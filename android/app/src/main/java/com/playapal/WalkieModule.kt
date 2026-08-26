package com.playapal

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.AudioManager
import android.media.MediaRecorder
import android.util.Log
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * Walkie — live PTT voice for Camp Mesh (docs/CREW-DESIGN.md §6d), the
 * Android half.
 *
 * RADIO SHAPE. Live duplex over BLE is a party trick, and cross-platform
 * ad-hoc Wi-Fi does not exist (Aware/Direct are Android-only, Multipeer is
 * Apple-only, iOS multicast needs an Apple-approved entitlement). What both
 * platforms share entitlement-free is Bonjour/NSD discovery + UDP UNICAST
 * on a common LAN — so the walkie works on ANY shared Wi-Fi (the base
 * station's hotspot, a camp router, a phone hotspot), and each 20 ms voice
 * frame is unicast to every discovered peer. Raw PCM 16 kHz mono ≈ 32 KB/s
 * per speaker: trivial for Wi-Fi, no codec licensing, no native codec deps.
 *
 * FRAME: 'PW'(2) + version|codec(1) + podHash(4 BE) + senderHash(4 BE) +
 * seq(2 BE) + payload. The rung changes the CODEC and the socket, never the
 * frame — which is why byte 2 exists (docs/WALKIE-LADDER.md §3).
 * Receivers play only their own pod's frames and drop stale seqs per
 * sender. No retransmit ON PURPOSE — late audio is worse than lost audio.
 *
 * CONSENT: the mic runs ONLY while startTalking..stopTalking (the held
 * button IS the consent surface). RECORD_AUDIO rejects with 'permission'
 * and JS asks in context, like every other permission in this app.
 *
 * Events:
 *   WalkiePeers    { count: int, talkingTo: int, names: string[],
 *                    rungs: string[] }   (rungs aligned with names:
 *                    "lan" | "aware" | "ble" — the panel's lo-fi badge)
 *   WalkieSpeaking { name: string, podHash: double }  (throttled ~1/s)
 */
class WalkieModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Walkie"

  companion object {
    /** One logcat tag for this module's own lines, beside the rungs' own
     * ("PlayaPalAware", "PlayaPalBleVoice"): the bench greps all three. */
    const val TAG = "PlayaPalWalkie"
    const val SERVICE_TYPE = "_playapal-walkie._udp."
    const val SAMPLE_RATE = 16_000
    const val FRAME_SAMPLES = 320 // 20 ms at 16 kHz
    const val FRAME_BYTES = FRAME_SAMPLES * 2
    const val HEADER = 13

    /**
     * Byte 2 of every PW frame: (version << 4) | codec.
     *
     * THE LADDER NEEDS THIS AND IT EXPIRED ON AUG 28 (docs/WALKIE-LADDER.md
     * §3). One protocol over N transports means the RUNG changes the codec
     * and the socket, never the frame — so the frame has to say which codec
     * it carries. Adding the byte costs nothing today because 0.7.5 was
     * cancelled and the walkie exists only on two field phones we reflash at
     * will; adding it in September would mean a build that cannot talk to
     * last week's build, in a place where nobody can update.
     *
     * A receiver that does not know a codec id DROPS the frame — the same
     * posture decodeBeacon takes toward a version it does not know. Silence
     * from one sender beats garbage played at a whole pod.
     */
    const val FRAME_VERSION = 1
    const val CODEC_PROBE = 0x0 // zero-length, rung negotiation (§5 step 3)
    const val CODEC_PCM16_16K = 0x1 // what rung 4 sends and plays

    /** Call-control payload (docs/VIDEO-CALLS.md): chunked 1:1 video-call
     * signaling, opaque bytes to this module. 0x2-0x4 stay reserved for
     * the ladder's audio codecs (§6) and 0x5 is CODEC_ADPCM8K below —
     * both lanes claimed 0x5 in parallel; the ladder doc canonized ADPCM
     * there first, so calls moved. Mirrored in Walkie.swift codecCall
     * and walkie.ts WALKIE_CODEC_CALL; a test reads all three files. */
    const val CODEC_CALL = 0x6
    const val FRAME_HEAD = (FRAME_VERSION shl 4) or CODEC_PCM16_16K

    /** Rung 3's codec (docs/WALKIE-LADDER.md §6): IMA ADPCM over 8 kHz —
     * see Adpcm.kt for why this and not the table's Opus/Codec2 (both are
     * native deps this tree does not carry; the codec byte exists so they
     * can arrive later without a wire change). */
    const val CODEC_ADPCM8K = 0x5

    /** Rung 3 sends every third 20 ms capture as ONE 60 ms ADPCM frame:
     * ~17 GATT writes/s instead of 50, each 257 bytes — under the
     * negotiated MTU and gentle on the 10-30 KB/s GATT budget the
     * answering machine shares (§6, §2a). */
    const val BLE_BATCH = 3

    /**
     * Live-talk channel ceiling, PEERS (so the channel is this + me = 10).
     * Owner ruling 2026-08-24: "a soft guard that limits the number of
     * joiners in a walkie channel to 10 or even less."
     *
     * SOFT, and the word is honest: mDNS + UDP has no admission control, so
     * anyone with the pod code can join and no phone can stop them. What
     * this bounds is what THIS phone TRANSMITS to — which is also the fan-out
     * cure, because live voice is unicast per peer per 20 ms frame: at 9
     * peers that is ~290 KB/s and 450 pps, at 59 it would be 1.9 MB/s and
     * 3,000 pps. Mirrored in src/crews/walkie.ts (WALKIE_MAX_PEERS) and
     * pinned by a test that reads both files.
     */
    const val MAX_PEERS = 9

    /**
     * SIGNAL BREADTH CEILING (docs/VIDEO-CALLS.md §2a). One call-signal
     * payload may ride at most this many of ONE podmate's datagram rows,
     * best-proven first — the JS signaler asks for two while it is
     * retransmitting and one otherwise, and this clamps whatever it asks
     * for. Bounded HERE, on the native side, for the same reason MAX_PEERS
     * is: a JS-side-only cap is a cap until the JS side is wrong.
     *
     * It applies to SIGNALING ONLY. Live voice is unicast per peer per
     * 20 ms frame and picks ONE row per person in recomputeTargets; a
     * hedged voice frame would double the hot path's packet rate for a
     * codec that already tolerates loss by design. Signaling is a few
     * dozen ≤606-byte control messages for a whole call.
     */
    const val MAX_SIGNAL_FANOUT = 2

    /**
     * §5'S CLOCK (docs/WALKIE-LADDER.md §5: "availability is PROVEN, never
     * announced"). A DATAGRAM row that has delivered nothing for this long
     * is DEMOTED — it stops counting as hi-fi or callable and ranks below
     * every proven row.
     *
     * MEASURED, two Pixels, ship build, 2026-08-25 night: P7's row for P9
     * wore a plain name and a Call button while its Aware datapath was
     * silently DEAD — the datapath re-logged aware//datapath-up minutes
     * later, so it had been down that whole time with no onLost, no
     * onUnavailable and no onCapabilitiesChanged (an Aware flap can simply
     * go quiet). The callee's call-ACK and a reverse INVITE each resolved
     * that lying row for all eight retransmits, UDP into the downed
     * interface erred nowhere, and the caller ended honest-but-wrong: "No
     * answer". Callbacks are not proof. Inbound frames are.
     *
     * Two probe rounds fit inside it, so a healthy link must lose two
     * keep-alives in a row before it is demoted.
     */
    const val STALE_MS = 10_000L

    /**
     * The keep-alive cadence, so SILENCE MEANS DEATH and not idleness:
     * while the walkie session is open every phone sends each datagram peer
     * a zero-payload CODEC_PROBE this often. 13 bytes per peer per round —
     * ~26 B/s at 9 peers, against the ~290 KB/s a single talker already
     * costs — and it runs ONLY between start() and stop(), never with the
     * app merely open (the battery honesty is written down in §5b).
     */
    const val PROBE_MS = 4_500L

    /** The staleness sweep runs faster than the probe, so a demotion
     * reaches the badge at STALE_MS + one tick instead of STALE_MS + one
     * whole probe round. Probing stays on its own fixed cadence: sweeping
     * more often must never mean dialing more often. */
    const val SWEEP_MS = 2_000L

    /** Receive-side pre-amplification (owner field ruling 2026-08-25).
     * Applied with saturation before the track write; paired with the
     * USAGE_MEDIA loudspeaker fix below. PCM16 samples are read little-
     * endian from AudioRecord. */
    const val RX_GAIN = 3.0
    const val PEERS_EVENT = "WalkiePeers"
    const val SPEAKING_EVENT = "WalkieSpeaking"
    const val SIGNAL_EVENT = "WalkieSignal"

    /** Wi-Fi-class interface name prefixes, best first: wlan = the client
     * Wi-Fi the walkie normally rides; swlan/ap = this phone HOSTING the
     * hotspot (the camp-mailbox case — the host is on the LAN it made). */
    private val WIFI_IFACES = listOf("wlan", "swlan", "ap")
  }

  private data class Peer(
    /** Null = not datagram-addressable: a BLE peer's voice rides sendBle
     * instead of a socket. */
    val host: InetAddress?,
    val port: Int,
    val name: String,
    /** The socket this peer is reached through: null = the LAN socket. An
     * Aware peer rides a socket BOUND to its own datapath network —
     * sending from the LAN socket would route onto the wrong radio. */
    val socket: DatagramSocket? = null,
    /** Which rung carries this peer — "lan" | "aware" | "ble". The
     * panel's lo-fi badge and the per-person dedupe both read it. */
    val rung: String = "lan",
    /** Rung 3's write: one PW frame onto this peer's GATT voice pipe.
     * Non-null exactly when rung == "ble". */
    val sendBle: ((ByteArray, Int) -> Unit)? = null,
    /**
     * When THIS ROW last delivered a frame — §5's proof, kept per row and
     * never per person: a live LAN row must not vouch for the same
     * podmate's dead aware row, which is exactly the lie the field caught.
     *
     * Born stamped, because a row is minted from an mDNS resolve or a
     * datapath that just proved itself; handleFrame re-stamps it from the
     * socket each frame actually arrives on, so a re-minted row and a
     * re-answering row both re-promote through the same door.
     */
    val lastInbound: java.util.concurrent.atomic.AtomicLong =
      java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis()),
  )

  private var socket: DatagramSocket? = null
  private var aware: WalkieAwareLink? = null
  private var bleLink: WalkieBleLink? = null
  private var nsd: NsdManager? = null
  private var regListener: NsdManager.RegistrationListener? = null
  private var discListener: NsdManager.DiscoveryListener? = null
  private val peers = ConcurrentHashMap<String, Peer>()
  private var myServiceName = ""
  private var podHash = 0L
  private var senderHash = 0L
  @Volatile private var receiving = false
  @Volatile private var talking = false
  private var recordThread: Thread? = null
  private var receiveThread: Thread? = null
  /** The keep-alive + staleness sweep, alive exactly while the walkie
   * session is (see probeLoop for the battery arithmetic). */
  private var probeThread: Thread? = null
  /** Which rows were demoted at the last sweep — kept so the peers event
   * fires on a CHANGE of proof, not on every tick. */
  @Volatile private var unprovenRows: Set<String> = emptySet()
  private var track: AudioTrack? = null
  /** Atomic because TWO threads stamp frames: the walkie-tx capture loop
   * and the RN native-modules thread via sendSignal. A plain Int lost
   * updates there — two frames sharing one seq, and the receiver's
   * freshness gate eating one of them as a duplicate. incrementAndGet
   * wraps mod 2^32, so masking to 0xFFFF keeps the ring monotonic. */
  private val seqCounter = java.util.concurrent.atomic.AtomicInteger(0)
  /** A 1:1 call is connecting or live (set from JS, setCallActive): walkie
   * PLAYBACK is muted so the pod's voice cannot ride this loudspeaker into
   * the call's open mic — WebRTC's AEC cancels only its own far-end, not a
   * separate app-owned AudioTrack. TX suppression alone left this half of
   * the echo loop open. */
  @Volatile private var callActive = false
  private val lastSeq = ConcurrentHashMap<Long, Int>()
  @Volatile private var lastSpeakEmit = 0L

  private fun emit(name: String, body: com.facebook.react.bridge.WritableMap) {
    if (ctx.hasActiveReactInstance()) {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body)
    }
  }

  /**
   * Who we actually transmit to, recomputed only when the peer set changes
   * (NOT per frame — a 20 ms loop must not sort). Ordered by the senderHash
   * that rides the service name, so every phone that has discovered the same
   * people picks the SAME subset. That is not a quorum protocol and does not
   * pretend to be one: two phones with different discovery states can still
   * disagree. Determinism just makes the common case agree for free.
   */
  @Volatile private var targets: List<Peer> = emptyList()

  /** One row per PERSON, deduped from the transports (below): what the
   * panel lists. Uncapped — the cap bounds transmission, never sight. */
  @Volatile private var roster: List<Peer> = emptyList()

  /** Hi-fi first: a podmate reachable on both a datagram rung and the BLE
   * pipe is carried on the better one, and the other copy is dropped
   * HERE — before it can waste a transmit slot or list one human twice. */
  private fun rungRank(rung: String): Int = when (rung) {
    "lan" -> 0
    "aware" -> 1
    else -> 2
  }

  /**
   * §5, ASKED CONTINUOUSLY: has this row PROVEN it is alive?
   *
   * A datagram row proves itself with inbound frames and nothing else —
   * not with a callback, not with a discovery record, not with the fact
   * that it once worked. The keep-alive below guarantees a healthy link
   * always has recent inbound, so silence here means death, not quiet.
   *
   * A BLE row is exempt because it is proven by a different fact: rung 3
   * rides a GATT connection, and the link drops the row the moment that
   * connection does. It has no socket to go quietly dead behind.
   */
  private fun proven(p: Peer, now: Long): Boolean =
    p.sendBle != null || (now - p.lastInbound.get()) < STALE_MS

  /** Rung rank AFTER the proof: an unproven datagram row ranks below every
   * proven row — below BLE — so a demoted aware row falls to the lo-fi
   * pipe or to a live LAN row instead of holding the person's best slot. */
  private fun rank(p: Peer, now: Long): Int =
    if (proven(p, now)) rungRank(p.rung) else 3

  private fun recomputeTargets() {
    // ONE ROW PER PERSON. Every key shape carries the senderHash at
    // pipe-index 1 ("pp|<hex>|<name>", "aware|<hex>|<name>",
    // "ble|<hex>|<name>"), so the same podmate on several rungs collapses
    // to their best rung. Without this a phone near an Aware peer that is
    // ALSO in BLE range listed them twice and unicast every frame twice.
    //
    // RANKED BY PROOF, not by rung word (§5). A dead aware row used to win
    // this comparison against a live BLE row for the same person purely
    // because "aware" outranks "ble" on paper — and then every targeted
    // send resolved the dead one.
    val now = System.currentTimeMillis()
    val best = HashMap<String, Pair<String, Peer>>()
    for ((key, p) in peers) {
      val hash = key.split("|").getOrNull(1) ?: continue
      val cur = best[hash]
      if (cur == null || rank(p, now) < rank(cur.second, now)) {
        best[hash] = Pair(hash, p)
      }
    }
    val rows = best.entries
      .sortedBy { it.key }
      .map { it.value.second }
    roster = rows
    targets = rows.take(MAX_PEERS)
  }

  private fun emitPeers() {
    recomputeTargets()
    val m = Arguments.createMap()
    m.putInt("count", roster.size)
    // What we will actually reach. The panel needs BOTH: "12 people are here
    // but you are talking to 9" is the true sentence, and it cannot be
    // derived from count alone by a JS side that does not know the cap.
    m.putInt("talkingTo", targets.size)
    val now = System.currentTimeMillis()
    val arr = Arguments.createArray()
    val rungs = Arguments.createArray()
    for (p in roster) {
      arr.pushString(p.name)
      // Aligned with names: which rung carries each row, so the panel can
      // wear the lo-fi badge on exactly the peers that SOUND lo-fi —
      // the one badge, nothing louder (docs/WALKIE-LADDER.md §5a).
      //
      // A DEMOTED row says "stale", and the badge is the same one: this
      // person is at the floor, which is precisely what a demoted row
      // knows and all §5a allows us to say. What it must never do is keep
      // the plain name a hi-fi rung earns — that plain name is the lie the
      // owner watched on screen while the datapath was dead.
      rungs.pushString(if (proven(p, now)) p.rung else "stale")
    }
    m.putArray("names", arr)
    m.putArray("rungs", rungs)
    // Identity rows for targeted verbs (the 1:1 call button): the
    // senderHash rides every peer key ("pp|<hex>|.." / "aware|<hex>|..").
    // CALLABLE identities only — one row per hash, datagram rungs only
    // (host != null). A "ble|" row is not an address sendSignal can dial,
    // so a BLE-only podmate stays on the channel list above WITHOUT a call
    // button, instead of wearing one that can never ring them.
    // ...and PROVEN rows only. A row that cannot prove it is alive is not
    // an address: offering its Call button is announcing availability,
    // which is the one thing §5 forbids. The button comes back by itself
    // the moment a frame — a keep-alive answer, a probe, an INVITE —
    // re-stamps the row.
    val callable = HashMap<String, Peer>()
    for ((key, p) in peers) {
      if (p.host == null) {
        continue // BLE pipe: voice yes, call signaling no
      }
      if (!proven(p, now)) {
        continue // demoted: audible maybe, dialable no
      }
      val hash = key.split("|").getOrNull(1) ?: continue
      val cur = callable[hash]
      if (cur == null || rungRank(p.rung) < rungRank(cur.rung)) {
        callable[hash] = p
      }
    }
    val rows = Arguments.createArray()
    for ((hash, p) in callable) {
      val row = Arguments.createMap()
      row.putString("name", p.name)
      row.putString("hash", hash)
      rows.pushMap(row)
    }
    m.putArray("peers", rows)
    emit(PEERS_EVENT, m)
  }

  // ------------------------------------------------------------ lifecycle

  @ReactMethod
  fun start(podHashD: Double, senderHashD: Double, displayName: String, promise: Promise) {
    if (socket != null) {
      promise.resolve(null)
      return
    }
    podHash = podHashD.toLong() and 0xFFFFFFFFL
    senderHash = senderHashD.toLong() and 0xFFFFFFFFL
    try {
      val s = DatagramSocket(0)
      socket = s
      receiving = true
      receiveThread = Thread({ receiveLoop(s) }, "walkie-rx").apply {
        isDaemon = true
        start()
      }

      val manager = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
      nsd = manager
      // The service NAME carries who this is: pp|<senderHash hex>|<name>.
      // Bonjour instance names allow spaces/unicode; '|' keeps parsing dumb.
      val clean = displayName.replace("|", "/").take(24).ifEmpty { "someone" }
      val info = NsdServiceInfo().apply {
        serviceName = "pp|${java.lang.Long.toHexString(senderHash)}|$clean"
        serviceType = SERVICE_TYPE
        port = s.localPort
      }
      val reg = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(i: NsdServiceInfo) {
          // Android may rename on collision; remember OUR final name so
          // discovery can skip self.
          myServiceName = i.serviceName
        }

        override fun onRegistrationFailed(i: NsdServiceInfo, err: Int) {}
        override fun onServiceUnregistered(i: NsdServiceInfo) {}
        override fun onUnregistrationFailed(i: NsdServiceInfo, err: Int) {}
      }
      regListener = reg
      manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, reg)

      val disc = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(t: String) {}
        override fun onStartDiscoveryFailed(t: String, err: Int) {}
        override fun onStopDiscoveryFailed(t: String, err: Int) {}
        override fun onDiscoveryStopped(t: String) {}

        override fun onServiceFound(i: NsdServiceInfo) {
          if (i.serviceName == myServiceName || !i.serviceName.startsWith("pp|")) {
            return
          }
          // SELF BY IDENTITY, NOT BY NAME. The name check above has two
          // holes, both field-measured on a phone hosting the pod's hotspot
          // (the base-station posture the design recommends): discovery can
          // fire before onServiceRegistered has recorded our final name,
          // and mDNS on a second interface (the hotspot's ap_br) re-offers
          // OUR OWN service under a collision-renamed instance — either way
          // the phone walks into its own channel list. The senderHash in
          // the wire name is the canonical identity the name is not.
          if (i.serviceName.split("|").getOrNull(1) ==
            java.lang.Long.toHexString(senderHash)
          ) {
            return
          }
          // resolveService is one-shot per listener instance on purpose.
          manager.resolveService(i, object : NsdManager.ResolveListener {
            override fun onResolveFailed(ri: NsdServiceInfo, err: Int) {}
            override fun onServiceResolved(ri: NsdServiceInfo) {
              val host = ri.host ?: return
              val label = ri.serviceName.split("|").getOrNull(2) ?: "someone"
              peers[ri.serviceName] = Peer(host, ri.port, label)
              emitPeers()
            }
          })
        }

        override fun onServiceLost(i: NsdServiceInfo) {
          peers.remove(i.serviceName)
          emitPeers()
        }
      }
      discListener = disc
      manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, disc)

      // THE OWN-LINK RUNG (docs/WALKIE-LADDER.md §9): phones with the
      // Aware radio also discover each other with NO shared network and
      // feed the SAME peer table. Failure at any point simply contributes
      // no peers — the LAN rung above is already running.
      try {
        if (ctx.packageManager.hasSystemFeature(
            android.content.pm.PackageManager.FEATURE_WIFI_AWARE,
          )
        ) {
          val link = WalkieAwareLink(
          ctx,
          podHash,
          senderHash,
          displayName,
          onPeer = { key, host, port, name, sock ->
            val peer = Peer(host, port, name, sock, "aware")
            peers[key] = peer
            emitPeers()
            // THE PROBE, AT LAST (ladder §5 step 3). The initiator's row is
            // born knowing the peer's address and port; the responder's
            // cannot be, because the framework never tells a responder a
            // peer's port. So the side that CAN send goes first, with a
            // zero-payload frame, and the other side learns its return path
            // from it. Without this the pair stayed asymmetric until
            // somebody keyed a mic: voice worked, and the Call button —
            // which needs a dialable row, not an audible one — did not.
            //
            // It terminates in two frames. The responder answers here on
            // its own onPeer; the initiator's link refuses to mint a second
            // row for a peer it initiates to, so no onPeer, so no reply.
            sendProbe(peer)
          },
          onPeerLost = { key ->
            peers.remove(key)
            emitPeers()
          },
          onSocket = { sock ->
            Thread({ receiveLoop(sock) }, "walkie-rx-aware").apply {
              isDaemon = true
              start()
            }
          },
        )
          aware = link
          link.start()
        }
      } catch (_: Exception) {
        // RUNG ISOLATION (ladder §1, measured on the Pixel 7: a missing
        // ACCESS_WIFI_STATE surfaced as a SecurityException that killed
        // the WHOLE walkie start): whatever the optional rung throws, the
        // LAN rung above is already running and must stay running.
        aware = null
      }

      // RUNG 3 — LIVE LO-FI OVER BLE (docs/WALKIE-LADDER.md §2, §6): the
      // ladder's floor for LIVE talk. Two phones with no Wi-Fi of any
      // kind still carry choppy voice over a GATT pipe; peers arrive
      // under "ble|" keys and recomputeTargets keeps a podmate who is
      // also on a hi-fi rung on that rung instead. Fenced exactly like
      // the aware rung: whatever BLE throws, the rungs above keep running.
      try {
        val ble = WalkieBleLink(
          ctx,
          podHash,
          senderHash,
          clean,
          onPeer = { key, name, send ->
            peers[key] = Peer(null, 0, name, null, "ble", send)
            emitPeers()
          },
          onPeerLost = { key ->
            if (peers.remove(key) != null) {
              emitPeers()
            }
          },
          onFrame = { bytes -> handleFrame(bytes, bytes.size, null, null) },
        )
        bleLink = ble
        ble.start()
      } catch (e: Exception) {
        // Fenced on purpose — but SILENT fencing cost a bench hour tonight:
        // the rung vanished on a ship build and nothing said why. Name it.
        Log.i("PlayaPalBleVoice", "voice//start-failed err=" + e)
        bleLink = null
      }

      // Last, because it probes whatever the rungs above discovered: the
      // keep-alive that turns §5's "availability is PROVEN" from a rule the
      // ladder states into a rule the walkie enforces every few seconds.
      unprovenRows = emptySet()
      probeThread = Thread({ probeLoop() }, "walkie-probe").apply {
        isDaemon = true
        start()
      }
      promise.resolve(null)
    } catch (e: Exception) {
      stopInternal()
      promise.reject("walkie", e.message ?: "could not start the walkie")
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  private fun stopInternal() {
    talking = false
    receiving = false
    // The sweep sleeps in SWEEP_MS bites; interrupting means the thread is
    // gone now rather than up to two seconds after the walkie is.
    probeThread?.interrupt()
    probeThread = null
    unprovenRows = emptySet()
    // A walkie restart must never inherit a stale mute: the JS unmute arc
    // rides the panel's call effect, and a panel unmounted mid-call tears
    // the module down through here instead.
    callActive = false
    try {
      aware?.stop()
    } catch (_: Exception) {}
    aware = null
    try {
      bleLink?.stop()
    } catch (_: Exception) {}
    bleLink = null
    try {
      regListener?.let { nsd?.unregisterService(it) }
    } catch (_: Exception) {}
    try {
      discListener?.let { nsd?.stopServiceDiscovery(it) }
    } catch (_: Exception) {}
    regListener = null
    discListener = null
    socket?.close()
    socket = null
    peers.clear()
    targets = emptyList()
    roster = emptyList()
    lastSeq.clear()
    try {
      track?.release()
    } catch (_: Exception) {}
    track = null
  }

  // ------------------------------------------------------------ talk

  @ReactMethod
  fun startTalking(promise: Promise) {
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("permission", Manifest.permission.RECORD_AUDIO)
      return
    }
    val s = socket ?: run {
      promise.reject("idle", "walkie is not on")
      return
    }
    if (talking) {
      promise.resolve(null)
      return
    }
    talking = true
    recordThread = Thread({
      var rec: AudioRecord? = null
      try {
        val minBuf = AudioRecord.getMinBufferSize(
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
        rec = AudioRecord(
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          maxOf(minBuf, FRAME_BYTES * 4),
        )
        rec.startRecording()
        val buf = ByteArray(HEADER + FRAME_BYTES)
        buf[0] = 'P'.code.toByte()
        buf[1] = 'W'.code.toByte()
        buf[2] = FRAME_HEAD.toByte()
        writeU32(buf, 3, podHash)
        writeU32(buf, 7, senderHash)
        // Rung 3's accumulator: BLE_BATCH 20 ms captures become one 60 ms
        // ADPCM frame for the BLE-carried targets. Allocated once, out of
        // the loop — this thread must not churn the GC at 50 Hz.
        val bleSamples = ShortArray(FRAME_SAMPLES * BLE_BATCH)
        var bleFill = 0
        while (talking) {
          var got = 0
          while (got < FRAME_BYTES && talking) {
            val n = rec.read(buf, HEADER + got, FRAME_BYTES - got)
            if (n <= 0) {
              break
            }
            got += n
          }
          if (got <= 0) {
            continue
          }
          val seq = seqCounter.incrementAndGet() and 0xFFFF
          buf[11] = ((seq shr 8) and 0xFF).toByte()
          buf[12] = (seq and 0xFF).toByte()
          // BOUNDED FAN-OUT (see MAX_PEERS): the cap is enforced HERE, on the
          // hot path, not in the UI — a JS-side-only cap would still let a
          // 60-person pod melt the radio the moment the panel was wrong.
          var anyBle = false
          for (p in targets) {
            if (p.sendBle != null) {
              // Rung 3 rides the 60 ms lane below — a 653-byte PCM frame
              // does not fit a GATT write, and the whole rung exists
              // because the codec changes, not the frame.
              anyBle = true
              continue
            }
            val host = p.host ?: continue
            try {
              (p.socket ?: s).send(DatagramPacket(buf, HEADER + got, host, p.port))
            } catch (_: Exception) {
              // one unreachable peer must not stop the broadcast
            }
          }
          if (anyBle) {
            var i = 0
            while (i + 1 < got && bleFill < bleSamples.size) {
              // PCM16LE straight off the wire buffer — the byte order
              // AudioRecord filled it with.
              bleSamples[bleFill++] =
                (((buf[HEADER + i + 1].toInt()) shl 8) or (buf[HEADER + i].toInt() and 0xFF)).toShort()
              i += 2
            }
            if (bleFill >= bleSamples.size) {
              // Same seq counter as the PCM lane ON PURPOSE: a podmate
              // hearing this phone on two rungs at once plays whichever
              // copy lands first and the per-sender seq gate drops the
              // other — dedupe for free, no negotiation.
              val payload = Adpcm.encode(downsample(bleSamples))
              val f = ByteArray(HEADER + payload.size)
              f[0] = 'P'.code.toByte()
              f[1] = 'W'.code.toByte()
              f[2] = ((FRAME_VERSION shl 4) or CODEC_ADPCM8K).toByte()
              writeU32(f, 3, podHash)
              writeU32(f, 7, senderHash)
              f[11] = ((seq shr 8) and 0xFF).toByte()
              f[12] = (seq and 0xFF).toByte()
              payload.copyInto(f, HEADER)
              for (p in targets) {
                p.sendBle?.invoke(f, f.size)
              }
              bleFill = 0
            }
          } else {
            bleFill = 0
          }
        }
      } catch (_: Exception) {
        // recorder died (route change etc.) — releasing below is the recovery
      } finally {
        try {
          rec?.stop()
        } catch (_: Exception) {}
        rec?.release()
      }
    }, "walkie-tx").apply {
      isDaemon = true
      start()
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun stopTalking(promise: Promise) {
    talking = false
    promise.resolve(null)
  }

  /** The call's grip on the walkie SPEAKER (docs/VIDEO-CALLS.md §5): JS
   * sets true while a call is connecting/live and false on every call-end
   * arc; handleFrame drops playback while it holds. The walkie stays ON —
   * peers, signaling and the seq gates all keep running. */
  @ReactMethod
  fun setCallActive(active: Boolean, promise: Promise) {
    callActive = active
    // The call's OWN audio (WebRTC's ADM) routes to the EARPIECE by
    // default — the owner's field report: walkie loud, call whisper-quiet.
    // A video call is a speakerphone by nature; route it there while the
    // call holds, and put the route back when it ends.
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (active) {
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        am.isSpeakerphoneOn = true
      } else {
        am.mode = AudioManager.MODE_NORMAL
        am.isSpeakerphoneOn = false
      }
    } catch (e: Exception) {
      Log.i("PlayaPal", "call//audio-route err=" + e)
    }
    promise.resolve(null)
  }

  /**
   * Unicast one call-signal payload (a CODEC_CALL frame) to the peer with
   * this senderHash, over whatever socket already reaches them — the LAN
   * socket or their Aware datapath socket, exactly like voice. Loss is the
   * JS reliable layer's job; this only refuses what can never work.
   *
   * `fanout` is BREADTH: how many of that podmate's datagram rows this one
   * payload may ride, best-proven first, clamped to MAX_SIGNAL_FANOUT
   * (docs/VIDEO-CALLS.md §2a). The JS signaler sends first tries as
   * singles and retransmissions as twos, because a retransmission means
   * the road we picked is not delivering — and the field failure was a
   * road, not a moment: eight retransmits into one silently dead Aware
   * interface, none of them erroring. The receiver dedupes by message id
   * (callSignal.ts), so the extra copy costs one datagram and nothing else.
   */
  @ReactMethod
  fun sendSignal(toHashD: Double, payloadB64: String, fanoutD: Double, promise: Promise) {
    val s = socket ?: run {
      promise.reject("idle", "walkie is not on")
      return
    }
    val hex = java.lang.Long.toHexString(toHashD.toLong() and 0xFFFFFFFFL)
    // DATAGRAM-CAPABLE ONLY, best rung first — the same rungRank rule
    // recomputeTargets lives by. A podmate on Wi-Fi AND in BLE range holds
    // BOTH a "pp|" and a "ble|" row for one hash, and firstOrNull over a
    // ConcurrentHashMap is bucket order: picking the "ble|" row (host=null,
    // port=0) made DatagramSocket.send throw, so every call-signal frame to
    // that podmate died and the callee's phone never rang. A BLE-only hash
    // finds nothing here ON PURPOSE: emitPeers never offered it as a
    // callable identity, so this is the stale-roster case, not a path.
    val now = System.currentTimeMillis()
    val rows = peers.entries
      .filter { it.key.split("|").getOrNull(1) == hex && it.value.host != null }
      // BY PROOF FIRST (§5): rank() puts every unproven row below every
      // proven one, so a podmate whose aware datapath went quiet is dialed
      // on their live LAN row instead. The rank used to trust the row's
      // rung word alone, and the row was the thing that was lying.
      .sortedBy { rank(it.value, now) }
      .map { it.value }
    if (rows.isEmpty()) {
      promise.reject("gone", "that podmate is not on the channel")
      return
    }
    // Only PROVEN rows carry a signal, and only as many as asked for.
    // distinctBy: two rows for one person can resolve to the same address
    // (a rename mints a new key on the same host/port), and sending the
    // identical datagram twice down one road is the cost of a hedge with
    // none of the benefit.
    val breadth = fanoutD.toInt().coerceIn(1, MAX_SIGNAL_FANOUT)
    val live = rows
      .filter { proven(it, now) }
      .distinctBy { "${it.host}:${it.port}" }
      .take(breadth)
    if (live.isEmpty()) {
      // NO PROVEN PATH. Sending here is what the field measured: eight
      // retransmits into a downed interface, every one of them "sent"
      // without an error, and a caller told "No answer" about a phone that
      // never heard a thing. Failing here is the same loss to the reliable
      // layer above (it treats a reject as loss) and the truth to everyone
      // else — and the JS side reads THIS code to widen its next sends
      // instead of retrying the same dead row. Reply traffic is unaffected
      // by construction: the INVITE being ACKed re-stamped the very row the
      // ACK will ride.
      promise.reject("stale", "that podmate's link went quiet")
      return
    }
    val data = try {
      android.util.Base64.decode(payloadB64, android.util.Base64.NO_WRAP)
    } catch (_: Exception) {
      promise.reject("payload", "bad signal payload")
      return
    }
    if (data.size > FRAME_BYTES) {
      // The shared receive buffer is HEADER + FRAME_BYTES; a longer
      // payload would arrive TRUNCATED, not rejected — refuse it here so
      // the failure is loud and local instead of silent and remote.
      promise.reject("size", "signal payload too large")
      return
    }
    // ONE FRAME, ONE SEQ, N ROADS. Built once and sent to each row: the
    // copies are the SAME message, and the signal path skips the audio seq
    // gate anyway (§2) — the receiver's dedupe is by message id, which the
    // payload already carries.
    val buf = ByteArray(HEADER + data.size)
    buf[0] = 'P'.code.toByte()
    buf[1] = 'W'.code.toByte()
    buf[2] = ((FRAME_VERSION shl 4) or CODEC_CALL).toByte()
    writeU32(buf, 3, podHash)
    writeU32(buf, 7, senderHash)
    val seq = seqCounter.incrementAndGet() and 0xFFFF
    buf[11] = ((seq shr 8) and 0xFF).toByte()
    buf[12] = (seq and 0xFF).toByte()
    data.copyInto(buf, HEADER)
    var sent = 0
    var last: Exception? = null
    for (p in live) {
      try {
        (p.socket ?: s).send(DatagramPacket(buf, buf.size, p.host, p.port))
        sent += 1
      } catch (e: Exception) {
        // A hedge exists because one road can be bad. One throwing row
        // must not cost the other its copy — only ALL of them failing is
        // a failed send.
        last = e
      }
    }
    if (sent > 0) {
      promise.resolve(null)
    } else {
      promise.reject("send", last?.message ?: "could not send the signal")
    }
  }

  /**
   * One zero-payload PW frame (CODEC_PROBE) to one peer — the ladder's
   * rung-negotiation frame from §5 step 3, which the codec byte has always
   * reserved and nothing has ever sent.
   *
   * It says only "I am here and this is where my answers come from", which
   * is exactly what an Aware RESPONDER cannot learn any other way. Sent on
   * the peer's own socket, never the LAN socket: an Aware peer rides a
   * socket bound to its datapath network, and the LAN socket would put the
   * frame on the wrong radio.
   *
   * Fire and forget. The receiver drops it at the unknown-codec gate after
   * the return path is registered, and a lost probe costs only the symmetry
   * the next real frame restores anyway.
   */
  private fun sendProbe(peer: Peer) {
    val s = peer.socket ?: socket ?: return
    val host = peer.host ?: return
    if (peer.port <= 0) {
      return
    }
    try {
      val buf = ByteArray(HEADER)
      buf[0] = 'P'.code.toByte()
      buf[1] = 'W'.code.toByte()
      buf[2] = ((FRAME_VERSION shl 4) or CODEC_PROBE).toByte()
      writeU32(buf, 3, podHash)
      writeU32(buf, 7, senderHash)
      // The header has a seq field, so the probe fills it from the same ring
      // as voice. It never reaches the receiver's freshness gate — the
      // unknown-codec gate drops a probe first — so this neither helps nor
      // harms that gate; it just keeps ONE monotonic ring per sender instead
      // of a second numbering nobody can reason about.
      val seq = seqCounter.incrementAndGet() and 0xFFFF
      buf[11] = ((seq shr 8) and 0xFF).toByte()
      buf[12] = (seq and 0xFF).toByte()
      s.send(DatagramPacket(buf, buf.size, host, peer.port))
    } catch (_: Exception) {
      // The rung contributes what it can; a probe that will not send is not
      // a reason to fail anything above it.
    }
  }

  /**
   * THE KEEP-ALIVE (docs/WALKIE-LADDER.md §5b) — what makes silence mean
   * death instead of idleness.
   *
   * Without it, "no inbound for 10 s" is the normal state of a walkie
   * nobody is talking on, so a liveness rule built on inbound frames would
   * demote every healthy row the moment the pod went quiet. With it, every
   * phone puts one 13-byte probe on each datagram row every PROBE_MS, so a
   * link that is up ALWAYS has recent inbound and a link that is down says
   * so within STALE_MS.
   *
   * ONE FIXED CADENCE, no dial storms. The sweep ticks faster than the
   * probe so a demotion reaches the UI promptly, but probing itself is
   * clock-driven and peer-count-bounded: it adds no request loop, and the
   * only retry machinery it can wake is the aware link's existing one,
   * through its own 30 s floor.
   *
   * Battery: this runs between start() and stop() — the walkie session, the
   * thing the user switched on — and it is a rounding error beside the
   * radio it keeps warm (~26 B/s at the 9-peer cap, against ~290 KB/s for
   * one person holding the talk button).
   */
  private fun probeLoop() {
    var lastProbe = 0L
    while (receiving) {
      try {
        Thread.sleep(SWEEP_MS)
      } catch (_: InterruptedException) {
        return // stopInternal interrupts; a walkie that is off probes nothing
      }
      if (!receiving) {
        return
      }
      val now = System.currentTimeMillis()
      val probing = now - lastProbe >= PROBE_MS
      if (probing) {
        lastProbe = now
      }
      val unproven = HashSet<String>()
      for ((key, p) in peers) {
        if (p.host == null) {
          continue // rung 3 is proven by its GATT connection, not by frames
        }
        if (probing) {
          sendProbe(p)
        }
        if (!proven(p, now)) {
          unproven.add(key)
          // THE NUDGE (§5 rule 5, through machinery that already exists):
          // the aware link is the only thing that can re-dial rung 4, and
          // it never learned this row went quiet — the framework told it
          // nothing. Its own 30 s floor bounds what happens next.
          if (key.startsWith("aware|")) {
            nudgeAware(key)
          }
        }
      }
      // EMIT ON CHANGE ONLY. A demotion and a re-promotion are both events
      // the panel must see; a 2 s heartbeat of identical peer events is
      // noise the JS side would re-render on forever.
      if (unproven != unprovenRows) {
        // NAMED, because this is the whole lane's evidence: the two-Pixel
        // bench reads these two lines to tell "demoted honestly" from
        // "never noticed", and the failure they replace was silent by
        // definition. One line per transition, not per sweep.
        for (key in unproven) {
          if (!unprovenRows.contains(key)) {
            Log.i(TAG, "walkie//row-demoted key=" + key)
          }
        }
        for (key in unprovenRows) {
          // A row that LEFT the table did not recover, it died — saying
          // "proven" about it would put the bench's own evidence line on
          // the wrong event.
          if (!unproven.contains(key) && peers.containsKey(key)) {
            Log.i(TAG, "walkie//row-proven key=" + key)
          }
        }
        unprovenRows = unproven
        emitPeers()
      }
    }
  }

  private fun nudgeAware(key: String) {
    val hex = key.split("|").getOrNull(1) ?: return
    val hash = try {
      java.lang.Long.parseLong(hex, 16)
    } catch (_: Exception) {
      return
    }
    aware?.noteSilent(hash)
  }

  // ------------------------------------------------------------ diagnosis

  /**
   * Our own IPv4 + CIDR prefix on the Wi-Fi-class interface, or null when
   * none carries one — the walkie panel's cross-subnet diagnosis (field
   * test #8: two routers behind one network name left "Nobody else on the
   * channel yet" as the app's only word). NetworkInterface needs no
   * permission; ConnectivityManager would drag ACCESS_NETWORK_STATE into
   * the manifest for one diagnostic line. Rejects on failure — "can't
   * tell" must never masquerade as "no Wi-Fi".
   */
  @ReactMethod
  fun netInfo(promise: Promise) {
    try {
      var bestRank = Int.MAX_VALUE
      var best: java.net.InterfaceAddress? = null
      val ifaces = java.net.NetworkInterface.getNetworkInterfaces()
      if (ifaces != null) {
        for (ni in ifaces) {
          if (!ni.isUp || ni.isLoopback) {
            continue
          }
          val rank = WIFI_IFACES.indexOfFirst { ni.name.startsWith(it) }
          if (rank < 0 || rank >= bestRank) {
            continue
          }
          for (ia in ni.interfaceAddresses) {
            if (ia.address is java.net.Inet4Address) {
              bestRank = rank
              best = ia
              break
            }
          }
        }
      }
      if (best == null) {
        promise.resolve(null)
        return
      }
      val m = Arguments.createMap()
      m.putString("ip", best.address.hostAddress)
      m.putInt("prefix", best.networkPrefixLength.toInt())
      promise.resolve(m)
    } catch (e: Exception) {
      promise.reject("walkie", e.message ?: "could not read the network")
    }
  }

  // ------------------------------------------------------------ receive

  private fun receiveLoop(s: DatagramSocket) {
    val buf = ByteArray(HEADER + FRAME_BYTES)
    while (receiving) {
      try {
        val pkt = DatagramPacket(buf, buf.size)
        s.receive(pkt)
        handleFrame(buf, pkt.length, s, pkt)
      } catch (_: Exception) {
        // A CLOSED socket is not a torn packet: receive() on one throws
        // instantly and forever, so swallowing and continuing spins this
        // thread at 100 % CPU for the life of the walkie. Aware sockets are
        // closed by the link on every datapath loss — and now on every
        // silence-renewal too — so this is not a rare path. `receiving`
        // still rules the ordinary stop.
        if (s.isClosed) {
          return
        }
      }
    }
  }

  /**
   * ONE receive path for every rung (ladder §3: the rung changes the codec
   * and the socket, never the frame): gates, codec dispatch, gain, the
   * track write and the speaking chip all live here. srcSocket/pkt are the
   * datagram lanes' extras — the aware return-path registration below
   * needs them; the BLE rung passes null for both, because its frames
   * arrived by GATT write and have no datagram source to learn.
   */
  private fun handleFrame(buf: ByteArray, n: Int, srcSocket: DatagramSocket?, pkt: DatagramPacket?) {
    // `< HEADER`, not `<= HEADER`: the ladder's probe (§5 step 3) is a frame
    // with a ZERO-LENGTH payload, so a full header is a whole valid frame.
    // Rejecting it here is what left CODEC_PROBE declared and unreachable.
    // Nothing downstream reads past byte 12 without a codec that has one:
    // the seq bytes are 11 and 12, and the unknown-codec gate below drops
    // the probe before any payload is touched.
    if (n < HEADER || buf[0] != 'P'.code.toByte() || buf[1] != 'W'.code.toByte()) {
      return
    }
    val head = buf[2].toInt() and 0xFF
    if ((head shr 4) != FRAME_VERSION) {
      return // a protocol we do not speak
    }
    if (readU32(buf, 3) != podHash) {
      return // someone else's pod on the same LAN
    }
    val from = readU32(buf, 7)
    if (from == senderHash) {
      return // our own echo
    }
    // §5's PROOF, taken on every rung's every frame — voice, probe, signal
    // alike. Stamped before any gate below can drop the frame: a probe is
    // dropped at the unknown-codec gate and a stale seq is dropped at the
    // freshness gate, and BOTH of them still prove the row is alive.
    stampInbound(from, srcSocket)
    // An Aware INITIATOR reveals its return path with its first frame
    // (the responder advertised a port; identity is the senderHash in
    // the frame, never the packet source alone). Registering it makes
    // the voice path symmetric without one more handshake. Hoisted above
    // the codec dispatch because a call's FIRST packets can be signal
    // frames — the return path must not wait for voice; the `known`
    // check keeps a stale duplicate from double-registering.
    if (srcSocket != null && pkt != null && srcSocket !== socket) {
      // THE LINK MINTS IT, not this method. The row belongs to the same
      // owner as every other aware row, so the link's one cleanup path
      // covers it: while this method minted the row itself, the two sides
      // computed the SAME key from the same discovered name, and the link's
      // peer cleanup deleted a working return path it had never created.
      // That is the field report — voice both ways, no Call button.
      aware?.noteReturnPath(from, pkt.address, pkt.port, srcSocket)
    }
    // Call signaling (docs/VIDEO-CALLS.md): opaque bytes up to JS. No
    // seq gate on purpose — freshness gating is for audio; the signal
    // layer dedupes by its own message ids, and a dropped ack RELIES
    // on the retransmit arriving.
    if ((head and 0x0F) == CODEC_CALL) {
      val m = Arguments.createMap()
      m.putString("from", java.lang.Long.toHexString(from))
      m.putString(
        "payload",
        android.util.Base64.encodeToString(
          buf, HEADER, n - HEADER, android.util.Base64.NO_WRAP,
        ),
      )
      emit(SIGNAL_EVENT, m)
      return
    }
    // Unknown codec = DROP, never play. Feeding an unrecognised payload
    // to a PCM16 track is not degraded audio, it is noise at whatever
    // volume the pod is holding to its ear. Two codecs are known now:
    // rung 4's PCM16 and rung 3's ADPCM.
    if ((head and 0x0F) != CODEC_PCM16_16K && (head and 0x0F) != CODEC_ADPCM8K) {
      return
    }
    val sq = ((buf[11].toInt() and 0xFF) shl 8) or (buf[12].toInt() and 0xFF)
    val last = lastSeq[from] ?: -1
    // Drop stale/duplicate frames; accept wrap (a jump backwards by
    // more than half the ring reads as a wrap, not staleness). Because
    // seq is per SENDER and shared across that sender's rungs, this gate
    // is also what deduplicates a sender heard on two rungs at once.
    if (last in 0..0xFFFF) {
      val diff = (sq - last) and 0xFFFF
      if (diff == 0 || diff > 0x8000) {
        return
      }
    }
    lastSeq[from] = sq
    if (callActive || talking) {
      // Mute walkie PLAYBACK while a call is connecting/live: this
      // loudspeaker feeds the call's open mic, so pod voice played here is
      // relayed to the person on the call (the echo loop TX suppression
      // alone could not close). Seq bookkeeping above still ran, so
      // playback resumes cleanly at hang-up with no stale-frame burst.
      //
      // ...and while THIS phone is keying (half-duplex, like every radio
      // ever made): with two phones a foot apart, played-back pod voice
      // re-entered the still-open mic and the RX pre-amp pushed the loop
      // over unity — the owner heard the howl from another room
      // (field-measured 2026-08-25). Not hearing the channel while you
      // hold the button is what a walkie IS; releasing resumes playback
      // on the same clean-seq terms as hang-up.
      return
    }
    if ((head and 0x0F) == CODEC_ADPCM8K) {
      // Rung 3: decode, upsample 8 -> 16 kHz, same RX_GAIN, same track —
      // a lo-fi speaker sounds rougher, never different in kind.
      val pcm8 = Adpcm.decode(buf, HEADER, n - HEADER)
      if (pcm8.isNotEmpty()) {
        val out = ByteArray(pcm8.size * 4)
        upsampleWithGain(pcm8, out)
        ensureTrack().write(out, 0, out.size)
      }
    } else {
      // PRE-AMP (field test, owner 2026-08-25: "REALLY soft even at max
      // volume"): phone mics level conservatively and the playa is loud.
      // Fixed digital gain with hard saturation — a clipped consonant
      // beats an inaudible sentence on a bike at 15 mph.
      var i = HEADER
      while (i + 1 < n) {
        val lo = buf[i].toInt() and 0xFF
        val hi = buf[i + 1].toInt()
        var sample = (hi shl 8) or lo
        sample = (sample * RX_GAIN).toInt().coerceIn(-32768, 32767)
        buf[i] = (sample and 0xFF).toByte()
        buf[i + 1] = ((sample shr 8) and 0xFF).toByte()
        i += 2
      }
      ensureTrack().write(buf, HEADER, n - HEADER)
    }
    val now = System.currentTimeMillis()
    if (now - lastSpeakEmit > 1000) {
      lastSpeakEmit = now
      val name = peers.values.firstOrNull {
        it.name.isNotEmpty() && peerHash(it) == from
      }?.name ?: "someone"
      val m = Arguments.createMap()
      m.putString("name", name)
      m.putDouble("podHash", podHash.toDouble())
      emit(SPEAKING_EVENT, m)
    }
  }

  /**
   * Mark the ROW this frame arrived on as alive (§5).
   *
   * PER SOURCE ROW is the whole point. One podmate can hold a "pp|" row and
   * an "aware|" row at once, and the field bug was one of them vouching for
   * the other: the socket a frame lands on names exactly one of them — the
   * LAN row rides the module's own socket, an aware row rides the socket
   * bound to its datapath, and a BLE frame arrives with no socket at all
   * and belongs to the row that carries a GATT pipe.
   *
   * On the 50 Hz receive path, so it allocates ONE small string and walks a
   * handful of rows: the needle is built once and the name segment cannot
   * contain it (display names have '|' replaced upstream).
   */
  private fun stampInbound(from: Long, srcSocket: DatagramSocket?) {
    val needle = "|" + java.lang.Long.toHexString(from) + "|"
    val now = System.currentTimeMillis()
    for ((key, p) in peers) {
      if (!key.contains(needle)) {
        continue
      }
      val mine = if (srcSocket == null) {
        p.sendBle != null
      } else {
        (p.socket ?: socket) === srcSocket
      }
      if (mine) {
        p.lastInbound.set(now)
      }
    }
  }

  /** 16 -> 8 kHz by pair-averaging: the cheapest anti-alias there is, and
   * the right cost for the hot mic thread — rung 3 is lo-fi by contract. */
  private fun downsample(pcm: ShortArray): ShortArray {
    val out = ShortArray(pcm.size / 2)
    for (i in out.indices) {
      out[i] = ((pcm[2 * i] + pcm[2 * i + 1]) / 2).toShort()
    }
    return out
  }

  /** 8 -> 16 kHz with RX_GAIN and saturation: each source sample emits
   * itself and the midpoint to its successor, PCM16LE, so rung 3 rides
   * the same 16 kHz track as rung 4 — one track, one volume story. */
  private fun upsampleWithGain(pcm: ShortArray, out: ByteArray) {
    var o = 0
    for (i in pcm.indices) {
      val cur = pcm[i].toInt()
      val nxt = pcm[if (i + 1 < pcm.size) i + 1 else i].toInt()
      val a = (cur * RX_GAIN).toInt().coerceIn(-32768, 32767)
      val b = (((cur + nxt) / 2) * RX_GAIN).toInt().coerceIn(-32768, 32767)
      out[o++] = (a and 0xFF).toByte()
      out[o++] = ((a shr 8) and 0xFF).toByte()
      out[o++] = (b and 0xFF).toByte()
      out[o++] = ((b shr 8) and 0xFF).toByte()
    }
  }

  /** Sender hash rides the SERVICE NAME (pp|<hex>|<name>); resolve it back
   * so "who is talking" can show a name without another lookup table. */
  private fun peerHash(p: Peer): Long {
    for ((serviceName, peer) in peers) {
      if (peer === p) {
        val hex = serviceName.split("|").getOrNull(1) ?: return -1
        return try {
          java.lang.Long.parseLong(hex, 16)
        } catch (_: Exception) {
          -1
        }
      }
    }
    return -1
  }

  // Synchronized because three threads reach here now — "walkie-rx",
  // one "walkie-rx-aware" per datapath socket, and the BLE GATT server
  // callback thread. Unsynchronized check-then-create raced the first
  // concurrent frames into TWO AudioTracks, one of them leaked until the
  // process died (stopInternal releases only the surviving reference).
  @Synchronized
  private fun ensureTrack(): AudioTrack {
    track?.let { return it }
    val minBuf = AudioTrack.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val t = AudioTrack(
      AudioAttributes.Builder()
        // MEDIA, not VOICE_COMMUNICATION (field test, owner 2026-08-25):
        // the call-usage track rides the separate, quieter voice-call
        // volume and can route to the EARPIECE — the walkie was whispering
        // out of the wrong speaker. Media usage takes the loudspeaker and
        // the volume rocker everyone actually uses.
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build(),
      AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build(),
      maxOf(minBuf, FRAME_BYTES * 8),
      AudioTrack.MODE_STREAM,
      android.media.AudioManager.AUDIO_SESSION_ID_GENERATE,
    )
    t.play()
    track = t
    return t
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

  // NativeEventEmitter requires these two to exist, even when unused.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }
}
