import CoreBluetooth
import Foundation
import os

/**
 The walkie's RUNG 3 — live lo-fi voice over BLE GATT (docs/WALKIE-LADDER.md
 §2, §6), iOS half. Mirrors WalkieBleLink.kt — read that file for the full
 design; this comment records the contract and the places CoreBluetooth
 forces a different shape.

 THE CONTRACT (identical to Android): every phone with the walkie OPEN
 advertises one connectable service and runs one GATT server with two
 characteristics:
   IDENT (read):  'PV' + podHash(4 BE) + senderHash(4 BE) + utf8 name
   VOICE (write-no-response): one PW frame per write
 and scans for the same service, connecting as a CENTRAL to every pod peer
 it sights. Voice is asymmetric on purpose: MY voice rides MY central
 connection to THEIR server; theirs rides theirs to mine — no role
 negotiation, each direction owns its pipe. MEMBERSHIP IS THE CONNECTION
 (§5: availability is PROVEN, never announced): a peer is listed only after
 the identity read came back with the right pod on a link whose write
 budget fits a voice frame. Every failure path ends in "this rung
 contributes no peers" — the LAN and Aware rungs are untouched.

 WHERE iOS DIFFERS, AND WHY:

 - THE IDENTITY RIDES THE LOCAL NAME, NOT MANUFACTURER DATA. A CoreBluetooth
   peripheral can advertise ONLY service UUIDs and a local name — the same
   asymmetry CrewBeacon.swift already encodes — so the 10 PV bytes Android
   puts in manufacturer data are spelled here as the advertised name:
   "PV" + podHash(8 hex). Both scanners read BOTH carriers
   (WalkieBleLink.kt's pvFromName is the Android half). Either carrier is a
   pre-connect FILTER only — the identity read stays the proof.
   Backgrounded, iOS drops the local name from the advertisement, so an
   Android central cannot identify a pocketed iPhone and THAT direction
   contributes no peers until the app is foreground again; the walkie is an
   open-panel surface, so the honest cost is small — and the iPhone-as-
   central half keeps dialling Androids regardless.

 - THE WRITE BUDGET IS ASKED, NOT NEGOTIATED. Android requests MTU 517 and
   gates on the answer; CoreBluetooth exchanges MTU on its own, and
   maximumWriteValueLength(for: .withoutResponse) is the question this
   side can ask. Same rule either way: a 60 ms frame is 257 bytes, and a
   link whose budget came back smaller is dropped before it was ever
   listed (Android's MIN_VOICE_MTU 260 is this number plus the 3-byte ATT
   header its API counts).

 - THE SCAN STREAM IS THE RETRY ENGINE only with duplicates ON.
   CBCentralManager reports each peripheral once per scan by default;
   CBCentralManagerScanOptionAllowDuplicatesKey keeps the sightings coming
   so the per-peer backoff has its trigger, exactly like Android's
   scanner. (iOS ignores the option in background — the same foreground
   story as the local name, the same honest cost.)

 - AND THE ONE THIS FILE IS SHAPED BY: A CALLBACK CANNOT SAY WHICH LINK IT
   BELONGS TO. Android's callbacks arrive on a per-dial
   BluetoothGattCallback object, so a generation is separable by
   construction. CoreBluetooth's arrive at a manager's delegate and a
   peripheral's delegate, and it vends ONE CBPeripheral per phone — so
   `identifier` names the PHONE and never the LINK. Four rounds of this
   rung tried to adjudicate that overlap with epochs, captured records and
   live-state tests, and each grew another mutable slot on the peer entry
   to do it. The binding cross-family reading was that the slots ARE the
   shape and no arrangement of them can mint provenance the API does not
   supply.

   So the question is not answered here, it is DISSOLVED, in the shape that
   reading named: GENERATION-ISOLATED OWNERSHIP. Every dial mints a
   BleLinkGeneration that owns its OWN CBCentralManager, its own manager
   delegate, the CBPeripheral THAT manager produced, its own peripheral
   delegate, its own services, characteristics, timers and operations. The
   shared manager below SCANS AND NOTHING ELSE: it passes a UUID and the
   advertisement's facts, never its own CBPeripheral object. The durable
   peer entry keeps a backoff and the identity of its CURRENT link, and not
   one callback, handle or operation slot. Retiring is monotonic and comes
   BEFORE the cancel, so everything a teardown provokes lands on an owner
   that is already retired and holds nothing.

   ABOVE ALL OF IT SITS ONE THING THE MODULE CANNOT OWN, because it must
   outlive the module: BleObjectQuarantine, the process-wide OWNER of every
   CBPeripheral object a link is built on. A dial does not ask whether an
   object looks free, it CLAIMS it — and a claim is granted only if nobody
   holds that exact object, live or retired-and-not-yet-dead. Anything else
   FAILS CLOSED: not re-delegated, not connected, left to the backoff. The
   address becomes dialable again when the object dies or the adapter epoch
   turns over. A retirement may transition ONLY THE CLAIM IT HOLDS, and a
   retirement that finds its claim superseded touches nothing.

 THREADING: one serial queue owns the scanner, every generation and every
 peer record — the stop() serialization WalkieBleLink.kt earned the hard
 way arrives here for free: stop() enqueues the teardown, a dial already
 enqueued completes first and is closed BY it, anything enqueued after
 sees `stopped`. Every manager and every peripheral delegate is bound to
 that same queue, so every callback already arrives on it. Callbacks out
 (onPeer/onPeerLost/onFrame) fire on this queue; Walkie.swift hops them to
 main, its own discipline.
 */

/// THE FIELD LOG THIS RUNG NEVER HAD. WalkieBleLink.kt has named a dozen
/// decisions since the day it shipped; this file logged NOTHING, which is
/// why the 2026-08-26 bench could write down "no audio and no errors" —
/// there was nowhere on the iPhone for an error to appear. One terse line
/// per rate-limited decision and sighting: a release build is exactly where
/// the next 3am diagnosis happens.
///
/// A free function rather than a method, because two types decide things
/// now — the coordinator and each link generation — and one log verb
/// spelled in two places is one log verb that will eventually be spelled
/// two ways.
///
/// Every interpolation is explicitly public: these are field diagnostics,
/// including peer-carried names, and a private redaction would restore the
/// same "no audio and no errors" blind spot this logger exists to remove.
private let wlog = Logger(
  subsystem: "com.playapal.walkie",
  category: "ble"
)

private func vlog(_ line: String) {
  wlog.notice("voice//\(line, privacy: .public)")
}

private let logKeyCap = 1_024

private func logAllowed(
  _ map: inout [String: TimeInterval],
  key: String,
  now: TimeInterval,
  every window: TimeInterval
) -> Bool {
  if let until = map[key], now < until {
    return false
  }
  if map.count >= logKeyCap {
    map = map.filter { $0.value > now }
    if map.count >= logKeyCap,
       let soonest = map.min(by: { $0.value < $1.value })?.key {
      map.removeValue(forKey: soonest)
    }
  }
  map[key] = now + window
  return true
}

private func hex(_ v: UInt32) -> String {
  String(format: "%08x", v)
}

/// THE OBJECT ADDRESS, ON GLASS. Generation isolation is invisible from
/// the outside — a bench reading a logcat cannot tell one CBPeripheral
/// from the next, which is precisely the confusion the four reverted
/// rounds lived inside. Every mint, every retirement and every refusal
/// says WHICH object it was about, so the isolation can be read working
/// rather than argued about.
///
/// EAS-VERIFY: UInt(bitPattern: ObjectIdentifier) is Swift stdlib
/// (ObjectIdentifier's documented bit-pattern bridge); if the builder
/// disagrees, String(describing: ObjectIdentifier(o)) carries the same
/// address in a noisier spelling.
private func objTag(_ o: AnyObject?) -> String {
  guard let o else { return "-" }
  return String(UInt(bitPattern: ObjectIdentifier(o)), radix: 16)
}

// ------------------------------------------------- the object quarantine

/**
 A PROCESS-LIFETIME WEAK-OBJECT QUARANTINE, deliberately ABOVE
 WalkieBleVoice — and it OWNS the objects rather than merely remembering
 the dead ones.

 Generation isolation rests on one assumption: that the CBPeripheral a
 fresh CBCentralManager hands back is a fresh object, so the retired
 generation's delegate pointer, outstanding reads and pending writes
 belong to something else entirely. CoreBluetooth does not promise that,
 and the whole shape is void where it does not hold — a fresh manager
 vending the SAME object means the new link inherits the old link's
 delegate slot and its outstanding operations, which is the bug wearing
 the cure's clothes.

 A TOMBSTONE REGISTER IS NOT ENOUGH, and this is the correction the
 binding review made of the first build. Retirement in this rung is
 ENQUEUED, not immediate: stop() posts its teardown to the link queue and
 returns, so between the gesture and the tombstone there is a window in
 which the old link is still ACTIVE and no tombstone for it exists. A
 camper who closes the walkie and immediately reopens it dials inside that
 window on a SECOND WalkieBleVoice with its own queue — retrievePeripherals
 hands back the exact still-live object, a register of the dead has nothing
 to say about it, and the new dial takes the old link's delegate seat. The
 old retirement then runs and cancels the connection the new link is
 standing on. The old build's stop/start arm assumed the retirement had
 already happened and so never modelled the ordering the field actually
 produces.

 SO THE STATES ARE TWO AND THE OWNERSHIP IS TOTAL. Every object this
 process has built a link on is CLAIMED by exactly one live generation or
 TOMBSTONED by the generation that has retired off it, and both live in one
 register under one lock:

   claim()  — atomically: refuse if this exact object is CLAIMED by anyone
              or TOMBSTONED and still alive; otherwise record the claim and
              hand back its ticket. The delegate seat and the connect
              happen only after a granted ticket, never before.
   retire() — transitions THIS CLAIM ONLY, and the transition precedes the
              cancel. A retirement whose claim was superseded logs and
              touches nothing: the object belongs to somebody else now.

 THE ENQUEUED RETIREMENT IS THEREFORE SAFE BY CONSTRUCTION. Until the
 queued retire actually runs, the claim still names the old generation, so
 the new session's dial fails closed and rides the same backoff arc a live
 tombstone already produces. There is one fail-closed road, not two.

 THE TICKET IS NOT THE GENERATION'S `id`. That counter restarts at 1 with
 every WalkieBleVoice, and an immediate stop/start — two instances briefly
 alive at once — is the exact path this class exists for. A token two
 instances can both mint cannot decide ownership between them, so the
 quarantine mints its own, monotonic for the life of the process.

 THE BOXES ARE WEAK, claims included: holding an object strongly would keep
 alive the very thing whose death is the release condition, and the
 quarantine would become the wedge it exists to prevent. The address comes
 back the moment the object dies (the ordinary case, and usually within
 milliseconds of the retirement releasing it) or the adapter epoch turns
 over, which invalidates every object CoreBluetooth ever vended.

 IT LIVES ABOVE THE MODULE BECAUSE IT MUST OUTLIVE IT. Closing the walkie
 and reopening it mints a new WalkieBleVoice, new managers and new
 everything — but the OS's objects and their in-flight operations do not
 restart with us. Claims and tombstones both survive it.

 AND RETIREMENT IS A LEASE, NOT AN INSTANT — the correction the binding
 review made of THIS build. Deciding ownership atomically is not enough
 while the act the decision authorizes happens outside the lock:
 `cancelPeripheralConnection` is issued after the transition returns, and
 in that gap an adapter reset can clear the register (or the tombstone can
 be released with it), a new generation can claim the very same object,
 install its delegate and connect — and the older, already-authorized
 cancel then lands on the new link. Making the absent verdict harmless
 narrows that window; it does not close it, because tombstone → reset →
 claim → old cancel is the same window one state along.

 SO THE TEARDOWN IS THREE STEPS AND THE OBJECT IS RESERVED ACROSS THEM:

   beginRetire()    — under the lock: if the ticket holds the claim, move
                      it to RETIRING (reserved for that ticket) and answer
                      `.authorized`. Superseded and absent answer as before
                      and authorize NOTHING.
   the cancel       — outside the lock, under the lease. While a record is
                      reserved, `claim()` fails closed on that exact object
                      exactly as it does for a live claim, and
                      `adapterReset()` may NOT delete it: the epoch turns,
                      the record goes epoch-stale, and the object stays
                      reserved.
   finalizeRetire() — under the lock: only the leasing ticket may spend the
                      lease. Inside its own epoch the reservation becomes
                      the tombstone; if the epoch turned under the lease
                      the record is dropped outright, because every object
                      of a dead epoch is already meaningless to the stack.

 AND THE LEASE ENDS AT THE CANCEL'S EFFECT, NOT AT ITS ISSUE — the
 correction the binding review made of the LEASE build, and the last of
 this seam: "cancelPeripheralConnection is nonblocking, so immediate
 finalize after the call may release/tombstone before old didDisconnect
 /effect lands, allowing B claim/connect then old cancel completion kills
 B." The previous build spent the lease on the line after the issue and
 argued the damage was done at issue. IT IS NOT. Issue is a REQUEST; the
 stack tears the link down at some later moment of its own choosing, and
 between those two moments a released record is an object B can claim,
 delegate and connect — and the teardown then lands on B's link, which is
 the identical casualty one layer along.

 SO A LEASE LIVES UNTIL A PROVEN TERMINAL, and there are exactly four
 roads out of it, all of them fail-closed:

   T1  didDisconnectPeripheral for THE EXACT reserved object, arriving on
       the retiring generation's OWN CBCentralManager — the primary
       completion, and the reason a retiring generation keeps its manager,
       keeps its delegate seat on it, and routes NOTHING but this while it
       retires.
   T2  the synchronous fast path: at ISSUE the object was already
       `.disconnected`, so the cancel is a no-op and there is no effect to
       wait for. `.disconnecting` does NOT qualify — a teardown in flight
       is precisely an effect that has not landed.
   T3  an OBSERVED `.poweredOff` on that generation's own manager: every
       link this stack had is physically gone, so the cancel can no longer
       reach anybody. `.unknown`, `.resetting` and `.unauthorized` say
       nothing about any link, and a generic epoch turn says nothing at
       all — none of the four completes a lease.
   T4  the no-wedge fallback, because a stack that never delivers T1 must
       not strand the address forever: a BOUNDED recheck on the
       generation's own queue re-reads the object's state and re-issues
       the cancel while it is still connected, and when that budget is out
       the record is POISONED. Poison is FAIL-CLOSED, not a release: no
       claim may take it, and no adapter reset or epoch turn may free it.
       It is freed by exactly two things — the exact object's death (the
       weak box empties, and a dead object has no link to kill) or a later
       proven T3.

 AND EVERY COMPLETION IS TICKET-IDEMPOTENT. A duplicate didDisconnect, a
 poweredOff behind a disconnect, a straggler that arrives after the poison:
 each finds a lease that is no longer `.held` by its ticket and does
 nothing. A lease is spent exactly once or it is not a lease.
 */
final class BleObjectQuarantine {
  static let shared = BleObjectQuarantine()

  /// What a dial asked the quarantine for, and what it got.
  enum Claim {
    /// This generation now OWNS the object, under this ticket. Only now
    /// may it take the delegate seat and connect.
    case granted(UInt64)
    /// A LIVE generation holds it — the enqueued-retirement window. Its
    /// label rides the refusal log.
    case active(String)
    /// A retirement has RESERVED it and its cancel has not been issued
    /// yet. The same fail-closed arc as `.active`, for the same reason:
    /// this object is somebody's, and it is about to be torn down.
    case retiring(String)
    /// A retired generation held it and the object has not died yet.
    case retired(String)
  }

  /// STEP ONE'S ANSWER: the LEASE a retirement was given, or the reason
  /// there is none.
  enum Lease {
    /// The object is RESERVED for this ticket alone. Until the lease is
    /// spent, no claim may take it and no epoch may free it, so the cancel
    /// that follows can only ever land on this generation's own link.
    case authorized
    /// Somebody else owns this object now. Hands off — no delegate clear,
    /// no cancel.
    case superseded(String)
    /// Nothing owns it: the object died, or the epoch turned before this
    /// retirement could reserve it. NO LEASE MEANS NO CANCEL — an object
    /// this process no longer owns is an object it may not tear down.
    case absent
  }

  /// STEP THREE'S ANSWER: what became of a spent lease.
  enum Finalization {
    /// Reserved → tombstoned, inside the epoch that granted the claim. The
    /// address comes back when the object dies, as it always did.
    case tombstoned
    /// The adapter epoch turned while the cancel was in flight. The lease
    /// held the object through it — which is what made the cancel safe —
    /// and spending it now RELEASES the address outright, because the
    /// stack has already forgotten every object of that epoch.
    case released
    /// The lease is not this ticket's. Unreachable from the retirement
    /// flow, which hands a ticket only to the generation that minted it;
    /// stated as a case so that the impossible one is a no-op by
    /// construction rather than by argument.
    case foreign(String)
    /// The object died under the lease. There is nothing left to
    /// transition and nothing left to refuse.
    case absent
  }

  /// The three states one object can be in, and the third is THE CANCEL
  /// WINDOW: an object whose owner has been authorized to tear it down and
  /// has not done so yet. It is neither claimable nor free.
  private enum State {
    case claimed(UInt64)
    case retiring(UInt64)
    case tombstoned
  }

  /// One owned object. WEAK on purpose — see the class note.
  private final class Record {
    weak var object: CBPeripheral?
    var state: State
    let label: String
    let epoch: UInt64
    init(_ object: CBPeripheral, state: State, label: String, epoch: UInt64) {
      self.object = object
      self.state = state
      self.label = label
      self.epoch = epoch
    }
    /// RESERVED BY A RETIREMENT IN FLIGHT, and a reserved record outlives
    /// the epoch that made it. That is the whole of the lease.
    var reserved: Bool {
      if case .retiring = state {
        return true
      }
      return false
    }
  }

  /// Two WalkieBleVoice instances can briefly overlap across a restart and
  /// they own different queues, so this is the one structure here that is
  /// not queue-confined. ONE lock: the claim decision, the reservation and
  /// the finalization are the same question asked from three sides, and
  /// asking it under three locks is asking it three times.
  private let lock = NSLock()
  private var records: [UUID: [Record]] = [:]
  private var epoch: UInt64 = 1
  /// Process-wide and monotonic. Never a generation id.
  private var tickets: UInt64 = 0

