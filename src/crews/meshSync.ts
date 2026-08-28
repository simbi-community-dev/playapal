/**
 * meshSync — the conductor that turns sightings into mailbox syncs (Camp
 * Mesh, docs/CREW-DESIGN.md §6b). Composition only:
 *
 *   radio sighting (peerId) ──> throttle ──> CrewSyncLink over the native
 *   syncWithPeer ──> syncLink.syncWithPeer (digest → wants → messages →
 *   accept) ──> messagesRevision bump ──> inbox re-renders.
 *
 * And the SERVING side: the native GATT server asks JS two things —
 * "what do you carry?" (answered by keeping setSyncDigest fresh on every
 * store change) and "peer X wants these ids" (CrewSyncWant → serveMessages
 * → provideSyncMessages).
 *
 * TWO CONNECTIONS PER SYNC, on purpose: the native syncWithPeer runs one
 * connected op and cannot pause mid-connection while JS computes the want
 * list, so the link does a digest-only pass, JS diffs against its own
 * store, then a second pass writes the want and reads the messages. The
 * second pass re-reads the digest and throws it away — a few hundred bytes
 * against not holding a radio connection open across a JS round-trip.
 *
 * WHAT MOVES: every typed record the store carries, not just pod mail.
 * The digest/want/serve path here is kind-blind (syncLink.ts owns that
 * contract), so a board post or camp note riding these rails propagates
 * across camp on exactly the same sightings, with no wiring in this file.
 *
 * BASE STATION (design §6b): there is NO special base mode in code — the
 * serving side runs whenever the GATT server is up, so any phone with
 * sharing on relays everything it carries. A plugged-in phone at camp with
 * the toggle left on IS the base station.
 *
 * The want wire format is OURS (native moves opaque bytes): UTF-8 JSON
 * array of message ids. The digest/messages formats belong to syncLink.ts.
 */
import { AppState, NativeModules } from 'react-native';
import {
  messagesRevision,
  subscribeLocalCompose,
  subscribeMessagesChanged,
  epochMinutes,
} from './messages';
import {
  serveDigest,
  serveMessages,
  syncWithPeer as linkSync,
  type CrewSyncLink,
  type OfferIdentity,
  type SyncOutcome,
} from './syncLink';
import {
  b64ToBytes,
  bytesToB64,
  onRadioState,
  onSighting,
  onSyncServed,
  onSyncWant,
  setScanPosture,
} from './radio';

const native = NativeModules.CrewBeacon;

/** A peer is re-synced at most this often — sightings repeat every scan
 * window, mailboxes change on human timescales. This is the BACKGROUND
 * number; it was also the delivery clock (field report 2026-08-25: two
 * phones a foot apart, app open on both, and mail still took "not very
 * quick" — up to a full minute), because sync is pull-only, so the
 * RECEIVER's cooldown decides when a fresh message moves. Foreground gets
 * the shorter clock below, plus the nudge paths that bypass both. */
const PEER_SYNC_COOLDOWN_MS = 60_000;

/** Foreground cooldown: the app is OPEN, the human is watching the pod,
 * and a GATT digest exchange is a sub-second connect — four dials a minute
 * per peer is cheap next to the high-accuracy GPS watch the same session
 * already runs. Restored to the 60 s clock the moment the app backgrounds
 * (the posture listener below owes the reverse arc). */
const FOREGROUND_SYNC_COOLDOWN_MS = 15_000;

/** A nudge (compose / served / manual check) bypasses the cooldown but
 * never dials a peer synced this recently: below this the honest answer is
 * already "caught up", and this floor is also what bounds the reciprocity
 * chain — A dials B, B dials back, and A's would-be third dial lands
 * inside the floor and stops the ping-pong.
 *
 * THE NATIVE SIDE HOLDS THE SAME NUMBER while the app is foreground
 * (CrewBeaconModule.GATT_COOLDOWN_FOREGROUND_MS). That is not a
 * coincidence to be tidied away later: a nudge can only dial an address it
 * has SEEN, and for a peer whose payload rides a characteristic the read
 * IS the sighting, so a 30-second native floor under a 5-second JS one
 * meant the JS floor never decided anything (measured: 27.4 s to deliver
 * between adjacent phones). One question, one answer, both layers. */
const NUDGE_MIN_GAP_MS = 5_000;

/** Only addresses HEARD this recently are worth nudging: a compose should
 * dial the phone standing next to you, not every name the forget horizon
 * still remembers. */
const NUDGE_FRESH_WINDOW_MS = 15_000;

/**
 * The freshness rule: an address is stale when it has missed too many of
 * ITS OWN heartbeats — not when it crosses one number chosen for one
 * platform.
 *
 * A peerId here is a BLE address, and a BLE address is a temporary name.
 * Android mints a fresh random address every time the advertisement is
 * (re)started, which on a sharing phone is every refresh tick — measured
 * on two handsets: an address is visible for a median of 11 seconds and
 * then is gone forever, replaced by an unrelated one.
 *
 * THE SPIRAL THE GATE ENDS, measured rather than reasoned: a queued
 * address that has rotated does not fail fast, it fails at the GATT
 * connect TIMEOUT. Dials were landing exactly 30 seconds apart — so every
 * attempt spent 30 seconds learning that a 10-second name was dead, and
 * left the next queue entry 30 seconds staler than the one that just
 * died. Once behind, never caught up: 5 of the last 5 dials targeted an
 * address that had not been on the air at any point in the log, while the
 * mailbox sat full and the radio was healthy.
 *
 * WHY THE THRESHOLD ADAPTS instead of being the flat ten seconds this
 * shipped with for one commit: sighting CADENCE is a platform property.
 * An Android advertisement carries the payload inline, so a live
 * neighbour is sighted every second or two — but an iOS peer's payload
 * rides a GATT characteristic and the read is rate-limited by the native
 * floor (CrewBeacon.gattCooldown, 30 s on iOS; the Android module now runs
 * 5 s foreground / 30 s background), so a live iPhone is sighted twice
 * a minute AT BEST. A flat 10-second gate reads every live iPhone as a
 * corpse and starves it of mail forever — caught in cross-family review,
 * not on devices, because the test pair is two Androids. So an 'adv'
 * address is judged against its own observed rhythm — missing three of
 * your own heartbeats means gone — and a GATT-sighted address is not
 * judged at all (see addressFresh for why no number can be right there).
 */
const FRESH_GAP_MULTIPLE = 3;
/** Floor: an Android address seen twice 1s apart is not stale 4s later —
 * scan bursts under-estimate the true gap. */
const FRESH_FLOOR_MS = 12_000;
/** An 'adv' address seen only ONCE has no rhythm to judge against, and a
 * short allowance is safe BECAUSE of how 'adv' sightings arrive: inline
 * scan data, a path our own busy radio can never starve — a live Android
 * neighbour re-sights within a second or two no matter what the sync
 * worker is doing. A 20-second-old one-shot 'adv' name is a rotation
 * drive-by, and dialling it burns a connect timeout. */
const FRESH_SINGLE_ADV_MS = 15_000;
/** Ceiling, so a wildly-spaced pair of sightings cannot argue an address
 * into being dialable minutes after it left the air. */
const FRESH_CEILING_MS = 90_000;

/** Addresses stop existing, so their bookkeeping has to stop too: an entry
 * older than this can never pass the freshness gate again, and on a phone
 * left sharing for a week the rotation would otherwise grow these maps by
 * thousands of dead names per peer. */
const ADDRESS_FORGET_MS = 5 * 60_000;

/**
 * THE ONE-WAY MIRROR, measured on the 2026-08-26 four-phone bench.
 *
 * Sync is PULL-ONLY, and the dial queue was fed by ONE source: scan
 * sightings. So a peer this phone cannot DISCOVER is a peer whose mail can
 * never move to us, no matter how reachable it is — and an iPhone with the
 * walkie open is exactly that peer, because holdCrewAdvertising takes its
 * crew beacon off the air (share.ts explains why it must: CoreBluetooth
 * pushes a second advertiser's service UUID into the overflow area, where
 * Android cannot see it at all).
 *
 * What the logs actually showed, in two minutes with three phones a foot
 * apart: each Pixel's scan produced 74 results and every single one was the
 * OTHER Pixel. Zero sightings of the iPhone. Meanwhile the iPhone connected
 * to those same Pixels eleven times and pulled their whole digest each time
 * — from nine different rotating addresses, every one of them live,
 * dialable, and thrown away, because meshSync read CrewSyncServed as
 * "somebody pulled" and never as "somebody is at THIS address".
 *
 * So the cure is not a duty cycle and not a looser freshness gate: it is
 * to stop discarding the address the peer just handed us. A completed
 * digest pull is the strongest sighting there is — not "this name was on
 * the air recently" but "this name completed a connection to us just now".
 * Stamped as via='gatt', because it is not scan-path evidence and the
 * freshness gate must not judge it by an advertiser's rhythm.
 */
/** Consecutive failed dials of an address known ONLY from a served event,
 * after which that path rests. The native sync mutex is one-at-a-time with
 * a 60 s timeout, so an address that cannot be dialled is not merely a
 * wasted attempt — it is a stall of every other peer's mail. Three strikes
 * bounds that at a few tens of seconds per rest window; any success at all
 * clears it. */
const SERVED_DIAL_STRIKES = 3;
/** How long the served-address path rests after striking out. */
const SERVED_DIAL_REST_MS = 5 * 60_000;

/**
 * THE REST WINDOW USED TO EAT THE EVIDENCE TOO, and that is what broke the
 * eight-minute cross-OS bar (composition review, 2026-08-27).
 *
 * The breaker above is right about REACHABILITY and says nothing about
 * ROUTES. What it did in practice was both: a peer that pulled from us
 * during the rest handed over a live, dialable address, meshSync stamped
 * it, dropped the queue entry (`drop reason=served-dial-resting`) and then
 * simply waited for whatever radio event came next. With the walkie open
 * the automatic nudges are standing down (see airtimeHeld), so "next" is
 * the ambient 60 s clock plus an idle back-off step — 120-150 s — and the
 * two-pass sync behind it is two more native ops. Measured against the
 * bar: 300 s of rest + 150 s to the next usable event + 120 s of passes =
 * 9.5 minutes for a message between phones a foot apart.
 *
 * THE CURE IS NOT A CLOCK, and the first attempt at one is why this
 * paragraph exists. Retaining the route and dialling it at the breaker's
 * expiry (the design this replaces) bounded nothing: the expiry instant
 * can land while an unrelated two-pass sync is ALREADY in flight, and the
 * target's own two passes queue up behind it — 300 + 120 + 120 = 540 s
 * before a timer's own jitter, past the bar again. A number chosen against
 * one interleaving is not a bound.
 *
 * SO THE DEBT IS KEYED TO THE EVIDENCE — not to the address forever, and
 * not to a clock at all. A CrewSyncServed is authoritative proof of
 * reachability ("this name completed a connection to us just now"), and
 * each FRESH piece of that proof earns exactly ONE priority reciprocal
 * attempt: the address goes to the FRONT of the dial queue, so the only
 * thing that can precede it is the operation already in flight. Its worst
 * case is two native ops end to end — current (120 s) + target (120 s) =
 * 240 s from the event — whatever the rest window has left to run.
 *
 * AND THE OCCURRENCE IS THE CALLBACK INVOCATION, NOT THE NAME. The first
 * cut of this cure asked "have we seen this address before?" and refused
 * every later pull from a name already carrying a claim — which reads as a
 * breaker and is really a lost message: native emits CrewSyncServed once
 * per COMPLETED digest pull, so a second callback for one address is a
 * second connection the peer actually made, minutes of mail later, and the
 * only thing it has in common with the first is spelling. Keying freshness
 * on the address made ROTATION the retry capability — a peer whose central
 * name happened not to rotate went mute for the rest of the window, which
 * on the hostile interleaving is 570 s on a 480 s bar (review, round 5).
 *
 * SO EACH INVOCATION MINTS ITS OWN GENERATION and every generation is
 * worth one attempt. Per address this file keeps at most TWO slots:
 *
 *   CURRENT — the claim whose attempt is in flight or waiting for the
 *     radio. It is what the rest window lets through, and it is what the
 *     dial log names (`evidence=<gen>`).
 *   PENDING — the LATEST occurrence banked behind it. A pull arriving
 *     while the current attempt is outstanding does not dial (one attempt
 *     in flight, always) and does not queue a second entry: it replaces
 *     whatever was banked. Two occurrences that both arrived mid-attempt
 *     coalesce because they are both "the peer is still there", and the
 *     later one says it with fresher bytes — coalesced by GEN, never by
 *     spelling.
 *
 * FAILURE consumes the current (stamped spent, before the name's own
 * bookkeeping goes) and then PROMOTES the pending, if there is one, into a
 * new current claim worth exactly one priority attempt. SUCCESS clears
 * both, because a completed dial opens the breaker outright and the debt
 * is paid in full.
 *
 * WHAT BOUNDS THE STORM, now that the address no longer does. One
 * occurrence earns one attempt; nothing in this file ever schedules a
 * retry for itself; and occurrences arrive only when a peer COMPLETES a
 * digest pull from us. So N callbacks buy at most N dials, the cadence is
 * the peer's own connection rate rather than any clock of ours, and the
 * two slots are all the memory an address can ever hold.
 *
 * AND N IS NOT A FAIRNESS ARGUMENT — the finding against the paragraph
 * above (cross-family review, 2026-08-27). "N callbacks buy at most N
 * dials" bounds the WORK and says nothing about WHOSE work it displaces.
 * N is unbounded in time: one completed pull inside every 120 s failure
 * sustains the failure->promote cycle forever, the breaker cannot see it
 * (fresh proof is exactly what the breaker is told to let through), and
 * every promotion above unshifted the address ahead of every peer already
 * waiting. So a podmate this phone can be pulled FROM but cannot dial back
 * monopolises the single-flight worker, and unrelated peers wait behind it
 * for as long as it keeps pulling. That is starvation, not a bound.
 *
 * SO THE PRIORITY IS A CREDIT, ONE PER ADDRESS PER FAIRNESS EPOCH. The
 * FIRST claim an address makes in an epoch takes the front of the queue
 * exactly as before — that is the 210 s path the bar is stated against and
 * it is untouched. A claim made before that address has yielded is placed
 * NEXT-AFTER-ONE instead: behind exactly the first unrelated peer waiting,
 * and never behind more than that one.
 *
 * AN EPOCH ENDS AT A DIAL TURN. Taking a turn spends the dialling
 * address's own credit and RESTORES every other address's, so the front is
 * available to a peer that has just waited and never twice running to the
 * peer that just had it; and an idle worker (the queue drained) owes
 * nobody a turn, so it restores everyone's. The debt this charges an
 * unrelated peer is therefore exactly ONE native op and never the whole
 * queue — current op (120 s) + one fairness peer (120 s) + the target
 * (120 s) = 360 s from the proof, inside the 480 s bar — and the
 * alternation is the bound: a storming address can never take two
 * consecutive dials while an unrelated peer is waiting.
 *
 * AND ONE ADDRESS IS NOT THE CLASS — the finding against the paragraph
 * above (cross-family review, 2026-08-27, on the commit that shipped it).
 * The credit was PER ADDRESS and a turn restored every OTHER address's, so
 * two storming podmates hand it back and forth: A and B both take a front,
 * B's turn restores A, A's turn restores B, and the queue cycles B, A, B,
 * A while an ordinary peer C waits forever. Every clause of the rule above
 * still holds — no address takes two consecutive turns, each yields to
 * "one unrelated peer" — and C is starved anyway, because the peer each of
 * them yielded to was the OTHER storm. An arm that arms a single storming
 * address cannot see it.
 *
 * SO THE OUTER CREDIT IS THE SERVED-PRIORITY CLASS'S, not an address's.
 * Any promoted turn spends it, and while it is spent EVERY promotion —
 * including the first claim of an address that has its own credit in
 * hand — is placed behind the first ORDINARY waiter rather than at the
 * front. A different served address does NOT hand it back: only an
 * ordinary dial turn does, or a worker that goes truly idle (queue
 * drained, nobody left to be jumped). The per-address credit above is kept
 * BENEATH this gate and still owns everything it owned — the occurrence,
 * the current + pending slots, and the placement whenever the class gate
 * is open — so the class rule can only ever move a promotion FURTHER
 * back, never forward.
 *
 * THE NET LAW, and what the arms assert: promoted turns and ordinary turns
 * ALTERNATE whenever both classes are waiting. The bound is unchanged,
 * because the class gate charges the target exactly the same single
 * ordinary op the per-address rule already charged it — behind the first
 * ordinary waiter is still index 1 whenever no promoted entry sits ahead
 * of it, and the drain below refuses to let one stay there.
 */
