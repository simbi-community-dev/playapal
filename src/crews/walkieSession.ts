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
import { CallRuntime, callsPresent, type CallSnapshot } from './callRuntime';
import { ensureCrewPermissions } from './radio';
import { holdCrewAdvertising, releaseCrewAdvertising } from './share';
import {
  dedupeWalkiePeers,
  formatChannelNames,
  onWalkiePeers,
  setWalkieCallMuted,
  startWalkie,
  stopTalking,
  stopWalkie,
  subscribeWalkieChannel,
  walkieChannelRevision,
  walkieOn,
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
/** Re-entrancy guard for the one teardown path — see stopWalkieSession. */
let stopping = false;

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
export async function startWalkieSession(id: WalkieSessionId): Promise<void> {
  if (state.session?.crewId === id.crewId && walkieOn()) {
    set({ session: id }); // a renamed camper, same channel
    return;
  }
  if (state.session) {
    await stopWalkieSession();
  }
  await ensureCrewPermissions().catch(() => false);
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
  await holdCrewAdvertising().catch(() => undefined);
  await startWalkie(id.crewCode, id.myCardId, id.myName);

  offPeers = onWalkiePeers(p => {
    const peerRows = dedupeWalkiePeers(p.peers);
    set({ peers: p.entries, peerRows, talkingTo: p.talkingTo });
    // The call watches the roster with the panel CLOSED too: a call peer
    // who stays gone must tear the call down with the honest sentence, and
    // whether the camper is looking at the stage has nothing to do with it.
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
export async function stopWalkieSession(): Promise<void> {
  if (stopping) {
    // stopWalkie's own revision bump lands the channel watcher below back
    // in here mid-teardown; one stop is one stop.
    return;
  }
  stopping = true;
  try {
    const rt = runtime;
    runtime = null;
    offCall?.();
    offCall = null;
    offPeers?.();
    offPeers = null;
    noteRing(null);
    set({ ...EMPTY });
    rt?.destroy();
    await stopTalking();
    void setWalkieCallMuted(false);
    await stopWalkie();
    // …and the crew beacon gets its slot back, AFTER the walkie's own
    // advertiser is down — the mirror of the hold above, in the same order
    // and for the same reason: the two must never be on the air together.
    // Fail-soft again; the sharing session's own cadence tick re-advertises
    // within 15 s if this one did not land.
    await releaseCrewAdvertising().catch(() => undefined);
  } finally {
    stopping = false;
  }
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
  return s.session !== null && !s.panelOpen;
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
  ringingCallId = null;
  stopping = false;
  callWatchers.clear();
  state = EMPTY;
  revision += 1;
  for (const w of watchers) {
    w();
  }
}