  var adapterEpoch: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return epoch
  }

  /// The adapter cycled: every object CoreBluetooth vended before it is
  /// dead to the stack whether or not ARC has caught up. Claims AND
  /// tombstones go, under the same lock — an object the stack has
  /// forgotten cannot be owned by anybody.
  ///
  /// EXCEPT A RESERVED ONE, AND THAT EXCEPTION IS THE LEASE. A retirement
  /// that has been authorized and whose cancel has not been issued yet
  /// still owns its object; releasing it here opens exactly the window the
  /// binding review named — reset, a new generation claims the same
  /// object, and the older authorization then lands on it. So a reserved
  /// record STAYS, epoch-stale, refusing every claim until its leaseholder
  /// finalizes, and that finalize releases it outright.
  func adapterReset() {
    lock.lock()
    defer { lock.unlock() }
    epoch &+= 1
    for (key, list) in records {
      let reserved = list.filter { $0.object != nil && $0.reserved }
      if reserved.isEmpty {
        records.removeValue(forKey: key)
      } else {
        records[key] = reserved
      }
    }
  }

  /// THE ONE DOOR IN, and the whole fail-closed decision happens inside
  /// this lock. Granting is the ONLY thing that may precede a delegate
  /// seat or a connect.
  func claim(_ candidate: CBPeripheral, id: UUID, label: String) -> Claim {
    lock.lock()
    defer { lock.unlock() }
    // A busy playa can put thousands of addresses through a scan; the
    // register is swept of dead entries whenever it grows, so a diagnostic
    // can never become a leak (CrewBeaconModule's posture toward anything
    // a stranger can make us hold).
    if records.count > 64 {
      sweepLocked()
    }
    var live = liveLocked(id)
    if let held = live.first(where: { $0.object === candidate }) {
      switch held.state {
      case .claimed:
        return .active(held.label)
      case .retiring:
        return .retiring(held.label)
      case .tombstoned:
        return .retired(held.label)
      }
    }
    tickets &+= 1
    live.append(Record(candidate, state: .claimed(tickets), label: label, epoch: epoch))
    records[id] = live
    return .granted(tickets)
  }

  /// STEP ONE OF THREE. A generation is retiring off its object: RESERVE
  /// the exact object for this ticket, so that nothing can hand it to
  /// anybody else while the cancel is in flight, and answer with this
  /// retirement's permission to touch it at all. Only the holder of the
  /// live claim gets a lease.
  func beginRetire(_ peripheral: CBPeripheral, claim ticket: UInt64, id: UUID) -> Lease {
    lock.lock()
    defer { lock.unlock() }
    let live = liveLocked(id)
    guard let held = live.first(where: { $0.object === peripheral }) else {
      return .absent
    }
    if case .claimed(let mine) = held.state, mine == ticket {
      held.state = .retiring(ticket)
      return .authorized
    }
    return .superseded(held.label)
  }

  /// STEP THREE. The cancel has COMPLETED — a proven terminal, never
  /// merely a returned call — so spend the lease. Only the leaseholder
  /// may, and only this makes the object claimable again: a tombstone
  /// inside its own epoch, or a released address if the epoch turned while
  /// the lease was held.
  func finalizeRetire(_ peripheral: CBPeripheral, claim ticket: UInt64, id: UUID) -> Finalization {
    lock.lock()
    defer { lock.unlock() }
    let live = liveLocked(id)
    guard let held = live.first(where: { $0.object === peripheral }) else {
      return .absent
    }
    guard case .retiring(let mine) = held.state, mine == ticket else {
      return .foreign(held.label)
    }
    if held.epoch == epoch {
      held.state = .tombstoned
      return .tombstoned
    }
    let rest = live.filter { $0 !== held }
    if rest.isEmpty {
      records.removeValue(forKey: id)
    } else {
      records[id] = rest
    }
    return .released
  }

  /// The entries for one address that still MEAN something, swept as they
  /// are read: the object is alive, and the record either belongs to the
  /// current epoch or is RESERVED. Reserved records survive the epoch turn
  /// on purpose — an object with a cancel in flight is not the epoch's to
  /// give away.
  private func liveLocked(_ id: UUID) -> [Record] {
    let live = (records[id] ?? []).filter { $0.object != nil && ($0.epoch == epoch || $0.reserved) }
    if live.isEmpty {
      records.removeValue(forKey: id)
    } else {
      records[id] = live
    }
    return live
  }

  private func sweepLocked() {
    for (key, list) in records {
      let live = list.filter { $0.object != nil && ($0.epoch == epoch || $0.reserved) }
      if live.isEmpty {
        records.removeValue(forKey: key)
      } else {
        records[key] = live
      }
    }
  }
}

// ------------------------------------------------------ the airtime arbiter

/**
 ONE PROCESS-LIFETIME ARBITER FOR ONE RADIO, and both advertisers are its
 clients (cross-family ARCHITECTURE ruling, 2026-08-27, read of a24b1e2):

   "The minimal coherent root is ONE process-lifetime native Airtime/Radio
   Arbiter shared by CrewBeacon + Walkie, with exact leaseId/opId/requestId,
   one serialized native state machine, retained operation handles, process
   incarnation + wire-safe revision string, and bridge modules as stateless
   clients/sinks. JS epochs remain stale-write guards/UX ordering only;
   snapshots/events are observability, never authority to release a radio
   hold."

 WHAT WAS WRONG, AND IT WAS NOT A MISSING FENCE. Every round before this
 one put the decision in a different place and then wrote a guard to keep
 that place honest: an event, then a level, then a count, then a four-field
 snapshot with a token. Each round's guard was correct about the fact it
 guarded and none of them changed WHO DECIDES — JS read a snapshot and JS
 acted on it, so every one of them could be beaten by a snapshot that was
 true when it was built and false when it was read. A snapshot is a
 photograph. You cannot hand back a radio with a photograph.

 SO THE DECISION MOVES, AND THE SNAPSHOT BECOMES WHAT IT ALWAYS WAS. This
 object owns the advertising slot. It hands it out as a LEASE, it drives
 both radios' suppression and resumption itself, at the effect, and it is
 the only thing in the process that may end a hold. The state it publishes
 is OBSERVABILITY — JS reads it to order its own UX and to keep its own
 caches honest, and JS can be arbitrarily stale without any radio moving,
 because no road from a JS read to a radio exists any more.

 THE SEVEN PHASES, and a lease occupies exactly one:

   idle             no lease. THE ONLY phase in which CrewBeacon may
                    advertise, and the gate below is that sentence
                    compiled.
   reserving        a lease exists and has been minted under the lock. It
                    holds the slot from this instant, which is what makes
                    two simultaneous debt-free starts impossible.
   suppressingCrew  the crew advertiser has been asked to go quiet and its
                    effect is not yet proven.
   starting         crew suppression is PROVEN and the walkie's own
                    advertiser has been asked to come up. Not active:
                    asking is not effect.
   active           the chosen rung reached a terminal — `advertising`
                    (the advertiser's own didStartAdvertising said so) or
                    `degraded` (no walkie advertiser at all, because
                    something upstream could not be proven).
   stopping         a stop is in flight against THIS exact lease. Every
                    later stop for the same lease coalesces onto the same
                    terminal rather than answering on its own.
   debt             the owner released but the process could not prove an
                    advertiser quiet, so the airtime did NOT come back. The
                    lease outlives its owner precisely so that nothing else
                    can take the slot while the debt stands.

 EXACT IDENTITY, AND THREE KINDS OF IT (S5). `processIncarnation` says
 WHICH PROCESS is speaking — a JS world that reloads keeps talking to the
 same one, and a real relaunch is visible as a different string rather than
 as a suspiciously small revision. `leaseId` is opaque and says WHICH HOLD;
 equality is the only operation anyone performs on it. `opId` says WHICH
 OPERATION on that hold, so a stop's answer can be attributed. `requestId`
 says WHICH CALLER asked, so two callers coalesced onto one terminal can
 still each tell their own answer from the other's.

 AND THE REVISION IS NOT AN ID (S5 again). Owner identity and ordering are
 different questions and one field cannot answer both: a lease that is
 reserved, suppressed, started and stopped is ONE owner across FIVE
 revisions. It travels as a DECIMAL STRING plus an exact hi/lo pair,
 because a UInt64 through JSON becomes a JS Number and every order relation
 above 2^53 is a coin toss — which is not a rounding error, it is a stale
 snapshot silently winning a compare against a fresh one.

 THE LOCK HOLDS NOTHING OUT. Every mutation happens under `lock`, every
 emission and every radio call happens after it is released, and the body
 that goes out is BUILT under the lock — so a subscriber is reading one
 moment rather than a composite assembled from several.
 */
enum AirtimePhase: String {
  case idle
  case reserving
  case suppressingCrew
  case starting
  case active
  case stopping
  case debt
}

/// Which rung the lease actually reached, once its start op is terminal.
/// `none` until the effect arrives — a snapshot may never call a lease
/// `advertising` before its advertiser said so (arbiter addendum 3).
enum AirtimeRung: String {
  case none
  case advertising
  case degraded
}

/// The four answers a stop can carry, and the whole of S7. `unknown` is
/// deliberately absent from this enum's producers: the arbiter always
/// knows which of the other three happened, and `unknown` is what the JS
/// boundary yields when it cannot understand the answer at all. What
/// matters on both sides is that it is never `clear`.
enum AirtimeStopOutcome: String {
  case clear
  case debt
  case notOwner
}

/// A crew beacon that can be taken off the air and put back — BY EFFECT,
/// never by flag (S2). The arbiter drives this; JS's `advertisingHeld` is
/// a cache in another process's language and is not proof of anything.
protocol CrewAirtimeSink: AnyObject {
  /// Take the crew advertiser off the air and PROVE it went. `done(true)`
  /// only on an observed effect (absent manager, observed power-off, or a
  /// fresh `isAdvertising == false` on a later turn); `done(false)` when
  /// no proof could arrive inside the budget.
  func suppressCrewAdvertising(_ done: @escaping (Bool, String) -> Void)
  /// Put it back. Called with no lock held, from the arbiter's retirement.
  func resumeCrewAdvertising()
  /// May this beacon advertise right now? Read at the EFFECT site, so a
  /// beacon that comes up mid-lease is refused by the same rule.
  var crewAirtimeGate: Bool { get }
}

/// ONE LEASE — the hold itself, and every handle needed to end it.
///
/// THE STOPPER IS RETAINED HERE, and that one line is the cure for the
/// duplicate-stop hole the addendum names: "stop1 nils instance bleVoice
/// before async proof; stop2 sees nil, debt book still empty, answers
/// clear and releases while stop1 advertiser may radiate". A module field
/// is not an operation handle — it is one instance's opinion about what it
/// is currently holding, and a stop clears it on the way in. The handle
/// belongs to the LEASE, which outlives the instance, so a second stop
/// finds phase `stopping` with a live operation and coalesces onto it.
final class AirtimeLease {
  let id: String
  var phase: AirtimePhase = .reserving
  var rung: AirtimeRung = .none
  var opId: String
  /// The retained operation handle: perform and PROVE this lease's own
  /// advertiser teardown. nil for a lease that never reached `starting`,
  /// which is a lease with no advertiser to prove.
  var stopper: ((@escaping (Bool, String) -> Void) -> Void)?
  /// Every caller coalesced onto this lease's ONE terminal, with the
  /// request each of them asked under.
  var stopWaiters: [(requestId: String, answer: (AirtimeStopOutcome, String, String) -> Void)] = []

  init(id: String, opId: String) {
    self.id = id
    self.opId = opId
  }
}

final class WalkieAirtimeArbiter {
  /// PROCESS-LIFETIME, THEREFORE STATIC — and this is the property every
  /// previous round was missing rather than a style choice. A JS reload
  /// builds a new bridge and new instances of both modules; the radios
  /// those old instances lit do not reload with them. Anything that
  /// answers "who owns the air?" from instance state answers it with the
  /// reload's own amnesia.
  static let shared = WalkieAirtimeArbiter()

  /// The state wire version. A decoder that does not recognise this
  /// number must say INCOMPATIBLE and park (S9/S10) — never "no hold
  /// required", and never "an event I will keep waiting for".
  static let wireVersion = 2

  /// How long a start op may wait for its chosen rung's own effect before
  /// the lease settles DEGRADED rather than sitting in `starting` forever.
  /// The same shape as the advertiser proof's budget and for the same
  /// reason: a budget is a cadence for a CAMPER, and a radio that will not
  /// answer must still produce a terminal.
  static let startEffectBudget = 4
  static let startEffectTick: TimeInterval = 0.25

  /// ONE SERIALIZED STATE MACHINE, AND THE LOCK IS THE SERIALIZER. Every
  /// transition mutates under it; every emission, every radio call and
  /// every completion happens after it is released. A second dispatch
  /// queue on top of this would buy nothing and would add a whole class of
  /// re-entrancy question — the debt book below keeps exactly this
  /// discipline and it is the one piece of this lane that never had to be
  /// re-cut.
  ///
  /// IT IS NOT RECURSIVE, ON PURPOSE. A recursive lock makes "does this
  /// path call back into me?" unanswerable by reading; a plain one makes
  /// the answer a compile-time habit — build the body under the lock,
  /// release, then act.
  private let lock = NSLock()
  /// For the parked reservation's TIMEOUT only. Never used to touch a
  /// radio: that is always the owning module's own queue.
  private let timers = DispatchQueue(label: "playapal.airtime.arbiter")

  private let incarnation = UUID().uuidString
  private var revision: UInt64 = 0
  private var lease: AirtimeLease?
  private var nextLease = 1
  private var nextOp = 1
  private var nextRequest = 1

  /// EXACT SINKS, BY TOKEN (S3). A module registers and unregisters the
  /// same token; nothing here is weak-bound to one module, and a bridge
  /// that goes away takes exactly its own sink with it.
  private var sinks: [String: ([String: Any]) -> Void] = [:]
  private var nextSink = 1
  /// The last body emitted, replayed to every sink the instant it
  /// registers — which is what makes a missed event safe (S3). An edge
  /// has no replay; a level does.
  private var lastBody: [String: Any] = [:]

  /// Reservations parked behind a debt. At most ONE is woken per clear
  /// (arbiter addendum 2): waking all of them is how "the final debt
  /// settlement wakes all waiters together" turns one free slot into
  /// several starts that each believe they have it.
  private var reserveQueue: [(String?, String) -> Void] = []

  private weak var crew: CrewAirtimeSink?

  private init() {
    // ARMED BEFORE ANY DEBT CAN BE BORN, and armed HERE rather than in a
    // session's start: a hop that is only wired once a walkie has opened
    // is a hop that is missing for the first debt, which is the one that
    // matters. The book stays the debt phase's substrate — it is what
    // this arbiter's `debt` phase is made of.
    AdvertiserDebtBook.shared.armBookChange { [weak self] why, clear in
      self?.noteBookChanged(why, clear: clear)
    }
    lastBody = body(why: "init")
  }

  // ------------------------------------------------------ the clients

  /// CrewBeacon introduces itself. Weak, because the bridge owns the
  /// module's lifetime and this is not the debt book (whose release
  /// condition is a READ of the object it holds, which is why THAT one
  /// holds strongly). A nil sink is a CrewBeacon that was never
  /// constructed in this process, and the gate below is what makes that
  /// an enforceable fact rather than an assumption: a beacon built later,
  /// mid-lease, is refused by the same rule.
  func registerCrew(_ sink: CrewAirtimeSink) {
    lock.lock()
    crew = sink
    lock.unlock()
  }

  /// THE GATE, and the ruling's own sentence compiled: "CrewBeacon may
  /// advertise iff no Walkie lease occupies any phase." Read at the
  /// effect site — the line that actually calls startAdvertising — so
  /// that no JS flag, no cached bit and no ordering accident can put the
  /// second advertiser on the air.
  var crewMayAdvertise: Bool {
    lock.lock()
    defer { lock.unlock() }
    return lease == nil
  }

  /// A state sink, by exact token. The current state is replayed
  /// immediately, so a subscriber that attached one turn after a
  /// transition is not one transition behind.
  func addSink(_ emit: @escaping ([String: Any]) -> Void) -> String {
    lock.lock()
    let token = "s\(nextSink)"
    nextSink += 1
    sinks[token] = emit
    let replay = lastBody
    lock.unlock()
    emit(replay)
    return token
  }

  /// …and only ever its own. A bridge invalidate in ANY phase removes one
  /// sink and touches no lease: the hold is the process's, not the
  /// bridge's, and a reload must never hand the slot back by disconnecting.
  func removeSink(_ token: String?) {
    guard let token else { return }
    lock.lock()
    sinks.removeValue(forKey: token)
    lock.unlock()
  }

  // ------------------------------------------------------- the state

  /// THE WHOLE STATE, ONE VERSIONED BODY, on every revision and from the
  /// query alike (S3). Built under the lock by its callers.
  private func body(why: String) -> [String: Any] {
    let l = lease
    let phase = l?.phase ?? .idle
    let debts = AdvertiserDebtBook.shared.ledger().open
    return [
      "v": Self.wireVersion,
      "processIncarnation": incarnation,
      // DECIMAL STRING, and the hi/lo pair beside it. A UInt64 handed to
      // JSON becomes a Number, and above 2^53 the order relation this
      // whole mechanism rests on stops being an order.
      "revision": String(revision),
      "revisionHi": NSNumber(value: UInt32(truncatingIfNeeded: revision >> 32)),
      "revisionLo": NSNumber(value: UInt32(truncatingIfNeeded: revision)),
      "phase": phase.rawValue,
      "leaseId": l?.id ?? NSNull(),
      "opId": l?.opId ?? NSNull(),
      "rung": (l?.rung ?? .none).rawValue,
      "debtCount": debts,
      // DERIVED, never a field to keep in step: the crew beacon may
      // advertise exactly when no lease occupies any phase.
      "crewMayAdvertise": l == nil,
      "holdRequired": l != nil,
      "why": why,
    ]
  }

  /// One transition. Call with the lock HELD; it returns the body to
  /// broadcast once the caller has released it.
  private func bump(_ why: String) -> [String: Any] {
    revision += 1
    let b = body(why: why)
    lastBody = b
    return b
  }

  private func broadcast(_ b: [String: Any]) {
    lock.lock()
    let live = Array(sinks.values)
    lock.unlock()
    for emit in live {
      emit(b)
    }
  }

  /// The query road. Same body the event carries, built the same way, so
  /// an asker and a subscriber are reading one level rather than two
  /// accounts of it.
  func currentState() -> [String: Any] {
    lock.lock()
    let b = body(why: "query")
    lock.unlock()
    return b
  }

  // ------------------------------------------------------ reservation

  /**
   RESERVE — ATOMICALLY, UNDER THE LOCK, BEFORE ANSWERING (arbiter
   addendum 2).

     "current admit is debt query only; two debt-free starts both pass,
     and final debt settlement wakes all waiters together. Reserve one
     lease under lock before returning; queue/wake at most one next start
     after clear."

   A DEBT QUERY IS A QUESTION ABOUT THE PAST. Two starts that both ask it
   in the same turn both get the same true answer and both proceed, and
   the phone then has two advertisers because nothing in between wrote
   anything down. So this WRITES FIRST: the lease is minted under the lock
   and the second caller finds a lease rather than an answer.

   AND IT ANSWERS ON THE CALLER'S OWN TURN when it can. A reservation that
   came back a hop later would leave the caller holding no identity in the
   window between asking and owning — and a stop arriving in that window
   would read `notOwner` against a lease that was about to be its own.

   THREE ROADS OUT, and no fourth. An idle arbiter mints. A lease in any
   live phase REFUSES immediately — a session with no rung 3 is the
   ladder's own fail-soft answer, and a refusal the camper is still
   standing there for is better than one they wait out. A lease in `debt`
   PARKS the caller and re-drives the book, because re-issuing the stop is
   the single most likely thing to end a wedge and the debt may well clear
   inside the window.
   */
  func reserve(_ answer: @escaping (String?, String) -> Void) {
    lock.lock()
    if let l = lease {
      if l.phase == .debt {
        reserveQueue.append(answer)
        lock.unlock()
        vlog("airtime reserve parked behind debt")
        // RE-DRIVE, THEN LET THE CLEAR DECIDE. A parked reservation is
        // woken only by `noteBookChanged`, so this call's own answer is
        // read for one thing: a book that will NOT come clean inside the
        // window, which is the refusal the camper can see.
        AdvertiserDebtBook.shared.admitNewAdvertiser { [self] clear, why in
          guard !clear else { return }
          failParkedReserves(why)
        }
        return
      }
      let phase = l.phase
      lock.unlock()
      vlog("airtime reserve refused phase=" + phase.rawValue)
      answer(nil, "busy")
      return
    }
    let l = AirtimeLease(id: "\(incarnation)/L\(nextLease)", opId: "O\(nextOp)")
    nextLease += 1
    nextOp += 1
    lease = l
    let b = bump("reserve")
    lock.unlock()
    vlog("airtime reserved lease=" + l.id)
    broadcast(b)
    answer(l.id, "reserved")
  }

