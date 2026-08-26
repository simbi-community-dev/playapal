/**
 * The video-call lifecycle (docs/VIDEO-CALLS.md §3), as a pure reducer.
 *
 * A call is a LIFECYCLE, not a demo transition: it rings, gets answered or
 * declined, ends from either side, survives the peer walking out of range
 * only by saying so honestly, and pauses its camera when the app
 * backgrounds. Every one of those arcs is a (state, event) -> (state,
 * effects) row here, with no I/O — the runtime (callRuntime.ts) owns
 * sockets, WebRTC and timers, and tests own this table completely.
 *
 * Owner scope (2026-08-25): 1:1 between two pod members, opt-in via an
 * explicit call button — never ambient like the walkie.
 */

export type CallPhase =
  | 'idle'
  | 'calling' // outbound — their phone is ringing (or we hope it is)
  | 'ringing' // inbound — our screen is asking
  | 'connecting' // both said yes; media is being negotiated
  | 'live'
  | 'ended'; // showing WHY, until dismissed

export type CallEndReason =
  | 'declined'
  | 'busy'
  | 'no-answer'
  | 'missed'
  | 'hung-up'
  | 'lost'
  | 'no-path'
  | 'unreachable'
  | 'permission';

export interface CallModel {
  phase: CallPhase;
  callId: string | null;
  peerHash: number | null;
  peerName: string | null;
  /** The caller makes the SDP offer; the answerer answers. Decided once,
   * at accept time, so glare cannot happen. */
  offerer: boolean;
  /** The user tapped "mute video". Survives backgrounding. */
  userMuted: boolean;
  /** The camper muted their MICROPHONE (the owner's field ask after the
   * first real call: camera mute existed, mic mute did not). Video-only:
   * the walkie's half-duplex owns the PTT mic. */
  micMuted: boolean;
  /** The app is backgrounded — camera off regardless of userMuted. */
  backgrounded: boolean;
  endedReason: CallEndReason | null;
}

export const idleCall: CallModel = {
  phase: 'idle',
  callId: null,
  peerHash: null,
  peerName: null,
  offerer: false,
  userMuted: false,
  micMuted: false,
  backgrounded: false,
  endedReason: null,
};

export type CallEvent =
  | { type: 'place'; peerHash: number; peerName: string; call: string }
  | { type: 'invite'; from: number; name: string; call: string }
  | { type: 'answer' }
  | { type: 'decline' }
  | { type: 'hangup' }
  | { type: 'dismiss' }
  | { type: 'remote-accept'; call: string }
  | { type: 'remote-decline'; call: string }
  | { type: 'remote-busy'; call: string }
  | { type: 'bye'; call: string }
  | { type: 'media-up' }
  | { type: 'media-failed'; why: 'permission' | 'other' }
  | { type: 'link-failed' }
  /** The transport gave up on PEER `from` (SIGNAL_MAX_TRIES of silence).
   * Carries the hash because a runtime keeps one signaler per peer: a
   * stale bye dying toward a phone that left must not read as the ACTIVE
   * call's transport failing. */
  | { type: 'signal-dead'; from: number }
  | { type: 'ring-timeout' }
  | { type: 'connect-timeout' }
  | { type: 'peer-gone'; hash: number }
  | { type: 'toggle-video' }
  | { type: 'toggle-mic' }
  | { type: 'app-background' }
  | { type: 'app-foreground' };

export type CallEffect =
  | { do: 'send'; to: number; msg: Record<string, unknown> }
  | { do: 'open-media' }
  | { do: 'apply-mic'; on: boolean }
  | { do: 'close-media' }
  | { do: 'arm-ring-timeout' }
  | { do: 'arm-connect-timeout' }
  | { do: 'clear-timers' }
  | { do: 'apply-video'; on: boolean };

/** How long an unanswered ring keeps ringing before the honest "no
 * answer". Thirty seconds — a phone in a dusty pocket deserves a while. */
export const CALL_RING_TIMEOUT_MS = 30_000;

/** How long media negotiation may take after both sides said yes. Twenty
 * seconds is geological for a LAN handshake — past it, the path is not
 * there (two routers, isolated AP), and the copy says so. */
export const CALL_CONNECT_TIMEOUT_MS = 20_000;

/** Is the camera supposed to be sending right now? */
export function callVideoOn(m: CallModel): boolean {
  return !m.userMuted && !m.backgrounded;
}

/**
 * The walkie's PTT is SUPPRESSED while a call holds the mic (decision,
 * docs/VIDEO-CALLS.md §5): WebRTC's audio unit and the walkie's raw
 * AudioRecord would contend for one microphone with no arbitration, and a
 * call's loudspeaker feeding the walkie's open mic is an echo machine.
 * The pod's ASYNC lane (voice notes, messages) is untouched.
 */
export function walkiePttSuppressed(phase: CallPhase): boolean {
  return phase === 'connecting' || phase === 'live';
}

export const PTT_SUPPRESSED_COPY =
  'The call has the mic — hang up to talk to the whole pod. Voice notes still send.';

