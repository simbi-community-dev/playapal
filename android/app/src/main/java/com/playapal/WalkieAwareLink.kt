package com.playapal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySession
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.net.DatagramSocket
import java.net.Inet6Address
import java.util.concurrent.ConcurrentHashMap

/**
 * The walkie's OWN-LINK rung (docs/WALKIE-LADDER.md §9, rung 4's second
 * radio): Wi-Fi Aware discovery + pairwise datapaths, so two phones with
 * NO shared network — no router, no hotspot, no internet — still carry
 * live voice. This class is a LINK PROVIDER only: it discovers pod peers
 * over NAN and hands (address, port, socket) triples to WalkieModule's one
 * peer table. The PW frame, the codec, the fan-out cap and the receive
 * parsing never change — the rung changes the socket, never the frame.
 *
 * SHAPE. Every phone both PUBLISHES and SUBSCRIBES one service
 * ("playapal-walkie"); the pod code scopes matches via the podHash carried
 * in the service-specific info, so two pods at one camp never cross-join.
 * For each discovered pair exactly ONE datapath forms, with a
 * deterministic role choice (lower senderHash RESPONDS — both phones
 * agree without a message).
 *
 * THE TWO ROLES ARE NOT MIRROR IMAGES, and pretending they were is what
 * broke call symmetry in the field. What the framework does with each:
 *
 * - INITIATOR (subscribe session). `requestNetwork` actually dials:
 *   WifiAwareDataPathStateManager.needNetworkFor calls initiateDataPathSetup
 *   for role INITIATOR and nothing else. Its capabilities callback carries a
 *   WifiAwareNetworkInfo with the responder's IPv6 AND port, so it can send
 *   voice straight away. A request that produces no datapath is a real
 *   failure with a real deadline — the retry ladder below is for this role.
 *
 * - RESPONDER (publish session). `requestNetwork` dials NOTHING. The same
 *   needNetworkFor parks it in STATE_RESPONDER_WAIT_FOR_REQUEST and waits
 *   for a peer's NDP to arrive. It has no completion time, so a timeout is
 *   a category error, and its capabilities carry NO peer port: the TLV that
 *   carries a port is parsed "only relevant for the initiator", which is why
 *   noteReturnPath below is not a shortcut but the only channel that can
 *   tell a responder where to send.
 *
 * So the responder files ONE ANY-PEER request (API 31+,
 * Builder(PublishDiscoverySession)) for the whole pod, with no peer handle
 * and no deadline, and learns each peer's address from that peer's first PW
 * frame. The per-peer responder request it used to file matched an incoming
 * NDP only while the peer's cached discovery MAC still matched
 * (onDataPathRequest: "The peer MAC address (if specified - i.e. non-null)
 * must match") — and NAN rotates that MAC. Measured on two Pixels: the
 * responder's request was refused as unfulfillable, re-filed under a fresh
 * peerId every cycle, and never carried anything.
 *
 * TRUST matches the LAN rung exactly: the pod code is the admission
 * secret. The datapath PSK derives from the podHash — anyone with the
 * code can join, which is the pod's stated model ("hand it around like a
 * note, not a password"), and the pod-scoped PSK still shuts out the
 * neighbouring camp's traffic at the radio.
 *
 * FAILS DOWNWARD, SILENTLY (§1 corollary): every failure path here ends
 * in "this rung contributes no peers" — the LAN rung and the BLE rungs
 * are untouched, and a phone without the silicon never constructs this
 * class at all.
 */