  /// Every parked reservation is refused at once when the book will not
  /// come clean — refusing takes no slot, so the at-most-one rule that
  /// governs WAKING does not apply to refusing.
  private func failParkedReserves(_ why: String) {
    lock.lock()
    let parked = reserveQueue
    reserveQueue = []
    lock.unlock()
    for p in parked {
      p(nil, why)
    }
  }

  // --------------------------------------------------- crew suppression

  /**
   THE ARBITER OWNS THE SUPPRESSION EFFECT (S2).

     "arbiter owns CrewBeacon suppression effect — JS advertisingHeld/stop
     request is not proof; if suppression cannot be effect-proven,
     degrade/refuse Walkie peripheral advertiser, never overlap."

   Two 128-bit UUIDs do not fit one advertising packet and CoreBluetooth
   does not revisit the overflow decision afterwards, so "I asked the crew
   beacon to stop" is worth nothing: the question is whether it STOPPED.
   The sink proves it or it does not, and a lease that could not get the
   proof does not get an advertiser. Degrading costs this session rung 3;
   overlapping costs every Android in the pod its view of this iPhone,
   which is the measured defect this whole lane exists against.
   */
  func suppressCrew(lease id: String, _ done: @escaping (Bool, String) -> Void) {
    lock.lock()
    guard let l = lease, l.id == id, l.phase == .reserving else {
      lock.unlock()
      done(false, "not-owner")
      return
    }
    l.phase = .suppressingCrew
    let b = bump("suppressing-crew")
    let sink = crew
    lock.unlock()
    broadcast(b)
    guard let sink else {
      // NO SINK IS NOT AN ASSUMPTION HERE, because the gate makes it a
      // fact: CrewBeacon registers in its own init, so an unregistered
      // sink is a module this process never constructed and therefore
      // never advertised — and one constructed a moment from now reads
      // `crewMayAdvertise` at its own effect site and is refused there.
      finishSuppress(id, proven: true, why: "crew-unregistered", done)
      return
    }
    sink.suppressCrewAdvertising { [self] proven, why in
      finishSuppress(id, proven: proven, why: why, done)
    }
  }

  private func finishSuppress(
    _ id: String,
    proven: Bool,
    why: String,
    _ done: @escaping (Bool, String) -> Void
  ) {
    lock.lock()
    guard let l = lease, l.id == id, l.phase == .suppressingCrew else {
      lock.unlock()
      done(false, "not-owner")
      return
    }
    if proven {
      l.phase = .starting
    } else {
      // DEGRADE, NEVER OVERLAP. The lease keeps the slot — it is still a
      // hold and the crew beacon is still gated — but no walkie advertiser
      // is minted at all, so there is nothing to overlap WITH.
      l.phase = .active
      l.rung = .degraded
    }
    let b = bump(proven ? "crew-suppressed" : "degraded-no-suppression-proof")
    lock.unlock()
    vlog("airtime suppress lease=" + id + " proven=" + String(proven) + " why=" + why)
    broadcast(b)
    done(proven, why)
  }

  // ---------------------------------------------------------- the start

  /**
   THE START OP IS TERMINAL-ONLY (arbiter addendum 3).

     "bridge resolves after async ble.start; admission refusal only logs
     and no didStartAdvertising(error) settlement exists. State must
     distinguish reserved->starting->active|degraded/error; start returns
     structured outcome only after chosen rung reaches terminal, and
     snapshot cannot call it advertiserActive before effect."

   `armStart` retains the lease's stop handle and arms the budget. The
   START OP's own structured terminal — `terminal(rung, why)` — is called
   exactly once, by the advertiser's OWN didStartAdvertising delegate
   (success or error), by a state callback that ends the rung, or by that
   budget. Only then does the lease leave `starting`.

   AND THE LAN RUNG DOES NOT WAIT FOR IT. The ladder's own law is that a
   BLE failure contributes no peers and the rungs above run regardless
   (docs/WALKIE-LADDER.md §1), so Walkie.start's promise stays the LAN
   verb's and this op's terminal reaches JS through the state stream.
   What the addendum forbids is a snapshot calling the rung ACTIVE before
   its effect, and that is enforced absolutely: until this settles, the
   phase is `starting` and the rung is `none`.
   */
  func armStart(
    lease id: String,
    stopper: @escaping (@escaping (Bool, String) -> Void) -> Void,
    _ terminal: @escaping (AirtimeRung, String) -> Void
  ) {
    lock.lock()
    guard let l = lease, l.id == id, l.phase == .starting else {
      lock.unlock()
      terminal(.none, "not-owner")
      return
    }
    // RETAINED ON THE LEASE, not on the module. See AirtimeLease.
    l.stopper = stopper
    lock.unlock()
    // The budget is the only thing between a radio that never calls its
    // delegate back and a start op that never has a terminal at all.
    timers.asyncAfter(
      deadline: .now() + Self.startEffectTick * Double(Self.startEffectBudget)
    ) { [self] in
      noteStartEffect(lease: id, rung: .degraded, why: "advertiser-no-callback", terminal)
    }
  }

  /// The advertiser's own delegate speaking — `didStartAdvertising` with
  /// or without an error, which before this commit had no settlement at
  /// all and simply left the state claiming whatever it claimed.
  /// Idempotent by the phase guard: whichever road arrives first is THE
  /// terminal, and the ones behind it change nothing.
  func noteStartEffect(
    lease id: String,
    rung: AirtimeRung,
    why: String,
    _ terminal: ((AirtimeRung, String) -> Void)? = nil
  ) {
    lock.lock()
    guard let l = lease, l.id == id, l.phase == .starting else {
      lock.unlock()
      return
    }
    l.phase = .active
    l.rung = rung
    let b = bump(rung == .advertising ? "active" : "degraded")
    lock.unlock()
    vlog("airtime start-effect lease=" + id + " rung=" + rung.rawValue + " why=" + why)
    broadcast(b)
    terminal?(rung, why)
  }

  // ----------------------------------------------------------- the stop

  /**
   THE STOP IS A BARRIER, AND DUPLICATES COALESCE ONTO ONE TERMINAL
   (the ruling, and arbiter addendum 1).

     "stop1 nils instance bleVoice before async proof; stop2 sees nil, debt
     book still empty, answers clear and releases while stop1 advertiser
     may radiate. Arbiter must retain phase=stopping with exact lease and
     coalesce duplicate stops onto the SAME terminal promise; no clear
     until exact proof/debt transfer."

   The old shape could not express that sentence: "am I stopping?" was a
   module field that the stop cleared on its way IN, so the second tap
   asked a question whose answer had already been erased by the first. The
   phase is the answer now, it lives on the lease, and the lease outlives
   the instance.

   THREE ANSWERS AND NO FOURTH:

     clear     the exact owner's advertiser is PROVEN down and the process
               owes nothing. Only here does the slot go back, and the
               arbiter itself is what hands it back (S4).
     debt      the proof could not arrive, so the advertiser moved onto
               the book and the lease is DEMOTED rather than retired. The
               owner is released; the hold is not.
     notOwner  this caller never held this lease. Nothing is released,
               nothing is proven, and the answer says so — a second module
               instance's stop cannot end the first one's hold (S1).

   `unknown` is deliberately not producible here. The arbiter always knows
   which of the three happened; `unknown` is what the JS boundary yields
   when it cannot understand the answer at all, and its whole contract is
   that it is never `clear` (S7).
   */
  func stop(
    lease id: String?,
    _ done: @escaping (AirtimeStopOutcome, String, String) -> Void
  ) {
    lock.lock()
    let requestId = "R\(nextRequest)"
    nextRequest += 1
    guard let l = lease else {
      // NOTHING OWNS THE AIR, so there is nothing to hand back and nothing
      // to hold. `clear` is the exact answer here and `notOwner` would be
      // a lie in the dangerous direction — it would park a hold that was
      // never taken, which is the strand this whole lane is against.
      lock.unlock()
      done(.clear, "no-lease", requestId)
      return
    }
    guard let id, l.id == id else {
      lock.unlock()
      done(.notOwner, "not-owner", requestId)
      return
    }
    if l.phase == .debt {
      // The owner already released and the hold outlived them. Answering
      // `debt` rather than `notOwner` is the honest word: this caller's
      // obligation is real and it is still outstanding.
      lock.unlock()
      done(.debt, "already-in-debt", requestId)
      return
    }
    if l.phase == .stopping {
      // THE COALESCE. One operation, one terminal, many callers — and no
      // caller answers on its own while the first one's advertiser may
      // still be radiating.
      l.stopWaiters.append((requestId: requestId, answer: done))
      lock.unlock()
      vlog("airtime stop coalesced lease=" + id + " req=" + requestId)
      return
    }
    l.phase = .stopping
    l.opId = "O\(nextOp)"
    nextOp += 1
    l.stopWaiters = [(requestId: requestId, answer: done)]
    let stopper = l.stopper
    let b = bump("stopping")
    lock.unlock()
    vlog("airtime stopping lease=" + id + " req=" + requestId)
    broadcast(b)
    guard let stopper else {
      // A lease that never reached `starting` minted no advertiser, so
      // there is nothing OF ITS OWN to prove. The book still decides,
      // because the slot belongs to the process and not to this lease.
      settleStop(id, down: true, why: "no-advertiser")
      return
    }
    stopper { [self] down, why in
      settleStop(id, down: down, why: why)
    }
  }

  /// The stop's own terminal, and the ONE place a hold may end.
  private func settleStop(_ id: String, down: Bool, why: String) {
    guard down else {
      // The prover moved this manager onto the book BEFORE it answered
      // false (proveAdvertiserDown keeps that order on purpose), so the
      // obligation is already live and this is the transfer.
      finishStop(id, clear: false, why: why)
      return
    }
    // THE SECOND QUESTION, AND IT IS NOT OPTIONAL: this lease proved its
    // own advertiser, but the slot belongs to the PROCESS. A book that
    // still owes is a debt transfer, not a clear. Asked HERE and nowhere
    // else — one owner for the process-scoped question, so the two scopes
    // can never drift into disagreement.
    AdvertiserDebtBook.shared.service(within: AdvertiserDebtBook.reconcileWindow) {
      [self] clear, bookWhy in
      finishStop(id, clear: clear, why: clear ? why : bookWhy)
    }
  }

  private func finishStop(_ id: String, clear: Bool, why: String) {
    lock.lock()
    guard let l = lease, l.id == id, l.phase == .stopping else {
      lock.unlock()
      return
    }
    let waiters = l.stopWaiters
    l.stopWaiters = []
    l.stopper = nil
    let out: Retirement
    if clear {
      out = retireLease(why: "stop-clear")
    } else {
      // DEMOTED, NOT RETIRED. The owner is gone and the hold is not:
      // nothing else may take the slot while the book owes.
      l.phase = .debt
      l.rung = .none
      out = Retirement(body: bump("debt-transfer"), resumeCrew: false, handoff: nil)
    }
    lock.unlock()
    vlog("airtime stop lease=" + id + " outcome=" + (clear ? "clear" : "debt") + " why=" + why)
    apply(out)
    for w in waiters {
      w.answer(clear ? .clear : .debt, why, w.requestId)
    }
  }

  // ------------------------------------------------------- retirement

  /// WHAT A RETIREMENT PRODUCES, as data rather than as three branches
  /// that must agree: the body to broadcast, whether the crew beacon gets
  /// its slot back, and which parked reservation (at most one) takes it
  /// instead. Both roads out of a hold — a proven stop and a settled debt
  /// — build one of these, so the two cannot drift apart.
  private struct Retirement {
    let body: [String: Any]
    let resumeCrew: Bool
    let handoff: (waiter: (String?, String) -> Void, id: String)?
  }

  /// Lock HELD. Retires the standing lease and decides what takes its
  /// place: at most ONE parked reservation (arbiter addendum 2), and the
  /// crew beacon only when nobody is waiting — so the beacon never flaps
  /// up and down between two back-to-back walkie sessions.
  private func retireLease(why: String) -> Retirement {
    // THE INVARIANT, ENFORCED RATHER THAN ARGUED. Every debt is born from
    // a lease's own stop, so a retirement should never meet an owing book
    // — and "should never" is exactly the sentence that ships an overlap.
    // A book that owes demotes instead: the hold survives its owner.
    if AdvertiserDebtBook.shared.ledger().open > 0, let l = lease {
      l.phase = .debt
      l.rung = .none
      l.stopper = nil
      return Retirement(body: bump("debt-transfer"), resumeCrew: false, handoff: nil)
    }
    lease = nil
    if reserveQueue.isEmpty {
      return Retirement(body: bump(why), resumeCrew: true, handoff: nil)
    }
    let next = reserveQueue.removeFirst()
    let fresh = AirtimeLease(id: "\(incarnation)/L\(nextLease)", opId: "O\(nextOp)")
    nextLease += 1
    nextOp += 1
    lease = fresh
    return Retirement(
      body: bump(why + "-handoff"),
      resumeCrew: false,
      handoff: (waiter: next, id: fresh.id)
    )
  }

  /// …and the effects, all of them outside the lock.
  private func apply(_ r: Retirement) {
    broadcast(r.body)
    if r.resumeCrew {
      // THE RELEASE IS A DIRECT ARBITER ACTION against the lease it just
      // retired (S4) — never a JS action from a snapshot that was true
      // when it was built and false when it was read.
      crewSink()?.resumeCrewAdvertising()
    }
    if let h = r.handoff {
      h.waiter(h.id, "reserved")
    }
  }

  private func crewSink() -> CrewAirtimeSink? {
    lock.lock()
    defer { lock.unlock() }
    return crew
  }

  // ------------------------------------------------------- the debt phase

  /// The book moved. A BIRTH and a SETTLE are both airtime-ownership
  /// changes, so both revision the state (S3) — the old shape published
  /// only the clear edge, and a debt being born was invisible to every
  /// reader until something else happened to ask.
  private func noteBookChanged(_ why: String, clear: Bool) {
    lock.lock()
    guard let l = lease, l.phase == .debt, clear else {
      let b = bump(clear ? "book-clear" : "book-changed")
      lock.unlock()
      broadcast(b)
      return
    }
    _ = l
    // THE DEBT PHASE ENDS, and this is the second of exactly two roads out
    // of a hold. At most one parked reservation takes the slot straight
    // from here.
    let out = retireLease(why: "debt-settled")
    lock.unlock()
    vlog("airtime debt settled why=" + why)
    apply(out)
  }
}

// --------------------------------------------------- the advertiser debts

/**
 A PROCESS-LIFETIME BOOK OF UNPROVEN ADVERTISERS, beside the quarantine and
 above WalkieBleVoice for the same reason the quarantine is: the fact
 outlives the module that produced it.

 THE FINDING IT CURES (cross-family read of 2edcc6a, 2026-08-27):

   "budget-out forgets advertiser A: Walkie clears bleVoice, JS skips hold
   release, duplicate stop early-exits, and new start has no debt gate.
   Result: mail hold can strand forever; B may start; closing proven B
   releases CrewBeacon while forgotten A may still radiate."

 2edcc6a proved the EFFECT of a stop and failed closed when it could not.
 What it never did was REMEMBER the failure. `proveAdvertiserDown` ran out
 of looks, answered `false`, and returned — and that return dropped the
 last strong reference to the CBPeripheralManager it had just failed to
 prove quiet. From that instant this process owned an advertiser it could
 neither see nor stop, and every later question about the air was answered
 by whoever happened to ask it, in ignorance of A: a duplicate stop said
 "absent", a new session minted B beside A, and closing the PROVEN B handed
 the advertising slot back while A was possibly still radiating.

 A BUDGET IS A CADENCE, NOT A VERDICT. That is the whole correction. Four
 looks over one second is how long the CAMPER may be made to wait for a
 promise, and 2edcc6a is right to settle the promise there and fail closed.
 It is not how long the RADIO may be watched. So budget exhaustion now
 DEMOTES the proof onto this book's slow tick and keeps it running; the
 obligation ends only on a TERMINAL, of which there are exactly two:

   late-not-advertising  a fresh `isAdvertising == false` — the fast
                         prover's P3, arriving after the promise already
                         failed closed.
   late-power-off        an OBSERVED, EXACT `.poweredOff` on that manager's
                         own state — P2. `.unauthorized`, `.unsupported`
                         and `.resetting` are NOT this and settle nothing:
                         they say nothing about what is radiating, which is
                         the same rule the fast prover keeps.

 There is no third road and NO EXPIRY. `false` from the budget is not a
 terminal — it is the instant the debt is BORN. A debt that never settles
 is a process that never hands the advertising slot back, and that is the
 honest end state for a phone whose BLE stack will not answer: a degraded
 crew beacon forever, never an overlap. (P1 — "the manager is absent" — is
 not a terminal here either, and cannot be: this book is the thing holding
 it, so absence is a statement about our own bookkeeping, not about the
 air.)

 THE MANAGER IS HELD STRONGLY, the exact opposite of the quarantine's weak
 boxes, and the difference is not an inconsistency. The quarantine's
 release condition IS the object's death, so holding one would wedge the
 very thing it exists to free. This book's release condition is a READ OF
 the object, so dropping it would make the obligation unanswerable — the
 same reasoning that already makes `proveAdvertiserDown` capture `self`
 strongly, carried one scope further out.

 THE PROOF IDENTITY TRAVELS WITH THE MANAGER. A CBPeripheralManager's state
 belongs to the queue it was minted on, and the WalkieBleVoice that minted
 it is gone by the time this book is asked, so the record carries that
 queue: every read, every re-issued `stopAdvertising()` and every terminal
 happens ON IT. The book's own lock guards the map and nothing else, and no
 radio call is ever made under it.

 WHO ASKS, AND WHAT THEY GET:

   owe()                 the fast prover's budget ran out. Opens the debt
                         and starts the slow chain.
   service(within:)      RE-DRIVE every open debt now, at the fast tick,
                         and answer when the book is CLEAR — or refuse with
                         `advertiser-debt` when it did not come clean
                         inside the window. This is the one answer three
                         different callers need: a stop that has proven its
                         OWN advertiser (the slot belongs to the process,
                         not to that instance), a DUPLICATE stop that has
                         no advertiser of its own (absence is proof only
                         when the book is clear), and —
   admitNewAdvertiser()  — the NEW-START gate, which is `service` under the
                         name that says what it decides.
   onBookClear           set by Walkie.swift: the RCTEventEmitter hop that
                         tells JS the LAST debt went terminal, so the crew
                         beacon release it had to skip can finally run.
 */
final class AdvertiserDebtBook {
  static let shared = AdvertiserDebtBook()

  /// THE DEMOTED CADENCE. Deliberately far slower than
  /// `advertiserProofTick`: nobody is waiting on this one — the promise
  /// already settled `false` and the airtime hold is already set — so a
  /// wedged stack costs one state read every two seconds instead of four a
  /// second, for as long as it stays wedged.
  static let debtTick: TimeInterval = 2

  /// THE BOUNDED WINDOW a caller may wait for the book to come clean.
  /// Reconciliation re-drives at the FAST tick, so this is that budget
  /// (advertiserProofBudget * advertiserProofTick = 1 s) plus a tick of
  /// slack — long enough for a stack that was merely busy to answer the
  /// re-issued stop, short enough that a refused start is refused while the
  /// camper is still standing there.
  static let reconcileWindow: TimeInterval = 1.5

  /// The code a refusal carries, on both sides of the bridge.
  static let refusalCode = "advertiser-debt"