/** The honest sentence for each way a call ends. `stillLofi` is evidence,
 * never hope: pass true ONLY for a proven lo-fi row (rung 'ble'), and the
 * unreachable sentence gains its working alternative. A 'stale' row has no
 * pipe under it, so routing there would be the same overclaim the (quiet)
 * badge exists to end. */
export function callEndedCopy(
  reason: CallEndReason,
  peerName: string | null,
  stillLofi?: boolean,
): string {
  const who = peerName || 'Your podmate';
  const base = (() => {
    switch (reason) {
      case 'declined':
        return `${who} can't talk right now.`;
      case 'busy':
        return `${who} is already on a call.`;
      case 'no-answer':
        return `No answer from ${who}. A voice note keeps until they see it.`;
      case 'missed':
        return `${who} called — they hung up before you answered.`;
      case 'hung-up':
        return `${who} hung up.`;
      case 'lost':
        return `The link to ${who} dropped, so the call ended. They may be out of range.`;
      case 'no-path':
        return (
          'Your phones can signal each other, but the video stream ' +
          "couldn't get through — a call needs both phones on the same " +
          'Wi-Fi. Turn on Camp hotspot under your pod and one Android makes ' +
          'that Wi-Fi itself. A voice note reaches them either way.'
        );
      case 'unreachable':
        // The transport's verdict, in the transport's own words: the
        // invite never left the phone. 'no-answer' here said "they
        // ignored you" about a person who never heard a ring.
        return `Couldn't get through to ${who} — their link went quiet. A voice note keeps until they see it.`;
      case 'permission':
        return 'Playa Pal needs the camera and microphone for a video call — allow them and call again.';
    }
  })();
  return reason === 'unreachable' && stillLofi
    ? `${base} They still come through on the walkie, rougher — hold the talk button.`
    : base;
}

interface Step {
  model: CallModel;
  effects: CallEffect[];
}

const same = (m: CallModel): Step => ({ model: m, effects: [] });

function end(
  m: CallModel,
  reason: CallEndReason,
  effects: CallEffect[],
): Step {
  return {
    model: { ...m, phase: 'ended', endedReason: reason },
    effects,
  };
}

/** An active call's teardown always closes media and clears timers —
 * forgetting either is a hot camera or a stray timeout firing into the
 * next call. */
const TEARDOWN: CallEffect[] = [{ do: 'clear-timers' }, { do: 'close-media' }];

