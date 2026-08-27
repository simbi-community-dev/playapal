package com.playapal

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The walkie's RUNG 3 — live lo-fi voice over BLE GATT (docs/WALKIE-LADDER
 * §2, §6): the ladder's designed floor for LIVE talk, so two phones with
 * NO Wi-Fi of any kind — no router, no hotspot, no Aware silicon — still
 * carry intelligible, choppy voice. Like WalkieAwareLink this class is a
 * LINK PROVIDER only: it finds pod peers on its own BLE advertisement,
 * proves each one's voice pipe (connect + MTU + identity read), and hands
 * WalkieModule a per-peer WRITE function. The PW frame, the pod gate, the
 * sender identity and the sequence discipline never change — the rung
 * changes the CODEC (0x5, IMA ADPCM @ 8 kHz) and the socket (a GATT
 * characteristic), never the frame.
 *
 * SHAPE. Every phone with the walkie OPEN advertises one connectable
 * service and runs one GATT server with two characteristics:
 *   IDENT (read):  'PV' + podHash(4 BE) + senderHash(4 BE) + utf8 name
 *   VOICE (write-no-response): one PW frame per write
 * and scans for the same service, connecting as a CENTRAL to every pod
 * peer it sights. Voice is asymmetric on purpose: MY voice rides MY
 * central connection to THEIR server; theirs rides theirs to mine. No
 * role negotiation, no collision — each direction owns its pipe.
 *
 * MEMBERSHIP IS THE CONNECTION (ladder §5: availability is PROVEN, never
 * announced). A peer enters the channel list only after the identity read
 * came back with the right pod on a link whose MTU fits a voice frame —
 * so a listed peer is by construction a writable peer. Closing the walkie
 * stops the advertisement and the server, which drops every inbound
 * connection: the peer LEAVES the other phones' lists on the disconnect,
 * and re-enters on the next scan sighting when the walkie reopens — no
 * app restart anywhere in the arc.
 *
 * TRUST matches the other rungs: the pod code (podHash) is the admission
 * gate — in the advertisement filter, in the identity read, and in every
 * frame. A stranger who connects and writes garbage is bounded by the
 * frame-size cap here and dropped by the module's pod gate.
 *
 * FAILS DOWNWARD, SILENTLY (§1 corollary): every failure path ends in
 * "this rung contributes no peers". Store-and-forward (rung 2) rides
 * CrewBeaconModule's separate service and is untouched by any of this.
 */
