import CoreBluetooth
import Foundation
import React

/**
 CrewBeacon — the iOS radio half of Crew (docs/CREW-DESIGN.md Phase B/C)
 plus the answering machine's message-exchange pipe (§6b Phase D).

 THE PLATFORM ASYMMETRY THIS FILE ENCODES. CoreBluetooth peripherals cannot
 put data in an advertisement — only service UUIDs and a local name — so an
 iPhone can never broadcast the crew payload inline the way Android does.
 Both halves of the answer live here:
  - As a PERIPHERAL we advertise the service UUID and serve the current
    payload from a read-only GATT characteristic; peers connect and read.
  - As a CENTRAL we scan for the service UUID. An Android peer's payload
    arrives inline as manufacturer data (company id 0xFFFF, little-endian
    prefix, then the protocol bytes) and costs nothing; an iOS peer has no
    inline data, so we connect, read the characteristic, disconnect —
    rate-limited and capped so a dusty crowd never becomes a connect storm.

 MESSAGE SYNC (Phase D) mirrors the Android module: three more
 characteristics on the same service move opaque byte streams as
 [seq u16 BE][total u16 BE][chunk] frames — GATT values cap at 512 bytes,
 so a stream is pulled by REPEATED reads with a per-central cursor on the
 serving side; total=0 means "not ready, retry". One iOS-specific
 correctness detail: a central's long read arrives as offset-sliced
 didReceiveRead requests, so the server caches the CURRENT frame per
 central and advances the cursor only on offset==0 — continuation offsets
 slice the SAME frame. The write direction is symmetric and was NOT: a
 central's long write arrives as offset-sliced didReceiveWrite requests
 too, so those are assembled by offset before anything reads a frame
 header out of them. A digest that changes mid-stream bumps a GENERATION
 rather than clearing state, so a read already in flight finishes from its
 own snapshot and only the central's next fresh read rewinds. The payload
 bytes are opaque here; codec and policy live in src/crews/syncLink.ts /
 messages.ts.

 WHAT A STRANGER CAN MAKE US HOLD. Every per-central buffer here is
 created by whoever connects — there is no pairing and no crew check at
 this layer — and CBPeripheralManager never tells a peripheral that a
 central went away. So the roster is capped (maxTrackedCentrals, oldest
 evicted), a want assembly is capped (maxWantBytes), and an assembled long
 write is capped (maxPreparedBytes). At a 70k-person festival the
 alternative is a memory-exhaustion surface with no authentication in
 front of it.

 Backgrounded (Phase C, bluetooth background modes): iOS moves our service
 UUID to the proprietary "overflow area", which ONLY other iPhones
 scanning explicitly for this UUID can see — a pocketed iPhone is findable
 by iPhones, not by Androids, and the UI says so honestly.

 THE SAME RULE BITES IN THE FOREGROUND, THROUGH A SECOND ADVERTISER — and
 that is why this beacon goes quiet while the walkie is open. Measured
 2026-08-26 on three phones: an iPhone carried live BLE voice to an
 Android for the first time, and neither Android could see that iPhone in
 their channel at all. Their logcat proved the other Pixel's identity over
 and over and never once attempted the iPhone's. With the walkie open this
 app runs TWO CBPeripheralManager advertisers — WalkieBleVoice's (rung 3's
 128-bit service UUID plus its "PV…" local name) and this one (the crew
 service UUID) — and two 128-bit UUIDs do not fit one 31-byte primary
 advertising packet. CoreBluetooth then does what it documents: it moves
 the service UUIDs to the overflow area, iPhone-only by construction, and
 Android's ScanFilter.setServiceUuid matches nothing. Two advertisers do
 not halve the reach; they end it.

 So while the walkie is on, the walkie has the airtime. src/crews/share.ts
 owns that decision (holdCrewAdvertising / releaseCrewAdvertising) — the
 seam is deliberately in JS, because rung 3's voice link and this beacon
 are separate concerns that merely share a radio, and the app is the only
 layer that knows both were asked for at once. NOTHING NATIVE CHANGES
 HERE, and the cost is smaller than it sounds: only startAdvertising
 stops — this service stays published, so a peer that already holds our
 address still connects and reads its mail, and our CENTRAL half keeps
 scanning and dialling, which is the direction an iPhone's mail already
 travelled. What an Android loses is dialling this iPhone cold, which
 during a walkie it could not do anyway. That was the bug.

 Events mirror Android exactly:
   CrewBeaconSighting { payload: base64, rssi: int, via: 'adv'|'gatt',
                        peerId: string }
   CrewBeaconState    { advertising: bool, scanning: bool,
                        adapterEnabled?: bool, error?: string }
   CrewSyncWant       { peerId: string, payload: base64,
                        requestId: number, serverEpoch: number }
   CrewSyncServed     { peerId: string }

 ADAPTER BOUNCE. The CBManager state callbacks already carry power-off and
 power-on, and wantAdvertising/wantScanning make the restart automatic here
 (Android has no equivalent and needs a broadcast receiver for it). What was
 missing on BOTH platforms was telling JS: a session whose radio dies has to
 stop claiming the pod can see you. adapterEnabled rides every state event
 for exactly that.
 */
@objc(CrewBeacon)
final class CrewBeacon: RCTEventEmitter {
  private static let sightingEvent = "CrewBeaconSighting"
  private static let stateEvent = "CrewBeaconState"
  private static let syncWantEvent = "CrewSyncWant"
  /** A central finished reading our digest: the reciprocity cue the JS fast
   path dials back on (meshSync.ts). Address only, never content. Mirrors
   CrewBeaconModule.SYNC_SERVED_EVENT. */
  private static let syncServedEvent = "CrewSyncServed"
  private static let serviceUUID = CBUUID(string: "6B75A1F4-8E2A-4B0B-9F21-706C61796170")
  private static let payloadChar = CBUUID(string: "6B75A1F5-8E2A-4B0B-9F21-706C61796170")
  private static let digestChar = CBUUID(string: "6B75A1F6-8E2A-4B0B-9F21-706C61796170")
  private static let wantChar = CBUUID(string: "6B75A1F7-8E2A-4B0B-9F21-706C61796170")
  private static let msgChar = CBUUID(string: "6B75A1F8-8E2A-4B0B-9F21-706C61796170")
  private static let manufacturerId: UInt16 = 0xFFFF
  /** The re-read floor for a peer whose payload rides a characteristic —
   * on this platform every peer, since CoreBluetooth cannot inline data.
   * The Android module now runs this at 5 s while the app is foreground
   * (CrewBeaconModule.GATT_COOLDOWN_FOREGROUND_MS: a JS nudge can only dial
   * an address it has SEEN, so this floor is the delivery clock), and it
   * takes the posture from JS's setScanMode — a method this module does not
   * have yet, because it has no scan-duty-cycle knob to hang it on. Stated
   * as a KNOWN GAP rather than a matched number: an iPhone in a pod is
   * sighted twice a minute at best, which is exactly what meshSync's
   * freshness gate refuses to condemn an address for. */
  private static let gattCooldown: TimeInterval = 30
  private static let gattTimeout: TimeInterval = 8
  private static let frameChunk = 480
  private static let syncTimeout: TimeInterval = 60
  private static let notReadyRetry: TimeInterval = 0.4
  /** How many centrals we keep per-connection state for at once. Every
   per-central buffer below is created by WHOEVER CONNECTS — no pairing, no
   crew membership, nothing authenticated — and CBPeripheralManager gives a
   peripheral no disconnect callback for a central, so on this platform the
   roster cap is the ONLY bound. Oldest goes first. */
  private static let maxTrackedCentrals = 8
  /** A want list carries message IDS, never bodies; `total` is a
   peer-supplied u16, so 65535 frames of 480 bytes is 31MB of our memory on
   their say-so. Past this the assembly is dropped, not grown. */
  private static let maxWantBytes = 64 * 1024
  /** GATT attribute values cap at 512 bytes, so no honest long write
   assembles to more; ours are at most one 484-byte frame. */
  private static let maxPreparedBytes = 512
  /**
   THE FRUGAL SCAN'S HEARTBEAT — and the reason this platform needs one at
   all. Android's SCAN_MODE_BALANCED still reports a peer it has already
   seen, just less often. CoreBluetooth's duplicates-off does not: a
   peripheral is reported ONCE per scan session and then never again, so
   mapping "frugal" straight onto `allowDuplicates: false` would freeze
   every peer's last-seen stamp while the radio is demonstrably still
   hearing them. Presence liveness is MEMBERSHIP (docs/WALKIE-LADDER.md §1:
   a posture change may cost fidelity, never a seat in the pod), so the
   frugal posture restarts the scan on this interval instead — each peer is
   re-reported about twice a minute rather than on every advertisement.
   Comfortably inside presence's 3-minute live window and meshSync's 90 s
   freshness ceiling, and roughly an order of magnitude fewer wakeups than
   the low-latency posture.
   */
  private static let frugalRescanInterval: TimeInterval = 30

  private var peripheralManager: CBPeripheralManager?
  private var centralManager: CBCentralManager?
  private var payload = Data()
  private var wantAdvertising = false
  private var wantScanning = false
  private var advertising = false
  private var scanning = false
  /** Scan duty cycle asked for by JS (setScanMode): false = frugal (the
   battery-honest default this module ships with, and the posture a stopped
   session is handed back), true = LOW_LATENCY while the app is foreground.
   Mirrors CrewBeaconModule.scanLowLatency. */
  private var scanLowLatency = false
  /** Armed only while the frugal posture is scanning; see
   frugalRescanInterval. */
  private var rescanTimer: Timer?
  private var serviceAdded = false
  /** Strong refs while connecting — CoreBluetooth drops unreferenced peripherals. */
  /**
   ONE PASSIVE GATT READ, AND THE RADIO WORLD IT WAS OPENED IN (row 116).

   These are the connects the SIGHTING path opens — an iOS peer carries no
   inline payload, so we dial it and read the payload characteristic. They
   are capped at two, and the cap is the whole reason this record carries a
   generation: a `.radio` retirement (an adapter power cycle) cancels them
   and clears the map, but CoreBluetooth's own late callbacks for those
   cancelled connections keep arriving afterwards. A late `didDisconnect`
   for peripheral X, keyed only by X's identifier, would remove the entry a
   NEW connect to X has since created — or, in the shape the review traced,
   leave a dead entry occupying the cap so that every rediscovery after the
   bounce is refused. The generation makes the late callback INADMISSIBLE:
   it names the world its connect was opened in, and a callback from a world
   that ended clears nothing.
   */
  private struct PassiveConnect {
    let peripheral: CBPeripheral
    let gen: Int
    /** THE EXACT OPERATION, MINTED AT CREATION — and this is what the
     generation alone could not carry. `gen` names the WORLD a connect was
     opened in, so a callback from a dead world clears nothing; it says
     nothing about WHICH connect a callback belongs to inside one world.
     The reachable loss: op A to peripheral X is cancelled by a retirement,
     X is rediscovered and op B is opened, and A's late `didDisconnect` —
     which names only X — looks X up, finds B's entry carrying the CURRENT
     generation, and deletes the slot B is holding. A UUID is a NAME, and a
     name outlives the operation it was used for. See `passiveOwed`. */
    let opId: Int64
  }

  private var inFlight: [UUID: PassiveConnect] = [:]

  /// Monotonic over the process, minted on the owner queue at connect.
  private var passiveOpSeq: Int64 = 0

  /**
   THE TERMINALS COREBLUETOOTH STILL OWES US, per peripheral, oldest first.

   Cancelling a connect does not un-schedule its delegate terminal — it
   CAUSES one. So every road that cancels a passive connect records the op
   it cancelled here, and the next callback for that peripheral PAYS THAT
   DEBT and clears nothing. CoreBluetooth guarantees per-peripheral
   delivery order, which is exactly what makes "the next callback belongs
   to the oldest owed op" a fact rather than a guess.

   Bounded by `maxOwedTerminals` so a peripheral whose terminals never
   arrive cannot grow a list; the ledger is emptied by `.everything`, which
   is the road on which nothing is owed to anybody any more.

   WHAT THE CAP BOUNDS IS THE NAMES, NOT THE COUNT — and that distinction is
   this ledger's whole correctness. The cap used to DROP the third debt, on
   the reasoning that "two is the passive connect cap so a third would name
   an op that never existed". Two is the cap on connects IN FLIGHT AT ONCE;
   debts are not in flight, they outlive the ops that made them, and they
   accumulate one per OUTAGE. Three bounces over one peripheral whose
   terminals are slow is three debts, and the third one was thrown away with
   a log line calling it a fail-open.

   It is not fail-open. A dropped debt means one late callback arrives
   ANONYMOUS: it finds no debt, looks the peripheral up by UUID, finds
   whatever connect happens to occupy the slot now, and — if that entry
   carries the current generation — DELETES IT. That is precisely the
   opId-vs-UUID defect this ledger was built to stop, re-entered through its
   own overflow.

   So no debt is ever dropped. `passiveOwed` keeps the OLDEST
   `maxOwedTerminals` opIds by name (they are what the log attributes), and
   `passiveOwedOverflow` counts the rest. The total owed is exact, callbacks
   are paid oldest-first out of the names and then out of the count, and the
   memory is O(1) per peripheral past the cap.
   */
  private var passiveOwed: [UUID: [Int64]] = [:]

  /**
   THE DEBTS PAST THE NAMED CAP, AS AN EXACT COUNT.

   An unnamed debt is paid exactly like a named one; all it loses is the
   opId in its log line, which is attribution rather than correctness. This
   is the honest half of the bound: the list of names cannot grow, and the
   number of terminals still owed is never wrong.
   */
  private var passiveOwedOverflow: [UUID: Int] = [:]

  /// At most this many unpaid terminals per peripheral are held BY NAME.
  /// Past this the debt is counted rather than named — never dropped.
  private static let maxOwedTerminals = 2

  /// Bumped by every RADIO-scope retirement (`.radio` and `.everything`).
  /// Passive connects opened before the bump are inadmissible after it.
  private var radioGeneration = 0

  /**
   HAS THE RADIO ALREADY BEEN RETIRED FOR THIS OUTAGE? The reconciler runs
   on every manager event, and `.radio` retirement is not idempotent — it
   bumps `radioGeneration` and `digestGeneration`. This latch is what makes
   "apply the shared radio generation ONCE" true across the two managers'
   two event streams: the first reconcile that finds NEITHER manager
   powered on retires, and the next one that finds either of them up arms
   it again.
   */
  private var radioRetired = false
  private var lastTried: [UUID: Date] = [:]
  private var lastRssi: [UUID: NSNumber] = [:]
  private var startAdvertisePromise: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?
  private var startScanPromise: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?

  // ---- sync server state (peripheral side) ----
  private var syncDigest = Data()
  private var digestCursor: [UUID: Int] = [:]
  private var digestFrame: [UUID: Data] = [:]
  private var msgCursor: [UUID: Int] = [:]
  private var msgFrame: [UUID: Data] = [:]
  private var msgBuffers: [UUID: Data] = [:]
  private var wantAssembly: [UUID: Data] = [:]
  /** DIGEST GENERATION. setSyncDigest fires on EVERY message-store change —
   which is to say while peers are reading — and it used to clear the
   cursors and the cached frames outright. That invalidated centrals mid
   long-read (the continuation lost the frame it was slicing) and mid
   stream (the cursor rewound, so the next frame the central appended was a
   frame 0 of a DIFFERENT digest). The invalidation is still real and still
   enforced — a fresh digest must never be continued as if it were the old
   one — but it is now a generation rather than a deletion: cached frames
   are snapshots that any in-flight continuation can finish from, and each
   central rewinds to seq 0 at ITS next offset-0 read. */
  private var digestGeneration = 0
  private var digestStreamGen: [UUID: Int] = [:]
  /** The tracked-central roster, oldest first. See maxTrackedCentrals. */
  private var centralSeen: [UUID] = []

