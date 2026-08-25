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
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * CrewBeacon — the Android radio half of Crew (docs/CREW-DESIGN.md Phase
 * B/C) plus the answering machine's message-exchange pipe (§6b Phase D).
 *
 * PRESENCE (Phase B/C):
 *  - ADVERTISE: the 128-bit service UUID rides the PRIMARY packet (the
 *    discovery/filter key — scan-response-only UUIDs match less robustly
 *    across stacks; cross-family review, Aug 24), and the small payload
 *    rides the SCAN RESPONSE as manufacturer data (test company id 0xFFFF),
 *    which active scanners merge into the same scan record. Passive or
 *    backgrounded scanners that miss it fall back to the GATT read below.
 *  - GATT: the same payload is served read-only from PAYLOAD_CHAR, because
 *    iOS peripherals CANNOT put data in advertisements at all — reading a
 *    sighted peer with no inline payload is how an Android phone hears an
 *    iPhone.
 *
 * MESSAGE SYNC (Phase D): three more characteristics on the same service
 * carry the answering machine's store-and-forward exchange. GATT attribute
 * values cap at 512 bytes, so streams are FRAMED over repeated reads: every
 * read of a stream characteristic returns [seq u16 BE][total u16 BE][chunk]
 * for the requesting device, with a per-device cursor server-side; total=0
 * means "not ready, retry". A central pulls a peer's mailbox in two phases:
 *    1. read DIGEST_CHAR frames  -> the ids the peer carries (JS keeps it
 *       fresh via setSyncDigest on every store change);
 *    2. write want-list frames to WANT_CHAR -> the server hands the want
 *       to JS (CrewSyncWant event), JS assembles the response
 *       (provideSyncMessages), central reads MSG_CHAR frames.
 * The payload bytes are opaque here — codec and policy live in
 * src/crews/syncLink.ts / messages.ts where they are unit-tested. Sync
 * connections request MTU 517 + high connection priority, run ONE at a
 * time (mutex), and time out rather than hang: a partial sync is fine,
 * the next sighting continues it.
 *
 * THREE PROPERTIES THE SERVING SIDE HAS TO KEEP, each of which was a bug:
 *  - A LONG READ IS ONE VALUE IN PIECES. Frames are built at offset 0 and
 *    cached per central; continuations slice that cached frame.
 *  - A LONG (PREPARED) WRITE IS ALSO ONE VALUE IN PIECES. Chunks are
 *    buffered per central per characteristic and only assembled in
 *    onExecuteWrite — CoreBluetooth splits every oversized iOS write this
 *    way, so this is the path most real want lists arrive on.
 *  - A FRESH DIGEST MUST NOT LAND ON A READER'S HEAD. setSyncDigest fires
 *    on every store change; it bumps a GENERATION instead of clearing
 *    state, so an in-flight continuation finishes from its own snapshot
 *    and only the central's next fresh read rewinds to seq 0.
 * And the state all three keep is bounded: any stranger can connect, so
 * the central roster, each want assembly and each prepared write are
 * capped, and every buffer is freed on that central's disconnect.
 *
 * The module stays deliberately DUMB about content. Events:
 *   CrewBeaconSighting { payload: base64, rssi: int, via: 'adv'|'gatt',
 *                        peerId: string }
 *   CrewBeaconState    { advertising: bool, scanning: bool,
 *                        adapterEnabled: bool, error?: string }
 *   CrewSyncWant       { peerId: string, payload: base64 }
 *   CrewBeaconTick     (from CrewShareService, Phase C)
 *
 * ADAPTER BOUNCE (measured 2026-08-24). Turning Bluetooth off under a live
 * session used to be invisible to JS: the OS silently dropped our
 * advertisement and scan, this module kept its `advertising` flag as it
 * was, and when Bluetooth came back nothing restarted — the session ticked
 * setPayload into a module that was not on the air. A receiver on
 * ACTION_STATE_CHANGED now closes both halves: OFF drops the stale
 * callbacks, closes the GATT server and emits an errored state; ON emits a
 * clean one, which is JS's cue (src/crews/session.ts) to re-arm the legs.
 *
 * PERMISSIONS: API 31+ wants runtime BLUETOOTH_ADVERTISE/SCAN/CONNECT;
 * methods REJECT with code 'permission' instead of asking — the JS side
 * asks in context with payoff copy (design §5), like camera and location.
 *
 * FIELD LOGGING. Every decision this file makes — above all the ones that
 * DROP something — emits one short line at INFO under the tag `PlayaMesh`,
 * unconditionally, in the shape `phase//event k=v k=v`. A pod that will
 * not sync at 3am in the dust is otherwise undiagnosable: the platform's
 * own BluetoothGatt chatter proves a connection happened and says nothing
 * about what we then decided. Follow one attempt with
 *   adb logcat -s PlayaMesh:I
 * Content NEVER appears: no payload bodies, no digests, no card fields, no
 * pod names, no join codes — addresses, byte counts, offsets, sequence
 * numbers and boolean outcomes only, so a log is safe to paste into a bug
 * report.
 */
class CrewBeaconModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "CrewBeacon"

  companion object {
    val SERVICE_UUID: UUID = UUID.fromString("6b75a1f4-8e2a-4b0b-9f21-706c61796170")
    val PAYLOAD_CHAR: UUID = UUID.fromString("6b75a1f5-8e2a-4b0b-9f21-706c61796170")
    val DIGEST_CHAR: UUID = UUID.fromString("6b75a1f6-8e2a-4b0b-9f21-706c61796170")
    val WANT_CHAR: UUID = UUID.fromString("6b75a1f7-8e2a-4b0b-9f21-706c61796170")
    val MSG_CHAR: UUID = UUID.fromString("6b75a1f8-8e2a-4b0b-9f21-706c61796170")
    /** One stable field-log tag for the whole mesh; see the class doc. */
    const val TAG = "PlayaMesh"
    const val MANUFACTURER_ID = 0xFFFF // Bluetooth SIG "internal use / testing" id
    const val SIGHTING_EVENT = "CrewBeaconSighting"
    const val STATE_EVENT = "CrewBeaconState"
    const val SYNC_WANT_EVENT = "CrewSyncWant"
    private const val GATT_COOLDOWN_MS = 30_000L
    private const val GATT_TIMEOUT_MS = 8_000L
    private const val MAX_GATT_IN_FLIGHT = 2
    /** Frame chunk kept safely under a 517-MTU write/read. */
    private const val FRAME_CHUNK = 480
    private const val SYNC_TIMEOUT_MS = 60_000L
    private const val NOT_READY_RETRY_MS = 400L

    /**
     * How many centrals we keep per-connection state for at once. Every
     * buffer below is created by WHOEVER CONNECTS — no pairing, no crew
     * membership, nothing authenticated — so an unbounded roster is an
     * unauthenticated memory-exhaustion surface, and the deployment is a
     * 70k-person festival where thousands of phones pass in a day. Android
     * itself tops out around 7 concurrent GATT links; 8 covers every real
     * pod and evicts the oldest beyond it.
     */
    private const val MAX_TRACKED_CENTRALS = 8

    /** A want list carries message IDS, never bodies. Past this a peer is
     * hostile or broken, not a pod — the assembly is dropped, not grown. */
    private const val MAX_WANT_BYTES = 64 * 1024

    /** GATT attribute values cap at 512 bytes, so no honest prepared (long)
     * write assembles to more; ours are at most one 484-byte frame. */
    private const val MAX_PREPARED_BYTES = 512
  }

  private val main = Handler(Looper.getMainLooper())
  private var payload: ByteArray = ByteArray(0)
  private var advertising = false
  private var scanning = false
  private var advertiseCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null
  private var gattServer: BluetoothGattServer? = null
  private val gattTried = HashMap<String, Long>()
  private val gattInFlight = HashSet<String>()

  // ---- sync server state (peripheral side) ----
  private var syncDigest: ByteArray = ByteArray(0)
  /** Per-central stream cursors + reassembly buffers, keyed by address. */
  private val digestCursor = HashMap<String, Int>()
  private val msgCursor = HashMap<String, Int>()
  private val msgBuffers = HashMap<String, ByteArray>()
  private val wantAssembly = HashMap<String, ByteArrayOutputStream>()
  /**
   * The frame currently being delivered to each central. A long read is ONE
   * value split across continuation reads at increasing offsets, so the
   * frame must be built once (at offset 0) and sliced thereafter — see the
   * read handler. Without this, continuations were served fresh frames and
   * the central reassembled bytes from several of them.
   */
  private val digestFrame = HashMap<String, ByteArray>()
  private val msgFrame = HashMap<String, ByteArray>()

  /**
   * DIGEST GENERATION — the cure for "a fresh digest lands mid-read".
   *
   * setSyncDigest fires on EVERY message-store change, which is to say
   * exactly while peers are reading. It used to clear the cursors AND the
   * cached frames outright, and both halves of that hurt a central that was
   * in the middle of something: a long read lost the frame it was slicing
   * (the continuation got an empty answer and the central kept a truncated
   * value), and a multi-frame stream had its cursor rewound to 0, so the
   * next frame the central appended was a frame 0 of a DIFFERENT digest.
   * Neither is a fresh start; both are a chimera.
   *
   * The invalidation the earlier GATT fix wanted is real and is kept — a
   * fresh digest must never be continued as if it were the old one. It is
   * now expressed as a GENERATION rather than as deletion:
   *  - a new digest bumps `digestGeneration`;
   *  - an in-flight continuation (offset > 0) still slices the frame cached
   *    for that central, which frameFor() COPIED at build time and which no
   *    later digest can therefore mutate — so it completes honestly;
   *  - a new read (offset == 0) whose central is behind the generation
   *    restarts its stream at seq 0 on the new digest.
   */
  private var digestGeneration = 0
  private val digestStreamGen = HashMap<String, Int>()

  /**
   * Prepared (long) write chunks, per central per characteristic, held
   * until onExecuteWrite. A central whose value exceeds the negotiated MTU
   * — every iOS central writing a real want list, since CoreBluetooth
   * splits long writes automatically — sends the value this way.
   */
  private val preparedWrites = HashMap<String, HashMap<UUID, ByteArrayOutputStream>>()

  /**
   * The tracked-central roster, insertion-ordered by last touch so the
   * front is the oldest. Bounds every map above; see MAX_TRACKED_CENTRALS.
   */
  private val centralSeen = LinkedHashMap<String, Long>()

  /**
   * One lock over ALL per-central server state. GATT server callbacks
   * arrive on a binder thread while setSyncDigest / provideSyncMessages
   * arrive on the JS thread, and the roster cap means one thread can now
   * evict a central another thread is actively serving — so the maps can
   * no longer be touched unguarded. Nothing that crosses the bridge or the
   * radio happens inside it: the want handoff returns bytes and the caller
   * emits after releasing.
   */
  private val syncLock = Any()

  // ---- sync client state (central side) ----
  private var syncBusy = false

  private fun adapter(): BluetoothAdapter? =
    (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private fun has(permission: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

  private fun missingFor(vararg perms31: String): String? {
    if (Build.VERSION.SDK_INT < 31) {
      return null // legacy permissions are install-time; location is the compass's
    }
    return perms31.firstOrNull { !has(it) }
  }

  // ------------------------------------------------------------ field log

  private fun log(line: String) {
    Log.i(TAG, line)
  }

  /** Characteristics by role, never by raw UUID — a log line has to be
   * readable at 3am; the unknown case keeps the UUID because that IS the
   * information then. */
  private fun charName(uuid: UUID): String = when (uuid) {
    PAYLOAD_CHAR -> "payload"
    DIGEST_CHAR -> "digest"
    WANT_CHAR -> "want"
    MSG_CHAR -> "msg"
    else -> "unknown($uuid)"
  }

  private fun connState(newState: Int): String = when (newState) {
    BluetoothProfile.STATE_CONNECTED -> "connected"
    BluetoothProfile.STATE_DISCONNECTED -> "disconnected"
    BluetoothProfile.STATE_CONNECTING -> "connecting"
    BluetoothProfile.STATE_DISCONNECTING -> "disconnecting"
    else -> "state$newState"
  }

  private fun advErrName(code: Int): String = when (code) {
    AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "data-too-large"
    AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too-many-advertisers"
    AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already-started"
    AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "internal-error"
    AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "feature-unsupported"
    else -> "code$code"
  }

  /** 5 and 6 stayed @hide for years; literals so this compiles on any SDK. */
  private fun scanErrName(code: Int): String = when (code) {
    ScanCallback.SCAN_FAILED_ALREADY_STARTED -> "already-started"
    ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "app-registration-failed"
    ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "internal-error"
    ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "feature-unsupported"
    5 -> "out-of-hardware-resources"
    6 -> "scanning-too-frequently"
    else -> "code$code"
  }

  private fun emit(name: String, body: com.facebook.react.bridge.WritableMap) {
    if (ctx.hasActiveReactInstance()) {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body)
    } else {
      // A radio event with nobody listening: the sighting/want happened and
      // JS will never hear about it. Silent until now.
      log("bridge//drop event=$name reason=no-react-instance")
    }
  }

  private fun emitState(error: String? = null) {
    val m = Arguments.createMap()
    m.putBoolean("advertising", advertising)
    m.putBoolean("scanning", scanning)
    // The adapter's own power state rides EVERY state event, so JS can tell
    // "the radio refused" from "there is no radio right now" — different
    // recoveries: an advertise failure retries, a dead adapter waits.
    m.putBoolean("adapterEnabled", adapter()?.isEnabled == true)
    if (error != null) {
      m.putString("error", error)
    }
    emit(STATE_EVENT, m)
  }

  private fun emitSighting(bytes: ByteArray, rssi: Int, via: String, peerId: String) {
    log("sighting//emit addr=$peerId via=$via rssi=$rssi bytes=${bytes.size}")
    val m = Arguments.createMap()
    m.putString("payload", Base64.encodeToString(bytes, Base64.NO_WRAP))
    m.putInt("rssi", rssi)
    m.putString("via", via)
    m.putString("peerId", peerId)
    emit(SIGHTING_EVENT, m)
  }

  // ------------------------------------------------------- adapter bounce

  /**
   * Bluetooth off and back on, the way a camper actually does it: airplane
   * mode, a battery-saver tap, the quick-settings tile at 3am. The OS tears
   * the advertisement and the scan down WITHOUT telling the app —
   * AdvertiseCallback.onStartFailure does not fire for an adapter that goes
   * away — so every flag downstream of it went stale and stayed stale. The
   * adapter is the only authority on this, which is why the flags are reset
   * from this receiver and inferred nowhere else.
   *
   * Registered for the life of the React instance rather than per session:
   * the state this repairs is the module's, and a bounce that happens
   * between sessions must still leave honest flags behind.
   */
  private val adapterReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) {
        return
      }
      when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
        BluetoothAdapter.STATE_OFF -> main.post { onAdapterOff() }
        BluetoothAdapter.STATE_ON -> main.post { onAdapterOn() }
        else -> Unit // TURNING_ON/TURNING_OFF: act on settled states only
      }
    }
  }
  private var adapterReceiverRegistered = false

  private fun onAdapterOff() {
    log("adapter//off wasAdvertising=$advertising wasScanning=$scanning syncBusy=$syncBusy")
    // Deliberately NOT calling stopAdvertising/stopScan: the adapter is
    // gone, its handles throw, and the OS has already stopped both. Drop
    // what is now stale so that a later restart is a REAL restart.
    advertiseCallback = null
    scanCallback = null
    advertising = false
    scanning = false
    stopGattServer() // a server on a dead adapter serves nobody
    synchronized(gattTried) {
      // Connections died with the adapter; without this the in-flight cap
      // would still be full after the bounce and no peer could be read.
      gattInFlight.clear()
    }
    // The notification is the consent surface: while the radio is down it
    // must not keep promising the pod can see you.
    CrewShareService.setInterrupted(ctx, true)
    emitState("Bluetooth is off")
  }

  private fun onAdapterOn() {
    log("adapter//on advertising=$advertising scanning=$scanning")
    CrewShareService.setInterrupted(ctx, false)
    // A clean state event with adapterEnabled=true IS the recovery cue; JS
    // (src/crews/session.ts) restarts scan + advertise, which reopens the
    // GATT server on the way. The native side deliberately does not
    // self-restart: only JS knows whether a session is still wanted.
    emitState()
  }

  override fun initialize() {
    super.initialize()
    if (!adapterReceiverRegistered) {
      val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
      if (Build.VERSION.SDK_INT >= 33) {
        ctx.registerReceiver(adapterReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        ctx.registerReceiver(adapterReceiver, filter)
      }
      adapterReceiverRegistered = true
      log("adapter//watch registered=1 enabled=${adapter()?.isEnabled == true}")
    }
  }

  private fun unregisterAdapterReceiver() {
    if (!adapterReceiverRegistered) {
      return
    }
    adapterReceiverRegistered = false
    try {
      ctx.unregisterReceiver(adapterReceiver)
      log("adapter//watch registered=0")
    } catch (_: IllegalArgumentException) {
      log("adapter//watch registered=0 err=not-registered")
    }
  }

  // ------------------------------------------------------------ advertise

  @ReactMethod
  fun setPayload(payloadB64: String, promise: Promise) {
    payload = try {
      Base64.decode(payloadB64, Base64.NO_WRAP)
    } catch (e: Exception) {
      log("advertise//payload-reject reason=not-base64")
      promise.reject("payload", "payload is not base64")
      return
    }
    log("advertise//payload bytes=${payload.size} advertising=$advertising")
    // A live Android advertisement is immutable — a payload change while
    // advertising restarts it. The GATT server reads the field directly.
    if (advertising) {
      main.post {
        log("advertise//payload-restart bytes=${payload.size}")
        stopAdvertisingInternal(keepServer = true)
        startAdvertisingInternal(promise)
      }
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun startAdvertising(promise: Promise) {
    val missing = missingFor(
      Manifest.permission.BLUETOOTH_ADVERTISE,
      Manifest.permission.BLUETOOTH_CONNECT,
    )
    if (missing != null) {
      log("advertise//reject reason=permission perm=$missing")
      // The rejection reaches only the CALLER. A grant revoked mid-session
      // has no caller waiting — the tick's refresh swallows it — so the
      // state event is the only way the UI ever learns. It classifies as
      // 'permission' in src/crews/session.ts: the one reason that does NOT
      // auto-recover, because retrying a missing grant is a lie in a loop.
      emitState("permission $missing")
      promise.reject("permission", missing)
      return
    }
    if (payload.isEmpty()) {
      log("advertise//reject reason=no-payload")
      promise.reject("payload", "setPayload first")
      return
    }
    main.post { startAdvertisingInternal(promise) }
  }

  private fun startAdvertisingInternal(promise: Promise?) {
    val adapter = adapter()
    val advertiser: BluetoothLeAdvertiser? = adapter?.bluetoothLeAdvertiser
    if (adapter == null || !adapter.isEnabled || advertiser == null) {
      log(
        "advertise//reject reason=bluetooth-off adapter=${adapter != null} " +
          "enabled=${adapter?.isEnabled} advertiser=${advertiser != null}",
      )
      promise?.reject("bluetooth-off", "Bluetooth is off")
      emitState("Bluetooth is off")
      return
    }
    if (advertising) {
      log("advertise//start skip=already-advertising")
      promise?.resolve(null)
      return
    }
    try {
      startGattServer()
      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
        .setConnectable(true) // GATT read + sync paths need connectable
        .build()
      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(SERVICE_UUID))
        .build()
      val scanResponse = AdvertiseData.Builder()
        .addManufacturerData(MANUFACTURER_ID, payload)
        .build()
      val cb = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
          advertising = true
          log(
            "advertise//started mode=${settingsInEffect.mode} " +
              "tx=${settingsInEffect.txPowerLevel} " +
              "connectable=${settingsInEffect.isConnectable}",
          )
          emitState()
          promise?.resolve(null)
        }

        override fun onStartFailure(errorCode: Int) {
          advertising = false
          // DATA_TOO_LARGE here means the payload outgrew the 31-byte scan
          // response and NOTHING is on the air — the loudest silent failure
          // in the whole file.
          log("advertise//failed code=$errorCode reason=${advErrName(errorCode)} scanRspBytes=${payload.size}")
          emitState("advertise failed ($errorCode)")
          promise?.reject("advertise", "start failed ($errorCode)")
        }
      }
      advertiseCallback = cb
      // The primary packet carries the service UUID; the payload rides the
      // scan response as manufacturer data. Both sizes matter at 31 bytes.
      log(
        "advertise//start uuid=service primary=uuid-only " +
          "scanRsp=mfr:0x${MANUFACTURER_ID.toString(16)}:${payload.size}B connectable=true",
      )
      advertiser.startAdvertising(settings, data, scanResponse, cb)
    } catch (e: SecurityException) {
      log("advertise//reject reason=security-exception")
      emitState("permission denied")
      promise?.reject("permission", e.message ?: "denied")
    }
  }

  @ReactMethod
  fun stopAdvertising(promise: Promise) {
    main.post {
      stopAdvertisingInternal(keepServer = false)
      promise.resolve(null)
    }
  }

  private fun stopAdvertisingInternal(keepServer: Boolean) {
    log("advertise//stop wasAdvertising=$advertising keepServer=$keepServer")
    try {
      advertiseCallback?.let { adapter()?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    } catch (_: Exception) {
      // Bluetooth toggled off underneath us — the goal state is reached.
      log("advertise//stop err=exception (adapter gone)")
    }
    advertiseCallback = null
    advertising = false
    if (!keepServer) {
      stopGattServer()
    }
    emitState()
  }

  // ------------------------------------------------------------ GATT server

  /** Frame a stream for one central: [seq u16][total u16][chunk]. total=0
   * (with empty body) means "not ready — retry". */
  private fun frameFor(buf: ByteArray?, cursor: Int): ByteArray {
    if (buf == null) {
      return byteArrayOf(0, 0, 0, 0)
    }
    val total = if (buf.isEmpty()) 1 else (buf.size + FRAME_CHUNK - 1) / FRAME_CHUNK
    val seq = cursor.coerceIn(0, total - 1)
    val from = seq * FRAME_CHUNK
    val to = minOf(from + FRAME_CHUNK, buf.size)
    val out = ByteArray(4 + (to - from))
    out[0] = ((seq shr 8) and 0xFF).toByte()
    out[1] = (seq and 0xFF).toByte()
    out[2] = ((total shr 8) and 0xFF).toByte()
    out[3] = (total and 0xFF).toByte()
    buf.copyInto(out, 4, from, to)
    return out
  }

  // -------------------------------------------------- per-central lifetime

  /**
   * Remember this central, and keep the roster small. Call this at every
   * point that CREATES per-central state; the caller must already hold
   * syncLock. The central being touched is moved to the newest end first,
   * so it can never evict itself.
   */
  private fun trackCentral(addr: String) {
    centralSeen.remove(addr)
    centralSeen[addr] = System.currentTimeMillis()
    while (centralSeen.size > MAX_TRACKED_CENTRALS) {
      val oldest = centralSeen.keys.first()
      log(
        "gatt-server//evict addr=$oldest tracked=${centralSeen.size} " +
          "max=$MAX_TRACKED_CENTRALS reason=roster-full",
      )
      dropCentralState(oldest)
    }
  }

  /**
   * Free EVERY buffer one central made. Called from the server's own
   * disconnect callback and from eviction: state a central created must not
   * outlive its link. Before this, a stranger who connected once left seven
   * map entries behind until the whole server closed. Caller holds syncLock.
   */
  private fun dropCentralState(addr: String) {
    val bytes = (digestFrame[addr]?.size ?: 0) +
      (msgFrame[addr]?.size ?: 0) +
      (msgBuffers[addr]?.size ?: 0) +
      (wantAssembly[addr]?.size() ?: 0) +
      (preparedWrites[addr]?.values?.fold(0) { acc, s -> acc + s.size() } ?: 0)
    centralSeen.remove(addr)
    digestCursor.remove(addr)
    digestStreamGen.remove(addr)
    digestFrame.remove(addr)
    msgCursor.remove(addr)
    msgFrame.remove(addr)
    msgBuffers.remove(addr)
    wantAssembly.remove(addr)
    preparedWrites.remove(addr)
    log("gatt-server//free addr=$addr bytes=$bytes tracked=${centralSeen.size}")
  }

  /**
   * One WANT frame, however it reached us — a short write that fits the
   * MTU, or a prepared (long) write assembled in onExecuteWrite. Returns
   * the completed want bytes when this frame closed the stream, otherwise
   * null; the caller emits to JS AFTER releasing syncLock. Caller holds it.
   */
  private fun handleWantFrame(addr: String, value: ByteArray): ByteArray? {
    if (value.size < 4) {
      log("gatt-server//want-drop addr=$addr bytes=${value.size} reason=short-frame(<4B)")
      return null
    }
    val seq = ((value[0].toInt() and 0xFF) shl 8) or (value[1].toInt() and 0xFF)
    val total = ((value[2].toInt() and 0xFF) shl 8) or (value[3].toInt() and 0xFF)
    val sink = if (seq == 0) {
      trackCentral(addr)
      ByteArrayOutputStream().also { wantAssembly[addr] = it }
    } else {
      wantAssembly[addr]
    }
    if (sink == null) {
      // A continuation frame with no seq=0 to continue: these bytes vanish
      // and the want is never assembled or answered.
      log(
        "gatt-server//want-drop addr=$addr seq=$seq total=$total " +
          "bytes=${value.size - 4} reason=no-assembly-for-continuation",
      )
      return null
    }
    if (sink.size() + value.size - 4 > MAX_WANT_BYTES) {
      // total is a peer-supplied u16: 65535 frames x 480 bytes is 31MB of
      // OUR heap on THEIR say-so. A want list of ids never approaches this.
      wantAssembly.remove(addr)
      log(
        "gatt-server//want-drop addr=$addr seq=$seq total=$total " +
          "acc=${sink.size()} max=$MAX_WANT_BYTES reason=want-too-large",
      )
      return null
    }
    sink.write(value, 4, value.size - 4)
    log(
      "gatt-server//want-frame addr=$addr seq=$seq total=$total " +
        "chunk=${value.size - 4} acc=${sink.size()}",
    )
    if (seq + 1 < total) {
      return null
    }
    wantAssembly.remove(addr)
    // fresh want = fresh response stream; JS assembles it
    msgBuffers.remove(addr)
    msgCursor.remove(addr)
    msgFrame.remove(addr) // never continue the previous answer's frame
    log("gatt-server//want-complete addr=$addr bytes=${sink.size()} handoff=js")
    return sink.toByteArray()
  }

  private fun startGattServer() {
    if (gattServer != null) {
      log("gatt-server//open skip=already-open")
      return
    }
    val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: run {
      log("gatt-server//open err=no-bluetooth-manager")
      return
    }
    try {
      val server = manager.openGattServer(ctx, object : BluetoothGattServerCallback() {
        override fun onCharacteristicReadRequest(
          device: BluetoothDevice,
          requestId: Int,
          offset: Int,
          characteristic: BluetoothGattCharacteristic,
        ) {
          val addr = device.address
          val role = charName(characteristic.uuid)
          log("gatt-server//read addr=$addr char=$role offset=$offset")
          // A LONG READ IS ONE VALUE DELIVERED IN PIECES, NOT N READS.
          // Cross-family review, Aug 24: this handler used to mint a NEW
          // frame and advance the cursor on EVERY read request, ignoring
          // `offset`. iOS negotiates a ~185-byte ATT MTU, so a 484-byte
          // frame arrives as continuation reads at offsets 184 and 368 —
          // each continuation was served a DIFFERENT frame's bytes, the
          // central reassembled a chimera, and mail never moved iOS <-
          // Android once the store held more than ~4 digest entries. That
          // is the exact iPhone/Android pairing this feature exists for.
          // The Swift server had it right; Android was the wrong side.
          // So: build a frame only when offset == 0, cache it per central,
          // and serve continuations by slicing THAT cached frame.
          val value: ByteArray = when (characteristic.uuid) {
            PAYLOAD_CHAR -> {
              if (offset >= payload.size) {
                // Empty means "no more bytes" — except at offset 0, where it
                // means this phone has NO payload set and the peer learns
                // nothing about us at all.
                log(
                  "gatt-server//read-empty addr=$addr char=payload offset=$offset " +
                    "size=${payload.size} reason=" +
                    (if (payload.isEmpty()) "no-payload-set" else "offset-past-end"),
                )
                ByteArray(0)
              } else {
                payload.copyOfRange(offset, payload.size)
              }
            }
            DIGEST_CHAR -> synchronized(syncLock) {
              if (offset == 0) {
                // A new digest does NOT clobber this central's stream any
                // more; it bumps a generation, and the rewind happens HERE,
                // at a stream boundary the central chose, instead of under
                // its feet mid-read. See digestGeneration.
                val gen = digestStreamGen[addr]
                val stale = gen != digestGeneration
                if (stale) {
                  log(
                    "gatt-server//digest-generation addr=$addr from=${gen ?: -1} " +
                      "to=$digestGeneration restart=seq0",
                  )
                }
                trackCentral(addr)
                digestStreamGen[addr] = digestGeneration
                val cur = if (stale) 0 else (digestCursor[addr] ?: 0)
                val f = frameFor(syncDigest, cur)
                digestFrame[addr] = f
                val total = ((f[2].toInt() and 0xFF) shl 8) or (f[3].toInt() and 0xFF)
                digestCursor[addr] = if (cur + 1 >= total) 0 else cur + 1
                // digestBytes=0 is the quiet one: an unset digest is served
                // as a COMPLETE one-frame stream with an empty body, which a
                // central reads as "this peer carries nothing".
                log(
                  "gatt-server//digest-frame addr=$addr gen=$digestGeneration seq=$cur " +
                    "total=$total chunk=${f.size - 4} digestBytes=${syncDigest.size} " +
                    "nextCursor=${digestCursor[addr]}",
                )
              }
              val cached = digestFrame[addr]
              if (cached == null) {
                log(
                  "gatt-server//read-empty addr=$addr char=digest offset=$offset " +
                    "reason=no-cached-frame (continuation with no offset-0 build)",
                )
              }
              val frame = cached ?: byteArrayOf(0, 0, 0, 0)
              if (offset >= frame.size) {
                log(
                  "gatt-server//read-empty addr=$addr char=digest offset=$offset " +
                    "frameBytes=${frame.size} reason=offset-past-frame-end",
                )
                ByteArray(0)
              } else {
                frame.copyOfRange(offset, frame.size)
              }
            }
            MSG_CHAR -> synchronized(syncLock) {
              if (offset == 0) {
                val buf = msgBuffers[addr]
                val cur = msgCursor[addr] ?: 0
                val f = frameFor(buf, cur)
                trackCentral(addr)
                msgFrame[addr] = f
                val total = ((f[2].toInt() and 0xFF) shl 8) or (f[3].toInt() and 0xFF)
                if (buf == null) {
                  // total=0 = "not ready, retry": JS has not answered the
                  // want yet, or never will.
                  log("gatt-server//msg-frame addr=$addr notready=1 total=0 reason=no-buffer-from-js")
                }
                if (buf != null && cur + 1 >= total) {
                  // Stream complete — but only once the FINAL frame has been
                  // handed over, which is this offset==0 build. Freeing on a
                  // continuation would drop the tail mid-delivery.
                  msgBuffers.remove(addr)
                  msgCursor.remove(addr)
                  log(
                    "gatt-server//msg-frame addr=$addr seq=$cur total=$total " +
                      "chunk=${f.size - 4} last=1 streamFreed=1",
                  )
                } else if (buf != null) {
                  msgCursor[addr] = cur + 1
                  log(
                    "gatt-server//msg-frame addr=$addr seq=$cur total=$total " +
                      "chunk=${f.size - 4} last=0 bufBytes=${buf.size}",
                  )
                }
              }
              val cached = msgFrame[addr]
              if (cached == null) {
                log(
                  "gatt-server//read-empty addr=$addr char=msg offset=$offset " +
                    "reason=no-cached-frame (continuation with no offset-0 build)",
                )
              }
              val frame = cached ?: byteArrayOf(0, 0, 0, 0)
              if (offset >= frame.size) {
                log(
                  "gatt-server//read-empty addr=$addr char=msg offset=$offset " +
                    "frameBytes=${frame.size} reason=offset-past-frame-end",
                )
                ByteArray(0)
              } else {
                frame.copyOfRange(offset, frame.size)
              }
            }
            else -> null
          } ?: run {
            log(
              "gatt-server//read-fail addr=$addr char=$role offset=$offset " +
                "reason=unknown-characteristic answer=GATT_FAILURE",
            )
            try {
              val server = gattServer
              if (server == null) {
                log("gatt-server//read-drop addr=$addr char=$role reason=server-null answer=none")
              } else {
                server.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, ByteArray(0))
              }
            } catch (_: SecurityException) {
              log("gatt-server//read-drop addr=$addr char=$role reason=security-on-failure-response answer=none")
            }
            return
          }
          try {
            val server = gattServer
            if (server == null) {
              // No response at all: the central waits out its own timeout.
              log(
                "gatt-server//read-drop addr=$addr char=$role offset=$offset " +
                  "bytes=${value.size} reason=server-null answer=none",
              )
            } else {
              server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
              log("gatt-server//read-ok addr=$addr char=$role offset=$offset bytes=${value.size}")
            }
          } catch (_: SecurityException) {
            // connect permission revoked mid-flight; nothing to serve
            log(
              "gatt-server//read-drop addr=$addr char=$role offset=$offset " +
                "reason=security-exception answer=none",
            )
          }
        }

        override fun onCharacteristicWriteRequest(
          device: BluetoothDevice,
          requestId: Int,
          characteristic: BluetoothGattCharacteristic,
          preparedWrite: Boolean,
          responseNeeded: Boolean,
          offset: Int,
          value: ByteArray,
        ) {
          val waddr = device.address
          val wrole = charName(characteristic.uuid)
          log(
            "gatt-server//write addr=$waddr char=$wrole offset=$offset " +
              "bytes=${value.size} prepared=$preparedWrite needsResponse=$responseNeeded",
          )
          if (preparedWrite) {
            // A PREPARED (LONG) WRITE IS ONE VALUE QUEUED IN PIECES, NOT N
            // VALUES. This handler used to parse every chunk as a complete
            // [seq][total][chunk] frame, so a central whose value exceeds
            // the negotiated MTU had chunk 2 onwards read as a header — and
            // then onExecuteWrite never answered, so the central sat there
            // until it gave up and dropped the link. CoreBluetooth splits
            // long writes AUTOMATICALLY, so that is every iOS central whose
            // want list is bigger than one ATT payload: the exact pairing
            // this feature exists for, hung at the want step.
            val status = synchronized(syncLock) {
              // Deliberately NOT getOrPut: a rejected chunk must leave no
              // entry behind, or a stranger spraying bad offsets from many
              // addresses grows the outer map past the roster cap.
              val sink = preparedWrites[waddr]?.get(characteristic.uuid)
              when {
                sink == null && offset != 0 -> {
                  log(
                    "gatt-server//prepare-reject addr=$waddr char=$wrole offset=$offset " +
                      "reason=no-queue-for-continuation answer=invalid-offset",
                  )
                  BluetoothGatt.GATT_INVALID_OFFSET
                }
                sink != null && offset != sink.size() -> {
                  log(
                    "gatt-server//prepare-reject addr=$waddr char=$wrole offset=$offset " +
                      "queued=${sink.size()} reason=offset-gap answer=invalid-offset",
                  )
                  BluetoothGatt.GATT_INVALID_OFFSET
                }
                (sink?.size() ?: 0) + value.size > MAX_PREPARED_BYTES -> {
                  preparedWrites[waddr]?.remove(characteristic.uuid)
                  log(
                    "gatt-server//prepare-reject addr=$waddr char=$wrole offset=$offset " +
                      "queued=${sink?.size() ?: 0} bytes=${value.size} max=$MAX_PREPARED_BYTES " +
                      "reason=too-long answer=invalid-attribute-length",
                  )
                  BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH
                }
                else -> {
                  val s = sink ?: ByteArrayOutputStream().also {
                    trackCentral(waddr)
                    preparedWrites.getOrPut(waddr) { HashMap() }[characteristic.uuid] = it
                  }
                  s.write(value, 0, value.size)
                  log(
                    "gatt-server//prepare addr=$waddr char=$wrole offset=$offset " +
                      "bytes=${value.size} queued=${s.size()}",
                  )
                  BluetoothGatt.GATT_SUCCESS
                }
              }
            }
            if (responseNeeded) {
              try {
                val server = gattServer
                if (server == null) {
                  log("gatt-server//prepare-drop addr=$waddr char=$wrole reason=server-null answer=none")
                } else {
                  // A prepare-write response ECHOES the offset and the bytes
                  // it queued; a central that compares them is entitled to.
                  server.sendResponse(device, requestId, status, offset, value)
                }
              } catch (_: SecurityException) {
                log("gatt-server//prepare-drop addr=$waddr char=$wrole reason=security-exception answer=none")
              }
            }
            return
          }
          if (characteristic.uuid == WANT_CHAR) {
            val addr = device.address
            val ready = synchronized(syncLock) { handleWantFrame(addr, value) }
            if (ready != null) {
              val m = Arguments.createMap()
              m.putString("peerId", addr)
              m.putString("payload", Base64.encodeToString(ready, Base64.NO_WRAP))
              emit(SYNC_WANT_EVENT, m)
            }
          } else {
            // Everything else on this server is read-only, so any other
            // write is accepted at the ATT layer and then thrown away.
            // (A short WANT frame is now the want handler's own line.)
            log(
              "gatt-server//write-ignored addr=$waddr char=$wrole bytes=${value.size} " +
                "reason=not-want-char",
            )
          }
          if (responseNeeded) {
            try {
              val server = gattServer
              if (server == null) {
                log("gatt-server//write-drop addr=$waddr char=$wrole reason=server-null answer=none")
              } else {
                server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
                log("gatt-server//write-ack addr=$waddr char=$wrole offset=$offset")
              }
            } catch (_: SecurityException) {
              log("gatt-server//write-drop addr=$waddr char=$wrole reason=security-exception answer=none")
            }
          }
        }

        // An inbound connection, a negotiated MTU and a service
        // registration are three server-side facts the platform's own logs
        // never attribute to us, which is why all three are overridden. The
        // MTU and service-added overrides are LOG-ONLY (their base
        // implementations are empty, so they change nothing on the wire);
        // the connection one also FREES that central's state on disconnect.

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
          log(
            "gatt-server//conn addr=${device.address} status=$status " +
              "state=${connState(newState)}",
          )
          if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            // NOT log-only any more. Every buffer a central made dies with
            // its link: cached frames, cursors, generation, want assembly,
            // queued prepared writes. Before this they lived until the
            // whole server closed — one set per stranger who ever
            // connected, and connecting takes no crew, no pairing and no
            // permission from us.
            synchronized(syncLock) {
              if (centralSeen.containsKey(device.address)) {
                dropCentralState(device.address)
              }
            }
          }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
          // A small MTU is not an error, but it decides how many
          // continuation reads each 484-byte frame costs.
          log("gatt-server//mtu addr=${device.address} mtu=$mtu")
        }

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
          log(
            "gatt-server//service-added status=$status ok=${status == BluetoothGatt.GATT_SUCCESS} " +
              "chars=${service.characteristics.size}",
          )
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
          // The other half of the prepared-write fix. execute=false is the
          // central CANCELLING everything it queued (ATT "Execute Write
          // Request" with flags=0x00) and it must discard, not apply.
          val addr = device.address
          val ready = synchronized(syncLock) {
            val queued = preparedWrites.remove(addr)
            val chars = queued?.size ?: 0
            val bytes = queued?.values?.fold(0) { acc, s -> acc + s.size() } ?: 0
            log(
              "gatt-server//execute-write addr=$addr execute=$execute " +
                "chars=$chars bytes=$bytes",
            )
            var out: ByteArray? = null
            if (!execute) {
              if (chars > 0) {
                log("gatt-server//execute-cancel addr=$addr chars=$chars bytes=$bytes")
              }
            } else if (queued != null) {
              for ((uuid, sink) in queued) {
                val assembled = sink.toByteArray()
                if (uuid == WANT_CHAR) {
                  log(
                    "gatt-server//execute-apply addr=$addr char=${charName(uuid)} " +
                      "bytes=${assembled.size}",
                  )
                  out = handleWantFrame(addr, assembled) ?: out
                } else {
                  log(
                    "gatt-server//execute-drop addr=$addr char=${charName(uuid)} " +
                      "bytes=${assembled.size} reason=not-want-char",
                  )
                }
              }
            }
            out
          }
          if (ready != null) {
            val m = Arguments.createMap()
            m.putString("peerId", addr)
            m.putString("payload", Base64.encodeToString(ready, Base64.NO_WRAP))
            emit(SYNC_WANT_EVENT, m)
          }
          try {
            val server = gattServer
            if (server == null) {
              log("gatt-server//execute-drop addr=$addr reason=server-null answer=none")
            } else {
              server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, ByteArray(0))
              log("gatt-server//execute-ack addr=$addr execute=$execute")
            }
          } catch (_: SecurityException) {
            log("gatt-server//execute-drop addr=$addr reason=security-exception answer=none")
          }
        }
      }) ?: run {
        log("gatt-server//open err=openGattServer-returned-null")
        return
      }
      val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          PAYLOAD_CHAR,
          BluetoothGattCharacteristic.PROPERTY_READ,
          BluetoothGattCharacteristic.PERMISSION_READ,
        ),
      )
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          DIGEST_CHAR,
          BluetoothGattCharacteristic.PROPERTY_READ,
          BluetoothGattCharacteristic.PERMISSION_READ,
        ),
      )
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          WANT_CHAR,
          BluetoothGattCharacteristic.PROPERTY_WRITE,
          BluetoothGattCharacteristic.PERMISSION_WRITE,
        ),
      )
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          MSG_CHAR,
          BluetoothGattCharacteristic.PROPERTY_READ,
          BluetoothGattCharacteristic.PERMISSION_READ,
        ),
      )
      server.addService(service)
      gattServer = server
      log("gatt-server//open ok chars=4 (payload,digest,want,msg)")
    } catch (_: SecurityException) {
      // no CONNECT permission: the inline-advertisement path still works
      log("gatt-server//open err=security-exception reason=no-connect-permission")
    }
  }

  private fun stopGattServer() {
    log("gatt-server//close open=${gattServer != null}")
    try {
      gattServer?.close()
    } catch (_: Exception) {
      // closing a server whose adapter died throws; the state is what we want
      log("gatt-server//close err=exception (adapter gone)")
    }
    gattServer = null
    synchronized(syncLock) {
      // The server is gone, so every central's link is too: this is the one
      // place a wholesale clear is honest.
      log("gatt-server//free-all tracked=${centralSeen.size}")
      centralSeen.clear()
      digestCursor.clear()
      digestStreamGen.clear()
      msgCursor.clear()
      msgBuffers.clear()
      wantAssembly.clear()
      digestFrame.clear()
      msgFrame.clear()
      preparedWrites.clear()
    }
  }

  /** JS keeps the served digest current on every message-store change. */
  @ReactMethod
  fun setSyncDigest(b64: String, promise: Promise) {
    val decoded = try {
      Base64.decode(b64, Base64.NO_WRAP)
    } catch (e: Exception) {
      log("sync-server//digest-reject reason=not-base64")
      promise.reject("payload", "digest is not base64")
      return
    }
    // THIS FIRES ON EVERY MESSAGE-STORE CHANGE — i.e. while peers are
    // reading. It used to clear the cursors and the cached frames, which
    // invalidated centrals mid-stream and mid-continuation alike. It now
    // bumps a generation instead: the cached frames stay (an in-flight
    // continuation completes from its own snapshot) and each central
    // rewinds to seq 0 at ITS next offset-0 read. See digestGeneration.
    synchronized(syncLock) {
      syncDigest = decoded
      digestGeneration++
      log(
        "sync-server//digest bytes=${syncDigest.size} gen=$digestGeneration " +
          "tracked=${centralSeen.size} framesKept=${digestFrame.size}",
      )
    }
    promise.resolve(null)
  }

  /** JS answers a CrewSyncWant with the assembled message bytes for that
   * central; the MSG_CHAR stream serves it out in frames. */
  @ReactMethod
  fun provideSyncMessages(peerId: String, b64: String, promise: Promise) {
    val bytes = try {
      Base64.decode(b64, Base64.NO_WRAP)
    } catch (e: Exception) {
      log("sync-server//provide-reject addr=$peerId reason=not-base64")
      promise.reject("payload", "messages are not base64")
      return
    }
    log("sync-server//provide addr=$peerId bytes=${bytes.size}")
    synchronized(syncLock) {
      trackCentral(peerId)
      msgBuffers[peerId] = bytes
      msgCursor[peerId] = 0
      msgFrame.remove(peerId) // new stream: never continue an old frame
    }
    promise.resolve(null)
  }

  // ------------------------------------------------------------ scan

  @ReactMethod
  fun startScan(promise: Promise) {
    val missing = missingFor(
      Manifest.permission.BLUETOOTH_SCAN,
      Manifest.permission.BLUETOOTH_CONNECT,
    )
    if (missing != null) {
      log("scan//reject reason=permission perm=$missing")
      emitState("permission $missing") // same reason as advertise: see above
      promise.reject("permission", missing)
      return
    }
    val adapter = adapter()
    val scanner = adapter?.bluetoothLeScanner
    if (adapter == null || !adapter.isEnabled || scanner == null) {
      log(
        "scan//reject reason=bluetooth-off adapter=${adapter != null} " +
          "enabled=${adapter?.isEnabled} scanner=${scanner != null}",
      )
      promise.reject("bluetooth-off", "Bluetooth is off")
      return
    }
    if (scanning) {
      log("scan//start skip=already-scanning")
      promise.resolve(null)
      return
    }
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
      .build()
    val cb = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val addr = result.device.address
        log("scan//result addr=$addr rssi=${result.rssi} cbType=$callbackType")
        val record = result.scanRecord ?: run {
          // Filtered in by the service UUID, yet no record survived the
          // stack: nothing to read, no sighting, no GATT fallback.
          log("scan//discard addr=$addr reason=no-scan-record")
          return
        }
        val inline = record.getManufacturerSpecificData(MANUFACTURER_ID)
        if (inline != null && inline.isNotEmpty()) {
          log("scan//inline addr=$addr bytes=${inline.size} mfrId=0x${MANUFACTURER_ID.toString(16)}")
          emitSighting(inline, result.rssi, "adv", result.device.address)
          return
        }
        // No inline payload = an iOS peer (or a stripped record): read the
        // characteristic, rate-limited so a crowd never becomes a storm.
        // NOT a discard — but the sighting now depends on the GATT read
        // below succeeding, so say which of the two cases this was.
        log(
          "scan//no-inline addr=$addr reason=" +
            (if (inline == null) "no-manufacturer-data" else "empty-manufacturer-data") +
            " fallback=gatt",
        )
        maybeGattRead(result.device, result.rssi)
      }

      override fun onScanFailed(errorCode: Int) {
        scanning = false
        log("scan//failed code=$errorCode reason=${scanErrName(errorCode)}")
        emitState("scan failed ($errorCode)")
      }
    }
    try {
      scanner.startScan(listOf(filter), settings, cb)
      scanCallback = cb
      scanning = true
      log("scan//start filter=service-uuid mode=balanced")
      emitState()
      promise.resolve(null)
    } catch (e: SecurityException) {
      log("scan//reject reason=security-exception")
      emitState("permission denied")
      promise.reject("permission", e.message ?: "denied")
    }
  }

  @ReactMethod
  fun stopScan(promise: Promise) {
    log("scan//stop wasScanning=$scanning")
    try {
      scanCallback?.let { adapter()?.bluetoothLeScanner?.stopScan(it) }
    } catch (_: Exception) {
      // adapter off — already stopped in effect
      log("scan//stop err=exception (adapter gone)")
    }
    scanCallback = null
    scanning = false
    emitState()
    promise.resolve(null)
  }

  private fun maybeGattRead(device: BluetoothDevice, rssi: Int) {
    val now = System.currentTimeMillis()
    val addr = device.address
    log("gatt//maybe addr=$addr rssi=$rssi")
    synchronized(gattTried) {
      val last = gattTried[addr] ?: 0L
      // Global in-flight cap (cross-family review): per-device cooldowns
      // alone still let a dense crowd open N parallel connects.
      if (gattInFlight.size >= MAX_GATT_IN_FLIGHT) {
        log(
          "gatt//skip addr=$addr reason=in-flight-cap " +
            "inFlight=${gattInFlight.size} max=$MAX_GATT_IN_FLIGHT",
        )
        return
      }
      if (addr in gattInFlight || now - last < GATT_COOLDOWN_MS) {
        log(
          "gatt//skip addr=$addr reason=" +
            (if (addr in gattInFlight) "already-in-flight" else "cooldown") +
            " ageMs=${if (last == 0L) -1 else now - last} cooldownMs=$GATT_COOLDOWN_MS",
        )
        return
      }
      gattTried[addr] = now
      gattInFlight.add(addr)
    }
    log("gatt//connect addr=$addr rssi=$rssi inFlight=${gattInFlight.size}")
    var gatt: BluetoothGatt? = null
    val finish = Runnable {
      log("gatt//finish addr=$addr")
      try {
        gatt?.disconnect()
        gatt?.close()
      } catch (_: Exception) {
        // double-close on a dead adapter is fine
        log("gatt//finish addr=$addr err=exception-on-close")
      }
      synchronized(gattTried) { gattInFlight.remove(addr) }
    }
    val timeout = Runnable {
      log("gatt//timeout addr=$addr ms=$GATT_TIMEOUT_MS reason=no-read-completed")
      finish.run()
    }
    try {
      gatt = device.connectGatt(ctx, false, object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
          log("gatt//state addr=$addr status=$status state=${connState(newState)}")
          if (newState == BluetoothProfile.STATE_CONNECTED) {
            try {
              g.discoverServices()
              log("gatt//discover addr=$addr")
            } catch (_: SecurityException) {
              log("gatt//discard addr=$addr reason=security-on-discoverServices")
              main.post(finish)
            }
          } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            // Includes the connect that never landed (status 133 & friends):
            // no sighting comes out of this peer this round.
            log("gatt//discard addr=$addr reason=disconnected status=$status")
            main.post(finish)
          }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          val svc = g.getService(SERVICE_UUID)
          val ch = svc?.getCharacteristic(PAYLOAD_CHAR)
          log(
            "gatt//services addr=$addr status=$status service=${svc != null} " +
              "payloadChar=${ch != null}",
          )
          if (ch == null) {
            log(
              "gatt//discard addr=$addr reason=" +
                (if (svc == null) "no-crew-service" else "no-payload-characteristic"),
            )
            main.post(finish)
            return
          }
          try {
            @Suppress("DEPRECATION")
            g.readCharacteristic(ch)
            log("gatt//read addr=$addr char=payload")
          } catch (_: SecurityException) {
            log("gatt//discard addr=$addr reason=security-on-readCharacteristic")
            main.post(finish)
          }
        }

        @Deprecated("pre-33 callback; the 33+ overload delegates here")
        override fun onCharacteristicRead(
          g: BluetoothGatt,
          characteristic: BluetoothGattCharacteristic,
          status: Int,
        ) {
          @Suppress("DEPRECATION")
          val v = characteristic.value
          log("gatt//read-result addr=$addr api=pre33 status=$status bytes=${v?.size ?: -1}")
          if (status == BluetoothGatt.GATT_SUCCESS && v != null && v.isNotEmpty()) {
            emitSighting(v, rssi, "gatt", addr)
          } else {
            log(
              "gatt//discard addr=$addr reason=" +
                (
                  if (status != BluetoothGatt.GATT_SUCCESS) "read-status-$status"
                  else if (v == null) "null-value"
                  else "empty-value"
                  ),
            )
          }
          main.post { main.removeCallbacks(timeout); finish.run() }
        }

        override fun onCharacteristicRead(
          g: BluetoothGatt,
          characteristic: BluetoothGattCharacteristic,
          value: ByteArray,
          status: Int,
        ) {
          log("gatt//read-result addr=$addr api=33+ status=$status bytes=${value.size}")
          if (status == BluetoothGatt.GATT_SUCCESS && value.isNotEmpty()) {
            emitSighting(value, rssi, "gatt", addr)
          } else {
            log(
              "gatt//discard addr=$addr reason=" +
                (
                  if (status != BluetoothGatt.GATT_SUCCESS) "read-status-$status"
                  else "empty-value"
                  ),
            )
          }
          main.post { main.removeCallbacks(timeout); finish.run() }
        }
      })
      main.postDelayed(timeout, GATT_TIMEOUT_MS)
    } catch (_: SecurityException) {
      log("gatt//discard addr=$addr reason=security-on-connectGatt")
      finish.run()
    }
  }

  // ------------------------------------------------------------ sync client

  /**
   * One connected sync engine per call: connect to the peer, run the
   * requested phases, assemble the framed streams, disconnect, resolve.
   * wantB64 empty = digest-only. Runs ONE at a time on purpose (one radio,
   * and syncs recur on later sightings anyway).
   */
  @ReactMethod
  fun syncWithPeer(peerId: String, wantB64: String, promise: Promise) {
    val missing = missingFor(Manifest.permission.BLUETOOTH_CONNECT)
    if (missing != null) {
      log("sync//reject addr=$peerId reason=permission perm=$missing")
      promise.reject("permission", missing)
      return
    }
    val adapter = adapter()
    if (adapter == null || !adapter.isEnabled) {
      log("sync//reject addr=$peerId reason=bluetooth-off")
      promise.reject("bluetooth-off", "Bluetooth is off")
      return
    }
    synchronized(this) {
      if (syncBusy) {
        // The one-at-a-time mutex. A sync that never releases it strands
        // every later attempt here, so this line is the first place to look
        // when one direction goes quiet.
        log("sync//reject addr=$peerId reason=busy")
        promise.reject("busy", "another sync is running")
        return
      }
      syncBusy = true
    }
    val wantBytes = try {
      if (wantB64.isEmpty()) ByteArray(0) else Base64.decode(wantB64, Base64.NO_WRAP)
    } catch (e: Exception) {
      syncBusy = false
      log("sync//reject addr=$peerId reason=want-not-base64")
      promise.reject("payload", "want is not base64")
      return
    }
    val device = try {
      adapter.getRemoteDevice(peerId)
    } catch (e: Exception) {
      syncBusy = false
      log("sync//reject addr=$peerId reason=unknown-peer-id")
      promise.reject("peer", "unknown peer id")
      return
    }
    log(
      "sync//request addr=$peerId wantBytes=${wantBytes.size} " +
        "mode=${if (wantBytes.isEmpty()) "digest-only" else "digest+messages"}",
    )
    SyncClient(device, wantBytes, promise).start()
  }

  /** The connected sync state machine. Kept as an inner class so its many
   * callbacks share state without a map of partial closures. */
  private inner class SyncClient(
    private val device: BluetoothDevice,
    private val want: ByteArray,
    private val promise: Promise,
  ) : BluetoothGattCallback() {
    private var gatt: BluetoothGatt? = null
    private var digestOut = ByteArrayOutputStream()
    private var msgOut = ByteArrayOutputStream()
    private var phase = "connect" // connect -> digest -> want -> messages
    private var wantSeq = 0
    /** The seq this side expects next. A server whose digest changed
     * between our reads restarts its stream at seq 0 (see the serving
     * side's generation logic); appending its frame 0 onto our half-read
     * old stream would build a digest that never existed on either phone.
     * The check turns that from silent corruption into a named event. */
    private var expectSeq = 0
    private var done = false
    private val addr = device.address
    private val timeoutRunnable = Runnable {
      log("sync//timeout addr=$addr phase=$phase ms=$SYNC_TIMEOUT_MS")
      fail("sync timed out")
    }

    fun start() {
      log("sync//start addr=$addr wantBytes=${want.size} timeoutMs=$SYNC_TIMEOUT_MS")
      main.postDelayed(timeoutRunnable, SYNC_TIMEOUT_MS)
      try {
        gatt = device.connectGatt(ctx, false, this)
      } catch (e: SecurityException) {
        log("sync//err addr=$addr phase=$phase reason=security-on-connectGatt")
        fail("permission")
      }
    }

    private fun finishOk() {
      if (done) {
        log("sync//late addr=$addr phase=$phase call=finishOk (already done)")
        return
      }
      done = true
      main.removeCallbacks(timeoutRunnable)
      cleanup()
      val m = Arguments.createMap()
      m.putString("digest", Base64.encodeToString(digestOut.toByteArray(), Base64.NO_WRAP))
      m.putString("messages", Base64.encodeToString(msgOut.toByteArray(), Base64.NO_WRAP))
      log(
        "sync//done addr=$addr ok=1 phase=$phase " +
          "digestBytes=${digestOut.size()} msgBytes=${msgOut.size()}",
      )
      syncBusy = false
      promise.resolve(m)
    }

    private fun fail(why: String) {
      if (done) {
        log("sync//late addr=$addr phase=$phase call=fail why=$why (already done)")
        return
      }
      done = true
      main.removeCallbacks(timeoutRunnable)
      cleanup()
      log(
        "sync//done addr=$addr ok=0 phase=$phase why=\"$why\" " +
          "digestBytes=${digestOut.size()} msgBytes=${msgOut.size()} wantSeq=$wantSeq",
      )
      syncBusy = false
      promise.reject("sync", why)
    }

    private fun cleanup() {
      try {
        gatt?.disconnect()
        gatt?.close()
      } catch (_: Exception) {}
    }

    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      log("sync//conn addr=$addr status=$status state=${connState(newState)} phase=$phase")
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        try {
          g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
          g.requestMtu(517)
          log("sync//mtu-request addr=$addr mtu=517 priority=high")
        } catch (_: SecurityException) {
          log("sync//err addr=$addr phase=$phase reason=security-on-requestMtu")
          fail("permission")
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED && !done) {
        // Dropped before we finished. If phase is still 'connect' we never
        // read a single byte off this peer.
        log(
          "sync//dropped addr=$addr phase=$phase status=$status " +
            "digestBytes=${digestOut.size()} msgBytes=${msgOut.size()} readAnything=" +
            "${digestOut.size() + msgOut.size() > 0}",
        )
        fail("peer disconnected")
      }
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      // The GRANTED mtu, which is what decides frame continuation counts —
      // iOS commonly grants ~185 against our request of 517.
      log("sync//mtu addr=$addr granted=$mtu status=$status frameChunk=$FRAME_CHUNK")
      try {
        g.discoverServices()
        log("sync//discover addr=$addr")
      } catch (_: SecurityException) {
        log("sync//err addr=$addr phase=$phase reason=security-on-discoverServices")
        fail("permission")
      }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      log(
        "sync//services addr=$addr status=$status service=${g.getService(SERVICE_UUID) != null}",
      )
      log("sync//phase addr=$addr from=$phase to=digest")
      phase = "digest"
      expectSeq = 0
      readChar(g, DIGEST_CHAR)
    }

    private fun readChar(g: BluetoothGatt, uuid: UUID) {
      val svc = g.getService(SERVICE_UUID)
      val ch = svc?.getCharacteristic(uuid)
      if (ch == null) {
        log(
          "sync//err addr=$addr phase=$phase char=${charName(uuid)} reason=" +
            (if (svc == null) "no-crew-service" else "characteristic-missing"),
        )
        fail("peer has no crew service")
        return
      }
      try {
        @Suppress("DEPRECATION")
        val started = g.readCharacteristic(ch)
        // The return value was always discarded: false means the read never
        // went out (busy queue / bad state) and NO callback will follow, so
        // the sync sits here until the 60s timeout. Log-only, unchanged.
        log("sync//read addr=$addr phase=$phase char=${charName(uuid)} started=$started")
      } catch (_: SecurityException) {
        log("sync//err addr=$addr phase=$phase reason=security-on-readCharacteristic")
        fail("permission")
      }
    }

    private fun writeWantFrame(g: BluetoothGatt) {
      val svc = g.getService(SERVICE_UUID)
      val ch = svc?.getCharacteristic(WANT_CHAR)
      if (ch == null) {
        log(
          "sync//err addr=$addr phase=$phase char=want reason=" +
            (if (svc == null) "no-crew-service" else "characteristic-missing"),
        )
        fail("peer has no crew service")
        return
      }
      val total = if (want.isEmpty()) 1 else (want.size + FRAME_CHUNK - 1) / FRAME_CHUNK
      val from = wantSeq * FRAME_CHUNK
      val to = minOf(from + FRAME_CHUNK, want.size)
      val frame = ByteArray(4 + (to - from))
      frame[0] = ((wantSeq shr 8) and 0xFF).toByte()
      frame[1] = (wantSeq and 0xFF).toByte()
      frame[2] = ((total shr 8) and 0xFF).toByte()
      frame[3] = (total and 0xFF).toByte()
      want.copyInto(frame, 4, from, to)
      try {
        @Suppress("DEPRECATION")
        ch.value = frame
        @Suppress("DEPRECATION")
        ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        val started = g.writeCharacteristic(ch)
        // Same discarded-boolean story as the read: false = nothing went
        // out and onCharacteristicWrite never fires.
        log(
          "sync//want-write addr=$addr seq=$wantSeq total=$total " +
            "chunk=${to - from} bytes=${frame.size} started=$started",
        )
      } catch (_: SecurityException) {
        log("sync//err addr=$addr phase=$phase reason=security-on-writeCharacteristic")
        fail("permission")
      }
    }

    override fun onCharacteristicWrite(
      g: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        log("sync//want-ack addr=$addr seq=$wantSeq status=$status ok=0")
        fail("want write failed ($status)")
        return
      }
      val total = if (want.isEmpty()) 1 else (want.size + FRAME_CHUNK - 1) / FRAME_CHUNK
      log("sync//want-ack addr=$addr seq=$wantSeq total=$total status=$status ok=1")
      wantSeq++
      if (wantSeq < total) {
        writeWantFrame(g)
      } else {
        log("sync//phase addr=$addr from=$phase to=messages wantFrames=$total")
        phase = "messages"
        expectSeq = 0
        readChar(g, MSG_CHAR)
      }
    }

    private fun onFrame(g: BluetoothGatt, value: ByteArray) {
      if (value.size < 4) {
        // Under a 4-byte header there is no frame at all — most often the
        // server answered an empty array (see its read-empty lines).
        log("sync//frame addr=$addr phase=$phase bytes=${value.size} reason=short-frame")
        fail("short frame")
        return
      }
      val seq = ((value[0].toInt() and 0xFF) shl 8) or (value[1].toInt() and 0xFF)
      val total = ((value[2].toInt() and 0xFF) shl 8) or (value[3].toInt() and 0xFF)
      val sink = if (phase == "digest") digestOut else msgOut
      if (total == 0) {
        // peer's JS is still assembling — retry the same read shortly.
        // Unbounded except by the 60s timeout: a peer that never provides
        // spins here, one line per retry.
        log("sync//notready addr=$addr phase=$phase retryMs=$NOT_READY_RETRY_MS")
        val uuid = if (phase == "digest") DIGEST_CHAR else MSG_CHAR
        main.postDelayed({ if (!done) readChar(g, uuid) }, NOT_READY_RETRY_MS)
        return
      }
      if (seq != expectSeq) {
        // The peer restarted this stream under us — its store changed and
        // its digest moved to a new generation. Two generations must never
        // be concatenated: take a seq 0 as a clean restart, refuse anything
        // else rather than assemble a frame sequence that means nothing.
        log(
          "sync//restart addr=$addr phase=$phase gotSeq=$seq expectSeq=$expectSeq " +
            "had=${sink.size()} action=" + (if (seq == 0) "reset" else "fail"),
        )
        if (seq != 0) {
          fail("stream restarted out of order")
          return
        }
        sink.reset()
      }
      log(
        "sync//frame addr=$addr phase=$phase seq=$seq total=$total " +
          "chunk=${value.size - 4} acc=${sink.size() + value.size - 4}",
      )
      sink.write(value, 4, value.size - 4)
      expectSeq = seq + 1
      if (seq + 1 < total) {
        readChar(g, if (phase == "digest") DIGEST_CHAR else MSG_CHAR)
        return
      }
      // stream complete
      if (phase == "digest") {
        if (want.isEmpty()) {
          log("sync//stream-complete addr=$addr phase=digest bytes=${digestOut.size()} next=finish")
          finishOk()
        } else {
          log("sync//phase addr=$addr from=digest to=want digestBytes=${digestOut.size()}")
          phase = "want"
          wantSeq = 0
          writeWantFrame(g)
        }
      } else {
        log("sync//stream-complete addr=$addr phase=$phase bytes=${msgOut.size()} next=finish")
        finishOk()
      }
    }

    @Deprecated("pre-33 callback; the 33+ overload delegates here")
    override fun onCharacteristicRead(
      g: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      @Suppress("DEPRECATION")
      val v = characteristic.value
      log(
        "sync//read-result addr=$addr api=pre33 phase=$phase " +
          "char=${charName(characteristic.uuid)} status=$status bytes=${v?.size ?: -1}",
      )
      if (status != BluetoothGatt.GATT_SUCCESS || v == null) {
        fail("read failed ($status)")
        return
      }
      onFrame(g, v)
    }

    override fun onCharacteristicRead(
      g: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) {
      log(
        "sync//read-result addr=$addr api=33+ phase=$phase " +
          "char=${charName(characteristic.uuid)} status=$status bytes=${value.size}",
      )
      if (status != BluetoothGatt.GATT_SUCCESS) {
        fail("read failed ($status)")
        return
      }
      onFrame(g, value)
    }
  }

  // ------------------------------------------------------------ Phase C

  /**
   * Keep the session alive with the screen off (CrewShareService). The
   * service only holds the process and ticks CrewBeaconTick — JS keeps
   * owning every refresh. On 33+ the persistent notification needs the
   * POST_NOTIFICATIONS grant; without it the OS shows nothing, which would
   * silently break the "you can always see it is on" consent surface — so
   * this rejects and the JS side asks in context first.
   */
  @ReactMethod
  fun startForegroundSession(promise: Promise) {
    if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) {
      log("service//reject reason=permission perm=POST_NOTIFICATIONS")
      promise.reject("permission", Manifest.permission.POST_NOTIFICATIONS)
      return
    }
    // A FOREGROUND_SERVICE_TYPE_LOCATION service on API 34+ throws
    // SecurityException at startForeground() unless fine location is
    // granted — and that throw happens ASYNCHRONOUSLY inside the service's
    // onStartCommand, where the try/catch below cannot reach it, so it
    // killed the app. Cross-family review, Aug 24, with the repro that
    // matters: a stranger who says NO to location and YES to Bluetooth,
    // then flips the share switch. Refuse honestly here instead; the JS
    // side already degrades to foreground-only sharing on a rejection.
    if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) {
      log("service//reject reason=permission perm=ACCESS_FINE_LOCATION")
      promise.reject("permission", Manifest.permission.ACCESS_FINE_LOCATION)
      return
    }
    try {
      CrewShareService.start(ctx)
      promise.resolve(null)
    } catch (e: Exception) {
      log("service//reject reason=start-threw")
      promise.reject("service", e.message ?: "could not start")
    }
  }

  @ReactMethod
  fun stopForegroundSession(promise: Promise) {
    CrewShareService.stop(ctx)
    promise.resolve(null)
  }

  /** True when the phone has a BLE stack at all — the UI hides Crew radio
   * affordances entirely on the rare device without one. */
  @ReactMethod
  fun isSupported(promise: Promise) {
    val fm = ctx.packageManager
    promise.resolve(
      fm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && adapter() != null,
    )
  }

  @ReactMethod
  fun stopAll(promise: Promise) {
    main.post {
      log("mesh//stop-all advertising=$advertising scanning=$scanning syncBusy=$syncBusy")
      stopAdvertisingInternal(keepServer = false)
      try {
        scanCallback?.let { adapter()?.bluetoothLeScanner?.stopScan(it) }
      } catch (_: Exception) {
        // adapter off
      }
      scanCallback = null
      scanning = false
      emitState()
      promise.resolve(null)
    }
  }

  // NativeEventEmitter requires these two to exist, even when unused.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  override fun invalidate() {
    // React instance is going away (reload, teardown): leave no radio on
    // and no receiver behind (a leaked one throws at the next reload).
    unregisterAdapterReceiver()
    // AND NO SERVICE. Killing the radio while the foreground service ran on
    // left the "Sharing with your pod" notification standing over a phone
    // that was neither advertising nor scanning — the consent surface
    // outliving the thing it certifies, which is the same defect class as
    // the notification that lies through a Bluetooth outage. The service
    // also cannot repair itself: its ticks reach a React instance that no
    // longer exists (service//tick drop=1 reason=no-react-context).
    CrewShareService.stop(ctx)
    main.post {
      log("mesh//invalidate advertising=$advertising scanning=$scanning syncBusy=$syncBusy service=stopped")
      stopAdvertisingInternal(keepServer = false)
      try {
        scanCallback?.let { adapter()?.bluetoothLeScanner?.stopScan(it) }
      } catch (_: Exception) {
        // adapter off
      }
      scanCallback = null
      scanning = false
    }
    super.invalidate()
  }
}
