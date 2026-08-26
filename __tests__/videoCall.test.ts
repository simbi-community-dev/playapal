/**
 * The video-call lifecycle (src/crews/videoCall.ts). A call is a
 * LIFECYCLE, not a demo transition — this suite walks every arc the field
 * will produce: ring, answer, decline from either side, hang up from
 * either side, the caller giving up, the peer walking out of range, media
 * that cannot connect, the app backgrounding. Each test names the
 * mutation it dies on.
 */
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_RING_TIMEOUT_MS,
  PTT_SUPPRESSED_COPY,
  callEndedCopy,
  callVideoOn,
  idleCall,
  reduceCall,
  walkiePttSuppressed,
  type CallEffect,
  type CallEvent,
  type CallModel,
} from '../src/crews/videoCall';

const PEER = 0xabcd1234;

function run(events: CallEvent[], from: CallModel = idleCall) {
  let model = from;
  const effects: CallEffect[] = [];
  for (const e of events) {
    const step = reduceCall(model, e);
    model = step.model;
    effects.push(...step.effects);
  }
  return { model, effects };
}

const does = (effects: CallEffect[], kind: CallEffect['do']) =>
  effects.filter(e => e.do === kind);
const sent = (effects: CallEffect[], t: string) =>
  effects.filter(e => e.do === 'send' && (e.msg as { t?: string }).t === t);

describe('the caller’s arc', () => {
  test('placing a call rings the peer and arms the give-up timer', () => {
    // Mutation: drop arm-ring-timeout — an unanswered call rings forever.
    const { model, effects } = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
    ]);
    expect(model.phase).toBe('calling');
    expect(model.offerer).toBe(true);
    expect(sent(effects, 'invite')).toHaveLength(1);
    expect(does(effects, 'arm-ring-timeout')).toHaveLength(1);
  });

  test('accept -> connecting opens media; media-up -> live', () => {
    const { model, effects } = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]);
    expect(model.phase).toBe('live');
    expect(does(effects, 'open-media')).toHaveLength(1);
    expect(does(effects, 'arm-connect-timeout')).toHaveLength(1);
  });

  test('decline and busy end with their own honest reasons', () => {
    expect(
      run([
        { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
        { type: 'remote-decline', call: 'c1' },
      ]).model.endedReason,
    ).toBe('declined');
    expect(
      run([
        { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
        { type: 'remote-busy', call: 'c1' },
      ]).model.endedReason,
    ).toBe('busy');
  });

  test('ring timeout gives up out loud and tells the peer to stop ringing', () => {
    // Mutation: no bye on timeout — the callee's screen rings for a
    // caller who already gave up.
    const { model, effects } = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'ring-timeout' },
    ]);
    expect(model.phase).toBe('ended');
    expect(model.endedReason).toBe('no-answer');
    expect(sent(effects, 'bye')).toHaveLength(1);
  });

  test('cancelling an unanswered call returns to idle and says bye', () => {
    const { model, effects } = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'hangup' },
    ]);
    expect(model.phase).toBe('idle');
    expect(sent(effects, 'bye')).toHaveLength(1);
  });
});

