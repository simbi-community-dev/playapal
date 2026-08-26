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

  /** One entry per pod peer BY HASH, kept across disconnects — the entry
   * carries the backoff that paces redials; the next scan sighting is
   * what actually redials. */
  private inner class VoicePeer(val hash: Long) {
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
        // The PV identity rides the scan response TWO ways: Android puts
        // the 10 raw bytes in manufacturer data; an iPhone CANNOT — a
        // CoreBluetooth peripheral advertises only service UUIDs and a
        // local name (the asymmetry CrewBeacon.swift documents) — so
        // WalkieBleVoice.swift spells the same bytes as the advertised
        // name, "PV" + 16 hex digits. Either carrier is a pre-connect
        // FILTER only; the identity read stays the proof (§5).
        val mfg = r.scanRecord?.getManufacturerSpecificData(MANUFACTURER_ID)
          ?: pvFromName(r.scanRecord?.deviceName)
          ?: return
        if (mfg.size < PV_HEADER ||
          mfg[0] != 'P'.code.toByte() || mfg[1] != 'V'.code.toByte()
        ) {
          return
        }
        if (readU32(mfg, 2) != podHash) {
          return // another pod's walkie
        }
        val hash = readU32(mfg, 6)
        if (hash == senderHash) {
          return // our own reflection off a second interface
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

  /** "PV" + podHash(8 hex) + senderHash(8 hex) -> the same 10 bytes the
   * manufacturer-data carrier holds, or null for any other name — the
   * iPhone advertisement carrier (see onScanResult). */
  private fun pvFromName(name: String?): ByteArray? {
    if (name == null || name.length != 2 + 16 || !name.startsWith("PV")) {
      return null
    }
    return try {
      val b = ByteArray(PV_HEADER)
      b[0] = 'P'.code.toByte()
      b[1] = 'V'.code.toByte()
      writeU32(b, 2, java.lang.Long.parseLong(name.substring(2, 10), 16))
      writeU32(b, 6, java.lang.Long.parseLong(name.substring(10, 18), 16))
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
    if (status != BluetoothGatt.GATT_SUCCESS || value.size < PV_HEADER ||
      value[0] != 'P'.code.toByte() || value[1] != 'V'.code.toByte() ||
      readU32(value, 2) != podHash || readU32(value, 6) != peer.hash
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