  // ---- sync client state (central side) ----
  /// The op that owns the radio, or nil. Written only on `bleQueue`.
  private var syncOwner: SyncOp?

  /**
   THE ONE QUEUE THAT OWNS THE SYNC CLIENT (iOS confinement, M2's native
   half — the mesh lane built this on Android and handed the iPhone over).

   BOTH MANAGERS ARE BUILT WITH `queue: nil`, WHICH IS THE MAIN QUEUE. So
   every CoreBluetooth delegate callback in this file — the central's
   discover/connect/disconnect, the peripheral's read and write, the sync
   client's own characteristic callbacks — is already serialized against
   itself, and `syncOwner`, `inFlight`, the digest state and the per-central
   cursors are all safe FROM EACH OTHER.

   WHAT THEY WERE NOT SAFE FROM IS THE BRIDGE. React Native calls
   @objc methods on the module's own method queue, and `syncWithPeer` and
   `stopAll` read and wrote `syncOwner` and `inFlight` from there, directly,
   while the radio's callbacks were writing the same Dictionary and the same
   optional on main. A Swift Dictionary written from two queues at once is
   undefined behaviour, not merely stale — and the specific loss is the one
   Android's owner-record essay names: a check-then-set that is not atomic
   admits two clients onto one radio.

   SO THE QUEUE IS NAMED, AND EVERY ENTRY POINT THAT TOUCHES CONFINED STATE
   GOES THROUGH IT. It is main rather than a private serial queue on
   purpose: main is where CoreBluetooth already delivers (changing that
   would move every callback in the file at once), and it is the only queue
   with a run loop — `rescanTimer` is a Foundation Timer and a bare
   DispatchQueue cannot host one. `onBle` runs INLINE when the caller is
   already on the queue, so a delegate callback keeps its present ordering
   exactly and does not gain a reentrancy hazard it did not have.
   */
  private static let bleQueue = DispatchQueue.main