  /// ONE OPEN DEBT.
  private struct Debt {
    let id: Int
    /// STRONG, on purpose — see the class note.
    let mgr: CBPeripheralManager
    /// THE PROOF IDENTITY: the queue this manager's state belongs to.
    let queue: DispatchQueue
    var looks: Int
    /// Bumped whenever a fresh chain of looks takes over (a reconcile, a
    /// duplicate stop). A look whose chain is stale returns WITHOUT
    /// rescheduling, so there is always exactly ONE live chain per debt —
    /// two would double the radio traffic and race their own reschedules.
    var chain: Int
  }

  /// A parked caller, one-shot. A class so the timeout road and the
  /// clearing road can race for the same flag without racing the answer.
  private final class Waiter {
    var fired = false
    let answer: (Bool, String) -> Void
    init(_ answer: @escaping (Bool, String) -> Void) { self.answer = answer }
  }

  private let lock = NSLock()
  private var debts: [Int: Debt] = [:]
  private var waiters: [Waiter] = []
  private var nextId = 1
  /// THE ARBITER'S OWN HOP. It fires on every CHANGE — a birth as well as
  /// a settle — because both are airtime-ownership changes and the state
  /// above this book publishes a revision for each (S3). The old shape
  /// announced only the clear EDGE, so a debt being born was invisible to
  /// every reader until something else happened to ask.
  private var bookChanged: ((String, Bool) -> Void)?

  /// The book's own queue, for the reconcile TIMEOUT only. Never used to
  /// touch a manager: that is always the debt's own queue.
  private let timers = DispatchQueue(label: "playapal.walkie.debt")

  /// The arbiter's hop. Set through the lock because it is written from
  /// the arbiter's own init and read from a debt's queue.
  ///
  /// ARMED ONCE, BY THE ARBITER, AND NEVER BY A SESSION. A hop wired at
  /// the first walkie start is a hop that is missing for the first debt,
  /// which is the debt that matters — so the owner of the airtime arms it
  /// when the process mints the arbiter, before anything can owe.
  func armBookChange(_ hop: @escaping (String, Bool) -> Void) {
    lock.lock()
    bookChanged = hop
    lock.unlock()
  }

  /**
   THE BOOK AS A LEVEL, IN ONE READ — how many advertisers this process has
   failed to prove quiet and has not yet accounted for, and an EPOCH that
   changes every time that answer's cause changes.

   ONE LOCK ACQUISITION, and that is the whole reason this is one accessor
   rather than two. A caller that asked the count and the epoch separately
   would be reading two different moments and calling the pair a state; the
   airtime snapshot above this book is exactly the kind of composite that
   defect hides in.

   THE EPOCH IS DERIVED, NOT KEPT — no new field, no new write, nothing in
   the debt machinery to keep in step. `nextId` already counts every debt
   ever BORN and `debts.count` is how many are still open, so
   `births - open` is how many have SETTLED. Both halves only ever go up,
   and every airtime-ownership change in this book moves exactly one of
   them: a birth bumps births, a terminal bumps settles. Their sum is
   therefore strictly monotonic across both, which is what a token has to
   be to fence a stale snapshot out.

   IT READS, IT DOES NOT PROVE (the rule `openDebts` carried and this
   keeps): the answer comes off the book under the book's own lock and
   touches no radio. Proving stays the debt chain's job, on each manager's
   own queue.
   */
  func ledger() -> (open: Int, epoch: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    let births = nextId - 1
    let open = debts.count
    let settles = births - open
    return (open: open, epoch: UInt64(births + settles))
  }

  // ------------------------------------------------------------ the debt

  /**
   THE BUDGET RAN OUT — so the manager moves in HERE rather than out of
   scope, and the proof continues on the slow chain.

   Called from `proveAdvertiserDown` immediately BEFORE it answers `false`.
   The order matters and it is not cosmetic: the promise's `false` is what
   holds the crew beacon off the air, and the debt is what will eventually
   let it back on. Opening the debt second would leave a window in which
   JS has been told "unproven" and nothing in this process is watching.
   */
  @discardableResult
  func owe(_ mgr: CBPeripheralManager, on queue: DispatchQueue) -> Int {
    lock.lock()
    let id = nextId
    nextId += 1
    debts[id] = Debt(id: id, mgr: mgr, queue: queue, looks: 0, chain: 1)
    let open = debts.count
    let hop = bookChanged
    lock.unlock()
    vlog("advertiser-debt-open id=" + String(id) + " open=" + String(open))
    // A BIRTH IS A CHANGE. Announced outside the lock, like every other
    // call back out of this book, so the one lock order above it holds.
    hop?("debt-born", false)
    queue.asyncAfter(deadline: .now() + Self.debtTick) { [self] in
      look(id, chain: 1, fast: false)
    }
    return id
  }

  /**
   ONE LOOK AT ONE DEBT, ON THAT DEBT'S OWN QUEUE. Two roads out and no
   third: a terminal, or another look. The stop is RE-ISSUED between looks
   for the same reason T4's lease re-issues its cancel and the fast prover
   re-issues this one — a stack that swallowed the first request is the
   case the whole mechanism exists for.
   */
  private func look(_ id: Int, chain: Int, fast: Bool) {
    lock.lock()
    guard let debt = debts[id], debt.chain == chain else {
      lock.unlock()
      return
    }
    lock.unlock()
    // EVERY READ OF THE MANAGER HAPPENS HERE, on the queue it was minted
    // on. A state read from anywhere else is a race against the delegate
    // callbacks rather than a turn behind them.
    debt.queue.async { [self] in
      if debt.mgr.state == .poweredOff {
        settle(id, "late-power-off")
        return
      }
      if !debt.mgr.isAdvertising {
        settle(id, "late-not-advertising")
        return
      }
      debt.mgr.stopAdvertising()
      lock.lock()
      guard var live = debts[id], live.chain == chain else {
        lock.unlock()
        return
      }
      live.looks += 1
      debts[id] = live
      let looks = live.looks
      lock.unlock()
      vlog(
        "advertiser-debt-open id=" + String(id) + " looks=" + String(looks) +
          " fast=" + String(fast)
      )
      let next = fast ? WalkieBleVoice.advertiserProofTick : Self.debtTick
      debt.queue.asyncAfter(deadline: .now() + next) { [self] in
        look(id, chain: chain, fast: fast)
      }
    }
  }

  /// A TERMINAL, and the only transition out of a debt. Idempotent: a
  /// second settle for an id already closed touches nothing, so two chains
  /// arriving at the same fact cannot clear the book twice.
  private func settle(_ id: Int, _ why: String) {
    lock.lock()
    guard debts.removeValue(forKey: id) != nil else {
      lock.unlock()
      return
    }
    let clear = debts.isEmpty
    var woken: [Waiter] = []
    if clear {
      woken = waiters.filter { !$0.fired }
      for w in woken { w.fired = true }
      waiters = []
    }
    let hop = bookChanged
    lock.unlock()
    vlog(
      "advertiser-debt-terminal id=" + String(id) + " why=" + why +
        " clear=" + String(clear)
    )
    // THE LAST DEBT, AND ONLY THE LAST, for the WAITERS. Everything they
    // gate — a parked stop, a parked reservation, the arbiter's debt phase
    // — is a statement about the PROCESS having nothing unaccounted for,
    // never about one manager.
    for w in woken { w.answer(true, why) }
    // …and the arbiter hears EVERY terminal, because `debtCount` is part
    // of the published state and a state that only moves on the last one
    // is a state that lies about the two before it.
    hop?(why, clear)
  }

  // --------------------------------------------------------- the answers

  /**
   RE-DRIVE EVERYTHING AND ANSWER WHEN THE BOOK IS CLEAR.

   `answer(true, …)` is the one fact the crew beacon's release may follow:
   no advertiser this process ever failed to prove quiet is still
   unaccounted for. `answer(false, "advertiser-debt")` is the bounded
   refusal — the book did not come clean inside `within`, so whoever asked
   must fail closed exactly as the fast prover's budget-out does.

   The clear case answers SYNCHRONOUSLY and on the caller's own thread,
   which is what keeps the overwhelmingly common close costing nothing.
   */
  func service(within: TimeInterval, _ answer: @escaping (Bool, String) -> Void) {
    lock.lock()
    if debts.isEmpty {
      lock.unlock()
      answer(true, "no-debt")
      return
    }
    let waiter = Waiter(answer)
    waiters.append(waiter)
    var chains: [Int: Int] = [:]
    for id in debts.keys {
      debts[id]?.chain += 1
      chains[id] = debts[id]?.chain ?? 0
    }
    let live = debts
    lock.unlock()
    vlog("advertiser-debt-service open=" + String(live.count))
    // A LOOK ON EVERY DEBT NOW, then the fast tick for the length of the
    // window. Re-issuing the stop is the single most likely thing to end a
    // wedge, and servicing the debt is precisely what a duplicate stop is
    // FOR: the second tap is a second chance at the radio, not a no-op.
    for (id, debt) in live {
      debt.queue.async { [self] in
        look(id, chain: chains[id] ?? 0, fast: true)
      }
    }
    timers.asyncAfter(deadline: .now() + within) { [self] in
      wake(waiter, false, Self.refusalCode)
    }
  }

  /**
   THE NEW-START GATE. Minting a second advertiser while the first is
   unaccounted for IS the overlap this lane exists against, so a start
   consults the book before it mints anything.

   RECONCILE, THEN REFUSE — not a flat block, and the reason is the
   camper's. A flat block would refuse rung 3 for the life of a wedge that
   this very call is the best cure for: re-driving the stop is what ends
   most of them, and the debt loop may well have cleared the book between
   the close and the reopen. So the gate re-drives at the fast tick and
   admits the moment the book is clear; only a book that will not come
   clean inside `reconcileWindow` refuses, and a refusal is a session with
   no rung 3 — the ladder's own fail-soft law (a BLE failure contributes no
   peers, the rungs above run regardless), never a second advertiser.
   */
  func admitNewAdvertiser(_ ready: @escaping (Bool, String) -> Void) {
    service(within: Self.reconcileWindow, ready)
  }

  /// One-shot, whichever road gets there first.
  private func wake(_ waiter: Waiter, _ down: Bool, _ why: String) {
    lock.lock()
    if waiter.fired {
      lock.unlock()
      return
    }
    waiter.fired = true
    waiters.removeAll { $0 === waiter }
    let idle = waiters.isEmpty
    lock.unlock()
    waiter.answer(down, why)
    // NOBODY IS WAITING ANY MORE, so the fast chain goes back to the slow
    // one. A reconcile that timed out must not leave the phone reading its
    // radio four times a second forever.
    if idle {
      demote()
    }
  }

  /// Hands every open debt back to the slow chain.
  private func demote() {
    lock.lock()
    guard waiters.isEmpty else {
      lock.unlock()
      return
    }
    var chains: [Int: Int] = [:]
    for id in debts.keys {
      debts[id]?.chain += 1
      chains[id] = debts[id]?.chain ?? 0
    }
    let live = debts
    lock.unlock()
    for (id, debt) in live {
      debt.queue.asyncAfter(deadline: .now() + Self.debtTick) { [self] in
        look(id, chain: chains[id] ?? 0, fast: false)
      }
    }
  }
}

// --------------------------------------------------------- the generation

/**
 ONE DIAL, AND EVERYTHING THAT DIAL OWNS.

 A generation is minted by maybeConnect and is the sole owner of a
 CBCentralManager it created, the CBPeripheral THAT manager produced, both
 delegate seats, the discovered service and characteristics, the setup
 timer and every operation on the link. Nothing here is reachable from the
 durable peer entry except through `peer.link`, and nothing here is ever
 reassigned to a second dial: a redial mints a new object.

 RETIREMENT IS MONOTONIC AND COMES FIRST. `retire()` can only ever move
 false to true, and it drops the pipes and the delegate pointer BEFORE it
 asks the manager to cancel — so the disconnect that cancel provokes, the
 read that fails because the pipe closed, and the discovery that was
 already in flight all arrive at an object that is retired and holds
 nothing. Every handler's first line asks its own retirement, and there is
 nothing for one that forgot to reach.
 */
/// How the one IDENT op a link may run ENDED. Three of the five are
/// voice-safe; the two that are not are the only two that tear down.
enum IdentOutcome: String {
  /// NOTHING WENT ON THE AIR AND THE LINK IS FINE — a read-only IDENT, on
  /// a pipe that is up. The promptest settle there is, and the road every
  /// phone already in the dust takes. It says something specific about the
  /// FAR END'S GATT TABLE and nothing about our transport, which is why a
  /// dead transport may never borrow it.
  case skipped
  /// The far end took it.
  case acknowledged
  /// It went out and answered an error. Terminal, and voice-safe: a peer
  /// that declined an optional courtesy still carries our voice.
  case failed
  /// THE TRANSPORT WAS GONE before a byte could go out. NOT voice-safe: a
  /// peripheral that is not connected is not a stack refusing a write, it
  /// is a link that has ended, and no second offer down the same dead pipe
  /// can heal it.
  case dead
  /// identSettleCap fired with an op still outstanding. NOT voice-safe.
  case expired

  /// The one place voice-safety is decided, so a new outcome cannot be
  /// added without answering the question. Both `false` rows leave by
  /// generationFailed and publish nothing.
  var voiceSafe: Bool {
    switch self {
    case .skipped, .acknowledged, .failed: return true
    case .dead, .expired: return false
    }
  }
}

final class BleLinkGeneration: NSObject {
  /// Monotonic per process, for the log line and nothing else. NO GUARD
  /// ANYWHERE READS IT — a number that decides things is an epoch, and
  /// epochs are the shape four reverted rounds proved cannot work here.
  let id: Int
  /// The hash this dial was made against. `unknownSender` until the proof
  /// names the phone a truncated advertisement could not.
  let dialedHash: UInt32
  /// The address, which names the PHONE. Passed by the scanner as a fact;
  /// the object it resolves to is this generation's alone.
  let peripheralId: UUID
  /// The adapter epoch this dial was born under.
  let adapterEpoch: UInt64

  /// THE QUARANTINE TICKET THIS GENERATION HOLDS on its object, and the
  /// only thing that entitles it to cancel one. Nil until a claim is
  /// granted and nil again the instant it is spent, so a dial that never
  /// owned an object can never tear one down and a second retirement has
  /// nothing left to spend.
  private var claimTicket: UInt64?

  /// THE LEASE THIS RETIREMENT STILL OWES A TERMINAL FOR. `held` from the
  /// moment beginRetire authorizes until one proven completion (T1/T2/T3);
  /// `poisoned` when T4's budget ran out without one, which is FAIL-CLOSED
  /// and not a release; `spent` exactly once, after which every later
  /// terminal for the same ticket finds nothing and does nothing.
  private enum LeaseState {
    case idle
    case held(UInt64)
    case poisoned(UInt64)
    case spent
  }
  private var lease: LeaseState = .idle
  /// THE EXACT OBJECT THE LEASE IS OVER, and weak for the same reason the
  /// register's box is: its death is one of the two things that can free a
  /// poisoned record, and a strong box here would prevent the death.
  private weak var leasedObject: CBPeripheral?
  private var leaseRechecks = 0
  /// A RETIRING GENERATION MUST OUTLIVE ITS OWN CANCEL. CoreBluetooth
  /// holds a delegate weakly, so a generation nobody else references dies
  /// the moment the coordinator drops it — and T1, the terminal that
  /// completes the lease, would then be delivered to nothing. The hold is
  /// EXPLICIT and BOUNDED: taken when the lease is authorized, dropped the
  /// instant it is spent or poisoned, and T4's budget guarantees one of
  /// those two happens within `leaseRecheckBudget` ticks.
  private var leaseHold: BleLinkGeneration?
  /// The ticket a live lease is under, spent or poisoned alike — nil once
  /// there is no lease at all, which is what makes a stray callback a
  /// stray callback.
  private var leaseTicket: UInt64? {
    switch lease {
    case .held(let ticket), .poisoned(let ticket):
      return ticket
    case .idle, .spent:
      return nil
    }
  }

  private(set) var retired = false
  /// PUBLISHED, not merely proven: set by markReady() in the one place
  /// that hands the module a writer. A durable peer reads its liveness
  /// through here, so a flag can never outlive the link it describes —
  /// which is the defect the whole ready-link watchdog exists for, cured
  /// one layer lower.
  private(set) var ready = false

  private weak var owner: WalkieBleVoice?
  weak var peer: VoicePeer?
  private let queue: DispatchQueue

  /// THIS GENERATION'S OWN MANAGER. Not the scanner's, not shared, and
  /// never carrying a restoration identifier — several managers cannot
  /// share one, and a walkie that is open is a walkie in the foreground.
  private var manager: CBCentralManager?
  private(set) var peripheral: CBPeripheral?
  private(set) var service: CBService?
  private(set) var voiceChar: CBCharacteristic?
  private(set) var identChar: CBCharacteristic?

  /// THE WATCHDOG'S WHOLE STATE, and it is the LINK'S — not the peer's.
  /// A generation that dies takes its deadline and its refusal budget with
  /// it, so a new link arrives owing nothing and no timer from a dead one
  /// can reach it. Android has to reset these in dropClient because its
  /// peer entry outlives its links; here there is nothing to reset.
  private var lastProof: TimeInterval = 0
  private var probePending = false
  private var probeAt: TimeInterval = 0
  private var probeRefusals = 0

  /// ONE LOGICAL IDENT OP PER LINK GENERATION, and its token is the
  /// generation's own id — immutable, minted with the object, never
  /// reassigned. Every terminal path goes through settle(token:outcome:)
  /// and the first one to arrive is the only one that counts. There is no
  /// offer counter here any more: beginIdent makes exactly one offer, by
  /// the shape of the code rather than by a number.
  private var identOutstanding = 0
  private var identSettled = false
  /// The proof read came back and passed the pod and identity gates. The
  /// listing needs this AND a voice-safe settle AND no outstanding ack.
  private(set) var identProven = false
  /// The settle left this link safe to carry audio. False until settled,
  /// and false forever if the cap or a dead transport settled it.
  private(set) var identVoiceSafe = false
  var identOpsRemaining: Int { identOutstanding }
  /// IS THE PIPE UP RIGHT NOW. Asked at the offer AND again at the publish
  /// door: the setup read that proved this link and the settle that lists
  /// it are two moments, and the state can flip between them with the
  /// disconnect callback still queued behind us. A writer minted in that
  /// window is a camper talking into nothing.
  var transportConnected: Bool { peripheral?.state == .connected }

  init(
    id: Int,
    dialedHash: UInt32,
    peripheralId: UUID,
    owner: WalkieBleVoice,
    peer: VoicePeer,
    queue: DispatchQueue
  ) {
    self.id = id
    self.dialedHash = dialedHash
    self.peripheralId = peripheralId
    self.owner = owner
    self.peer = peer
    self.queue = queue
    adapterEpoch = BleObjectQuarantine.shared.adapterEpoch
    super.init()
  }

  /// Queue. Mints the manager; everything else waits on its state.
  func open() {
    vlog(
      "gen-mint gen=" + String(id) + " hash=" + hex(dialedHash) +
        " id=" + peripheralId.uuidString + " obj=" + objTag(self)
    )
    // No options dictionary AT ALL: CBCentralManagerOptionRestoreIdentifierKey
    // must be unique per manager and this rung mints one per dial, so state
    // restoration is not a thing this shape can have. Saying so here rather
    // than leaving an empty dictionary that a later edit could fill.
    manager = CBCentralManager(delegate: self, queue: queue)
    queue.asyncAfter(deadline: .now() + WalkieBleVoice.setupTimeout) { [weak self] in
      // ONLY THIS DIAL'S TIMER CAN KILL THIS DIAL, and it needs no epoch to
      // know: the timer belongs to the generation, and a generation that
      // has been retired or has gone ready is not something it can reach.
      guard let self, !self.retired, !self.ready else { return }
      vlog("setup-timeout gen=" + String(self.id) + " hash=" + hex(self.dialedHash))
      self.owner?.generationFailed(self, "setup-timeout")
    }
  }

