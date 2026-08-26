/**
 * Call signaling over the walkie wire (src/crews/callSignal.ts): the
 * chunker that keeps every payload under the native receive buffer, the
 * reassembler that survives loss/duplication/reordering, and the
 * retransmit-until-acked layer that turns UDP into something a call
 * lifecycle can stand on. Each test names the mutation it dies on.
 */
import {
  ReliableSignaler,
  SIGNAL_CHUNK_DATA_MAX,
  SIGNAL_CHUNK_HEADER,
  SIGNAL_HEDGE_FANOUT,
  SIGNAL_MAX_PARTIALS,
  SIGNAL_MAX_TRIES,
  SIGNAL_RETRY_MS,
  SignalReassembler,
  WALKIE_SIGNAL_MAX_PAYLOAD,
  b64Decode,
  b64Encode,
  encodeSignalChunks,
  utf8Decode,
  utf8Encode,
  type SignalEnvelope,
} from '../src/crews/callSignal';

describe('utf8 + base64, hand-rolled so no Hermes global is load-bearing', () => {
  test('round-trips ascii, accents and astral-plane emoji', () => {
    // Mutation: break surrogate-pair handling — every name with an emoji
    // in it corrupts in transit, silently.
    for (const s of ['hello', 'Señora Dusty', '🔥🎪 playa 🚲', '']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
      expect(utf8Decode(b64Decode(b64Encode(utf8Encode(s))))).toBe(s);
    }
  });

  test('base64 handles every padding length', () => {
    // Mutation: drop the '=' handling and 1-in-3 payload lengths corrupt.
    for (const len of [0, 1, 2, 3, 4, 5, 599, 600, 601]) {
      const b = Uint8Array.from({ length: len }, (_, i) => (i * 37) & 0xff);
      expect([...b64Decode(b64Encode(b))]).toEqual([...b]);
    }
  });
});

describe('chunking respects the native frame budget', () => {
  test('every chunk fits the wire, including the header', () => {
    // THE LOAD-BEARING ONE. The Android receive loop reuses one
    // HEADER+640-byte buffer; a longer datagram arrives TRUNCATED, not
    // errored. Mutation: raise SIGNAL_CHUNK_DATA_MAX past the buffer and
    // every SDP silently loses its tail on one platform.
    const big = JSON.stringify({ t: 'sdp', sdp: 'v'.repeat(5000) });
    const chunks = encodeSignalChunks(7, big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(b64Decode(c).length).toBeLessThanOrEqual(
        WALKIE_SIGNAL_MAX_PAYLOAD,
      );
    }
    expect(WALKIE_SIGNAL_MAX_PAYLOAD).toBe(
      SIGNAL_CHUNK_HEADER + SIGNAL_CHUNK_DATA_MAX,
    );
  });

  test('reassembly survives reordering', () => {
    // Mutation: concatenate in arrival order instead of index order and a
    // reordered SDP parses as garbage.
    const msg = JSON.stringify({ t: 'sdp', sdp: 'x'.repeat(1500) });
    const chunks = encodeSignalChunks(42, msg).map(b64Decode);
    const r = new SignalReassembler();
    expect(r.feed(chunks[2])).toBeNull();
    expect(r.feed(chunks[0])).toBeNull();
    const done = r.feed(chunks[1]);
    expect(done?.json).toBe(msg);
    expect(done?.msgId).toBe(42);
  });

  test('duplicates and completed messages never deliver twice', () => {
    // Mutation: drop the done-set — every retransmit of an already-heard
    // "accept" re-fires the call machine. The duplicate must still be
    // REPORTED (dup: true), because it means our ack was lost and the
    // peer needs another one — but its content never re-delivers.
    const msg = JSON.stringify({ t: 'accept', call: 'abc' });
    const chunks = encodeSignalChunks(9, msg).map(b64Decode);
    const r = new SignalReassembler();
    const first = r.feed(chunks[0]);
    expect(first?.json).toBe(msg);
    expect(first?.dup).toBeUndefined();
    expect(r.feed(chunks[0])).toEqual({ msgId: 9, json: '', dup: true });
  });

  test('permanently incomplete messages are bounded, oldest evicted first', () => {
    // Mutation: drop the eviction in feed() — every message that lost a
    // chunk for good (UDP on a lossy playa link) holds its buffers for
    // the process lifetime, and the docstring's "bounded memory" claim
    // is true of only the done-id half.
    const msg = JSON.stringify({ t: 'sdp', sdp: 'x'.repeat(900) }); // 2 chunks
    const chunksFor = (id: number) => encodeSignalChunks(id, msg).map(b64Decode);
    for (let id = 1; id <= SIGNAL_MAX_PARTIALS; id++) {
      expect(r0.feed(chunksFor(id)[0])).toBeNull();
    }
    // One more incomplete message evicts the OLDEST (id 1)...
    expect(r0.feed(chunksFor(SIGNAL_MAX_PARTIALS + 1)[0])).toBeNull();
    // ...so id 1's second chunk no longer completes it (its first chunk
    // is gone; a full retransmit round recovers it, which is the cost).
    expect(r0.feed(chunksFor(1)[1])).toBeNull();
    expect(r0.feed(chunksFor(1)[0])?.json).toBe(msg);
    // The youngest partial survived the churn and still completes.
    expect(r0.feed(chunksFor(SIGNAL_MAX_PARTIALS + 1)[1])?.json).toBe(msg);
  });
  const r0 = new SignalReassembler();

  test('a torn header is dropped, never thrown', () => {
    const r = new SignalReassembler();
    expect(r.feed(Uint8Array.from([1, 2, 3]))).toBeNull();
    // total = 0 and idx >= total are both wire corruption
    expect(r.feed(Uint8Array.from([0, 0, 0, 1, 0, 0, 65]))).toBeNull();
    expect(r.feed(Uint8Array.from([0, 0, 0, 1, 5, 2, 65]))).toBeNull();
  });
});