  /// Run `work` on the confinement queue — inline if we are already there.
  private func onBle(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      Self.bleQueue.async(execute: work)
    }
  }

  /**
   THE OWNER RECORD, not a busy flag (M2, mirroring Android's syncOwner).

   `syncOp` used to be the whole story, and `syncFinished()` cleared it
   unconditionally. That is the same defect the Android module traced: a
   timeout and a final read can both enter a terminal, the first clears the
   record, the next sync is admitted, and the SECOND terminal of the dead op
   then clears the NEW op's claim — so a third sync is admitted while the
   second still holds the radio. "The radio is free" is never a fact on its
   own; the only fact is "op N is over AND op N is what the record names".

   `opId` is minted under this queue at admission and is monotonic over the
   process. Every clear compares it.
   */
  private var syncOpSeq: Int64 = 0

  /// The offer's SCOPE (M5/M6). A publish is installed only when it is
  /// strictly newer than (digestEpoch, digestRev), and these survive
  /// endSession deliberately: they are the FLOOR a dying session's
  /// last in-flight publish must fail to beat.
  private var digestEpoch: Int64 = 0
  private var digestRev: Int64 = 0
  /// Has an offer for the CURRENT session been installed and acked? Until
  /// it has, the digest characteristic answers the not-ready frame rather
  /// than serving an empty buffer as a complete stream. See didReceiveRead.
  private var digestReady = false
  /// The identity handed to JS with each want, so an answer can be matched
  /// to the request that asked for it (Android: wantTicketSeq). Monotonic
  /// over the PROCESS: it is never reset, because a reset would let a new
  /// session mint an id a dead session's answer is still carrying.
  private var wantTicketSeq: Int64 = 0

  /// THE ONE REQUEST THIS PHONE HAS OPEN FOR A CENTRAL, and the scope it was
  /// asked under (Android's WantTicket, of which iOS needs exactly one per
  /// central: a fresh want here replaces the response stream outright).
  private struct OpenWant {
    let id: Int64
    let epoch: Int64
    let rev: Int64
  }

  /// Keyed by central, so an answer is matched to the QUESTION rather than
  /// installed against the name of whoever asked one. The install used to
  /// be `msgBuffers[peer] = data` with nothing consulted at all: a central
  /// that wrote a second want while JS was computing the first answer got
  /// the OLD rows served as the answer to the NEW ask, and a want from a
  /// session that had since ended could fill a live session's buffer.
  private var openWant: [UUID: OpenWant] = [:]

  /// EVERY REQUEST ID AT OR BELOW THIS IS DEAD FOREVER. A stop does not
  /// merely forget what is outstanding — forgetting is what let the next
  /// session's tickets be filled by the previous one's answers — it draws a
  /// line under every id minted so far. Ids only ever go up, so a reply from
  /// before the line can never match a request made after it, whatever
  /// central it names and however many sessions have opened since.
  private var wantInvalidBefore: Int64 = 0

  /**
   THE PER-CENTRAL LAST-READ RECORD IS GONE, AND ITS DELETION IS THE CURE
   (row 120). It used to be the authority for "the offer this ask was built
   against": recorded at the handover of the last digest frame, compared
   against the live offer when a want arrived.

   IT CANNOT BE THAT AUTHORITY, and no amount of care makes it one. The
   client's second pass re-reads the digest before it writes the want, so by
   the time the want lands the record names whatever the server published
   most recently — which is exactly the offer the check compares it to. The
   invariant was self-satisfying, and a want derived from A was accepted,
   stamped and served as one derived from B, with every check green.

   IT IS DELETED RATHER THAN DEMOTED TO DIAGNOSTICS. A second, weaker copy
   of a fact the wire now carries is a copy a future edit re-promotes, and
   every retirement road would still have to remember to clear it. Nothing
   is lost by removing it: the carried identity is STRICTLY STRONGER
   evidence than the record ever was, because the only place a central can
   learn a live (epoch, rev, generation) triple is the digest stream itself,
   so a want that names the live offer is a want from a central that read
   it. See `handleWantFrame`.
   */

  /**
   THE RETIRED GATE — the one piece of this module's state that is NOT
   confined to `bleQueue`, and the reason is the whole of finding 109.

   A CoreBluetooth read request R can already be sitting on the main queue
   when the bridge's teardown calls `invalidate` on RN's `_sharedModuleQueue`
   (this module has no methodQueue override and requiresMainQueueSetup is
   false, so that is where every @objc entry point lands). Main's order is
   then R -> whatever the retirement enqueues, so a retirement that is only a
   dictionary cleanup on main is a cleanup R has already run in front of: R
   serves the previous session's bytes after the logical stop returned.

   Clearing those dictionaries from the CALLING queue instead is not the cure
   — it is a data race on maps the radio's own callbacks write. So the cure
   is a gate that can be published from any queue and is read by every
   main-confined serve BEFORE it touches a buffer: the retirement becomes
   EFFECTIVE the instant it is published, and the dictionary cleanup that
   follows is bookkeeping rather than the barrier.

   `meshRetired` is the mesh session's scope (offer withdrawn: digest and
   message reads answer the not-ready retry frame). `surfaceRetired` is the
   sharing surface's (services and payload gone: nothing is answered at all).
   Both are cleared by the verb that legitimately re-opens what they closed —
   an installed offer, a set payload — so a live session never inherits a
   dead one's refusal.
   */
  private let retiredLock = NSLock()
  private var meshRetiredFlag = false
  private var surfaceRetiredFlag = false

  /**
   THE RETIREMENT GENERATION — what turns a cleanup that LOST ITS RACE into
   a no-op instead of a ghost (the cross-family binding no-go on 9c0ad89).

   HOW THE GHOST GOT OUT. `retireBeforeReturning` publishes the gate, hops
   to the confined queue and waits at most `retirementBarrierTimeout`. On
   TIMEOUT it returns — correctly, and fail-closed, because the gate is what
   is holding — while the cleanup it dispatched is still QUEUED behind
   whatever is blocking main. `stopAll` then resolves, the teardown
   completes, the camper turns sharing back on, `setPayload` / `installDigest`
   legitimately reopen the gate, session B advertises… and only THEN does
   main drain the OLD cleanup, which sets `wantAdvertising = false`, removes
   the services, clears the payload and republishes the retirement. B dies
   after JS was told its start succeeded. Nothing fenced it: the cleanup
   carried no statement about WHICH surface world it belonged to.

   THE FENCE, AND WHY IT COMPOSES WITH THE GATE-FIRST INVARIANT RATHER THAN
   REPLACING IT. Every write to this gate — a publish OR a clear — mints the
   next generation, under the SAME lock, in the same atomic write as the
   flags. A dispatched cleanup captures the generation its own publish
   minted, and its FIRST act on the confined queue is to compare. Three
   sentences, and not one of them weakens what was already true:

     - the gate still closes ATOMICALLY BEFORE ANY QUEUE HOP, so the
       retirement is in force from the calling queue's own line;
     - the timeout still FAILS CLOSED — the gate holds whether or not the
       cleanup ever lands, and a cleanup that no-ops leaves it holding;
     - the ONLY thing the generation changes is the fate of a cleanup that
       lost the race. A newer retirement, or a legitimate reopen, has moved
       the surface world on; the stale cleanup then touches NOTHING —
       not `wantAdvertising`, not the services, not the payload, and it does
       not republish the retirement — rather than retiring the world that
       replaced it.

   REOPENING IS THEREFORE THE FENCE, not a second mechanism bolted beside
   it. `setPayload` and `installDigest` are already the only two verbs that
   lift what a stop closed, and because they clear UNDER THIS LOCK they mint
   the generation that makes the old cleanup stale. There is no third place
   anyone has to remember.

   AND ONE TERMINAL PER GENERATION — the belt on these braces. The claim
   below is taken in the same critical section as the compare, so a cleanup
   body runs AT MOST ONCE for any one retirement; a re-dispatch of the same
   generation finds the claim taken and no-ops. What is NOT achievable here
   is the reviewer's stronger "one terminal BEFORE stopAll resolves": that
   requires the calling queue to block on main, which is exactly the
   `DispatchQueue.main.sync` this file refuses on RN 0.87 (the deadlock
   argument in `retireBeforeReturning`). An unprovable barrier is not a
   barrier, so the generation is the cure and the claim is only the belt.
   */
  private var retirementGen: Int64 = 0
  private var retirementCleanupClaimed: Int64 = 0

  /// How long the off-main retirement barrier waits for its confined half.
  /// See `retireBeforeReturning`: the wait is bounded because the gate above
  /// has ALREADY made the retirement effective, so the timeout costs a
  /// delayed cleanup and never a served byte.
  private static let retirementBarrierTimeout: TimeInterval = 2

  /// Read under the lock, on whatever queue asks. Cheap: two Bools.
  private func retirementGate() -> (mesh: Bool, surface: Bool) {
    retiredLock.lock()
    defer { retiredLock.unlock() }
    return (meshRetiredFlag, surfaceRetiredFlag)
  }

  /// PUBLISHED BEFORE ANY QUEUE HOP. This is the line that makes a
  /// retirement a barrier rather than an intention — and it MINTS the
  /// generation that write owns, in the same critical section, so a caller
  /// that is about to dispatch a cleanup can name the world it closed.
  @discardableResult
  private func publishRetired(mesh: Bool, surface: Bool) -> Int64 {
    retiredLock.lock()
    if mesh { meshRetiredFlag = true }
    if surface { surfaceRetiredFlag = true }
    retirementGen &+= 1
    let minted = retirementGen
    retiredLock.unlock()
    return minted
  }

  /// The gate opens again only for the verb that re-opens what it closed —
  /// AND REOPENING IS THE FENCE. The bump here is what makes every cleanup
  /// still queued for the world this call just reopened a no-op.
  private func clearRetired(mesh: Bool, surface: Bool) {
    retiredLock.lock()
    if mesh { meshRetiredFlag = false }
    if surface { surfaceRetiredFlag = false }
    retirementGen &+= 1
    retiredLock.unlock()
  }

  /// The generation the surface world is at right now, on any queue.
  private func currentRetirementGeneration() -> Int64 {
    retiredLock.lock()
    defer { retiredLock.unlock() }
    return retirementGen
  }

  /**
   THE CAS A QUEUED CLEANUP TAKES BEFORE IT TOUCHES ANYTHING.

   True only when `generation` is still the world's generation AND no
   cleanup has already run for it. Both halves are read and written in ONE
   critical section: a compare that released the lock before claiming would
   be the same check-then-set this module's owner record already learned to
   refuse.
   */
  private func claimRetirementCleanup(_ generation: Int64) -> Bool {
    retiredLock.lock()
    defer { retiredLock.unlock() }
    guard retirementGen == generation, retirementCleanupClaimed < generation else {
      return false
    }
    retirementCleanupClaimed = generation
    return true
  }

  /// THE ARBITER'S HOLD, AS THIS MODULE SEES IT. Written only by the
  /// arbiter's own suppress/resume, and read at the one line that puts an
  /// advertisement on the air. It is not a mirror of JS's
  /// `advertisingHeld`: that flag stops the JS CADENCE from asking, which
  /// is necessary and is not proof of anything. This is the EFFECT side.
  private var airtimeSuppressed = false

  override init() {
    super.init()
    // INTRODUCED AT CONSTRUCTION, so the window in which this module
    // exists and the arbiter does not know about it is empty. A beacon
    // the process never constructed never advertised, which is what makes
    // the arbiter's "no sink" road honest.
    WalkieAirtimeArbiter.shared.registerCrew(self)
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [Self.sightingEvent, Self.stateEvent, Self.syncWantEvent, Self.syncServedEvent]
  }

  /** True when EITHER manager reports the radio powered on. Nil before any
   manager exists — "unknown", never "off", so JS reads it as unchanged
   rather than raising a false interruption before the first radio use. */
  private var adapterEnabled: Bool? {
    let states = [peripheralManager?.state, centralManager?.state].compactMap { $0 }
    guard !states.isEmpty else { return nil }
    return states.contains(.poweredOn)
  }

  private func emitState(_ error: String? = nil) {
    var body: [String: Any] = ["advertising": advertising, "scanning": scanning]
    // Mirrors Android's adapterEnabled: the JS honesty/recovery state
    // machine (src/crews/session.ts) tells "the radio refused" from "there
    // is no radio right now" by this field, and treats its return as the
    // cue to re-arm. iOS ALSO self-restarts below (wantAdvertising /
    // wantScanning survive a power cycle), so on this platform the JS
    // resume is a belt on top of a brace — both are idempotent.
    if let adapterEnabled { body["adapterEnabled"] = adapterEnabled }
    if let error { body["error"] = error }
    sendEvent(withName: Self.stateEvent, body: body)
  }

  private func emitSighting(_ bytes: Data, rssi: NSNumber, via: String, peerId: String) {
    sendEvent(withName: Self.sightingEvent, body: [
      "payload": bytes.base64EncodedString(),
      "rssi": rssi.intValue,
      "via": via,
      "peerId": peerId,
    ])
  }

  /** Frame a stream for one central: [seq][total][chunk]; total=0 = retry. */
  private static func frame(of buf: Data?, cursor: Int) -> Data {
    guard let buf else { return Data([0, 0, 0, 0]) }
    let total = buf.isEmpty ? 1 : (buf.count + frameChunk - 1) / frameChunk
    let seq = min(max(cursor, 0), total - 1)
    let from = seq * frameChunk
    let to = min(from + frameChunk, buf.count)
    var out = Data([
      UInt8((seq >> 8) & 0xFF), UInt8(seq & 0xFF),
      UInt8((total >> 8) & 0xFF), UInt8(total & 0xFF),
    ])
    out.append(buf.subdata(in: from ..< to))
    return out
  }

  private static func frameTotal(_ f: Data) -> Int {
    guard f.count >= 4 else { return 0 }
    return (Int(f[f.startIndex + 2]) << 8) | Int(f[f.startIndex + 3])
  }

  // ------------------------------------------------ the offer identity

  /**
   THE OFFER IDENTITY, AND WHY IT RIDES THE WIRE (row 120).

   The exchange is TWO connected passes with a JS round trip between them,
   and pass 2 ALWAYS re-reads the digest before it writes the want — that is
   not an accident of this client, it is what the two-pass design costs. So
   the per-central "the offer this central last read" record could never be
   the authority it claimed to be: JS derives its want ids from offer A, the
   server publishes B in the gap, pass 2's own reread records B, and the want
   built from A is minted, stamped and served as a want built against B. The
   exact/current checks all pass, because every one of them is comparing the
   server's record with the server's own present.

   The cure is that the ASK CARRIES THE OFFER IT WAS DERIVED FROM, and the
   server matches that against what it publishes NOW. Two wire additions,
   both of them fixed-width and both of them read by the other platform's
   twin:

     - a DIGEST frame whose total is non-zero carries this block between the
       4-byte [seq][total] header and its chunk, so a client learns the
       identity of the offer it is assembling from the offer itself;
     - a WANT payload begins with the same block, so the identity JS derived
       its ids from is the identity the server matches.

   A not-ready digest frame (total = 0) stays the bare four bytes it always
   was: there is no offer to name, and the retry protocol on both clients
   reads seq/total before it reads anything else.

   [epoch: 8 big-endian][rev: 8 big-endian][generation: 4 big-endian].
   */
  fileprivate static let offerIdentityBytes = 20

  fileprivate struct OfferIdentity: Equatable {
    let epoch: Int64
    let rev: Int64
    let generation: Int
  }

  private static func be32(_ v: UInt32) -> [UInt8] {
    [
      UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF),
      UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF),
    ]
  }

  private static func be64(_ v: Int64) -> [UInt8] {
    let u = UInt64(bitPattern: v)
    return be32(UInt32((u >> 32) & 0xFFFF_FFFF)) + be32(UInt32(u & 0xFFFF_FFFF))
  }

  fileprivate static func offerIdentityBlock(_ id: OfferIdentity) -> Data {
    var out = Data(be64(id.epoch))
    out.append(contentsOf: be64(id.rev))
    out.append(contentsOf: be32(UInt32(truncatingIfNeeded: id.generation)))
    return out
  }

  private static func readBE32(_ d: Data, _ at: Int) -> UInt32 {
    let i = d.startIndex + at
    return (UInt32(d[i]) << 24) | (UInt32(d[i + 1]) << 16)
      | (UInt32(d[i + 2]) << 8) | UInt32(d[i + 3])
  }

  private static func readBE64(_ d: Data, _ at: Int) -> Int64 {
    let hi = UInt64(readBE32(d, at))
    let lo = UInt64(readBE32(d, at + 4))
    return Int64(bitPattern: (hi << 32) | lo)
  }

  /// Reads the block, or nil when there are not enough bytes to hold one.
  fileprivate static func offerIdentity(from d: Data, at: Int) -> OfferIdentity? {
    guard d.count >= at + offerIdentityBytes else { return nil }
    return OfferIdentity(
      epoch: readBE64(d, at),
      rev: readBE64(d, at + 8),
      generation: Int(Int32(bitPattern: readBE32(d, at + 16)))
    )
  }

  /// A digest frame: the ordinary frame with the offer identity spliced in
  /// behind the header. `total == 0` (not ready) is left exactly as it was.
  private static func digestFrame(
    of buf: Data?,
    cursor: Int,
    identity: OfferIdentity
  ) -> Data {
    let f = frame(of: buf, cursor: cursor)
    guard frameTotal(f) > 0 else { return f }
    var out = f.subdata(in: f.startIndex ..< (f.startIndex + 4))
    out.append(offerIdentityBlock(identity))
    out.append(f.subdata(in: (f.startIndex + 4) ..< f.endIndex))
    return out
  }

  /// What this phone publishes RIGHT NOW. On `bleQueue`.
  private var liveOffer: OfferIdentity {
    OfferIdentity(epoch: digestEpoch, rev: digestRev, generation: digestGeneration)
  }

  // -------------------------------------------------- per-central lifetime

  /** Remember this central and keep the roster small. Called at every point
   that CREATES per-central state; the touched central moves to the newest
   end first, so it can never evict itself. */
  private func trackCentral(_ central: UUID) {
    centralSeen.removeAll { $0 == central }
    centralSeen.append(central)
    while centralSeen.count > Self.maxTrackedCentrals {
      dropCentralState(centralSeen[0]) // removes it, so this terminates
    }
  }

  /** Free EVERY buffer one central made. */
  private func dropCentralState(_ central: UUID) {
    centralSeen.removeAll { $0 == central }
    digestCursor.removeValue(forKey: central)
    digestStreamGen.removeValue(forKey: central)
    digestFrame.removeValue(forKey: central)
    msgCursor.removeValue(forKey: central)
    msgFrame.removeValue(forKey: central)
    msgBuffers.removeValue(forKey: central)
    wantAssembly.removeValue(forKey: central)
    openWant.removeValue(forKey: central)
  }

  /** Every central at once — the radio powered off or sharing stopped, so
   nothing we hold for any of them can still be in flight. */
  private func dropAllCentralState() {
    centralSeen.removeAll()
    digestCursor.removeAll()
    digestStreamGen.removeAll()
    digestFrame.removeAll()
    msgCursor.removeAll()
    msgFrame.removeAll()
    msgBuffers.removeAll()
    wantAssembly.removeAll()
    invalidateOpenWants()
  }

  /**
   EVERY OUTSTANDING REQUEST DIES HERE, AND STAYS DEAD.

   Clearing `openWant` alone would only make the next reply UNMATCHED, which
   is already refused — but the ids keep climbing and a later session's ids
   would be the ones a delayed reply is compared against. The watermark is
   what makes the refusal permanent rather than a race: every id minted up to
   this moment is below the line for the life of the process, so a reply that
   has been sitting on the bridge since before a stop cannot install into the
   session that replaced it no matter how many wants have happened since.

   Callers clear the served buffers themselves (endSession, stopAll via
   dropAllCentralState): an invalidated request must not leave a frame the
   message characteristic would still hand out.
   */
  private func invalidateOpenWants() {
    wantInvalidBefore = wantTicketSeq
    openWant.removeAll()
  }

  /** One WANT frame, however it reached us — a short write that fits the
   MTU, or a long write assembled from its offset slices (see
   didReceiveWrite). Mirrors the Android server's handleWantFrame. */
  private func handleWantFrame(central: UUID, value: Data) {
    guard value.count >= 4 else { return }
    let seq = (Int(value[value.startIndex]) << 8) | Int(value[value.startIndex + 1])
    let total = (Int(value[value.startIndex + 2]) << 8) | Int(value[value.startIndex + 3])
    let chunk = value.subdata(in: (value.startIndex + 4) ..< value.endIndex)
    if seq == 0 {
      trackCentral(central)
      wantAssembly[central] = chunk
    } else {
      guard var buf = wantAssembly[central] else { return }
      guard buf.count + chunk.count <= Self.maxWantBytes else {
        wantAssembly.removeValue(forKey: central)
        return
      }
      buf.append(chunk)
      wantAssembly[central] = buf
    }
    guard seq + 1 >= total, let full = wantAssembly.removeValue(forKey: central) else { return }
    // THE WANT PAYLOAD BEGINS WITH THE OFFER IT WAS DERIVED FROM (row 120).
    // A payload too short to hold one is not an ask this phone can attribute
    // to any offer, so it mints nothing — fail-closed, and the same road a
    // stale ask takes.
    guard let carried = Self.offerIdentity(from: full, at: 0) else {
      NSLog("crew//want-refused peer=\(central.uuidString) reason=no-offer-identity")
      return
    }
    let ids = full.subdata(in: (full.startIndex + Self.offerIdentityBytes) ..< full.endIndex)
    // fresh want = fresh response stream; JS assembles it
    msgBuffers.removeValue(forKey: central)
    msgCursor.removeValue(forKey: central)
    msgFrame.removeValue(forKey: central)
    // THE ASK IS MINTED AGAINST THE OFFER IT NAMES, or it is not minted at
    // all (the stale-offer refusal).
    //
    // TWO SHAPES HAVE BEEN REFUTED HERE, and both are worth naming because
    // each looked like the cure for the one before it. The first STAMPED
    // FROM THE GLOBALS — whatever (epoch, rev) this phone published when the
    // want arrived — so a want built against A was stamped B and every later
    // check agreed with itself. The second recorded, per central, the offer
    // that central COMPLETED a pull under, and compared THAT to the live
    // offer. It reads like the invariant, and it is still self-satisfying:
    // the client's second pass re-reads the digest before it writes the
    // want, so the record it is compared against was overwritten with B by
    // the very pass that carries the A-derived ids. Sequential passes are
    // enough; no concurrency is needed to reach it.
    //
    // So the ASK CARRIES ITS OWN OFFER. `carried` was parsed off the front
    // of the want payload — the identity JS held beside the ids it derived
    // from that exact digest read — and it is compared against what this
    // phone publishes NOW. B may be a new session OR a same-epoch republish;
    // both move the live identity and both refuse here.
    //
    // THE REFUSAL IS THE RETRY ROAD, not a dropped connection: no ticket is
    // minted and no want reaches JS, so the central's next MSG_CHAR read is
    // answered with the not-ready frame (total=0) and its client re-runs the
    // exchange from the digest — reading offer B, deriving under B, and
    // asking again while naming it.
    let live = liveOffer
    guard carried == live else {
      // stale-offer: the ask names a digest this phone no longer publishes.
      NSLog(
        "crew//want-refused peer=\(central.uuidString) reason=stale-offer " +
          "asked=\(carried.epoch)/\(carried.rev)/\(carried.generation) " +
          "live=\(live.epoch)/\(live.rev)/\(live.generation)"
      )
      return
    }
    // THE WANT CARRIES THE REQUEST'S IDENTITY BESIDE THE BYTES (M5/M6,
    // matching Android's ticket fields). `requestId` names this exact ask so
    // an answer can be matched to it rather than to "whatever this central
    // most recently wanted", and `serverEpoch` is the offer the ask was
    // built against — an answer computed for a digest this phone has since
    // replaced is answering a question nobody asked any more.
    wantTicketSeq += 1
    // …AND THE PHONE REMEMBERS THE ASK, not just the asker. This is the one
    // request open for this central; the previous one (if the central wrote
    // again while JS was computing) is replaced right here, which is the
    // same sentence the three removeValue lines above say about its bytes.
    // …and the ticket is stamped from the CARRIED identity rather than from
    // the globals. They are equal here by the guard above, and writing it
    // this way is what keeps them equal: a future edit that loosens the
    // guard cannot silently go back to stamping whatever is current.
    openWant[central] = OpenWant(id: wantTicketSeq, epoch: carried.epoch, rev: carried.rev)
    sendEvent(withName: Self.syncWantEvent, body: [
      "peerId": central.uuidString,
      "payload": ids.base64EncodedString(),
      "requestId": NSNumber(value: wantTicketSeq),
      "serverEpoch": NSNumber(value: digestEpoch),
    ])
  }

  // ------------------------------------------------------------ payload

  @objc(setPayload:resolver:rejecter:)
  func setPayload(
    _ payloadB64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = Data(base64Encoded: payloadB64) else {
      reject("payload", "payload is not base64", nil)
      return
    }
    // ONTO THE OWNER QUEUE — the reopen is confined too, not only the
    // retirement. This was the last off-main writer of surface state, and
    // the race it left is exact: cleanup A claims generation G on main
    // while React Native writes `payload` and clears the gate from
    // `_sharedModuleQueue`, so A's destructive body then empties the
    // payload session B had just installed and B advertises in front of
    // nothing. A CAS on one side of a race is not a CAS.
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      self.payload = data
      // A PAYLOAD IS THE SURFACE RE-OPENING. stopAll/invalidate retired it;
      // the next session sets one before it advertises, and that is the verb
      // that legitimately lifts the surface gate (see retireMeshScope). The
      // write and the reopen are now ONE step on ONE queue, which is what
      // makes the cleanup's CAS decisive: a cleanup that lost its race
      // cannot interleave between them.
      self.clearRetired(mesh: false, surface: true)
      // Unlike Android, the advertisement itself carries no payload here —
      // the GATT characteristic serves the field directly, so no restart is
      // needed.
      resolve(nil)
    }
  }

  /**
   The UNSCOPED publish, kept exactly as it was for a JS build that does not
   carry its session with its offer (Android keeps the same twin). It
   installs unconditionally and marks the service readable.
   */
  @objc(setSyncDigest:resolver:rejecter:)
  func setSyncDigest(
    _ b64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    installDigest(b64, epoch: nil, rev: nil, resolve: resolve, reject: reject)
  }

  /**
   THE SCOPED PUBLISH: this offer belongs to mesh session `radioEpoch` and is
   that session's revision `digestRevision` (M5/M6, mirroring Android's
   publishSyncDigest).

   A publish is installed only when it is strictly NEWER than what is held —
   a later epoch, or a later revision inside the same epoch. That refusal is
   the point rather than a nicety: pushDigest runs on every message-store
   change, so several publishes can be in flight across the bridge at once
   and one of them can belong to a session that has already ended. Installed,
   it becomes this phone's offer to the whole pod until the next store
   change happens along.

   THE PROMISE IS THE ACK. JS records nothing as installed until it resolves,
   and the digest characteristic answers "not ready" until then — so a stale
   publish must REJECT, never resolve: a resolve would tell JS that a dead
   session's offer is the live one.
   */
  @objc(publishSyncDigest:radioEpoch:digestRevision:resolver:rejecter:)
  func publishSyncDigest(
    _ b64: String,
    radioEpoch: NSNumber,
    digestRevision: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    installDigest(
      b64,
      epoch: radioEpoch.int64Value,
      rev: digestRevision.int64Value,
      resolve: resolve,
      reject: reject
    )
  }

  /// Strictly newer, lexicographically by (epoch, revision). On `bleQueue`.
  private func newerThanInstalled(_ epoch: Int64, _ rev: Int64) -> Bool {
    epoch > digestEpoch || (epoch == digestEpoch && rev > digestRev)
  }

  private func installDigest(
    _ b64: String,
    epoch: Int64?,
    rev: Int64?,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = Data(base64Encoded: b64) else {
      reject("payload", "digest is not base64", nil)
      return
    }
    // Onto the confinement queue, which is where every read of this state
    // happens: this method arrives on React Native's own method queue, and
    // the roster cap below means one queue can now evict a central the
    // other is actively serving.
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      if let epoch, let rev, !self.newerThanInstalled(epoch, rev) {
        // REJECTED, not silently dropped: JS must not record a stale offer
        // as the installed one, and a promise that resolved would say it
        // did.
        reject("stale", "a newer digest is already published", nil)
        return
      }
      self.syncDigest = data
      self.digestGeneration += 1
      self.digestReady = true
      // AN INSTALLED OFFER IS THE MESH SCOPE RE-OPENING — the one verb that
      // lifts the retired gate a stop published. Nothing else does: a live
      // session must publish before this phone serves anybody again.
      self.clearRetired(mesh: true, surface: false)
      if let epoch, let rev {
        self.digestEpoch = epoch
        self.digestRev = rev
      }
      resolve(nil)
    }
  }

  /**
   JS answers a CrewSyncWant with the assembled message bytes; the MSG_CHAR
   stream serves them out in frames.

   THE ANSWER IS MATCHED TO ITS REQUEST, and refused when it cannot be — the
   iOS half of Android's ticket rule, and the reason this method takes four
   arguments instead of two. It used to install by PEER: `msgBuffers[id] =
   data`, with nothing consulted. A peer is a name, not a question, and the
   name outlives the ask.

   Four refusals, each a resolved REASON rather than a rejection, because a
   refusal is a normal answer here and JS logs it against the want:

     invalidated     — the id is at or below the stop watermark. A session
       ended (or the radio stopped) after this want was handed up, so this
       reply belongs to a pod that no longer exists. Permanent: ids only go
       up, so this never becomes true again for a live request.
     no-open-request — nothing is open for this central. Nothing asked, so
       nothing is served: a buffer written here would be read by the NEXT
       want as its own answer.
     stale-request   — something is open, but not this id. The central wrote
       again while JS was computing, so these rows were chosen for a request
       that no longer exists; the newer answer is still coming.
     stale-epoch     — the id matches, and the offer it was built against is
       not the one this phone publishes now. The want was answering a digest
       we have since replaced or withdrawn.

   Refusing is always safe BECAUSE of the not-ready protocol: with no buffer
   installed the MSG_CHAR read answers a total=0 frame and the central
   retries (NOT_READY_RETRY_MS), which is the same sentence it already hears
   while JS is still assembling.
   */
  @objc(provideSyncMessages:requestId:serverEpoch:payload:resolver:rejecter:)
  func provideSyncMessages(
    _ peerId: String,
    requestId: NSNumber,
    serverEpoch: NSNumber,
    payload b64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let id = UUID(uuidString: peerId), let data = Data(base64Encoded: b64) else {
      reject("payload", "bad peer id or base64", nil)
      return
    }
    let askedId = requestId.int64Value
    let askedEpoch = serverEpoch.int64Value
    // Onto the confinement queue: openWant, the watermark and every buffer
    // below are read and written by the radio's own callbacks, and this
    // method arrives on React Native's method queue.
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      let open = self.openWant[id]
      let refusal: String?
      if askedId <= self.wantInvalidBefore {
        refusal = "invalidated"
      } else if open == nil {
        refusal = "no-open-request"
      } else if open!.id != askedId {
        refusal = "stale-request"
      } else if askedEpoch != self.digestEpoch ||
        open!.epoch != self.digestEpoch ||
        open!.rev != self.digestRev {
        refusal = "stale-epoch"
      } else {
        refusal = nil
      }
      guard refusal == nil else {
        resolve(refusal)
        return
      }
      // ONE ANSWER PER REQUEST. The ask is consumed here, so a duplicate
      // reply bearing the same id finds no open request rather than
      // re-installing over a stream the central has begun reading.
      self.openWant.removeValue(forKey: id)
      self.trackCentral(id)
      self.msgBuffers[id] = data
      self.msgCursor[id] = 0
      self.msgFrame.removeValue(forKey: id)
      resolve(nil)
    }
  }

  // ------------------------------------------------------------ advertise

  /**
   THIN BRIDGE SHELL — and every scan/advertise verb below is one.

   REACT NATIVE CALLS THESE ON `_sharedModuleQueue`. Before this shape they
   read and wrote `wantScanning`, `scanning`, `startScanPromise` and the
   managers themselves from there, DIRECTLY, while the CoreBluetooth
   callbacks and the `.radio` retirement read and wrote the same fields on
   main. That is not staleness, it is a data race: a Swift `Bool` and a
   Swift tuple written from two queues at once are undefined behaviour, and
   the specific losses are a scan LEVEL that is neither true nor false and a
   promise settled twice or never. A per-state clear cannot fix it, because
   there is no state at which both writers agree.

   So the intent, the level, the promise and every CoreBluetooth call enter
   ONE owner queue (`onBle`, which runs inline when the caller is already
   there, so a delegate callback keeps its ordering exactly). The promise is
   settled only from that queue — `settleScan` / `settleAdvertise` are the
   only two places it happens — and the owner queue is then the ONLY writer
   of scan and advertise state anywhere in this module.
   */
  @objc(startAdvertising:rejecter:)
  func startAdvertising(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      guard !self.payload.isEmpty else {
        reject("payload", "setPayload first", nil)
        return
      }
      // SETTLE THE OLD ASKER BEFORE TAKING ITS SLOT. `startAdvertisePromise`
      // is ONE deep, and a second start while the first is still held — a
      // re-arm racing the camper's own tap, share.ts retrying behind a
      // resume — used to overwrite the record and ORPHAN the promise it
      // replaced: JS awaits a settlement nothing in the process can ever
      // deliver, which is the hang `.unsupported` and `.unknown` were fixed
      // for, reached from the other end. Superseded is a REJECTION with a
      // reason, taken through the one settlement road so the record is
      // cleared before anything is called out to.
      self.settleAdvertise(
        .reject(code: "superseded", message: "a newer startAdvertising replaced this one")
      )
      self.wantAdvertising = true
      self.startAdvertisePromise = (resolve, reject)
      if self.peripheralManager == nil {
        // Creating the manager IS the OS permission ask (NSBluetooth
        // string); its state callback triggers the reconcile that carries
        // the verdict and finishes the promise.
        self.peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
      } else {
        self.reconcileRadioState("start-advertising")
      }
    }
  }

  @objc(stopAdvertising:rejecter:)
  func stopAdvertising(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      self.wantAdvertising = false
      self.guardedStep("stopAdvertising", "stop-advertising") {
        self.peripheralManager?.stopAdvertising()
      }
      // THE LEVEL IS READ BACK FROM THE FRAMEWORK, never assumed. See
      // reconcileRadioState: `isAdvertising` is the object that owns the
      // fact, and a mirror set by hand is exactly the lying flag this
      // module spent two commits chasing.
      self.advertising = self.peripheralManager?.isAdvertising ?? false
      self.emitState()
      resolve(nil)
    }
  }

  // ------------------------------------------------------------ scan

  @objc(startScan:rejecter:)
  func startScan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      // THE SAME ONE-DEEP RULE AS THE ADVERTISE HALF. A second startScan
      // over an unresolved one orphaned the first promise; it is settled as
      // superseded, through `settleScan`, before this one takes the slot.
      self.settleScan(
        .reject(code: "superseded", message: "a newer startScan replaced this one")
      )
      self.wantScanning = true
      self.startScanPromise = (resolve, reject)
      if self.centralManager == nil {
        self.centralManager = CBCentralManager(delegate: self, queue: nil)
      } else {
        self.reconcileRadioState("start-scan")
      }
    }
  }

  @objc(stopScan:rejecter:)
  func stopScan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      self.wantScanning = false
      self.guardedStep("stopScan", "stop-scan") { self.centralManager?.stopScan() }
      self.cancelRescan()
      // Read back, not assumed — same rule as stopAdvertising above.
      self.scanning = self.centralManager?.isScanning ?? false
      self.emitState()
      resolve(nil)
    }
  }

  /**
   FOREGROUND FAST PATH (field report 2026-08-25), the iOS half. While the
   app is on screen JS asks for the low-latency posture — the human is
   watching the pod and seconds matter — and hands back the frugal one when
   the app backgrounds or the session stops. On this platform the knob is
   CBCentralManagerScanOptionAllowDuplicatesKey plus the frugal rescan tick
   (see frugalRescanInterval); a scan restart, unlike an advertise restart,
   has no identity cost, because scanning owns no address. The ADVERTISE
   interval deliberately has no such knob on either platform: restarting the
   advertisement mints a fresh random address and re-opens the rotation
   wound the AdvertisingSet path closed.

   Two iOS truths this cannot paper over, and does not try to: backgrounded,
   the OS ignores allowDuplicates and coalesces scans on its own, and a
   suspended app's rescan tick does not fire. So the posture is stored
   regardless and applied wherever it still means something — which also
   keeps the reverse arc real, because the next foreground start reads the
   posture this call left behind.
   */
  @objc(setScanMode:resolver:rejecter:)
  func setScanMode(
    _ lowLatency: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // ONTO THE OWNER QUEUE, through the same helper every other bridge
    // entry uses. This arrives on React Native's own method queue, and the
    // posture, the level and the CoreBluetooth calls below all belong to
    // the one owner.
    onBle { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      guard self.scanLowLatency != lowLatency else {
        resolve(nil)
        return
      }
      self.scanLowLatency = lowLatency
      // THE ACTUAL LEVEL FROM THE OBJECT THAT OWNS IT, not from the mirror.
      guard let central = self.centralManager, central.isScanning,
            central.state == .poweredOn else {
        // Stored posture only; the next startScan reads it.
        resolve(nil)
        return
      }
      // No emitState around this: `scanning` is true before and after, and
      // a momentary false would read to the JS honesty machine (session.ts)
      // as a radio interruption over a radio that never stopped.
      self.guardedStep("stopScan", "scan-posture") { central.stopScan() }
      self.beginScan(central)
      resolve(nil)
    }
  }

  /** Bring the scan up under the CURRENT posture — the one place that
   decides a duty cycle, shared by the startScan path and the posture flip
   so the two can never drift. */
  @discardableResult
  private func beginScan(_ central: CBCentralManager) -> String? {
    // THE RAISE IS RETURNED, NOT SWALLOWED. `guardedStep` keeps a throwing
    // CoreBluetooth call from aborting the process; it does not make the
    // scan have happened. The caller that owns a promise needs to know
    // WHICH of the two occurred — see driveScan.
    let raised = guardedStep("scanForPeripherals", "begin-scan") {
      central.scanForPeripherals(
        withServices: [Self.serviceUUID],
        // Duplicates ON in the low-latency posture: each repeat sighting
        // refreshes presence liveness, and the JS presence store is the
        // dedupe layer, not the radio. OFF is the frugal posture, which the
        // rescan tick below keeps from becoming silence.
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: self.scanLowLatency]
      )
    }
    // THE LEVEL IS THE FRAMEWORK'S, READ BACK. If the call raised, or the
    // manager refused, `isScanning` says so and this module does not carry
    // a flag claiming otherwise.
    scanning = central.isScanning
    armRescan()
    return raised
  }

  /** The frugal posture's re-report tick. Only a stop/start makes
   CoreBluetooth report an already-discovered peripheral again with
   duplicates off, so that is what this does. It does not re-arm itself
   from inside beginScan, so a posture flip is the only thing that
   reschedules it. */
  private func armRescan() {
    cancelRescan()
    guard !scanLowLatency else { return }
    rescanTimer = Timer.scheduledTimer(
      withTimeInterval: Self.frugalRescanInterval,
      repeats: true
    ) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      guard !self.scanLowLatency, self.wantScanning,
            let central = self.centralManager, central.state == .poweredOn,
            central.isScanning else { return }
      self.guardedStep("stopScan", "rescan-tick") { central.stopScan() }
      self.guardedStep("scanForPeripherals", "rescan-tick") {
        central.scanForPeripherals(
          withServices: [Self.serviceUUID],
          options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
      }
      self.scanning = central.isScanning
    }
  }

  /**
   A Timer must be invalidated from the thread that installed it, and this
   one is installed on main (beginScan runs there, on the CoreBluetooth
   queue). stopScan and stopAll arrive on React Native's own method queue,
   so those calls have to hop — while armRescan, already on main, must NOT,
   because it cancels and immediately reschedules and a deferred cancel
   would kill the timer it just installed.
   */
  private func cancelRescan() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.rescanTimer?.invalidate()
        self?.rescanTimer = nil
      }
      return
    }
    rescanTimer?.invalidate()
    rescanTimer = nil
  }

  // ------------------------------------------- the radio reconciler

  /**
   THE STATE TABLE. Every `CBManagerState` has a terminal policy, and there
   is no `default:` road left for a promise to hang on.

   THE ROAD THAT FORCED IT was `default: break // resetting/unknown resolve
   on the next state callback`, and the comment was true of exactly one of
   the states it covered. `.unsupported` is TERMINAL — no further update is
   ever coming — so a `startScan` on a device without BLE left
   `startScanPromise` pending FOREVER, and JS waited on a promise nothing
   in the process could settle. `.unknown` covers the same road with a
   different lie: the framework says an update is imminent, but nothing
   guarantees one, and a module that claims nothing while holding a
   promise open is indistinguishable from a hang.

     .poweredOn     EFFECT, THEN SETTLE. Drive the desired effect where the
                    actual level is down, and settle the asker after the
                    effect ran — never before it.
     .resetting     HOLD. The framework has promised a further update, the
                    actual level is down, and NOTHING settles: an ask
                    issued mid-bounce settles on the return, which is what
                    makes a bounce recovery a recovery. The DESIRE stands.
     .unauthorized  REJECT AND CLEAR, honestly — the camper denied the
                    permission and must be told so. The DESIRE stands, so a
                    permission granted in Settings comes back as
                    `.poweredOn` and re-enters the effect with no second JS
                    call.
     .unsupported   REJECT AND CLEAR. The promise TERMINATES, which is the
                    whole of the fix; the desire is harmless because no
                    state that could act on it will ever arrive.
     .poweredOff    REJECT AND CLEAR, and the shared radio retirement runs
                    (below). The desire stands and re-arms the scan.
     .unknown       FAIL CLOSED, WITH AN OUTCOME. We cannot say the radio is
                    up, so we do not claim it: the level is down and the ask
                    is rejected by name (`radio-unknown`). The alternative
                    — hold, and hope — is the hang wearing a different
                    label. The desire stands, so the imminent update, if it
                    comes, re-enters the effect autonomously.
   */
  private enum RadioPolicy {
    case run
    case hold
    case terminal(code: String, message: String)
  }

  private static func radioPolicy(for state: CBManagerState) -> RadioPolicy {
    switch state {
    case .poweredOn:
      return .run
    case .resetting:
      return .hold
    case .poweredOff:
      return .terminal(code: "bluetooth-off", message: "Bluetooth is off")
    case .unauthorized:
      return .terminal(code: "permission", message: "Bluetooth permission denied")
    case .unsupported:
      return .terminal(code: "unsupported", message: "Bluetooth LE is not supported")
    case .unknown:
      return .terminal(code: "radio-unknown", message: "the Bluetooth state is not known")
    @unknown default:
      return .terminal(code: "radio-unknown", message: "an unrecognised Bluetooth state")
    }
  }

  private static func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .resetting: return "resetting"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .unknown: return "unknown"
    @unknown default: return "unrecognised"
    }
  }

  private enum RadioSettlement {
    case resolve
    case reject(code: String, message: String)
  }

  /// THE ONLY PLACE `startScanPromise` IS SETTLED. Every road into it runs
  /// on the owner queue, so the check and the clear are atomic against the
  /// other roads by construction rather than by hope.
  private func settleScan(_ how: RadioSettlement) {
    guard let promise = startScanPromise else { return }
    startScanPromise = nil
    switch how {
    case .resolve:
      promise.resolve(nil)
    case let .reject(code, message):
      promise.reject(code, message, nil)
    }
  }

  /// The advertise half of the same rule.
  private func settleAdvertise(_ how: RadioSettlement) {
    guard let promise = startAdvertisePromise else { return }
    startAdvertisePromise = nil
    switch how {
    case .resolve:
      promise.resolve(nil)
    case let .reject(code, message):
      promise.reject(code, message, nil)
    }
  }

  /**
   THE ONE PLACE THE RADIO'S TRUTH IS READ AND BOTH EFFECTS ARE DRIVEN.

   WHY A RECONCILER RATHER THAN TWO CALLBACKS. Apple guarantees the delivery
   queue of EACH manager's callbacks; it guarantees nothing about the ORDER
   of two managers' event streams against each other. One physical radio
   does not make two streams one ordered truth, and the failures are
   symmetric:

    - A central `.poweredOn` arrives, the scan restarts, and THEN the
      peripheral's lagging `.poweredOff` lands. A callback that acted on its
      own event body would globally retire the scan it just started and
      cancel the rescan tick. The peripheral's own `.poweredOn` then arrives
      with `wantAdvertising` false, guard-returns, and leaves no cue at all
      — while the central, having already reported `.poweredOn`, need never
      emit again. The camper is deaf until they restart sharing.
    - The other order does the same damage the other way: a peripheral-only
      manager reset must not retire a central scan that never stopped.

   SO CALLBACKS ARE TRIGGERS ONLY. They note the state that changed (for the
   log, and for the terminal each manager owes its own asker) and call this,
   which reads the CURRENT state of BOTH managers, derives EACH actual level
   from the object that owns it, applies the shared radio fact ONCE, and
   re-drives each desired effect independently. A stale event body can
   trigger a reconcile; it can never write the other manager's level.
   */
  private func reconcileRadioState(_ trigger: String) {
    let central = centralManager
    let peripheral = peripheralManager
    let centralPolicy = central.map { Self.radioPolicy(for: $0.state) } ?? RadioPolicy.hold
    let peripheralPolicy = peripheral.map { Self.radioPolicy(for: $0.state) } ?? RadioPolicy.hold

    // (1) THE ACTUAL LEVELS, EACH READ FROM THE OBJECT THAT OWNS IT.
    //
    // THIS IS THE CLASS CURE. `scanning` was a mirror this file set by hand
    // on some roads and not others, so every new manager state was a fresh
    // chance to leave it lying — and a lying level is what turned the
    // poweredOn guard's else into a false success. `CBCentralManager
    // .isScanning` (iOS 9; this target is 15.1) and
    // `CBPeripheralManager.isAdvertising` (iOS 6) are the framework's own
    // answer to the same question, and no manager state can leave THEM
    // stale. The mirrors survive only as what `emitState` sends to JS, and
    // they are re-derived here on every radio event.
    scanning = central?.isScanning ?? false
    advertising = peripheral?.isAdvertising ?? false

    // (2) THE SHARED RADIO FACT, APPLIED EXACTLY ONCE.
    //
    // The radio is dead when a manager exists and NEITHER reports
    // `.poweredOn`. Reading both current states is what makes a lagging
    // `.poweredOff` harmless: by the time this runs the other manager
    // already says `.poweredOn`, so the hardware is up and nothing is
    // retired. A genuinely dead radio still takes the whole radio scope
    // with it — the passive connects, the offer, the published services —
    // exactly as the two poweredOff arcs used to do separately.
    let centralUp = central?.state == .poweredOn
    let peripheralUp = peripheral?.state == .poweredOn
    let radioDown = (central != nil || peripheral != nil) && !centralUp && !peripheralUp
    if radioDown {
      if !radioRetired {
        radioRetired = true
        NSLog("crew//radio-down trigger=\(trigger)")
        retireMeshScope(reason: "radio down", scope: .radio)
        // Re-derived after the retirement, because the retirement writes the
        // mirrors too and the framework is still the authority.
        scanning = central?.isScanning ?? false
        advertising = peripheral?.isAdvertising ?? false
      }
    } else {
      radioRetired = false
    }
    // …AND EACH MANAGER'S OWN BOOKKEEPING FROM ITS OWN STATE, never from the
    // other's event. CoreBluetooth drops PUBLISHED SERVICES with the
    // PERIPHERAL manager, so that fact is read off the peripheral; the
    // frugal rescan tick has nothing to poke while the CENTRAL is down, so
    // that one is read off the central.
    if !peripheralUp {
      serviceAdded = false
    }
    if !centralUp {
      cancelRescan()
    }

    // (3) RE-DRIVE EACH DESIRED EFFECT, INDEPENDENTLY, AFTER EITHER UPDATE.
    let scanNote = driveScan(central, centralPolicy)
    let advertiseNote = driveAdvertise(peripheral, peripheralPolicy)
    emitState(scanNote ?? advertiseNote)
  }

  /**
   THE SCAN'S DESIRED EFFECT, against the central's CURRENT policy.

   `desired && actual-down && this manager poweredOn` is the whole entry
   condition, and each of the three is read from the thing that owns it:
   the desire from `wantScanning` (which only a real stop retires), the
   actual level from `central.isScanning`, the manager from its own state.
   */
  @discardableResult
  private func driveScan(_ central: CBCentralManager?, _ policy: RadioPolicy) -> String? {
    switch policy {
    case .hold:
      // Nothing settles. The desire stands and the return re-enters here.
      return nil
    case let .terminal(code, message):
      // THE TERMINAL, REPORTED HONESTLY — and `wantScanning` is deliberately
      // NOT touched. The camper still WANTS to be scanning; the radio went
      // away, or the permission was refused, and their intent did not. That
      // surviving desire is exactly what makes the return automatic: the
      // recovery arms below re-enter `beginScan` with NO second JS call.
      settleScan(.reject(code: code, message: message))
      return message
    case .run:
      guard let central, wantScanning else { return nil }
      guard !central.isScanning else {
        // Already scanning: SETTLE the asker. A fresh startScan issued after
        // the recovery already happened must not hang — and this road is a
        // lie only when the level it reads is a lie, which is why the level
        // is the framework's.
        settleScan(.resolve)
        return nil
      }
      if let raised = beginScan(central) {
        // THE GUARDED FAILURE IS STILL A FAILURE. `guardedStep` exists so a
        // raising framework call cannot abort the process — it was never a
        // licence to report the effect as landed. Resolving here told JS the
        // scan was up over a central that is not scanning, and the camper is
        // deaf with a green session; leaving it pending is the same lie with
        // a hang instead of a claim. The asker is told what raised.
        settleScan(.reject(code: "scan-failed", message: raised))
        return raised
      }
      // AFTER THE EFFECT, never before it.
      settleScan(.resolve)
      return nil
    }
  }

  /** The advertise half, same three reads. */
  @discardableResult
  private func driveAdvertise(_ peripheral: CBPeripheralManager?, _ policy: RadioPolicy) -> String? {
    switch policy {
    case .hold:
      return nil
    case let .terminal(code, message):
      settleAdvertise(.reject(code: code, message: message))
      return message
    case .run:
      guard let peripheral, wantAdvertising else { return nil }
      guard !peripheral.isAdvertising else {
        // Already up: SETTLE the asker. A re-arm after a power cycle calls
        // startAdvertising again, and an unsettled promise there would leave
        // the session awaiting forever — reading "interrupted" over a
        // working radio.
        settleAdvertise(.resolve)
        return nil
      }
      // THE GATE, AT THE EFFECT SITE (S2): "CrewBeacon may advertise iff no
      // Walkie lease occupies any phase". Read HERE — on the line that would
      // actually radiate — and not at the JS call site, because the whole
      // class of failure this lane keeps producing is a decision taken
      // somewhere the radio cannot be seen from.
      //
      // THE SERVICE STAYS PUBLISHED, and that is the documented trade: what
      // a hold stops is being FOUND by a fresh scan. A central that already
      // holds this phone's address still reads the mailbox (share.ts holds
      // the reasoning). AND IT RESOLVES rather than failing: a held beacon
      // is a DEGRADED rung, and a degraded rung never fails the rung above.
      if WalkieAirtimeArbiter.shared.crewMayAdvertise == false || airtimeSuppressed {
        settleAdvertise(.resolve)
        return nil
      }
      if !serviceAdded {
        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        let mk = { (uuid: CBUUID, props: CBCharacteristicProperties, perms: CBAttributePermissions) in
          CBMutableCharacteristic(type: uuid, properties: props, value: nil, permissions: perms)
        }
        service.characteristics = [
          mk(Self.payloadChar, [.read], [.readable]),
          mk(Self.digestChar, [.read], [.readable]),
          mk(Self.wantChar, [.write], [.writeable]),
          mk(Self.msgChar, [.read], [.readable]),
        ]
        if let raised = guardedStep("addService", "reconcile", { peripheral.add(service) }) {
          // THE MIRROR DOES NOT GET AHEAD OF THE FRAMEWORK. `serviceAdded`
          // is this file's record that CoreBluetooth is holding the service;
          // setting it after a raise makes the NEXT reconcile skip the add
          // and advertise in front of nothing — a phone discoverable with no
          // characteristics to read, which is the lying-flag class this
          // module spent two commits removing. It stays false, the level is
          // re-derived from the peripheral, and the asker is told.
          advertising = peripheral.isAdvertising
          settleAdvertise(.reject(code: "advertise-failed", message: raised))
          return raised
        }
        serviceAdded = true
      }
      if let raised = guardedStep("startAdvertising", "reconcile", {
        peripheral.startAdvertising([
          CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
        ])
      }) {
        // AND THE ADVERTISE PROMISE HAS NO OTHER ROAD HOME. It settles on
        // `didStartAdvertising` — the framework's own confirmation — and
        // that callback is never coming for a call that raised, so the
        // asker waited forever. Same rule as the scan half: the level is
        // re-read from the peripheral, and the failure is reported.
        advertising = peripheral.isAdvertising
        settleAdvertise(.reject(code: "advertise-failed", message: raised))
        return raised
      }
      // The advertise promise settles on `didStartAdvertising` — the
      // framework's own confirmation that the effect landed — which is the
      // same "settle after the effect" rule the scan half keeps inline.
      return nil
    }
  }

  /**
   ONE APPLE-FRAMEWORK CALL, UNDER ObjCTry, ATTRIBUTED — and it lives HERE,
   on the module, rather than inside `retireMeshScope`, because the coverage
   is TRANSITIVE and a helper nested in one function cannot be transitive.

   The audit that forced this: `retireMeshScope` guarded its own four calls
   and then called `syncOwner?.cancel(reason)`, which runs the op's ordinary
   failure terminal, which runs `cleanup()`, which called
   `cancelPeripheralConnection` BARE. One raise out of that nested delegate
   cleanup aborts the process from inside a retirement that had already
   published its gate — the crash road the per-step guarding was added to
   close, reached one frame deeper. Every Apple-framework call reachable
   from a teardown now goes through this, including the nested owner and
   delegate cleanups, and each returns its own attribution string so the
   caller can name the FIRST raise rather than the last.
   */
  @discardableResult
  func guardedStep(_ name: String, _ context: String, _ body: () -> Void) -> String? {
    guard let raised = ObjCTry.run(body) else { return nil }
    let why = raised.reason ?? raised.name.rawValue
    NSLog("crew//retire-step-raised step=\(name) reason=\(context) why=\(why)")
    return "\(name): \(why)"
  }

  // -------------------------------------------------- the retirement

  /**
   HOW MUCH OF THIS PHONE A DEATH ROAD TAKES DOWN. Three scopes, because
   this module has three genuinely different deaths and the file used to
   spell each one out separately — which is how iOS's `invalidate` came to
   retire nothing but the sync client while Android's tore the whole server
   down.

   `.mesh`       the MESH SESSION's scope, and nothing else. The offer is
                 withdrawn and every buffer, cursor, recorded scope and open
                 question dies, but the advertisement, the published services
                 and the payload all stand: the camper is still sharing and
                 still discoverable. This is `endSession`, the verb a walkie
                 open/close and a pod change fire dozens of times an evening.
   `.radio`      `.mesh` plus the bookkeeping a POWER CYCLE forces on us.
                 CoreBluetooth drops published services when the radio goes
                 down, so `serviceAdded` has to go with them or the next
                 poweredOn advertises in front of nothing. The payload and
                 wantAdvertising/wantScanning survive on purpose: that is
                 what makes the automatic restart a restart.
   `.everything` the SHARING SURFACE as well. Advertising stops, the services
                 are removed, the payload is cleared, in-flight connections
                 are cancelled, and the surface gate is published so a read
                 that is already queued cannot be answered on the way out.
                 This is `stopAll` (the camper stopped sharing) and
                 `invalidate` (the bridge went away).
   */
  private enum RetirementScope {
    case mesh
    case radio
    case everything
  }

  /**
   THE ONE RETIREMENT, and every death road runs through it.

   WHAT IT RETIRES, in the order it retires it:
     - the operation on the radio (`syncOwner`), through its own terminal, so
       the owner record is cleared by the same check-and-set every other
       terminal uses;
     - the OFFER: syncDigest emptied, digestReady false, digestGeneration
       bumped so no central's stream survives as a continuation;
     - every per-central buffer, cursor, cached frame, part-assembled want
       and RECORDED DIGEST SCOPE (dropAllCentralState);
     - every outstanding want ticket, permanently, through the monotonic
       watermark (invalidateOpenWants inside the same helper).

   WHAT IT DELIBERATELY KEEPS: `digestEpoch` and `digestRev`. They are the
   FLOOR a later publish must beat (M5), and clearing them is exactly what
   would let a dying world's last publish — already in flight across the
   bridge when this ran — land afterwards and reinstall a dead pod's offer.

   ON THE CONFINED QUEUE. Every dictionary above is written by
   CoreBluetooth's own main-queue callbacks, so this body may only ever run
   there; `retireBeforeReturning` is what gets an off-main caller onto it
   without becoming another async enqueue.
   */
  private func retireMeshScope(
    reason: String,
    scope: RetirementScope,
    generation: Int64? = nil
  ) {
    // THE CAS IS THE FIRST ACT, BEFORE A SINGLE FIELD IS TOUCHED. A cleanup
    // that was dispatched by `retireBeforeReturning` carries the generation
    // its own publish minted; if the surface world has moved on since — a
    // NEWER retirement, or a legitimate reopen through setPayload /
    // installDigest — then this body belongs to a world that no longer
    // exists and it does nothing AT ALL. Not the gate, not wantAdvertising,
    // not the services, not the payload, not the offer. See the essay on
    // `retirementGen`. The roads that run inline on the confined queue (the
    // two poweredOff arcs) pass no generation and are their own barrier.
    if let generation {
      guard claimRetirementCleanup(generation) else {
        NSLog(
          "crew//retire-cleanup-stale gen=\(generation) " +
            "current=\(currentRetirementGeneration()) reason=\(reason)"
        )
        return
      }
    }
    // THE GATE IS PART OF THE RETIREMENT, not part of one caller's road.
    // retireBeforeReturning publishes it again ahead of the queue hop (that
    // is what makes an off-main call a barrier); publishing it here as well
    // is what makes it impossible to retire this module's scope by ANY road
    // without the gate going up. Idempotent, and both writes take the lock.
    publishRetired(mesh: true, surface: scope == .everything)
    // EVERY FRAMEWORK CALL BELOW RUNS UNDER ObjCTry, ONE STEP AT A TIME
    // (row 115, and the law Walkie.swift's tap install states). Swift cannot
    // catch an Objective-C exception, and CoreBluetooth raises them for its
    // own preconditions — a manager torn down under us, a service list
    // mutated from the wrong state. This whole body is reachable from a
    // finger (the camper toggling sharing off), so an unguarded raise here
    // is an ABORT in the middle of a retirement: the steps after the raising
    // one never run, and the camper is left advertising a surface the app
    // believes it retired. Per-step, so one raise costs exactly its own
    // step; the ORIGINAL failure is attributed at the end rather than
    // swallowed; and the retirement GATE above is already published, so even
    // a retirement that cannot complete is one no read can get behind.
    var firstRaise: String?
    func step(_ name: String, _ body: () -> Void) {
      guard let raised = self.guardedStep(name, reason, body) else { return }
      if firstRaise == nil {
        firstRaise = raised
      }
    }
    if scope == .everything {
      // THE SURFACE FIRST, because it is the half a previously-known central
      // can still reach: discovery, then the services behind it, then the
      // bytes those services were serving.
      wantAdvertising = false
      wantScanning = false
      step("stopAdvertising") { self.peripheralManager?.stopAdvertising() }
      step("stopScan") { self.centralManager?.stopScan() }
      step("removeAllServices") { self.peripheralManager?.removeAllServices() }
      payload = Data()
      scanning = false
      // AND NO ASK OUTLIVES THE SURFACE IT ASKED FOR. `.everything` retires
      // the desire, so nothing will ever drive these effects again in this
      // world — a promise left pending here is the same hang the state
      // table closed on `.unsupported`, reached by the other road.
      settleScan(.reject(code: "stopped", message: "sharing stopped"))
      settleAdvertise(.reject(code: "stopped", message: "sharing stopped"))
      // NOTHING IS OWED TO ANYBODY ANY MORE. `.everything` is the road on
      // which this module stops answering at all, so a debt kept past it
      // would only ever swallow the first callback of a world that has not
      // been built yet.
      passiveOwed.removeAll()
      passiveOwedOverflow.removeAll()
    }
    if scope != .mesh {
      // A power cycle took the services with it; a full stop just removed
      // them. Either way the next poweredOn must re-add ours rather than
      // believe it is still published.
      cancelRescan()
      serviceAdded = false
      advertising = false
      // AND THE SCAN LEVEL DIES WITH THE RADIO TOO, for the same reason the
      // advertise level above it does — the scope is the HARDWARE, and a
      // scan cannot outlive the adapter it ran on. This lived in the
      // `.everything` branch alone, and both poweredOff arcs take `.radio`,
      // so `scanning` stayed TRUE across a power cycle. The poweredOn guard
      // is `wantScanning, !scanning`, whose else branch RESOLVES the pending
      // startScan and returns: off -> on then reported a successful recovery
      // to JS while no scan was ever restarted, and the phone went deaf for
      // the rest of the session with a green state event behind it.
      //
      // `wantScanning` is deliberately NOT touched here. The camper still
      // WANTS to be scanning — the radio went away, their intent did not —
      // and that surviving desire is exactly what makes the poweredOn arc
      // re-arm by itself. The DESIRE outlives the outage; the ACTUAL LEVEL
      // does not. Only `.everything` (a real stop) retires the desire.
      scanning = false
      // …AND THE PASSIVE READS ON THE CENTRAL SIDE GO WITH THE RADIO (row
      // 116). This used to live in the `.everything` branch alone, so the
      // two poweredOff arcs — which both take `.radio` — left the in-flight
      // entries standing. Two payload fallback connects occupy the cap of
      // two, the adapter powers off before either callback lands, the
      // entries survive, and after power-on EVERY rediscovery is refused by
      // a cap held by connections that died with the hardware. The eight-
      // second fallback is not a terminal for this: its guard returns
      // without finishing when a mesh sync owns the radio, and nothing
      // re-arms it. So the cancel and the clear happen on the RADIO scope,
      // where the hardware fact is, and `.mesh` stays as narrow as it was —
      // ending a mesh session must never cost the camper a passive read.
      //
      // The bump is what makes the LATE callbacks of those cancelled
      // connections inadmissible: see PassiveConnect and `dropPassive`.
      for entry in inFlight.values {
        step("cancelPeripheralConnection") {
          self.centralManager?.cancelPeripheralConnection(entry.peripheral)
        }
        // …AND THE FRAMEWORK STILL OWES US ONE TERMINAL FOR EACH. Cancelling
        // does not un-schedule a delegate callback, it causes one; the entry
        // is gone a line below, so without this ledger that terminal would
        // arrive as an anonymous `didDisconnect` for a peripheral whose
        // CURRENT entry belongs to whatever connect opened next. Record the
        // exact op; `dropPassive` pays the debt and clears nothing.
        oweTerminal(entry.peripheral.identifier, entry.opId)
      }
      inFlight.removeAll()
      radioGeneration &+= 1
    }
    // THE MESH SCOPE ITSELF, which every road retires — AND IT IS A STEP.
    // `cancel` runs the op's ordinary failure terminal, which runs its
    // `cleanup()`, which touches CoreBluetooth. The coverage is transitive
    // or it is not coverage: this call is the doorway to the nested
    // framework calls the audit found bare, and each of those is guarded at
    // its own site as well (SyncOp.cleanup).
    step("syncOwnerCancel") { self.syncOwner?.cancel(reason) }
    syncDigest = Data()
    digestReady = false
    digestGeneration += 1
    dropAllCentralState()
    // digestEpoch / digestRev STAY. See the essay above.
    if let firstRaise {
      // ATTRIBUTED, NOT SWALLOWED. Every step above ran; this names the one
      // that raised first, which is the sentence a crash-free-but-degraded
      // radio needs in a 3am log.
      NSLog(
        "crew//retire-incomplete reason=\(reason) scope=\(scope) first=\(firstRaise)"
      )
    }
  }

  /**
   THE SYNCHRONOUS RETIREMENT BARRIER — retirement is EFFECTIVE before this
   returns, whatever queue called it.

   WHY THIS IS NOT `onBle { … }`. React Native runs `invalidate` on
   `_sharedModuleQueue` (this module declares no methodQueue and
   requiresMainQueueSetup is false), and the teardown retains the module only
   until its invalidation group finishes. An `onBle` enqueue from there
   RETURNS with the peripheral manager, the services, msgFrame, msgBuffers
   and openWant all live and all still callback-capable — which is the
   reported bug reproduced inside its own fix.

   WHY IT IS NOT `DispatchQueue.main.sync` EITHER, which was the shape asked
   for. That is safe only if main is never blocked waiting on the module
   queue during teardown, and against RN 0.87 that cannot be proven: bridge
   and RCTHost invalidation are routinely INITIATED from main and wait on the
   module queue's group, so a main.sync from `_sharedModuleQueue` is a
   genuine deadlock and an unprovable claim is not a barrier.

   SO THE BARRIER IS THE GATE, AND THE HOP IS BOUNDED. The retired gate is
   published first, atomically, from the calling queue — after that line no
   main-confined read can serve anything in this scope, so the retirement is
   already in force. The confined cleanup is then dispatched and waited on
   for at most `retirementBarrierTimeout`; if the wait expires (main busy,
   main blocked on us) the cleanup still lands later and the gate has been
   holding the whole time. Fail-closed in both directions.

   `self` IS CAPTURED STRONGLY, on purpose. A `[weak self]` cleanup queued
   during teardown is a cleanup that can simply disappear when the module is
   released — which is the other half of the finding, and it is the half that
   makes "deallocation eventually" not a barrier.
   */
  private func retireBeforeReturning(reason: String, scope: RetirementScope) {
    // THE GATE AND THE GENERATION ARE ONE WRITE. What comes back names the
    // surface world this call closed, and it is the only thing the queued
    // cleanup below is entitled to act on.
    let generation = publishRetired(mesh: true, surface: scope == .everything)
    if Thread.isMainThread {
      // Already on the confined queue: inline, exactly as onBle would, and
      // NEVER main.sync from main (that deadlocks by construction).
      retireMeshScope(reason: reason, scope: scope, generation: generation)
      return
    }
    let done = DispatchSemaphore(value: 0)
    Self.bleQueue.async {
      self.retireMeshScope(reason: reason, scope: scope, generation: generation)
      done.signal()
    }
    if done.wait(timeout: .now() + Self.retirementBarrierTimeout) == .timedOut {
      // THE TIMEOUT ROAD, SAID OUT LOUD. We return with the gate HELD — that
      // is the fail-closed half, unchanged — and the cleanup still queued.
      // Whether it ever lands is now irrelevant to the world that replaces
      // this one: it carries `generation`, and any reopen mints past it.
      NSLog(
        "crew//retire-barrier-timeout reason=\(reason) gen=\(generation) " +
          "gate=held cleanup=queued"
      )
    }
  }

  /**
   THE SHARING SESSION'S BARRIER — and this is the mailbox ship-gate
   minimum on iOS (audit, 2026-08-27).

     "stop retires the GATT services, clears digest/payload buffers and
     handlers so previously-known centrals lose access."

   WHAT THIS USED TO LEAVE STANDING, and why it is a leak rather than a
   trade. `stopAdvertising()` ends DISCOVERY and nothing else: the
   published service survives it, and a central that has already seen this
   phone keeps its address. That asymmetry is deliberately correct while
   the WALKIE holds the airtime — the camper is still sharing, mail should
   still flow, and share.ts argues the whole trade out loud. It is exactly
   wrong when SHARING ITSELF ENDS. Then a peer who was in the pod ten
   minutes ago could still connect, read the payload characteristic, and
   pull the digest, because everything behind the advertisement was still
   there and still answering.

   So this retires the surface as well as the announcement: the services
   go, the identity buffers this phone would serve go, and every
   per-central cursor and part-assembled frame goes with them. What a
   previously-known central finds afterwards is a phone with nothing
   published — not a quiet advertisement in front of a live mailbox.

   ON MAIN, because that is the CoreBluetooth queue these managers were
   built on and where every read/write handler touches these dictionaries;
   a Swift Dictionary written from two queues at once is undefined
   behaviour, not merely stale.
   */
  @objc(stopAll:rejecter:)
  func stopAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // EVERYTHING, AND BEFORE THIS RETURNS. The whole list used to be spelled
    // out here inside an `onBle` enqueue, which meant the documented barrier
    // resolved its promise with the services still published and a queued
    // read still able to answer from them — and it meant `invalidate` had a
    // second, shorter copy of the same list that had drifted to nothing.
    // One function, one list, one barrier.
    retireBeforeReturning(reason: "radio stopped", scope: .everything)
    emitState()
    resolve(nil)
  }

  /**
   END THE NATIVE MESH SESSION — the cancel JS's arbiter needs (meshSync's
   endNativeSession), and the iOS twin of Android's endSession.

   AND ITS RELATIONSHIP TO stopAll, SAID PLAINLY, because they overlap and a
   reader who guesses will delete one of them:

     `stopAll` is the SHARING SESSION'S barrier. The camper stopped sharing,
     so the surface is retired — services removed, payload gone, every
     previously-known central locked out. It is about who may reach this
     phone at all.

     `endSession` is the MESH SESSION'S barrier. The radio stays up and the
     pod stays reachable; what ends is the SCOPE — this mesh session's
     in-flight sync and the offer it published. It is the verb a walkie
     open/close or a pod change fires, dozens of times in an evening, and
     it must not cost the camper their discoverability.

   Before this verb a stop could not reach the radio at all: stopAll left
   the client exactly where it found it on the iPhone, so an operation begun
   by a session that no longer exists ran to its own 60-second timeout while
   the session that REPLACED it could not dial — the JS slot released a
   minute late, or never.

   THE EPOCH AND THE REVISION STAY. They are the FLOOR a later publish has to
   beat, and clearing them is what would let the dying session's own last
   publish — already in flight across the bridge — land after this and
   reinstall a dead pod's offer. The session that replaces this one carries a
   higher epoch and installs immediately.

   AND IT IS A BARRIER, NOT A REQUEST (row 107). This verb used to enqueue
   its retirement onto the confined queue and return, and JS never awaited
   the promise anyway — so `stopMeshSync()` could hand control back, the UI
   could finish saying "off", and the services, the buffers and the open
   wants were all still live and still readable. Both halves are closed now:
   the native side completes its retirement before this call returns (see
   retireBeforeReturning), and the JS lifecycle awaits the promise through
   teardownSession (share.ts). Belt and braces on purpose — an async road
   that "usually wins" is the exact shape a Jest stub hides for a year.
   */
  @objc(endSession:rejecter:)
  func endSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // THE MESH SCOPE ONLY. The advertisement, the published services and
    // the payload all stand: this verb must not cost the camper their
    // discoverability, which is the whole distinction from stopAll above.
    retireBeforeReturning(reason: "session ended", scope: .mesh)
    resolve(nil)
  }

  // -------------------------------------------------- the airtime sink

  /**
   THE BRIDGE GOES AWAY, AND SO DOES EVERYTHING IT WAS SERVING.

   THIS IS THE CURE for the cross-family blocker on 18758e8. A PRODUCTION
   appearance change reloads the React instance (SettingsScreen ->
   ThemeReload), which invalidates every module — and NOTHING in JS runs on
   that road: no stopMeshSync, no endSession, no stopAll. The JS world simply
   stops existing and a new one starts. So whatever this method leaves
   standing is what a stranger can still read while the replacement world
   boots.

   What it used to leave standing was everything except the sync client: the
   peripheral manager, the published services, the payload, the digest offer,
   every per-central cursor and — the reachable trace the review wrote — the
   answer this phone had already assembled for central C under the session
   that just died. It cancelled `syncOwner` through an ASYNC enqueue and
   returned, so even that one line was not in force at the return. C reads
   MSG_CHAR, gets session A's mail, and the world it belonged to is gone.

   Now it takes the same scope stopAll takes, through the same function, as a
   synchronous barrier: retirement is effective before this returns even
   though React Native calls us off-main, and a read already queued on main
   finds the gate rather than A's bytes. Android's `invalidate` has always
   done this (stopAdvertisingInternal(keepServer = false) -> stopGattServer);
   the parity is now structural rather than a coincidence of two lists.
   */
  override func invalidate() {
    // The arbiter's view of us goes first: a suppression in flight must not
    // be answered by a module that is coming down.
    airtimeSuppressed = false
    // EVERYTHING, SYNCHRONOUSLY, INCLUDING THE OP. A sync in flight holds a
    // promise whose resolve/reject blocks belong to a bridge that is going
    // away; it dies through the ordinary failure road inside the retirement,
    // on the confinement queue, so the owner record is cleared by the same
    // check-and-set every other terminal uses.
    retireBeforeReturning(reason: "bridge invalidated", scope: .everything)
    super.invalidate()
  }
  @objc(isSupported:rejecter:)
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(true) // every supported iPhone has BLE; state events carry denial
  }

  // Phase C is Android's foreground service; iOS rides its declared
  // background modes. These exist so JS can call them unconditionally.
  @objc(startForegroundSession:rejecter:)
  func startForegroundSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  @objc(stopForegroundSession:rejecter:)
  func stopForegroundSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  // ------------------------------------------------------------ sync client

  @objc(syncWithPeer:want:resolver:rejecter:)
  func syncWithPeer(
    _ peerId: String,
    want wantB64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // ADMISSION HAPPENS ON THE CONFINEMENT QUEUE, and it is the same queue
    // the terminal clears under. This method arrives on React Native's own
    // method queue, so the old shape read `syncOp`, decided the radio was
    // free, and wrote the field — three steps, none of them atomic against
    // a terminal landing on main between any two of them. That is the
    // check-then-set Android's owner-record essay traces to two clients on
    // one radio.
    onBle { [weak self] in
      guard let self else {
        reject("stopped", "the beacon went away", nil)
        return
      }
      guard self.syncOwner == nil else {
        // The one-at-a-time mutex, and it now names the op that has the
        // radio — which is what a 3am log needs.
        reject("busy", "another sync is running", nil)
        return
      }
      guard let id = UUID(uuidString: peerId) else {
        reject("peer", "unknown peer id", nil)
        return
      }
      guard let central = self.centralManager, central.state == .poweredOn else {
        reject("bluetooth-off", "Bluetooth is off", nil)
        return
      }
      let want = wantB64.isEmpty ? Data() : (Data(base64Encoded: wantB64) ?? Data())
      guard let peripheral = central.retrievePeripherals(withIdentifiers: [id]).first else {
        reject("peer", "peer not seen recently", nil)
        return
      }
      // The op is BUILT here so the record can name the exact object: "the
      // radio is busy" and "which operation has it" are one fact, and the
      // whole defect was storing only the first half.
      self.syncOpSeq += 1
      let op = SyncOp(
        module: self,
        peripheral: peripheral,
        want: want,
        resolve: resolve,
        reject: reject,
        opId: self.syncOpSeq
      )
      self.syncOwner = op
      op.start()
    }
  }

  /**
   THE CLEAR, AND IT NAMES THE OP. A late terminal from an operation that no
   longer owns the radio finds a record that is not its own and clears
   nothing — which is the only thing that stops a dead op's second terminal
   from releasing the live op's claim and admitting a third client.
   */
  fileprivate func syncFinished(_ opId: Int64) {
    guard syncOwner?.opId == opId else {
      return
    }
    syncOwner = nil
  }

  /** The connected sync state machine — mirrors the Android SyncClient. */
  fileprivate final class SyncOp: NSObject, CBPeripheralDelegate {
    private weak var module: CrewBeacon?
    private let peripheral: CBPeripheral
    private let want: Data
    private let resolve: RCTPromiseResolveBlock
    private let reject: RCTPromiseRejectBlock
    private var digestOut = Data()
    private var msgOut = Data()
    /** THE IDENTITY OF THE OFFER THESE BYTES ARE (row 120) — parsed off the
     digest frames as they arrive, handed back to JS with them, and carried
     by JS onto the WANT of the pass that follows. This is the only place a
     client can learn it, which is exactly why the server puts it here. */
    private var offerRead: CrewBeacon.OfferIdentity?
    private var phase = "digest"
    private var wantSeq = 0
    /** The seq this side expects next. A peer whose digest changed between
     our reads restarts its stream at seq 0 (see the serving side's
     generation logic); appending its frame 0 onto our half-read old stream
     would build a digest that never existed on either phone. */
    private var expectSeq = 0
    private var done = false
    private var chars: [CBUUID: CBCharacteristic] = [:]

    /** THIS OPERATION'S IDENTITY. Monotonic over the process, minted on the
     confinement queue at admission, and the thing every clear compares
     against: "the radio is free" is never a fact on its own, only ever
     "op N is over AND op N is what the record still names". */
    let opId: Int64

    init(
      module: CrewBeacon,
      peripheral: CBPeripheral,
      want: Data,
      resolve: @escaping RCTPromiseResolveBlock,
      reject: @escaping RCTPromiseRejectBlock,
      opId: Int64
    ) {
      self.module = module
      self.peripheral = peripheral
      self.want = want
      self.resolve = resolve
      self.reject = reject
      self.opId = opId
      super.init()
    }

    var peerIdentifier: UUID { peripheral.identifier }

    func start() {
      peripheral.delegate = self
      module?.passiveOpSeq &+= 1
      module?.inFlight[peripheral.identifier] = CrewBeacon.PassiveConnect(
        peripheral: peripheral,
        gen: module?.radioGeneration ?? 0,
        opId: module?.passiveOpSeq ?? 0
      )
      module?.guardedStep("connect", "sync-start") {
        self.module?.centralManager?.connect(self.peripheral, options: nil)
      }
      // The timeout lands on the SAME queue everything else here runs on, so
      // it cannot race the terminal it is competing with.
      CrewBeacon.bleQueue.asyncAfter(deadline: .now() + CrewBeacon.syncTimeout) { [weak self] in
        self?.fail("sync timed out")
      }
    }

    func connected() {
      peripheral.discoverServices([CrewBeacon.serviceUUID])
    }

    /**
     TEAR THIS OPERATION DOWN FROM OUTSIDE — endSession's and stopAll's
     cancel. It runs the ordinary failure terminal, so the bridge promise is
     settled by the rejection road and the owner record is cleared by the
     same check-and-set every other terminal uses. Both callers are already
     on the confinement queue.
     */
    func cancel(_ why: String) {
      fail(why)
    }

    /** THE TERMINAL, AND IT IS A CHECK-AND-SET. `done` is read and written
     on the confinement queue only, so the guard and the assignment are
     atomic against every other road into a terminal — the timeout, a
     delegate error, an external cancel — and exactly one of them settles
     the promise. */
    func fail(_ why: String) {
      guard !done else { return }
      done = true
      cleanup()
      reject("sync", why, nil)
    }

    private func finishOk() {
      guard !done else { return }
      done = true
      cleanup()
      var out: [String: Any] = [
        "digest": digestOut.base64EncodedString(),
        "messages": msgOut.base64EncodedString(),
      ]
      if let offerRead {
        // THE ANSWER NAMES THE OFFER IT READ. JS holds this beside the want
        // ids it derives from these bytes and writes it back on the WANT
        // wire; the server matches it against what it publishes then.
        out["offerEpoch"] = NSNumber(value: offerRead.epoch)
        out["offerRev"] = NSNumber(value: offerRead.rev)
        out["offerGeneration"] = NSNumber(value: offerRead.generation)
      }
      resolve(out)
    }

    private func cleanup() {
      // TRANSITIVE COVERAGE, AT THE SITE. This is the nested cleanup the
      // audit found bare: retire -> syncOwner.cancel -> fail -> cleanup ->
      // cancelPeripheralConnection, one raise aborting the process from
      // inside a retirement. Guarding the doorway alone is not coverage.
      let id = peripheral.identifier
      let owned = module?.inFlight[id]
      module?.guardedStep("cancelPeripheralConnection", "sync-cleanup") {
        self.module?.centralManager?.cancelPeripheralConnection(self.peripheral)
      }
      if module?.dropPassive(peripheral) == true, let owned {
        module?.oweTerminal(id, owned.opId)
      }
      // BY NAME. A terminal from an op that no longer owns the radio must
      // clear nothing — see CrewBeacon.syncFinished.
      module?.syncFinished(opId)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
      guard error == nil,
            let service = p.services?.first(where: { $0.uuid == CrewBeacon.serviceUUID }) else {
        fail("peer has no crew service")
        return
      }
      p.discoverCharacteristics(
        [CrewBeacon.digestChar, CrewBeacon.wantChar, CrewBeacon.msgChar],
        for: service
      )
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
      guard error == nil else {
        fail("discover failed")
        return
      }
      for ch in service.characteristics ?? [] {
        chars[ch.uuid] = ch
      }
      guard chars[CrewBeacon.digestChar] != nil else {
        fail("peer has no crew service")
        return
      }
      readStream()
    }

    private func readStream() {
      let uuid = phase == "digest" ? CrewBeacon.digestChar : CrewBeacon.msgChar
      guard let ch = chars[uuid] else {
        fail("peer has no crew service")
        return
      }
      peripheral.readValue(for: ch)
    }

    private func writeWantFrame() {
      guard let ch = chars[CrewBeacon.wantChar] else {
        fail("peer has no crew service")
        return
      }
      let total = want.isEmpty ? 1 : (want.count + CrewBeacon.frameChunk - 1) / CrewBeacon.frameChunk
      let from = wantSeq * CrewBeacon.frameChunk
      let to = min(from + CrewBeacon.frameChunk, want.count)
      var frame = Data([
        UInt8((wantSeq >> 8) & 0xFF), UInt8(wantSeq & 0xFF),
        UInt8((total >> 8) & 0xFF), UInt8(total & 0xFF),
      ])
      frame.append(want.subdata(in: from ..< to))
      peripheral.writeValue(frame, for: ch, type: .withResponse)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
      guard error == nil else {
        fail("want write failed")
        return
      }
      let total = want.isEmpty ? 1 : (want.count + CrewBeacon.frameChunk - 1) / CrewBeacon.frameChunk
      wantSeq += 1
      if wantSeq < total {
        writeWantFrame()
      } else {
        phase = "messages"
        expectSeq = 0
        readStream()
      }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
      guard !done else { return }
      guard error == nil, let value = characteristic.value, value.count >= 4 else {
        fail("read failed")
        return
      }
      let seq = (Int(value[value.startIndex]) << 8) | Int(value[value.startIndex + 1])
      let total = (Int(value[value.startIndex + 2]) << 8) | Int(value[value.startIndex + 3])
      if total == 0 {
        CrewBeacon.bleQueue.asyncAfter(deadline: .now() + CrewBeacon.notReadyRetry) { [weak self] in
          guard let self, !self.done else { return }
          self.readStream()
        }
        return
      }
      if seq != expectSeq {
        // The peer restarted this stream under us — its store changed and
        // its digest moved to a new generation. Two generations must never
        // be concatenated: take a seq 0 as a clean restart, refuse anything
        // else rather than assemble a frame sequence that means nothing.
        guard seq == 0 else {
          fail("stream restarted out of order")
          return
        }
        if phase == "digest" {
          digestOut = Data()
          offerRead = nil
        } else {
          msgOut = Data()
        }
      }
      var body = value.startIndex + 4
      if phase == "digest" {
        // EVERY NON-EMPTY DIGEST FRAME NAMES ITS OFFER. A frame that does
        // not is a peer speaking a wire this build cannot attribute an ask
        // to, and an unattributable ask is one the server would refuse
        // anyway — so it fails here, where the reason is legible, rather
        // than as a silent stale-offer refusal two passes later.
        guard let id = CrewBeacon.offerIdentity(from: value, at: 4) else {
          fail("digest frame carries no offer identity")
          return
        }
        if let held = offerRead, held != id {
          // The peer republished between two frames of one stream. The seq
          // restart rule usually catches this; when it does not, two
          // generations must still never be concatenated.
          fail("the peer's offer changed mid-stream")
          return
        }
        offerRead = id
        body += CrewBeacon.offerIdentityBytes
      }
      let chunk = value.subdata(in: body ..< value.endIndex)
      if phase == "digest" {
        digestOut.append(chunk)
      } else {
        msgOut.append(chunk)
      }
      expectSeq = seq + 1
      if seq + 1 < total {
        readStream()
        return
      }
      if phase == "digest" {
        if want.isEmpty {
          finishOk()
        } else {
          phase = "want"
          wantSeq = 0
          writeWantFrame()
        }
      } else {
        finishOk()
      }
    }
  }
}