/** Monotonic over the CALLBACK INVOCATIONS this system governs — the
 * occurrence id, and the number the field log prints so a trace can tell
 * one pull from the next. Minted per invocation and never per name: the
 * whole defect above was a freshness test that could be answered by an
 * address's history. */
let servedEvidenceGen = 0;
/**
 * addr -> the CURRENT claim: the one attempt in flight or awaiting its
 * dial.
 *
 * `spent` is the consumption record: false while the attempt is
 * outstanding (the queue entry carrying it IS the attempt), true once that
 * dial has run and failed. A spent claim gates nothing — the next
 * occurrence from the same address takes the slot and earns its own dial —
 * it is the audit line and the thing a promotion is measured against. An
 * unspent claim is RELEASED whenever the drain drops its entry without
 * dialling, because evidence is consumed by an attempt and never by a
 * decision not to make one. Pruned on the same forget horizon as every
 * other address map.
 */
let servedEvidence = new Map<
  string,
  { gen: number; at: number; spent: boolean }
>();
/**
 * addr -> the LATEST occurrence banked behind the current attempt, and at
 * most that one. Written when a pull lands mid-attempt, read exactly once
 * by the promotion on that attempt's failure, dropped by a success, by a
 * release, and by the forget horizon.
 */
let servedPending = new Map<string, { gen: number; at: number }>();
/**
 * Addresses that have SPENT their priority credit in the current fairness
 * epoch — they took the front of the queue, or they took a dial turn — so
 * their next claim is placed behind one unrelated peer instead of ahead of
 * all of them. See the fairness epoch above.
 *
 * Deliberately NOT cleared by forgetAddress. The served path forgets a
 * rotated central name on every failed dial and promotes the banked
 * occurrence one line later, so a credit that died with the name would
 * hand the front straight back to the address that just used it — which is
 * the monopoly this set exists to refuse. Its own bound is the epoch: a
 * dial leaves at most the dialling address in it, and an idle worker
 * empties it outright.
 */
const servedPrioritySpent = new Set<string>();
/**
 * THE CLASS-LEVEL CREDIT: true once any promoted turn has run, until an
 * ordinary dial turn runs or the worker goes idle. While it is true, no
 * promotion may be placed ahead of an ordinary waiter — not even one whose
 * own per-address credit is unspent, and not because of WHICH address took
 * the last promoted turn. A second storming address handing the first one
 * its per-address credit back is exactly the starvation this refuses.
 */
let classPrioritySpent = false;

/**
 * THE WASTEFUL HEARTBEAT the same bench showed on the OTHER pair: two
 * caught-up Androids re-pulling an identical 1105-byte digest over a fresh
 * GATT connection four times a minute, forever, and logging accepted=0
 * every time. The cooldown is a clock and nothing above it ever learned
 * that the answer had not changed.
 *
 * A digest is a deterministic byte string, so "did this peer's offer
 * change?" is one cheap hash. A peer that offers the SAME digest and moves
 * nothing has its SIGHTING clock stretched, step by step, to this ceiling —
 * and only its sighting clock. Every path that means something happened
 * (compose, a served pull, the manual check) is a nudge, and nudges bypass
 * this entirely; the first byte of change in their offer resets it to base.
 * The ceiling is deliberately the BACKGROUND cooldown, so this can only
 * ever slow the foreground fast clock down to the frugal one — never past
 * a rate the app already considers honest.
 */
const IDLE_BACKOFF_CEILING_MS = PEER_SYNC_COOLDOWN_MS;
/** Multiplier steps: 15 s → 30 → 45 → 60 and stop. */
const IDLE_BACKOFF_MAX_STEPS = 3;

let running = false;
/**
 * THE MESH SESSION EPOCH — one number that says which session a piece of
 * work belongs to.
 *
 * THE CLASS IS OLDER THAN THIS LANE (traced to 949d0bd, the commit that
 * created this file WITH an async drain — a shared `syncing` boolean and a
 * loop awaiting linkSync; the hash cited here through ac124d8, 15db991, is
 * a walkie-BLE commit that never touched this file): stopMeshSync clears
 * the queue and the markers, and cannot cancel a native op already in
 * flight — nor can the native side, whose stopAll leaves syncBusy set. The
 * drain
 * awaiting that op wakes up in whatever world it finds — and everything
 * after the await mutates SHARED module state. What this lane's evidence
 * machinery added was CONSEQUENCE, not the race: a9a4251 gave a completed
 * dial the power to clear every claim (so an old success can erase a NEW
 * session's current+pending evidence), and d9a6c27 gave a failure the
 * power to promote a banked occurrence (so an old failure can re-add
 * queue, nudge and promoted markers to a session that never earned them —
 * or to no session at all, with running=false).
 *
 * So the cure is an identity, not another flag. startMeshSync and
 * stopMeshSync each mint a new epoch; every drain and every dial captures
 * the epoch it began in; and after EVERY await the captured epoch must
 * still be the current one before a single shared write happens. A
 * completion that fails that test does only what it alone owns (see
 * staleDialCompletion — which is nearly nothing, and that is the point).
 */
let meshEpoch = 0;
/**
 * Who is waiting to hear that the session ENDED — the manual check, and
 * nothing else so far.
 *
 * A gesture that awaits the radio has to be able to stop awaiting it the
 * instant the pod it was asked about stops existing; polling for that would
 * be a clock, and awaiting the radio anyway is how a tap outlived its own
 * screen by up to a native timeout. So the epoch bump is a published event.
 * Waiters are one-shot: the bump wakes and clears every one of them.
 */
const epochWaiters = new Set<() => void>();

/** The one place the session identity moves, so the wake can never be
 * forgotten by a new lifecycle path. */
function bumpMeshEpoch(why: string): void {
  meshEpoch += 1;
  // A recovery leg minted in the session that just ended is SUPERSEDED, and
  // it learns that here rather than by waiting for an ack that will never
  // come: the identity it captured is no longer the live one.
  notifyDigestReady();
  if (epochWaiters.size > 0) {
    const woken = [...epochWaiters];
    epochWaiters.clear();
    for (const wake of woken) {
      wake();
    }
    mlog(`epoch ${meshEpoch} reason=${why} woke=${woken.length}`);
  }
}

/** Resolves when THIS session ends (or is replaced). Never rejects. */
function epochEnds(): Promise<void> {
  return new Promise<void>(resolve => {
    epochWaiters.add(resolve);
  });
}

let unsubs: Array<() => void> = [];
let lastSynced = new Map<string, number>();
/** addr -> when we last actually SAW it advertising. */
let lastSeen = new Map<string, number>();
/** addr -> the observed gap between its last two sightings — the
 * address's own heartbeat, which the freshness gate judges it against. */
let seenGap = new Map<string, number>();
/** addr -> how its last sighting arrived ('adv' | 'gatt' | ...): the
 * gate's jurisdiction test — only scan-path ('adv') names can be
 * freshness-dropped, because only their silence is trustworthy. */
let seenVia = new Map<string, string>();
/** Addresses this phone knows ONLY because they pulled our digest — never
 * from a scan. The ones the strike counter judges, and the ones a failed
 * dial forgets outright (a rotated central name is worth exactly one try). */
let servedOnly = new Set<string>();
/** Consecutive failures on served-only addresses, and when the path may be
 * tried again. See SERVED_DIAL_STRIKES. */
let servedDialFails = 0;
let servedDialRestUntil = 0;
/** addr -> a hash of the digest it offered on its last completed exchange,
 * and how many consecutive exchanges have offered that same digest while
 * moving nothing. See IDLE_BACKOFF_CEILING_MS. */
let digestSig = new Map<string, number>();
let idleRuns = new Map<string, number>();
/** addr -> did the digest just fetched match the one before it? Written by
 * the in-flight fetchDigest, read and cleared once by the drain that owns
 * it — the drain is single-flight, so exactly one entry is ever live. */
let offeredSame = new Map<string, boolean>();
/**
 * Single-flight gate for the drain worker (the native side rejects
 * concurrent syncs): WHICH EPOCH's drain owns the worker right now, or
 * null when nobody does. Set synchronously at launch and cleared
 * synchronously at loop exit — gating on the promise's own settlement is a
 * microtask late, and a sighting landing in that gap saw a "running" drain
 * that would never reach its queue entry (caught by the freshness suite's
 * re-queue test). The promise below is only for callers that must WAIT.
 *
 * EPOCH-SCOPED RATHER THAN A BOOLEAN, and that is the second half of the
 * stop/start cure. A shared boolean is INHERITED: an old drain still
 * awaiting its native op holds `syncing = true` across the restart, so the
 * new session cannot start a drain of its own until a dead session's radio
 * op returns — and then that dead drain's `finally` clears the flag out
 * from under the live one. A new start may launch its own drain
 * immediately, and an old drain's finally only ever clears its OWN epoch's
 * ownership.
 */
let drainEpoch: number | null = null;
/** What checkPodUpdates awaits: the in-flight (or last) drain run. */
let drainPromise: Promise<void> = Promise.resolve();

/**
 * THE NATIVE-OP ARBITER — one radio, one operation, ACROSS SESSIONS, and
 * now with a CANCEL underneath it.
 *
 * THE HOLE THE EPOCH ALONE LEAVES (cross-family review, 2026-08-27). The
 * epoch stamp above makes a dead session's completion harmless, and it does
 * nothing about the RADIO: stopMeshSync could not cancel a native op already
 * in flight, and the Android module's stopAll neither cleared nor cancelled
 * its syncBusy latch. So the replacement session was free to dial while the
 * old op was still unresolved, native answered that dial 'busy', and the
 * REPLACEMENT session paid for it — a cooldown stamped at a dial that never
 * reached the air, a fairness turn taken, its own fresh served evidence
 * spent, a strike against its breaker, possibly its rest window opened.
 *
 * SO OWNERSHIP OF THE RADIO IS NOT SESSION-SCOPED. Everything else in this
 * file dies with the session that learned it; the radio does not, because it
 * is not a fact about a session at all — it is a fact about the hardware.
 * This slot therefore OUTLIVES resetMeshWorld and outlives the epoch bump
 * (see the justified-not-cleared table), and every dial chains through it.
 *
 * AND WAITING BEHIND IT WAS THE SECOND DEFECT (the architecture round,
 * 2026-08-27). The first arbiter made a new session's drain PARK on the dead
 * op's settlement proof, which converts "native is busy" into head-of-line
 * blocking of up to the native timeout — 60 s in which the live session's
 * whole queue is behind one corpse — and it had no terminal at all for a
 * promise that never settles: a bridge call that neither resolves nor
 * rejects wedged the worker for the life of the process.
 *
 * THE CURE IS OWNERSHIP PLUS CANCELLATION PLUS DEFERRAL, in that order:
 *
 *   OWNERSHIP  — installing an op mints a monotonic ticket and stores
 *                {ticket, at, settled}. `settled` is a SETTLEMENT PROOF, not
 *                the op: it resolves on BOTH roads and never rejects, so
 *                nobody learns a dead session's outcome from it.
 *   CANCEL     — a lifecycle event ENDS the native session (endSession), so
 *                the outstanding op is torn down at the source instead of
 *                waited out. The op then settles by its own road, releases
 *                the slot, and the live session dials immediately.
 *   DEFER      — a drain that finds the radio busy does NOT park on it. It
 *                leaves its queue exactly as it is and returns; the
 *                SETTLEMENT re-enters the drain. Nothing is dropped, nothing
 *                is charged, and no worker is held hostage to another
 *                session's op.
 *   TERMINAL   — a slot older than NATIVE_OP_TERMINAL_MS is a broken
 *                promise, not a busy radio: the native side's own contract
 *                is a hard timeout well inside that, so past it the op will
 *                never settle. It is cancelled and evicted at the next
 *                drain attempt, which is the one moment the answer matters.
 *                No timer: a clock this file starts is a clock this file
 *                must cancel on four teardown paths, and the deadline is
 *                only ever READ where it is acted on.
 *
 * RELEASE clears the slot ONLY IF the settling op's ticket still owns it. A
 * settlement that finds a NEWER ticket logs and leaves it alone: it is not
 * its slot to null. Both roads release — a THROWN op that left the arbiter
 * occupied would wedge the radio for the life of the process.
 *
 * An epoch bump never clears this slot. That is the whole point.
 */
let nativeOpTicket = 0;
let nativeOp: { ticket: number; at: number; settled: Promise<void> } | null =
  null;

/**
 * Past this, an outstanding native op is a BROKEN PROMISE rather than a busy
 * radio. The Android module's own sync timeout is 60 s and it settles the
 * bridge promise on every road out; iOS confines its op to one queue with
 * the same terminal discipline. So an op still unsettled a full timeout
 * PLUS a generous margin later is not going to settle, and holding the radio
 * for it forever is strictly worse than taking it back: the cancel goes out
 * first, so the hardware is told before this layer stops believing in it.
 */
const NATIVE_OP_TERMINAL_MS = 90_000;

/**
 * Tell the native side its mesh session is over — the CANCEL half of the
 * arbiter, and the reason a stop no longer leaves the radio holding a dead
 * pod's operation. Android tears down the exact in-flight SyncClient and
 * clears its owner record only when the record is still that op's; iOS
 * confines the same teardown to its own queue.
 *
 * CALLED PLAINLY, AND PROBED BY NAME — which is not a style preference.
 * iosMeshParity reads every `native.<verb>(` call site out of this file and
 * requires the iOS bridge to export it; `native?.endSession?.()` never
 * matched that reader, so the whole point of the gate — "no JS call site
 * aims at a verb one platform does not answer to" — was silently skipped for
 * exactly the two verbs that were newest and least likely to exist. The
 * optional-call SYNTAX is gone; the DEGRADE is not. A capability probe by
 * name keeps an older native binary under a newer JS bundle running exactly
 * the old behaviour — the op runs to its own terminal — while leaving the
 * call itself where the parity gate can see it.
 */
function endNativeSession(why: string): Promise<void> {
  try {
    const ended = 'endSession' in native ? native.endSession() : undefined;
    mlog(`native end reason=${why} sent=${ended === undefined ? 0 : 1}`);
    if (ended && typeof ended.then === 'function') {
      // …AND THE PROMISE IS HANDED BACK, not merely defused (row 107). This
      // used to `.catch(() => undefined)` and return void, so the ONLY thing
      // production could do with a native teardown was fire it and forget —
      // and forget is what teardownSession did, resolving while the native
      // side's own retirement had not run yet. The rejection is still
      // swallowed here (a radio that refuses to stop must not fail the stop),
      // but the SETTLEMENT is now something a caller can wait on.
      return Promise.resolve(ended).then(
        () => undefined,
        () => undefined,
      );
    }
  } catch {
    // A teardown that throws is still a teardown: the epoch already moved.
    mlog(`native end reason=${why} sent=0 threw=1`);
  }
  return Promise.resolve();
}

