/**
 * The walkie SESSION — owned above the panel (owner un-defer, 2026-08-25:
 * "with the walkie on, a call must ring wherever the camper is").
 *
 * WHAT WAS WRONG. The channel and the call runtime both lived inside
 * WalkiePanel, so the radio's life was the life of a VIEW: closing the pod
 * card's walkie stage closed the channel, switching pods closed it, and an
 * incoming call could only ring into a subtree the camper had to already be
 * looking at. A walkie whose reach depends on which tab you are on is not a
 * walkie.
 *
 * THE OWNERSHIP MOVE. This module holds the session: which pod's channel is
 * open, who is on it, the CallRuntime that rides the same sockets, and
 * whether the panel — now a VIEW onto the session — is showing. The panel
 * opens and closes; the channel does not care.
 *
 * TEARDOWN ORDER IS STRUCTURAL HERE, NOT A REACT ACCIDENT. It used to be
 * enforced by the definition order of two useEffect cleanups: destroy() had
 * to reach the native queue before stopWalkie closed the socket, or every
 * close-path bye was rejected 'idle' and the peer waited out the 8 s grace
 * to read "the link dropped" instead of "hung up". That contract now lives
 * in one function (stopWalkieSession) where it can be read, not inferred.
 *
 * ONE PEER MODEL. The roster subscription lives here too, because the call
 * needs it with the panel closed (a peer who walks away must still tear the
 * call down honestly) and because the panel, the pod card's link list and
 * the mini-bar must never disagree about who is on the channel.
 *
 * WHAT THIS IS NOT. It is not OS-background ringing: with the app killed or
 * swapped out, nothing here runs. That needs an Android foreground service
 * and Apple PushToTalk (the capability is enabled on the App ID) and is the
 * named next step — see docs/VIDEO-CALLS.md.
 */
import { AppState } from 'react-native';

import { CallRuntime, callsPresent, type CallSnapshot } from './callRuntime';
import { crewAdvertisingHeld, ensureCrewPermissions } from './radio';
import { holdCrewAdvertising, releaseCrewAdvertising } from './share';
import {
  compareWalkieRevision,
  dedupeWalkiePeers,
  formatChannelNames,
  onWalkieAirtimeState,
  onWalkiePeers,
  setWalkieCallMuted,
  startWalkie,
  stopTalking,
  stopWalkie,
  subscribeWalkieChannel,
  walkieAirtimeState,
  walkieChannelRevision,
  walkieOn,
  type WalkieAirtime,
  type WalkiePeerEntry,
  type WalkiePeerRow,
} from './walkie';
import { walkiePttSuppressed } from './videoCall';

/** Which pod's channel is open, and as whom. The pod is part of the
 * session's identity on purpose: one radio, one channel, and every surface
 * that claims live voice must be able to ask "for WHICH pod?". */
export interface WalkieSessionId {
  crewId: string;
  crewCode: string;
  myCardId: string;
  myName: string;
}

/** Everything a mounted surface needs, as one frozen object — rebuilt only
 * when something actually changed, so useSyncExternalStore can compare it
 * by identity instead of re-rendering on every read. */
export interface WalkieSessionState {
  /** Null when no channel is open anywhere in the app. */
  session: WalkieSessionId | null;
  /** Is the walkie STAGE showing? A view flag, never a radio flag. */
  panelOpen: boolean;
  /** Is the stage actually ON SCREEN — the Pods tab up, the Walkie pane
   * chosen, the session's own pod shown? panelOpen is the camper's
   * Hide/Show intent; this is whether that intent is currently visible.
   * The two compose in walkieMiniBarShown: a stage the camper wants open
   * but has walked away from (another pane, another pod, another tab) is
   * a hot radio with nothing on screen admitting it — the exact lie the
   * mini-bar exists to prevent (codex seam, 2026-08-27). */
  stageVisible: boolean;
  peers: WalkiePeerEntry[];
  /** Callable identities — deduped across transports, un-attributed rows
   * dropped (walkie.ts: "someone" is not an address a call can dial). */
  peerRows: WalkiePeerRow[];
  /** What the radio will actually reach, which is not always peers.length. */
  talkingTo: number;
  /** The call runtime's latest snapshot; null on a build without calls. */
  call: CallSnapshot | null;
}

const EMPTY: WalkieSessionState = {
  session: null,
  panelOpen: false,
  stageVisible: false,
  peers: [],
  peerRows: [],
  talkingTo: 0,
  call: null,
};

let state: WalkieSessionState = EMPTY;
let revision = 0;
const watchers = new Set<() => void>();

let runtime: CallRuntime | null = null;
let offPeers: (() => void) | null = null;
let offCall: (() => void) | null = null;
let offChannel: (() => void) | null = null;
/**
 * THE DEFERRED CREW-BEACON RELEASE (advertiser-debt no-go, 2026-08-27).
 *
 * A close whose native stop could not prove rung 3's advertiser down skips
 * the release and leaves the airtime hold set. Fail-closed, and right —
 * but on its own the hold had no way out, because nothing was ever told
 * when that advertiser finally went quiet. The crew beacon then stayed off
 * the air for the life of the process on the strength of one wedged close:
 * a hold that STRANDS FOREVER, which is a worse outage than the overlap it
 * was protecting against.
 *
 * So the skipped release is not dropped — it is PARKED here, on the native
 * debt-settled event, and it runs when the last unproven advertiser goes
 * terminal. One at a time: a second refusal replaces the first, because
 * there is one hold and one slot, and the event says "the book is clear",
 * which is a fact about the whole process rather than about one debt.
 */
let offSettled: (() => void) | null = null;

