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
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
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
 *   CrewSyncWant       { peerId: string, payload: base64,
 *                        requestId: number, serverEpoch: number }
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
    /** A central finished reading our digest: the reciprocity cue the JS
     * fast path dials back on (meshSync.ts). Address only, never content. */
    const val SYNC_SERVED_EVENT = "CrewSyncServed"
    /**
     * How long before this phone will re-READ a peer whose advertisement
     * carries no inline payload (an iOS peripheral, or a record the stack
     * stripped): the sighting for those peers IS a GATT read, so this
     * constant is not only a storm guard — it is that peer's SIGHTING
     * CADENCE, and every JS layer above sits underneath it.
     *
     * TWO NUMBERS, BECAUSE THERE ARE TWO POSTURES (delivery-clock lane,
     * 2026-08-25). JS shortened its own foreground cooldown to 15 s and
     * added compose/served nudges that bypass it (meshSync.ts) — and a
     * message still took 27.4 s to arrive between two adjacent phones,
     * because a nudge can only dial an address it has SEEN, and this gate
     * decided when one was seen. A JS fast path underneath a 30-second
     * native floor is not a fast path.
     *
     *  - FOREGROUND: 5 s, deliberately the same number as meshSync's
     *    NUDGE_MIN_GAP_MS. That constant is the app's answer to "how often
     *    may one peer be dialled at the very most" — the floor that bounds
     *    the reciprocity ping-pong — and there is no reason for the two
     *    layers to hold different opinions about it. Below the floor the
     *    honest answer is already "caught up".
     *  - BACKGROUND: 30 s, the number this shipped with, kept unchanged
     *    for the pocket.
     *
     * The STORM guard is not this constant and never was: MAX_GATT_IN_FLIGHT
     * caps concurrent connects, which is what a crowd of 70,000 phones
     * actually threatens. The floor bounds one address's rate; the cap
     * bounds the whole radio's.
     */
    private const val GATT_COOLDOWN_FOREGROUND_MS = 5_000L
    private const val GATT_COOLDOWN_BACKGROUND_MS = 30_000L
    private const val GATT_TIMEOUT_MS = 8_000L
    private const val MAX_GATT_IN_FLIGHT = 2
    /** Frame chunk kept safely under a 517-MTU write/read. */
    private const val FRAME_CHUNK = 480

    /** [epoch: 8][rev: 8][generation: 4] — see offerIdentityBlock. The
     * Swift twin's `offerIdentityBytes` is the same number. */
    private const val OFFER_IDENTITY_BYTES = 20
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
  /** Scan duty cycle asked for by JS (setScanMode): false = BALANCED (the
   * frugal default), true = LOW_LATENCY while the app is foreground. */
  private var scanLowLatency = false
  private var advertiseCallback: AdvertiseCallback? = null
  /** The live advertising set (API 26+ path). Holding it is what lets a
   * payload change be an in-place data update instead of a stop/start —
   * and a stop/start is not cosmetic: every restart mints a fresh random
   * BLE address, so a sharing phone used to change its name four times a
   * minute, and the whole meshSync freshness apparatus exists to survive
   * that. Keeping the set keeps the address. */
  private var advertisingSet: AdvertisingSet? = null
  private var advertisingSetCallback: AdvertisingSetCallback? = null
  private var scanCallback: ScanCallback? = null
  private var gattServer: BluetoothGattServer? = null
  private val gattTried = HashMap<String, Long>()
  private val gattInFlight = HashSet<String>()

  /**
   * THE RADIO WORLD A PASSIVE READ WAS OPENED IN (row 116, the Android twin
   * of CrewBeacon.swift's PassiveConnect).
   *
   * `onAdapterOff` clears `gattInFlight` because connections died with the
   * hardware — but the OS keeps delivering their callbacks afterwards, and
   * the per-connect `finish` runnable removes by ADDRESS. An address is a
   * name that outlives the connection: after the bounce, a fresh connect to
   * X takes a slot in the cap, then the pre-bounce finish for X runs and
   * removes it, and the two facts the cap is made of stop agreeing. Bumped
   * on every radio-scope retirement; a finish from an older world logs and
   * clears nothing. Guarded by `gattTried`, the lock the set already uses.
   */
  private var radioGeneration = 0

  /**
   * THE RETIREMENT GENERATION FOR THE RESPONSE PATH (row 123, blocker 2).
   *
   * A GATT read copies its bytes under `syncLock`, RELEASES the lock, and
   * only then hands them to `sendResponse` — because a bridge emit and a
   * BluetoothGattServer call must not run under a mutex the server's own
   * callbacks take. That gap is a real interleaving: R copies session A's
   * frame, `endSession` acquires the lock, clears the buffers and resolves
   * its promise, and R then emits A's bytes to a central after JS was told
   * the session was over. The buffers being empty is no help — R is holding
   * a COPY.
   *
   * So the copy carries the generation it was taken under, and the send
   * re-checks it under the lock immediately before it emits. A response
   * whose world ended between copy and send is refused with the protocol's
   * own not-ready frame rather than served. Guarded by `syncLock`.
   */
  private var retireGen = 0

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
   * THE SERVING SCOPE — is there an offer to serve at all, and whose?
   *
   * WHAT AN UNSET DIGEST USED TO SAY. frameFor() answers an empty buffer as
   * a COMPLETE one-frame stream with an empty body, and a central reads that
   * as the finished sentence "this phone carries nothing". So every window
   * between the server opening and JS's first publish landing was a window
   * in which a podmate asked and was confidently told there was no mail —
   * and went away satisfied. The window is real: the server opens with the
   * advertiser, and a background bounce re-opens it before the new session's
   * first digest has crossed the bridge.
   *
   * So the characteristic is NOT READABLE until an offer for the current
   * session has been installed. Not-ready is not a new protocol: total=0 is
   * exactly what the MSG_CHAR already answers while JS is still assembling,
   * and every central retries it (NOT_READY_RETRY_MS). "Ask again in a
   * moment" and "I have nothing" are different sentences, and only one of
   * them was being said.
   *
   * AND AN OFFER CARRIES WHOSE IT IS. `digestEpoch` is the JS mesh session
   * that published it and `digestRev` is that session's own monotonic
   * revision, so a publish that lands late — from a session that has already
   * ended, or out of order behind a newer one — is REFUSED rather than
   * installed over the live offer. Both are cleared by endSession, which is
   * what makes a stopped session serve nothing at all instead of serving its
   * last offer forever.
   */
  private var digestReady = false
  private var digestEpoch = -1L
  private var digestRev = -1L

  /**
   * ONE CENTRAL'S OUTSTANDING WANTS, oldest first — the correlation that
   * keeps a late answer from filling the wrong request.
   *
   * The round trip is: the central's want frames assemble here, native emits
   * CrewSyncWant, JS computes the rows, JS calls provideSyncMessages. That
   * middle step is a bridge hop, and a central can write a SECOND want
   * before the first answer comes back — a reconnect, or simply a peer
   * running its two-pass sync again. The answer arriving then filled the
   * buffer the central was about to read as the answer to its NEWER want:
   * rows chosen for a request nobody made any more.
   *
   * A ticket is pushed when the want is handed to JS, and the answer NAMES
   * the ticket it is for: `requestId` rides the event up and comes back down
   * with the bytes, so the match is EXACT rather than positional. It was
   * positional — pop the oldest — which reads as the same thing only while
   * every want is answered, in order, by a session that is still alive. It
   * is not the same thing at all when a session ends between the ask and the
   * answer: the pop consumed whatever ticket happened to be first, so a
   * delayed answer to a want this phone no longer has open filled the ticket
   * of the NEXT want from the SAME central. Same peer, different question,
   * and the answer had nothing on it to say so.
   *
   * An answer whose ticket is not the NEWEST is a late one and is REFUSED —
   * the newer answer is still coming, and the central's own retry loop
   * covers the gap. An answer whose ticket was minted under a scope that has
   * since been cleared is refused for the same reason: it was built against
   * an offer this phone no longer makes.
   */
  private class WantTicket(val id: Long, val epoch: Long, val rev: Long)

  /**
   * THE OFFER A CENTRAL ACTUALLY READ — the scope a ticket is minted
   * against, recorded at the moment that central provably holds the whole
   * digest (the last frame handed over in onCharacteristicReadRequest).
   *
   * WHY A RECORD AND NOT THE GLOBALS. The ticket's epoch/rev used to be
   * stamped at want COMPLETION from whatever this phone published right
   * then, and nothing on the WANT wire carries a scope either. So a central
   * that completed digest A, watched this phone end/start/publish B, and
   * then wrote its A-derived want had that want stamped B — after which
   * every check agreed with itself: exact request, current epoch, current
   * rev, and JS echoing B. The stated M5/M6 invariant ("the offer the ask
   * was built against") was simply false, and a stale A request was served
   * as a B one. Current-crew filtering in JS bounds the disclosure; it does
   * not make the invariant true.
   *
   * `generation` rides beside (epoch, rev) because the counterexample is not
   * only a session restart. pushDigest fires on every message-store change,
   * so a SAME-EPOCH, NEW-REV republish is the common case — and the
   * unscoped setSyncDigest twin bumps the generation while touching neither.
   */
  /**
   * AND THE PER-CENTRAL RECORD IS GONE (row 120). It used to live here and
   * be the authority for the paragraph above. It cannot be: the client's
   * second pass re-reads the digest before it writes the want, so by the
   * time a want lands the record names whatever this phone published most
   * recently — which is exactly what the check compares it to.
   *
   * DELETED RATHER THAN DEMOTED TO DIAGNOSTICS. A weaker second copy of a
   * fact the wire now carries is a copy a future edit re-promotes, and every
   * retirement road would still have to remember to clear it. Nothing is
   * lost: only the digest stream carries a live (epoch, rev, generation)
   * triple, so a want that NAMES the live offer is a want from a central
   * that read it — strictly stronger evidence than the record ever was.
   */

  // A plain ArrayList with explicit index ops rather than a deque: this
  // module is compiled by whatever AGP/Kotlin pair the release lane is on,
  // and removeFirst()/removeLast() are exactly the names that collide with
  // Java 21's SequencedCollection members on some of those pairs. The queue
  // is at most four entries; there is nothing to gain by being clever.
  private val wantTickets = HashMap<String, MutableList<WantTicket>>()

  /** Monotonic over the PROCESS, never reset: a reset would let a new
   * session mint an id that a dead session's answer is still carrying. */
  private var wantTicketSeq = 0L

  /** EVERY TICKET ID AT OR BELOW THIS IS DEAD FOREVER — the stop watermark.
   *
   * Dropping the outstanding tickets is not enough on its own. It makes the
   * next reply UNSOLICITED, which is refused, but only until the same
   * central asks again: then there IS a ticket, and before the ids were
   * matched exactly the delayed reply took it. The line makes the refusal a
   * property of the ID rather than of what happens to be outstanding, so a
   * reply that has been sitting on the bridge since before a stop can never
   * install into the session that replaced it — whatever central it names,
   * however many sessions have opened since. */
  private var wantInvalidBefore = 0L

  /** A central cannot bank more outstanding requests than this; past it the
   * oldest is dropped, because a peer that writes wants faster than it reads
   * answers is broken or hostile, not a pod. */
  private val maxOutstandingWants = 4

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
  /**
   * THE OWNER RECORD, AND ITS LOCK — the cure for the syncBusy race
   * (cross-family review, 2026-08-27).
   *
   * WHAT WAS THERE. `syncBusy` was acquired under `synchronized(this)` and
   * CLEARED from three unsynchronized places on three different threads: the
   * GATT callbacks arrive on a Binder thread, the timeout runnable on the
   * main looper, and the reject paths on the RN method thread. The `done`
   * terminal check-and-set was unsynchronized too, so two terminals could
   * both pass `if (done)` and both proceed.
   *
   * THE LEGAL TRACE THAT BREAKS IT, and it needs no exotic scheduling:
   *
   *   1. the 60 s timeout fires on main and enters fail();
   *   2. the final read lands on a Binder thread and enters finishOk();
   *      both read done == false, both set it true, both continue;
   *   3. the first one out clears syncBusy — sync A is over;
   *   4. sync B is admitted (syncBusy = true) and starts;
   *   5. the SECOND terminal, still unwinding from step 2, clears syncBusy
   *      again — B's own latch, cleared by A's leftover;
   *   6. sync C is admitted while B still holds the radio, and the module's
   *      one-at-a-time invariant — the whole reason the latch exists — is
   *      gone. Two connected GATT clients, interleaved reads, and a JS layer
   *      whose arbiter believes one op is outstanding.
   *
   * A volatile Boolean does not fix this. Volatility makes each read and
   * write visible; it does not make check-then-set atomic, and it cannot
   * express "clear it only if it is still MINE" — which is the actual rule.
   *
   * SO THE LATCH IS AN OWNER RECORD UNDER ONE LOCK. `syncOwner` names the
   * exact SyncClient that holds the radio and `syncOpId` is its identity;
   * admission, the terminal check-and-set, and the clear all happen inside
   * `syncOwnerLock`, and the clear is conditional on the owner still being
   * THIS op. A late terminal from a dead op finds a record that is not its
   * own, logs it, and clears nothing.
   *
   * Nothing that crosses the bridge or touches the radio happens inside the
   * lock — the same rule syncLock already keeps for the server state: the
   * terminal decides ownership under the lock and settles the promise,
   * removes its timeout and closes the GATT outside it.
   */
  private val syncOwnerLock = Any()
  private var syncOwner: SyncClient? = null
  private var syncOpSeq = 0L

  /**
   * Tear down whatever operation holds the radio, if any. The victim is
   * READ under the lock and cancelled OUTSIDE it: the cancel runs the
   * client's ordinary failure terminal, which takes the same lock to claim
   * itself, and taking it twice from one thread would be a re-entrant hold
   * on a lock other threads' callbacks are queued behind.
   */
  private fun cancelSyncOwner(why: String) {
    val victim = synchronized(syncOwnerLock) { syncOwner }
    if (victim == null) {
      log("sync//cancel-none why=\"$why\"")
      return
    }
    victim.cancel(why)
  }

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
    log(
      "adapter//off wasAdvertising=$advertising wasScanning=$scanning " +
        "syncOpId=${synchronized(syncOwnerLock) { syncOwner?.opId ?: 0L }}",
    )
    // Deliberately NOT calling stopAdvertising/stopScan: the adapter is
    // gone, its handles throw, and the OS has already stopped both. Drop
    // what is now stale so that a later restart is a REAL restart.
    advertiseCallback = null
    advertisingSet = null
    advertisingSetCallback = null
    scanCallback = null
    advertising = false
    scanning = false
    stopGattServer() // a server on a dead adapter serves nobody
    synchronized(gattTried) {
      // Connections died with the adapter; without this the in-flight cap
      // would still be full after the bounce and no peer could be read.
      gattInFlight.clear()
      // …AND THEIR LATE CALLBACKS ARE INADMISSIBLE FROM HERE (row 116). The
      // OS keeps delivering callbacks for connections the bounce killed, and
      // each carries a `finish` that removes BY ADDRESS — which after the
      // bounce is the address of somebody else's live slot.
      radioGeneration += 1
      log("adapter//off radioGeneration=$radioGeneration inFlight=cleared")
    }
    // The sync op died with the adapter too, and its own callbacks may never
    // arrive to say so: without this its claim on the radio outlives the
    // hardware that was holding it, and every later dial is answered 'busy'
    // until the 60-second timeout that nobody is waiting for.
    cancelSyncOwner("adapter off")
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
    if (advertising) {
      main.post {
        val set = advertisingSet
        if (set != null) {
          // THE ROOT CURE for the address-rotation class (field sweep X5's
          // cause): an AdvertisingSet updates its data IN PLACE, no stop,
          // no start, no new random address. The payload rides the scan
          // response, so that is the half we swap. Failures surface in the
          // set callback's onScanResponseDataSet status; a set that has
          // died is dropped there and the next refresh restarts cleanly.
          try {
            log("advertise//payload-inplace bytes=${payload.size}")
            set.setScanResponseData(
              AdvertiseData.Builder()
                .addManufacturerData(MANUFACTURER_ID, payload)
                .build(),
            )
            promise.resolve(null)
          } catch (e: Exception) {
            // The set handle outlived its adapter — fall back to a full
            // restart, which re-checks everything from the top.
            log("advertise//payload-inplace err=${e.javaClass.simpleName} fallback=restart")
            advertisingSet = null
            stopAdvertisingInternal(keepServer = true)
            startAdvertisingInternal(promise)
          }
        } else {
          // Legacy advertiser (API < 26): an advertisement is immutable, a
          // payload change restarts it — and mints a new address, which
          // the meshSync freshness gate exists to survive.
          log("advertise//payload-restart bytes=${payload.size}")
          stopAdvertisingInternal(keepServer = true)
          startAdvertisingInternal(promise)
        }
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
      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(SERVICE_UUID))
        .build()
      val scanResponse = AdvertiseData.Builder()
        .addManufacturerData(MANUFACTURER_ID, payload)
        .build()
      // The primary packet carries the service UUID; the payload rides the
      // scan response as manufacturer data. Both sizes matter at 31 bytes.
      log(
        "advertise//start uuid=service primary=uuid-only " +
          "scanRsp=mfr:0x${MANUFACTURER_ID.toString(16)}:${payload.size}B connectable=true",
      )
      if (android.os.Build.VERSION.SDK_INT >= 26) {
        // THE SET PATH, and the reason it exists: a set's data updates in
        // place (setPayload above), so a payload change no longer restarts
        // the advertisement — and no longer mints a fresh random address
        // four times a minute. LEGACY MODE is load-bearing, not a nicety:
        // it keeps the wire format ADV_IND + SCAN_RSP, exactly what every
        // peer's scanner — including iOS CoreBluetooth and pre-extended
        // Android handsets — already parses. Extended advertising would be
        // invisible to the phones this app most needs to reach.
        val params = AdvertisingSetParameters.Builder()
          .setLegacyMode(true)
          .setConnectable(true) // GATT read + sync paths need connectable
          .setScannable(true) // legacy connectable is scannable; explicit
          .setInterval(AdvertisingSetParameters.INTERVAL_MEDIUM)
          .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
          .build()
        val cb = object : AdvertisingSetCallback() {
          override fun onAdvertisingSetStarted(
            set: AdvertisingSet?,
            txPower: Int,
            status: Int,
          ) {
            if (status == ADVERTISE_SUCCESS && set != null) {
              advertisingSet = set
              advertising = true
              // Same line the field-log greps have always keyed on; the
              // set marker rides behind it rather than replacing it.
              log("advertise//started mode=set tx=$txPower connectable=true")
              emitState()
              promise?.resolve(null)
            } else {
              advertising = false
              advertisingSet = null
              log("advertise//failed code=$status reason=${advErrName(status)} scanRspBytes=${payload.size}")
              emitState("advertise failed ($status)")
              promise?.reject("advertise", "start failed ($status)")
            }
          }

          override fun onAdvertisingSetStopped(set: AdvertisingSet?) {
            // The OS tore the set down (adapter cycled, resources
            // reclaimed). Drop the handle so the next payload change falls
            // back to a clean restart instead of poking a corpse.
            advertisingSet = null
          }

          override fun onScanResponseDataSet(set: AdvertisingSet?, status: Int) {
            if (status != ADVERTISE_SUCCESS) {
              // An in-place update failed — DATA_TOO_LARGE is the live
              // suspect (the payload outgrew the 31-byte scan response).
              // The advertisement is still on the air with the PREVIOUS
              // payload, so say so loudly rather than letting a stale
              // position broadcast read as fresh.
              log("advertise//payload-inplace failed code=$status reason=${advErrName(status)} scanRspBytes=${payload.size}")
              emitState("advertise payload update failed ($status)")
            }
          }
        }
        advertisingSetCallback = cb
        advertiser.startAdvertisingSet(params, data, scanResponse, null, null, cb)
      } else {
        val settings = AdvertiseSettings.Builder()
          .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
          .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
          .setConnectable(true) // GATT read + sync paths need connectable
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
        advertiser.startAdvertising(settings, data, scanResponse, cb)
      }
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
      advertisingSetCallback?.let {
        if (android.os.Build.VERSION.SDK_INT >= 26) {
          adapter()?.bluetoothLeAdvertiser?.stopAdvertisingSet(it)
        }
      }
      advertiseCallback?.let { adapter()?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    } catch (_: Exception) {
      // Bluetooth toggled off underneath us — the goal state is reached.
      log("advertise//stop err=exception (adapter gone)")
    }
    advertisingSet = null
    advertisingSetCallback = null
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
  /**
   * THE OFFER IDENTITY, AND WHY IT RIDES THE WIRE (row 120).
   *
   * The exchange is TWO connected passes with a JS round trip between them,
   * and pass 2 ALWAYS re-reads the digest before it writes the want. So the
   * per-central "offer this central last read" record could never be the
   * authority it claimed: JS derives ids from offer A, this phone publishes
   * B in the gap, pass 2's own reread records B, and the A-derived want is
   * minted, stamped and served as a B one with every check green. Sequential
   * passes are enough; no concurrency is needed to reach it.
   *
   * The cure is that the ASK CARRIES THE OFFER IT WAS DERIVED FROM. Two
   * fixed-width wire additions, mirrored byte for byte in CrewBeacon.swift:
   *
   *  - a DIGEST frame whose total is non-zero carries this block between the
   *    4-byte [seq][total] header and its chunk, so a client learns the
   *    identity of the offer it is assembling FROM that offer;
   *  - a WANT payload begins with the same block, so the identity JS derived
   *    its ids from is the identity this server matches against what it
   *    publishes now.
   *
   * A not-ready digest frame (total = 0) stays the bare four bytes it always
   * was: there is no offer to name, and both clients read seq/total first.
   *
   * [epoch: 8 big-endian][rev: 8 big-endian][generation: 4 big-endian].
   */
  private fun putBE32(out: ByteArray, at: Int, v: Int) {
    out[at] = ((v ushr 24) and 0xFF).toByte()
    out[at + 1] = ((v ushr 16) and 0xFF).toByte()
    out[at + 2] = ((v ushr 8) and 0xFF).toByte()
    out[at + 3] = (v and 0xFF).toByte()
  }

  private fun putBE64(out: ByteArray, at: Int, v: Long) {
    putBE32(out, at, (v ushr 32).toInt())
    putBE32(out, at + 4, v.toInt())
  }

  private fun readBE32(b: ByteArray, at: Int): Int =
    ((b[at].toInt() and 0xFF) shl 24) or ((b[at + 1].toInt() and 0xFF) shl 16) or
      ((b[at + 2].toInt() and 0xFF) shl 8) or (b[at + 3].toInt() and 0xFF)

  private fun readBE64(b: ByteArray, at: Int): Long =
    ((readBE32(b, at).toLong() and 0xFFFF_FFFFL) shl 32) or
      (readBE32(b, at + 4).toLong() and 0xFFFF_FFFFL)

  private fun offerIdentityBlock(epoch: Long, rev: Long, generation: Int): ByteArray {
    val out = ByteArray(OFFER_IDENTITY_BYTES)
    putBE64(out, 0, epoch)
    putBE64(out, 8, rev)
    putBE32(out, 16, generation)
    return out
  }

  /** A digest frame: the ordinary frame with the live offer identity
   * spliced in behind the header. Caller holds syncLock. */
  private fun digestFrameFor(buf: ByteArray?, cursor: Int): ByteArray {
    val f = frameFor(buf, cursor)
    val total = ((f[2].toInt() and 0xFF) shl 8) or (f[3].toInt() and 0xFF)
    if (total == 0) {
      return f
    }
    val out = ByteArray(f.size + OFFER_IDENTITY_BYTES)
    f.copyInto(out, 0, 0, 4)
    offerIdentityBlock(digestEpoch, digestRev, digestGeneration).copyInto(out, 4)
    f.copyInto(out, 4 + OFFER_IDENTITY_BYTES, 4, f.size)
    return out
  }

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
    wantTickets.remove(addr)
    preparedWrites.remove(addr)
    log("gatt-server//free addr=$addr bytes=$bytes tracked=${centralSeen.size}")
  }

  /**
   * A completed want, with the identity of the REQUEST it is. The id and
   * the epoch ride the event to JS (M6's want/response scope) and are what
   * the answer is matched against when it comes back.
   */
  private class ReadyWant(
    val bytes: ByteArray,
    val requestId: Long,
    val serverEpoch: Long,
  )

  /**
   * One WANT frame, however it reached us — a short write that fits the
   * MTU, or a prepared (long) write assembled in onExecuteWrite. Returns
   * the completed want when this frame closed the stream, otherwise null;
   * the caller emits to JS AFTER releasing syncLock. Caller holds it.
   */
  private fun handleWantFrame(addr: String, value: ByteArray): ReadyWant? {
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
    // THE ASK IS MINTED AGAINST THE OFFER IT NAMES, or it is not minted at
    // all. The want payload begins with the identity JS held beside the ids
    // it derived from that exact digest read (offerIdentityBlock), and that
    // is what this compares against what this phone publishes NOW. B may be
    // a new session OR a same-epoch republish; both move the live identity
    // and both refuse here.
    //
    // THE REFUSAL IS THE RETRY ROAD. No ticket is minted and no want reaches
    // JS, so this central's next MSG_CHAR read is answered with the
    // not-ready frame (total=0) and its client re-runs the exchange from the
    // digest — reading offer B, deriving under B, and naming it.
    val full = sink.toByteArray()
    if (full.size < OFFER_IDENTITY_BYTES) {
      // Not an ask this phone can attribute to any offer. Fail-closed, by
      // the same road a stale one takes.
      log(
        "gatt-server//want-drop addr=$addr bytes=${full.size} " +
          "reason=no-offer-identity",
      )
      return null
    }
    val askedEpoch = readBE64(full, 0)
    val askedRev = readBE64(full, 8)
    val askedGen = readBE32(full, 16)
    if (askedEpoch != digestEpoch || askedRev != digestRev || askedGen != digestGeneration) {
      log(
        "gatt-server//want-drop addr=$addr reason=stale-offer " +
          "askedEpoch=$askedEpoch askedRev=$askedRev askedGen=$askedGen " +
          "epoch=$digestEpoch rev=$digestRev gen=$digestGeneration",
      )
      return null
    }
    val ids = full.copyOfRange(OFFER_IDENTITY_BYTES, full.size)
    // AND A TICKET, so the answer can be matched to the request. See
    // wantTickets: without it a late answer to an earlier want fills the
    // buffer the central is about to read as the answer to this one.
    wantTicketSeq += 1
    val tickets = wantTickets.getOrPut(addr) { ArrayList() }
    // …stamped from the CARRIED identity rather than from the globals. They
    // are equal here by the guard above, and writing it this way is what
    // keeps them equal: a future edit that loosens the guard cannot silently
    // go back to stamping whatever this phone happens to publish now.
    tickets.add(WantTicket(wantTicketSeq, askedEpoch, askedRev))
    while (tickets.size > maxOutstandingWants) {
      val dropped = tickets.removeAt(0)
      log("gatt-server//want-drop addr=$addr requestId=${dropped.id} reason=too-many-outstanding")
    }
    log(
      "gatt-server//want-complete addr=$addr bytes=${ids.size} " +
        "requestId=$wantTicketSeq serverEpoch=$digestEpoch handoff=js",
    )
    return ReadyWant(ids, wantTicketSeq, digestEpoch)
  }

  /**
   * The CrewSyncWant payload. It carries the REQUEST's identity beside the
   * bytes — `requestId` and `serverEpoch` — so the JS side can echo the scope
   * it answered under once radio.ts forwards them (see the lane report's
   * handoff). Native already matches the answer by arrival order; these are
   * what let that match be exact rather than positional.
   */
  private fun wantEvent(
    addr: String,
    ready: ReadyWant,
  ): com.facebook.react.bridge.WritableMap {
    val m = Arguments.createMap()
    m.putString("peerId", addr)
    m.putString("payload", Base64.encodeToString(ready.bytes, Base64.NO_WRAP))
    m.putDouble("requestId", ready.requestId.toDouble())
    m.putDouble("serverEpoch", ready.serverEpoch.toDouble())
    return m
  }

  /** Where this answer's request sits in the central's queue, or -1 when
   * this phone has no such request open for it. EXACT, by id: never "the
   * oldest", which is how one central's delayed answer used to consume the
   * ticket of its own next question. Caller holds syncLock. */
  private fun wantTicketIndex(addr: String, requestId: Long): Int {
    val tickets = wantTickets[addr] ?: return -1
    return tickets.indexOfFirst { it.id == requestId }
  }

  /** Drop one ticket by index, and the central's whole entry once it is
   * empty. Caller holds syncLock. */
  private fun dropWantTicket(addr: String, at: Int) {
    val tickets = wantTickets[addr] ?: return
    tickets.removeAt(at)
    if (tickets.isEmpty()) {
      wantTickets.remove(addr)
    }
  }

  /**
   * EVERY OUTSTANDING REQUEST DIES HERE, AND STAYS DEAD — the stop verbs'
   * shared line (stopGattServer, endSession), and the reason the watermark
   * exists rather than a bare clear. Caller holds syncLock.
   */
  private fun invalidateWantTickets() {
    wantInvalidBefore = wantTicketSeq
    wantTickets.clear()
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
          // Set when this read hands over the LAST digest frame — the
          // moment the central provably holds our whole offer. Emitted
          // below, after the response and outside syncLock (bridge rule).
          var digestServed = false
          // THE GENERATION THIS RESPONSE'S BYTES WERE COPIED UNDER (row 123,
          // blocker 2). Taken inside the SAME critical section as the copy,
          // and re-checked under the lock immediately before the send: what
          // happens in between is `endSession` clearing the buffers and
          // resolving its promise, and the copy in hand is the thing that
          // clear cannot reach. -1 means "no copy was taken" (the
          // unknown-characteristic road, which answers a failure anyway).
          var respGen = -1
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
              respGen = synchronized(syncLock) { retireGen }
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
              respGen = retireGen
              if (offset == 0 && !digestReady) {
                // NOT READY, WHICH IS NOT "NOTHING". No offer for the
                // current session has been installed and acked yet, so the
                // only honest answer is the retry frame — serving the empty
                // buffer here is a complete, confident "this phone carries
                // no mail", said to a podmate holding a phone that does.
                log(
                  "gatt-server//digest-notready addr=$addr epoch=$digestEpoch " +
                    "rev=$digestRev reason=no-offer-installed",
                )
                trackCentral(addr)
                digestFrame[addr] = byteArrayOf(0, 0, 0, 0)
              } else if (offset == 0) {
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
                // THE FRAME NAMES THE OFFER IT IS A FRAME OF (row 120): the
                // client has no other place to learn the identity it must
                // carry back on the want, and taking it from the frame means
                // it is the identity of the bytes it actually assembled.
                val f = digestFrameFor(syncDigest, cur)
                digestFrame[addr] = f
                val total = ((f[2].toInt() and 0xFF) shl 8) or (f[3].toInt() and 0xFF)
                digestCursor[addr] = if (cur + 1 >= total) 0 else cur + 1
                // Building the final frame = this central is completing a
                // digest pull. One event per completed pull (offset-0 build
                // only, so MTU continuations never double-fire it).
                digestServed = cur + 1 >= total
                if (digestServed) {
                  // …AND THE SCOPE IT COMPLETED UNDER IS RECORDED HERE, at
                  // the handover of the last frame — the one moment this
                  // phone knows WHICH offer that central is holding. A want
                  // it writes later is minted only while this record is
                  // still the offer we publish (handleWantFrame); nothing on
                  // the WANT wire carries the scope, so this record is the
                  // only place the invariant can live.
                }
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
              respGen = retireGen
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
          // THE CHECK AND THE SEND ARE ONE RETIREMENT-ATOMIC TERMINAL.
          //
          // WHAT THIS USED TO BE was check-then-send: the generation was
          // read under `syncLock`, the lock was RELEASED, and only then did
          // the response go out. The window that leaves is exact and is the
          // whole finding — R reads `retireGen` and sees its own; E enters
          // `endSession`, bumps the generation, clears the buffers and
          // resolves its promise; R then sends session A's mail to a central
          // that the app has already told JS is out of the pod. Re-checking
          // outside the lock cannot close a race the lock exists for: a
          // compare that releases before it acts is the same check-then-set
          // this module's owner record already refused.
          //
          // SO THE SEND HAPPENS UNDER THE LOCK, and that is safe here for a
          // stated reason rather than a hopeful one:
          // `BluetoothGattServer.sendResponse` is an asynchronous binder
          // call into the Bluetooth stack — it dispatches and returns, and
          // this callback class's own methods are delivered later on a
          // binder thread. It cannot re-enter `syncLock` from inside itself,
          // so holding the lock across it is bounded by an IPC dispatch and
          // not by a peer's behaviour.
          //
          // WHAT STAYS OUTSIDE is the bridge emit. That rule is unchanged
          // and is why `dialable` is carried out of the block rather than
          // sent from inside it.
          var servedDialable = false
          try {
            synchronized(syncLock) {
              val server = gattServer
              val retiredSinceCopy = respGen >= 0 && retireGen != respGen
              if (server == null) {
                // No response at all: the central waits out its own timeout.
                log(
                  "gatt-server//read-drop addr=$addr char=$role offset=$offset " +
                    "bytes=${value.size} reason=server-null answer=none",
                )
              } else if (retiredSinceCopy) {
                // The refusal is the protocol's own not-ready frame for the
                // session-scoped characteristics — which the reading client
                // already knows how to retry — and empty bytes for the
                // payload, never the copy in hand.
                val notReady = byteArrayOf(0, 0, 0, 0)
                val refusal = when {
                  characteristic.uuid == PAYLOAD_CHAR -> ByteArray(0)
                  offset >= notReady.size -> ByteArray(0)
                  else -> notReady.copyOfRange(offset, notReady.size)
                }
                log(
                  "gatt-server//read-refuse addr=$addr char=$role offset=$offset " +
                    "copiedBytes=${value.size} copyGen=$respGen reason=retired-since-copy",
                )
                server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, refusal)
              } else {
                server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                log("gatt-server//read-ok addr=$addr char=$role offset=$offset bytes=${value.size}")
                servedDialable = digestServed
              }
            }
            if (servedDialable) {
              // The peer that just pulled our digest is alive and in
              // range RIGHT NOW; JS dials back on this instead of
              // waiting out a cooldown (the delivery-latency fix,
              // 2026-08-25). After the response so the read is never
              // delayed by the bridge, and OUTSIDE syncLock.
              log("sync-server//digest-served addr=$addr dialable=1")
              val m = Arguments.createMap()
              m.putString("peerId", addr)
              // AND IT IS A ROUTE, NOT JUST A CUE. On this platform the
              // name a GATT server knows a central by is its BLE address
              // — the same address space the scanner reports and
              // syncWithPeer dials. That matters for a peer this phone
              // cannot DISCOVER: an iPhone with the walkie open holds its
              // crew beacon off the air (share.ts), so a scan never sees
              // it, and this address is the only route to its mailbox.
              // iOS says false here: its CBCentral identifier is not the
              // peripheral identifier a dial would need.
              m.putBoolean("dialable", true)
              emit(SYNC_SERVED_EVENT, m)
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
              emit(SYNC_WANT_EVENT, wantEvent(addr, ready))
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
            var out: ReadyWant? = null
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
            emit(SYNC_WANT_EVENT, wantEvent(addr, ready))
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
      // THE RETIREMENT MOVES, so any response already copied out of these
      // buffers is refused at its send (see retireGen).
      retireGen += 1
      log("gatt-server//free-all tracked=${centralSeen.size} retireGen=$retireGen")
      centralSeen.clear()
      digestCursor.clear()
      digestStreamGen.clear()
      msgCursor.clear()
      msgBuffers.clear()
      wantAssembly.clear()
      // …AND THE OPEN QUESTIONS, permanently. The buffers above are what a
      // central could still READ; the tickets are what JS could still FILL,
      // and a reply already on the bridge outlives the server that asked
      // for it. The watermark is what makes that refusal survive the next
      // server, which the bare clear did not.
      invalidateWantTickets()
      digestFrame.clear()
      msgFrame.clear()
      preparedWrites.clear()
      // The server is closed, so the offer it was serving is withdrawn: a
      // reopened server must not answer from a digest published for a
      // session that has since gone.
      digestReady = false
    }
  }

  /**
   * JS keeps the served digest current on every message-store change — the
   * UNSCOPED form, kept for a JS build (or an iOS module) that does not yet
   * carry the session with its offer. It installs unconditionally, exactly
   * as it always did, and marks the service readable.
   */
  @ReactMethod
  fun setSyncDigest(b64: String, promise: Promise) {
    installDigest(b64, null, null, promise)
  }

  /**
   * THE SCOPED PUBLISH: this offer belongs to mesh session `radioEpoch` and
   * is that session's revision `digestRevision`.
   *
   * A publish is installed only when it is strictly NEWER than what is held
   * — a later epoch, or a later revision inside the same epoch. That refusal
   * is the point: pushDigest runs on every store change, so several can be
   * in flight at once and one of them can belong to a session that has
   * already ended. Installed, it becomes this phone's offer to the whole
   * pod until the next store change happens along.
   *
   * The promise IS the ACK — JS records nothing as installed until it
   * resolves, and the digest characteristic answers "not ready" until then.
   */
  @ReactMethod
  fun publishSyncDigest(
    b64: String,
    radioEpoch: Double,
    digestRevision: Double,
    promise: Promise,
  ) {
    installDigest(b64, radioEpoch.toLong(), digestRevision.toLong(), promise)
  }

  private fun installDigest(
    b64: String,
    epoch: Long?,
    rev: Long?,
    promise: Promise,
  ) {
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
    val stale = synchronized(syncLock) {
      if (epoch != null && rev != null && !newerThanInstalled(epoch, rev)) {
        log(
          "sync-server//digest-reject reason=stale-publish epoch=$epoch rev=$rev " +
            "heldEpoch=$digestEpoch heldRev=$digestRev",
        )
        true
      } else {
        syncDigest = decoded
        digestGeneration++
        digestReady = true
        if (epoch != null && rev != null) {
          digestEpoch = epoch
          digestRev = rev
        }
        log(
          "sync-server//digest bytes=${syncDigest.size} gen=$digestGeneration " +
            "epoch=$digestEpoch rev=$digestRev tracked=${centralSeen.size} " +
            "framesKept=${digestFrame.size}",
        )
        false
      }
    }
    if (stale) {
      // REJECTED, not silently dropped: JS must not record a stale offer as
      // the installed one, and a promise that resolved would say it did.
      promise.reject("stale", "a newer digest is already published")
      return
    }
    promise.resolve(null)
  }

  /** Strictly newer, lexicographically by (epoch, revision). Caller holds
   * syncLock. */
  private fun newerThanInstalled(epoch: Long, rev: Long): Boolean =
    epoch > digestEpoch || (epoch == digestEpoch && rev > digestRev)

  /**
   * JS answers a CrewSyncWant with the assembled message bytes for that
   * central; the MSG_CHAR stream serves it out in frames.
   *
   * THE ANSWER IS MATCHED TO ITS REQUEST BY NAME, and refused when it
   * cannot be. `requestId` is the ticket this answer is for and `serverEpoch`
   * the offer it was built against — both came up with the want and both
   * come back here, so the match is exact rather than positional. Four
   * refusals, and each of them served the wrong bytes before:
   *
   *   INVALIDATED — the id is at or below the stop watermark. A session
   *     ended (or the server closed) after this want was handed up, so this
   *     reply belongs to a pod that no longer exists. Permanent: ids only go
   *     up, so this never becomes true again for a live request. Without it,
   *     dropping the tickets was enough only until the same central asked
   *     again — and then the delayed reply took the new question's ticket.
   *   UNSOLICITED — no such want is open for this central. Nothing asked, so
   *     nothing is served: a buffer written here would be read by the next
   *     want as its own answer.
   *   SUPERSEDED  — the ticket this answer names is not the newest one. The
   *     central wrote again while JS was computing, so these rows were
   *     chosen for a request that no longer exists; the newer answer is
   *     still coming, and the central's own retry loop covers the gap.
   *   OUT OF SCOPE— the ticket was minted under a digest scope this phone no
   *     longer publishes (a session ended, or a newer offer replaced it), or
   *     the answer names an epoch that is not the live one. The want was
   *     built from an offer we have withdrawn.
   *
   * The reason is RESOLVED to JS, not merely logged: meshSync records it
   * against the want, so a want that went unserved is a line somebody can
   * read rather than a silence. Refusing is always safe here BECAUSE of the
   * not-ready protocol: an unanswered MSG_CHAR read gets total=0 and the
   * central retries.
   */
  @ReactMethod
  fun provideSyncMessages(
    peerId: String,
    requestId: Double,
    serverEpoch: Double,
    b64: String,
    promise: Promise,
  ) {
    val bytes = try {
      Base64.decode(b64, Base64.NO_WRAP)
    } catch (e: Exception) {
      log("sync-server//provide-reject addr=$peerId reason=not-base64")
      promise.reject("payload", "messages are not base64")
      return
    }
    // JS numbers cross the bridge as doubles; both values are counters well
    // inside the exactly-representable range.
    val askedId = requestId.toLong()
    val askedEpoch = serverEpoch.toLong()
    val refusal = synchronized(syncLock) {
      val at = wantTicketIndex(peerId, askedId)
      val tickets = wantTickets[peerId]
      when {
        askedId <= wantInvalidBefore -> "invalidated"
        at < 0 || tickets == null -> "unsolicited"
        at != tickets.size - 1 -> {
          dropWantTicket(peerId, at)
          "superseded"
        }
        tickets[at].epoch != digestEpoch ||
          tickets[at].rev != digestRev ||
          askedEpoch != digestEpoch -> {
          dropWantTicket(peerId, at)
          "out-of-scope"
        }
        else -> {
          val ticket = tickets[at]
          // ONE ANSWER PER REQUEST, and the older asks go with it: they can
          // only ever be superseded now, and a queue that is never emptied
          // is a queue that grows.
          wantTickets.remove(peerId)
          trackCentral(peerId)
          msgBuffers[peerId] = bytes
          msgCursor[peerId] = 0
          msgFrame.remove(peerId) // new stream: never continue an old frame
          log(
            "sync-server//provide addr=$peerId bytes=${bytes.size} " +
              "requestId=${ticket.id} serverEpoch=${ticket.epoch}",
          )
          null
        }
      }
    }
    if (refusal != null) {
      log(
        "sync-server//provide-drop addr=$peerId bytes=${bytes.size} " +
          "requestId=$askedId serverEpoch=$askedEpoch reason=$refusal",
      )
    }
    promise.resolve(refusal)
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
    startScanInternal(promise)
  }

  /**
   * FOREGROUND FAST PATH (field report 2026-08-25). While the app is on
   * screen JS asks for SCAN_MODE_LOW_LATENCY — the human is watching the
   * pod and seconds matter — and restores BALANCED when it backgrounds.
   * A scan restart, unlike an advertise restart, has no identity cost
   * (scanning owns no address), so the flip is a plain stop/start. The
   * ADVERTISE interval deliberately has no such knob: restarting the set
   * mints a fresh random address and re-opens the rotation wound the
   * AdvertisingSet path closed.
   */
  @ReactMethod
  fun setScanMode(lowLatency: Boolean, promise: Promise) {
    if (scanLowLatency == lowLatency) {
      promise.resolve(null)
      return
    }
    scanLowLatency = lowLatency
    log("scan//mode lowLatency=$lowLatency scanning=$scanning")
    if (!scanning) {
      // Stored posture only; the next startScan reads it.
      promise.resolve(null)
      return
    }
    try {
      scanCallback?.let { adapter()?.bluetoothLeScanner?.stopScan(it) }
    } catch (_: Exception) {
      log("scan//mode err=stop-exception (adapter gone)")
    }
    scanCallback = null
    scanning = false
    startScanInternal(promise)
  }

  /** The scan bring-up, shared by startScan and the posture flip; reads
   * scanLowLatency so the duty cycle is whatever JS last asked for. */
  private fun startScanInternal(promise: Promise?) {
    val scanner = adapter()?.bluetoothLeScanner
    if (scanner == null) {
      log("scan//reject reason=bluetooth-off scanner=false")
      promise?.reject("bluetooth-off", "Bluetooth is off")
      return
    }
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val settings = ScanSettings.Builder()
      .setScanMode(
        if (scanLowLatency) ScanSettings.SCAN_MODE_LOW_LATENCY
        else ScanSettings.SCAN_MODE_BALANCED,
      )
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
      log(
        "scan//start filter=service-uuid mode=" +
          (if (scanLowLatency) "low-latency" else "balanced"),
      )
      emitState()
      promise?.resolve(null)
    } catch (e: SecurityException) {
      log("scan//reject reason=security-exception")
      emitState("permission denied")
      promise?.reject("permission", e.message ?: "denied")
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

  /** The re-read floor for THIS moment. Read at every gate (never cached)
   * so a posture flip takes effect on the very next scan result, the same
   * discipline meshSync.cooldownMs() follows on the JS side. */
  private fun gattCooldownMs(): Long =
    if (scanLowLatency) GATT_COOLDOWN_FOREGROUND_MS else GATT_COOLDOWN_BACKGROUND_MS

  private fun maybeGattRead(device: BluetoothDevice, rssi: Int) {
    val now = System.currentTimeMillis()
    val addr = device.address
    val cooldown = gattCooldownMs()
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
      if (addr in gattInFlight || now - last < cooldown) {
        log(
          "gatt//skip addr=$addr reason=" +
            (if (addr in gattInFlight) "already-in-flight" else "cooldown") +
            " ageMs=${if (last == 0L) -1 else now - last} cooldownMs=$cooldown" +
            " posture=${if (scanLowLatency) "foreground" else "background"}",
        )
        return
      }
      gattTried[addr] = now
      gattInFlight.add(addr)
    }
    // The world this connect belongs to; its finish compares against it.
    val myRadioGen = synchronized(gattTried) { radioGeneration }
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
      synchronized(gattTried) {
        if (radioGeneration != myRadioGen) {
          // A finish from a world the adapter took away. The set was cleared
          // wholesale then; removing by address now would take a slot that
          // belongs to a connect opened after the bounce.
          log("gatt//finish-late addr=$addr gen=$myRadioGen current=$radioGeneration")
        } else {
          gattInFlight.remove(addr)
        }
      }
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
    // PARSE BEFORE CLAIMING. Both of these can refuse, and every early
    // return that had to hand the latch back was one more place the latch
    // could be handed back WRONGLY — the clear was unconditional, so a
    // reject arriving while a later op held the radio cleared that op's
    // claim. Nothing is owned until the admission below, so nothing has to
    // be released here.
    val wantBytes = try {
      if (wantB64.isEmpty()) ByteArray(0) else Base64.decode(wantB64, Base64.NO_WRAP)
    } catch (e: Exception) {
      log("sync//reject addr=$peerId reason=want-not-base64")
      promise.reject("payload", "want is not base64")
      return
    }
    val device = try {
      adapter.getRemoteDevice(peerId)
    } catch (e: Exception) {
      log("sync//reject addr=$peerId reason=unknown-peer-id")
      promise.reject("peer", "unknown peer id")
      return
    }
    // ADMISSION, and it is the same lock the terminal clears under. The
    // client is BUILT here so the record can name the exact object: "the
    // radio is busy" and "which operation has it" are one fact, and the
    // whole defect was storing only the first half.
    val client = synchronized(syncOwnerLock) {
      val held = syncOwner
      if (held != null) {
        // The one-at-a-time mutex. A sync that never releases it strands
        // every later attempt here, so this line is the first place to look
        // when one direction goes quiet — and it now names the op that has
        // the radio, which is what a 3am log needs.
        log("sync//reject addr=$peerId reason=busy ownerOpId=${held.opId} ownerAddr=${held.addr}")
        null
      } else {
        syncOpSeq += 1
        val fresh = SyncClient(device, wantBytes, promise, syncOpSeq)
        syncOwner = fresh
        fresh
      }
    }
    if (client == null) {
      promise.reject("busy", "another sync is running")
      return
    }
    log(
      "sync//request addr=$peerId opId=${client.opId} wantBytes=${wantBytes.size} " +
        "mode=${if (wantBytes.isEmpty()) "digest-only" else "digest+messages"}",
    )
    // OUTSIDE THE LOCK: start() posts a delayed runnable and opens a GATT
    // connection, and neither belongs under a mutex the radio's own
    // callbacks take.
    client.start()
  }

  /**
   * END THE NATIVE MESH SESSION — the cancel JS's arbiter needs (meshSync's
   * endNativeSession).
   *
   * Before this verb a stop could not reach the radio at all: stopAll left
   * the latch exactly as it found it, so an operation begun by a session that
   * no longer exists ran to its own 60-second timeout while the session that
   * REPLACED it could not dial. Now the outstanding op is torn down at the
   * source, its own terminal settles the bridge promise by the failure road,
   * and JS's slot is released seconds later instead of a minute later.
   *
   * It also puts the SERVING side out of scope: the digest this session
   * published is no longer this phone's offer, so it is cleared and the
   * characteristic goes back to answering "not ready" rather than serving a
   * dead session's mailbox — or, worse, serving an empty one as the complete
   * and confident sentence "this phone carries nothing".
   */
  @ReactMethod
  fun endSession(promise: Promise) {
    // The client's own terminal is what clears the owner record, and it
    // clears it only if the record is still ITS OWN — so a cancel racing a
    // natural completion cannot clear the NEXT op's claim.
    cancelSyncOwner("session ended")
    synchronized(syncLock) {
      syncDigest = ByteArray(0)
      digestReady = false
      digestGeneration++
      // …AND THE RESPONSE GENERATION WITH IT (row 123, blocker 2). A read
      // that copied this session's frame before this line and reaches its
      // sendResponse after it is refused there rather than emitted.
      retireGen += 1
      // THE EPOCH AND REVISION STAY. They are the FLOOR a later publish has
      // to beat, and clearing them here is what would let the dying
      // session's own last publish — already in flight across the bridge —
      // land after this and reinstall a dead pod's offer. The session that
      // replaces this one carries a higher epoch and installs immediately.
      log(
        "mesh//end-session digestGen=$digestGeneration heldEpoch=$digestEpoch " +
          "heldRev=$digestRev",
      )
      // Every central's read state belongs to the offer that is now gone.
      digestCursor.clear()
      digestFrame.clear()
      msgCursor.clear()
      msgBuffers.clear()
      msgFrame.clear()
      // The same permanence as stopGattServer, for the verb a walkie
      // open/close fires dozens of times an evening: a reply computed for
      // THIS session and still on the bridge must not install into the
      // session that replaces it a moment from now.
      invalidateWantTickets()
    }
    promise.resolve(null)
  }

  /** The connected sync state machine. Kept as an inner class so its many
   * callbacks share state without a map of partial closures. */
  private inner class SyncClient(
    private val device: BluetoothDevice,
    private val want: ByteArray,
    private val promise: Promise,
    /** THIS OPERATION'S IDENTITY. Monotonic over the process, minted under
     * the owner lock at admission, and the thing every clear compares
     * against: "the radio is free" is never a fact on its own, only ever
     * "op N is over AND op N is what the record still names". */
    val opId: Long,
  ) : BluetoothGattCallback() {
    private var gatt: BluetoothGatt? = null
    private var digestOut = ByteArrayOutputStream()
    private var msgOut = ByteArrayOutputStream()
    /** THE IDENTITY OF THE OFFER THESE DIGEST BYTES ARE (row 120) — parsed
     * off the frames as they arrive, handed back to JS with them, and
     * carried by JS onto the WANT of the pass that follows. This is the only
     * place a client can learn it, which is why the server puts it here.
     * [epoch, rev, generation]. */
    private var offerRead: Triple<Long, Long, Int>? = null
    private var phase = "connect" // connect -> digest -> want -> messages
    private var wantSeq = 0
    /** The seq this side expects next. A server whose digest changed
     * between our reads restarts its stream at seq 0 (see the serving
     * side's generation logic); appending its frame 0 onto our half-read
     * old stream would build a digest that never existed on either phone.
     * The check turns that from silent corruption into a named event. */
    private var expectSeq = 0
    /**
     * The terminal latch, and it is READ AND WRITTEN ONLY UNDER
     * syncOwnerLock. It used to be a plain field checked and set on
     * whichever thread got here first, which is how the timeout and the
     * final read both entered a terminal and cleared the busy flag twice —
     * the second clear landing on the NEXT operation's claim. Every read of
     * it below is inside the lock for that reason; `@Volatile` would make
     * the reads fresh and still leave check-then-set torn.
     */
    private var done = false
    val addr: String = device.address
    private val timeoutRunnable = Runnable {
      log("sync//timeout addr=$addr opId=$opId phase=$phase ms=$SYNC_TIMEOUT_MS")
      fail("sync timed out")
    }

    fun start() {
      log("sync//start addr=$addr opId=$opId wantBytes=${want.size} timeoutMs=$SYNC_TIMEOUT_MS")
      main.postDelayed(timeoutRunnable, SYNC_TIMEOUT_MS)
      try {
        gatt = device.connectGatt(ctx, false, this)
      } catch (e: SecurityException) {
        log("sync//err addr=$addr phase=$phase reason=security-on-connectGatt")
        fail("permission")
      }
    }

    /** Has a terminal already run? Answered under the lock, for the
     * callbacks that only want to know whether to keep going. */
    private fun finished(): Boolean = synchronized(syncOwnerLock) { done }

    /**
     * THE ONE TERMINAL, and the only place `done` and the owner record are
     * written.
     *
     * Answers true when THIS call is the one that ends the operation. The
     * check-and-set and the ownership clear happen together under one lock,
     * so of two terminals racing from two threads exactly one gets true and
     * the loser does nothing at all — and the clear names this op, so a
     * terminal that somehow arrives after the record has moved on (a cancel
     * racing a natural completion) cannot release a LATER operation's claim.
     */
    private fun claimTerminal(): Boolean {
      var owned = false
      val mine = synchronized(syncOwnerLock) {
        if (done) {
          false
        } else {
          done = true
          if (syncOwner === this) {
            syncOwner = null
            owned = true
          }
          true
        }
      }
      if (mine && !owned) {
        // The record had already moved on. Nothing to release, and saying so
        // is the log line that distinguishes this from a leak.
        log("sync//terminal addr=$addr opId=$opId owner=other cleared=0")
      }
      return mine
    }

    /** Tear this operation down from OUTSIDE — endSession's cancel. Runs the
     * ordinary failure terminal, so the bridge promise settles by its normal
     * road and JS learns the radio is free. */
    fun cancel(why: String) {
      log("sync//cancel addr=$addr opId=$opId phase=$phase why=\"$why\"")
      fail(why)
    }

    private fun finishOk() {
      if (!claimTerminal()) {
        log("sync//late addr=$addr opId=$opId phase=$phase call=finishOk (already done)")
        return
      }
      main.removeCallbacks(timeoutRunnable)
      cleanup()
      val m = Arguments.createMap()
      m.putString("digest", Base64.encodeToString(digestOut.toByteArray(), Base64.NO_WRAP))
      m.putString("messages", Base64.encodeToString(msgOut.toByteArray(), Base64.NO_WRAP))
      offerRead?.let { (epoch, rev, generation) ->
        // THE ANSWER NAMES THE OFFER IT READ. JS holds this beside the want
        // ids it derives from these bytes and writes it back on the WANT
        // wire; the server matches it against what it publishes then.
        m.putDouble("offerEpoch", epoch.toDouble())
        m.putDouble("offerRev", rev.toDouble())
        m.putDouble("offerGeneration", generation.toDouble())
      }
      log(
        "sync//done addr=$addr opId=$opId ok=1 phase=$phase " +
          "digestBytes=${digestOut.size()} msgBytes=${msgOut.size()}",
      )
      promise.resolve(m)
    }

    private fun fail(why: String) {
      if (!claimTerminal()) {
        log("sync//late addr=$addr opId=$opId phase=$phase call=fail why=$why (already done)")
        return
      }
      main.removeCallbacks(timeoutRunnable)
      cleanup()
      log(
        "sync//done addr=$addr opId=$opId ok=0 phase=$phase why=\"$why\" " +
          "digestBytes=${digestOut.size()} msgBytes=${msgOut.size()} wantSeq=$wantSeq",
      )
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
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED && !finished()) {
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
        main.postDelayed({ if (!finished()) readChar(g, uuid) }, NOT_READY_RETRY_MS)
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
        if (phase == "digest") {
          offerRead = null
        }
      }
      log(
        "sync//frame addr=$addr phase=$phase seq=$seq total=$total " +
          "chunk=${value.size - 4} acc=${sink.size() + value.size - 4}",
      )
      var from = 4
      if (phase == "digest") {
        // EVERY NON-EMPTY DIGEST FRAME NAMES ITS OFFER. A frame that does
        // not is a peer speaking a wire this build cannot attribute an ask
        // to, and an unattributable ask is one the server would refuse
        // anyway — so it fails here, where the reason is legible, rather
        // than as a silent stale-offer refusal two passes later.
        if (value.size < 4 + OFFER_IDENTITY_BYTES) {
          log("sync//frame addr=$addr phase=digest bytes=${value.size} reason=no-offer-identity")
          fail("digest frame carries no offer identity")
          return
        }
        val id = Triple(readBE64(value, 4), readBE64(value, 12), readBE32(value, 20))
        val held = offerRead
        if (held != null && held != id) {
          // The peer republished between two frames of one stream. The seq
          // restart rule usually catches this; when it does not, two
          // generations must still never be concatenated.
          log("sync//frame addr=$addr phase=digest reason=offer-changed-mid-stream")
          fail("the peer's offer changed mid-stream")
          return
        }
        offerRead = id
        from = 4 + OFFER_IDENTITY_BYTES
      }
      sink.write(value, from, value.size - from)
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
      log(
        "mesh//stop-all advertising=$advertising scanning=$scanning " +
          "syncOpId=${synchronized(syncOwnerLock) { syncOwner?.opId ?: 0L }}",
      )
      stopAdvertisingInternal(keepServer = false)
      // AND THE OP ON THE RADIO. Leaving it running was the whole reason a
      // stop could not free the hardware: the latch stayed set, the JS side
      // could not dial, and the only thing that ever ended it was its own
      // 60-second timeout.
      cancelSyncOwner("radio stopped")
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
      log(
        "mesh//invalidate advertising=$advertising scanning=$scanning " +
          "syncOpId=${synchronized(syncOwnerLock) { syncOwner?.opId ?: 0L }} service=stopped",
      )
      stopAdvertisingInternal(keepServer = false)
      cancelSyncOwner("react instance gone")
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