/**
 THE CREW BEACON AS THE ARBITER'S SINK (S2).

   "arbiter owns CrewBeacon suppression effect — JS advertisingHeld/stop
   request is not proof; if suppression cannot be effect-proven,
   degrade/refuse Walkie peripheral advertiser, never overlap."

 WHAT WAS NEVER PROVEN BEFORE. The hold lived in JS: radio.ts set a flag,
 called `stopAdvertising`, and every layer above treated the RESOLVED
 promise as the fact. But `stopAdvertising()` is a nonblocking request and
 the promise resolves on the call, so "the beacon is off the air" was an
 ISSUE wearing an effect's clothes — the same defect the walkie's own
 advertiser proof was written against, on the other advertiser, unnoticed
 for as long as the walkie half was the one being argued about.

 THE THREE PROOFS ARE THE SAME THREE, deliberately: P1 the manager is
 ABSENT (nothing this object could advertise exists), P2 an observed,
 EXACT `.poweredOff` (the radio is physically down), P3 `isAdvertising ==
 false` read FRESH on a LATER turn of the owning queue — never in the same
 block as the stop that preceded it, because CoreBluetooth's flag is
 updated asynchronously and a same-block read is the cached answer to the
 question we just asked.

 `.unauthorized`, `.unsupported` and `.resetting` prove nothing and settle
 nothing: they say nothing about what is radiating. They land on P3, where
 a manager that never advertised reads false and proves itself in one look.
 */