/**
 * IS A DEFERRED RELEASE OWED? Explicit state, because a subscription
 * alone could not answer it: a second stop tap needs to find outstanding
 * work that no live closure exposes.
 */
let deferredDebt = false;

/**
 * WHO OWNS THE AIRTIME HOLD *IN THIS JS WORLD*, as a monotonic
 * generation — and read the qualifier, because it is the whole of what
 * this variable is allowed to mean now.
 *
 * WHAT IT USED TO BE. Every previous round of this lane made JS the
 * decider: a settlement arrived, JS looked at its own locals, and JS
 * released a radio hold. The generation was one of the fences that kept
 * that honest, and it was a good fence — a settlement dispatched before a
 * new start and delivered during that start's awaits passes every other
 * JS question, and only "is this still MY hold?" catches it.
 *
 * WHAT IT IS NOW. The ARBITER owns the slot and hands it back itself, at
 * the effect, against the lease it currently holds (S4). Nothing here can
 * move a radio. So the generation and `pendingStarts` are demoted to what
 * the ruling permits them to be: stale-write guards and UX ordering — they
 * decide whether THIS world mirrors a change into radio.ts's caches, never
 * whether a radio may do anything.
 */
let holdGen = 0;
let holdOwner = 0;

/**
 * Starts ASKED FOR and not yet finished — the lifecycle queue's pending
 * head, made observable.
 *
 * IT IS ALSO NATIVE-VISIBLE NOW (S6), and that is the half that was
 * missing. A start that has reserved shows up in the arbiter's own state
 * as phase `reserving`, so the process refuses the release on its own
 * account; this counter is the JS-side ordering guard for the window
 * before the reservation exists at all.
 */
let pendingStarts = 0;

/**
 * THE NATIVE OWNERSHIP THIS WORLD ADOPTED — split into the two questions
 * one field used to answer badly (S5).
 *
 *   `adoptedIncarnation`  WHICH PROCESS. A JS reload keeps talking to the
 *                         same one; a relaunch is a different string.
 *   `adoptedAt`           WHEN, as the arbiter's own revision. Compared
 *                         through `compareWalkieRevision`, never through
 *                         Number: a UInt64 through JSON loses every order
 *                         relation above 2^53, and a stale snapshot that
 *                         compares EQUAL to the state that replaced it
 *                         walks through every "is this older?" fence.
 */
let adoptedIncarnation: string | null = null;
let adoptedAt: WalkieAirtime | null = null;

/**
 * WHY THIS WORLD IS HOLDING, IN ONE WORD — and `incompatible`/`absent`
 * are the two that did not exist before (S9, and the acceptance detail:
 * "must produce explicit incompatible/degraded outcome, not null watcher
 * forever").
 *
 *   none          nothing held here.
 *   watching      a live subscription and a live query; the arbiter will
 *                 say when the slot comes back.
 *   incompatible  the native ANSWERED and this JS could not read the
 *                 answer. The hold parks, permanently, and no watcher is
 *                 left waiting on an event shape that will never arrive —
 *                 because the event carries the same body the query does,
 *                 so a native we cannot read emits events we cannot read.
 *   absent        no native, no such method, or a seam that threw. Same
 *                 park, different reason.
 */
export type WalkieHoldReason = 'none' | 'watching' | 'incompatible' | 'absent';

let parkReason: WalkieHoldReason = 'none';

/** Readable, because a park with no reason anyone can see is the strand
 *  wearing a cure's clothes. */
export function walkieHoldReason(): WalkieHoldReason {
  return parkReason;
}

/** Which generation this watch parked for, and whether it ever owed
 *  anything. Module-level rather than closure-local because the re-drive
 *  (see `redriveAirtimeWatch`) is a road into the SAME watch from
 *  outside it. */
let watchGen = 0;
let watchOwes = false;
/** THIS WATCH'S ONE-SHOT — and it latches on a release that RAN, never on
 *  one that was refused (S6). See `settleAirtime`. */
let watchDone = true;

/** The hold's next owner. Monotonic, and minted before the hold is taken
 *  so the hold is never briefly unowned. */
function mintHoldGeneration(): void {
  holdGen += 1;
  holdOwner = holdGen;
}

/**
 * THE ONE RELEASE ANY DEFERRED ROAD MAY RUN — and what it releases is
 * THIS WORLD'S MIRROR, not the radio.
 *
 * READ THAT LINE FIRST, because it is the demotion the ruling asks for.
 * The arbiter has already put the crew beacon back on the air, itself, at
 * the effect, before any of this runs. What is left here is radio.ts's
 * cached `advertisingHeld` bit and the sharing session's refresh — the UX
 * half. A stale JS world that never gets here costs the camper a cadence
 * tick; it does not cost anyone an overlap. That is the whole difference
 * between this round and the four before it.
 *
 * THE FENCES REMAIN, in the order the arbiter's own answers arrive: what
 * the PROCESS says first, then which process, then when, then whether
 * this world is the one to act on it.
 */
function releaseDeferredHold(gen: number, snap: WalkieAirtime | null): boolean {
  // THE NATIVE FENCE. A snapshot nobody could produce is not a clear
  // slot, and a slot the process still occupies is not ours to mirror.
  if (snap === null || snap.holdRequired) {
    return false;
  }
  // THE INCARNATION FENCE. A different process is not a later state of
  // this one: nothing this world adopted survives a relaunch, and a body
  // from another incarnation says nothing about the hold this one took.
  if (adoptedIncarnation !== null && snap.processIncarnation !== adoptedIncarnation) {
    return false;
  }
  // THE REVISION FENCE. The body may have travelled — RN delivers what it
  // already dispatched, and a background can hold one for minutes. A
  // state from before the adoption describes a world that has since moved
  // on. Equal is fine: that is the same moment, answering.
  if (adoptedAt !== null && compareWalkieRevision(snap, adoptedAt) < 0) {
    return false;
  }
  // THE ORDERING FENCE, and it is exactly that now: same generation, and
  // no start already asked for that this mirror is about to belong to.
  if (gen !== holdOwner || pendingStarts > 0) {
    return false;
  }
  if (state.session !== null || walkieOn()) {
    return false;
  }
  deferredDebt = false;
  adoptedIncarnation = null;
  adoptedAt = null;
  parkReason = 'none';
  void releaseCrewAdvertising().catch(() => undefined);
  return true;
}