/**
 * Install `op` as THE outstanding native radio op and hand the op back
 * unchanged, so a caller writes `await holdRadio(dial())` and its own
 * success/failure handling is untouched.
 */
function holdRadio<T>(op: Promise<T>): Promise<T> {
  nativeOpTicket += 1;
  const ticket = nativeOpTicket;
  const release = (ok: boolean): void => {
    if (nativeOp !== null && nativeOp.ticket === ticket) {
      nativeOp = null;
      mlog(`arbiter release ticket=${ticket} ok=${ok ? 1 : 0}`);
      // THE RADIO CHANGED HANDS, so whoever deferred on it gets to go now.
      // This is the other half of refusing to park: a deferred drain is not
      // waiting on anything, so something has to wake it, and the settlement
      // is the only event that means "the hardware is free".
      kickDrain('arbiter-release');
      return;
    }
    // A NEWER op owns the radio (or nobody does). This settlement is late
    // and owns nothing: clearing here would hand a live op's radio to a
    // second caller.
    mlog(
      `arbiter kept ticket=${ticket} owner=${
        nativeOp === null ? 'none' : nativeOp.ticket
      }`,
    );
  };
  // Attached BEFORE the slot is published and before any caller's own
  // handler, so the release is the first thing that runs on either road.
  const settled = op.then(
    () => release(true),
    () => release(false),
  );
  nativeOp = { ticket, at: Date.now(), settled };
  mlog(`arbiter hold ticket=${ticket}`);
  return op;
}

/**
 * Is the radio busy RIGHT NOW — and if it has been busy past the terminal,
 * take it back.
 *
 * Answers true when a dial must not go out. The terminal eviction is done
 * here rather than on a timer because this is the only place the answer is
 * consumed: a drain asking for the radio is exactly the moment at which "the
 * op that will never settle" stops being a harmless curiosity.
 */
function radioBusy(reason: string): boolean {
  const held = nativeOp;
  if (held === null) {
    return false;
  }
  const age = Date.now() - held.at;
  if (age < NATIVE_OP_TERMINAL_MS) {
    mlog(`arbiter busy ticket=${held.ticket} ageMs=${age} reason=${reason}`);
    return true;
  }
  // A BROKEN PROMISE. Tell the hardware first, then stop believing in it:
  // its own settlement, if it ever comes, finds a slot it no longer owns and
  // says so (`arbiter kept`).
  // Deliberately NOT awaited here: this is the eviction of a broken promise
  // inside a synchronous predicate, and the whole point is that nothing waits
  // on the radio any more. The stop road below is the one that is a barrier.
  void endNativeSession('op-terminal');
  nativeOp = null;
  mlog(`arbiter terminal ticket=${held.ticket} ageMs=${age} reason=${reason}`);
  return false;
}

/**
 * ONE QUEUE ENTRY, AND EVERYTHING TRUE ABOUT IT (the architecture round,
 * 2026-08-27).
 *
 * This was three parallel collections keyed by address — the queue itself,
 * a `nudged` Set, a `promotedWaiters` Set — and every operation on the queue
 * had to remember to keep all three in step. The drain's own class-yield
 * proves the cost: it shifted an entry, deleted two Set memberships, decided
 * to put the entry BACK, and then had to re-add both by hand (`if (wasNudged)
 * nudged.add(peerId)`), where forgetting either silently changes what the
 * dial is allowed to do. Membership that belongs to an ENTRY was being
 * stored against a NAME, and a name can be in the queue once while its
 * markers say something about a dial that already happened.
 *
 * So the entry owns its own metadata. Moving it moves everything true about
 * it; dropping it drops everything; and there is no third collection that
 * can disagree with the queue about what is waiting.
 */
type QueuedDial = {
  addr: string;
  /** Placed by the served-priority path: the PROMOTED class, as opposed to
   * the ordinary waiters an ambient sighting queued. The class gate's whole
   * question, and it is the entry's fact, never the name's. */
  promoted: boolean;
  /** This dial may bypass the sighting clock (never the NUDGE_MIN_GAP_MS
   * floor, and never the freshness gate). One-shot by construction: it dies
   * with the entry at the dial. */
  nudged: boolean;
  /** The manual check that queued (or adopted) this entry, or 0 for an
   * ambient one. THE CHECK'S BATCH IS THIS FIELD — see CheckRun: a check
   * accounts for the entries carrying its id and for nothing else, which is
   * what makes its answer about the routes the human's tap actually
   * covered rather than about whatever the global worker happened to do. */
  check: number;
};

const queue: QueuedDial[] = [];

/** Where this address is waiting, or -1. One address, one entry — every
 * placement below either moves the existing entry or makes the only one. */
function queuedAt(addr: string): number {
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].addr === addr) {
      return i;
    }
  }
  return -1;
}

/** The crewCodes getter of the running session, so nudge paths triggered
 * by events (not by the start call) can drain with the same codes. */
let codesFn: (() => string[]) | null = null;

/** App posture: foreground = the human is watching, latency beats battery.
 * Defaults false so a native-free harness (and a headless start) keeps the
 * frugal clocks until the platform says 'active'. */
let foreground = false;

/**
 * THE ADAPTER'S LAST KNOWN POWER STATE, as this file heard it (row 123,
 * blocker 1). `null` = nothing has said yet; a module that cannot answer
 * reads as unchanged, never as off.
 */
let adapterUp: boolean | null = null;
let appStateSub: { remove(): void } | null = null;

/**
 * THE OTHER HALF OF THE AIRTIME TRADE — the receiving direction, and the
 * one this file's own addressFresh doc already banked as the cost it could
 * not pay: "a GATT-read sighting is produced by the very radio the queue
 * occupies… a live iPhone can go unsighted for minutes because WE were
 * busy."
 *
 * On iOS the walkie's BLE scan is the iPhone's ONLY road to discovering an
 * Android peer (being dialled teaches an iPhone nothing — an Android
 * central never writes its ident), and that scan shares ONE radio with
 * this file's dial queue. Foreground, this queue dials every known peer
 * every 15 s as a two-pass connect-and-read op under a 60 s native
 * timeout. Measured in the field: 3-4 minutes to sight a podmate, and
 * "Look again" — which parks the sync worker — fixing it in ~10 s.
 *
 * So while the walkie is OPEN, the ambient gossip clock steps back to the
 * frugal one and the automatic nudges stand down. THE TRADE, SAID PLAINLY,
 * exactly as share.ts says its half: iOS pod mail moves on the 60 s clock
 * instead of the 15 s one for the length of a walkie session. Nothing
 * stops — the queue still drains, the serving side still answers every
 * pull, and the MANUAL check (checkPodUpdates, the human's own gesture)
 * deliberately does not consult this flag at all. What pauses is this
 * phone hogging its own radio on a cadence nobody asked for, during the
 * one gesture that needs the radio to LISTEN.
 *
 * ANDROID IS UNTOUCHED: the hold is set only from share.ts's already
 * iOS-gated holdCrewAdvertising/releaseCrewAdvertising pair, so an Android
 * phone — whose advertisement carries its payload inline and whose peers
 * therefore never depended on our scan — keeps the fast clock. And with
 * the walkie CLOSED the flag is false on every platform, so the cadence is
 * byte-identical to what it always was.
 */
let airtimeHeld = false;
/** Has this hold already said it is parking? See the drain's park branch. */
let parkLogged = false;

/**
 * The walkie has (or has handed back) the radio. Called by share.ts from
 * inside holdCrewAdvertising/releaseCrewAdvertising, so this flag engages
 * and clears on exactly the paths the beacon hold does — including the
 * platform gate, which lives there and only there.
 *
 * Deliberately NOT reset by startMeshSync/stopMeshSync: backgrounding with
 * the walkie open tears mailbox presence down and re-arms it, and a hold
 * that forgot itself across that would restore the fast clock underneath a
 * still-open walkie. The release is what clears it, and the release always
 * runs (see the leak arm in __tests__/meshAirtimeHold.test.ts).
 */
export function setMeshAirtimeHold(held: boolean): void {
  if (airtimeHeld === held) {
    return;
  }
  airtimeHeld = held;
  parkLogged = false;
  mlog(`airtime ${held ? 'held' : 'released'} reason=walkie-airtime`);
  if (!held) {
    // THE RELEASE IS THE RESUME. While the hold stood, sightings kept
    // queueing and pulls kept claiming — evidence, not dials — so there is
    // a real queue here and no radio event is owed to it. Waiting for the
    // next sighting instead would spend the whole cost of the hold twice:
    // once during the walkie, and again afterwards.
    kickDrain('airtime-released');
  }
}

/** Is the walkie holding the radio right now — the surfaces' and the
 * suite's read of the flag above. */
export function meshAirtimeHeld(): boolean {
  return airtimeHeld;
}

/** Sync outcomes, for the honest surfaces: when did mail last actually
 * move, and how much did a manual check achieve. */
let lastSyncOkAt: number | null = null;
// acceptedTotal — a session-wide "messages accepted" counter — used to live
// here, and it is GONE rather than kept: its only reader was the manual
// check, which subtracted it across an await, and that subtraction is the
// defect M4 names (another peer's mail reported as the answer to a tap; a
// negative number across a restart). A counter nothing reads is a surface
// waiting to be misread, and the honest per-gesture number is the check's
// own batch.

// The pod surfaces re-render off this (last-caught-up line, check button):
// the presence/session revisions don't move when a sync completes.
let meshRev = 0;
const meshWatchers = new Set<() => void>();

function notifyMeshChanged(): void {
  meshRev += 1;
  for (const w of meshWatchers) {
    w();
  }
}

/**
 * THE FIELD LOG THIS LAYER NEVER HAD. The 2026-08-25 diagnosis ran on two
 * logcat dumps with ZERO JS lines: the native radio proved it was
 * advertising and said nothing about why mail sat still, because every
 * decision above the bridge was silent. One terse line per DECISION —
 * dials, drops, nudges, posture — at the cadence of syncs (15 s+), not of
 * sightings (1-2 s), so it is loggable unconditionally: release builds are
 * exactly where the next 3am diagnosis happens.
 */