extension CrewBeacon: CrewAirtimeSink {
  /// How many looks the suppression gets, on the manager's own queue.
  private static var suppressBudget: Int { 4 }
  private static var suppressTick: TimeInterval { 0.25 }

  var crewAirtimeGate: Bool { !airtimeSuppressed }

  func suppressCrewAdvertising(_ done: @escaping (Bool, String) -> Void) {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        // A module that went away between the ask and this block cannot
        // be advertising: there is nothing left to hold a manager.
        done(true, "module-gone")
        return
      }
      self.airtimeSuppressed = true
      let pm = self.peripheralManager
      self.guardedStep("stopAdvertising", "airtime-suppress") { pm?.stopAdvertising() }
      self.advertising = pm?.isAdvertising ?? false
      self.emitState()
      self.proveCrewDown(pm, tries: 0, done)
    }
  }

  func resumeCrewAdvertising() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.airtimeSuppressed = false
      guard self.wantAdvertising, self.peripheralManager != nil else { return }
      // The session is the only thing that can build a correctly
      // time-bucketed payload, and on iOS the advertisement carries none
      // — the characteristic serves the field — so re-driving the effect is
      // the whole of putting it back. Through the reconciler, like every
      // other road: the arbiter's resume is not entitled to a private view
      // of the radio either.
      self.reconcileRadioState("airtime-resume")
    }
  }

  /// The effect, on the manager's own queue (nil == main for both of this
  /// module's managers). Strong capture through the chain, bounded by the
  /// budget: a `[weak self]` chain that emptied would drop the completion
  /// and leave a lease waiting on a proof that is never coming.
  private func proveCrewDown(
    _ mgr: CBPeripheralManager?,
    tries: Int,
    _ done: @escaping (Bool, String) -> Void
  ) {
    guard let mgr else {
      done(true, "absent")
      return
    }
    if mgr.state == .poweredOff {
      done(true, "power-off")
      return
    }
    if tries > 0, !mgr.isAdvertising {
      done(true, "not-advertising")
      return
    }
    if tries >= Self.suppressBudget {
      // FAIL CLOSED, AND THE ARBITER KNOWS WHAT TO DO WITH IT: the lease
      // degrades and the walkie mints no advertiser at all. There is no
      // debt to open here — nothing of the WALKIE's is on the air, and the
      // thing that would not go quiet is the beacon we are trying to make
      // room for. Refusing the room is the honest answer.
      done(false, "crew-still-advertising")
      return
    }
    if tries > 0 {
      mgr.stopAdvertising() // re-issue: a stack that swallowed the first
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.suppressTick) { [self] in
      proveCrewDown(mgr, tries: tries + 1, done)
    }
  }
}