describe('the callee’s arc', () => {
  test('an invite rings; answering accepts and opens media', () => {
    const { model, effects } = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'answer' },
    ]);
    expect(model.phase).toBe('connecting');
    expect(model.offerer).toBe(false); // Mutation: both offer — glare
    expect(sent(effects, 'accept')).toHaveLength(1);
    expect(does(effects, 'open-media')).toHaveLength(1);
  });

  test('declining writes nothing and tells the caller', () => {
    const { model, effects } = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'decline' },
    ]);
    expect(model).toEqual(idleCall);
    expect(sent(effects, 'decline')).toHaveLength(1);
  });

  test('a caller who hangs up mid-ring reads as a missed call, not silence', () => {
    const { model } = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'bye', call: 'c2' },
    ]);
    expect(model.phase).toBe('ended');
    expect(model.endedReason).toBe('missed');
  });

  test('the caller’s retransmitted invite does not restart the ring', () => {
    // Mutation: treat every invite as new — the ring UI flickers once a
    // second for as long as the ack is lost.
    const first = run([{ type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' }]);
    const again = reduceCall(first.model, {
      type: 'invite',
      from: PEER,
      name: 'Sparkle',
      call: 'c2',
    });
    expect(again.model).toEqual(first.model);
    expect(again.effects).toEqual([]);
  });
});

describe('busy is a fact about the phone, not a question for the callee', () => {
  test('a second caller during a live call is told busy automatically', () => {
    // Mutation: ring over the live call — the current call's tile is
    // replaced by a ring the user never asked to arbitrate.
    const live = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]).model;
    const step = reduceCall(live, {
      type: 'invite',
      from: 0x9999,
      name: 'Marisol',
      call: 'c9',
    });
    expect(step.model).toEqual(live);
    expect(sent(step.effects, 'busy')).toHaveLength(1);
    expect((sent(step.effects, 'busy')[0] as { to: number }).to).toBe(0x9999);
  });

  test('a stale bye from an old call cannot kill the new one', () => {
    // Mutation: skip the call-id gate — a delayed bye from the last call
    // tears down its successor.
    const live = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]).model;
    const step = reduceCall(live, { type: 'bye', call: 'OLD' });
    expect(step.model).toEqual(live);
    expect(step.effects).toEqual([]);
  });
});

describe('teardown is honest and complete from every direction', () => {
  const live = () =>
    run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]).model;

  test('local hangup closes media and says bye', () => {
    // Mutation: drop close-media — the camera stays hot after hang-up,
    // the worst state a camera has.
    const step = reduceCall(live(), { type: 'hangup' });
    expect(step.model.phase).toBe('idle');
    expect(does(step.effects, 'close-media')).toHaveLength(1);
    expect(sent(step.effects, 'bye')).toHaveLength(1);
  });

  test('a remote bye ends with "hung up" and closes media', () => {
    const step = reduceCall(live(), { type: 'bye', call: 'c1' });
    expect(step.model.endedReason).toBe('hung-up');
    expect(does(step.effects, 'close-media')).toHaveLength(1);
  });

  test('the peer vanishing tears the call down with the honest sentence', () => {
    // THE OWNER-VISIBLE ONE. Mutation: ignore peer-gone — a frozen tile
    // and silence, indistinguishable from "the app broke".
    const step = reduceCall(live(), { type: 'peer-gone', hash: PEER });
    expect(step.model.endedReason).toBe('lost');
    expect(does(step.effects, 'close-media')).toHaveLength(1);
    const copy = callEndedCopy('lost', 'Dusty');
    expect(copy).toContain('Dusty');
    expect(copy).toMatch(/dropped/);
  });

  test('someone ELSE vanishing does not touch the call', () => {
    const step = reduceCall(live(), { type: 'peer-gone', hash: 0x1111 });
    expect(step.model.phase).toBe('live');
  });

  test('link failure and signal death read as lost, with media closed', () => {
    for (const e of [
      { type: 'link-failed' },
      { type: 'signal-dead', from: PEER },
    ] as CallEvent[]) {
      const step = reduceCall(live(), e);
      expect(step.model.endedReason).toBe('lost');
      expect(does(step.effects, 'close-media')).toHaveLength(1);
    }
  });

  test('media that cannot connect becomes the no-path sentence, not a spinner', () => {
    const connecting = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
    ]).model;
    const step = reduceCall(connecting, { type: 'connect-timeout' });
    expect(step.model.endedReason).toBe('no-path');
    const copy = callEndedCopy('no-path', 'Dusty');
    expect(copy).toMatch(/same Wi-Fi/);
    expect(copy).toMatch(/voice note/i); // async keeps equal billing
  });

  test('a denied camera says which permission and sends bye', () => {
    const connecting = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'answer' },
    ]).model;
    const step = reduceCall(connecting, {
      type: 'media-failed',
      why: 'permission',
    });
    expect(step.model.endedReason).toBe('permission');
    expect(sent(step.effects, 'bye')).toHaveLength(1);
    expect(callEndedCopy('permission', null)).toMatch(/camera and microphone/);
  });

  test('dismissing the ended card returns to idle, ready for the next call', () => {
    const ended = reduceCall(live(), { type: 'bye', call: 'c1' }).model;
    expect(reduceCall(ended, { type: 'dismiss' }).model).toEqual(idleCall);
  });
});