describe('reliable delivery: retransmit until acked, then give up honestly', () => {
  /** Two signalers wired through lossy-controllable pipes. */
  function pair() {
    const aOut: string[] = [];
    const bOut: string[] = [];
    const aGot: SignalEnvelope[] = [];
    const bGot: SignalEnvelope[] = [];
    const aDead: SignalEnvelope[] = [];
    let nextA = 1;
    let nextB = 1000;
    const a = new ReliableSignaler(
      p => aOut.push(p),
      env => aGot.push(env),
      env => aDead.push(env),
      () => nextA++,
    );
    const b = new ReliableSignaler(
      p => bOut.push(p),
      env => bGot.push(env),
      () => {},
      () => nextB++,
    );
    return { a, b, aOut, bOut, aGot, bGot, aDead };
  }

  const pump = (
    from: string[],
    to: ReliableSignaler,
    now: number,
  ): void => {
    for (const p of from.splice(0)) {
      to.receive(p, now);
    }
  };

  test('a delivered message is acked and retransmission stops', () => {
    const { a, b, aOut, bOut, bGot } = pair();
    a.post({ t: 'invite', call: 'c1' }, 0);
    expect(aOut.length).toBe(1);
    pump(aOut, b, 5);
    expect(bGot).toEqual([{ t: 'invite', call: 'c1', id: 1 }]);
    pump(bOut, a, 10); // the ack comes home
    expect(a.busy()).toBe(false);
    a.tick(SIGNAL_RETRY_MS + 20);
    expect(aOut.length).toBe(0); // Mutation: ignore acks — resends forever
  });

  test('a lost first send is retransmitted and still delivers exactly once', () => {
    const { a, b, aOut, bOut, bGot } = pair();
    a.post({ t: 'accept', call: 'c2' }, 0);
    aOut.splice(0); // the first datagram dies in the dust
    a.tick(SIGNAL_RETRY_MS - 1);
    expect(aOut.length).toBe(0); // Mutation: retry early — doubles traffic
    a.tick(SIGNAL_RETRY_MS + 1);
    expect(aOut.length).toBe(1);
    pump(aOut, b, SIGNAL_RETRY_MS + 2);
    expect(bGot.length).toBe(1);
    // A duplicate retransmit (ack lost) is re-acked but not re-delivered.
    a.tick(2 * SIGNAL_RETRY_MS + 2);
    pump(aOut, b, 2 * SIGNAL_RETRY_MS + 3);
    expect(bGot.length).toBe(1);
    expect(bOut.length).toBeGreaterThanOrEqual(2); // acks kept coming
  });

  test('a peer that never answers becomes onDead after bounded tries', () => {
    // THE HONESTY ONE. Mutation: retry forever — a caller's screen says
    // "Calling…" until the battery dies instead of "no answer".
    const { a, aOut, aDead } = pair();
    a.post({ t: 'invite', call: 'c3' }, 0);
    let now = 0;
    for (let i = 0; i < SIGNAL_MAX_TRIES + 2; i++) {
      now += SIGNAL_RETRY_MS + 1;
      a.tick(now);
    }
    expect(aDead).toEqual([{ t: 'invite', call: 'c3' }]);
    expect(a.busy()).toBe(false);
    expect(aOut.length).toBe(SIGNAL_MAX_TRIES);
  });

  test('reset drops everything in flight: no retransmit, no late onDead', () => {
    // reset() is what the runtime calls when a peer's transport is
    // declared dead. Mutation: make it a no-op — the stale bye keeps
    // retrying and its onDead fires a SECOND signal-dead 8 s into
    // whatever call is active then (the 0.8.2 blocker's timeline).
    const { a, aOut, aDead } = pair();
    a.post({ t: 'bye', call: 'c9' }, 0);
    aOut.splice(0);
    a.reset();
    expect(a.busy()).toBe(false);
    let now = 0;
    for (let i = 0; i < SIGNAL_MAX_TRIES + 2; i++) {
      now += SIGNAL_RETRY_MS + 1;
      a.tick(now);
    }
    expect(aOut).toEqual([]);
    expect(aDead).toEqual([]);
  });

  test('acks are fire-and-forget: the receiver does not retransmit them', () => {
    // Mutation: track acks as pending — two phones ack each other's acks
    // forever, a packet storm on a shared camp LAN.
    const { a, b, aOut } = pair();
    a.post({ t: 'bye', call: 'c4' }, 0);
    pump(aOut, b, 1);
    b.tick(SIGNAL_RETRY_MS + 5);
    expect(b.busy()).toBe(false);
  });

  test('a multi-chunk message rides the same reliability', () => {
    const { a, b, aOut, bOut, bGot } = pair();
    a.post({ t: 'sdp', call: 'c5', sdp: 'q'.repeat(2000) }, 0);
    expect(aOut.length).toBe(4); // 2006-byte JSON < 4 × 600
    pump(aOut, b, 1);
    expect(bGot.length).toBe(1);
    expect((bGot[0].sdp as string).length).toBe(2000);
    pump(bOut, a, 2);
    expect(a.busy()).toBe(false);
  });
});