/**
 * ADOPT — this world takes responsibility for mirroring a hold the
 * PROCESS says it is holding, whatever this world's own flags say.
 *
 * IT NEVER LOWERS (S6). Adoption is monotonic: a later state that still
 * says `holdRequired` refreshes the revision and keeps everything else,
 * and nothing in here can turn an adopted world back into an unadopted
 * one. The only exit is a release that actually ran.
 */
function adoptAirtime(snap: WalkieAirtime): boolean {
  if (state.session !== null || walkieOn()) {
    // A live session is a live owner: its own close hands the slot back.
    return false;
  }
  deferredDebt = true;
  adoptedIncarnation = snap.processIncarnation;
  if (adoptedAt === null || compareWalkieRevision(snap, adoptedAt) > 0) {
    adoptedAt = snap;
  }
  if (!crewAdvertisingHeld()) {
    // THE ACTUATOR, never the gate: the flag answering false means this
    // world's cadence is not suppressed and must be, so radio.ts does not
    // tick a payload into a beacon the arbiter is holding down.
    void holdCrewAdvertising().catch(() => undefined);
  }
  return true;
}

/**
 * WATCH THE AIRTIME — SUBSCRIBE FIRST, QUERY SECOND, AND PARK WITH A
 * REASON WHEN NEITHER ROAD EXISTS.
 *
 * THE ORDER. The state is announced on every revision and can also be
 * asked; subscribing first means no change slips past after this point,
 * querying second means any change that slipped past before it is found
 * anyway. The two roads share one latch, so a state that goes clear on
 * the very turn between them is mirrored exactly once.
 *
 * THE CAPABILITY (S9). If the seam cannot be reached, or answers a body
 * this JS cannot read, there is no third road to fall back to: the event
 * carries the SAME body as the query, so a native whose answer we cannot
 * read emits events we cannot read either. "Keep listening" would be a
 * watcher waiting forever on a shape that will never arrive, which is the
 * strand this whole lane exists against. So the hold parks with an
 * explicit reason and this world stops pretending it is watching.
 */
function watchAirtime(gen: number, owed: boolean): void {
  offSettled?.();
  offSettled = null;
  watchGen = gen;
  watchOwes = owed;
  watchDone = false;
  if (owed) {
    deferredDebt = true;
  }
  let sub: (() => void) | null = null;
  try {
    sub = onWalkieAirtimeState(settleAirtime);
  } catch {
    // A seam that cannot even be subscribed to is `absent`, not silent.
    sub = null;
  }
  if (sub === null) {
    parkAirtime('absent');
    return;
  }
  offSettled = sub;
  parkReason = 'watching';
  void walkieAirtimeState()
    .then(({ capability, state: snap }) => {
      if (capability !== 'arbiter') {
        parkAirtime(capability);
        return;
      }
      settleAirtime(snap);
    })
    .catch(() => parkAirtime('absent'));
}

/**
 * THE DEGRADED PARK. The hold stays, the subscription goes (it cannot
 * deliver anything readable), and the reason is on the record so a
 * surface, a log or an arm can name it. It is deliberately terminal:
 * nothing about an incompatible native gets better by waiting.
 */
function parkAirtime(reason: 'incompatible' | 'absent'): void {
  offSettled?.();
  offSettled = null;
  watchDone = true;
  parkReason = reason;
  // SAID OUT LOUD, in the shape share.ts's own skips already use. A
  // degraded park is permanent, and a permanent suppression nobody can
  // see is the exact class of defect this whole lane exists against — a
  // phone that quietly stopped advertising cost two evenings and three
  // phones to catch. The reason is on the record; this is the record
  // being readable from a field log rather than only from a debugger.
  // eslint-disable-next-line no-console
  console.log('PlayaMesh airtime//park reason=' + walkieHoldReason());
  // NOT `deferredDebt`. That flag means "a later stop can re-drive the
  // native book", and there is no book we can talk to here — a second tap
  // would be a second native stop answering the same unreadable answer.
  // The hold stands on the reason alone.
}

/**
 * Either road into the same one-shot, and the ADOPTION that is not a
 * release at all.
 *
 * THE LATCH CLOSES ON A RELEASE THAT RAN, NEVER ON ONE THAT WAS REFUSED
 * (S6, and the test-vacuity addendum's exact seam):
 *
 *   "clear snapshot arrives during failed-start cleanup; watcher marks
 *   done/unsubscribes; release rejects on pendingStarts; finally
 *   decrements with no redrive => stranded hold."
 *
 * The old shape latched on the STATE — it saw a clear body, declared
 * itself finished, dropped the subscription, and only then asked whether
 * it was allowed to act. When the answer was no, the watch was already
 * gone and nothing would ever ask again. A clear state is not a
 * completed job; a completed job is.
 */