export function reduceCall(m: CallModel, e: CallEvent): Step {
  // An invite is the one event whose handling ignores the current call id:
  // a second caller during any active call is told 'busy' without
  // disturbing the call — and busy is a fact about this phone, not a
  // judgment the callee is asked to make.
  if (e.type === 'invite') {
    if (m.phase === 'idle' || m.phase === 'ended') {
      return {
        model: {
          ...idleCall,
          phase: 'ringing',
          callId: e.call,
          peerHash: e.from,
          peerName: e.name,
          offerer: false,
        },
        // The callee arms its own terminal timer: the designed exit is
        // the caller's bye at ITS ring timeout, but a caller whose phone
        // dies (dozes, walkie closes) between invite and bye left this
        // screen ringing until the panel closed. Same window as the
        // caller's — the two clocks give up together, give or take loss.
        effects: [{ do: 'arm-ring-timeout' }],
      };
    }
    if (e.call === m.callId) {
      return same(m); // the caller's retransmitted invite, already ringing
    }
    return {
      model: m,
      effects: [{ do: 'send', to: e.from, msg: { t: 'busy', call: e.call } }],
    };
  }

  // Remote events must belong to THIS call — a stale bye from a call that
  // already ended must not kill its successor.
  if (
    (e.type === 'remote-accept' ||
      e.type === 'remote-decline' ||
      e.type === 'remote-busy' ||
      e.type === 'bye') &&
    e.call !== m.callId
  ) {
    return same(m);
  }

  switch (m.phase) {
    case 'idle':
    case 'ended': {
      if (e.type === 'place') {
        return {
          model: {
            ...idleCall,
            phase: 'calling',
            callId: e.call,
            peerHash: e.peerHash,
            peerName: e.peerName,
            offerer: true,
          },
          effects: [
            {
              do: 'send',
              to: e.peerHash,
              msg: { t: 'invite', call: e.call },
            },
            { do: 'arm-ring-timeout' },
          ],
        };
      }
      if (m.phase === 'ended' && e.type === 'dismiss') {
        return { model: idleCall, effects: [] };
      }
      return same(m);
    }

    case 'calling': {
      switch (e.type) {
        case 'remote-accept':
          return {
            model: { ...m, phase: 'connecting' },
            effects: [
              { do: 'clear-timers' },
              { do: 'open-media' },
              { do: 'arm-connect-timeout' },
            ],
          };
        case 'remote-decline':
          return end(m, 'declined', [{ do: 'clear-timers' }]);
        case 'remote-busy':
          return end(m, 'busy', [{ do: 'clear-timers' }]);
        case 'signal-dead':
          if (e.from !== m.peerHash) {
            // A dead message to some OTHER phone (a stale bye, a busy to
            // a caller who left) says nothing about THIS call.
            return same(m);
          }
          // Not one invite was acked: the TRANSPORT's verdict, and it
          // deserves the transport's sentence. Falling through to
          // 'no-answer' said "they ignored you" about an invite that
          // never left this phone (audit case 3, 2026-08-25 dust bench).
          return end(m, 'unreachable', [
            { do: 'clear-timers' },
            {
              do: 'send',
              to: m.peerHash!,
              msg: { t: 'bye', call: m.callId },
            },
          ]);
        case 'ring-timeout':
          return end(m, 'no-answer', [
            { do: 'clear-timers' },
            {
              do: 'send',
              to: m.peerHash!,
              msg: { t: 'bye', call: m.callId },
            },
          ]);
        case 'hangup':
          return {
            model: idleCall,
            effects: [
              { do: 'clear-timers' },
              {
                do: 'send',
                to: m.peerHash!,
                msg: { t: 'bye', call: m.callId },
              },
            ],
          };
        case 'bye':
          // The callee's phone saw the invite and its user is gone — or
          // their walkie closed. Either way: nobody is coming.
          return end(m, 'no-answer', [{ do: 'clear-timers' }]);
        case 'peer-gone':
          return e.hash === m.peerHash
            ? end(m, 'lost', [{ do: 'clear-timers' }])
            : same(m);
        default:
          return same(m);
      }
    }

    case 'ringing': {
      switch (e.type) {
        case 'answer':
          return {
            model: { ...m, phase: 'connecting' },
            effects: [
              // clear-timers first: the ring timer armed at invite must
              // not fire 'ring-timeout' into the connecting call.
              { do: 'clear-timers' },
              {
                do: 'send',
                to: m.peerHash!,
                msg: { t: 'accept', call: m.callId },
              },
              { do: 'open-media' },
              { do: 'arm-connect-timeout' },
            ],
          };
        case 'decline':
          return {
            model: idleCall,
            effects: [
              { do: 'clear-timers' },
              {
                do: 'send',
                to: m.peerHash!,
                msg: { t: 'decline', call: m.callId },
              },
            ],
          };
        case 'ring-timeout':
          // The caller went dark without a bye (dead battery, doze, a
          // closed walkie): stop ringing for a phone that is not coming.
          // Reads as 'missed', the same truth their mid-ring bye tells.
          return end(m, 'missed', [{ do: 'clear-timers' }]);
        case 'bye':
          return end(m, 'missed', [{ do: 'clear-timers' }]);
        case 'peer-gone':
          return e.hash === m.peerHash
            ? end(m, 'lost', [{ do: 'clear-timers' }])
            : same(m);
        default:
          return same(m);
      }
    }

    case 'connecting':
    case 'live': {
      switch (e.type) {
        case 'media-up':
          return m.phase === 'connecting'
            ? {
                model: { ...m, phase: 'live' },
                effects: [{ do: 'clear-timers' }],
              }
            : same(m);
        case 'media-failed':
          return end(
            m,
            e.why === 'permission' ? 'permission' : 'no-path',
            [
              ...TEARDOWN,
              {
                do: 'send',
                to: m.peerHash!,
                msg: { t: 'bye', call: m.callId },
              },
            ],
          );
        case 'connect-timeout':
          return end(m, 'no-path', [
            ...TEARDOWN,
            {
              do: 'send',
              to: m.peerHash!,
              msg: { t: 'bye', call: m.callId },
            },
          ]);
        case 'bye':
          return end(m, 'hung-up', TEARDOWN);
        case 'hangup':
          return {
            model: idleCall,
            effects: [
              ...TEARDOWN,
              {
                do: 'send',
                to: m.peerHash!,
                msg: { t: 'bye', call: m.callId },
              },
            ],
          };
        case 'link-failed':
          return end(m, 'lost', TEARDOWN);
        case 'signal-dead':
          // Identity-gated like peer-gone below: only the active call's
          // peer going silent tears the call down. Mutation: drop the
          // gate — a stale bye to the LAST call's peer dies mid-call and
          // ends a healthy call with the wrong sentence.
          return e.from === m.peerHash ? end(m, 'lost', TEARDOWN) : same(m);
        case 'peer-gone':
          return e.hash === m.peerHash ? end(m, 'lost', TEARDOWN) : same(m);
        case 'toggle-video': {
          const next = { ...m, userMuted: !m.userMuted };
          return {
            model: next,
            effects: [{ do: 'apply-video', on: callVideoOn(next) }],
          };
        }
        case 'toggle-mic': {
          // No background coupling on purpose: a pocketed phone mid-call
          // keeps carrying voice unless the camper themselves muted.
          const next = { ...m, micMuted: !m.micMuted };
          return {
            model: next,
            effects: [{ do: 'apply-mic', on: !next.micMuted }],
          };
        }
        case 'app-background': {
          const next = { ...m, backgrounded: true };
          return {
            model: next,
            effects: [{ do: 'apply-video', on: false }],
          };
        }
        case 'app-foreground': {
          const next = { ...m, backgrounded: false };
          return {
            model: next,
            effects: [{ do: 'apply-video', on: callVideoOn(next) }],
          };
        }
        default:
          return same(m);
      }
    }
  }
}