/**
 * RETRANSMISSION DIVERSITY (docs/VIDEO-CALLS.md §2a) — the residual race the
 * liveness lane left open, and the reason retrying harder was never going to
 * close it.
 *
 * THE MEASURED FAILURE: P9's invite rang P7 over the shared LAN while P7's
 * ACK died into P7's own stale Aware row for P9, eight times, erring nowhere,
 * and P9's screen read "No answer". Demotion takes up to ~12 s (4.5 s probe
 * cadence + a 10 s staleness window); the retransmit budget is 8 × 1 s. So a
 * signal fired in the first seconds after a path dies silently can spend
 * every try on a row that has not been demoted YET.
 *
 * Retransmission beats loss that is independent per try. This loss is a
 * property of the ROAD, so the fix is a second road, not a ninth try — and
 * dedupe-by-message-id already made a second copy harmless, which is what
 * makes hedging free.
 */
describe('a retransmission changes road, not just time', () => {
  /** A signaler whose every transmission is recorded WITH its fanout. */
  function recorder() {
    const sends: { payload: string; fanout: number }[] = [];
    const dead: SignalEnvelope[] = [];
    const got: SignalEnvelope[] = [];
    let next = 1;
    const s = new ReliableSignaler(
      (payload, fanout) => sends.push({ payload, fanout }),
      env => got.push(env),
      env => dead.push(env),
      () => next++,
    );
    return { s, sends, dead, got };
  }

  test('MUTATION hedge-absent: the first try is a single, every retry spreads', () => {
    // Mutation: transmit the retry with the same width as the first send —
    // the exact shipped behaviour that lost the measured call. All eight
    // copies ride the one row that is not delivering, the caller reads
    // "No answer", and nothing in the log says why.
    const { s, sends } = recorder();
    s.post({ t: 'invite', call: 'c1' }, 0);
    expect(sends.map(x => x.fanout)).toEqual([1]); // ordinary cost, unchanged
    s.tick(SIGNAL_RETRY_MS + 1);
    expect(sends.length).toBe(2);
    expect(sends[1].fanout).toBe(SIGNAL_HEDGE_FANOUT);
    // ...and it stays spread for the whole remaining budget, not just once.
    let now = SIGNAL_RETRY_MS + 1;
    for (let i = 0; i < 3; i++) {
      now += SIGNAL_RETRY_MS + 1;
      s.tick(now);
    }
    expect(sends.slice(1).every(x => x.fanout === SIGNAL_HEDGE_FANOUT)).toBe(
      true,
    );
    expect(sends.length).toBe(5);
  });

  test('MUTATION fanout-unbounded: no transmission may ask for a third row', () => {
    // Mutation: raise SIGNAL_HEDGE_FANOUT, or let a caller's number through
    // unclamped — a call's whole control channel lands on rows the ladder
    // deliberately ranked last, and a signal costs N datagrams where the
    // benefit stopped at two. The natives clamp too (videoWire.test.ts);
    // this is the JS half of the same bound.
    expect(SIGNAL_HEDGE_FANOUT).toBe(2);
    const { s, sends } = recorder();
    s.post({ t: 'sdp', call: 'c2', sdp: 'x'.repeat(1500) }, 0);
    s.noteSendMiss();
    s.post({ t: 'ice', call: 'c2' }, 0);
    let now = 0;
    for (let i = 0; i < SIGNAL_MAX_TRIES + 2; i++) {
      now += SIGNAL_RETRY_MS + 1;
      s.tick(now);
    }
    expect(sends.length).toBeGreaterThan(SIGNAL_MAX_TRIES); // it really ran
    expect(Math.max(...sends.map(x => x.fanout))).toBe(SIGNAL_HEDGE_FANOUT);
    expect(sends.every(x => x.fanout >= 1)).toBe(true);
  });

  test('MUTATION stale-reject-kills-signaler: a refused send is a miss, not a death', () => {
    // THE ONE THAT INVERTS THE FIX IF IT IS WRONG. Native rejects `stale`
    // when no row for this podmate has proven itself (WALKIE-LADDER §5b).
    // Mutation 1: fire onDead from that path — the call ends inside the
    // very ~12 s window this lane exists to survive, and a demotion that
    // heals on the next probe round trip becomes a hung-up call. Mutation
    // 2: count the reject as a try (or pull nextAt forward) — the eight
    // tries are spent in less wall-clock time, so the caller is told "no
    // answer" EARLIER than a silent drop would have told them.
    const { s, sends, dead } = recorder();
    s.post({ t: 'invite', call: 'c3' }, 0);
    s.noteSendMiss();
    s.noteSendMiss();
    s.noteSendMiss();
    expect(dead).toEqual([]);
    expect(s.busy()).toBe(true);
    // The clock is untouched: nothing new goes out before the retry window.
    s.tick(SIGNAL_RETRY_MS - 1);
    expect(sends.length).toBe(1);
    // The FULL budget is still there — eight transmissions, then honesty.
    let now = 0;
    for (let i = 0; i < SIGNAL_MAX_TRIES + 2; i++) {
      now += SIGNAL_RETRY_MS + 1;
      s.tick(now);
    }
    expect(sends.length).toBe(SIGNAL_MAX_TRIES);
    expect(dead).toEqual([{ t: 'invite', call: 'c3' }]);
    expect(s.busy()).toBe(false);
  });

  test('after a stale reject even a NEW message spreads on its first send', () => {
    // Mutation: only widen on retries — the reject already proved the best
    // row is not deliverable, so making the next message discover that the
    // slow way costs a whole second of a ringing phone's budget.
    const { s, sends } = recorder();
    s.noteSendMiss();
    s.post({ t: 'bye', call: 'c4' }, 0);
    expect(sends[0].fanout).toBe(SIGNAL_HEDGE_FANOUT);
  });

  test('an inbound frame is a row proving itself: back to singles', () => {
    // Mutation: leave the hedge latched — a link that flapped once pays
    // double for every signal for the rest of the call, and the "first
    // tries are singles" bound quietly stops being true.
    const { s, sends } = recorder();
    s.noteSendMiss();
    s.receive(encodeSignalChunks(77, JSON.stringify({ t: 'ack', of: 5 }))[0], 0);
    s.post({ t: 'ice', call: 'c5' }, 0);
    expect(sends.map(x => x.fanout)).toEqual([1]);
  });

  test('a RE-ack spreads — the measured failure seen from the callee', () => {
    // This is P7's side of it. The first ack is a single; a duplicate of a
    // message we already delivered means that ack never arrived, so the
    // re-ack is a retransmission and earns the second road. Mutation: send
    // the re-ack single — P7 acks eight times into its own dead row while
    // P9 counts down to "No answer", which is precisely what the field
    // measured.
    const { s, sends, got } = recorder();
    const chunk = encodeSignalChunks(
      4242,
      JSON.stringify({ t: 'invite', call: 'c6', id: 4242 }),
    )[0];
    s.receive(chunk, 0);
    expect(got.length).toBe(1);
    expect(sends.map(x => x.fanout)).toEqual([1]); // the first ack
    s.receive(chunk, SIGNAL_RETRY_MS + 1);
    expect(got.length).toBe(1); // never re-delivered — dedupe still holds
    expect(sends.length).toBe(2);
    expect(sends[1].fanout).toBe(SIGNAL_HEDGE_FANOUT);
  });
});