function settleAirtime(snap: WalkieAirtime | null): void {
  if (watchDone) {
    return;
  }
  if (snap === null) {
    // A question nobody answered; keep watching, keep the hold.
    return;
  }
  if (snap.holdRequired) {
    // ANSWERED BY THE ADOPTION ITSELF, never by re-reading the module
    // flag: `deferredDebt` can be true because some other road set it,
    // and "did THIS watch take something on?" is a different question.
    watchOwes = adoptAirtime(snap) || watchOwes;
    return;
  }
  if (!watchOwes) {
    // A clean world that asked, was told the slot is free, and has
    // nothing of its own to hand back.
    watchDone = true;
    offSettled?.();
    offSettled = null;
    parkReason = 'none';
    return;
  }
  if (!releaseDeferredHold(watchGen, snap)) {
    // REFUSED, AND THEREFORE NOT FINISHED. Both roads stay open: the
    // subscription stands and the re-drive can ask again. A latch closed
    // here would declare the job done before asking whether it was
    // allowed to do the job — which is the strand, exactly.
    return;
  }
  watchDone = true;
  offSettled?.();
  offSettled = null;
}

/**
 * RE-DRIVE AFTER A PENDING START (S6). The ordering fence above refuses
 * while a start is in flight, and that refusal is correct — but a
 * refusal is not an answer, and nothing was going to ask again: the
 * arbiter's state has not changed, so no new event is coming, and the
 * query already ran. So the moment the thing the fence was waiting for is
 * over, the question is asked again.
 */
function redriveAirtimeWatch(): void {
  if (watchDone || offSettled === null) {
    return;
  }
  void walkieAirtimeState()
    .then(({ capability, state: snap }) => {
      if (capability !== 'arbiter') {
        parkAirtime(capability);
        return;
      }
      settleAirtime(snap);
    })
    .catch(() => undefined);
}

/** The refused close's road: a mirror IS owed, and the arbiter's state is
 *  what decides when it may run. */
function deferCrewRelease(gen: number): void {
  watchAirtime(gen, true);
}

/** A new session takes the hold, so the old close's parked mirror is no
 *  longer owed by anyone. The in-flight event this does NOT un-queue is
 *  what the fences are for. */
function cancelDeferredCrewRelease(): void {
  offSettled?.();
  offSettled = null;
  watchDone = true;
  deferredDebt = false;
  adoptedIncarnation = null;
  adoptedAt = null;
  parkReason = 'none';
}

/**
 * THE SECOND TAP'S RECONCILE. A public stop that finds nothing standing
 * but a debt still owed re-drives the native stop — which SERVICES the
 * arbiter's debt phase, re-issuing every open advertiser stop at the fast
 * tick — and then re-runs subscribe-first-query-second against the state
 * that stop left behind.
 *
 * THE STOP'S OWN ANSWER IS NOT THE QUESTION HERE, which is why it is not
 * read. The hold is owed to the PROCESS, and only the state speaks for
 * the process.
 */
async function reconcileDeferredDebt(): Promise<void> {
  const gen = holdOwner;
  await stopWalkie();
  deferCrewRelease(gen);
}

/*
 * ---------------------------------------------------------------------
 * ONE TEARDOWN, RUN BY ONE EXECUTOR (S8, and the acceptance detail:
 * "replace abandonFailedStart's 5+ repeated fail-soft try/catches with a
 * cleanup-step data structure/shared teardown executor per repo law (3+
 * same-shaped ops => data)").
 *
 * FIVE HAND-WRITTEN try/catch BLOCKS ARE FIVE CHANCES TO FORGET ONE, and
 * the one that gets forgotten is always the one after a step that raises.
 * The steps are DATA now — a label and a thunk — and one loop runs them,
 * guarding each. Adding a step cannot introduce an unguarded one, and
 * reordering cannot change whether a later step runs.
 *
 * AND IT IS THE SAME LIST FOR BOTH ROADS. A normal close and a start that
 * threw after its holds were taken are the same teardown with different
 * epilogues: the close resolves, the failed start rethrows the camper's
 * original error. Two lists that must agree is the defect class this
 * whole architecture round is about.
 * ---------------------------------------------------------------------
 */

interface TeardownStep {
  label: string;
  run: () => void | Promise<void>;
}

/** Runs every step, guards each ONE, and returns the labels that raised.
 *  A step that throws is a step that is over, never a teardown that is. */
async function runTeardown(steps: readonly TeardownStep[]): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      failed.push(step.label);
    }
  }
  return failed;
}

/**
 * THE SESSION'S TEARDOWN, IN ORDER, AND THE ORDER IS THE CONTRACT.
 *
 * DETACHING COMES FIRST so nothing later can call back into a session
 * that is coming down: a peers event landing mid-teardown would drive a
 * runtime that is being destroyed and re-`set` a session being cleared.
 *
 * Then destroy(), then the mic, then (by the caller) the socket. destroy()
 * dispatches the hangup, whose first transmission is posted onto the
 * native-modules queue before stopWalkie closes the socket — both
 * serialize on that thread, so the order of these calls IS the order on
 * the wire. Reverse them and every close-path bye is rejected 'idle' and
 * the peer waits out the 8 s ICE grace to read "the link dropped" instead
 * of "hung up".
 *
 * IDEMPOTENT BY CONSTRUCTION: every step is a no-op on a session that is
 * already down, so running the list twice costs nothing and cannot
 * double-fire anything.
 */
function sessionTeardownSteps(): readonly TeardownStep[] {
  let rt: CallRuntime | null = null;
  return [
    {
      label: 'detach-peers',
      run: () => {
        offPeers?.();
        offPeers = null;
      },
    },
    {
      label: 'detach-call',
      run: () => {
        offCall?.();
        offCall = null;
      },
    },
    {
      label: 'clear-claim',
      run: () => {
        rt = runtime;
        runtime = null;
        noteRing(null);
        set({ ...EMPTY });
      },
    },
    { label: 'destroy-runtime', run: () => rt?.destroy() },
    { label: 'release-mic', run: () => stopTalking() },
    { label: 'unmute', run: () => setWalkieCallMuted(false) },
  ];
}