  /// A NAME THIS GENERATION ANSWERS TO ACROSS INSTANCES. `id` alone
  /// restarts at 1 with every WalkieBleVoice, and the refusal this label
  /// appears in is the one that fires when two instances overlap — so the
  /// object tag is not decoration here, it is what tells gen 3 of the
  /// closing session from gen 3 of the opening one.
  private var claimLabel: String { "gen" + String(id) + "@" + objTag(self) }

  /// Queue. The manager is up: resolve the address to an object, CLAIM it,
  /// and only then take the delegate seat.
  private func attach() {
    guard !retired, let mgr = manager else { return }
    guard let per = mgr.retrievePeripherals(withIdentifiers: [peripheralId]).first else {
      vlog("gen-refuse gen=" + String(id) + " reason=no-object")
      owner?.generationFailed(self, "no-object")
      return
    }
    // FAIL CLOSED, AND UNDER THE QUARANTINE'S OWN LOCK. A fresh manager
    // handing back an object somebody still owns — a live generation whose
    // enqueued retirement has not run yet, or a retired one whose object
    // has not died yet — means this dial would inherit that link's
    // delegate seat and its outstanding operations, and that the other
    // link's teardown would land on ours. Both refuse before one byte of
    // state is bound to it: no delegate, no connect, one log line, and the
    // peer's backoff dials again.
    switch BleObjectQuarantine.shared.claim(per, id: peripheralId, label: claimLabel) {
    case .granted(let ticket):
      claimTicket = ticket
    case .active(let holder):
      vlog(
        "gen-refuse gen=" + String(id) + " reason=object-claimed obj=" + objTag(per) +
          " held=" + holder + " id=" + peripheralId.uuidString
      )
      owner?.generationFailed(self, "object-claimed")
      return
    case .retiring(let holder):
      // THE CANCEL WINDOW. Somebody's teardown of this exact object has
      // been authorized and not yet issued, so binding here is binding to
      // something that is about to be cancelled out from under us. Same
      // arc as a live claim, one dial and one log line, and the lease's
      // own finalize is what makes the address dialable again.
      vlog(
        "gen-refuse gen=" + String(id) + " reason=object-retiring obj=" + objTag(per) +
          " held=" + holder + " id=" + peripheralId.uuidString
      )
      owner?.generationFailed(self, "object-retiring")
      return
    case .retired(let holder):
      vlog(
        "gen-refuse gen=" + String(id) + " reason=object-alias obj=" + objTag(per) +
          " held=" + holder + " id=" + peripheralId.uuidString
      )
      owner?.generationFailed(self, "object-alias")
      return
    }
    peripheral = per
    per.delegate = self
    vlog(
      "connect gen=" + String(id) + " hash=" + hex(dialedHash) +
        " id=" + peripheralId.uuidString + " obj=" + objTag(per)
    )
    mgr.connect(per, options: nil)
  }

  /// Queue. MONOTONIC, and ordered so that everything the teardown
  /// provokes lands on an object that already holds nothing.
  func retire(_ why: String) {
    guard !retired else {
      return // monotonic: a second retirement is not an event
    }
    retired = true
    ready = false
    probePending = false
    service = nil
    voiceChar = nil
    identChar = nil
    let per = peripheral
    peripheral = nil
    let ticket = claimTicket
    claimTicket = nil
    if let per, let ticket {
      // THE RESERVATION COMES FIRST, and what comes back is this
      // retirement's permission to touch the object at all. Between this
      // line and the finalize below, that object is reserved for this
      // ticket: no claim may take it and no adapter epoch may free it, so
      // the cancel can only ever land on this generation's own link.
      switch BleObjectQuarantine.shared.beginRetire(per, claim: ticket, id: peripheralId) {
      case .authorized:
        // Cleared only while it is still OURS. A blind nil here would be a
        // retired link DEAFENING a replacement in one line — refused
        // structurally rather than argued about.
        if per.delegate === self {
          per.delegate = nil
        }
        // THE MANAGER SEAT IS NOT HANDED BACK. The cancel below is
        // NONBLOCKING — it books a teardown the stack performs later — and
        // T1, the disconnect for this exact object on this exact manager,
        // is the only thing that proves that teardown has landed. So this
        // generation keeps its manager, keeps its delegate seat on it and
        // keeps ITSELF alive, and while it retires it routes nothing out
        // of that seat except the completion of this lease.
        lease = .held(ticket)
        leasedObject = per
        leaseRechecks = 0
        leaseHold = self
        // READ BEFORE THE ISSUE, because the issue is what changes it.
        let atIssue = per.state
        // UNDER THE LEASE, never before it: the cancel's own disconnect
        // notice is the first late callback this generation will get.
        manager?.cancelPeripheralConnection(per)
        if atIssue == .disconnected {
          // T2 — THE ONE STATE THAT NEEDS NO TERMINAL. There was no link
          // to tear down, so the cancel is a no-op and there is no effect
          // that could ever land on anybody. `.disconnecting` is NOT this
          // case: a teardown already in flight is an effect still owed.
          _ = spendLease(per, ticket: ticket, why: "disconnected-at-issue", poisonToo: false)
        } else {
          // T4 arms here and nowhere else, so no road out of an authorized
          // lease is missing its no-wedge budget.
          scheduleLeaseRecheck()
        }
      case .superseded(let holder):
        // THE ENQUEUED-RETIREMENT WINDOW, closed. This generation's claim
        // was released out from under it (only an adapter epoch can do
        // that) and another link has since been built on this object. Its
        // delegate seat and its connection are not ours to end.
        vlog(
          "gen-supersede gen=" + String(id) + " obj=" + objTag(per) + " held=" + holder
        )
      case .absent:
        // NO LEASE, SO NO CANCEL. The object died, or the adapter cycled
        // and took the whole register with it. Either way this process no
        // longer owns this object, and a cancel issued without ownership
        // is exactly the shot that can hit a link somebody else has since
        // built on it — the review's first window, refused by not firing.
        vlog("gen-unowned gen=" + String(id) + " obj=" + objTag(per))
      }
    }
    vlog(
      "gen-retire gen=" + String(id) + " hash=" + hex(dialedHash) +
        " why=" + why + " obj=" + objTag(per)
    )
  }

  // ------------------------------------------------- spending the lease

  /// THE ONE PLACE A LEASE IS SPENT, and it is TICKET-IDEMPOTENT by
  /// construction: the lease leaves `.held` BEFORE the register is
  /// touched, so a second terminal for the same ticket — a duplicate
  /// didDisconnect, a poweredOff arriving behind one, a straggler after
  /// the poison — finds nothing to spend and transitions nothing.
  ///
  /// `poisonToo` is the one asymmetry the ruling draws: a poisoned lease
  /// is fail-closed and a late T1 may NOT lift it, because the disconnect
  /// this generation gave up waiting for proves nothing about a teardown
  /// the stack may still be sitting on. Only T3 — every link physically
  /// dead — may.
  @discardableResult
  private func spendLease(
    _ per: CBPeripheral, ticket: UInt64, why: String, poisonToo: Bool
  ) -> Bool {
    switch lease {
    case .held(let mine) where mine == ticket:
      break
    case .poisoned(let mine) where mine == ticket && poisonToo:
      break
    default:
      vlog("lease-dup gen=" + String(id) + " why=" + why + " obj=" + objTag(per))
      return false
    }
    lease = .spent
    leasedObject = nil
    leaseHold = nil
    switch BleObjectQuarantine.shared.finalizeRetire(per, claim: ticket, id: peripheralId) {
    case .tombstoned, .absent:
      vlog("lease-spent gen=" + String(id) + " why=" + why + " obj=" + objTag(per))
    case .released:
      vlog("gen-release gen=" + String(id) + " why=" + why + " obj=" + objTag(per))
    case .foreign(let holder):
      vlog("gen-foreign gen=" + String(id) + " obj=" + objTag(per) + " held=" + holder)
    }
    return true
  }

  /// T1 — THE PRIMARY COMPLETION, and the only work a retiring generation
  /// does in its delegate seat. THE EXACT reserved object, on THIS
  /// generation's own manager: another object is another link, another
  /// manager is another generation's stack, and neither can say anything
  /// about the teardown this lease is waiting on. Returns true when the
  /// callback was ours, so the handler above can stop there.
  private func noteLeaseTerminal(_ peripheral: CBPeripheral, central: CBCentralManager) -> Bool {
    guard let ticket = leaseTicket else { return false }
    guard let leased = leasedObject, peripheral === leased, central === manager else {
      return false
    }
    spendLease(leased, ticket: ticket, why: "did-disconnect", poisonToo: false)
    return true
  }

  /// T3 — an OBSERVED `.poweredOff` on this generation's own manager. The
  /// radio is gone, so every link it held is physically dead and the
  /// teardown this lease owed can no longer reach anybody. This is the one
  /// terminal that may also lift a poison, and the ONLY adapter fact that
  /// completes anything: a generic epoch turn, `.unknown`, `.resetting`
  /// and `.unauthorized` complete nothing.
  private func noteLeasePowerOff(_ central: CBCentralManager) -> Bool {
    guard let ticket = leaseTicket, central === manager else { return false }
    guard let leased = leasedObject else {
      // The object died under the lease; the register let the address go
      // with it and there is nothing left to spend.
      lease = .spent
      leaseHold = nil
      return true
    }
    spendLease(leased, ticket: ticket, why: "power-off", poisonToo: true)
    return true
  }

  /// T4 — THE NO-WEDGE FALLBACK, on this generation's own queue.
  private func scheduleLeaseRecheck() {
    queue.asyncAfter(deadline: .now() + WalkieBleVoice.leaseRecheckTick) { [weak self] in
      self?.leaseRecheck()
    }
  }

  /// A bounded look at the object the lease is over: if the stack has
  /// disconnected it after all, that is the terminal; if it is still up,
  /// re-issue the cancel; and when the budget is out, POISON — which
  /// refuses every future claim exactly as the lease did and is freed only
  /// by the exact object's death or a later proven T3.
  private func leaseRecheck() {
    guard case .held(let ticket) = lease else { return }
    guard let per = leasedObject else {
      // The weak box emptied: the object died, the register released the
      // address with it, and a dead object has no link left to kill.
      lease = .spent
      leaseHold = nil
      vlog("lease-object-died gen=" + String(id))
      return
    }
    if per.state == .disconnected {
      spendLease(per, ticket: ticket, why: "recheck-disconnected", poisonToo: false)
      return
    }
    leaseRechecks += 1
    if leaseRechecks > WalkieBleVoice.leaseRecheckBudget {
      lease = .poisoned(ticket)
      leaseHold = nil
      vlog(
        "lease-poison gen=" + String(id) + " obj=" + objTag(per) +
          " state=" + String(per.state.rawValue)
      )
      return
    }
    vlog(
      "lease-recheck gen=" + String(id) + " n=" + String(leaseRechecks) +
        " state=" + String(per.state.rawValue)
    )
    manager?.cancelPeripheralConnection(per)
    scheduleLeaseRecheck()
  }

  /// Queue. The one place `ready` becomes true, called by the coordinator's
  /// publish step — so "listed" and "ready" are the same instant on this
  /// rung, and §5's order is a property of one function rather than a race
  /// between two.
  func markReady() {
    guard !retired else { return }
    ready = true
    // A LINK IS BORN PROVEN: the setup's own ident read IS the first
    // proof, so it starts with a full window rather than owing one
    // immediately.
    lastProof = ProcessInfo.processInfo.systemUptime
    scheduleLiveness()
  }

  /// A ready link's ident read answered. THE WHOLE CONTENT OF THIS EVENT
  /// IS THAT IT ARRIVED, on the link our voice leaves on — nothing about
  /// the peer changes. Queue.
  func noteProof() {
    guard !retired else { return }
    probePending = false
    probeRefusals = 0
    lastProof = ProcessInfo.processInfo.systemUptime
  }

  // ------------------------------------------------ the ident handshake

  /// The one logical IDENT op this link may run. Queue.
  ///
  /// ORDERED BETWEEN THE PROOF AND THE LISTING — the one moment on this
  /// link where the audio path is provably idle, because onPeer has not
  /// yet handed the module a write function. Identity is never paid for
  /// in audio, and unlike this feature's first attempt that is a fact
  /// about the WIRE and not about source order: the writer is published
  /// by the SETTLE, so nothing can ride this link until the exchange is
  /// over.
  ///
  /// ONE OFFER, BY CONSTRUCTION, and this is the correction the third
  /// attempt still owed. af06a4e retried for a stack it thought was busy;
  /// e4b0923 removed that and kept ONE retry for the refusal it called
  /// certain — a peripheral that is not connected — and that is where it
  /// was wrong. `per.state != .connected` is not a stack declining a
  /// write. It is a TRANSPORT THAT HAS ENDED, an identical second offer
  /// down the same dead pipe cannot heal it, and settling it `skipped`
  /// handed a dead link the read-only peer's voice-safe publish. It
  /// retires here instead, by the one road out. What is left below is a
  /// straight line with exactly one writeValue on it.
  func beginIdent(_ bytes: Data) {
    guard !retired, !identSettled else { return }
    identProven = true
    // THE TRANSPORT, FIRST AND ONCE. Asked before the far end's GATT table
    // because it is a fact about OUR pipe and outranks anything the peer
    // does or does not permit. Not voice-safe, so it leaves through
    // generationFailed and the peer's backoff redials; nothing is lost but
    // seconds.
    //
    // AND AFTER THIS LINE THERE IS NO SYNCHRONOUS REFUSAL LEFT TO READ, so
    // nothing downstream can earn a second offer: CoreBluetooth's
    // writeValue(_:for:type:) returns Void and queues, and
    // canSendWriteWithoutResponse answers for the OTHER write type — ours
    // is .withResponse. An offer that gets past here has started as far as
    // this API can tell us, and its only terminals are the callback and
    // the cap.
    guard let per = peripheral, per.state == .connected else {
      vlog("ident-write-fail gen=" + String(id) + " reason=transport-dead")
      settle(id, .dead)
      return
    }
    guard let ch = identChar else {
      settle(id, .skipped)
      return
    }
    // AN OLD PEER'S IDENT IS READ-ONLY — every build-44 iPhone, every
    // 0.8.6 Android, and they are the phones in the dust this week — and
    // its discovered properties say so before a byte goes out. Asked and
    // answered here rather than by provoking the framework: this project's
    // iOS law is that Apple frameworks enforce preconditions by RAISING,
    // which Swift cannot catch. It is also the PROMPTEST settle there is —
    // not one byte goes out, so the link is audible in the same instant it
    // was proved. THIS IS THE ONLY ROAD TO `skipped`, and it means "the
    // pipe is up and nothing needed to go down it".
    guard ch.properties.contains(.write) else {
      vlog("ident-write-fail gen=" + String(id) + " reason=read-only")
      settle(id, .skipped)
      return
    }
    // ARMED BEFORE THE OFFER, so no road out of the handshake can skip it.
    queue.asyncAfter(deadline: .now() + WalkieBleVoice.identSettleCap) { [weak self] in
      guard let self, !self.retired, !self.identSettled else { return }
      vlog("ident-cap gen=" + String(self.id) + " hash=" + hex(self.dialedHash))
      self.settle(self.id, .expired)
    }
    identOutstanding += 1
    // ACKNOWLEDGED, deliberately, and this is the one writer in this file
    // that is: identity is a fact confirmed once, audio is a fact that
    // expires. The voice writer stays .withoutResponse.
    // GUARDED: the IDENT bytes carry displayName with no withResponse length
    // guard, and CoreBluetooth raises NSException synchronously on a
    // too-large value or a characteristic the stack already tore down — a
    // bare raise here skips settle, strands the cap, and takes the process.
    let raised = ObjCTry.run {
      per.writeValue(bytes, for: ch, type: .withResponse)
    }
    if raised != nil {
      identOutstanding = max(0, identOutstanding - 1)
      vlog("ident-write-fail gen=" + String(id) + " reason=synchronous-raised")
      settle(id, .dead)
    }
  }

  /// EVERY TERMINAL PATH COMES THROUGH HERE, ONCE. Queue.
  private func settle(_ token: Int, _ outcome: IdentOutcome) {
    guard token == id, !identSettled else {
      return
    }
    identSettled = true
    identVoiceSafe = outcome.voiceSafe
    vlog(
      "ident-settle gen=" + String(id) + " hash=" + hex(dialedHash) +
        " outcome=" + outcome.rawValue
    )
    guard identVoiceSafe else {
      // A SETTLE THAT IS NOT VOICE-SAFE TEARS DOWN AND NEVER PUBLISHES.
      // Either the cap fired with an op still outstanding — an
      // acknowledged write may still be in flight, and a link whose
      // ordering we have lost is not a link to put a camper's voice on —
      // or the transport was gone before the offer. Both are the same
      // ruling and both leave by this one road; the peer's backoff redials
      // and nothing is lost but seconds.
      owner?.generationFailed(self, outcome == .expired ? "ident-cap" : "ident-transport")
      return
    }
    owner?.publishIfSettled(self)
  }

  /// The tick, rescheduled for as long as this generation lives. It
  /// reschedules UNCONDITIONALLY: a tick that decided nothing must not be
  /// the last tick, or one odd moment silently retires the only thing that
  /// can demote a dead link.
  private func scheduleLiveness() {
    queue.asyncAfter(deadline: .now() + WalkieBleVoice.livenessTick) { [weak self] in
      guard let self, !self.retired else { return }
      self.livenessTick()
      self.scheduleLiveness()
    }
  }

  /// Two jobs, IN THIS ORDER: collect on a proof that was never answered,
  /// then ask a link that has gone quiet past the window to prove itself.
  /// Asking first would give every probe a free extra tick before anyone
  /// checked it.
  private func livenessTick() {
    guard !retired, ready else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if probePending {
      if now - probeAt >= WalkieBleVoice.livenessProbeTimeout {
        vlog(
          "liveness-lost gen=" + String(id) + " hash=" + hex(dialedHash) +
            " silent=" + String(Int(now - lastProof)) + "s"
        )
        owner?.generationFailed(self, "liveness-lost")
      }
      return
    }
    if now - lastProof >= WalkieBleVoice.livenessWindow {
      probeLiveness()
    }
  }

  /// "LOOK AGAIN" reaching a READY link (WalkieBleLink.refresh, mirrored).
  /// The camper taps it precisely when the channel looks wrong, and a row
  /// that still says ready while the channel looks wrong is the one state
  /// where the flag and the world disagree — so this asks, immediately,
  /// and collects on an ask that is already overdue. A healthy link
  /// answers in tens of milliseconds and nobody on it hears a thing.
  func lookAgain() {
    guard !retired, ready else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if probePending {
      if now - probeAt >= WalkieBleVoice.livenessProbeTimeout {
        vlog(
          "liveness-lost gen=" + String(id) + " hash=" + hex(dialedHash) + " via=look-again"
        )
        owner?.generationFailed(self, "liveness-lost")
      }
      return
    }
    probeLiveness()
  }