function mlog(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[mesh] ${line}`);
}

/** The cooldown for THIS moment — posture-dependent, read at every gate so
 * a background transition (or a walkie opening) takes effect on the very
 * next decision. The airtime hold buys the fast clock back for the
 * walkie's scan: held, a foreground app runs the frugal clock it would run
 * in a pocket, and nothing else changes. */
function cooldownMs(): number {
  return foreground && !airtimeHeld
    ? FOREGROUND_SYNC_COOLDOWN_MS
    : PEER_SYNC_COOLDOWN_MS;
}

/**
 * The cooldown for THIS PEER: the posture clock, stretched by however many
 * consecutive exchanges it has answered with an unchanged digest and no
 * mail. Never past the frugal clock the background posture already runs.
 */
function sightingGateMs(peerId: string): number {
  const base = cooldownMs();
  const steps = idleRuns.get(peerId) ?? 0;
  if (steps <= 0) {
    return base;
  }
  return Math.min(base * (steps + 1), IDLE_BACKOFF_CEILING_MS);
}

/** FNV-1a over the peer's digest frame — "is their offer the same one?"
 * in 32 bits, so an unchanged mailbox costs one number instead of a copy.
 * Collisions cost one extra idle exchange, never a lost message. */
function digestSigOf(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  }
  return h;
}

/** Everything this layer knows about one address, gone. */
function forgetAddress(addr: string): void {
  const queued = queuedAt(addr);
  if (queued >= 0) {
    // The entry carries its own promoted/nudged/check markers, so dropping
    // it drops all three at once — there is no second collection left
    // holding an opinion about a dial that can no longer happen.
    noteCheckDone(queue[queued], 0);
    queue.splice(queued, 1);
  }
  lastSeen.delete(addr);
  lastSynced.delete(addr);
  seenGap.delete(addr);
  seenVia.delete(addr);
  servedOnly.delete(addr);
  digestSig.delete(addr);
  idleRuns.delete(addr);
  offeredSame.delete(addr);
  // servedPrioritySpent is deliberately absent from this list — see its
  // own doc. Forgetting the name one line before the promotion that
  // re-learns it must not also refund the credit that promotion is
  // supposed to have spent.
  //
  // An unspent claim's queue entry just went with the name. Release it, or
  // the peer's next pull would find its own proof already claimed by an
  // attempt that can no longer happen.
  releaseServedEvidence(addr, 'forgotten');
}

/**
 * The next occurrence id.
 *
 * Minted per JS CALLBACK INVOCATION — never per name, per address, or per
 * anything a peer's spelling can repeat. That is the whole owner model:
 * native raises CrewSyncServed once per completed digest pull, so an
 * invocation IS an occurrence, and two invocations are two occurrences
 * even when they carry the same six bytes of address.
 */
function nextServedGen(): number {
  servedEvidenceGen += 1;
  return servedEvidenceGen;
}

/**
 * FRONT OF THE QUEUE FOR THE FIRST CLAIM OF AN EPOCH, and behind exactly
 * one peer for every claim after it.
 *
 * The front is what the bound is stated against: appending puts every peer
 * already waiting BETWEEN the proof and the dial it authorised — three
 * waiting entries is 360 s of native ops before the target is tried at
 * all. But an UNCONDITIONAL front is a monopoly, so it is a credit: taken
 * once per address per fairness epoch, and after that the claim goes
 * NEXT-AFTER-ONE — index 1, behind the first unrelated peer waiting,
 * wherever the rest of the queue happens to be. An idle worker has nobody
 * to yield to, so on an empty queue the two placements are one entry.
 *
 * An entry the ordinary paths already queued for this address is MOVED
 * rather than duplicated: one address, one dial. That splice is also why
 * the head read below is by construction somebody ELSE's entry.
 */
function queueServedPriority(addr: string): void {
  // A nudge, deliberately, and for the reason the retained-route design
  // gave: this dial exists because the reciprocity nudge could not run when
  // the route arrived, so it inherits the nudge's bypass of the sighting
  // clock and the nudge's own NUDGE_MIN_GAP_MS floor.
  //
  // The entry is MOVED, never duplicated: whatever an ordinary path already
  // queued for this address is the same dial, so it is lifted out whole —
  // carrying the check that may own it — and re-placed as a promotion.
  const queued = queuedAt(addr);
  const entry: QueuedDial =
    queued >= 0
      ? { ...queue.splice(queued, 1)[0], promoted: true, nudged: true }
      : { addr, promoted: true, nudged: true, check: 0 };
  // THE CLASS GATE, and it is a FLOOR on the index rather than a branch of
  // its own: while the served-priority class owes a turn and an ordinary
  // peer is actually waiting, nothing promoted may land ahead of that
  // peer. Zero when the class credit is in hand or when there is nobody
  // ordinary to jump — an idle-ish queue makes the gate a no-op, which is
  // what keeps the 210 s first-claim path below byte-identical.
  const ordinary = firstOrdinaryWaiter();
  const floor = classPrioritySpent && ordinary >= 0 ? ordinary + 1 : 0;
  if (servedPrioritySpent.has(addr)) {
    const behind = queue[0]?.addr;
    const own = behind === undefined ? 0 : 1;
    const at = Math.max(own, floor);
    const after = queue[at - 1]?.addr;
    queue.splice(at, 0, entry);
    if (at > own) {
      mlog(`served-class-fairness ${addr} pos=${at} behind=${after}`);
    } else {
      mlog(`served-fairness ${addr} pos=${at} behind=${behind ?? 'idle'}`);
    }
  } else if (floor > 0) {
    // A first claim of this address's own epoch, gated by the CLASS: the
    // per-address credit is not spent here, because this claim never took
    // the front. It is still in hand for the next epoch the class opens.
    const after = queue[floor - 1]?.addr;
    queue.splice(floor, 0, entry);
    mlog(`served-class-fairness ${addr} pos=${floor} behind=${after}`);
  } else {
    servedPrioritySpent.add(addr);
    queue.unshift(entry);
    mlog(`served-priority ${addr} pos=front`);
  }
  kickDrain('served-priority');
}

/** Where the first ORDINARY waiter sits, or -1 when every entry in the
 * queue is a promotion. The class gate's whole question. */
function firstOrdinaryWaiter(): number {
  for (let i = 0; i < queue.length; i++) {
    if (!queue[i].promoted) {
      return i;
    }
  }
  return -1;
}

/** A dial TURN is the fairness epoch boundary: the address taking it
 * spends its own priority credit, and every address that did NOT take it
 * gets one back. One turn of debt, never the whole queue. */
function noteFairnessTurn(addr: string): void {
  for (const other of servedPrioritySpent) {
    if (other !== addr) {
      servedPrioritySpent.delete(other);
    }
  }
  servedPrioritySpent.add(addr);
}

/** This occurrence takes the CURRENT slot and the one priority reciprocal
 * attempt it earns. The caller has already established that no attempt is
 * outstanding for this address. */
function claimServedEvidence(addr: string, gen: number, at: number): void {
  servedEvidence.set(addr, { gen, at, spent: false });
  mlog(`served-evidence dial ${addr} gen=${gen}`);
  queueServedPriority(addr);
}

/**
 * This occurrence landed while an attempt for the same address was still
 * outstanding, so it is BANKED rather than dialled: one attempt in flight,
 * always. It replaces whatever was banked before it — two mid-attempt
 * occurrences say the same thing ("the peer is still there") and the later
 * one says it with fresher bytes. Coalesced by GEN; `replaces=0` is the
 * first one banked behind this attempt.
 */
function bankServedEvidence(addr: string, gen: number, at: number): void {
  const prev = servedPending.get(addr);
  servedPending.set(addr, { gen, at });
  mlog(
    `served-evidence banked ${addr} gen=${gen} replaces=${prev ? prev.gen : 0}`,
  );
}

/**
 * The current attempt failed and has been consumed: the LATEST banked
 * occurrence, if there is one, becomes the new current claim and earns
 * exactly ONE priority attempt of its own.
 *
 * The name is re-learned here on purpose. The pull that banked this
 * occurrence reached us from THIS address after the attempt that just died
 * was already in flight, so it is known-by-serving all over again — and
 * without that, the promoted dial would slip out of the served-only
 * population whose strikes and forgetting keep this path bounded.
 */
function promoteServedEvidence(addr: string): void {
  const occ = servedPending.get(addr);
  if (occ === undefined) {
    return;
  }
  servedPending.delete(addr);
  servedOnly.add(addr);
  seenVia.set(addr, 'gatt');
  if ((lastSeen.get(addr) ?? 0) < occ.at) {
    lastSeen.set(addr, occ.at);
  }
  servedEvidence.set(addr, { gen: occ.gen, at: occ.at, spent: false });
  mlog(`served-evidence promote ${addr} gen=${occ.gen}`);
  queueServedPriority(addr);
}

/** The attempt ran and FAILED: this proof is used up. Stamped before the
 * address's own bookkeeping is forgotten, because forgetting the name is
 * exactly what would otherwise make the peer's identical next pull look
 * like new proof. */
function spendServedEvidence(addr: string): void {
  const ev = servedEvidence.get(addr);
  if (ev === undefined || ev.spent) {
    return;
  }
  ev.spent = true;
  mlog(`served-evidence spent ${addr} gen=${ev.gen}`);
}

/** The attempt did NOT run — the drain dropped its entry at a gate, or the
 * name was forgotten underneath it. Nothing was learned, so nothing is
 * consumed: the claim goes back and the peer's next pull is fresh proof
 * again. A SPENT claim is never released; that one is the record of an
 * attempt that did happen.
 *
 * The banked occupant goes with it, because only a FAILURE promotes one
 * and no failure is coming for an attempt that never ran. The address is
 * left holding nothing, which is exactly the state its next pull expects. */
function releaseServedEvidence(addr: string, reason: string): void {
  const ev = servedEvidence.get(addr);
  if (ev === undefined || ev.spent) {
    return;
  }
  servedEvidence.delete(addr);
  servedPending.delete(addr);
  mlog(`served-evidence release ${addr} gen=${ev.gen} reason=${reason}`);
}

/** A dial COMPLETED, so the breaker is open and every address belongs to
 * the ordinary paths again: the debt is paid in full. The claims' QUEUE
 * ENTRIES are deliberately left standing — a dial that somebody else's
 * success did not perform is still owed, and the mail behind it sits on
 * that peer alone. */
function clearServedEvidence(reason: string): void {
  if (servedEvidence.size === 0 && servedPending.size === 0) {
    return;
  }
  // BOTH slots. A banked occurrence is a promise of one more dial on a
  // failure that is no longer coming — leave it standing and the next
  // failure on that address would promote proof from a window the radio
  // has already answered.
  servedEvidence.clear();
  servedPending.clear();
  mlog(`served-evidence clear reason=${reason}`);
}

/**
 * THE CLEAN WORLD one epoch hands to the next — every piece of module
 * state this file owns, cleared here or justified BY NAME below. Called by
 * BOTH ends of the lifecycle, because "start resets the evidence maps but
 * not the queue, stop clears the queue but not the evidence maps" is
 * exactly how a stopped session's leftovers reached a live one.
 *
 * CLEARED (session-scoped, every one of them keyed to addresses or claims
 * that die with the radio session that learned them):
 *   queue                                   — the dial queue, and with it
 *                                             every entry's promoted /
 *                                             nudged / check marker: the
 *                                             markers ARE the entries now
 *   liveCheck                               — the manual check's batch. Its
 *                                             own awaiter is woken by the
 *                                             epoch bump, which is what
 *                                             makes dropping this safe.
 *   digestRevision, digestInstalled,
 *     digestWithdrawnAt                     — the served offer's scope: a
 *                                             new session has published
 *                                             nothing until it does, and
 *                                             until then it serves nothing
 *   servedPrioritySpent, classPrioritySpent — the fairness credits
 *   servedEvidence, servedPending,
 *     servedEvidenceGen                     — the served-evidence slots
 *   servedOnly, servedDialFails,
 *     servedDialRestUntil                   — the served-route breaker
 *   lastSeen, lastSynced, seenGap, seenVia  — the address books
 *   digestSig, idleRuns, offeredSame        — the idle back-off
 *   drainPromise                            — what a waiting caller awaits
 *   lastSyncOkAt                            — this session's outcome
 *   foreground                              — re-derived from AppState at
 *                                             start; a stopped pod has no
 *                                             posture to keep
 *
 * DELIBERATELY NOT CLEARED, each for its own reason:
 *   drainEpoch    — an ownership STAMP, and its meaning is already
 *                   epoch-relative: every read of it is a comparison
 *                   against the CURRENT epoch, so a stale stamp answers
 *                   "nobody owns this session's worker" without being
 *                   cleared. Clearing it here would hide the inheritance
 *                   the stamp exists to refuse — a new start would find a
 *                   null flag and launch for that reason rather than
 *                   because the old drain's claim is no longer current.
 *   nativeOp,
 *     nativeOpTicket— the RADIO's, not the session's. A stop cannot cancel a
 *                   native op already in flight, and the Android module's
 *                   stopAll neither clears nor cancels its syncBusy latch,
 *                   so the hardware is still busy after the session that
 *                   made it busy is gone. Clearing the slot here is exactly
 *                   the bug: the replacement session would dial into that
 *                   latch, be answered 'busy', and pay a cooldown, a
 *                   fairness turn and a spent claim for a dead session's
 *                   leftover. The ticket counter goes with it — a reset
 *                   counter could mint a ticket a live slot already holds.
 *   airtimeHeld   — the WALKIE owns it, not the mesh. Backgrounding with
 *                   the walkie open stops and starts this file underneath
 *                   an open gesture, and a hold that forgot itself there
 *                   would restore the fast clock under a live walkie
 *                   scan. Its own doc and the (d) leak arm own this.
 *   meshEpoch     — the identity that survives the reset is what makes the
 *                   reset meaningful; the lifecycle verbs bump it.
 *   codesFn       — lifecycle-shaped, not world-shaped: start installs the
 *                   new session's getter AFTER this runs, stop nulls it.
 *   unsubs,
 *     appStateSub — live subscriptions; start attaches, stop detaches.
 *   meshRev,
 *     meshWatchers— the SURFACES' state, owned by whoever subscribed. A
 *                   React screen does not unmount because the radio did.
 */
function resetMeshWorld(): void {
  queue.length = 0;
  liveCheck = null;
  digestRevision = 0;
  digestInstalled = 0;
  digestWithdrawnAt = 0;
  republishOutstanding = 0;
  republishTarget = 0;
  servedPrioritySpent.clear();
  classPrioritySpent = false;
  servedEvidence = new Map();
  servedPending = new Map();
  servedEvidenceGen = 0;
  servedOnly = new Set();
  servedDialFails = 0;
  servedDialRestUntil = 0;
  lastSeen = new Map();
  lastSynced = new Map();
  seenGap = new Map();
  seenVia = new Map();
  digestSig = new Map();
  idleRuns = new Map();
  offeredSame = new Map();
  // The in-flight drain's PROMISE, but not its ownership stamp: see
  // drainEpoch in the justified list below.
  drainPromise = Promise.resolve();
  lastSyncOkAt = null;
  foreground = false;
  adapterUp = null;
}

function setPosture(fg: boolean): void {
  if (foreground === fg) {
    return;
  }
  foreground = fg;
  mlog(`posture ${fg ? 'foreground' : 'background'}`);
  if (running) {
    // The scan duty cycle follows the posture; the reverse arc (frugal on
    // background) is the half that keeps this honest at BRC.
    setScanPosture(fg).catch(() => {});
  }
  notifyMeshChanged();
}

/**
 * Try the radio NOW for everyone plausibly in range — the level trigger.
 * Three callers: a local compose (the sender's phone), a CrewSyncServed
 * event (a peer just pulled from us — pull back and their news is ours,
 * which is also how the SENDER's compose reaches the RECEIVER within
 * seconds: sender dials, receiver hears the served event, receiver dials
 * back and collects), and the manual check. Bypasses the cooldown, keeps
 * the freshness gate, and NUDGE_MIN_GAP_MS keeps it from ever dialling in
 * tight circles.
 */
function nudgeSync(reason: string): void {
  if (!running || !codesFn) {
    return;
  }
  if (airtimeHeld) {
    // The walkie is open and needs the radio to LISTEN. These are the
    // AUTOMATIC nudges (a compose, a peer's pull) — the manual check is a
    // separate path and is never held, because that one is the human
    // asking. Skipped, not queued for later: a nudge is a level trigger on
    // "someone is on the air right now", and replaying a stale one when
    // the walkie closes would dial an address that has since rotated.
    mlog('nudge skipped reason=walkie-airtime');
    return;
  }
  const now = Date.now();
  let queued = 0;
  for (const [addr, seen] of lastSeen) {
    if (now - seen > NUDGE_FRESH_WINDOW_MS || !addressFresh(addr, now)) {
      continue;
    }
    if (now - (lastSynced.get(addr) ?? 0) < NUDGE_MIN_GAP_MS) {
      continue;
    }
    queueDial(addr, { nudged: true });
    queued += 1;
  }
  mlog(`nudge reason=${reason} queued=${queued}`);
  if (queued > 0) {
    kickDrain(`nudge-${reason}`);
  }
}

/**
 * Put this address in the queue, or bring an existing entry up to date.
 *
 * ONE ADDRESS, ONE ENTRY, and the flags are a UNION rather than an
 * overwrite: an ambient sighting that lands on top of a nudged entry must
 * not take that entry's bypass away, and a check that adopts an ambient
 * entry does not make the ambient dial disappear — it becomes the same dial,
 * accounted to the human who asked for it.
 */
function queueDial(
  addr: string,
  flags: { nudged?: boolean; check?: number },
): QueuedDial {
  const at = queuedAt(addr);
  if (at >= 0) {
    const entry = queue[at];
    entry.nudged = entry.nudged || flags.nudged === true;
    if (flags.check !== undefined && flags.check !== 0) {
      entry.check = flags.check;
    }
    return entry;
  }
  const entry: QueuedDial = {
    addr,
    promoted: false,
    nudged: flags.nudged === true,
    check: flags.check ?? 0,
  };
  queue.push(entry);
  return entry;
}

/** Every map is keyed by an address, pruned by the same rule. */
function forgetOldAddresses(now: number): void {
  for (const [addr, at] of lastSeen) {
    if (now - at > ADDRESS_FORGET_MS) {
      forgetAddress(addr);
    }
  }
  // Spent claims outlive their addresses on purpose — that is what refuses
  // the identical re-arrival — so they need the same horizon, or a phone
  // left sharing for a week grows one per rotated name.
  for (const [addr, ev] of servedEvidence) {
    if (now - ev.at > ADDRESS_FORGET_MS) {
      servedEvidence.delete(addr);
    }
  }
  for (const [addr, occ] of servedPending) {
    if (now - occ.at > ADDRESS_FORGET_MS) {
      servedPending.delete(addr);
    }
  }
}

/**
 * Is this address still plausibly on the air, judged by its own rhythm?
 *
 * ONLY 'adv'-SIGHTED NAMES ARE EVER CONDEMNED. The gate's evidence is
 * "this address stopped being heard", and that is only meaningful when
 * the hearing could not have been our own fault. An inline-advertisement
 * sighting rides the scan path, which keeps delivering while the sync
 * worker holds connections — so silence from an 'adv' name really is the
 * name leaving the air (measured: rotation kills one every ~11s). A
 * GATT-read sighting is produced by the very radio the queue occupies:
 * one queued item is up to TWO native calls at 60s timeout each (review,
 * round 4 — the single-call bound the previous constant assumed was
 * false), so a live iPhone can go unsighted for minutes because WE were
 * busy, and no allowance constant can separate that from absence. Those
 * names are not freshness-dropped at all; their bound is the address
 * forget horizon, and a rare truly-departed one costs one bounded
 * timeout — the pre-gate world's price, paid only on the platform where
 * it is rare. This replaces a widening series of allowance constants
 * (45s, then 75s, then the next dispute) with the reason the number
 * could never be right.
 */
function addressFresh(addr: string, now: number): boolean {
  if (seenVia.get(addr) !== 'adv') {
    return true;
  }
  const seen = lastSeen.get(addr) ?? 0;
  const gap = seenGap.get(addr);
  const allowance =
    gap === undefined
      ? FRESH_SINGLE_ADV_MS
      : Math.min(
          Math.max(gap * FRESH_GAP_MULTIPLE, FRESH_FLOOR_MS),
          FRESH_CEILING_MS,
        );
  return now - seen <= allowance;
}

function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) {
      i++;
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * THE WANT WIRE, AND ITS FIRST TWENTY BYTES (row 120).
 *
 * The payload this hands the native client is written verbatim into the
 * WANT characteristic, so putting the offer identity on the front of it IS
 * putting the identity on the wire — the server strips these twenty bytes
 * before the ids reach its own JS, and matches them against the offer it
 * publishes at that moment.
 *
 * [epoch: 8 big-endian][rev: 8 big-endian][generation: 4 big-endian], the
 * same block CrewBeacon.swift's `offerIdentityBlock` and
 * CrewBeaconModule.kt's twin write onto every non-empty digest frame.
 *
 * A NULL OFFER WRITES ZEROS, DELIBERATELY. It means "this ask names no
 * offer", which is exactly what a link that could not learn one should say;
 * the server refuses it rather than attributing the ask to whatever it
 * happens to publish. Guessing here — stamping the ids with the last thing
 * this file saw — is the class of defect this whole change removes.
 */
const OFFER_IDENTITY_BYTES = 20;

function putBE32(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

function putBE64(out: Uint8Array, at: number, v: number): void {
  // Counters, not timestamps: exact well inside 2^53, and the split is the
  // only honest way to put one on an eight-byte wire from Hermes.
  putBE32(out, at, Math.floor(v / 4294967296));
  putBE32(out, at + 4, v >>> 0);
}

function wantToB64(ids: string[], offer: OfferIdentity | null): string {
  const body = utf8Bytes(JSON.stringify(ids));
  const out = new Uint8Array(OFFER_IDENTITY_BYTES + body.length);
  putBE64(out, 0, offer?.epoch ?? 0);
  putBE64(out, 8, offer?.rev ?? 0);
  putBE32(out, 16, offer?.generation ?? 0);
  out.set(body, OFFER_IDENTITY_BYTES);
  return bytesToB64(out);
}

function bytesToUtf8(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      s += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
      i += 2;
    } else if (b < 0xf0) {
      s += String.fromCharCode(
        ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63),
      );
      i += 3;
    } else {
      const cp =
        ((b & 7) << 18) |
        ((bytes[i + 1] & 63) << 12) |
        ((bytes[i + 2] & 63) << 6) |
        (bytes[i + 3] & 63);
      s += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return s;
}

/**
 * The CrewSyncLink over the native two-pass op, for one peer.
 *
 * `isCurrent` is the DIAL's epoch predicate, threaded down here because
 * this is where the pipeline's first post-await shared write lives — the
 * conductor above it cannot guard a stamp that happens inside the
 * transport it awaits.
 */
function linkFor(peerId: string, isCurrent: () => boolean): CrewSyncLink {
  // THE OFFER THE FIRST PASS READ, held for this link's lifetime — which is
  // one exchange with one peer (row 120). The conductor reads it on the line
  // after fetchDigest resolves and hands it back on the want, so what the
  // ask names is the offer the ids were derived from and never the one the
  // second pass happens to re-read.
  let offer: OfferIdentity | null = null;
  return {
    offerRead(): OfferIdentity | null {
      return offer;
    },
    async fetchDigest(): Promise<Uint8Array> {
      const r = await native.syncWithPeer(peerId, '');
      const bytes = b64ToBytes(r.digest ?? '');
      // BOTH SERVERS PUT IT ON EVERY NON-EMPTY DIGEST FRAME and both clients
      // hand it up here. A module that cannot answer leaves this null, and
      // the ask says so rather than inventing one.
      offer =
        typeof r.offerEpoch === 'number' &&
        typeof r.offerRev === 'number' &&
        typeof r.offerGeneration === 'number'
          ? {
              epoch: r.offerEpoch,
              rev: r.offerRev,
              generation: r.offerGeneration,
            }
          : null;
      if (offer === null) {
        mlog(`digest-read ${peerId} offer=none`);
      }
      if (!isCurrent()) {
        // THE SESSION ENDED WHILE THE RADIO WAS OUT. Everything below this
        // line writes the observations of a dead session into the LIVE
        // one's address book and idle-clock maps — a stamp saying a name
        // was heard just now, in a session that never heard it. Hand the
        // bytes back unstamped and let the conductor's own guard turn this
        // exchange into a cancelled outcome, before the want list is even
        // computed.
        return bytes;
      }
      // A completed digest exchange is BETTER evidence than any sighting:
      // this address answered a connection just now. Stamp it, so the
      // freshness check before pass 2 cannot condemn a peer for the crime
      // of serving us — an iOS peripheral may pause discovery entirely
      // while it holds our connection, which starves the sighting path at
      // exactly the moment the address is provably alive.
      lastSeen.set(peerId, Date.now());
      // "Is this the same offer as last time?" — answered HERE because
      // this is the only place the digest bytes exist, and read once by
      // the drain that owns this exchange.
      const sig = digestSigOf(bytes);
      offeredSame.set(peerId, digestSig.get(peerId) === sig);
      digestSig.set(peerId, sig);
      return bytes;
    },
    async fetchMessages(
      wantIds: string[],
      carried?: OfferIdentity | null,
    ): Promise<Uint8Array> {
      // The SECOND dial of the two-pass sync, and the same adaptive
      // freshness rule as the queue's: between the digest pass and this
      // one sits a JS round-trip, and an address that rotated inside that
      // gap fails at the connect TIMEOUT, not fast. Better to throw now —
      // the failure path forgives the want stamps and the next sighting of
      // this phone, under its new name, carries the same digest. Judged by
      // the address's OWN cadence, so an iOS peer — whose sightings are
      // 30-second GATT reads, and whose discovery may pause entirely while
      // it serves this very connection — is not aborted mid-sync by a
      // clock tuned to Android's chatter.
      if (!addressFresh(peerId, Date.now())) {
        throw new Error('peer address left the air between sync passes');
      }
      // THE IDENTITY THE CONDUCTOR HELD BESIDE THESE IDS. It comes down as
      // an argument rather than being re-read from this closure so that the
      // thing on the wire is provably the thing the ids were derived from —
      // syncLink took it on the line after the digest bytes arrived.
      const r = await native.syncWithPeer(
        peerId,
        wantToB64(wantIds, carried ?? null),
      );
      return b64ToBytes(r.messages ?? '');
    },
  };
}

/**
 * A DIAL WHOSE SESSION ENDED UNDERNEATH IT — the stale-completion
 * contract, and it is deliberately almost empty.
 *
 * What a completion normally does is all SHARED: queue and nudge markers,
 * the promoted class, the fairness credits, the evidence slots, the
 * strikes and the rest window, lastSynced, the idle clocks. Every one of
 * those now belongs to a session this dial never ran in, so a stale
 * completion touches NONE of them — not to tidy up, not to release its own
 * claim, not even to clear the offeredSame scratch (the link's own writes
 * are guarded at the source, so there is nothing of this dial's in the
 * live maps to clear).
 *
 * The only teardown this layer owns is the native op that has just
 * settled, and native owns the GATT connection end to end: this file keeps
 * no per-dial handle, so "local cleanup" here is one honest log line. The
 * caller must also NOT re-enter the drain loop after calling this.
 */
function staleDialCompletion(peerId: string, phase: string): void {
  mlog(`drop ${peerId} reason=stale-epoch phase=${phase}`);
}

// -------------------------------------------------------- the manual check
//
// THE HUMAN'S TAP OWNS A BATCH, NOT THE WORKER (the architecture round,
// 2026-08-27).
//
// "Check for pod updates" used to queue every fresh address, await the
// GLOBAL drain, and then subtract two SESSION-wide counters across that
// await. Three different things were wrong with reading the world instead
// of its own work: the count could include mail an ambient dial moved (or,
// across a restart, go negative), `inRange` was a tally of an address book
// that could be thrown away underneath it, and the gesture's answer was
// whatever the shared worker happened to have done by the time it returned.
//
// So a check FREEZES what it is about — the crew scope it was tapped under
// and the routes that were in range at the tap — marks the queue entries it
// owns, and accounts only for those. It finishes when its own routes are
// answered, whatever else the worker does before or after.

type CheckRun = {
  id: number;
  /** The mesh session this check belongs to. Anything it reports after this
   * stops being current is a measurement of a pod that no longer exists. */
  epoch: number;
  /** THE FROZEN SCOPE: the crew codes at the tap. A check is a question
   * about THIS pod, and the codes can move underneath it. */
  codes: string[];
  /** THE FROZEN ROUTES: every address the freshness gate believed in at the
   * tap. `inRange` is this list's length and nothing else. */
  routes: string[];
  /** The routes this check actually queued and is still owed an answer
   * about. Empties as entries are dialled, failed or dropped at a gate. */
  pending: Set<string>;
  /** Messages accepted BY THIS CHECK'S OWN DIALS. */
  accepted: number;
  /** Resolves when `pending` empties. */
  settle: (() => void) | null;
};

let checkSeq = 0;
let liveCheck: CheckRun | null = null;

/** This queue entry has been answered — dialled, failed, or dropped at a
 * gate — so the check that owns it (if any) is one route closer to done. */
function noteCheckDone(entry: QueuedDial, accepted: number): void {
  const run = liveCheck;
  if (run === null || entry.check !== run.id) {
    return;
  }
  if (!run.pending.delete(entry.addr)) {
    return;
  }
  run.accepted += accepted;
  if (run.pending.size === 0 && run.settle !== null) {
    const done = run.settle;
    run.settle = null;
    done();
  }
}

/**
 * WHICH ENTRY THIS TURN TAKES, or -1 for "park".
 *
 * THE HOLD IS DECIDED HERE AND NOWHERE ELSE, and that is the whole shape.
 * The rule started life as two gates — one refusing to enter the drain, one
 * refusing to pick an entry — and each mutation of one was MASKED by the
 * other, so neither was individually load-bearing and neither had an arm
 * that could die (found by planting it, which is what plants are for). Two
 * guards for one rule are not redundancy; they are a rule nothing pins.
 *
 * Ordinarily the head, exactly as a queue means. Under the airtime hold the
 * only dials that may go out are the manual check's own frozen routes, so a
 * borrowing drain walks past everything else — leaving it in the queue,
 * unspent and in order — and an ambient drain parks outright.
 */
function pickNext(borrow: boolean): number {
  if (!airtimeHeld) {
    return queue.length > 0 ? 0 : -1;
  }
  const run = borrow ? liveCheck : null;
  if (run === null) {
    return -1;
  }
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].check === run.id) {
      return i;
    }
  }
  return -1;
}

/**
 * Re-enter the worker, from whatever just made re-entering worth doing.
 *
 * ONE ENTRY POINT, because the borrow is a property of the WORK and not of
 * the caller: an arbiter release, a fresh sighting and a served pull all
 * mean the same thing here — "there may be something dialable now" — and
 * which of the queue's entries are dialable is decided by the hold and by
 * whether a check owns them, in pickNext. A release that re-entered as an
 * ambient drain would park with the human's own routes sitting in the
 * queue.
 */
function kickDrain(why: string): void {
  if (!running || !codesFn) {
    return;
  }
  // NO SECOND OPINION ABOUT THE HOLD HERE. Whether a dial may go out is
  // pickNext's question, and asking it twice is how the rule ended up with
  // no arm that could kill either half. A held drain enters, picks nothing
  // and parks — which costs one loop turn and says so once.
  const borrow = liveCheck !== null && liveCheck.pending.size > 0;
  void drainQueue(codesFn, borrow, why);
}

/** One-at-a-time sync worker: the native side rejects concurrent syncs
 * ('busy'), and one radio serves one connection well anyway. Returns the
 * in-flight drain when one exists, so a caller that queued more work can
 * await the loop that will reach it.
 *
 * `crewCodes` is the CAPTURE, and the discrimination is by capture and
 * never by re-reading: a drain launched in one session carries that
 * session's getter for its whole life, so even the paths below that could
 * only run stale cannot reach a NEW epoch's codes. */
function drainQueue(
  crewCodes: () => string[],
  borrow = false,
  why = 'direct',
): Promise<void> {
  // THE EPOCH THIS DRAIN BELONGS TO, captured at entry. Ownership of the
  // single-flight worker is per-epoch: a drain of THIS epoch already
  // running is the one to await, and an OLD epoch's drain still holding an
  // unresolved native op is not — the new session launches its own.
  const epoch = meshEpoch;
  const isCurrent = (): boolean => running && meshEpoch === epoch;
  if (drainEpoch === epoch) {
    return drainPromise;
  }
  drainEpoch = epoch;
  drainPromise = (async () => {
    try {
      while (queue.length > 0 && isCurrent()) {
        // THE RADIO BEFORE THE QUEUE. A drain of a NEW epoch may launch
        // while a DEAD epoch's native op is still out (that is the whole
        // point of the epoch-scoped ownership above), and dialling into
        // that is a call native answers 'busy' — charged to this session as
        // a cooldown, a fairness turn and a spent claim.
        //
        // SO IT DEFERS, AND DOES NOT WAIT. Parking here on the outstanding
        // op's settlement is what turned a busy radio into head-of-line
        // blocking of up to the native timeout, with no terminal at all for
        // a promise that never settles. The queue is left exactly as it is
        // — nothing dropped, nothing charged — and the arbiter's own
        // release re-enters this loop the moment the hardware is free.
        if (radioBusy(`drain epoch=${epoch}`)) {
          mlog(
            `defer reason=radio-busy epoch=${epoch} by=${why} ` +
              `queued=${queue.length}`,
          );
          return;
        }
        // THE AIRTIME HOLD IS A SCHEDULER STATE, not a clock (the
        // architecture round, 2026-08-27). While the walkie holds the
        // radio to LISTEN, this worker parks: the operation already in
        // flight finishes, and then nothing ambient, queued or sighted goes
        // out at all. Evidence keeps being recorded — sightings still stamp
        // the address book, a peer's pull still claims its priority slot —
        // so the moment the hold clears the queue is the truth rather than
        // a reconstruction. The MANUAL CHECK is the one explicit borrow,
        // and it borrows only for the routes it owns (see pickNext).
        const at = pickNext(borrow);
        if (at < 0) {
          // ONCE PER HOLD, not once per sighting: this is the sync-cadence
          // log (15 s+), and a park re-stated on every scan result at 1-2 s
          // would bury the decisions around it.
          if (!parkLogged) {
            parkLogged = true;
            mlog(
              `park reason=walkie-airtime epoch=${epoch} by=${why} ` +
                `queued=${queue.length}`,
            );
          }
          return;
        }
        const entry = queue.splice(at, 1)[0];
        const peerId = entry.addr;
        const promoted = entry.promoted;
        const wasNudged = entry.nudged;
        // Checked HERE, not at queue time: the wait for the radio is
        // exactly where an address dies. A name that was live when it was
        // queued can be gone by the time the connection ahead of it in
        // this loop finishes, and dialling it costs the whole connect
        // timeout. A drop is cheap to be wrong about — no cooldown was
        // spent, so the very next sighting of this phone re-queues it
        // under its current name.
        const now = Date.now();
        if (!addressFresh(peerId, now)) {
          // No dial happened, so no evidence was consumed: the claim goes
          // back, and this peer's next pull — under whatever name it is
          // wearing then — is fresh proof all over again.
          releaseServedEvidence(peerId, 'stale-address');
          noteCheckDone(entry, 0);
          mlog(`drop ${peerId} reason=stale-address`);
          continue;
        }
        // The cooldown starts when a sync actually STARTS. Re-checked here
        // (not only at queue time) because a sighting can re-queue an
        // address while its own sync is still in flight ahead of it. A
        // nudged dial bypasses the cooldown — that is a nudge's whole
        // point — but never the NUDGE_MIN_GAP_MS floor.
        const last = lastSynced.get(peerId) ?? 0;
        const gate = wasNudged ? NUDGE_MIN_GAP_MS : sightingGateMs(peerId);
        if (now - last < gate) {
          // Caught up seconds ago: an honest no-op, and again no attempt,
          // so again nothing consumed.
          releaseServedEvidence(peerId, 'inside-gate');
          noteCheckDone(entry, 0);
          continue;
        }
        // The served-only path rests after striking out — see
        // SERVED_DIAL_STRIKES. Checked at the dial, not at the stamp, so
        // the address stays known (the manual check still counts it in
        // range) while only the automatic dialling pauses.
        const onlyServed = servedOnly.has(peerId);
        let evidence: { gen: number; at: number; spent: boolean } | undefined;
        if (onlyServed && now < servedDialRestUntil) {
          // FRESH PROOF OUTRANKS THE REST WINDOW, for this one dial. The
          // breaker's subject is repeated retries on the same or staler
          // evidence, and it still owns every one of them: a claim already
          // spent, or no claim at all, is dropped here exactly as it always
          // was.
          evidence = servedEvidence.get(peerId);
          if (evidence === undefined || evidence.spent) {
            noteCheckDone(entry, 0);
            mlog(`drop ${peerId} reason=served-dial-resting`);
            continue;
          }
        }
        // THE CLASS GATE AT THE TURN, and it is here because the placement
        // gate alone cannot reach an entry that was placed BEFORE the class
        // owed anything. Two storming addresses both take a front while the
        // credit is in hand; the first one's turn spends it; and the second
        // is already sitting ahead of an ordinary peer with no placement
        // left to run. So a promotion about to take a consecutive turn
        // gives it up instead: the entries go back in behind the first
        // ordinary waiter, carrying their nudges, and nothing is consumed —
        // no cooldown stamped, no evidence spent, no turn taken.
        //
        // THE WHOLE PROMOTED PREFIX MOVES, IN ONE OPERATION, and that is
        // the cross-family finding against the one-head splice this
        // replaces (review, 2026-08-27). Yielding one head at a time
        // REVERSES the promoted run and can cycle a subset of it forever:
        // with a spent class and [P1,P2,C] the splices give [P2,C,P1] and
        // then [C,P2,P1], so the promoted class serves P2 twice before P1
        // once — under three storm addresses plus an ordinary peer that is
        // D,A,D,A while B waits behind them for good. The ordinary class
        // was protected the whole time; the served class starved itself,
        // and the FIFO occurrence order the queue carried was corrupted by
        // the yield rather than by any placement.
        //
        // So the prefix is identified whole — this entry plus every
        // promoted entry contiguously ahead of the first ordinary waiter —
        // and rotated behind that one waiter in a single splice, internal
        // order untouched. Each entry keeps its place relative to the
        // others; only the ordinary peer overtakes them, which is the
        // entire debt the class rule charges.
        //
        // It terminates: every rotation is followed immediately by shifting
        // that ordinary waiter, which either takes a turn (and hands the
        // class credit back) or is dropped at a gate (and leaves the
        // queue). Neither adds an entry, so the rotations on one drain are
        // bounded by the ordinary waiters already in it.
        if (promoted && classPrioritySpent) {
          const ordinary = firstOrdinaryWaiter();
          if (ordinary >= 0) {
            const behind = queue[ordinary].addr;
            // THE ENTRIES GO BACK, not their names. Every marker this dial
            // would have spent — the nudge bypass, the promoted class, the
            // check that owns it — rides the entry object itself, so a
            // yield cannot lose one by forgetting to re-add it.
            const prefix = [entry, ...queue.splice(0, ordinary)];
            // The ordinary waiter is at the head now, so the prefix goes
            // back directly behind it, in the order it was already in.
            queue.splice(1, 0, ...prefix);
            for (let i = 0; i < prefix.length; i++) {
              mlog(
                `served-class-yield ${prefix[i].addr} pos=${
                  i + 1
                } behind=${behind}`,
              );
            }
            continue;
          }
        }
        // The fairness epoch turns over on the TURN and not on the
        // outcome: whoever dials after this one has already waited behind
        // it, and this address has now had its go. The CLASS epoch turns
        // over on the same event and on the class of the turn alone: a
        // promoted turn spends the class credit, an ordinary one hands it
        // back. Which address took it is deliberately not consulted —
        // that read is what let two storms alternate over a waiting peer.
        classPrioritySpent = promoted;
        noteFairnessTurn(peerId);
        lastSynced.set(peerId, now);
        mlog(
          `dial ${peerId} via=${wasNudged ? 'nudge' : 'sighting'}` +
            (onlyServed ? ' known=served' : '') +
            (evidence ? ` evidence=${evidence.gen}` : '') +
            ` turn=${promoted ? 'promoted' : 'ordinary'}`,
        );
        // THIS DIAL'S OWN CAPTURE, taken before the await rather than read
        // after it. It equals the drain's by construction — the loop cannot
        // span a lifecycle event without the guard above catching it — and
        // it is taken separately anyway so the guards below read as what
        // they are: this dial's epoch, never an ambient one.
        const dialEpoch = meshEpoch;
        const dialIsCurrent = (): boolean => running && meshEpoch === dialEpoch;
        try {
          // Union-typed defensively: the conductor contract returns a
          // count, but this layer must not NaN its telemetry over a
          // harness stub.
          //
          // THE PREDICATE GOES DOWN THE PIPELINE, because a guard on this
          // side alone is necessary and not sufficient: syncLink runs its
          // second pass, stamps its want ledger and performs the
          // authoritative message ingest BEFORE its promise returns, so a
          // session that ended mid-exchange would still import a dead
          // session's mail into the live pod's store. syncLink checks this
          // before each of those and answers with a cancelled outcome
          // instead.
          //
          // CHAINED THROUGH THE ARBITER, so this dial IS the radio's
          // outstanding op for as long as it runs — the two native passes
          // and the JS round-trip between them. A drain of any later epoch
          // waits on the ticket minted here before it dials at all.
          const r: SyncOutcome | undefined = await holdRadio(
            linkSync(
              linkFor(peerId, dialIsCurrent),
              crewCodes(),
              epochMinutes(Date.now()),
              dialIsCurrent,
            ),
          );
          if (!dialIsCurrent() || r?.cancelled) {
            // The pod stopped — or stopped and started again — while this
            // op was on the radio. Nothing below this line is ours to write
            // any more, and the drain must not step to the next entry
            // either: that queue belongs to another session.
            staleDialCompletion(peerId, 'dial-ok');
            return;
          }
          const accepted = r ? r.accepted : 0;
          // The count goes to the CHECK that queued this entry, if one did,
          // and nowhere else. The human's tap accounts for the routes it
          // froze at the tap and for nothing more: reading a session-wide
          // counter across an await is what let another peer's mail be
          // reported as the answer to a gesture — and, across a restart, a
          // negative number of messages.
          noteCheckDone(entry, accepted);
          lastSyncOkAt = Date.now();
          // A dial that COMPLETED proves the served-address path works,
          // whichever address it was: the strikes are about reachability,
          // and this is reachability answered.
          servedDialFails = 0;
          servedDialRestUntil = 0;
          // The breaker is open again, so the ordinary paths own every
          // address once more and the debt is paid outright.
          clearServedEvidence('dial-ok');
          // Same offer as last time and nothing moved: stretch this peer's
          // sighting clock one step. Anything else puts it back to base.
          const same = offeredSame.get(peerId) === true;
          offeredSame.delete(peerId);
          if (accepted > 0 || !same) {
            idleRuns.delete(peerId);
          } else {
            idleRuns.set(
              peerId,
              Math.min((idleRuns.get(peerId) ?? 0) + 1, IDLE_BACKOFF_MAX_STEPS),
            );
          }
          const idle = idleRuns.get(peerId) ?? 0;
          mlog(
            `dial-ok ${peerId} accepted=${accepted}` +
              (idle > 0 ? ` idle=${idle} next=${sightingGateMs(peerId)}ms` : ''),
          );
          notifyMeshChanged();
        } catch (e) {
          if (!dialIsCurrent()) {
            // THE FAILURE HALF, and the one the amplification made
            // expensive: spend, forget, strike and PROMOTE all write into
            // whatever session is live now — an old failure promoting a
            // banked occurrence is a dial the new pod never earned, or with
            // running=false a queue/nudge/promoted marker re-added to no
            // session at all.
            staleDialCompletion(peerId, 'dial-fail');
            return;
          }
          // A failed sync self-heals on the peer's next sighting; the
          // cooldown stamped at dial so we don't hammer a broken peer.
          offeredSame.delete(peerId);
          // The route this check owned has been answered — with a failure,
          // which is an answer. Counted before forgetAddress below, which
          // would otherwise settle it a second time through the entry it no
          // longer has.
          noteCheckDone(entry, 0);
          mlog(`dial-fail ${peerId} ${String((e as Error)?.message ?? e)}`);
          if (onlyServed) {
            // The attempt this proof earned has run and failed: spend it
            // BEFORE the name's bookkeeping goes, so the peer's identical
            // next pull is refused by the breaker instead of dialling the
            // same corpse again.
            spendServedEvidence(peerId);
            // A rotated central name is worth exactly ONE try: it will
            // never be sighted, so nothing else can ever retire it, and
            // the next pull hands us the current name anyway.
            forgetAddress(peerId);
            servedDialFails += 1;
            if (servedDialFails >= SERVED_DIAL_STRIKES) {
              servedDialRestUntil = Date.now() + SERVED_DIAL_REST_MS;
              servedDialFails = 0;
              mlog(`served-dials resting=${SERVED_DIAL_REST_MS}ms`);
            }
            // The current claim is spent, so the occurrence banked behind
            // it — a LATER pull, from a peer that was still connecting to
            // us while this dial was dying — takes the slot and earns its
            // own one attempt. Placed after the strike bookkeeping because
            // fresh proof outranks a rest window this very failure may
            // have just opened, exactly as it outranks an older one.
            //
            // Re-checked here rather than trusted from the top of the
            // catch: this is the single line that can hand a queue entry, a
            // nudge and a promoted marker to a session, and it is the last
            // thing this dial does. Nothing between the guard above and
            // here can await — the check is the same answer twice, and it
            // is cheap enough to state at the place that would do the
            // damage.
            if (dialIsCurrent()) {
              promoteServedEvidence(peerId);
            }
          }
        }
      }
      if (queue.length === 0 && isCurrent()) {
        // An idle worker owes nobody a turn, so every address starts its
        // next claim with a fresh priority credit. (The other exits from
        // this loop are a stopped pod and a superseded epoch, and the
        // lifecycle verbs clear it there.)
        //
        // THE CLASS'S CREDIT IS NOT RESET HERE, and the deletion is the
        // ruling on it: the idle class reset shipped with no plant because
        // no plant could exist. A worker only goes idle with an EMPTY
        // queue, and with an empty queue the class gate is already a no-op
        // — its floor is `classPrioritySpent && ordinary >= 0`, and there
        // is no ordinary waiter to defer to. So the reset decided nothing
        // any dial order could show, and an unobservable rule is one more
        // invariant to keep true for no stated reason. The ordinary dial
        // turn is the whole mechanism (`classPrioritySpent = promoted`),
        // and it is the one the arms in (k) actually pin.
        servedPrioritySpent.clear();
      }
    } finally {
      // ONLY THIS EPOCH'S OWNERSHIP. An old drain settling long after its
      // session ended must not hand the worker back on behalf of the live
      // one — that is the shared-flag inheritance from the other direction,
      // and it would leave the new session's drain unowned while its loop
      // is still running.
      if (drainEpoch === epoch) {
        drainEpoch = null;
      }
    }
  })();
  return drainPromise;
}

/**
 * THE SERVED DIGEST, PUBLISHED WITH ITS SCOPE — and not readable until the
 * native side says it landed (the architecture round, 2026-08-27).
 *
 * WHAT WAS WRONG WITH "fire and hope". The GATT server answers a digest read
 * the moment it is open, and an unset digest was served as a COMPLETE
 * one-frame stream with an empty body — which a peer reads as the honest
 * sentence "this phone carries nothing". So every window in which the server
 * is up and this publish has not landed is a window where a podmate is told
 * a lie and goes away satisfied, and the window is not theoretical: the
 * server opens with the advertiser, this call crosses the bridge, and a
 * background bounce re-opens the server before the first push of the new
 * session has resolved.
 *
 * AND A LATE PUBLISH IS WORSE THAN A MISSING ONE. This runs on every
 * message-store change, so several can be in flight at once, and one belongs
 * to a session that has already ended — a dead pod's offer installed over
 * the live pod's, served to everyone until the next store change happens to
 * come along.
 *
 * So a publish carries WHOSE it is and WHICH one it is: the mesh epoch, and
 * a revision that only ever moves forward inside that epoch. The native side
 * refuses anything that is not strictly newer than what it holds, and it
 * does not let a peer read the digest characteristic AT ALL until a publish
 * for the current session has been installed — the not-ready answer, which
 * the reading protocol already knows how to retry, instead of a confident
 * "nothing here". The ACK is this promise resolving; only then is the
 * revision recorded as installed, and only then does this file consider the
 * serving side in scope (see the want handler).
 *
 * The scoped call is OPTIONAL because it is newer than the iOS module (see
 * the handoff in the lane report): a module that only knows setSyncDigest
 * gets exactly the old behaviour, which is what it had yesterday.
 */
let digestRevision = 0;
/** The revision whose ACK came back, or 0 for "this session has published
 * nothing the server can serve". */
let digestInstalled = 0;

/**
 * Publish this session's current offer, and REPORT WHICH REVISION IT WAS.
 *
 * The return value is the revision this call MINTED, or 0 if it never got
 * that far. It exists because "the offer is republished" and "the offer is
 * SERVABLE" are different facts: the revision is minted here and installed
 * only when the native ack comes back (`digestInstalled`), and a recovery
 * that reports ready on the first fact is reporting a mailbox no peer can
 * read yet. A failed publish still returns its minted revision — that is
 * the number readiness must fail to reach.
 */
async function pushDigest(crewCodes: () => string[]): Promise<number> {
  const epoch = meshEpoch;
  let minted = 0;
  try {
    const bytes = serveDigest(crewCodes(), epochMinutes(Date.now()));
    if (!running || meshEpoch !== epoch) {
      // The session ended while this offer was being built. Publishing it
      // now would install a dead pod's mailbox as the live one's.
      mlog(`digest drop reason=stale-epoch epoch=${epoch}`);
      return 0;
    }
    digestRevision += 1;
    const rev = digestRevision;
    minted = rev;
    const b64 = bytesToB64(bytes);
    // Plain call behind a name probe, for iosMeshParity's reader — see
    // endNativeSession. The unscoped fallback below is the degrade for a
    // native binary older than this bundle, not a second supported shape.
    const scoped =
      'publishSyncDigest' in native
        ? native.publishSyncDigest(b64, epoch, rev)
        : undefined;
    if (scoped === undefined) {
      await native.setSyncDigest(b64);
    } else {
      await scoped;
    }
    if (!running || meshEpoch !== epoch) {
      // The ACK outlived the session it was published for: it says nothing
      // about what the live session is serving, so it installs nothing.
      mlog(`digest stale-ack epoch=${epoch} rev=${rev}`);
      return minted;
    }
    if (rev > digestInstalled) {
      digestInstalled = rev;
    }
    // THE ACK IS THE EVENT A RECOVERY IS WAITING FOR. Threaded here rather
    // than polled for; the barrier decides whether this particular ack is
    // the one it was minted for.
    notifyDigestReady();
    mlog(
      `digest published epoch=${epoch} rev=${rev} scoped=${
        scoped === undefined ? 0 : 1
      }`,
    );
    return rev;
  } catch {
    // Radio off / module absent / the native side refused a stale publish:
    // the next store change retries, and nothing here claims it landed —
    // and the minted revision goes back so readiness can SEE that it did
    // not land, rather than inferring it from silence.
    mlog(`digest failed epoch=${epoch}`);
    return minted;
  }
}

/**
 * THE REPUBLISH THE ADAPTER'S RETURN OWES, AND WHETHER IT LANDED.
 *
 * `republishOutstanding` counts adapter-on republishes in flight;
 * `republishTarget` is the highest revision one of them minted. Recovery is
 * ready when nothing is in flight AND the installed revision has caught up
 * to that target — which is to say when the native side has ACKED the offer
 * this session is serving now.
 *
 * WHY THIS EXISTS AT ALL. The bounce recovery used to be two independent
 * races: this file fired `pushDigest` from the radio-state listener and
 * forgot about it, while the session's own honesty machine cleared the
 * interruption as soon as the scan and the payload were back. Both are
 * true before any offer is installed, so the app said "recovered" over a
 * phone whose digest characteristic still answered the not-ready frame —
 * sharing reads as on, the pod's mailbox reads as empty, and nothing
 * anywhere is an error. Readiness has to be the ACK or it is a guess.
 */
let republishOutstanding = 0;
let republishTarget = 0;
/**
 * THE REVISION THE ADAPTER'S WITHDRAWAL LEFT BEHIND — the floor a servable
 * offer has to clear, and the discriminator that makes a readiness barrier
 * an IDENTITY rather than a race.
 *
 * Both native modules WITHDRAW this phone's digest on a power cycle
 * (Android's onAdapterOff closes the GATT server, iOS's poweredOff arcs
 * take the .radio retirement; both clear syncDigest and drop digestReady).
 * So every revision published before that moment is gone from the native
 * side, and its ack — which is still sitting in `digestInstalled` — proves
 * nothing about what a peer can read NOW. Recorded here at the instant the
 * withdrawal is heard, so a recovery minted afterwards can refuse the
 * pre-bounce ack by its NUMBER instead of by when it happened to arrive.
 */
let digestWithdrawnAt = 0;
/**
 * Who is waiting to hear that this session's offer is servable again.
 *
 * The alternative is a clock, and a clock is what the readiness rule
 * already refused once: polling `meshRepublishReady()` would report the
 * recovery at whatever granularity the poll ran, which is arrival order
 * wearing a predicate's clothes. Waiters are re-checked (never simply
 * resolved) on the three events that can move the answer: an ack landing,
 * a republish leaving flight, and the epoch moving under them all.
 */
const digestWaiters = new Set<() => void>();

/**
 * A REPUBLISH COMPLETION THAT OUTLIVED THE SESSION THAT MINTED IT.
 *
 * The same shape as `staleDialCompletion`, for the same reason: the work was
 * handed to something outside this file (there, the radio; here, the native
 * publish), the answer comes back a microtask or a second later, and by then
 * `startMeshSync` may have run a whole new pod through `resetMeshWorld`. A
 * completion is DISCARDED by identity — no counter moves, no revision is
 * recorded, nothing is notified — and it leaves a log line rather than a
 * mutation.
 */
function staleRepublishCompletion(
  phase: string,
  epoch: number,
  rev: number,
): void {
  mlog(
    `digest republish drop reason=stale-epoch phase=${phase} ` +
      `epoch=${epoch} rev=${rev} live=${meshEpoch}`,
  );
}

/** Re-check every waiter. Snapshotted, because a waiter that settles
 * removes itself from the set it is being walked out of. */
function notifyDigestReady(): void {
  if (digestWaiters.size === 0) {
    return;
  }
  for (const wake of [...digestWaiters]) {
    wake();
  }
}

/**
 * Is this phone's offer servable for the LIVE epoch right now?
 *
 * False while a republish is in flight, false while the revision it minted
 * has not been acked, and false before this session has installed anything
 * at all. It is the same gate the want handler already consults
 * (`digestInstalled === 0`), raised to cover the republish road.
 */
export function meshRepublishReady(): boolean {
  return (
    running &&
    republishOutstanding === 0 &&
    digestInstalled > 0 &&
    digestInstalled >= republishTarget
  );
}

/**
 * THE DIGEST LEG OF A RECOVERY TRANSACTION, handed to whoever owns the
 * recovery — session.ts, injected through share.ts. Calling this MINTS the
 * leg: it captures the mesh identity as of right now and returns the
 * promise that says whether THAT identity's offer became servable.
 *
 *   true  — the offer this session is serving has been acked at a revision
 *           newer than anything the adapter withdrew. A peer that dials us
 *           can read the mailbox, so a recovery may report success.
 *   false — SUPERSEDED: the session ended or was replaced under the
 *           transaction (the epoch moved). It says nothing about the live
 *           session, so it must not clear anybody's interruption.
 *
 * Never rejects, and never resolves late-and-true for a dead identity:
 * every settlement is decided by the captured epoch and the captured
 * withdrawal floor, never by which promise happened to come back first.
 *
 * NO MESH, NO WORK. A phone with no pod (mailbox presence never started,
 * the mesh stopped, a harness with none at all) has no digest to publish
 * and nothing to wait for, so the leg settles trivially — a recovery must
 * never hang on a leg that has no work, or a pod-less camper's radio comes
 * back and the session goes on saying it did not.
 */
export function awaitMeshDigestReady(): Promise<boolean> {
  if (!running) {
    return Promise.resolve(true);
  }
  const epoch = meshEpoch;
  // THE IDENTITY, CAPTURED AT THE MINT. `meshRepublishReady()` alone is the
  // live answer to "is anything installed", and at the instant a bounce is
  // heard that answer is still YES — about the offer the adapter just took
  // away. Requiring a revision strictly past the withdrawal is what makes a
  // pre-bounce ack unable to settle a post-bounce recovery.
  const floor = digestWithdrawnAt;
  const verdict = (): boolean | null => {
    if (!running || meshEpoch !== epoch) {
      return false; // superseded: a stopped or replaced session
    }
    if (meshRepublishReady() && digestInstalled > floor) {
      return true;
    }
    return null; // not yet — and silence is not an ack
  };
  const first = verdict();
  if (first !== null) {
    return Promise.resolve(first);
  }
  return new Promise<boolean>(resolve => {
    const wake = (): void => {
      const v = verdict();
      if (v === null) {
        return;
      }
      digestWaiters.delete(wake);
      resolve(v);
    };
    digestWaiters.add(wake);
  });
}

export function meshSyncRunning(): boolean {
  return running;
}

/**
 * Wire the mesh: called by share.ts when a sharing session starts (the
 * radio is up exactly then — scanning gives sightings, the GATT server
 * gives peers a mailbox to read).
 */
export function startMeshSync(crewCodes: () => string[]): void {
  if (running || !native) {
    return;
  }
  running = true;
  // A NEW EPOCH FIRST, before a single map is touched. Everything an old
  // drain is still holding is now stale by identity, so the clean world
  // below cannot be reached by it: an op still out on the radio settles
  // into a session number that is no longer current, and its own guards
  // turn it into a log line.
  bumpMeshEpoch('start');
  // THIS SESSION'S NUMBER, held by the listeners below. `running` is a
  // module global that the very next start re-arms, so a callback queued by
  // the session that ENDED reads it as true and walks straight into the
  // live session's world — with the dead pod's crew codes in its closure.
  // Every other road in this file already carries its epoch (pushDigest,
  // the drain, the manual check); the serving road did not, and that is the
  // JS half of the same-peer want/answer crossover.
  const sessionEpoch = meshEpoch;
  // The debt dies with the session that learned it, and it is re-newed
  // HERE with every other address map for the reason the whole design
  // turns on: a claim can only act through a queue entry, and a stopped
  // pod has no queue. Carry one across a background bounce and the first
  // peer to strike the new session's breaker out is refused the priority
  // dial it never spent. The queue, the nudges, the promoted markers and
  // both fairness credits go with them — a start that inherited half a
  // world is how a dead session's leftovers reached a live one.
  resetMeshWorld();
  codesFn = crewCodes;
  // Posture at start comes from the platform when it can say ('active' =
  // the app is on screen); a harness or headless start without AppState
  // stays on the frugal background clocks.
  const app: typeof AppState | undefined = AppState;
  foreground = app?.currentState === 'active';
  if (foreground) {
    setScanPosture(true).catch(() => {});
  }
  appStateSub =
    app?.addEventListener?.('change', st => setPosture(st === 'active')) ??
    null;
  mlog(`start posture=${foreground ? 'foreground' : 'background'}`);
  void pushDigest(crewCodes);
  unsubs = [
    // Every store change re-offers the new truth to anyone who asks.
    subscribeMessagesChanged(() => {
      // Our own store moved, so no peer's "nothing changed" verdict is
      // still trustworthy — every idle clock goes back to base.
      idleRuns.clear();
      void pushDigest(crewCodes);
    }),
    /**
     * THE ADAPTER CAME BACK, SO THE OFFER MUST COME BACK WITH IT (row 123,
     * blocker 1 — confirmed on both platforms).
     *
     * An adapter power cycle WITHDRAWS this phone's digest: Android's
     * `onAdapterOff` closes the GATT server, iOS's two `.poweredOff` arcs
     * take the `.radio` retirement, and both clear `syncDigest` and set
     * `digestReady` false. The recovery road then restarts the SCAN and
     * refreshes the payload — and stops there. `meshSync` never stopped
     * running, so `startMeshSync` does not fire again, and `pushDigest`
     * fires only at start and on a store revision. The result the review
     * traced: a phone that bounced its Bluetooth serves `total=0` to every
     * podmate INDEFINITELY, until somebody happens to write or receive a
     * message on it. The camper sees sharing on, the pod sees an empty
     * mailbox, and nothing anywhere is in an error state.
     *
     * So the return of the adapter is a publish. It is EDGE-triggered off
     * the state stream rather than fired on every event, because that stream
     * carries an event per advertise/scan transition and a republish per
     * tick is radio time nobody asked for.
     *
     * AND THE STRICTLY-NEWER RULE ADMITS IT BY CONSTRUCTION: `pushDigest`
     * increments `digestRevision` on every call, so this republish carries
     * (epoch, rev + 1) inside the SAME session — strictly newer than the
     * floor both natives deliberately kept through the retirement, which is
     * why they kept it. No epoch bump, no special readmission path, and the
     * ack sets `digestInstalled` exactly as the first publish did.
     */
    // THE PROBE IS FOR HARNESSES, NOT FOR PHONES, and it is bounded by an
    // arm so it can never hide a missing seam. Three sibling suites stub
    // this module with only the members meshSync used before this listener
    // existed, and a stub that throws on subscribe would take the whole
    // session down; a phone always has the stream, because radio.ts always
    // exports it. iosMeshParity pins BOTH facts — radio.ts's export and this
    // call site — so a production seam that went missing fails there rather
    // than degrading quietly here.
    typeof onRadioState === 'function'
      ? onRadioState(s => {
          if (!running || meshEpoch !== sessionEpoch) {
            return;
          }
          if (typeof s.adapterEnabled !== 'boolean') {
            return; // "unchanged", never "off" — the module could not say
          }
          const was = adapterUp;
          adapterUp = s.adapterEnabled;
          if (!s.adapterEnabled && was !== false) {
            // THE WITHDRAWAL, RECORDED AS A NUMBER. Native has just dropped
            // this phone's digest, so every revision up to here is unreadable
            // by any peer — and `digestInstalled` still names one of them.
            // A recovery minted after this point must clear this floor.
            digestWithdrawnAt = digestRevision;
            mlog(
              `digest withdrawn epoch=${sessionEpoch} floor=${digestWithdrawnAt}`,
            );
          }
          if (s.adapterEnabled && was === false) {
            mlog(`digest republish reason=adapter-on epoch=${sessionEpoch}`);
            // NOT FIRE AND FORGET. The republish is counted BEFORE it goes
            // out, so readiness is false from the instant the radio returns
            // rather than from whenever the promise happens to settle, and
            // the revision it minted becomes the target the ack has to
            // reach. A recovery that reported ready off the scan and the
            // payload alone was reporting an empty mailbox.
            republishOutstanding += 1;
            void pushDigest(crewCodes)
              .then(rev => {
                // THE COMPLETION CARRIES THE IDENTITY IT WAS MINTED UNDER.
                // `pushDigest` guards its own writes, and this handler is a
                // SECOND writer running one microtask later — on whatever
                // world exists by then.
                if (!running || meshEpoch !== sessionEpoch) {
                  staleRepublishCompletion('target', sessionEpoch, rev);
                  return;
                }
                if (rev > republishTarget) {
                  republishTarget = rev;
                }
                mlog(
                  `digest republish target epoch=${sessionEpoch} rev=${rev} ` +
                    `installed=${digestInstalled}`,
                );
              })
              .finally(() => {
                // THE SAME RULE ON THE LEAVING-FLIGHT HALF, and this is the
                // one that could not merely mislead. `resetMeshWorld` puts
                // the counter back to 0 for the session that replaced this
                // one, so a decrement out of a dead session takes the LIVE
                // world to -1 — and `meshRepublishReady` compares against 0
                // exactly, so the replacement pod never reports ready again
                // and every recovery leg minted in it waits forever.
                if (!running || meshEpoch !== sessionEpoch) {
                  staleRepublishCompletion('leave-flight', sessionEpoch, 0);
                  return;
                }
                if (republishOutstanding <= 0) {
                  // A CLAMP WITH A REASON, never a silent floor: the epoch
                  // guard above already makes this unreachable, so reaching
                  // it means an increment went missing and the log is the
                  // only thing that would ever say so.
                  mlog(
                    `digest republish underflow epoch=${sessionEpoch} ` +
                      `outstanding=${republishOutstanding}`,
                  );
                  republishOutstanding = 0;
                } else {
                  republishOutstanding -= 1;
                }
                // Readiness cannot turn true while a republish is in flight,
                // so the moment one leaves flight is the other moment a
                // waiting recovery has to be re-asked.
                notifyDigestReady();
              });
          }
        })
      : () => undefined,
    // A sighting is the moment a peer is REACHABLE: queue a sync.
    onSighting(({ peerId, via }) => {
      if (!running || !peerId) {
        return;
      }
      seenVia.set(peerId, via);
      const now = Date.now();
      // Stamped on EVERY sighting, including the ones the cooldown below
      // turns away: this is "when was this name last on the air", which is
      // a different question from "when did we last sync it", and the
      // freshness gate needs the honest answer to the first one. The gap
      // between consecutive stampings is the address's own heartbeat.
      const prev = lastSeen.get(peerId);
      if (prev !== undefined && now > prev) {
        seenGap.set(peerId, now - prev);
      }
      lastSeen.set(peerId, now);
      forgetOldAddresses(now);
      // The cooldown reads the DIAL stamp (set in drainQueue when a sync
      // actually starts), not a queue-time stamp. Stamping at queue time
      // charged the cooldown for syncs that never happened: an address
      // dropped as stale had still spent its 60 seconds, so a slow-cadence
      // peer could be refused here on the very sighting that proved it was
      // back on the air.
      // A real scan sighting retires the served-only label: this name is
      // now discoverable, so the strike machinery has no business with it.
      servedOnly.delete(peerId);
      const last = lastSynced.get(peerId) ?? 0;
      if (now - last < sightingGateMs(peerId)) {
        return;
      }
      // QUEUED EVEN UNDER THE HOLD, and that is the difference between
      // parking dials and forgetting peers: everything above this line is
      // EVIDENCE (the address book, the heartbeat, the served-only label),
      // and the entry below is the standing intent to dial it. The hold
      // decides whether the worker may act, in one place — kickDrain — so
      // the queue the walkie hands back is the truth rather than a
      // reconstruction from whatever happens to be sighted at the release.
      queueDial(peerId, {});
      kickDrain('sighting');
    }),
    // A local compose is the human acting NOW: dial whoever is on the air
    // instead of waiting out a cooldown built for idle gossip. Foreground
    // by construction (you cannot compose from the background), but gated
    // anyway so the battery posture has one rule, not one rule and one
    // coincidence.
    subscribeLocalCompose(() => {
      if (foreground) {
        nudgeSync('compose');
      }
    }),
    // Reciprocity: a peer that just pulled our digest is provably alive,
    // in range, and — if the pull followed their compose-nudge — carrying
    // news. Pull back now and their fresh message arrives in seconds
    // instead of at the next cooldown boundary. Foreground-only: in the
    // pocket the 60 s gossip clock is the battery-honest cadence.
    onSyncServed(({ peerId, dialable }) => {
      // THE ADDRESS WE USED TO THROW AWAY. On a platform whose server names
      // a central by something this phone can dial back (Android: a MAC, in
      // the same address space the scanner reports), a completed digest
      // pull is the strongest sighting there is — and for an iPhone holding
      // its beacon off the air for the walkie, it is the ONLY one. Stamped
      // via='gatt' so the adv freshness gate, which judges an advertiser's
      // silence, never gets to condemn a name that just connected to us.
      // Where the server's name for a central is not an address at all
      // (iOS: an opaque CBCentral identifier), `dialable` is false and this
      // stays exactly what it always was — a "somebody pulled" cue.
      if (running && dialable && peerId) {
        const at = Date.now();
        if (!lastSeen.has(peerId)) {
          servedOnly.add(peerId);
        }
        seenVia.set(peerId, 'gatt');
        lastSeen.set(peerId, at);
        forgetOldAddresses(at);
        // …AND THE PROOF WE USED TO LET EXPIRE. While the served path is
        // resting, the nudge below either never runs (the walkie holds the
        // radio) or is dropped at the dial, so nothing else in this file
        // will ever come back to this address. Every pull is new
        // authoritative reachability proof and earns one priority dial
        // here, before any of that — either now, or as the banked
        // occurrence the attempt already in flight owes an answer to.
        if (servedOnly.has(peerId) && at < servedDialRestUntil) {
          // THIS INVOCATION IS THE OCCURRENCE. Native raises the event once
          // per completed digest pull, so being called again is the peer
          // connecting again — never a duplicate delivery of the pull we
          // already acted on, and never a fact about the name. It gets its
          // own generation whatever address it is wearing.
          const gen = nextServedGen();
          const current = servedEvidence.get(peerId);
          if (current === undefined || current.spent) {
            claimServedEvidence(peerId, gen, at);
          } else {
            // An attempt for this address is still outstanding: one dial
            // in flight, always. Bank it as the latest.
            bankServedEvidence(peerId, gen, at);
          }
        }
      }
      mlog(`served ${peerId}${dialable ? ' dialable=1' : ''}`);
      if (foreground) {
        nudgeSync('served');
      }
    }),
    // The serving side: a peer wrote its want list; hand back the bytes.
    //
    // UNDER THIS SESSION'S SCOPE, AND ONLY WHILE THERE IS ONE. A want list
    // is an unauthenticated write — whoever holds a GATT connection names
    // ids — so the answer is bounded twice over: by the crew codes this
    // session is serving RIGHT NOW (serveMessages filters rows outside
    // them, so an id guessed or remembered from another pod is not a row a
    // stranger can pull), and by the digest actually being installed. A
    // want that arrives before this session's own offer has landed was
    // built against somebody else's digest — a dead session's, or none at
    // all — and answering it would serve rows nobody was offered.
    //
    // …AND BOUNDED A THIRD TIME, BY WHICH QUESTION IT IS. The two bounds
    // above are both about SCOPE and neither of them names the request: an
    // answer that passed them was still addressed to a PEER, and a peer is
    // a name that outlives the ask. Same central, two wants, a stop and a
    // restart in between, and the first answer — computed under the dead
    // pod's codes — was installed as the answer to the second. The want's
    // own id and the epoch it was built under now ride the event down and
    // go back with the answer, so the server matches question to answer
    // instead of guessing from arrival order.
    onSyncWant(({ peerId, payload, requestId, serverEpoch }) => {
      if (!running) {
        return;
      }
      // …AND THE OFFER THIS SESSION SERVES IS THE ONE THAT IS INSTALLED
      // RIGHT NOW. `digestInstalled` alone says a revision was acked ONCE,
      // which stops being the same claim the moment the radio bounces: both
      // native modules WITHDRAW the offer on a power cycle (the digest
      // characteristic answers the not-ready frame again), so between the
      // adapter coming back and the republish being acked this number is a
      // lie of exactly the shape this file keeps finding. Readiness is the
      // ack — see meshRepublishReady — and the central retries on its own.
      if (!meshRepublishReady()) {
        mlog(
          `want-drop ${peerId} reason=digest-not-installed ` +
            `installed=${digestInstalled} outstanding=${republishOutstanding}`,
        );
        return;
      }
      // AND THE SESSION THAT WAS ASKED IS THE ONE ANSWERING. `running` says
      // a session is live, never that it is THIS one: a want handed to a
      // session that has since ended, answered after a restart, would be
      // served from the store under the codes captured in THIS closure —
      // the dead pod's — and land in whatever the same central has open now.
      if (meshEpoch !== sessionEpoch) {
        mlog(
          `want-drop ${peerId} req=${requestId} reason=stale-session ` +
            `epoch=${sessionEpoch} live=${meshEpoch}`,
        );
        return;
      }
      try {
        const ids = JSON.parse(bytesToUtf8(b64ToBytes(payload)));
        if (!Array.isArray(ids)) {
          return;
        }
        const bytes = serveMessages(
          ids.filter(x => typeof x === 'string'),
          epochMinutes(Date.now()),
          crewCodes(),
        );
        // THE ANSWER NAMES ITS QUESTION. Peer + bytes was an answer with no
        // question attached, and the server had nothing to match it against
        // but arrival order — so a late answer filled the buffer the central
        // was about to read as the answer to a NEWER want. The id and the
        // epoch came up with the event (radio.ts) and go straight back down;
        // the server installs only against the request it still has open at
        // this exact id, under the offer it publishes right now, and answers
        // a REFUSAL rather than installing something it cannot attribute.
        //
        // Plain call for iosMeshParity's reader — see endNativeSession.
        const answered = native.provideSyncMessages(
          peerId,
          requestId,
          serverEpoch,
          bytesToB64(bytes),
        );
        // The refusal is the server's, so it is logged where the server's
        // reasons can be read: a want that goes unserved is otherwise a
        // silence, and silence is what let this class live.
        void Promise.resolve(answered)
          .then(refusal => {
            if (typeof refusal === 'string' && refusal.length > 0) {
              mlog(`want-refused ${peerId} req=${requestId} reason=${refusal}`);
            }
          })
          .catch(() => {
            // Radio gone / module absent: the central's own retry covers it.
          });
      } catch {
        // A malformed want is a stranger's write; serve nothing.
      }
    }),
  ];
  // messagesRevision is read here once so a dead-code eliminator can never
  // decide the subscription above is unobserved.
  void messagesRevision();
}

/**
 * THE MESH STOP, AND IT IS SOMETHING YOU CAN WAIT ON (row 107).
 *
 * This returned void and fire-and-forgot `native.endSession()`, so
 * teardownSession ran straight on through masterOff and RESOLVED while the
 * native side had done nothing yet — on iOS that verb only enqueued its
 * retirement, so a phone whose UI had finished saying "off" still had the
 * previous session's services, buffers and open wants live and readable. The
 * Jest stub hid it perfectly by retiring synchronously inside its async
 * mock, which is why an async road rots: nothing in the harness could tell
 * the two apart.
 *
 * Both ends are closed now. The native verb completes its own retirement
 * before it returns (CrewBeacon.swift's retireBeforeReturning;
 * CrewBeaconModule's main-handler teardown), and the promise that says so is
 * handed back here so the lifecycle can await it. Every synchronous line
 * below still runs synchronously — a caller that ignores the promise gets
 * exactly the old behaviour, minus the lie.
 */
export function stopMeshSync(): Promise<void> {
  if (running) {
    mlog('stop');
  }
  running = false;
  // THE SAME NEW EPOCH, from the other end of the lifecycle. `running =
  // false` alone is not a cancellation: it is re-armed by the very next
  // start, and an op still on the radio would then wake up inside a
  // session that reads as live. The epoch is the thing a stopped drain
  // cannot get back.
  bumpMeshEpoch('stop');
  // AND THE RADIO IS TOLD, not merely disowned. The epoch makes a dead
  // session's completion harmless; it does nothing about the hardware, and
  // an op left running is up to a full native timeout in which the pod that
  // replaces this one cannot dial at all. endSession tears down the exact
  // in-flight operation at the source, so the arbiter's slot is released by
  // that op's own settlement seconds from now instead of a minute from now.
  const retired = endNativeSession('stop');
  for (const u of unsubs) {
    u();
  }
  unsubs = [];
  // ALL of it, exactly as a start clears it. A stop that cleared the queue
  // and left the evidence slots standing is how an old failure found a
  // banked occurrence to promote after its session had ended.
  resetMeshWorld();
  codesFn = null;
  appStateSub?.remove();
  appStateSub = null;
  // The reverse arc of the foreground fast path: never leave the radio in
  // the hungry mode past the session that justified it.
  setScanPosture(false).catch(() => {});
  notifyMeshChanged();
  // THE BARRIER, HANDED TO WHOEVER IS ENDING THE SESSION. Everything above
  // is this world's own bookkeeping and is already done; this is the one
  // fact that lives on the other side of a bridge hop.
  return retired;
}