describe('signal-dead names its peer, and only the active call listens', () => {
  const live = () =>
    run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]).model;

  test('a dead message to some OTHER hash cannot end a live call', () => {
    // THE 0.8.2 BLOCKER, path B: live with Alice, a busy to Bob dies 8 s
    // after he left range. Mutation: drop the from-gate — the Alice call
    // ends with "the link dropped" while the link is fine.
    const step = reduceCall(live(), { type: 'signal-dead', from: 0x1111 });
    expect(step.model.phase).toBe('live');
    expect(step.effects).toEqual([]);
  });

  test('a stale bye dying mid-dial cannot end the NEW call', () => {
    // Path A: the bye to Sparkle (out of range) dies while Dusty's phone
    // is being dialled. Mutation: drop the gate in 'calling' — the Dusty
    // call reads "no answer" 4 s in, and its own bye poisons a third try.
    const calling = run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c2' },
    ]).model;
    const stale = reduceCall(calling, { type: 'signal-dead', from: 0x2222 });
    expect(stale.model.phase).toBe('calling');
    expect(stale.effects).toEqual([]);
    // ...while OUR peer's transport dying is the TRANSPORT's verdict, in
    // the transport's own words (audit case 3, 2026-08-25): the invite was
    // never acked, so 'no-answer' said "they ignored you" about a person
    // who never heard a ring. Mutation: restore the fall-through to
    // ring-timeout — the lie returns.
    const real = reduceCall(calling, { type: 'signal-dead', from: PEER });
    expect(real.model.endedReason).toBe('unreachable');
    expect(sent(real.effects, 'bye')).toHaveLength(1);
    const copy = callEndedCopy('unreachable', 'Dusty');
    expect(copy).toMatch(/link went quiet/);
    expect(copy).toMatch(/voice note/i); // async keeps equal billing
    expect(copy).not.toMatch(/no answer/i);
    // The walkie route rides EVIDENCE only: a proven lo-fi row appends the
    // alternative, its absence appends nothing, and no other ending gets it.
    expect(callEndedCopy('unreachable', 'Dusty', true)).toMatch(
      /hold the talk button/,
    );
    expect(callEndedCopy('unreachable', 'Dusty', false)).not.toMatch(
      /talk button/,
    );
    expect(callEndedCopy('no-answer', 'Dusty', true)).not.toMatch(
      /talk button/,
    );
  });
});

describe('the callee’s ring arms its own terminal timer', () => {
  test('an invite arms the ring timeout', () => {
    // Mutation: return effects: [] from the invite arm — a caller whose
    // phone dies before its bye leaves this screen ringing until the
    // panel is closed.
    const { effects } = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
    ]);
    expect(does(effects, 'arm-ring-timeout')).toHaveLength(1);
  });

  test('a caller that went dark without a bye stops ringing as missed', () => {
    // Mutation: leave 'ring-timeout' unhandled in 'ringing' — the armed
    // timer fires into a switch with no case and the ring is eternal.
    const { model, effects } = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'ring-timeout' },
    ]);
    expect(model.phase).toBe('ended');
    expect(model.endedReason).toBe('missed');
    expect(does(effects, 'clear-timers')).toHaveLength(1);
  });

  test('answering and declining clear the ring timer', () => {
    // Mutation: drop clear-timers from either arm — the invite's timer
    // fires 'ring-timeout' into the connecting (or the NEXT) call.
    const answered = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'answer' },
    ]);
    expect(does(answered.effects, 'clear-timers')).toHaveLength(1);
    const declined = run([
      { type: 'invite', from: PEER, name: 'Sparkle', call: 'c2' },
      { type: 'decline' },
    ]);
    expect(does(declined.effects, 'clear-timers')).toHaveLength(1);
  });
});