  /// Ask this link to prove it is still there — the same ident read the
  /// setup used, so the far end needs nothing it does not already serve.
  ///
  /// ARMED ONLY BY A READ THE STACK ACCEPTED. Android learned this the
  /// expensive way: its `readCharacteristic` returns false when the stack
  /// is BUSY, and on this rung the stack is busy exactly when the pair is
  /// TALKING, because voice frames are the traffic. A read that never went
  /// out can never be answered, so arming the deadline on it demoted the
  /// healthiest link in the pod.
  ///
  /// EAS-VERIFY: CoreBluetooth's readValue(for:) returns Void and queues,
  /// so the ONE synchronous definitely-not-started signal this API offers
  /// is a peripheral that is not `.connected`. That is the refusal below;
  /// it is a weaker "busy" than Android's, and correspondingly rarer,
  /// which is why the budget that bounds it is the same four.
  private func probeLiveness() {
    guard !retired, ready else { return }
    guard let per = peripheral, let ident = identChar else {
      // A link whose pipe has gone missing under us is not a link at all.
      vlog(
        "liveness-lost gen=" + String(id) + " hash=" + hex(dialedHash) + " reason=no-pipe"
      )
      owner?.generationFailed(self, "liveness-lost")
      return
    }
    guard per.state == .connected else {
      // NOT ARMED, deliberately: nothing went on the air, so nobody owes
      // this link an answer and its standing is unchanged. Say it out
      // loud — a busy stack and a wedged one read identically from the
      // outside, and this line is what tells them apart in a log.
      probeRefusals += 1
      vlog(
        "liveness-busy gen=" + String(id) + " hash=" + hex(dialedHash) +
          " try=" + String(probeRefusals)
      )
      if probeRefusals >= WalkieBleVoice.livenessProbeTries {
        vlog(
          "liveness-lost gen=" + String(id) + " hash=" + hex(dialedHash) +
            " reason=refused tries=" + String(probeRefusals)
        )
        owner?.generationFailed(self, "liveness-lost")
      }
      return
    }
    per.readValue(for: ident)
    // The read is out. Only NOW does the deadline exist — and the answer
    // cannot beat this line, because the delegate callback is dispatched
    // to this same serial queue and this function has not returned.
    probeRefusals = 0
    probeAt = ProcessInfo.processInfo.systemUptime
    probePending = true
  }

  /// Called from the walkie's audio thread. Hops to the link queue so ONE
  /// queue owns the peripheral.
  ///
  /// IT CAPTURES THE GENERATION, NEVER THE PEER. The peer entry outlives
  /// its links by design; a writer that reached through it would put
  /// generation 1's frames on generation 2's wire, and WalkieModule owns
  /// this closure's lifetime so this file may not depend on it being let
  /// go.
  func write(_ frame: Data) {
    queue.async { [weak self] in
      guard let self, !self.retired, self.ready,
            let per = self.peripheral, let ch = self.voiceChar else {
        return
      }
      // EAS-VERIFY: canSendWriteWithoutResponse is the drop-on-busy gate
      // (CBPeripheral, iOS 11+); if the builder disagrees, write
      // unconditionally — the stack drops instead of us. Drop-on-busy
      // either way: a stack still chewing the last write loses this frame,
      // which is the walkie's own late-audio-is-worse-than-lost-audio law
      // on GATT.
      guard per.canSendWriteWithoutResponse else {
        return // dropped frame — never retransmitted
      }
      // GUARDED for the same synchronous-raise class as the IDENT writer: a
      // torn-down characteristic raises, and a raised frame is a dropped
      // frame — the same fate the busy-stack gate above already hands out.
      _ = ObjCTry.run { per.writeValue(frame, for: ch, type: .withoutResponse) }
    }
  }
}

// ---------------------------------------- the generation's manager seat

extension BleLinkGeneration: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard !retired else {
      // T3, AND NOTHING ELSE A RETIRED GENERATION DOES HERE. An OBSERVED
      // `.poweredOff` on this generation's own manager is the physical
      // death of every link it held, which is a terminal for the lease it
      // still owes a cancel on. `.unknown`, `.resetting` and
      // `.unauthorized` are not: they say nothing about whether the
      // teardown landed.
      if central.state == .poweredOff {
        _ = noteLeasePowerOff(central)
      }
      return
    }
    switch central.state {
    case .poweredOn:
      attach()
    case .poweredOff, .unauthorized, .unsupported, .resetting:
      // This generation's own manager says the radio is not there. The
      // coordinator's scanner owns the rung-wide arc; all this dial can
      // do is end.
      owner?.generationFailed(self, "adapter-" + String(central.state.rawValue))
    default:
      break // .unknown settles on the next state callback
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard !retired else { return }
    peripheral.discoverServices([WalkieBleVoice.serviceUUID])
  }

  func centralManager(
    _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
  ) {
    guard !retired else { return }
    vlog("connect-failed gen=" + String(id) + " hash=" + hex(dialedHash))
    owner?.generationFailed(self, "connect-failed")
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    guard !retired else {
      // T1 — THE LEASE'S PRIMARY COMPLETION, and the only thing routed out
      // of a retiring generation's seat. Exact object, own manager; every
      // other callback on a retired generation stays as inert as it has
      // always been.
      _ = noteLeaseTerminal(peripheral, central: central)
      return
    }
    vlog(
      "disconnected gen=" + String(id) + " hash=" + hex(dialedHash) +
        " ready=" + (ready ? "1" : "0")
    )
    owner?.generationFailed(self, "disconnected")
  }
}

// ------------------------------------- the generation's peripheral seat

extension BleLinkGeneration: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard !retired else { return }
    guard error == nil,
          let svc = peripheral.services?.first(where: { $0.uuid == WalkieBleVoice.serviceUUID })
    else {
      vlog("no-service gen=" + String(id) + " hash=" + hex(dialedHash))
      owner?.generationFailed(self, "no-service")
      return
    }
    service = svc
    peripheral.discoverCharacteristics(
      [WalkieBleVoice.voiceChar, WalkieBleVoice.identChar], for: svc
    )
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    guard !retired else { return }
    // By now the ATT MTU exchange is done, so the budget question has its
    // real answer. A pipe the frame does not fit is not a rung (§5): drop
    // before it was ever listed — Android's onMtuChanged gate in this
    // API's shape. EAS-VERIFY: maximumWriteValueLength(for:
    // .withoutResponse) reflects the negotiated MTU at this point (a
    // 257-byte 60 ms frame must fit).
    let budget = peripheral.maximumWriteValueLength(for: .withoutResponse)
    guard error == nil,
          budget >= WalkieBleVoice.minVoiceWrite,
          let voice = service.characteristics?.first(where: {
            $0.uuid == WalkieBleVoice.voiceChar
          }),
          let ident = service.characteristics?.first(where: {
            $0.uuid == WalkieBleVoice.identChar
          }) else {
      // The ONE number the 2026-08-26 bench could not read: an iPhone that
      // grants less than a frame silently contributes no peer and no error.
      vlog(
        "write-budget hash=" + hex(dialedHash) + " gen=" + String(id) +
          " granted=" + String(budget) +
          " need=" + String(WalkieBleVoice.minVoiceWrite) + " err=" + (error == nil ? "0" : "1")
      )
      owner?.generationFailed(self, "write-budget")
      return
    }
    voiceChar = voice
    identChar = ident
    peripheral.readValue(for: ident)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard !retired, characteristic.uuid == WalkieBleVoice.identChar else { return }
    guard error == nil else {
      vlog("ident-read-failed gen=" + String(id) + " hash=" + hex(dialedHash))
      owner?.generationFailed(self, "ident-read-failed")
      return
    }
    owner?.handleIdent(self, characteristic.value)
  }

  /// OUR IDENT WRITE CAME BACK. Both answers are terminal and both are
  /// voice-safe — there is no retry after a write that was accepted,
  /// because it went on the air and a second one could only collide with
  /// whatever it provoked.
  func peripheral(
    _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard !retired, characteristic.uuid == WalkieBleVoice.identChar else { return }
    identOutstanding = max(0, identOutstanding - 1)
    guard error == nil else {
      // A field peer that answers "writing is not permitted" has a
      // perfectly good link: it carries our voice, our own read proved it,
      // and it proves US the way it always has. This must never reach
      // generationFailed, or an upgrade becomes an outage for every phone
      // already in the field.
      vlog("ident-write-fail gen=" + String(id) + " reason=answered")
      settle(id, .failed)
      return
    }
    vlog("ident-write-out gen=" + String(id) + " hash=" + hex(dialedHash))
    settle(id, .acknowledged)
  }

  /// THE FAR END REBUILT ITS GATT TABLE UNDER US. Every characteristic
  /// this generation holds is now a stale handle, and a stale handle is
  /// not a link: the WHOLE generation retires. Re-discovering into the
  /// live object would be the mutable-slot shape again, one API further
  /// down.
  func peripheral(
    _ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]
  ) {
    guard !retired else { return }
    vlog(
      "services-modified gen=" + String(id) + " hash=" + hex(dialedHash) +
        " count=" + String(invalidatedServices.count)
    )
    owner?.generationFailed(self, "services-modified")
  }
}

// --------------------------------------------------------- the durable peer

/**
 ONE ENTRY PER POD PEER BY HASH, kept across disconnects.

 It owns a BACKOFF and the identity of its CURRENT LINK, and that is the
 whole list. No peripheral, no characteristic, no attempt epoch, no
 pending-operation flag — every one of those was tried on this class and
 each was a way for a dead link to answer for a live one. `ready` and
 `connecting` are READ THROUGH the link rather than stored, so the state
 that four rounds could silently falsify cannot exist: a link that has
 been retired reports what it is.
 */
final class VoicePeer {
  /// var, not let: a dial from a TRUNCATED advertisement starts life as
  /// unknownSender and is re-keyed to its proven identity by handleIdent.
  var hash: UInt32
  var name = "someone"
  var key = ""
  var lastAttempt: TimeInterval = 0
  var backoff: TimeInterval = WalkieBleVoice.connectBackoffBase
  /// Dials made against this peer, for the log line. No guard reads it.
  var dials = 0
  /// THE CURRENT LINK ID — the one handle the durable peer keeps, and the
  /// only thing that makes a callback's owner "current".
  var link: BleLinkGeneration?

  var ready: Bool { link?.ready ?? false }
  var connecting: Bool {
    guard let l = link else { return false }
    return !l.ready && !l.retired
  }

  init(hash: UInt32) { self.hash = hash }
}

// ------------------------------------------------------- the coordinator

final class WalkieBleVoice: NSObject {
  /// Must equal WalkieBleLink.kt's SERVICE/VOICE/IDENT UUIDs byte for
  /// byte — a test reads both files.
  static let serviceUUID = CBUUID(string: "6b75a1fa-8e2a-4b0b-9f21-706c61796170")
  static let voiceChar = CBUUID(string: "6b75a1fb-8e2a-4b0b-9f21-706c61796170")
  static let identChar = CBUUID(string: "6b75a1fc-8e2a-4b0b-9f21-706c61796170")
  /// Same test company id the crew beacon uses — READ from Android
  /// advertisements only; this side cannot advertise it (see header).
  static let manufacturerId: UInt16 = 0xFFFF
  /// 'P''V' + podHash(4 BE) + senderHash(4 BE).
  static let pvHeader = 10
  /// A 60 ms rung-3 frame is 13 + 4 + 240 = 257 bytes.
  /// maximumWriteValueLength already excludes the 3-byte ATT header, so
  /// this is Android's MIN_VOICE_MTU (260) in this API's units. §5: a
  /// rung that cannot carry is never offered.
  static let minVoiceWrite = 257
  /// Inbound writes above this are a stranger or a bug, not a frame.
  static let maxVoiceFrame = 600
  /// Redial pacing per peer: base doubles per failed setup to the cap,
  /// resets on a proven link. Scan sightings are the retry trigger, so a
  /// peer who reappears is redialled within one backoff window.
  static let connectBackoffBase: TimeInterval = 3
  static let connectBackoffCap: TimeInterval = 30
  /// A refusal before CoreBluetooth accepted a connection attempt says the
  /// object lane is occupied, not that this peer failed on the air. Keep the
  /// three-second floor, but do not make quarantine contention exponentiate.
  static let preConnectRefusals: Set<String> = [
    "no-object",
    "object-claimed",
    "object-retiring",
    "object-alias",
  ]
  /// A setup (manager up -> connect -> discover -> budget -> ident) that
  /// stalls past this is torn down; BLE stacks wedge silently and the
  /// walkie must not hold a half-open pipe it will never probe again.
  /// It covers the manager's own power-on now, which a per-dial manager
  /// pays and the old shared one did not.
  static let setupTimeout: TimeInterval = 12
  /// THE NO-WEDGE BUDGET ON A RETIREMENT'S LEASE (T4). A cancel whose
  /// disconnect never arrives would otherwise hold its object reserved for
  /// the life of the process, so the lease rechecks the object's state on
  /// this tick and re-issues the cancel while it is still connected. Four
  /// looks over two seconds: long enough that a stack merely busy delivers
  /// its terminal inside the budget, short enough that a stack that has
  /// wedged is declared so while the camper is still standing there.
  static let leaseRecheckTick: TimeInterval = 0.5
  static let leaseRecheckBudget = 4
  /// THE ADVERTISER'S OWN NO-WEDGE BUDGET, on the close path — the lease's
  /// T4 pointed at the other radio role (advertiser-side no-go,
  /// 2026-08-27, cross-family read of 6a5274e).
  ///
  /// `stopAdvertising()` is an ISSUE, exactly as `cancelPeripheralConnection`
  /// is: it returns having told CoreBluetooth what we want and having
  /// proved nothing about what is still on the air. The walkie's stop
  /// promise is what the crew beacon's release is sequenced behind, so a
  /// promise that resolves at the issue lets CrewBeacon put a SECOND
  /// advertiser up while rung 3's is still radiating — which is the
  /// overflow-area defect share.ts exists against, re-created by the
  /// teardown that was supposed to prevent it.
  ///
  /// So the close proves the effect: a fresh `isAdvertising` read on a
  /// LATER turn of the owning queue, re-issuing the stop between looks,
  /// four looks over one second. Long enough that a stack merely busy has
  /// gone quiet inside the budget, short enough that the camper who tapped
  /// off is still standing there — and when the budget is out the promise
  /// REJECTS rather than resolving, because an unproven advertiser is
  /// exactly the state the release must not be let into.
  static let advertiserProofTick: TimeInterval = 0.25
  static let advertiserProofBudget = 4
  /// One raw sighting per peripheral per ten seconds. Duplicate scan results
  /// are the retry engine, so this is field evidence without a log flood.
  static let sightLogWindow: TimeInterval = 10
  /// One scan-drop line per (peripheral, reason) per five minutes —
  /// WalkieBleLink.DROP_LOG_WINDOW_MS, mirrored.
  static let dropLogWindow: TimeInterval = 5 * 60
  /// THE READY-LINK WATCHDOG (WalkieBleLink.LIVENESS_WINDOW_MS and its
  /// three companions, mirrored number for number — a test reads both
  /// files, because the two halves of one rung disagreeing about how long
  /// a silence means death is exactly the drift nobody can debug in the
  /// dust).
  ///
  /// THE CLASS IT EXISTS FOR: voice rides write-no-response, so nothing on
  /// the audio path ever reports a failure and nothing ever comes back. A
  /// podmate who walked out of range, or a stack that wedged without
  /// delivering its disconnect, looks EXACTLY like a podmate who is not
  /// talking — and every healing path this rung owns is gated behind
  /// `ready`. The scan damper spends every later sighting on the memo
  /// saying that phone is already reached, maybeConnect refuses to redial
  /// a ready peer, and "Look again" used to step over ready links on
  /// purpose. So the one state where the flag and the world disagree was
  /// also the one state nothing could leave.
  ///
  /// THE CURE: a ready link re-proves itself on this window with the IDENT
  /// read — the one operation on this link that ANSWERS, and the same read
  /// the setup already does, so nothing new goes on the air and a
  /// 0.8.6-era peer serves it unchanged. Inbound frames are NOT the proof:
  /// voice is asymmetric here, their frames ride THEIR link to our server,
  /// and an asymmetric wedge is the case worth catching. The proof travels
  /// on the link it vouches for.
  ///
  /// AND IT LIVES ON THE GENERATION, which is why it can exist on this
  /// phone at all. Four rounds of it lived on the peer entry and each was
  /// reverted: a watchdog whose deadline outlives its link is a way for a
  /// dead generation to demote a live one. Here the timer, the deadline
  /// and the refusal budget are the link's own, and they die with it.
  static let livenessWindow: TimeInterval = 20
  /// How long a proof may go unanswered before the link is demoted. A GATT
  /// read on a healthy link answers in tens of milliseconds; six seconds
  /// is a stack in trouble, not a stack that is busy.
  static let livenessProbeTimeout: TimeInterval = 6
  /// How often the watchdog looks. Short enough that "Look again" answers
  /// a camper within one breath.
  static let livenessTick: TimeInterval = 3
  /// HOW MANY REFUSED PROBES IN A ROW BECOME THE MISS. A refusal is
  /// neither a proof nor a failure: it is a turn skipped, because nothing
  /// went on the air and nobody owes this link an answer. But a stack that
  /// will not accept a read for a dozen seconds is wedged rather than
  /// busy, and then the refusals themselves are the honest answer.
  static let livenessProbeTries = 4
  /// THE DIALER NAMES ITSELF, and this is the third attempt at it — read
  /// the settle machine in BleLinkGeneration before touching any of it.
  ///
  /// Identity on this wire is proved ONE DIRECTION PER LINK: the central
  /// reads the peripheral's IDENT, so a dial proves the phone that was
  /// DIALLED. Measured 2026-08-27 02:22: a Pixel dialled the iPhone and
  /// had her named in nine seconds, while the iPhone — holding no link of
  /// its own to the Pixel yet — had nothing to read and spent one to four
  /// MINUTES playing that Pixel's frames as an unnamed "someone is
  /// talking", waiting on its own sighting, its own backoff and its own
  /// dial. The far end's identity was in the room the whole time.
  ///
  /// IT IS A HINT, NEVER THE PROOF. §5 does not move: a peer is listed
  /// only after OUR OWN read came back with the right pod on a link whose
  /// budget fits a frame, because that is the link our voice leaves on.
  /// What the write buys the far end is WHO and WHERE, so its dial is
  /// immediate instead of scan-paced, and never a row.
  ///
  /// THERE IS NO OFFER COUNT HERE ANY MORE, and its absence is the ruling.
  /// af06a4e retried for a stack it thought was merely busy; e4b0923 cut
  /// that to one retry behind the single refusal it called certain — a
  /// peripheral that is not connected — and that refusal was never a
  /// refusal at all but a transport that had ended. beginIdent retires on
  /// it and offers exactly ONCE, so the bound that used to be a number a
  /// mutation could raise is now a property of the code's shape. Once a
  /// write is on the air there is no retry either: success and an explicit
  /// error are both terminal and both voice-safe, because a peer that
  /// declined an optional courtesy still carries our voice, and turning an
  /// upgrade into an outage is the one outcome worse than staying unnamed.
  ///
  /// AND THE GATE HAS A FLOOR. The writer is published at the SETTLE, so a
  /// stack that takes the write and never calls back would strand a proven
  /// link with no writer and no row — on the channel and unable to be
  /// heard, which is worse than the collision the settle exists to
  /// prevent. This cap is armed BEFORE the first offer so no road out of
  /// the handshake can skip it, and unlike its reverted ancestor it does
  /// NOT publish anyway: an unsettled op means an acknowledged write may
  /// still be in flight, and a link whose ordering we have lost is torn
  /// down rather than trusted with audio.
  static let identSettleCap: TimeInterval = 2
  /// Mirror of WalkieBleLink.MAX_VOICE_LINKS: four live voice links is a
  /// six-phone huddle with no Wi-Fi anywhere, already past what this
  /// rung's bandwidth story promises. It now also bounds how many
  /// CBCentralManagers this rung holds at once.
  static let maxVoiceLinks = 4