// ------------------------------------------------------------ peripheral side

extension CrewBeacon: CBPeripheralManagerDelegate {
  /**
   TRIGGER ONLY. This callback used to BE the peripheral's state machine —
   it added services, started the advertisement, settled the promise and,
   on `.poweredOff`, retired the whole radio scope out of its own event
   body. That last part is the cross-manager defect: one manager's stale
   event must never write the other manager's level. So the body of this
   method is now the two things a trigger may do — note what changed, and
   ask the reconciler to read the CURRENT truth of both managers.
   */
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    let name = Self.stateName(peripheral.state)
    NSLog("crew//radio-event manager=peripheral state=\(name)")
    reconcileRadioState("peripheral:\(name)")
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      advertising = peripheral.isAdvertising
      settleAdvertise(.reject(code: "advertise", message: error.localizedDescription))
      emitState(error.localizedDescription)
      return
    }
    // THE FRAMEWORK'S OWN ANSWER, not an assumption from the absence of an
    // error — the same rule the scan level keeps.
    advertising = peripheral.isAdvertising
    settleAdvertise(.resolve)
    emitState()
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    let central = request.central.identifier
    // THE RETIRED GATE, READ BEFORE ANY BUFFER IS TOUCHED (finding 109).
    //
    // This read may already have been sitting on the main queue when a stop
    // ran on React Native's method queue: main's order is then R -> the
    // retirement's own cleanup, so a retirement that is only a cleanup is one
    // this read got in front of. The gate is published from the calling queue
    // BEFORE that cleanup is even dispatched, which is what makes the stop a
    // barrier this line can honour.
    //
    // Surface retired (stopAll / invalidate): nothing is published, so
    // nothing is answered — a previously-known central finds a phone with no
    // mailbox rather than a quiet advertisement in front of a live one.
    // Mesh retired (endSession, a power cycle, and both of the above): the
    // offer is withdrawn, so the digest and message streams answer the
    // not-ready retry frame, which is the same sentence a central already
    // hears while JS is assembling. The payload is untouched by that scope:
    // endSession keeps the phone discoverable, deliberately.
    let gate = retirementGate()
    if gate.surface {
      peripheral.respond(to: request, withResult: .readNotPermitted)
      return
    }
    if gate.mesh,
       request.characteristic.uuid == Self.digestChar ||
       request.characteristic.uuid == Self.msgChar {
      let notReady = Data([0, 0, 0, 0])
      guard request.offset <= notReady.count else {
        peripheral.respond(to: request, withResult: .invalidOffset)
        return
      }
      request.value = notReady.subdata(in: request.offset ..< notReady.count)
      peripheral.respond(to: request, withResult: .success)
      return
    }
    var value: Data
    // Set when this read hands over the LAST digest frame — the moment the
    // central provably holds our whole offer. Emitted below, after the
    // response, so a bridge hop never delays the read itself.
    var digestServed = false
    switch request.characteristic.uuid {
    case Self.payloadChar:
      value = payload
    case Self.digestChar:
      // Advance the cursor only on a FRESH read; continuation offsets slice
      // the same cached frame (iOS long-read semantics — see file header).
      // A digest that changed since this central's last fresh read rewinds
      // it to seq 0 HERE, at a boundary it chose, instead of under its feet
      // mid-read — see digestGeneration.
      if request.offset == 0, !digestReady {
        // NOT READY, WHICH IS NOT "NOTHING" (M5/M6, Android's twin branch).
        // No offer for the current session has been installed and acked yet,
        // so the only honest answer is the retry frame — a total of 0, which
        // the client side already reads as "ask again shortly". Serving the
        // empty buffer here would be a COMPLETE, confident "this phone
        // carries no mail", said to a podmate holding a phone that does; and
        // `digestServed` deliberately stays false, because nobody completed
        // a pull of anything.
        trackCentral(central)
        digestFrame[central] = Data([0, 0, 0, 0])
      } else if request.offset == 0 {
        let stale = digestStreamGen[central] != digestGeneration
        trackCentral(central)
        digestStreamGen[central] = digestGeneration
        let cur = stale ? 0 : (digestCursor[central] ?? 0)
        // THE FRAME NAMES THE OFFER IT IS A FRAME OF (row 120): the client
        // has no other place to learn the identity it must carry back on the
        // want, and taking it from the frame means it is the identity of the
        // bytes it actually assembled.
        let f = Self.digestFrame(of: syncDigest, cursor: cur, identity: liveOffer)
        digestFrame[central] = f
        let total = Self.frameTotal(f)
        digestCursor[central] = (cur + 1 >= total) ? 0 : cur + 1
        // Building the final frame = this central is completing a digest
        // pull. One event per completed pull (offset-0 build only, so the
        // MTU continuations of this same frame never double-fire it).
        digestServed = cur + 1 >= total
      }
      value = digestFrame[central] ?? Data([0, 0, 0, 0])
    case Self.msgChar:
      if request.offset == 0 {
        let buf = msgBuffers[central]
        let cur = msgCursor[central] ?? 0
        let f = Self.frame(of: buf, cursor: cur)
        trackCentral(central)
        msgFrame[central] = f
        let total = Self.frameTotal(f)
        if buf != nil, cur + 1 >= total {
          msgBuffers.removeValue(forKey: central)
          msgCursor.removeValue(forKey: central)
        } else if buf != nil {
          msgCursor[central] = cur + 1
        }
      }
      value = msgFrame[central] ?? Data([0, 0, 0, 0])
    default:
      peripheral.respond(to: request, withResult: .attributeNotFound)
      return
    }
    guard request.offset <= value.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = value.subdata(in: request.offset ..< value.count)
    peripheral.respond(to: request, withResult: .success)
    if digestServed {
      // The peer that just pulled our digest is alive and in range RIGHT
      // NOW; JS dials back on this instead of waiting out a cooldown (the
      // delivery-latency fix, 2026-08-25). The id is this central's
      // peripheral-side identity, which is NOT the identifier we scan them
      // by — meshSync treats the event as "somebody pulled", not as an
      // address, and nudges everyone it can currently hear. `dialable` is
      // that fact said out loud rather than left to a comment: Android
      // sends true (its central name IS a dialable BLE address), and JS
      // reads an absent field as false, so this platform could never be
      // mistaken for one whose served id can be dialled back.
      sendEvent(
        withName: Self.syncServedEvent,
        body: ["peerId": central.uuidString, "dialable": false]
      )
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    // A LONG WRITE ARRIVES AS SEVERAL OFFSET-SLICED REQUESTS, NOT SEVERAL
    // FRAMES — the write-side mirror of the long-READ rule this file
    // already documents. CoreBluetooth splits a central's oversized
    // writeValue automatically, and this loop used to read each slice's
    // first four bytes as a [seq][total] header, so every want list longer
    // than one ATT payload was mis-parsed. Assemble by offset first, then
    // hand ONE value per central to the frame handler.
    // THE SAME GATE ON THE WRITE SIDE. A want that arrives after the scope
    // was retired has nothing to be built against, and admitting one would
    // recreate the per-central state the retirement just cleared.
    let gate = retirementGate()
    if gate.mesh || gate.surface {
      if let first = requests.first {
        peripheral.respond(to: first, withResult: .writeNotPermitted)
      }
      return
    }
    var assembled: [UUID: Data] = [:]
    var result: CBATTError.Code = .success
    var ok = true
    for request in requests {
      guard request.characteristic.uuid == Self.wantChar, let value = request.value else { continue }
      let central = request.central.identifier
      var buf = assembled[central] ?? Data()
      guard request.offset == buf.count else {
        result = .invalidOffset
        ok = false
        break
      }
      guard buf.count + value.count <= Self.maxPreparedBytes else {
        result = .invalidAttributeValueLength
        ok = false
        break
      }
      buf.append(value)
      assembled[central] = buf
    }
    // One response settles the whole batch, per CoreBluetooth's contract.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: result)
    }
    guard ok else { return }
    for (central, value) in assembled {
      handleWantFrame(central: central, value: value)
    }
  }
}