// ---------------------------------------------------------------- surfaces

/** Bumped when a sync completes or the posture flips — the pod card's
 * "last caught up" line and check button re-render off this. */
export function meshRevision(): number {
  return meshRev;
}

export function subscribeMeshChanged(cb: () => void): () => void {
  meshWatchers.add(cb);
  return () => {
    meshWatchers.delete(cb);
  };
}

/** When a sync last COMPLETED against any peer this session — the honest
 * recency the pod card shows. Null until one has. */
export function lastPodSyncMs(): number | null {
  return lastSyncOkAt;
}

/**
 * The manual check — "Check for pod updates" on the pod card.
 *
 * IT OWNS A BATCH (see CheckRun). The tap FREEZES two things: the crew
 * scope it was made under, and the routes the freshness gate believed in at
 * that instant. Those routes are queued as this check's own entries
 * (cooldowns bypassed, the NUDGE_MIN_GAP_MS floor kept: a peer synced
 * seconds ago is already the caught-up answer), and the answer counts only
 * what THOSE dials did. Reading the session-wide counter across the await
 * is what let another peer's mail be reported as the answer to a gesture —
 * and, across a restart, a negative one.
 *
 * IT IS ALSO THE ONE BORROW OF A HELD RADIO. While the walkie holds the
 * airtime every automatic dial parks; this is the human asking, so its own
 * routes go out and nothing else does.
 *
 * IT CONSUMES NO EVIDENCE on the way through: a check is a request to dial,
 * not proof of anything about a peer, and the claims already in the queue
 * are what this very drain is about to service. Spending them here would
 * cancel dials the check itself may never reach and leave the peer's mail
 * waiting on a pull that would then be refused as a repeat.
 */