/**
 * THE ONE CLOSE, AND THE ONE DECISION ABOUT THE HOLD.
 *
 * Teardown, then the native barrier, then the mirror. `clear` is the only
 * word that hands the JS-side hold back; `debt`, `notOwner` and `unknown`
 * all park, because none of them is a proof and unknown is never clear
 * (S7). The arbiter has already dealt with the RADIO either way.
 */
async function endWalkieSession(): Promise<void> {
  await runTeardown(sessionTeardownSteps());
  const stop = await stopWalkie();
  const gen = holdOwner;
  // ONE WORD DECIDES, AND ONLY ONE. `clear` is the arbiter saying the
  // exact owner's advertiser is proven off the air and the process owes
  // nothing; `debt`, `notOwner` and `unknown` all park, because none of
  // them is a proof and unknown is never clear (S7).
  //
  // THE OPTIONAL READ IS THE SAME RULE, not a defensive habit: an answer
  // whose shape this world does not recognise — a harness double that
  // does not model the boundary, a future adapter — has told us nothing
  // about the air, and nothing has never proved a radio quiet.
  if (stop?.outcome === 'clear') {
    await releaseCrewAdvertising().catch(() => undefined);
    return;
  }
  // …AND THE SKIPPED MIRROR IS OWED, NOT FORGOTTEN. The arbiter keeps
  // proving that advertiser for as long as it takes; when its debt phase
  // ends it publishes a revision saying so, and this park runs then —
  // against the session state of THAT moment, never against this one.
  deferCrewRelease(gen);
}

/**
 * THE SHARED FAILED-START OWNER (F2), which is now the shared teardown
 * plus one epilogue.
 *
 * A start that throws AFTER the holds are taken used to leave the wreck
 * where it fell: the airtime mirror set, the peer subscription attached,
 * the call runtime alive, the mic possibly open, and the module claiming
 * a session that never came up. Nothing later covered it either — the
 * next start's cancel drops a park that was never made.
 *
 * THREE PROPERTIES, and each one is a defect it answers:
 *
 * 1. EVERY STEP INDIVIDUALLY FAIL-SOFT — by the executor above, not by
 *    five hand-written guards that can be four.
 * 2. IT NEVER RELEASES INTO OVERLAP. The hold decision is the close's,
 *    verbatim, because it is the same function.
 * 3. THE ORIGINAL ERROR SURVIVES. Everything here is cleanup; none of it
 *    is the reason the start failed.
 */
export async function abandonFailedStart(original: unknown): Promise<never> {
  await endWalkieSession();
  throw original;
}

/**
 * RELOAD RECOVERY, on this module's own init.
 *
 * A JS world can end while an airtime mirror is standing — a reload, a
 * Fast Refresh, a resume that re-evaluated this module. The park dies
 * with it. THE RADIOS DO NOT CARE, and neither does the arbiter: the
 * lease it holds is a process fact and outlives every JS world above it.
 *
 * IT ASKS THE PROCESS, NOT ITSELF. Gating this on `crewAdvertisingHeld()`
 * — a JS flag the very reload this road exists for has already reset —
 * would close the road in exactly the world it was written for. So a new
 * world mints an owner and subscribes first / queries second
 * unconditionally, and ADOPTS whenever the arbiter says it is holding.
 * The flag still has a job and it is the other one: it says whether this
 * world already believes it is suppressing the cadence.
 *
 * AND IT FAILS SOFT, because of WHERE it runs: a module-init side effect
 * that throws takes the whole walkie import graph down with it.
 */
function reconcileStrandedHold(): void {
  try {
    if (state.session !== null || walkieOn()) {
      return;
    }
    mintHoldGeneration();
    watchAirtime(holdOwner, crewAdvertisingHeld());
  } catch {
    // A graph that cannot answer "who owns the airtime?" has told us
    // nothing, and nothing is not a hold to adopt.
  }
}

/**
 * THE LIFECYCLE IS SINGLE-FLIGHT. Both verbs run through this one queue,
 * because the teardown honestly clears state BEFORE its native awaits (see
 * stopWalkieSession) — which meant a fast off→on toggle could slip past the
 * session fence while the old teardown was suspended in the native stop,
 * and the teardown then resumed to stop the NEW session's radio and release
 * the NEW session's advertising hold: the tap that turned the walkie on was
 * silently undone. Confirmed adversarially (2026-08-26) before it was ever
 * benched. The queue is the whole cure — an operation begins only after the
 * previous one has entirely finished, so no verb can observe a half-torn
 * state.
 */
let lifecycle: Promise<unknown> = Promise.resolve();

/**
 * THE CAMPER'S INTENT, AS A NUMBER THE QUEUE CANNOT DELAY (M7).
 *
 * The public stop verb moves this the moment it is called — before the
 * teardown it files reaches the front of the lifecycle queue. That gap is
 * the whole point: a start suspended in a permission dialog HOLDS the
 * queue, so the stop filed behind it cannot run until the start has armed
 * the radio and taken both holds. The epoch is the only thing that crosses
 * that suspension, and it is what lets the start notice it has stopped
 * being wanted instead of arming a channel for a panel that is shut.
 */
let stopEpoch = 0;

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(op, op);
  lifecycle = run.catch(() => undefined);
  return run;
}

/**
 * The getSnapshot half, and it COMPOSES BOTH STORES on purpose: this
 * module's own counter plus walkie.ts's channel revision. A channel that
 * opens or closes changes what walkieOnFor() answers without changing a
 * single field here, so a revision that ignored it would let a mounted
 * surface keep rendering a claim the radio had already dropped — the exact
 * staleness the channel emitter was built to prevent. Both counters are
 * monotonic, so their sum is.
 */