  private let podHash: UInt32
  private let senderHash: UInt32
  private let myName: String
  /// A peer's voice pipe became WRITABLE. Key follows the
  /// "ble|<senderHash hex>|<name>" shape the roster dedupe reads; `send`
  /// writes one PW frame (drop-on-busy — the walkie never retransmits).
  private let onPeer: (String, String, UInt32, @escaping (Data) -> Void) -> Void
  private let onPeerLost: (String) -> Void
  /// An inbound PW frame from a peer's write; the module's one receive
  /// path gates and plays it.
  private let onFrame: (Data) -> Void

  /// Everything below is owned by this queue — the scanner, the server and
  /// every generation are constructed on it, so every delegate callback
  /// already arrives here.
  private let queue = DispatchQueue(label: "walkie-ble")
  private var stopped = false
  /// THE SHARED MANAGER SCANS, AND SCANS ONLY. It never connects, it never
  /// takes a peripheral's delegate seat, and it never hands its
  /// CBPeripheral object to anything: what leaves the scan callback is an
  /// address and the advertisement's facts. That is why this class
  /// implements no connection callbacks at all — there is no link for one
  /// to be about.
  private var scanner: CBCentralManager?
  private var peripheralMgr: CBPeripheralManager?
  private var serviceAdded = false
  /// Monotonic dial counter, for the log line.
  private var dialSeq = 0

  /// The advertisement named a sender we have not proven yet (a truncated
  /// or pod-only name); only the ident read assigns the real hash.
  static let unknownSender: UInt32 = 0

  /// Which peripheral identifier the ident proof revealed to be whom —
  /// the scan's churn damper (queue-confined, like every peer structure).
  private var provenIdentity: [UUID: UInt32] = [:]

  /// Independent expiry maps keep a crowd of long-lived filtered packets
  /// from evicting the ten-second raw-sighting throttle, or vice versa.
  private var sightLog: [String: TimeInterval] = [:]
  private var dropLog: [String: TimeInterval] = [:]
  private var dialLog: [String: TimeInterval] = [:]

  private func noteSighting(
    _ id: UUID,
    _ advertisementData: [String: Any],
    _ name: String?,
    _ RSSI: NSNumber
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    guard logAllowed(&sightLog, key: id.uuidString, now: now, every: Self.sightLogWindow) else {
      return
    }
    let mfgLen =
      (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data)?.count ?? 0
    // UUID is a device record; hashValue is process-randomized, preserving
    // same-run correlation without writing that durable identifier to logs.
    let tag = String(UInt(bitPattern: id.hashValue), radix: 16)
    wlog.notice(
      "voice//sight id=\(tag, privacy: .public) mfg=\(mfgLen, privacy: .public) name=\(name ?? "-", privacy: .public) rssi=\(RSSI.intValue, privacy: .public)"
    )
  }

  private func noteScanDrop(_ reason: String, _ id: UUID, _ name: String?) {
    let now = ProcessInfo.processInfo.systemUptime
    guard logAllowed(
      &dropLog,
      key: id.uuidString + "|" + reason,
      now: now,
      every: Self.dropLogWindow
    ) else {
      return
    }
    vlog(
      "scan-drop reason=" + reason + " id=" + id.uuidString +
        " name=" + (name.map { $0.isEmpty ? "-" : $0 } ?? "-")
    )
  }

  private var voicePeers: [UInt32: VoicePeer] = [:]

  init(
    podHash: UInt32,
    senderHash: UInt32,
    displayName: String,
    onPeer: @escaping (String, String, UInt32, @escaping (Data) -> Void) -> Void,
    onPeerLost: @escaping (String) -> Void,
    onFrame: @escaping (Data) -> Void
  ) {
    self.podHash = podHash
    self.senderHash = senderHash
    let clean = displayName.replacingOccurrences(of: "|", with: "/").prefix(24)
    myName = clean.isEmpty ? "someone" : String(clean)
    self.onPeer = onPeer
    self.onPeerLost = onPeerLost
    self.onFrame = onFrame
    super.init()
  }

  // ------------------------------------------------------------ lifecycle

  /// WHICH LEASE THIS ADVERTISER BELONGS TO. Set by Walkie.swift before
  /// `start`, from the reservation the arbiter granted — so every effect
  /// this rung reports is attributed to the exact hold that authorised it,
  /// and an effect arriving for a lease that has since ended is dropped by
  /// the arbiter rather than believed.
  var airtimeLease: String?

  func start() {
    queue.async { [self] in
      guard !stopped, scanner == nil else { return }
      // Creating the managers IS the one-time OS Bluetooth ask
      // (NSBluetoothAlwaysUsageDescription, already in the plist for the
      // crew beacon); opening the walkie is the in-context moment. A
      // denial surfaces as .unauthorized in the state callbacks below —
      // this rung contributes no peers, no dialog storm, the module's
      // fencing law.
      scanner = CBCentralManager(delegate: self, queue: queue)
      // THE ADMISSION IS THE ARBITER'S, AND IT ALREADY HAPPENED
      // (ARCHITECTURE ruling, 2026-08-27). This used to ask the debt book
      // itself — a QUERY, and a query is a question about the past: two
      // debt-free starts both asked it in the same turn, both got the same
      // true answer, and the phone ended up with two advertisers because
      // nothing in between wrote anything down. The arbiter RESERVES a
      // lease under its own lock before it answers anybody, and this
      // manager is minted only on the `starting` phase of that lease — so
      // by the time this line runs the admission is a fact already written
      // rather than a question being asked again.
      //
      // THE CENTRAL IS STILL UNGATED, and deliberately so: dialling
      // radiates nothing, and the ladder's dial half must never be held
      // hostage to the advertise half.
      guard !stopped, peripheralMgr == nil else { return }
      peripheralMgr = CBPeripheralManager(delegate: self, queue: queue)
    }
  }

  /// Serialized ON the link queue — the WalkieBleLink.stop() rule: a dial
  /// already enqueued completes before this block and its generation is in
  /// voicePeers by the time the teardown retires them all; anything
  /// enqueued after sees `stopped`. Closing the walkie stops the
  /// advertisement and the server, which drops every inbound connection —
  /// the peer LEAVES the other phones' lists on the disconnect
  /// (MEMBERSHIP IS THE CONNECTION, both halves).
  ///
  /// THE QUARANTINE IS NOT CLEARED HERE, deliberately, and this method is
  /// the reason it owns CLAIMS and not only tombstones. The teardown below
  /// is ENQUEUED: this call returns immediately, and a camper who closes
  /// the walkie and reopens it — exactly the gesture they make when the
  /// channel looks wrong — dials on a second instance, on a second queue,
  /// while these generations are still ACTIVE and have no tombstones yet.
  /// The old link's claim is what refuses that dial; the tombstone arrives
  /// later and continues the refusal, and the retirement below can only
  /// ever transition its own claim.
  /// THE COMPLETION IS THE ADVERTISER'S PROOF, not a courtesy callback:
  /// it fires on this queue with `true` only once THIS RUNG'S advertiser
  /// is PROVEN off the air (see proveAdvertiserDown), and with `false`
  /// when that proof could not arrive inside the budget.
  ///
  /// IT IS THE ARBITER THAT CALLS IT NOW, through the stop handle this
  /// module hands over at `armStart` — retained on the LEASE rather than
  /// on this instance, so a duplicate stop cannot find a nilled field and
  /// answer "absent" over a radio that is still up. What this completion
  /// means is unchanged and deliberately narrow: MY advertiser, nothing
  /// about the process. The arbiter asks the book.
  func stop(_ proven: ((Bool, String) -> Void)? = nil) {
    queue.async { [self] in
      stopped = true
      scanner?.stopScan()
      // THE MANAGER OUTLIVES ITS SLOT ON PURPOSE. The proof below is a
      // READ of this exact object, so the module's reference goes here and
      // a strong local carries the object through the recheck: a manager
      // that is gone proves absence, and one that is still here can be
      // asked. Dropping it before the read would leave the close with
      // nothing to interrogate and no honest way to answer.
      let pm = peripheralMgr
      pm?.stopAdvertising()
      pm?.removeAllServices()
      retireAll("stop")
      voicePeers.removeAll()
      scanner = nil
      peripheralMgr = nil
      // ONE QUESTION HERE, AND THE SECOND ONE HAS AN OWNER ELSEWHERE.
      // This asks only what this rung can answer: is MY advertiser off the
      // air (P1/P2/P3, bounded by advertiserProofBudget)? Whether the
      // PROCESS still owes anything is a different question about a
      // different scope, and it is the arbiter's — it asks the book in
      // `settleStop`, once, for every road out of a hold. Asking it in
      // both places is two levels that must be kept in agreement, which is
      // the defect class this whole architecture round is about.
      proveAdvertiserDown(pm, tries: 0) { down, why in
        proven?(down, why)
      }
    }
  }

  /**
   THE ADVERTISER'S EFFECT, on the owning queue — the close-path mirror of
   the lease's T4, and the whole of the advertiser-side no-go:

     "Native stop promise resolves before WalkieBleVoice queued advertiser
     stop effect, so JS release can restart crew advertising while walkie
     advert still active."

   ENQUEUEING IS NOT EFFECT, AND NEITHER IS CALLING. `stopAdvertising()` is
   a nonblocking request; the only facts that say this rung is off the air
   are read AFTER it, and there are exactly three, in this order:

     P1  the manager is ABSENT — never built (no rung 3 on this session),
         or already dropped by an earlier close. Nothing this object could
         advertise exists, so there is nothing to wait for.
     P2  an observed `.poweredOff` on that manager: the radio is
         physically down, so no advertisement of ours can be on the air.
         `.unauthorized`, `.unsupported` and `.resetting` say nothing about
         what is radiating and complete nothing on their own — they land on
         P3 instead, where a manager that never advertised reads false and
         proves itself in one look.
     P3  `isAdvertising == false`, READ FRESH on a LATER turn of this
         queue. Never in the same block as the stop that preceded it:
         CoreBluetooth's flag is updated asynchronously and can lag its own
         `stopAdvertising`, so a same-block read is the cached answer to
         the question we just asked, which is the issue wearing the
         effect's clothes. `tries > 0` is that rule, spelled.

   AND WHEN NONE OF THEM ARRIVES, FAIL CLOSED. The budget runs out and the
   completion says `false`, which rejects the JS promise and holds the crew
   beacon off the air — a degraded close, and strictly better than the
   overlap: two 128-bit UUIDs do not fit one advertising packet, and
   CoreBluetooth does not revisit the overflow decision when one of them
   later stops (share.ts holds the whole reasoning).

   SELF IS CAPTURED STRONGLY, deliberately, and the budget is what makes
   that safe: a `[weak self]` chain that emptied would drop the completion
   on the floor and leave the JS promise pending forever — a stop that
   never settles is worse than a stop that fails, because nothing above can
   even fail closed on it.
   */
  private func proveAdvertiserDown(
    _ mgr: CBPeripheralManager?,
    tries: Int,
    _ proven: ((Bool, String) -> Void)?
  ) {
    guard let mgr else {
      vlog("advertiser-down why=absent")
      proven?(true, "absent")
      return
    }
    if mgr.state == .poweredOff {
      vlog("advertiser-down why=power-off")
      proven?(true, "power-off")
      return
    }
    if tries > 0, !mgr.isAdvertising {
      vlog("advertiser-down why=not-advertising looks=" + String(tries))
      proven?(true, "not-advertising")
      return
    }
    if tries >= WalkieBleVoice.advertiserProofBudget {
      vlog(
        "advertiser-unproven looks=" + String(tries) +
          " state=" + String(mgr.state.rawValue)
      )
      // THE BUDGET DEMOTES THE CADENCE; IT DOES NOT END THE OBLIGATION.
      // The manager moves into the process-lifetime debt book — which
      // holds it strongly and keeps proving it on the slow tick — BEFORE
      // the promise fails closed, so there is no window in which JS has
      // been told "unproven" and nothing here is still watching. `false`
      // is this promise's answer, never this advertiser's terminal.
      AdvertiserDebtBook.shared.owe(mgr, on: queue)
      proven?(false, "advertiser-still-up")
      return
    }
    if tries > 0 {
      // Still on the air after a look: re-issue, exactly as T4 re-issues
      // its cancel. A stack that swallowed the first request is the case
      // this exists for.
      mgr.stopAdvertising()
    }
    queue.asyncAfter(deadline: .now() + WalkieBleVoice.advertiserProofTick) { [self] in
      proveAdvertiserDown(mgr, tries: tries + 1, proven)
    }
  }

  /// Queue. Retires every live generation and forgets every link, without
  /// touching the durable identities or the quarantine.
  private func retireAll(_ why: String) {
    for p in voicePeers.values {
      guard let link = p.link else { continue }
      let wasReady = link.ready
      p.link = nil
      link.retire(why)
      if wasReady, !p.key.isEmpty {
        vlog("peer-lost hash=" + hex(p.hash) + " why=" + why)
        onPeerLost(p.key)
      }
    }
  }

