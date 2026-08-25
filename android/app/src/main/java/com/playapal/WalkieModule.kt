package com.playapal

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
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
 *   WalkiePeers    { count: int, names: string[] }
 *   WalkieSpeaking { name: string, podHash: double }  (throttled ~1/s)
 */
class WalkieModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Walkie"

  companion object {
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
    const val CODEC_PCM16_16K = 0x1 // what this build sends and plays
    const val FRAME_HEAD = (FRAME_VERSION shl 4) or CODEC_PCM16_16K

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
    const val PEERS_EVENT = "WalkiePeers"
    const val SPEAKING_EVENT = "WalkieSpeaking"

    /** Wi-Fi-class interface name prefixes, best first: wlan = the client
     * Wi-Fi the walkie normally rides; swlan/ap = this phone HOSTING the
     * hotspot (the camp-mailbox case — the host is on the LAN it made). */
    private val WIFI_IFACES = listOf("wlan", "swlan", "ap")
  }

  private data class Peer(val host: InetAddress, val port: Int, val name: String)

  private var socket: DatagramSocket? = null
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
  private var track: AudioTrack? = null
  private var seq = 0
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

  private fun recomputeTargets() {
    targets = peers.entries
      .sortedBy { it.key.split("|").getOrNull(1) ?: "" }
      .take(MAX_PEERS)
      .map { it.value }
  }

  private fun emitPeers() {
    recomputeTargets()
    val m = Arguments.createMap()
    m.putInt("count", peers.size)
    // What we will actually reach. The panel needs BOTH: "12 people are here
    // but you are talking to 9" is the true sentence, and it cannot be
    // derived from count alone by a JS side that does not know the cap.
    m.putInt("talkingTo", targets.size)
    val arr = Arguments.createArray()
    for (p in peers.values) {
      arr.pushString(p.name)
    }
    m.putArray("names", arr)
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
          seq = (seq + 1) and 0xFFFF
          buf[11] = ((seq shr 8) and 0xFF).toByte()
          buf[12] = (seq and 0xFF).toByte()
          // BOUNDED FAN-OUT (see MAX_PEERS): the cap is enforced HERE, on the
          // hot path, not in the UI — a JS-side-only cap would still let a
          // 60-person pod melt the radio the moment the panel was wrong.
          for (p in targets) {
            try {
              s.send(DatagramPacket(buf, HEADER + got, p.host, p.port))
            } catch (_: Exception) {
              // one unreachable peer must not stop the broadcast
            }
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
        val n = pkt.length
        if (n <= HEADER || buf[0] != 'P'.code.toByte() || buf[1] != 'W'.code.toByte()) {
          continue
        }
        val head = buf[2].toInt() and 0xFF
        if ((head shr 4) != FRAME_VERSION) {
          continue // a protocol we do not speak
        }
        // Unknown codec = DROP, never play. Feeding an unrecognised payload
        // to a PCM16 track is not degraded audio, it is noise at whatever
        // volume the pod is holding to its ear.
        if ((head and 0x0F) != CODEC_PCM16_16K) {
          continue
        }
        if (readU32(buf, 3) != podHash) {
          continue // someone else's pod on the same LAN
        }
        val from = readU32(buf, 7)
        if (from == senderHash) {
          continue // our own echo
        }
        val sq = ((buf[11].toInt() and 0xFF) shl 8) or (buf[12].toInt() and 0xFF)
        val last = lastSeq[from] ?: -1
        // Drop stale/duplicate frames; accept wrap (a jump backwards by
        // more than half the ring reads as a wrap, not staleness).
        if (last in 0..0xFFFF) {
          val diff = (sq - last) and 0xFFFF
          if (diff == 0 || diff > 0x8000) {
            continue
          }
        }
        lastSeq[from] = sq
        ensureTrack().write(buf, HEADER, n - HEADER)
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
      } catch (_: Exception) {
        // socket closed on stop, or a torn packet — the loop condition rules
      }
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

  private fun ensureTrack(): AudioTrack {
    track?.let { return it }
    val minBuf = AudioTrack.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val t = AudioTrack(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
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