export type PodCheck = {
  inRange: number;
  moved: number;
  /** Present ONLY on a check whose session ended (or was replaced) while its
   * drain was on the radio. `inRange` and `moved` are both 0 and mean
   * nothing: this check measured a pod that no longer exists. */
  cancelled?: true;
};

export async function checkPodUpdates(): Promise<PodCheck> {
  if (!running || !codesFn) {
    return { inRange: 0, moved: 0 };
  }
  const epoch = meshEpoch;
  const now = Date.now();
  forgetOldAddresses(now);
  checkSeq += 1;
  const run: CheckRun = {
    id: checkSeq,
    epoch,
    // THE FROZEN SCOPE. Captured beside the routes, because a check is a
    // question about the pod as it was when the human asked.
    codes: codesFn(),
    routes: [],
    pending: new Set(),
    accepted: 0,
    settle: null,
  };
  for (const [addr] of lastSeen) {
    if (!addressFresh(addr, now)) {
      continue;
    }
    run.routes.push(addr);
    if (now - (lastSynced.get(addr) ?? 0) < NUDGE_MIN_GAP_MS) {
      continue; // in range AND just synced: counted, not re-dialled
    }
    run.pending.add(addr);
    queueDial(addr, { nudged: true, check: run.id });
  }
  // ONE CHECK AT A TIME, and the newest owns the batch: a second tap while
  // the first is still out is the same human asking the same question, and
  // the older run's awaiter is released by the settle below or by the epoch.
  const displaced = liveCheck;
  liveCheck = run;
  if (displaced !== null && displaced.settle !== null) {
    const done = displaced.settle;
    displaced.settle = null;
    done();
  }
  const inRange = run.routes.length;
  mlog(`check id=${run.id} inRange=${inRange} routes=${run.pending.size}`);
  const settled =
    run.pending.size === 0
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          run.settle = resolve;
        });
  kickDrain(`check-${run.id}`);
  // THE WAIT, and it ends on whichever comes first: this check's own routes
  // being answered, or the pod it asked about ceasing to exist. Awaiting the
  // drain promise instead is what made a superseded tap sit on the radio for
  // up to a native timeout after the screen it belonged to was gone.
  //
  // ROUNDS, because the radio can be busy when the camper taps: a deferred
  // drain leaves the queue intact and the arbiter's release re-enters it, so
  // each round costs one outstanding native op and there can only be as many
  // of those as there are routes to dial, plus the one already in flight.
  for (let round = 0; round <= run.routes.length; round++) {
    if (run.pending.size === 0 || !running || meshEpoch !== epoch) {
      break;
    }
    const held = nativeOp;
    if (held === null && drainEpoch !== epoch) {
      // NOBODY IS GOING TO ANSWER THESE. No op is on the radio (so no
      // settlement will re-enter the drain) and no drain of this session
      // owns the worker (so nothing is walking the queue). Waiting here
      // would be waiting for an event that has no source — the shape that
      // leaves a spinner up forever — so the check reports what it actually
      // measured instead.
      mlog(`check stalled id=${run.id} pending=${run.pending.size}`);
      break;
    }
    await Promise.race([
      settled,
      epochEnds(),
      held === null ? settled : held.settled,
    ]);
    if (run.pending.size > 0 && running && meshEpoch === epoch) {
      kickDrain(`check-${run.id}-retry`);
    }
  }
  if (liveCheck === run) {
    liveCheck = null;
  }
  // THE ONE POST-AWAIT CHECK, and it gates the surface write as well as the
  // arithmetic. A superseded check notifies NOTHING (the pod card would
  // re-render off a session it is not showing) and reports nothing: its
  // routes were a book the reset has since emptied. The caller reads
  // `cancelled` as silently-superseded — the human's gesture was answered by
  // a pod that stopped existing, and the honest surface for that is no
  // surface at all.
  if (!running || meshEpoch !== epoch) {
    mlog(`check cancelled id=${run.id} epoch=${epoch}`);
    return { inRange: 0, moved: 0, cancelled: true };
  }
  mlog(`check done id=${run.id} inRange=${inRange} moved=${run.accepted}`);
  notifyMeshChanged();
  return { inRange, moved: run.accepted };
}