export function walkieSessionRevision(): number {
  return revision + walkieChannelRevision();
}

export function subscribeWalkieSession(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

/** The current state. Stable by identity between changes — a caller may
 * hold it across renders and compare with ===. */
export function walkieSessionState(): WalkieSessionState {
  return state;
}

function set(next: Partial<WalkieSessionState>): void {
  state = { ...state, ...next };
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

/** Which pod's channel is open, or null. */
export function walkieSessionCrewId(): string | null {
  return state.session?.crewId ?? null;
}

/**
 * Is the walkie open FOR THIS POD? The question every truth rule on the pod
 * card must ask now that the session outlives the panel: with the channel
 * open on the big camp pod and the card switched to the two-person pod, a
 * bare walkieOn() would claim live voice for people this radio is not on a
 * channel with. Also gates on walkie.ts's own flag, so a native-side stop
 * can never be outlived by this module's bookkeeping.
 */
export function walkieOnFor(crewId: string): boolean {
  return walkieOn() && state.session?.crewId === crewId;
}

/** The runtime, for the surfaces that drive it (answer, decline, hang up,
 * place a call). Null whenever no session is up, or on a build whose native
 * half cannot carry calls. */
export function walkieCallRuntime(): CallRuntime | null {
  return runtime;
}

// ------------------------------------------------------------- ring events
//
// THE SEAM FOR THE POCKET (kept deliberately narrow): a lane that posts a
// call notification subscribes HERE rather than reaching into the reducer or
// racing the UI. One event when a ring starts, one when it stops — which is
// exactly a notification's post/cancel pair. Nothing in this module posts a
// notification itself.

export type WalkieCallEvent =
  | { kind: 'ring'; callId: string; peerHash: number | null; peerName: string }
  /** The ring is over — answered, declined, timed out, or the caller hung
   * up. A notification lane cancels on this and never needs to know which. */
  | { kind: 'ring-cleared'; callId: string };

const callWatchers = new Set<(e: WalkieCallEvent) => void>();
let ringingCallId: string | null = null;

export function subscribeWalkieCallEvents(
  cb: (e: WalkieCallEvent) => void,
): () => void {
  callWatchers.add(cb);
  return () => {
    callWatchers.delete(cb);
  };
}

function emitCall(e: WalkieCallEvent): void {
  for (const cb of callWatchers) {
    try {
      cb(e);
    } catch {
      // One subscriber's failure is not the call's failure.
    }
  }
}

function noteRing(snap: CallSnapshot | null): void {
  const m = snap?.model;
  const id = m && m.phase === 'ringing' ? m.callId : null;
  if (id === ringingCallId) {
    return;
  }
  if (ringingCallId !== null) {
    emitCall({ kind: 'ring-cleared', callId: ringingCallId });
  }
  ringingCallId = id;
  if (id !== null && m) {
    emitCall({
      kind: 'ring',
      callId: id,
      peerHash: m.peerHash,
      peerName: m.peerName ?? 'someone',
    });
  }
}

// ------------------------------------------------------------ the lifecycle

/**
 * Open the channel for this pod. Idempotent for the same pod; for a
 * DIFFERENT pod it is a swap, because there is one radio and one channel —
 * stopping the old session first is what keeps every "walkie is on" claim
 * attached to the pod it is actually true of.
 *
 * The BLE runtime grant is asked here, in context: opening the walkie is the
 * gesture the radio serves, and a decline is not an error (the Wi-Fi rungs
 * run regardless, the BLE rung just contributes no peers).
 */
export function startWalkieSession(id: WalkieSessionId): Promise<void> {
  // PENDING IS COUNTED AT THE VERB, not at the queue's head. A start that
  // is still queued behind a stop has minted no generation yet, so a
  // settlement landing in that window would pass the generation fence —
  // and release a hold this start is about to want. The intent is the
  // fact; the queue only decides when the machinery runs.
  pendingStarts += 1;
  return enqueue(() => doStartWalkieSession(id)).finally(() => {
    pendingStarts -= 1;
    // AND THE FENCE'S OWN WAIT IS OVER (S6). A parked mirror that was
    // refused *because of* this pending start has nothing else coming:
    // the arbiter's state did not change, so no event is due, and the
    // query already ran and was turned away. This is the re-drive — the
    // exact seam the test-vacuity addendum names, closed at the exact
    // line the refusal was waiting on.
    if (pendingStarts === 0) {
      redriveAirtimeWatch();
    }
  });
}

async function doStartWalkieSession(id: WalkieSessionId): Promise<void> {
  // Sampled BEFORE anything can suspend, and read again past the dialog.
  const wantedAt = stopEpoch;
  if (state.session?.crewId === id.crewId && walkieOn()) {
    set({ session: id }); // a renamed camper, same channel
    return;
  }
  // EVERY REJECTION ROAD OUT OF A START OWES THE HOLDS BACK — and the road
  // that owns it is the try below, not a wrapper around this whole function
  // (union resolution, 2026-08-27). Both lanes wrote this cleanup. The mesh
  // lane wrapped the entire body and called a second, older
  // abandonFailedStart(); that shape is retired here, for reasons of
  // substance rather than style.
  //
  // ONE: the native lane's teardown executor is a STRICT SUPERSET of the
  // mesh lane's step list. Every step the mesh version ran is in
  // sessionTeardownSteps(), individually guarded by runTeardown() rather
  // than by hand-written try/catches, and the executor adds the `unmute`
  // the mesh version omitted. There was no step to map in.
  //
  // TWO: the outer wrapper's extra reach was not extra safety, it was a new
  // defect. It also covered the PRE-HOLD steps, and abandoning from there
  // would drive endWalkieSession against a hold this start never took — a
  // native stop issued and a mirror parked on a debt owed by nobody.
  // Nothing between here and the hold can throw in any case: both awaits
  // below carry their own .catch, so the try that opens immediately after
  // holdCrewAdvertising() already covers every road that can.
  //
  // THREE: the mesh version's `stopWalkie() === false` advertiser-debt
  // branch is superseded, not dropped. The native side answers a structured
  // outcome and `clear` is the only word that releases; `debt`, `notOwner`
  // and `unknown` park the mirror on the arbiter's own terminal. That is
  // the same rule the mesh lane wanted — never release into an overlap —
  // decided by a proof instead of by a boolean the radio no longer sends.
  if (state.session) {
    // Direct, not through the queue: this op IS the queue's running head,
    // and enqueueing from inside it would wait on itself forever.
    await doStopWalkieSession();
  }
  cancelDeferredCrewRelease();
  await ensureCrewPermissions().catch(() => false);
  // AND THE GESTURE IS RE-READ ON THE FAR SIDE OF IT (M7, the mesh lane's
  // handoff, and the walkie half of the same seam share.ts's mailbox start
  // now carries).
  //
  // ensureCrewPermissions can raise a system dialog, and a system dialog is
  // a suspension with no upper bound: the camper may grant it a minute
  // later, from the app switcher, with the walkie panel long closed behind
  // it. Everything below this line opens a radio and takes TWO holds — the
  // crew advertiser off the air and meshSync's cadence parked — on the
  // strength of a tap that may no longer be anybody's intent.
  //
  // AND NOTHING ELSE CAN CATCH IT. The stop the camper filed while the
  // dialog was up is sitting in the lifecycle queue BEHIND this operation,
  // so it cannot run until the start it was meant to cancel has finished
  // arming; it then tears down a session that should never have come up,
  // and every stale-event fence in this file gets to be exercised for no
  // reason. Returning here is the cheap version of the same outcome.
  //
  // THE POSTURE READ REFUSES ONLY ON AN EXPLICIT 'background'. iOS reports
  // 'inactive' for the whole life of a permission sheet, so a stricter test
  // would refuse exactly the grants this road exists to act on, and a
  // harness with no AppState has no posture to refuse on (meshSync's start
  // and share.ts's mailbox start read it the same way, for the same
  // reason).
  //
  // NO HOLD HAS BEEN TAKEN YET, which is why this is a bare return and not
  // an abandon: mintHoldGeneration and holdCrewAdvertising are below. A
  // teardown here would issue a native stop and park a mirror on a debt
  // owed by nobody.
  if (stopEpoch !== wantedAt || AppState?.currentState === 'background') {
    return;
  }
  // THE WALKIE TAKES THE ADVERTISING SLOT (iOS only; share.ts holds the
  // whole reasoning and the platform gate). BEFORE the walkie's own
  // advertiser comes up, never after: two advertisers overlapping is
  // precisely the state that pushes this iPhone's service UUIDs into
  // CoreBluetooth's overflow area, where no Android scan can match them,
  // and CoreBluetooth does not revisit that decision when one of them
  // later stops.
  //
  // Fail-soft on purpose. A crew beacon that will not go quiet is a
  // degraded rung — the walkie still works between iPhones and still
  // dials Androids as a central — and a degraded rung never fails the
  // rung above it (docs/WALKIE-LADDER.md §1).
  //
  // THE HOLD GETS ITS OWNER BEFORE IT IS TAKEN. Minting after would leave
  // the new hold briefly wearing the OLD generation, and that is exactly
  // the window a stale settlement is delivered into — it would pass the
  // fence by matching a number that had not been updated yet.
  mintHoldGeneration();
  await holdCrewAdvertising().catch(() => undefined);
  // EVERYTHING PAST THE HOLD HAS AN OWNER IF IT FAILS. The native start
  // rejects (a radio that will not open, an ObjC raise carried up as a
  // reject), the emitter can throw on a partially wired bridge, and the
  // call runtime's own start can raise — and before this, each of those
  // left the hold set, the listeners attached and the runtime alive, with
  // only the rejection to show for it. One owner, one order, one decision
  // about the hold; the original error is what reaches the camper.
  try {
    await startWalkie(id.crewCode, id.myCardId, id.myName);

    offPeers = onWalkiePeers(p => {
      const peerRows = dedupeWalkiePeers(p.peers);
      set({ peers: p.entries, peerRows, talkingTo: p.talkingTo });
      // The call watches the roster with the panel CLOSED too: a call peer
      // who stays gone must tear the call down with the honest sentence,
      // and whether the camper is looking at the stage has nothing to do
      // with it.
      runtime?.notePeers(new Set(peerRows.map(r => r.hash)));
    });
    if (callsPresent()) {
      const rt = new CallRuntime(id.myName);
      runtime = rt;
      rt.start();
      offCall = rt.subscribe(onCallSnapshot);
      set({ session: id, call: rt.snapshot() });
    } else {
      set({ session: id, call: null });
    }
  } catch (e) {
    return await abandonFailedStart(e);
  }
}

/**
 * Close the channel — the ONE teardown path, and the order is the contract.
 *
 * destroy() first: it dispatches the hangup, whose first transmission is
 * posted onto the native-modules queue before stopWalkie closes the socket
 * (both serialize on that thread, so the order of these JS calls IS the
 * order on the wire). Reverse them and every close-path bye is rejected
 * 'idle' and the peer waits out the 8 s ICE grace to read "the link
 * dropped" instead of "hung up".
 *
 * Then the mic, then the socket. And the playback mute is released on the
 * way out: a channel closed mid-call must not leave the native side muted
 * for the next one.
 *
 * THE STATE CLEARS BEFORE THE AWAITS, for walkie.ts's own reason (its
 * stopWalkie notifies before awaiting the native stop): the surfaces' whole
 * job is to stop claiming a channel that is going away, and the native
 * teardown's latency must not extend the life of a claim that is already
 * false. The mini-bar promising a live radio for the length of a native
 * round-trip is exactly the staleness this lane's disclosure exists against.
 */
export function stopWalkieSession(): Promise<void> {
  // THE CLAIM DIES AT THE DECISION — the queue may delay the machinery,
  // never the honesty. The mini-bar stops promising a live radio the moment
  // the camper says stop, not at the end of a native teardown that may be
  // queued behind other lifecycle work. The queued stop below detaches and
  // re-clears authoritatively when it runs; this is only the claim.
  stopEpoch += 1;
  noteRing(null);
  if (state.session !== null || state.call !== null) {
    set({ ...EMPTY });
  }
  return enqueue(doStopWalkieSession);
}

async function doStopWalkieSession(): Promise<void> {
  if (!state.session && !runtime && !offPeers && !offCall && !walkieOn()) {
    if (!deferredDebt) {
      // A queued duplicate — a second off tap, or the channel watcher
      // filing a stop behind one already running — reaches here after the
      // real stop finished and finds nothing standing. One stop is one
      // stop. The listeners are part of "standing": a claim already
      // cleared by the public verb must not skip the detach that still
      // owes.
      return;
    }
    // …UNLESS SOMETHING IS STILL OWED. "Nothing standing" was read as
    // "nothing to do", and that is false the moment a refused close has
    // parked a mirror: the arbiter is in its debt phase, and this tap is
    // the best cure available — it re-drives every open advertiser stop
    // at the fast tick.
    await reconcileDeferredDebt();
    return;
  }
  await endWalkieSession();
}

/** Show or hide the walkie STAGE. Never touches the radio — that is the
 * whole point of the split, and the mini-bar is what keeps a hidden stage
 * from becoming an invisible hot radio. */
export function setWalkiePanelOpen(open: boolean): void {
  if (state.panelOpen !== open) {
    set({ panelOpen: open });
  }
}

/**
 * The mini-bar's condition, as a function so it is testable and so exactly
 * one place decides it: the walkie is on and the stage is not showing.
 * (With the stage showing, the stage IS the disclosure.)
 */
export function walkieMiniBarShown(s: WalkieSessionState): boolean {
  return s.session !== null && !(s.panelOpen && s.stageVisible);
}

/** The card reports whether the stage is on screen (see stageVisible).
 * Reporting visibility is not steering the session: the pod whose channel
 * is open never changes here — that one-way rule (session drives the pane,
 * never the reverse) still stands. */
export function setWalkieStageVisible(visible: boolean): void {
  if (state.stageVisible !== visible) {
    set({ stageVisible: visible });
  }
}

/**
 * What the mini-bar says. THE JUSTIFICATION IS BATTERY HONESTY: walkie
 * audio with the stage closed is a feature, and a radio that is
 * hot, draining, and invisible is a lie of omission — the same class as a
 * channel list that keeps claiming voice after the channel closed. So the
 * bar names the channel it is holding open, and the names are the ones the
 * stage itself would show, lo-fi badge and all.
 *
 * An empty channel still gets a bar: the drain is the same whether or not
 * anyone answered, and "nobody yet" is also the fact that sends a camper to
 * a voice note.
 */
export function walkieMiniBarCopy(s: WalkieSessionState): string {
  const who =
    s.peers.length > 0
      ? formatChannelNames(s.peers)
      : 'nobody else on the channel yet';
  return `Walkie on — ${who}`;
}

function onCallSnapshot(snap: CallSnapshot): void {
  // Walkie PLAYBACK mutes for the call's duration and unmutes on every end
  // arc. This moved up here WITH the runtime: pod voice now plays with the
  // panel closed, so the echo path (call loudspeaker into the walkie's open
  // mic) exists whether or not anyone is looking at the stage.
  void setWalkieCallMuted(walkiePttSuppressed(snap.model.phase));
  noteRing(snap);
  set({ call: snap });
}

/**
 * The channel's own open/close emitter (walkie.ts) is re-published through
 * this store, so surfaces subscribe once and still see a close they did not
 * ask for. It also keeps notifyWalkieChannel truthful in the other
 * direction: if the flag says closed while a session is still standing, the
 * session is the stale one and it comes down.
 */
function onChannelFlip(): void {
  if (!walkieOn() && state.session !== null) {
    void stopWalkieSession();
    return;
  }
  // No field here changed — the channel did. Wake the watchers anyway: the
  // composed revision above already reflects it, and walkieOnFor() reads
  // the flag live.
  for (const w of [...watchers]) {
    w();
  }
}

offChannel = subscribeWalkieChannel(onChannelFlip);
reconcileStrandedHold();

/** Test seam: return the module to its just-imported state. Production
 * never calls this — the store lives as long as the app does. */
export function __resetWalkieSessionForTests(): void {
  runtime = null;
  offPeers?.();
  offPeers = null;
  offCall?.();
  offCall = null;
  offChannel?.();
  offChannel = subscribeWalkieChannel(onChannelFlip);
  offSettled?.();
  offSettled = null;
  deferredDebt = false;
  adoptedIncarnation = null;
  adoptedAt = null;
  parkReason = 'none';
  watchGen = 0;
  watchOwes = false;
  watchDone = true;
  holdGen = 0;
  holdOwner = 0;
  pendingStarts = 0;
  ringingCallId = null;
  lifecycle = Promise.resolve();
  callWatchers.clear();
  state = EMPTY;
  revision += 1;
  for (const w of watchers) {
    w();
  }
}