// ------------------------------------------------------------ central side

extension CrewBeacon: CBCentralManagerDelegate, CBPeripheralDelegate {
  /**
   TRIGGER ONLY — the central's half of the same rule. The `.poweredOff`
   branch here retired the radio scope from its own event body too, so a
   lagging central `.poweredOff` arriving after a peripheral `.poweredOn`
   cancelled a healthy advertisement, and the reverse order cancelled a
   healthy scan. Both are gone: this notes the state and reconciles.
   */
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let name = Self.stateName(central.state)
    NSLog("crew//radio-event manager=central state=\(name)")
    reconcileRadioState("central:\(name)")
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let peerId = peripheral.identifier.uuidString
    if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
       mfg.count > 2 {
      // Manufacturer data arrives with its 2-byte little-endian company id
      // prefix; 0xFFFF is ours (the Android side's id). Anything else under
      // our service UUID is a stranger's coincidence — ignore.
      let company = UInt16(mfg[mfg.startIndex]) | (UInt16(mfg[mfg.startIndex + 1]) << 8)
      if company == Self.manufacturerId {
        emitSighting(mfg.dropFirst(2), rssi: RSSI, via: "adv", peerId: peerId)
        return
      }
    }
    // No inline payload: an iOS peer. Connect and read, rate-limited — and
    // globally capped (cross-family review): a dense crowd of first
    // sightings must not open N parallel connects on one radio.
    let id = peripheral.identifier
    if inFlight.count >= 2 { return }
    if inFlight[id] != nil { return }
    if let last = lastTried[id], Date().timeIntervalSince(last) < Self.gattCooldown { return }
    lastTried[id] = Date()
    lastRssi[id] = RSSI
    // STAMPED WITH THE RADIO WORLD IT IS OPENED IN, AND WITH ITS OWN
    // IDENTITY. Everything that later clears this entry compares both.
    passiveOpSeq &+= 1
    let opId = passiveOpSeq
    inFlight[id] = PassiveConnect(peripheral: peripheral, gen: radioGeneration, opId: opId)
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    Self.bleQueue.asyncAfter(deadline: .now() + Self.gattTimeout) { [weak self] in
      // BY OP, NOT BY NAME. A timeout minted for op N must not finish
      // whatever connect happens to occupy N's slot when it fires.
      guard let self, let entry = self.inFlight[id], entry.opId == opId,
            entry.gen == self.radioGeneration,
            self.syncOwner == nil else { return }
      self.finish(peripheral)
    }
  }

  /**
   RECORD THAT ONE DELEGATE TERMINAL IS STILL OWED for `opId` on `id`.

   Every road that cancels a passive connect calls this, because cancelling
   is what CAUSES the terminal. The next callback for that peripheral pays
   the debt instead of clearing whatever entry the map holds by then.
   */
  private func oweTerminal(_ id: UUID, _ opId: Int64) {
    var owed = passiveOwed[id] ?? []
    guard owed.count < Self.maxOwedTerminals else {
      // PAST THE NAMED CAP THE DEBT IS COUNTED, NOT DROPPED. The list of
      // names stays bounded — that was the only thing the cap was ever
      // entitled to bound — and the number of terminals CoreBluetooth still
      // owes us stays exact, because a debt that is forgotten is a live
      // entry a stale callback is free to delete.
      let over = (passiveOwedOverflow[id] ?? 0) + 1
      passiveOwedOverflow[id] = over
      NSLog(
        "crew//passive-owe-overflow peer=\(id.uuidString) op=\(opId) " +
          "named=\(owed.count) unnamed=\(over)"
      )
      return
    }
    owed.append(opId)
    passiveOwed[id] = owed
  }

  /**
   ONE PASSIVE READ ENDS — and only if this callback is the terminal of the
   operation the entry names (row 116, and the class cure above it).

   THE GENERATION ALONE WAS NOT ENOUGH, and the trace is exact: op A to
   peripheral X is cancelled by a `.radio` retirement, X is rediscovered
   after the bounce and op B is opened, and A's late `didDisconnect` — which
   names only X — looks X up, finds B's entry carrying the CURRENT
   generation, and deletes the slot B is holding. Comparing the map entry's
   generation cannot see that, because the entry it compares is B's.

   So the authority is the OPERATION, never the UUID. A cancelled op leaves
   a debt (`oweTerminal`); the next callback for that peripheral pays the
   OLDEST debt and clears nothing — CoreBluetooth delivers per-peripheral
   callbacks in order, which is what makes "next" mean "A's". Only a
   callback with no debt outstanding is entitled to clear the live entry,
   and even then only if that entry belongs to this radio world.
   */
  @discardableResult
  private func dropPassive(_ peripheral: CBPeripheral) -> Bool {
    let id = peripheral.identifier
    if var owed = passiveOwed[id], !owed.isEmpty {
      let dead = owed.removeFirst()
      if owed.isEmpty {
        passiveOwed.removeValue(forKey: id)
      } else {
        passiveOwed[id] = owed
      }
      NSLog(
        "crew//passive-late-drop peer=\(id.uuidString) op=\(dead) " +
          "reason=owed-terminal owed=\(owed.count)"
      )
      return false
    }
    // …AND THEN THE UNNAMED ONES. Oldest-first is preserved by construction:
    // the names ARE the oldest debts, so the count is only reached once
    // every named debt has been paid. An unnamed debt clears nothing, for
    // exactly the reason a named one does not.
    if let over = passiveOwedOverflow[id], over > 0 {
      if over == 1 {
        passiveOwedOverflow.removeValue(forKey: id)
      } else {
        passiveOwedOverflow[id] = over - 1
      }
      NSLog(
        "crew//passive-late-drop peer=\(id.uuidString) op=unnamed " +
          "reason=owed-terminal-overflow owed=\(over - 1)"
      )
      return false
    }
    guard let entry = inFlight[id] else { return false }
    guard entry.gen == radioGeneration else {
      NSLog(
        "crew//passive-late-drop peer=\(id.uuidString) op=\(entry.opId) " +
          "gen=\(entry.gen) current=\(radioGeneration)"
      )
      return false
    }
    inFlight.removeValue(forKey: id)
    return true
  }

  /// End one passive read WE are ending: cancel under ObjCTry (the call is
  /// reachable from a finger through the retirement), then clear the entry
  /// and record the terminal the cancel just caused.
  private func finish(_ peripheral: CBPeripheral) {
    let id = peripheral.identifier
    let owned = inFlight[id]
    guardedStep("cancelPeripheralConnection", "passive-finish") {
      self.centralManager?.cancelPeripheralConnection(peripheral)
    }
    // OUR OWN CANCEL IS NOT A DELEGATE CALLBACK, so it must not be routed
    // through the road that PAYS a debt. It used to be: `dropPassive` saw an
    // older op's debt outstanding for this peripheral, paid it with this
    // cancellation, returned false — and the entry we were finishing stayed
    // in `inFlight` holding one of the two cap slots with nothing left to
    // clear it, while the debt for the op we just cancelled was never
    // recorded at all. Both halves are wrong in the same direction as the
    // dropped debt above: the ledger stops matching the terminals owed.
    //
    // So the entry is cleared BY IDENTITY — this op's, or nobody's — and the
    // terminal our cancel just caused is recorded.
    if let owned, inFlight[id]?.opId == owned.opId {
      inFlight.removeValue(forKey: id)
      oweTerminal(id, owned.opId)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    if let op = syncOwner, peripheral.identifier == op.peerIdentifier {
      op.connected()
      return
    }
    peripheral.discoverServices([Self.serviceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    if let op = syncOwner, peripheral.identifier == op.peerIdentifier {
      op.fail("could not connect")
      return
    }
    dropPassive(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    dropPassive(peripheral)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil,
          let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
      finish(peripheral)
      return
    }
    peripheral.discoverCharacteristics([Self.payloadChar], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard error == nil,
          let ch = service.characteristics?.first(where: { $0.uuid == Self.payloadChar }) else {
      finish(peripheral)
      return
    }
    peripheral.readValue(for: ch)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if error == nil, characteristic.uuid == Self.payloadChar,
       let value = characteristic.value, !value.isEmpty {
      emitSighting(
        value,
        rssi: lastRssi[peripheral.identifier] ?? 0,
        via: "gatt",
        peerId: peripheral.identifier.uuidString
      )
    }
    finish(peripheral)
  }
}