class WalkieAwareLink(
  private val ctx: Context,
  private val podHash: Long,
  private val senderHash: Long,
  private val displayName: String,
  /** Hand a discovered peer to the module's table. Key must follow the
   * "<transport>|<senderHash hex>|<name>" shape peerHash() parses. */
  private val onPeer: (key: String, host: java.net.InetAddress, port: Int, name: String, socket: DatagramSocket) -> Unit,
  private val onPeerLost: (key: String) -> Unit,
  /** Spawn the module's receive loop on an aware-bound socket. */
  private val onSocket: (socket: DatagramSocket) -> Unit,
) {
  companion object {
    private const val TAG = "PlayaPalAware"
    const val SERVICE_NAME = "playapal-walkie"
    // serviceSpecificInfo: 'PA'(2) + podHash(4 BE) + senderHash(4 BE) +
    // utf8 name (bounded). NAN limits SSI to ~255 bytes; names are cut at
    // 24 chars upstream.
    private const val SSI_HEADER = 10

    /**
     * A datapath request that has produced nothing in this long is treated
     * as FAILED and re-filed. The one-shot 'requested' latch was the
     * measured reliability hole: requestNetwork can silently never call
     * back — a stale PeerHandle, a peer whose walkie is not open yet, a
     * vendor stack that lost the frame — and the old code then gave up on
     * that peer for the life of the walkie. The timeout overload turns
     * that silence into onUnavailable, which is a retriable event.
     */
    private const val REQUEST_TIMEOUT_MS = 30_000

    /** Re-request backoff: base doubles per silent failure up to the cap,
     * resets the moment a datapath actually forms. Bounded and small
     * because the common cause is "their walkie is not open YET" — the
     * whole point is to still be trying when it opens. */
    private const val RETRY_BASE_MS = 5_000L
    private const val RETRY_CAP_MS = 60_000L

    /** After a LIVE datapath drops, re-probe no sooner than this
     * (docs/WALKIE-LADDER.md §5 rule 5: a flapping radio must not become
     * a flapping walkie). */
    private const val RELOST_FLOOR_MS = 30_000L

    /** attach() refused while Aware reports available: rare, so a flat
     * bounded retry rather than a second backoff machine. */
    private const val ATTACH_RETRY_MS = 15_000L

    /** A publish/subscribe session the framework terminated is re-armed
     * after this long (fresh sessions mint fresh PeerHandles, so the old
     * ones are nulled first — a handle only works with its own session). */
    private const val SESSION_REARM_MS = 3_000L
  }

  private val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val thread = HandlerThread("walkie-aware").apply { start() }
  private val handler = Handler(thread.looper)

  private var awareSession: WifiAwareSession? = null
  private var pubSession: PublishDiscoverySession? = null
  private var subSession: SubscribeDiscoverySession? = null

  /**
   * A PeerHandle is valid ONLY for the discovery session that produced it
   * (measured on two Pixels: NAN discovery matched fine — dumpsys showed
   * the resolved peer MAC — but requestNetwork silently produced no
   * datapath because the handle came from the OTHER session). So a peer
   * carries BOTH handles as they arrive: the responder role uses its
   * PUBLISH handle with the publish session, the initiator role uses its
   * SUBSCRIBE handle with the subscribe session.
   */
  private data class AwarePeer(
    val hash: Long,
    /** Set once from the first real intro. NOT updated after that: the
     * name rides the peer key ("aware|<hex>|<name>"), and a renamed key
     * would strand the old row in the module's peer table forever. */
    @Volatile var name: String,
    @Volatile var publishHandle: PeerHandle? = null,
    @Volatile var subscribeHandle: PeerHandle? = null,
    /** A network request is currently REGISTERED for this peer — cleared
     * on onUnavailable/onLost so the peer can be re-requested. The latch
     * being permanent was the "connects once, never again" bug. */
    @Volatile var requested: Boolean = false,
    /** The datapath is live and delivering (onCapabilitiesChanged saw it). */
    @Volatile var up: Boolean = false,
    /** RESPONDER SIDE: this peer's first PW frame arrived, so we know where
     * to send and have handed the module a row. The framework never tells a
     * responder the peer's port (see the class header), so this flag — not
     * `up` — is what "callable" means on this side of the pair. */
    @Volatile var returnPathUp: Boolean = false,
    /** The endpoint the return path was last stamped with — the CHANGE
     * detector that lets a re-dialed initiator's fresh socket and port
     * re-fire onPeer (noteReturnPath) instead of latching forever. */
    @Volatile var returnHost: java.net.InetAddress? = null,
    @Volatile var returnPort: Int = 0,
    @Volatile var returnSocket: DatagramSocket? = null,
    @Volatile var backoffMs: Long = RETRY_BASE_MS,
    @Volatile var retryPending: Boolean = false,
    /** When this peer was last re-dialed because its ROW went silent —
     * §5 rule 5's floor applied to the module's demotion signal, so a
     * flapping radio still cannot become a flapping walkie. */
    @Volatile var lastNudge: Long = 0L,
    /** This object left `discovered` (service lost, aware down). A queued
     * retry runnable still holds it; without this flag that GHOST re-entered
     * maybeRequestDatapath, registered a NetworkCallback under the same
     * hash as the LIVE re-discovered peer, and the loser of that collision
     * was a ConnectivityManager request stop() could never unregister —
     * Android caps those near 100, after which the rung dies for the
     * process. A returning peer gets a FRESH AwarePeer from handleIntro. */
    @Volatile var dead: Boolean = false,
  )

  /** Peers by senderHash; a peer discovered on both sessions keeps one entry. */
  private val discovered = ConcurrentHashMap<Long, AwarePeer>()
  private val callbacks = ConcurrentHashMap<Long, ConnectivityManager.NetworkCallback>()
  private val sockets = ConcurrentHashMap<Long, DatagramSocket>()
  /** The one socket the RESPONDER advertises; PW frames from initiators
   * land here and reactively register their return path. */
  private var responderSocket: DatagramSocket? = null
  /** The ONE any-peer responder request (API 31+), covering every podmate
   * this phone responds to. Held so it can be unregistered when the publish
   * session that anchors it dies — a specifier outliving its session is the
   * ghost-request shape `dead` exists to prevent, one level up. */
  private var responderCallback: ConnectivityManager.NetworkCallback? = null
  /** The framework refused the any-peer responder specifier. TERMINAL: a
   * refused specifier cannot become valid by being filed again, and the
   * re-file loop was the measured thrash. Cleared only by a fresh publish
   * session or a re-attach, which are the events that CAN change the answer. */
  @Volatile private var responderRefused = false
  /** Networks the responder socket is already bound to — bindSocket is
   * idempotent per network but the callback fires repeatedly. */
  private val boundResponderNetworks = java.util.Collections.newSetFromMap(
    ConcurrentHashMap<Network, Boolean>(),
  )
  @Volatile private var stopped = false

  private fun passphrase(): String =
    "playapal-pod-" + java.lang.Long.toHexString(podHash).padStart(8, '0')

  private fun ssi(): ByteArray {
    val name = displayName.replace("|", "/").take(24).toByteArray(Charsets.UTF_8)
    val b = ByteArray(SSI_HEADER + name.size)
    b[0] = 'P'.code.toByte()
    b[1] = 'A'.code.toByte()
    writeU32(b, 2, podHash)
    writeU32(b, 6, senderHash)
    name.copyInto(b, SSI_HEADER)
    return b
  }

  @Volatile private var attaching = false

  /**
   * Aware AVAILABILITY comes and goes under a running walkie — Wi-Fi or
   * Location toggled, doze, the vendor stack recycling — and when it goes,
   * the framework terminates the attach session and every discovery
   * session WITHOUT a callback that says "start over". This broadcast is
   * the only recovery signal there is; without it the rung died at the
   * first toggle and only an app restart brought it back (the owner's
   * "doesn't connect reliably" has this as one of its faces).
   */
  private val availabilityReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED) {
        return
      }
      handler.post {
        if (stopped) {
          return@post
        }
        val mgr = try {
          ctx.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
        } catch (_: Exception) {
          null
        }
        val available = try { mgr?.isAvailable == true } catch (_: Exception) { false }
        Log.i(TAG, "aware//availability-changed available=$available attached=${awareSession != null}")
        if (available) {
          if (awareSession == null) {
            attach()
          }
        } else {
          onAwareDown()
        }
      }
    }
  }
  @Volatile private var receiverRegistered = false

  /** Availability collapsed: everything Aware-side is dead. Drop OUR
   * bookkeeping so recovery is a REAL restart, and empty the rung's rows
   * from the channel list — membership rides BLE (ladder §1); these rows
   * were rung-4 links and a listed peer we cannot reach is the lie §5
   * exists to prevent. */
  private fun onAwareDown() {
    pubSession = null
    subSession = null
    try {
      awareSession?.close()
    } catch (_: Exception) {}
    awareSession = null
    // First, because it drops every responder-side row while `discovered`
    // still knows the names those rows are keyed by. A re-attach mints a
    // fresh publish session, which is an event that CAN change a refusal —
    // so the terminal flag is forgiven here and nowhere else.
    releaseResponderRequest()
    responderRefused = false
    for (peer in discovered.values) {
      peer.dead = true // a queued retry must not resurrect this object
      callbacks.remove(peer.hash)?.let {
        try {
          cm.unregisterNetworkCallback(it)
        } catch (_: Exception) {}
      }
      sockets.remove(peer.hash)?.close()
      if (peer.up || peer.requested) {
        onPeerLost(keyFor(peer))
      }
      peer.up = false
      peer.requested = false
    }
    // Handles and peers died with the attach session; fresh discovery
    // after re-attach re-introduces everyone with valid handles.
    discovered.clear()
  }

  private fun keyFor(peer: AwarePeer): String =
    "aware|" + java.lang.Long.toHexString(peer.hash) + "|" + peer.name

  fun start() {
    // The WHOLE body is fenced: isAvailable itself throws SecurityException
    // without ACCESS_WIFI_STATE (measured — the first fence only covered
    // attach, and the leak took the walkie down with it).
    try {
      ctx.registerReceiver(
        availabilityReceiver,
        IntentFilter(WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED),
        null,
        handler,
      )
      receiverRegistered = true
    } catch (_: Exception) {}
    attach()
  }

  private fun attach() {
    try {
      if (stopped || attaching || awareSession != null) {
        return
      }
      val mgr = ctx.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager ?: return
      if (!mgr.isAvailable) {
        // The availability receiver re-enters here when it comes back.
        return
      }
      attaching = true
      mgr.attach(object : AttachCallback() {
        override fun onAttached(session: WifiAwareSession) {
          attaching = false
          if (stopped) {
            session.close()
            return
          }
          awareSession = session
          Log.i(TAG, "aware//attached")
          publish(session)
          subscribe(session)
        }

        override fun onAttachFailed() {
          // Refused while nominally available — rare, so one flat bounded
          // retry lane rather than a second backoff machine. The
          // availability receiver covers the common off/on case.
          attaching = false
          handler.postDelayed({
            if (!stopped && awareSession == null) {
              attach()
            }
          }, ATTACH_RETRY_MS)
        }
      }, handler)
    } catch (_: Exception) {
      // SecurityException (permission revoked mid-flight) or a vendor
      // throw: the rung contributes nothing, nothing else changes.
      attaching = false
    }
  }

  private fun publish(session: WifiAwareSession) {
    val config = PublishConfig.Builder()
      .setServiceName(SERVICE_NAME)
      .setServiceSpecificInfo(ssi())
      .build()
    try {
      session.publish(config, object : DiscoverySessionCallback() {
        override fun onPublishStarted(s: PublishDiscoverySession) {
          if (stopped) {
            s.close()
            return
          }
          pubSession = s
          Log.i(TAG, "aware//publish-started")
          // A fresh publish session is exactly the event that can change a
          // previous refusal's answer, and the any-peer specifier needs
          // NOTHING but this session — no peer, no handle, no intro. So the
          // responder is listening before the first podmate is discovered,
          // which is the ordering the framework's own recipe asks for.
          responderRefused = false
          ensureResponderRequest()
        }

        override fun onMessageReceived(peer: PeerHandle, message: ByteArray) {
          // The subscriber side introduces itself over the discovery
          // session (its SSI reached us only if WE also subscribe — this
          // message closes the loop when only one direction discovered).
          handleIntro(message, fromPublish = true, handle = peer)
        }

        override fun onSessionTerminated() {
          // The framework kills discovery sessions under doze/background
          // and never restarts them. Handles minted by this session died
          // with it (measured: a handle used with the wrong session
          // requests a datapath that silently never forms) — null them,
          // then re-arm so a returning app keeps discovering.
          pubSession = null
          for (p in discovered.values) {
            p.publishHandle = null
          }
          // The any-peer request is anchored to THIS session's id; the
          // framework resolves it through client.getSession(ns.sessionId)
          // on every incoming NDP, so once the session is gone the request
          // can only ever be refused. Drop it here and let the re-armed
          // publish file a fresh one.
          releaseResponderRequest()
          handler.postDelayed({
            val s = awareSession
            if (!stopped && s != null && pubSession == null) {
              publish(s)
            }
          }, SESSION_REARM_MS)
        }
      }, handler)
    } catch (_: Exception) {}
  }

  private fun subscribe(session: WifiAwareSession) {
    val config = SubscribeConfig.Builder()
      .setServiceName(SERVICE_NAME)
      .build()
    try {
      session.subscribe(config, object : DiscoverySessionCallback() {
        override fun onSubscribeStarted(s: SubscribeDiscoverySession) {
          if (stopped) {
            s.close()
            return
          }
          subSession = s
          Log.i(TAG, "aware//subscribe-started")
        }

        override fun onServiceDiscovered(
          peer: PeerHandle,
          serviceSpecificInfo: ByteArray?,
          matchFilter: List<ByteArray>?,
        ) {
          val info = serviceSpecificInfo ?: return
          handleIntro(info, fromPublish = false, handle = peer)
          // Introduce ourselves back over the session so the publisher
          // learns us even if its own subscribe never fires for us.
          try {
            subSession?.sendMessage(peer, 0, ssi())
          } catch (_: Exception) {}
        }

        override fun onServiceLost(peer: PeerHandle, reason: Int) {
          // A discovery-level goodbye (API 33+): the peer's publish went
          // off the air — walkie closed, radio off, they left. If no
          // datapath is up either, forget them entirely: retrying a phone
          // that said goodbye is noise, and a returning peer
          // re-introduces itself with fresh handles. If a datapath IS up,
          // keep everything — the network's own onLost is the authority
          // for that half.
          val p = discovered.values.firstOrNull { it.subscribeHandle == peer } ?: return
          Log.i(TAG, "aware//service-lost hash=" + java.lang.Long.toHexString(p.hash) + " up=" + p.up)
          p.subscribeHandle = null
          if (!p.up) {
            p.dead = true // a queued retry must not resurrect this object
            callbacks.remove(p.hash)?.let {
              try {
                cm.unregisterNetworkCallback(it)
              } catch (_: Exception) {}
            }
            sockets.remove(p.hash)?.close()
            p.requested = false
            // A responder-side row survives `up` being false — that is what
            // it is FOR — so it needs its own goodbye here, before the name
            // its key is built from leaves `discovered`.
            if (p.returnPathUp) {
              p.returnPathUp = false
              onPeerLost(keyFor(p))
            }
            discovered.remove(p.hash)
          }
        }

        override fun onSessionTerminated() {
          subSession = null
          for (p in discovered.values) {
            p.subscribeHandle = null
          }
          handler.postDelayed({
            val s = awareSession
            if (!stopped && s != null && subSession == null) {
              subscribe(s)
            }
          }, SESSION_REARM_MS)
        }
      }, handler)
    } catch (_: Exception) {}
  }

  private fun handleIntro(info: ByteArray, fromPublish: Boolean, handle: PeerHandle) {
    if (stopped || info.size < SSI_HEADER ||
      info[0] != 'P'.code.toByte() || info[1] != 'A'.code.toByte()
    ) {
      return
    }
    if (readU32(info, 2) != podHash) {
      return // another pod's walkie — same service, different camp
    }
    val hash = readU32(info, 6)
    if (hash == senderHash) {
      return // our own reflection
    }
    val name = String(info, SSI_HEADER, info.size - SSI_HEADER, Charsets.UTF_8)
      .ifEmpty { "someone" }
    Log.i(TAG, "aware//intro from=" + java.lang.Long.toHexString(hash) + " fromPublish=" + fromPublish)
    val peer = discovered.getOrPut(hash) { AwarePeer(hash, name) }
    // File the handle under the session it came from; the role below reads
    // the one it needs and starts the datapath once that arm is present.
    if (fromPublish) {
      peer.publishHandle = handle
    } else {
      peer.subscribeHandle = handle
    }
    maybeRequestDatapath(peer)
  }

  /** The role's handle: responder (lower hash) drives from its PUBLISH
   * session, initiator from its SUBSCRIBE session. */
  private fun roleHandle(peer: AwarePeer): PeerHandle? =
    if (senderHash < peer.hash) peer.publishHandle else peer.subscribeHandle

  /**
   * One datapath per pair, deterministic roles: the LOWER senderHash
   * RESPONDS (its publish session anchors the specifier and advertises
   * this phone's UDP port); the HIGHER hash INITIATES from its subscribe
   * session. Both phones compute the same answer from the two hashes.
   */
  /** Try again later. One pending retry per peer; the retry re-enters
   * maybeRequestDatapath, whose own latch guards double-requests, so an
   * intro arriving while a retry is queued costs nothing extra. */
  private fun scheduleRetry(peer: AwarePeer, delayMs: Long) {
    if (stopped || peer.retryPending) {
      return
    }
    peer.retryPending = true
    handler.postDelayed({
      peer.retryPending = false
      if (!stopped && !peer.dead && !peer.up) {
        maybeRequestDatapath(peer)
      }
    }, delayMs)
  }

  @Synchronized
  private fun maybeRequestDatapath(peer: AwarePeer) {
    if (stopped || peer.dead || peer.requested || peer.up) {
      return
    }
    val respond = senderHash < peer.hash
    if (respond && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // NOTHING PER-PEER TO DO. One any-peer request already accepts this
      // podmate and every other one; filing a second, peer-specific request
      // for the same pair is how the pre-S path used to spend its ladder.
      ensureResponderRequest()
      return
    }
    val session: DiscoverySession = (if (respond) pubSession else subSession) ?: return
    val handle = roleHandle(peer) ?: run {
      Log.i(TAG, "aware//waiting-for-role-handle respond=" + respond +
        " pub=" + (peer.publishHandle != null) + " sub=" + (peer.subscribeHandle != null))
      return
    }
    peer.requested = true
    Log.i(TAG, "aware//requesting-datapath respond=" + respond + " backoff=" + peer.backoffMs)
    val specifier = try {
      val builder = WifiAwareNetworkSpecifier.Builder(session, handle)
        .setPskPassphrase(passphrase())
      if (respond) {
        val s = responderSocket ?: DatagramSocket(0).also {
          responderSocket = it
          onSocket(it)
        }
        builder.setPort(s.localPort).setTransportProtocol(17) // UDP
      }
      builder.build()
    } catch (e: Exception) {
      Log.w(TAG, "aware//specifier-failed " + e.message)
      peer.requested = false
      return
    }
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
      .setNetworkSpecifier(specifier)
      .build()
    val key = keyFor(peer)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        if (stopped) {
          return
        }
        if (respond) {
          // The datapath exists (the responder needs nothing more from
          // caps): stop the retry clock and forgive the backoff, so the
          // next real failure recovers from the base again.
          peer.up = true
          peer.backoffMs = RETRY_BASE_MS
          // The responder needs no peer ADDRESS here (initiators reveal
          // their return path with their first PW frame), but its socket
          // MUST be bound to the aware network or the datapath's packets
          // never reach it: an unbound socket rides the DEFAULT network,
          // and on a phone with no Wi-Fi and no data there is none, so
          // frames arriving on aware_data0 were dropped by the stack.
          val s = responderSocket
          if (s != null && !boundResponderNetworks.contains(network)) {
            try {
              network.bindSocket(s)
              boundResponderNetworks.add(network)
              Log.i(TAG, "aware//responder-bound port=" + s.localPort)
            } catch (_: Exception) {
              // EPERM is the normal answer for a socket that has already
              // carried traffic, and MEASURED on two Pixels the unbound
              // socket receives the datapath's frames anyway. Binding is
              // an optimisation, never a requirement — mark it done so a
              // repeating callback stops retrying it.
              boundResponderNetworks.add(network)
            }
          }
          return
        }
        val info = caps.transportInfo as? WifiAwareNetworkInfo ?: run {
          Log.i(TAG, "aware//caps-no-transportinfo")
          return
        }
        Log.i(TAG, "aware//datapath-up port=" + info.port)
        val host = info.peerIpv6Addr as? Inet6Address ?: return
        val port = info.port
        if (port <= 0) {
          return
        }
        val socket = sockets.getOrPut(peer.hash) {
          DatagramSocket(0).also { s ->
            try {
              network.bindSocket(s)
            } catch (_: Exception) {}
            onSocket(s)
          }
        }
        // `up` flips only once the peer is actually DIALABLE (address +
        // port in hand, socket bound) — §5's proof, not the network's
        // existence: an early caps event without transportInfo must not
        // stop the retry clock.
        peer.up = true
        peer.backoffMs = RETRY_BASE_MS
        onPeer(key, host, port, peer.name, socket)
      }

      override fun onLost(network: Network) {
        // The peer is NOT forgotten here — that was the measured
        // reliability hole: NAN discovery does not re-introduce a peer it
        // already matched, so removing them from `discovered` meant one
        // datapath blip needed a full app restart to recover. This is
        // §5's "availability failed, capability did not": the row leaves
        // the channel list NOW (a listed peer we cannot reach is the lie
        // §1 warns about), and the link re-probes on the doc's 30 s floor
        // for as long as discovery still believes they are there.
        Log.i(TAG, "aware//datapath-lost hash=" + java.lang.Long.toHexString(peer.hash))
        // Unregister THIS callback unconditionally (the framework holds it
        // until told otherwise), and remove the map entry only when it is
        // still OURS — the two-arg remove. A blanket remove(hash) here let
        // a ghost's late onLost strip the LIVE peer's entry, leaving that
        // request registered forever with stop() unable to find it.
        try {
          cm.unregisterNetworkCallback(this)
        } catch (_: Exception) {}
        callbacks.remove(peer.hash, this)
        sockets.remove(peer.hash)?.close()
        peer.up = false
        peer.requested = false
        peer.backoffMs = RELOST_FLOOR_MS
        onPeerLost(key)
        scheduleRetry(peer, RELOST_FLOOR_MS)
      }

      override fun onUnavailable() {
        // The timeout overload lands here when the request produced no
        // datapath at all — the common shape is simply "their walkie is
        // not open yet". The framework has already released the request
        // (per contract), so no unregister: clear the latch and try
        // again with backoff. This callback is what turned the one-shot
        // latch into a ladder that keeps climbing.
        Log.i(TAG, "aware//datapath-unavailable hash=" + java.lang.Long.toHexString(peer.hash) +
          " respond=" + respond + " nextBackoff=" + peer.backoffMs)
        // Two-arg remove: only OUR entry, never a live replacement's.
        callbacks.remove(peer.hash, this)
        peer.requested = false
        if (respond) {
          // TERMINAL for a responder (pre-S only — S+ never gets here).
          // A responder request has no deadline of its own: this callback
          // means the framework REFUSED the specifier, and the one thing it
          // refuses on is a peer whose cached discovery MAC no longer
          // matches. Re-filing mints a new peerId against the same rotating
          // MAC and is refused again — that loop is the thrash, and it is
          // this phone's own doing, not the radio's. Discovery re-introducing
          // this peer (a FRESH AwarePeer from handleIntro) is the only event
          // that can change the answer, and it re-enters here on its own.
          return
        }
        scheduleRetry(peer, peer.backoffMs)
        peer.backoffMs = (peer.backoffMs * 2).coerceAtMost(RETRY_CAP_MS)
      }
    }
    // put() so a superseded entry is UNREGISTERED, not silently dropped:
    // a map overwrite that forgets the old callback leaks its request past
    // stop(), which iterates only callbacks.values.
    callbacks.put(peer.hash, callback)?.let {
      try {
        cm.unregisterNetworkCallback(it)
      } catch (_: Exception) {}
    }
    try {
      if (respond) {
        // NO DEADLINE. needNetworkFor parks a responder in
        // STATE_RESPONDER_WAIT_FOR_REQUEST and takes no further action —
        // waiting IS the request working. The timeout overload turned that
        // correct wait into onUnavailable every 30 s, and the re-file that
        // followed tore down the callback whose datapath was carrying voice.
        cm.requestNetwork(request, callback, handler)
      } else {
        cm.requestNetwork(request, callback, handler, REQUEST_TIMEOUT_MS)
      }
    } catch (e: Exception) {
      Log.w(TAG, "aware//requestNetwork-failed " + e.message)
      callbacks.remove(peer.hash, callback)
      peer.requested = false
      scheduleRetry(peer, peer.backoffMs)
      peer.backoffMs = (peer.backoffMs * 2).coerceAtMost(RETRY_CAP_MS)
    }
  }

  /**
   * The responder's whole request, filed once (API 31+).
   *
   * WHY ANY-PEER AND NOT PER-PEER. On every incoming NDP the framework walks
   * its request cache and, for a request built with a peer handle, requires
   * "the peer MAC address (if specified - i.e. non-null) must match". That
   * MAC was cached when this phone filed the request, from the PeerInfo its
   * publish session minted for that peerId — and NAN rotates discovery MACs.
   * After a rotation every arriving NDP falls through to "can't find a
   * request with specified pubSubId", the framework answers the initiator
   * with a refusal, and this phone sits in its own 30 s timeout wondering
   * why. A null peer MAC is documented as "accept (otherwise matching)
   * requests from any peer MAC", and the same loop explicitly supports
   * several NDPs against one any-peer request. One request, every podmate,
   * no cached identity to go stale.
   *
   * The port still travels: the responder's specifier port is what the
   * framework puts in the NDP response TLV, which is exactly where the
   * initiator reads it from.
   */
  @Synchronized
  private fun ensureResponderRequest() {
    if (stopped || responderRefused || responderCallback != null) {
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      return // pre-S has only the per-peer responder; maybeRequestDatapath files it
    }
    val session = pubSession ?: return
    val specifier = try {
      val s = responderSocket ?: DatagramSocket(0).also {
        responderSocket = it
        onSocket(it)
      }
      WifiAwareNetworkSpecifier.Builder(session)
        .setPskPassphrase(passphrase())
        .setPort(s.localPort)
        .setTransportProtocol(17) // UDP
        .build()
    } catch (e: Exception) {
      // The builder throws on a malformed port or a passphrase the platform
      // will not take. Neither improves by being retried.
      Log.w(TAG, "aware//responder-specifier-failed " + e.message)
      responderRefused = true
      return
    }
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
      .setNetworkSpecifier(specifier)
      .build()
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        if (stopped) {
          return
        }
        // The responder needs no peer ADDRESS here — its capabilities carry
        // the peer's IPv6 but never the peer's PORT, and with several NDPs
        // on one agent they carry only the FIRST peer's address anyway. The
        // dialable row comes from noteReturnPath. What this callback is for
        // is the binding: a socket created before the network existed rides
        // the default network, and on a phone with no Wi-Fi and no data
        // there is none, so frames arriving on aware_data0 are dropped by
        // the stack before the receive loop ever sees them.
        val s = responderSocket
        if (s != null && !boundResponderNetworks.contains(network)) {
          try {
            network.bindSocket(s)
            Log.i(TAG, "aware//responder-bound port=" + s.localPort)
          } catch (_: Exception) {
            // EPERM is the normal answer for a socket that has already
            // carried traffic, and MEASURED on two Pixels the unbound
            // socket receives the datapath's frames anyway. Binding is an
            // optimisation, never a requirement — mark it done either way
            // so a repeating callback stops retrying it.
          }
          boundResponderNetworks.add(network)
        }
      }

      override fun onLost(network: Network) {
        // One request, one agent, all of this phone's responder NDPs: when
        // it goes, every peer we were answering is unreachable at once. The
        // rows must leave the channel list NOW — §5's rule that no side
        // claims a rung it cannot send on — while discovery keeps believing
        // in these peers and the initiators keep re-probing.
        Log.i(TAG, "aware//responder-datapath-lost")
        boundResponderNetworks.remove(network)
        clearReturnPaths()
      }

      override fun onUnavailable() {
        // TERMINAL, and the whole point of criterion 2. A responder request
        // has no deadline, so this is the framework REFUSING the specifier,
        // not a peer being slow. Re-filing an identical specifier gets an
        // identical refusal; a fresh publish session (onPublishStarted) is
        // the one event that can change the answer, and it clears the flag.
        Log.w(TAG, "aware//responder-request-refused")
        responderRefused = true
        responderCallback = null
        clearReturnPaths()
      }
    }
    try {
      // No timeout, by role: see the requestNetwork note in
      // maybeRequestDatapath. A responder waits; waiting is not failing.
      cm.requestNetwork(request, callback, handler)
      responderCallback = callback
      Log.i(TAG, "aware//responder-listening port=" + (responderSocket?.localPort ?: 0))
    } catch (e: Exception) {
      Log.w(TAG, "aware//responder-request-failed " + e.message)
      responderRefused = true
    }
  }

  @Synchronized
  private fun releaseResponderRequest() {
    responderCallback?.let {
      try {
        cm.unregisterNetworkCallback(it)
      } catch (_: Exception) {}
    }
    responderCallback = null
    boundResponderNetworks.clear()
    clearReturnPaths()
  }

  /** When the responder socket was last rotated — one socket serves every
   * responder NDP, so rotation is global and rides the same 30 s floor as
   * every other silence response (§5 rule 5). */
  @Volatile private var lastResponderRotate = 0L

  /**
   * The responder's one socket can be BOUND TO A CORPSE: bindSocket ties it
   * to the first NDP's network, a later bind of a traffic-carrying socket
   * is refused (EPERM), and the framework often never says onLost — so
   * after the first datapath dies, sends route into a dead netid while the
   * advertised port lives on in the specifier. When a responder row goes
   * silent and NO network this socket was ever bound to is still alive,
   * nothing rides the socket any more: close it, drop the request built on
   * its port, and re-file fresh so the peer's next re-dial negotiates
   * against a port that can actually answer. Rotation is skipped while ANY
   * bound network is alive — another podmate may be riding it, and §1
   * forbids breaking a live NDP to court a dead one.
   */
  @Synchronized
  private fun maybeRotateResponder() {
    if (stopped) {
      return
    }
    val now = System.currentTimeMillis()
    if (now - lastResponderRotate < RELOST_FLOOR_MS) {
      return
    }
    val nets = boundResponderNetworks.toList()
    if (nets.isEmpty()) {
      return
    }
    val anyAlive = nets.any { n ->
      try {
        cm.getNetworkCapabilities(n) != null
      } catch (_: Exception) {
        false
      }
    }
    if (anyAlive) {
      return
    }
    lastResponderRotate = now
    Log.i(TAG, "aware//responder-rotating port=" + (responderSocket?.localPort ?: 0))
    releaseResponderRequest()
    try {
      responderSocket?.close()
    } catch (_: Exception) {}
    responderSocket = null
    ensureResponderRequest()
  }

  /**
   * A podmate's first PW frame arrived on the responder socket: THIS is
   * where a responder learns where to send.
   *
   * It cannot come from anywhere else. The framework parses the peer's port
   * out of the NDP TLV "only relevant for the initiator", so a responder's
   * WifiAwareNetworkInfo reports port 0 forever. Until this call the peer is
   * audible (their frames reach us) but not dialable — which is precisely
   * the field report: voice both ways, no Call button, because a row nobody
   * minted is a capability nobody has.
   *
   * The LINK mints the row, not the module, so that one owner has one
   * cleanup path: everything that drops an aware peer drops this too, and
   * nothing that drops an aware peer can strip a row it does not know about.
   */
  fun noteReturnPath(hash: Long, host: java.net.InetAddress, port: Int, socket: DatagramSocket) {
    if (stopped || port <= 0) {
      return
    }
    // Discovery is still the admission gate: a frame carrying a hash this
    // phone has never introduced is not a podmate we can name, and a row
    // named "someone" would outlive every removal path (they all compute the
    // key from the DISCOVERED name).
    val peer = discovered[hash] ?: return
    // ROLE, not liveness. We INITIATE to a higher hash, and that row already
    // carries an address and a port from the capabilities callback; minting
    // a second one from their answering probe would hand the module a
    // duplicate and, worse, arm a responder-side goodbye for a row the
    // initiator path owns. The pre-S responder DOES set `up`, so `up` is
    // exactly the wrong test here.
    if (peer.dead || senderHash > peer.hash) {
      return
    }
    // RE-STAMP ON CHANGE, never latch-once. The old `returnPathUp` early
    // return held the FIRST endpoint forever — and an initiator that
    // re-dials after noteSilent arrives from a FRESH socket with a fresh
    // ephemeral port, so every answer after the first redial went to a
    // closed port and the pair could re-prove for exactly one frame
    // (measured 2026-08-25: the dust-mode 30 s up->proven->deaf->demote
    // cycle — §5's demote machinery honestly reporting a deafness this
    // latch caused). The duplicate-row fear the latch guarded stays
    // guarded: same key, and the module's peer map overwrites by key.
    if (
      peer.returnPathUp &&
      host == peer.returnHost &&
      port == peer.returnPort &&
      socket === peer.returnSocket
    ) {
      return
    }
    peer.returnPathUp = true
    peer.returnHost = host
    peer.returnPort = port
    peer.returnSocket = socket
    Log.i(TAG, "aware//return-path hash=" + java.lang.Long.toHexString(hash) + " port=" + port)
    onPeer(keyFor(peer), host, port, peer.name, socket)
  }

  /**
   * A row this link minted has gone SILENT (WalkieModule's §5 sweep): no
   * frame of any kind for STALE_MS while the keep-alive probed it every few
   * seconds. Re-dial it.
   *
   * This is the callback the framework never made. Measured on two Pixels:
   * a datapath stopped carrying anything for minutes and then re-logged
   * aware//datapath-up, with no onLost, no onUnavailable and no
   * onCapabilitiesChanged in between — so `up` stayed true, the module kept
   * a row it could not reach, and every targeted send resolved it. Inbound
   * frames are the only honest liveness signal this rung has, and they are
   * measured one level up, so the demotion has to arrive from there.
   *
   * WHAT IT DOES, and only this:
   *  - INITIATOR (our hash is the higher one): we own a per-peer request,
   *    so drop it and file a fresh one — the same teardown onLost performs,
   *    for the same condition onLost failed to notice. `requestNetwork`'s
   *    own timeout ladder takes it from there.
   *  - RESPONDER: there is no per-peer request to re-file (one any-peer
   *    agent carries every NDP), so recovery is the peer's own keep-alive
   *    arriving and re-stamping the row the module still holds.
   *
   * The row is NOT dropped. Demotion is the module's honest state — no
   * hi-fi claim, no Call button, ranked below every proven row — and the
   * row must survive to be re-promoted by the next inbound frame.
   */
  fun noteSilent(hash: Long) {
    handler.post {
      val peer = discovered[hash] ?: return@post
      if (stopped || peer.dead) {
        return@post
      }
      if (senderHash < peer.hash) {
        // RESPONDER-side row gone silent. There is no per-peer request to
        // re-file — but there IS one socket, and if every network it was
        // ever bound to is DEAD, that socket is bound to a corpse: its
        // sends route into a torn-down netid, and its port is advertised
        // by a specifier no future NDP should negotiate against. Rotate
        // (fresh socket, fresh bind, fresh specifier) so the initiator's
        // next re-dial lands on a live port (measured 2026-08-25: the
        // responder half of the dust-mode 30 s flap).
        maybeRotateResponder()
        return@post
      }
      val now = System.currentTimeMillis()
      if (now - peer.lastNudge < RELOST_FLOOR_MS) {
        return@post // §5 rule 5: re-probe no sooner than 30 s
      }
      peer.lastNudge = now
      Log.i(TAG, "aware//row-silent-redialing hash=" + java.lang.Long.toHexString(hash))
      callbacks.remove(hash)?.let {
        try {
          cm.unregisterNetworkCallback(it)
        } catch (_: Exception) {}
      }
      // The socket was bound to a network that is not carrying anything;
      // leaving it in the map would hand the re-formed datapath the same
      // dead socket (sockets.getOrPut). The module's receive loop lets go
      // of a closed socket instead of spinning on it.
      sockets.remove(hash)?.close()
      peer.up = false
      peer.requested = false
      maybeRequestDatapath(peer)
    }
  }

  /** Every responder-side row at once — the only granularity the framework
   * gives us, since one any-peer agent carries every responder NDP. */
  private fun clearReturnPaths() {
    for (peer in discovered.values) {
      if (peer.returnPathUp) {
        peer.returnPathUp = false
        onPeerLost(keyFor(peer))
      }
    }
  }

  fun stop() {
    stopped = true
    if (receiverRegistered) {
      try {
        ctx.unregisterReceiver(availabilityReceiver)
      } catch (_: Exception) {}
      receiverRegistered = false
    }
    // Queued retries/re-arms must not outlive the link (their captures
    // hold sessions and peers).
    handler.removeCallbacksAndMessages(null)
    // The any-peer responder callback lives OUTSIDE `callbacks` (it belongs
    // to no single peer), so the loop below would leak its request past
    // stop() — the near-100 cap that kills the rung for the whole process.
    responderCallback?.let {
      try {
        cm.unregisterNetworkCallback(it)
      } catch (_: Exception) {}
    }
    responderCallback = null
    boundResponderNetworks.clear()
    for (cb in callbacks.values) {
      try {
        cm.unregisterNetworkCallback(cb)
      } catch (_: Exception) {}
    }
    callbacks.clear()
    for (s in sockets.values) {
      s.close()
    }
    sockets.clear()
    responderSocket?.close()
    responderSocket = null
    discovered.clear()
    try {
      pubSession?.close()
    } catch (_: Exception) {}
    try {
      subSession?.close()
    } catch (_: Exception) {}
    try {
      awareSession?.close()
    } catch (_: Exception) {}
    pubSession = null
    subSession = null
    awareSession = null
    thread.quitSafely()
  }

  private fun writeU32(b: ByteArray, at: Int, v: Long) {
    b[at] = ((v shr 24) and 0xFF).toByte()
    b[at + 1] = ((v shr 16) and 0xFF).toByte()
    b[at + 2] = ((v shr 8) and 0xFF).toByte()
    b[at + 3] = (v and 0xFF).toByte()
  }

  private fun readU32(b: ByteArray, at: Int): Long =
    ((b[at].toLong() and 0xFF) shl 24) or
      ((b[at + 1].toLong() and 0xFF) shl 16) or
      ((b[at + 2].toLong() and 0xFF) shl 8) or
      (b[at + 3].toLong() and 0xFF)
}