  /// The advertisement, in ONE place because two callers put it on the
  /// air: the poweredOn state callback and refresh() below. One fact, one
  /// statement — an identity carrier spelled twice is an identity carrier
  /// that will eventually be spelled two ways.
  private func beginAdvertising(_ peripheral: CBPeripheralManager) {
    vlog("advertise-start name=" + pvName())
    peripheral.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
      // The identity carrier (header): the one advertisement field an
      // app can fill. It rides the scan response beside the 128-bit
      // UUID — the same budget split Android's manufacturer data uses.
      CBAdvertisementDataLocalNameKey: pvName(),
    ])
  }

  /// "LOOK AGAIN" (Walkie.refreshDiscovery, the panel's control) — this
  /// rung's half.
  ///
  /// Restarts the LOOKING and re-asserts the being-found, and touches
  /// nothing that is WORKING. What it changes is the scan (a CoreBluetooth
  /// scan can be quietly wound down without telling its delegate), the
  /// advertisement, and the per-peer BACKOFF for peers that are NOT
  /// connected — after a few failed setups their next dial is up to 30 s
  /// out, and a control that says "right now" must not then wait half a
  /// minute. Sightings are the redial trigger and duplicates are on, so
  /// the next one dials.
  ///
  /// A READY LINK IS ASKED, NOT SPARED (WalkieBleLink.refresh, mirrored).
  /// "Working" and "ready" are different claims: ready says a link worked
  /// once, and the camper taps this control precisely when the channel
  /// looks wrong, which is the one moment those two claims are most likely
  /// to disagree. So every ready link re-proves itself HERE, immediately,
  /// and one that cannot answer inside livenessProbeTimeout is demoted by
  /// the watchdog moments later — which is the only thing that makes its
  /// peer re-scannable and its sighting re-dialable. A healthy link
  /// answers in tens of milliseconds and nobody on it hears a thing; no
  /// connected peripheral is cancelled and no published service is
  /// removed.
  func refresh() {
    queue.async { [self] in
      guard !stopped else { return }
      if let c = scanner, c.state == .poweredOn {
        c.stopScan()
        c.scanForPeripherals(
          withServices: [Self.serviceUUID],
          options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
      }
      for p in voicePeers.values {
        if p.ready {
          // ...AND IT NOW LOOKS AT THE LINKS IT USED TO SPARE. "Every
          // proven voice link is left exactly alone" was the right
          // instinct pointed at the wrong noun: what must be spared is a
          // link that is WORKING, and `ready` is not that claim — it is
          // the claim that a link worked once.
          p.link?.lookAgain()
        } else if !p.connecting {
          p.backoff = Self.connectBackoffBase
          p.lastAttempt = 0
        }
      }
      if let pm = peripheralMgr, pm.state == .poweredOn {
        pm.stopAdvertising()
        beginAdvertising(pm)
      }
      vlog("look-again peers=" + String(voicePeers.count))
    }
  }

  // ------------------------------------------------------------ identity

  /// The advertised-name carrier: "PV" + podHash, lowercase hex, fixed
  /// width — the 10 manufacturer-data bytes spelled for the one
  /// advertisement field a CoreBluetooth peripheral can fill. Must stay
  /// parseable by WalkieBleLink.kt's pvFromName.
  /// The POD half only, on purpose (2026-08-26): the first live cross-OS
  /// bench showed iOS truncating the 18-char two-hash name to eight
  /// characters ("PVb6ef1b") in the packet Android actually received, so
  /// the strict parser over there rejected every real iPhone. Ten chars
  /// survive packing far more often, the sender identity was never
  /// load-bearing in the advertisement (the GATT ident read is the proof
  /// and carries both hashes), and Android's acceptor now takes any
  /// "PV"+hex prefix of the pod hash.
  private func pvName() -> String {
    String(format: "PV%08x", podHash)
  }

  private func identBytes() -> Data {
    var d = Data(capacity: Self.pvHeader + myName.utf8.count)
    d.append(contentsOf: [0x50, 0x56]) // 'PV'
    d.append(contentsOf: be32(podHash))
    d.append(contentsOf: be32(senderHash))
    d.append(contentsOf: Array(myName.utf8))
    return d
  }

  /// (podHash, senderHash) from either advertisement carrier, or nil for
  /// a stranger's advertisement under our UUID.
  private func decodePv(_ advertisementData: [String: Any]) -> (UInt32, UInt32)? {
    if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
       mfg.count >= 2 + Self.pvHeader {
      // Android's carrier: a 2-byte little-endian company id, then the
      // PV bytes (CrewBeacon reads its sightings the same way).
      let company = UInt16(mfg[mfg.startIndex]) | (UInt16(mfg[mfg.startIndex + 1]) << 8)
      let b = [UInt8](mfg.dropFirst(2))
      if company == Self.manufacturerId, b[0] == 0x50, b[1] == 0x56 {
        return (be32(b, 2), be32(b, 6))
      }
    }
    if let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
       name.hasPrefix("PV"), name.count >= 2 + 6 {
      // Another iPhone's carrier — see the header. TRUNCATION IS THE
      // FIELD REALITY (2026-08-26): iOS itself cut the old 18-char form
      // to eight characters in delivered packets, and the 10-char
      // pod-only form is what pvName() advertises now — the old
      // exact-18 check here made new iPhones invisible to OTHER iPHONES
      // the same way the old Android parser made them invisible to
      // Androids. Mirror WalkieBleLink.kt's acceptor: any hex prefix of
      // the pod hash (>=6 chars, a 1-in-16M stranger costing one refused
      // ident read) earns a dial, and a sender the name does not carry
      // stays unknownSender until the ident proof supplies it.
      let hex = String(name.dropFirst(2)).lowercased()
      guard hex.allSatisfy({ $0.isHexDigit }) else { return nil }
      if hex.count >= 16,
         let pod = UInt32(hex.prefix(8), radix: 16),
         let sender = UInt32(hex.dropFirst(8).prefix(8), radix: 16) {
        return (pod, sender)
      }
      let podHex = String(format: "%08x", podHash)
      let n = min(hex.count, 8)
      if podHex.hasPrefix(String(hex.prefix(n))) {
        return (podHash, Self.unknownSender)
      }
      return nil
    }
    return nil
  }

  // ------------------------------------------------------------ client side

  /// Queue. The scan stream is the retry engine: every sighting of a
  /// not-connected pod peer lands here, and the backoff decides whether
  /// this one dials.
  ///
  /// IT TAKES AN ADDRESS, NOT AN OBJECT. The scanner's CBPeripheral is the
  /// scanner's; a dial that built on it would hand every generation the
  /// same object and the same delegate seat, which is the whole class this
  /// file is shaped against.
  private func maybeConnect(_ hash: UInt32, _ id: UUID) {
    guard !stopped else { return }
    let peer: VoicePeer
    if let existing = voicePeers[hash] {
      peer = existing
    } else {
      peer = VoicePeer(hash: hash)
      voicePeers[hash] = peer
    }
    if peer.ready || peer.connecting {
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    if now - peer.lastAttempt < peer.backoff {
      let wait = max(0, peer.backoff - (now - peer.lastAttempt))
      if logAllowed(
        &dialLog,
        key: String(hash) + "|" + String(peer.lastAttempt),
        now: now,
        every: peer.backoff
      ) {
        wlog.notice(
          "voice//dial-skip hash=\(String(hash, radix: 16), privacy: .public) reason=backoff wait=\(wait, privacy: .public)"
        )
      }
      return
    }
    if voicePeers.values.filter({ $0.ready || $0.connecting }).count >= Self.maxVoiceLinks {
      return
    }
    peer.lastAttempt = now
    peer.dials += 1
    dialSeq += 1
    // A FRESH OBJECT, ALWAYS. A redial never reuses the generation the
    // peer was holding — reuse is the shared-slot shape wearing a new
    // name, and it would hand the new dial the old dial's manager,
    // delegate seat and outstanding operations.
    let link = BleLinkGeneration(
      id: dialSeq,
      dialedHash: hash,
      peripheralId: id,
      owner: self,
      peer: peer,
      queue: queue
    )
    peer.link = link
    link.open()
  }

  /// Queue only. THE ONE ROAD OUT OF A LINK, whoever noticed. The entry
  /// SURVIVES the drop — its backoff paces the redial the next scan
  /// sighting triggers, which is the re-enter half of the membership arc
  /// (WalkieBleLink.dropClient, mirrored).
  private func dropClient(_ peer: VoicePeer, _ why: String) {
    let wasReady = peer.ready
    if let link = peer.link {
      // The peer stops pointing at it BEFORE it is retired, so nothing the
      // retirement provokes can find its way back to a current link.
      peer.link = nil
      link.retire(why)
    }
    if wasReady {
      // A proven link that died gets a fresh dialling record; a setup
      // that failed gets a longer wait before the next one.
      peer.backoff = Self.connectBackoffBase
      if !peer.key.isEmpty {
        vlog("peer-lost hash=" + hex(peer.hash) + " why=" + why)
        onPeerLost(peer.key)
      }
      return
    }
    if Self.preConnectRefusals.contains(why) {
      peer.backoff = Self.connectBackoffBase
      return
    }
    peer.backoff = min(peer.backoff * 2, Self.connectBackoffCap)
  }

  /// A GENERATION ENDED, and this is the only way one is allowed to say
  /// so. Queue.
  ///
  /// The current-link test is the whole gate, and it is an OBJECT
  /// IDENTITY test on a handle the generation owns — not an epoch, not an
  /// address, not a live-state guess. A retired generation's late
  /// callbacks all arrive here, and here they cost one log line.
  fileprivate func generationFailed(_ gen: BleLinkGeneration, _ why: String) {
    guard !stopped else { return }
    guard let peer = gen.peer, peer.link === gen else {
      vlog("gen-stale gen=" + String(gen.id) + " why=" + why)
      gen.retire(why)
      return
    }
    dropClient(peer, why)
  }

  /// The PROOF gate (§5): the peer is listed only after this read said
  /// "same pod, same phone the advertisement named". A mismatch is a
  /// stranger, a stale advertisement, or another pod — never a peer.
  fileprivate func handleIdent(_ gen: BleLinkGeneration, _ value: Data?) {
    guard !stopped, !gen.retired else { return }
    guard let peer = gen.peer, peer.link === gen else {
      vlog("gen-stale gen=" + String(gen.id) + " why=ident")
      gen.retire("stale-ident")
      return
    }
    let b = [UInt8](value ?? Data())
    guard b.count >= Self.pvHeader, b[0] == 0x50, b[1] == 0x56,
          be32(b, 2) == podHash else {
      // A refused proof is exactly the state that reads as "no audio and
      // no errors" from the far side. Say it.
      vlog(
        "ident-reject gen=" + String(gen.id) + " dialed=" + hex(peer.hash) +
          " reason=shape bytes=" + String(b.count)
      )
      dropClient(peer, "ident-shape")
      return
    }
    let sender = be32(b, 6)
    // A dial from a FULL advertisement must prove the phone it named; one
    // from a TRUNCATED advertisement (unknownSender) accepts whoever
    // answered — except our own reflection off a second radio path
    // (mirrors WalkieBleLink.kt's handleIdent).
    if (peer.hash == Self.unknownSender ? sender == senderHash : sender != peer.hash) {
      vlog(
        "ident-reject gen=" + String(gen.id) + " dialed=" + hex(peer.hash) +
          " answered=" + hex(sender)
      )
      dropClient(peer, "ident-identity")
      return
    }
    if peer.ready {
      // A LIVENESS RE-READ ANSWERED (the watchdog's, or "Look again"'s).
      // The peer is already listed and nothing about it changes — the
      // whole content of this callback is the fact that it ARRIVED, on the
      // link our voice leaves on. Stamped HERE rather than at the top of
      // this function on purpose: only a read that passed the pod and
      // identity gates above counts as proof, so a wrong phone answering
      // on a rotated address cannot renew a link.
      gen.noteProof()
      return
    }
    let id = gen.peripheralId
    if peer.hash == Self.unknownSender {
      // The proof named the phone the advertisement could not: re-key —
      // unless that identity is already held by a live entry, in which
      // case this dial was the second road to a reached phone.
      if let existing = voicePeers[sender], existing !== peer,
         existing.ready || existing.connecting {
        vlog("ident-dup hash=" + hex(sender) + " road=second")
        dropClient(peer, "ident-dup")
        return
      }
      // A HALF-DEAD ENTRY UNDER THIS IDENTITY IS TORN DOWN, NOT PAVED
      // OVER. The line below writes this peer over whatever was at
      // `sender`; under the old shape that stranded a peripheral and an
      // open connection, and under this one it would strand a whole
      // generation — its manager, its delegate seats and its live
      // connection — unreachable from the peer map forever.
      if let stale = voicePeers[sender], stale !== peer {
        dropClient(stale, "re-key")
      }
      voicePeers.removeValue(forKey: Self.unknownSender)
      peer.hash = sender
      voicePeers[sender] = peer
      // THE MEMO IS WRITTEN BY SUCCESS, AND ONLY BY SUCCESS (2026-08-27,
      // WalkieBleLink.kt carries the same correction). Written before the
      // duplicate check, it recorded "this peripheral is that phone, and
      // that phone is reached" for a dial that was then REFUSED — and the
      // scan damper above spent that record on every later sighting,
      // against a peer whose link runs to a different peripheral.
      provenIdentity[id] = sender
    }
    let raw = String(decoding: b[Self.pvHeader...], as: UTF8.self)
    peer.name = raw.isEmpty ? "someone" : raw
    peer.key = "ble|" + String(peer.hash, radix: 16) + "|" + peer.name
    // NAME OURSELVES, THEN LIST. The settle is what publishes.
    gen.beginIdent(identBytes())
  }

  /// The handshake settled voice-safe. Queue.
  fileprivate func publishIfSettled(_ gen: BleLinkGeneration) {
    guard !stopped else { return }
    guard let peer = gen.peer, peer.link === gen else {
      vlog("gen-stale gen=" + String(gen.id) + " why=settle")
      gen.retire("stale-settle")
      return
    }
    publish(gen, peer)
  }

  /// THE LISTING, and the only place this rung hands the module a writer.
  /// Queue.
  ///
  /// §5 lives in these four lines: the proof has already come back on this
  /// generation's own link, the budget gate already refused anything that
  /// cannot carry a frame, and only now does the link become `ready` and
  /// the peer become a row.
  private func publish(_ gen: BleLinkGeneration, _ peer: VoicePeer) {
    // FIVE CONDITIONS, AND ALL FIVE: the proof is authoritative, this
    // generation is the peer's current link, its ident token settled
    // voice-safe, no acknowledged write is still outstanding on the wire,
    // and THE PIPE IS STILL UP AT THIS INSTANT. Drop any one and the
    // module gets a writer for a link that is unproven, superseded,
    // mid-exchange — or dead. The last is the newest and the cheapest: a
    // settle can be reached from a callback that raced the disconnect, or
    // from a read-only skip taken microseconds before the state flipped
    // with the delegate callback still queued behind us, and re-asking the
    // object costs one property read at the one door that hands out a
    // writer.
    guard !stopped, !gen.retired, peer.link === gen, !gen.ready,
          gen.identProven, gen.identVoiceSafe, gen.identOpsRemaining == 0,
          gen.transportConnected else { return }
    gen.markReady()
    peer.backoff = Self.connectBackoffBase
    vlog("peer-ready gen=" + String(gen.id) + " hash=" + hex(peer.hash))
    onPeer(peer.key, peer.name, peer.hash) { [weak gen] frame in
      // THE WRITER CAPTURES THE GENERATION, NEVER THE PEER. WalkieModule
      // owns this closure's lifetime, so a writer minted for generation 1
      // would otherwise put frames on generation 2's wire.
      gen?.write(frame)
    }
  }

  /// A CENTRAL TOLD US WHO IT IS, over the link IT made. Queue.
  ///
  /// WHAT THIS IS NOT: a peer row. §5 is untouched — a phone is listed
  /// only after OUR OWN read came back on OUR OWN link, because that is
  /// the link our voice leaves on. What the write supplies is WHO and
  /// WHERE for a phone already talking to us, so the dial that names the
  /// talker happens NOW instead of waiting on a sighting, a backoff and a
  /// truncated advertisement to line up.
  ///
  /// EVERY GATE THE READ PATH HAS, because bytes a stranger can write are
  /// bytes a stranger can forge: the pod header, our own reflection, and
  /// an ident that names nobody. A WRITTEN HASH MAY NEVER OVERRULE A
  /// PROVEN ONE, and NO MEMO IS WRITTEN HERE — provenIdentity may only
  /// record a peripheral a link of OURS was actually established from, and
  /// this write establishes nothing of ours.
  ///
  /// EAS-VERIFY / field-verify: CBCentral.identifier and the
  /// CBPeripheral.identifier our own managers use are the same resolved
  /// peer UUID on iOS. Where that does not hold the dial below simply
  /// finds no object, logs gen-refuse reason=no-object, and the scan gets
  /// there the way it always did — a lost shortcut, never a lost peer.
  private func handleIdentWrite(_ id: UUID, _ value: Data) {
    guard !stopped else { return }
    let b = [UInt8](value)
    guard b.count >= Self.pvHeader, b[0] == 0x50, b[1] == 0x56,
          be32(b, 2) == podHash else {
      return // a stranger's bytes on our characteristic, silent like a bad frame
    }
    let sender = be32(b, 6)
    guard sender != senderHash, sender != Self.unknownSender else {
      return // our own reflection, or an ident that names nobody
    }
    if let held = voicePeers.values.first(where: {
      $0.ready && $0.hash != sender && $0.link?.peripheralId == id
    }) {
      vlog(
        "ident-write-reject claimed=" + hex(sender) + " proven=" + hex(held.hash) +
          " id=" + id.uuidString
      )
      return
    }
    // Re-key OUR OWN unproven entry for this address, exactly as the read
    // path does when the proof names the phone a truncated advertisement
    // could not.
    if let unknown = voicePeers[Self.unknownSender], !unknown.ready,
       unknown.link?.peripheralId == id {
      if let existing = voicePeers[sender], existing !== unknown,
         existing.ready || existing.connecting {
        vlog("ident-dup hash=" + hex(sender) + " road=second")
        dropClient(unknown, "ident-write-dup")
      } else {
        if let stale = voicePeers[sender], stale !== unknown {
          dropClient(stale, "re-key")
        }
        voicePeers.removeValue(forKey: Self.unknownSender)
        unknown.hash = sender
        voicePeers[sender] = unknown
      }
    }
    vlog("ident-write-in hash=" + hex(sender) + " id=" + id.uuidString)
    // maybeConnect owns every reason not to: already ready, already
    // dialling, inside its backoff, or at maxVoiceLinks. This adds a
    // TRIGGER, never an exemption.
    maybeConnect(sender, id)
  }

  private func be32(_ v: UInt32) -> [UInt8] {
    [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  private func be32(_ b: [UInt8], _ at: Int) -> UInt32 {
    (UInt32(b[at]) << 24) | (UInt32(b[at + 1]) << 16) | (UInt32(b[at + 2]) << 8) | UInt32(b[at + 3])
  }
}

// -------------------------------------------------- the scanner's seat

/**
 THE SHARED MANAGER'S DELEGATE, and the shortest extension in this file on
 purpose: a state callback and a sighting callback, and NOTHING ELSE.

 didConnect, didFailToConnect and didDisconnectPeripheral are deliberately
 absent. This manager never connects, so there is no link for one of them
 to be about — and their absence here is the structural half of the ruling
 that every link callback reaches a per-dial owner. A connection handler on
 this class would mean a link this class could answer for.
 */
extension WalkieBleVoice: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard !stopped else { return }
    switch central.state {
    case .poweredOn:
      vlog("up scan=1")
      // Duplicates ON: repeat sightings ARE the redial trigger (header).
      central.scanForPeripherals(
        withServices: [Self.serviceUUID],
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
      )
    case .poweredOff, .unauthorized, .resetting:
      vlog("adapter-off state=" + String(central.state.rawValue) + " peers=" + String(voicePeers.count))
      // Bluetooth off mid-walkie (or denied): the OS already dropped
      // every connection — empty the rung honestly; poweredOn re-enters
      // above and the next sightings redial (WalkieBleLink.onAdapterOff,
      // mirrored; here the state callback IS the adapter receiver).
      retireAll("adapter-off")
      voicePeers.removeAll()
      // AND THE EPOCH TURNS OVER. Every CBPeripheral the stack vended
      // before this moment is dead to it whether or not ARC has caught up,
      // so the quarantine's second release condition fires and no address
      // is held back by an object that can no longer mean anything.
      BleObjectQuarantine.shared.adapterReset()
    default:
      break // unknown/unsupported settle on the next state callback
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    guard !stopped else { return }
    // The ADDRESS and the advertisement's facts are what leave this
    // callback. The object stays here.
    let id = peripheral.identifier
    let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
    noteSighting(id, advertisementData, advName, RSSI)
    guard let (pod, hash) = decodePv(advertisementData) else {
      noteScanDrop("no-carrier", id, advName)
      return
    }
    guard pod == podHash else {
      noteScanDrop("other-pod", id, advName)
      return // another pod's walkie
    }
    guard hash != senderHash else {
      noteScanDrop("self", id, advName)
      return // our own reflection
    }
    if hash == Self.unknownSender,
       let known = provenIdentity[id],
       let p = voicePeers[known], p.ready {
      // Churn damper, mirrored from WalkieBleLink.kt: a truncated
      // advertisement re-sighted from a phone the proof already named
      // must not spend another dial while that peer is still reached.
      // READY ONLY — `connecting` is a dial in flight, which has proved
      // nothing yet, and the scan stream is this rung's only retry
      // engine; damping it on an unproven dial suppresses the very
      // sighting that would have healed a stalled setup.
      noteScanDrop("already-reached", id, advName)
      return
    }
    maybeConnect(hash, id)
  }
}

// ------------------------------------------------------------ server side

extension WalkieBleVoice: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard !stopped else { return }
    switch peripheral.state {
    case .poweredOn:
      if !serviceAdded {
        let svc = CBMutableService(type: Self.serviceUUID, primary: true)
        svc.characteristics = [
          CBMutableCharacteristic(
            type: Self.voiceChar,
            properties: [.writeWithoutResponse, .write],
            value: nil,
            permissions: [.writeable]
          ),
          CBMutableCharacteristic(
            type: Self.identChar,
            // .write joins .read: the read is still the proof every peer
            // in the field depends on and it is untouched — same UUID,
            // same bytes, same answer. The added permission only lets a
            // central that DIALLED us say who it is, over the link it
            // already holds. A peer that never writes is unaffected in
            // every direction.
            properties: [.read, .write],
            value: nil,
            permissions: [.readable, .writeable]
          ),
        ]
        peripheral.add(svc)
        serviceAdded = true
      }
      beginAdvertising(peripheral)
    case .poweredOff:
      // CoreBluetooth drops published services on power-off; the next
      // poweredOn must re-add ours or the advertisement comes back with
      // nothing to read behind it (the CrewBeacon lesson).
      serviceAdded = false
      settleStartEffect(.degraded, "power-off")
    case .unauthorized, .unsupported:
      // NOT A RUNG, AND THEREFORE A TERMINAL. Before this the start op had
      // no settlement on these roads at all: the lease sat in `starting`
      // until its budget ran out, which is a whole second of a state that
      // already knew its answer.
      settleStartEffect(.degraded, "state-" + String(peripheral.state.rawValue))
    default:
      break
    }
  }

  /**
   THE ADVERTISER'S OWN EFFECT, and the settlement that did not exist
   (arbiter addendum 3): "no didStartAdvertising(error) settlement exists".

   `startAdvertising` is a REQUEST. The delegate below is the answer, and
   until it lands nothing in this process may call this rung active — which
   is why the arbiter's `starting` phase reports rung `none` and why a
   snapshot cannot say `advertising` before this line runs.
   */
  func peripheralManagerDidStartAdvertising(
    _ peripheral: CBPeripheralManager,
    error: Error?
  ) {
    if let error {
      vlog("advertise-failed why=" + error.localizedDescription)
      settleStartEffect(.degraded, "advertise-error")
      return
    }
    vlog("advertise-effect name=" + pvName())
    settleStartEffect(.advertising, "advertising")
  }

  /// One line, two callers, one attribution: the effect is reported
  /// against the LEASE that authorised this advertiser, never against
  /// "the current one", so a callback arriving after the lease ended is
  /// dropped by the arbiter rather than believed by it.
  private func settleStartEffect(_ rung: AirtimeRung, _ why: String) {
    guard let leaseId = airtimeLease else { return }
    WalkieAirtimeArbiter.shared.noteStartEffect(lease: leaseId, rung: rung, why: why)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard request.characteristic.uuid == Self.identChar else {
      peripheral.respond(to: request, withResult: .attributeNotFound)
      return
    }
    // Honor offset continuations: a pre-MTU-exchange central reads this
    // in slices and must reassemble one value, not several (the same
    // long-read rule CrewBeacon documents).
    let b = identBytes()
    guard request.offset <= b.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = b.subdata(in: request.offset ..< b.count)
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    // One response settles the whole batch, per CoreBluetooth's contract.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: .success)
    }
    guard !stopped else { return }
    for request in requests {
      if request.characteristic.uuid == Self.identChar {
        // The reverse direction, and it is a HINT: handleIdentWrite mints
        // no row and writes no memo.
        if request.offset == 0, let v = request.value {
          handleIdentWrite(request.central.identifier, v)
        }
        continue
      }
      // Voice never rides a prepared (long) write — frames fit the write
      // budget by contract (the minVoiceWrite gate on the writer), so a
      // nonzero offset is a stranger or a bug, like an oversized value.
      guard request.characteristic.uuid == Self.voiceChar, request.offset == 0,
            let v = request.value, v.count <= Self.maxVoiceFrame else {
        continue
      }
      // The frame self-identifies (pod, sender, seq, codec) — the
      // module's one receive path gates it exactly like a datagram.
      onFrame(v)
    }
  }
}