class WalkieBleLink(
  private val ctx: Context,
  private val podHash: Long,
  private val senderHash: Long,
  private val displayName: String,
  /** A peer's voice pipe became WRITABLE. Key follows the
   * "<transport>|<senderHash hex>|<name>" shape peerHash() parses; `send`
   * writes one PW frame (drop-on-busy — the walkie never retransmits). */
  private val onPeer: (key: String, name: String, send: (ByteArray, Int) -> Unit) -> Unit,
  private val onPeerLost: (key: String) -> Unit,
  /** An inbound PW frame from a peer's write; the module's one receive
   * path gates and plays it. */
  private val onFrame: (bytes: ByteArray) -> Unit,
) {
  companion object {
    private const val TAG = "PlayaPalBleVoice"
    val SERVICE_UUID: UUID = UUID.fromString("6b75a1fa-8e2a-4b0b-9f21-706c61796170")
    val VOICE_CHAR: UUID = UUID.fromString("6b75a1fb-8e2a-4b0b-9f21-706c61796170")
    val IDENT_CHAR: UUID = UUID.fromString("6b75a1fc-8e2a-4b0b-9f21-706c61796170")
    /** Same test company id the crew beacon uses; the payload is scoped by
     * the service UUID filter, not by this. */
    const val MANUFACTURER_ID = 0xFFFF
    /** 'P''V' + podHash(4 BE) + senderHash(4 BE) — 10 bytes, chosen to fit
     * a legacy 31-byte scan response beside nothing else. The NAME does
     * not fit here; it arrives over the IDENT read instead. */
    private const val PV_HEADER = 10

    /** A 60 ms rung-3 frame is 13 + 4 + 240 = 257 bytes; +3 ATT header =
     * 260. A link whose MTU came back smaller cannot carry voice, and §5
     * says a rung that cannot carry is never offered: the peer is dropped
     * before it was ever listed. */
    const val MIN_VOICE_MTU = 260

    /** Inbound writes above this are a stranger or a bug, not a frame. */
    private const val MAX_VOICE_FRAME = 600

    /** Redial pacing per peer: base doubles per failed setup to the cap,
     * resets on a proven link. Scan sightings are the retry trigger, so a
     * peer who reappears is redialled within one backoff window. */
    private const val CONNECT_BACKOFF_BASE_MS = 3_000L
    private const val CONNECT_BACKOFF_CAP_MS = 30_000L

    /** A setup (connect->MTU->discover->ident) that stalls past this is
     * torn down; BLE stacks wedge silently and the walkie must not hold a
     * half-open pipe it will never probe again. */
    private const val SETUP_TIMEOUT_MS = 12_000L

    /** Android carries ~7 concurrent GATT links and the answering
     * machine's sync path needs its share; four live voice links is a
     * six-phone huddle with no Wi-Fi anywhere, which is already past what
     * this rung's bandwidth story promises. */
    const val MAX_VOICE_LINKS = 4

    /**
     * ONE scan-drop line per (device, reason) per five minutes.
     *
     * WHY THE DIAGNOSTIC EXISTS AT ALL, measured 2026-08-26 on three
     * phones: an iPhone was carrying live voice to an Android, and neither
     * Android could see that iPhone in their channel. The logcat showed
     * the central proving the other Pixel's hash over and over and never
     * once attempting the iPhone's — so the scan was working, and
     * something was being dropped before maybeConnect. WHICH of the four
     * returns below ran, and against whom, the log could not say, because
     * every one of them was silent. A rung that fails by returning is a
     * rung nobody can debug from a phone in the dust.
     *
     * WHY IT IS RATE LIMITED, and per PAIR rather than globally: with
     * CALLBACK_TYPE_ALL_MATCHES — the default this scan uses — a
     * LOW_LATENCY scan re-reports the same device several times a second.
     * A stranger's headphones (or our own reflection) would otherwise fill
     * the log buffer and push out the lines that matter. Five minutes is
     * long enough that a whole bench session yields one line per stranger,
     * short enough that a podmate whose advertisement broke mid-session
     * says so again rather than staying quiet forever.
     */
    private const val DROP_LOG_WINDOW_MS = 5 * 60_000L

    /** …and the memory the window costs is bounded, the same posture
     * CrewBeaconModule takes toward anything a stranger can make us hold:
     * at 70,000 people nobody gets to grow this map without limit. The
     * oldest pair is evicted and, at worst, says itself one extra time. */
    private const val DROP_LOG_KEYS = 64
  }

  private val thread = HandlerThread("walkie-ble").apply { start() }
  private val handler = Handler(thread.looper)
  @Volatile private var stopped = false

  private var advertiser: BluetoothLeAdvertiser? = null
  private var advCallback: AdvertiseCallback? = null
  private var scanner: BluetoothLeScanner? = null
  private var scanCallback: ScanCallback? = null
  private var gattServer: BluetoothGattServer? = null
  @Volatile private var receiverRegistered = false

  /** When each (device address, drop reason) pair last said itself. Read
   * and written only from the scan callback, which the framework delivers
   * on one thread; LruCache is synchronized anyway, and the bound is what
   * keeps a crowd from turning a diagnostic into a leak. */
  private val dropLog = android.util.LruCache<String, Long>(DROP_LOG_KEYS)

  /** One entry per pod peer BY HASH, kept across disconnects — the entry
   * carries the backoff that paces redials; the next scan sighting is
   * what actually redials. */
  private inner class VoicePeer(@Volatile var hash: Long) {
    @Volatile var gatt: BluetoothGatt? = null
    @Volatile var voiceChar: BluetoothGattCharacteristic? = null
    @Volatile var name: String = "someone"
    @Volatile var key: String = ""
    @Volatile var ready = false
    @Volatile var connecting = false
    @Volatile var lastAttempt = 0L
    @Volatile var backoffMs = CONNECT_BACKOFF_BASE_MS
    /** Dial generation. The setup-timeout runnable captures the value at
     * ITS dial; without it a stale 12 s timer from a failed dial 1 read
     * `!ready && connecting` as true and aborted the healthy dial 2 that
     * started meanwhile — thrashing the backoff toward the 30 s cap in
     * exactly the no-Wi-Fi huddle rung 3 exists for. */
    @Volatile var attempt = 0
  }

  private val voicePeers = ConcurrentHashMap<Long, VoicePeer>()

  private fun adapter(): BluetoothAdapter? =
    (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  /** The runtime trio (API 31+). Deliberately CHECKED, never asked: the
   * walkie panel asks in context; a missing grant just means this rung
   * contributes no peers, the module's fencing law. */
  private fun hasPerms(): Boolean {
    if (Build.VERSION.SDK_INT < 31) {
      return true
    }
    return listOf(
      Manifest.permission.BLUETOOTH_SCAN,
      Manifest.permission.BLUETOOTH_ADVERTISE,
      Manifest.permission.BLUETOOTH_CONNECT,
    ).all { ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED }
  }

  private fun pvBytes(): ByteArray {
    val b = ByteArray(PV_HEADER)
    b[0] = 'P'.code.toByte()
    b[1] = 'V'.code.toByte()
    writeU32(b, 2, podHash)
    writeU32(b, 6, senderHash)
    return b
  }

  private fun identBytes(): ByteArray {
    val name = displayName.replace("|", "/").take(24).toByteArray(Charsets.UTF_8)
    val b = ByteArray(PV_HEADER + name.size)
    pvBytes().copyInto(b)
    name.copyInto(b, PV_HEADER)
    return b
  }

  // ------------------------------------------------------------ lifecycle

  /** Bluetooth off and back on mid-walkie, the quick-settings way: the OS
   * silently kills the advertiser, the scanner, the server and every
   * connection. OFF empties the rung honestly; ON is a real restart —
   * the same posture CrewBeaconModule measured its way to. */
  private val adapterReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) {
        return
      }
      when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
        BluetoothAdapter.STATE_OFF -> handler.post { onAdapterOff() }
        BluetoothAdapter.STATE_ON -> handler.post { if (!stopped) bringUp() }
        else -> Unit
      }
    }
  }

  fun start() {
    handler.post {
      try {
        if (stopped || !hasPerms()) {
          Log.i(TAG, "voice//no-permission — rung contributes no peers")
          return@post
        }
        ctx.registerReceiver(
          adapterReceiver,
          IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
          null,
          handler,
        )
        receiverRegistered = true
        bringUp()
      } catch (_: Exception) {
        // whatever BLE throws, the rung contributes nothing and the
        // walkie's other rungs are already running
      }
    }
  }

  private fun bringUp() {
    try {
      val a = adapter() ?: return
      if (!a.isEnabled) {
        return // the adapter receiver re-enters here on ON
      }
      startServer()
      startAdvertising(a)
      startScan(a)
      Log.i(TAG, "voice//up")
    } catch (_: Exception) {}
  }

  /**
   * "LOOK AGAIN" (WalkieModule.refreshDiscovery, the panel's control).
   *
   * WHAT IT MAY TOUCH AND WHAT IT MAY NOT. A camper taps this because the
   * channel looks wrong, which means somebody may be TALKING on it — so
   * every proven voice link is left exactly alone. What restarts is the
   * LOOKING: the scan (a BLE scanner can be quietly starved by the OS
   * without ever telling its callback), plus the advertisement and the
   * GATT server if either went missing. And the per-peer BACKOFF is
   * forgiven for peers that are not connected: after a few failed setups a
   * redial is up to 30 s away, and a "look again" that then waits half a
   * minute is a control lying about being immediate. The next sighting
   * dials at once instead.
   */
  fun refresh() {
    handler.post {
      if (stopped) {
        return@post
      }
      try {
        val a = adapter() ?: return@post
        if (!a.isEnabled) {
          return@post // nothing to look with; the adapter receiver owns this arc
        }
        // Restart the scan ITSELF — stopScan then startScan, not a re-arm
        // of the handle we hold — because a starved scanner still holds a
        // perfectly valid-looking callback.
        try {
          scanCallback?.let { scanner?.stopScan(it) }
        } catch (_: Exception) {}
        scanCallback = null
        for (p in voicePeers.values) {
          if (!p.ready && !p.connecting) {
            p.backoffMs = CONNECT_BACKOFF_BASE_MS
            p.lastAttempt = 0L
          }
        }
        // The server and the advertiser are idempotent by their own
        // guards — each returns early when it is already up — so this only
        // fills a hole, and a healthy rung is untouched.
        startServer()
        startAdvertising(a)
        startScan(a)
        Log.i(TAG, "voice//look-again peers=" + voicePeers.size)
      } catch (_: Exception) {
        // The rung contributes what it contributed before; a refresh that
        // throws must never be worse than not tapping the control.
      }
    }
  }

  private fun onAdapterOff() {
    Log.i(TAG, "voice//adapter-off peers=" + voicePeers.size)
    // The OS already tore the radio down; drop the stale handles so ON is
    // a REAL restart, and empty the channel rows this rung owns.
    advertiser = null
    advCallback = null
    scanner = null
    scanCallback = null
    try {
      gattServer?.close()
    } catch (_: Exception) {}
    gattServer = null
    for (p in voicePeers.values) {
      if (p.ready && p.key.isNotEmpty()) {
        onPeerLost(p.key)
      }
      try {
        p.gatt?.close()
      } catch (_: Exception) {}
      p.gatt = null
      p.ready = false
      p.connecting = false
      p.voiceChar = null
    }
    voicePeers.clear()
  }

  fun stop() {
    stopped = true
    if (receiverRegistered) {
      try {
        ctx.unregisterReceiver(adapterReceiver)
      } catch (_: Exception) {}
      receiverRegistered = false
    }
    // The radio teardown runs ON the link thread, not the caller's:
    // maybeConnect runs there too, so SERIALIZATION — not the `stopped`
    // flag alone — is what closes a connectGatt that was already past its
    // stopped-check when this flag flipped. Done from the caller's thread,
    // that straddling dial repopulated the map stop() had just cleared and
    // its GATT link outlived the closed walkie — the one thing the
    // MEMBERSHIP IS THE CONNECTION contract forbids. Pending posts are
    // cleared FIRST so the teardown is the queue's last word; a runnable
    // already executing finishes before it, and the gatt it dialled is in
    // voicePeers by the time the teardown closes them all. quitSafely
    // still drains what is queued, so the teardown always runs.
    handler.removeCallbacksAndMessages(null)
    handler.post {
      try {
        scanCallback?.let { scanner?.stopScan(it) }
      } catch (_: Exception) {}
      scanCallback = null
      try {
        advCallback?.let { advertiser?.stopAdvertising(it) }
      } catch (_: Exception) {}
      advCallback = null
      for (p in voicePeers.values) {
        try {
          p.gatt?.close()
        } catch (_: Exception) {}
      }
      voicePeers.clear()
      try {
        gattServer?.close()
      } catch (_: Exception) {}
      gattServer = null
    }
    thread.quitSafely()
  }

  // ------------------------------------------------------------ radio legs

  private fun startAdvertising(a: BluetoothAdapter) {
    if (advCallback != null) {
      return
    }
    val adv = a.bluetoothLeAdvertiser ?: return
    val settings = AdvertiseSettings.Builder()
      // Low latency + connectable: the walkie is an explicitly OPEN
      // surface with a bounded lifetime — this is not the always-on
      // presence beacon, and it does not get the presence beacon's duty
      // cycle economics.
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .setIncludeDeviceName(false)
      .build()
    // The pod/sender ids ride the scan response as manufacturer data —
    // the primary packet is full with the 128-bit UUID, the same budget
    // split CrewBeaconModule uses.
    val resp = AdvertiseData.Builder()
      .addManufacturerData(MANUFACTURER_ID, pvBytes())
      .build()
    val cb = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        Log.i(TAG, "voice//advertise-started")
      }

      override fun onStartFailure(errorCode: Int) {
        Log.i(TAG, "voice//advertise-failed code=$errorCode")
        advCallback = null // scan+server still run: we can hear, they may not find us
      }
    }
    advCallback = cb
    try {
      adv.startAdvertising(settings, data, resp, cb)
      advertiser = adv
    } catch (_: Exception) {
      advCallback = null
    }
  }

  private fun startScan(a: BluetoothAdapter) {
    if (scanCallback != null) {
      return
    }
    val sc = a.bluetoothLeScanner ?: return
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()
    val cb = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult?) {
        val r = result ?: return
        // EVERY RETURN BELOW NAMES ITSELF (noteScanDrop, rate limited).
        // These four used to be silent, and the silence is what cost the
        // 2026-08-26 bench its evening: the scan was healthy, an iPhone
        // was in the room, and the only way to learn which of these
        // returns was eating it would have been to rebuild the app.
        val rec = r.scanRecord
        val name = rec?.deviceName
        // The PV identity rides the scan response TWO ways: Android puts
        // the 10 raw bytes in manufacturer data; an iPhone CANNOT — a
        // CoreBluetooth peripheral advertises only service UUIDs and a
        // local name (the asymmetry CrewBeacon.swift documents) — so
        // WalkieBleVoice.swift spells the same bytes as the advertised
        // name, "PV" + 16 hex digits. Either carrier is a pre-connect
        // FILTER only; the identity read stays the proof (§5).
        val mfg = rec?.getManufacturerSpecificData(MANUFACTURER_ID)
          ?: pvFromName(name)
        if (mfg == null) {
          // Advertising our service UUID with neither carrier. A stranger
          // whose device happens to collide, or — the case worth catching
          // — a phone whose identity did not survive its advertisement:
          // an iPhone drops its local name when backgrounded, and this is
          // exactly what that looks like from the other side.
          noteScanDrop("no-carrier", r, name)
          return
        }
        if (mfg.size < PV_HEADER ||
          mfg[0] != 'P'.code.toByte() || mfg[1] != 'V'.code.toByte()
        ) {
          noteScanDrop("bad-header", r, name)
          return
        }
        if (readU32(mfg, 2) != podHash) {
          noteScanDrop("other-pod", r, name)
          return // another pod's walkie
        }
        val hash = readU32(mfg, 6)
        if (hash == senderHash) {
          noteScanDrop("self", r, name)
          return // our own reflection off a second interface
        }
        if (hash == UNKNOWN_SENDER) {
          // THE CHURN DAMPER (measured 2026-08-26, minutes after the
          // acceptor landed): a truncated advertisement re-mints a fresh
          // unknown-sender entry on EVERY sighting once the proof vacates
          // slot 0, so the scan dialled the same already-reached iPhone
          // every backoff period forever — each dial waking its Bluetooth
          // stack. The proof records which address turned out to be whom;
          // a sighting whose address maps to a peer we still reach is
          // spent, not dialled. A DEAD peer falls through and redials —
          // the memo never outranks liveness, and a rotated MAC simply
          // misses the memo and pays one extra proof.
          val addr = try { r.device?.address } catch (_: Exception) { null }
          val known = addr?.let { provenAddr.get(it) }
          if (known != null) {
            val p = voicePeers[known]
            if (p != null && (p.ready || p.connecting)) {
              noteScanDrop("already-reached", r, name)
              return
            }
          }
        }
        val device = r.device ?: return
        handler.post { maybeConnect(hash, device) }
      }
    }
    scanCallback = cb
    try {
      sc.startScan(listOf(filter), settings, cb)
      scanner = sc
    } catch (_: Exception) {
      scanCallback = null
    }
  }

  /**
   * Say why one advertisement was dropped — at most once per (device,
   * reason) per DROP_LOG_WINDOW_MS.
   *
   * THE ACCEPTED PATH NEVER REACHES HERE, which is the point: a podmate's
   * good advertisement costs exactly the four comparisons it already cost,
   * and allocates nothing. A drop pays one small key and one map probe,
   * and the rate limit means it pays for the Log itself about once per
   * stranger per five minutes.
   */
  private fun noteScanDrop(reason: String, r: ScanResult, name: String?) {
    val addr = try {
      r.device?.address ?: "-"
    } catch (_: Exception) {
      "-" // an address we are not allowed to read is still a drop worth counting
    }
    val key = addr + "|" + reason
    val now = SystemClock.elapsedRealtime()
    val last = dropLog.get(key)
    if (last != null && now - last < DROP_LOG_WINDOW_MS) {
      return
    }
    dropLog.put(key, now)
    Log.i(
      TAG,
      "voice//scan-drop reason=" + reason + " addr=" + addr +
        " name=" + (if (name.isNullOrEmpty()) "-" else name),
    )
  }

  /** The advertisement named a sender we have not proven yet: a truncated
   * name carries the pod but not the phone, and only the ident read may
   * assign the real hash (handleIdent re-keys the peer when it does). */
  private val UNKNOWN_SENDER = 0L

  /** Which Bluetooth address the ident proof revealed to be whom — the
   * scan's churn damper. Entries are advisory: liveness is re-checked at
   * every use, MAC rotation just misses and pays one extra proof, and 16
   * slots outlast any pod this radio will meet. */
  private val provenAddr = android.util.LruCache<String, Long>(16)

  /** "PV" + podHash(8 hex) + senderHash(8 hex) -> the same 10 bytes the
   * manufacturer-data carrier holds, or null for any other name — the
   * iPhone advertisement carrier (see onScanResult).
   *
   * TRUNCATION IS THE FIELD REALITY, not a corner case: the first live
   * cross-OS bench (2026-08-26) showed iOS cutting the 18-char name to
   * "PVb6ef1b" — eight characters — in the packet Android actually
   * receives, so the strict length check rejected every real iPhone as
   * reason=no-carrier while the diagnosis log named it perfectly. The
   * name was only ever a pre-connect FILTER (§5: the ident read is the
   * proof), so a prefix that matches our pod is enough to spend a dial
   * on: six hex characters of pod hash is a 1-in-16-million stranger,
   * and a stranger costs one refused ident read. The sender half, when
   * absent, stays UNKNOWN_SENDER until the proof supplies it. */
  private fun pvFromName(name: String?): ByteArray? {
    if (name == null || name.length < 2 + 6 || !name.startsWith("PV")) {
      return null
    }
    val hex = name.substring(2)
    if (!hex.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
      return null // not hex is a stranger's name, not a peer
    }
    return try {
      val b = ByteArray(PV_HEADER)
      b[0] = 'P'.code.toByte()
      b[1] = 'V'.code.toByte()
      if (hex.length >= 16) {
        writeU32(b, 2, java.lang.Long.parseLong(hex.substring(0, 8), 16))
        writeU32(b, 6, java.lang.Long.parseLong(hex.substring(8, 16), 16))
      } else {
        val podHex = java.lang.String.format("%08x", podHash)
        val n = minOf(hex.length, 8)
        if (!podHex.regionMatches(0, hex, 0, n, ignoreCase = true)) {
          return null // a truncated name for someone else's pod
        }
        writeU32(b, 2, podHash)
        writeU32(b, 6, UNKNOWN_SENDER)
      }
      b
    } catch (_: Exception) {
      null // hex that does not parse is a stranger's name, not a peer
    }
  }

  // ------------------------------------------------------------ client side

  /** Runs on the link thread. The scan stream is the retry engine: every
   * sighting of a not-connected pod peer lands here, and the backoff
   * decides whether this one dials. */
  private fun maybeConnect(hash: Long, device: BluetoothDevice) {
    if (stopped) {
      return
    }
    val peer = voicePeers.getOrPut(hash) { VoicePeer(hash) }
    if (peer.ready || peer.connecting) {
      return
    }
    val now = SystemClock.elapsedRealtime()
    if (now - peer.lastAttempt < peer.backoffMs) {
      return
    }
    if (voicePeers.values.count { it.ready || it.connecting } >= MAX_VOICE_LINKS) {
      return
    }
    peer.connecting = true
    peer.lastAttempt = now
    peer.attempt += 1
    val epoch = peer.attempt
    Log.i(TAG, "voice//connect hash=" + java.lang.Long.toHexString(hash))
    try {
      peer.gatt = device.connectGatt(ctx, false, clientCallback(peer), BluetoothDevice.TRANSPORT_LE)
    } catch (_: Exception) {
      peer.connecting = false
      return
    }
    handler.postDelayed({
      // Only THIS dial's timer may kill this dial: a later attempt bumped
      // peer.attempt past our epoch, and its own timer owns it.
      if (!peer.ready && peer.connecting && peer.attempt == epoch) {
        Log.i(TAG, "voice//setup-timeout hash=" + java.lang.Long.toHexString(hash))
        dropClient(peer)
      }
    }, SETUP_TIMEOUT_MS)
  }

  private fun clientCallback(peer: VoicePeer) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        try {
          gatt?.requestMtu(517)
        } catch (_: Exception) {
          handler.post { dropClient(peer) }
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        handler.post { dropClient(peer) }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt?, mtu: Int, status: Int) {
      if (mtu < MIN_VOICE_MTU) {
        // A pipe the frame does not fit is not a rung. §5: a rung that
        // cannot carry is never offered — drop before it was ever listed.
        Log.i(TAG, "voice//mtu-too-small mtu=$mtu")
        handler.post { dropClient(peer) }
        return
      }
      try {
        gatt?.discoverServices()
      } catch (_: Exception) {}
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
      val svc = gatt?.getService(SERVICE_UUID)
      val voice = svc?.getCharacteristic(VOICE_CHAR)
      val ident = svc?.getCharacteristic(IDENT_CHAR)
      if (voice == null || ident == null) {
        handler.post { dropClient(peer) }
        return
      }
      peer.voiceChar = voice
      try {
        gatt.readCharacteristic(ident)
      } catch (_: Exception) {}
    }

    // Both read signatures on purpose: API 33+ calls the value-carrying
    // one, older frameworks call the legacy one — never both from the OS.
    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) {
      handleIdent(peer, value, status)
    }

    @Deprecated("pre-33 callback")
    override fun onCharacteristicRead(
      gatt: BluetoothGatt?,
      characteristic: BluetoothGattCharacteristic?,
      status: Int,
    ) {
      if (Build.VERSION.SDK_INT < 33) {
        @Suppress("DEPRECATION")
        handleIdent(peer, characteristic?.value ?: ByteArray(0), status)
      }
    }
  }

  /** The PROOF gate (§5): the peer is listed only after this read said
   * "same pod, same phone the advertisement named". A mismatch is a
   * stranger, a stale advertisement, or another pod — never a peer. */
  private fun handleIdent(peer: VoicePeer, value: ByteArray, status: Int) {
    val sender = if (value.size >= PV_HEADER) readU32(value, 6) else -1L
    if (status != BluetoothGatt.GATT_SUCCESS || value.size < PV_HEADER ||
      value[0] != 'P'.code.toByte() || value[1] != 'V'.code.toByte() ||
      readU32(value, 2) != podHash ||
      // A dial from a FULL advertisement must prove the phone it named; a
      // dial from a TRUNCATED one (UNKNOWN_SENDER) accepts whoever answers
      // — except our own reflection off a second interface.
      (if (peer.hash == UNKNOWN_SENDER) sender == senderHash else sender != peer.hash)
    ) {
      handler.post { dropClient(peer) }
      return
    }
    val name = String(value, PV_HEADER, value.size - PV_HEADER, Charsets.UTF_8)
      .ifEmpty { "someone" }
    handler.post {
      if (stopped || peer.ready) {
        return@post
      }
      if (peer.hash == UNKNOWN_SENDER) {
        // The proof named the phone the advertisement could not. Remember
        // which ADDRESS that was either way — the scan's churn damper reads
        // this memo so the same already-reached phone is not redialled on
        // every future sighting of its truncated name.
        try {
          peer.gatt?.device?.address?.let { provenAddr.put(it, sender) }
        } catch (_: Exception) {}
        // Re-key the peer to its real identity so the roster, self-skip and
        // dedupe all see the same hash the frames will carry — unless that
        // identity is already held by a live entry, in which case this dial
        // was the second road to a phone we already reach.
        val existing = voicePeers[sender]
        if (existing != null && existing !== peer && (existing.ready || existing.connecting)) {
          dropClient(peer)
          return@post
        }
        voicePeers.remove(UNKNOWN_SENDER)
        peer.hash = sender
        voicePeers[sender] = peer
      }
      peer.name = name
      peer.key = "ble|" + java.lang.Long.toHexString(peer.hash) + "|" + name
      peer.ready = true
      peer.connecting = false
      peer.backoffMs = CONNECT_BACKOFF_BASE_MS
      Log.i(TAG, "voice//peer-ready hash=" + java.lang.Long.toHexString(peer.hash))
      onPeer(peer.key, name) { bytes, len -> writeVoice(peer, bytes, len) }
    }
  }

  /** Link thread only. The entry SURVIVES the drop — its backoff paces
   * the redial the next scan sighting triggers, which is the re-enter
   * half of the membership arc. */
  private fun dropClient(peer: VoicePeer) {
    val wasReady = peer.ready
    peer.ready = false
    peer.connecting = false
    peer.voiceChar = null
    try {
      peer.gatt?.close()
    } catch (_: Exception) {}
    peer.gatt = null
    if (wasReady) {
      // A proven link that died gets a fresh dialling record; a setup
      // that failed gets a longer wait before the next one.
      peer.backoffMs = CONNECT_BACKOFF_BASE_MS
      if (peer.key.isNotEmpty()) {
        Log.i(TAG, "voice//peer-lost hash=" + java.lang.Long.toHexString(peer.hash))
        onPeerLost(peer.key)
      }
    } else {
      peer.backoffMs = (peer.backoffMs * 2).coerceAtMost(CONNECT_BACKOFF_CAP_MS)
    }
  }

  /** Called from the walkie's tx thread. WRITE_NO_RESPONSE, drop-on-busy:
   * a stack still chewing the last write loses this frame, which is the
   * walkie's own late-audio-is-worse-than-lost-audio law applied to GATT. */
  private fun writeVoice(peer: VoicePeer, bytes: ByteArray, len: Int) {
    val g = peer.gatt ?: return
    val c = peer.voiceChar ?: return
    val value = if (len == bytes.size) bytes else bytes.copyOf(len)
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        g.writeCharacteristic(c, value, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
      } else {
        c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        @Suppress("DEPRECATION")
        c.value = value
        @Suppress("DEPRECATION")
        g.writeCharacteristic(c)
      }
    } catch (_: Exception) {
      // dropped frame — never retransmitted
    }
  }

  // ------------------------------------------------------------ server side

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice?,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic?,
    ) {
      val srv = gattServer ?: return
      // sendResponse requires a non-null device; a null one has no one to
      // answer (never observed from the framework, typed nullable anyway).
      val dev = device ?: return
      if (characteristic?.uuid != IDENT_CHAR) {
        try {
          srv.sendResponse(dev, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        } catch (_: Exception) {}
        return
      }
      val b = identBytes()
      // Honor offset continuations: a pre-MTU-exchange central reads this
      // in 22-byte slices and must reassemble one value, not several.
      val v = if (offset >= b.size) ByteArray(0) else b.copyOfRange(offset, b.size)
      try {
        srv.sendResponse(dev, requestId, BluetoothGatt.GATT_SUCCESS, offset, v)
      } catch (_: Exception) {}
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice?,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic?,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (responseNeeded && device != null) {
        try {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        } catch (_: Exception) {}
      }
      // Voice never rides a prepared (long) write: our frames fit the
      // negotiated MTU by contract (MIN_VOICE_MTU gate on the writer).
      if (characteristic?.uuid != VOICE_CHAR || preparedWrite) {
        return
      }
      val v = value ?: return
      if (v.size > MAX_VOICE_FRAME) {
        return // a stranger or a bug; frames are ~257 bytes
      }
      // The frame self-identifies (pod, sender, seq, codec) — the
      // module's one receive path gates it exactly like a datagram.
      onFrame(v)
    }
  }

  private fun startServer() {
    if (gattServer != null) {
      return
    }
    val mgr = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: return
    val srv = try {
      mgr.openGattServer(ctx, serverCallback)
    } catch (_: Exception) {
      null
    } ?: return
    gattServer = srv
    val svc = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    svc.addCharacteristic(
      BluetoothGattCharacteristic(
        VOICE_CHAR,
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
          BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
      ),
    )
    svc.addCharacteristic(
      BluetoothGattCharacteristic(
        IDENT_CHAR,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
      ),
    )
    try {
      srv.addService(svc)
    } catch (_: Exception) {}
  }

}