describe('camera state: mute and backgrounding compose', () => {
  const live = () =>
    run([
      { type: 'place', peerHash: PEER, peerName: 'Dusty', call: 'c1' },
      { type: 'remote-accept', call: 'c1' },
      { type: 'media-up' },
    ]).model;

  test('toggle-video mutes and unmutes with matching apply-video effects', () => {
    const a = reduceCall(live(), { type: 'toggle-video' });
    expect(a.model.userMuted).toBe(true);
    expect(a.effects).toEqual([{ do: 'apply-video', on: false }]);
    const b = reduceCall(a.model, { type: 'toggle-video' });
    expect(b.effects).toEqual([{ do: 'apply-video', on: true }]);
  });

  test('backgrounding pauses video; foreground resumes only if not muted', () => {
    // Mutation: resume unconditionally — foregrounding un-mutes a camera
    // the user deliberately turned off.
    const bg = reduceCall(live(), { type: 'app-background' });
    expect(bg.effects).toEqual([{ do: 'apply-video', on: false }]);
    const muted = reduceCall(bg.model, { type: 'toggle-video' }).model;
    const fg = reduceCall(muted, { type: 'app-foreground' });
    expect(fg.effects).toEqual([{ do: 'apply-video', on: false }]);
    expect(callVideoOn(fg.model)).toBe(false);
    const fgUnmuted = reduceCall(bg.model, { type: 'app-foreground' });
    expect(fgUnmuted.effects).toEqual([{ do: 'apply-video', on: true }]);
  });
});

describe('the walkie during a call', () => {
  test('PTT is suppressed exactly while the call owns the mic', () => {
    // Mutation: suppress in 'calling' too — a caller waiting on an
    // unanswered ring loses the walkie for no reason; or fail to suppress
    // in 'live' — two recorders fight for the mic and the pod hears the
    // call's loudspeaker as echo.
    expect(walkiePttSuppressed('idle')).toBe(false);
    expect(walkiePttSuppressed('calling')).toBe(false);
    expect(walkiePttSuppressed('ringing')).toBe(false);
    expect(walkiePttSuppressed('connecting')).toBe(true);
    expect(walkiePttSuppressed('live')).toBe(true);
    expect(walkiePttSuppressed('ended')).toBe(false);
    expect(PTT_SUPPRESSED_COPY).toMatch(/hang up/i);
    expect(PTT_SUPPRESSED_COPY).toMatch(/voice note/i);
  });
});

describe('the timers are the design’s numbers', () => {
  test('ring and connect windows match the doc', () => {
    expect(CALL_RING_TIMEOUT_MS).toBe(30_000);
    expect(CALL_CONNECT_TIMEOUT_MS).toBe(20_000);
  });
});


describe('mic mute (the owner\'s first-real-call ask)', () => {
  test('toggle-mic flips the flag and applies the track state, both directions', () => {
    // Mutation: drop the apply-mic effect — the flag flips while the track
    // keeps sending; the button becomes a lie.
    const live = { ...idleCall, phase: 'live' as const, peerHash: 7, peerName: 'Star Hare' };
    const a = reduceCall(live, { type: 'toggle-mic' });
    expect(a.model.micMuted).toBe(true);
    expect(a.effects).toContainEqual({ do: 'apply-mic', on: false });
    const b = reduceCall(a.model, { type: 'toggle-mic' });
    expect(b.model.micMuted).toBe(false);
    expect(b.effects).toContainEqual({ do: 'apply-mic', on: true });
  });
});
