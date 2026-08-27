/**
 * CLOCK SKEW AT THE ACCEPT BOUNDARY — a burn-week failure that needs no
 * attacker, no bad radio, and no bug anywhere else.
 *
 * THE MECHANISM. `acceptIncoming` used to do two things with the SENDER's
 * absolute `expires_min`, measured against the RECEIVER's clock:
 *   - refuse outright when `m.expires_min <= nowMin`, and
 *   - store `Math.min(m.expires_min, nowMin + ttl)` — clamped from ABOVE only,
 *     so a heard row inherited the sender's number whenever it was smaller.
 * Meanwhile `composeRecord` stamps OWN mail at `nowMin + ttl`, and
 * `pruneExpired` deletes on the local clock.
 *
 * Playa phones have no cell and no NTP, so they drift freely. A receiver whose
 * clock runs S minutes ahead therefore gave every RECEIVED message a life of
 * (ttl - S) while its OWN mail kept the full ttl — and past ~24 h of skew the
 * accept gate refused everything outright. The symptom is a pod that syncs one
 * way, silently, with nothing in the UI that could explain it, on a phone
 * nobody can debug in the dust. It is a strong candidate for the original
 * one-way blocker.
 *
 * THE CURE: take the LENGTH the sender asked for — `expires_min -
 * created_min`, a difference of two of THEIR OWN stamps and therefore free of
 * any clock offset — cap it at our own policy so a lying peer cannot buy
 * extra life, and start it from ARRIVAL.
 *
 * (My first attempt dropped the sender's expiry entirely and gave every heard
 * row a full fresh TTL. `crewMessages` caught it immediately and was right: a
 * record the sender minted with a one-minute life was being resurrected for a
 * day. The length is the part that travels; the deadline is the part that
 * does not.)
 *
 * THE TRADE, stated because it is a real cost: a relayed record's life
 * restarts at each hop, so a 24 h message can circulate longer than 24 h —
 * bounded by MAX_HOPS and by needing a real encounter per hop. The
 * alternative is believing a clock we cannot check, which is what silently
 * emptied a pod's inbox.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  CLOCK_SKEW_TOLERANCE_MIN,
  MESSAGE_TTL_MIN,
  acceptIncoming,
  epochMinutes,
  pruneExpired,
  recordsOfKind,
  type WireMessage,
} from '../src/crews/messages';
import { hash32 } from '../src/crews/beacon';
import {
  decodeMessages,
  serveDigest,
  serveMessages,
  syncWithPeer,
  type CrewSyncLink,
} from '../src/crews/syncLink';
import { composeText } from '../src/crews/messages';

const { DatabaseSync } = require('node:sqlite');

function makePhone() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  } as any;
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

const CODE = 'dusty-llamas-7';
const SENDER = 'aaaa1111';
/** The SENDER's clock. Every skew below is the receiver's offset from this. */
const THEIR_NOW = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));

/** A message as the sender stamps it — on the sender's own clock, unclamped. */
const wire = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'cafe1234-29000000-beef',
  crew_code: CODE,
  from_hash: hash32(SENDER),
  to_hash: null,
  kind: 'text',
  body: 'ice run at noon',
  mime: '',
  created_min: THEIR_NOW - 2,
  expires_min: THEIR_NOW - 2 + MESSAGE_TTL_MIN,
  hops: 0,
  ...over,
});

/** Life the row actually got, in minutes from the receiver's own now. */
function storedLife(myNow: number): number | null {
  const res = mockConn.execute('SELECT expires_min FROM crew_messages LIMIT 1');
  const row = res.rows._array[0];
  return row ? Number(row.expires_min) - myNow : null;
}

beforeEach(() => {
  mockConn = makePhone();
});

describe('a receiver whose clock runs ahead still keeps what it is told', () => {
  test.each([
    ['12 hours ahead, read 13 hours later', 12 * 60, 13 * 60],
    ['23 hours ahead, read 1 hour later', 23 * 60, 60],
  ])('%s', (_label, skew, elapsed) => {
    // Both of these VANISHED before the fix: accepted, stored with the
    // sender's number, then deleted by the local clock before the camper
    // opened the pod. Own mail sent in the same minute survived, which is
    // what made it read as a one-way pod rather than as expiry.
    const myNow = THEIR_NOW + skew;
    expect(acceptIncoming([wire()], [CODE], myNow)).toBe(1);
    pruneExpired(myNow + elapsed);
    expect(recordsOfKind('text', [CODE])).toHaveLength(1);
  });

  test('past a day of skew it is still ACCEPTED, not refused outright', () => {
    // The worst face: the old gate refused on `m.expires_min <= nowMin`, so
    // at >= ~24 h of drift EVERY record bounced. Nothing was stored, nothing
    // was logged, and the pod simply never received.
    const myNow = THEIR_NOW + 24 * 60;
    expect(acceptIncoming([wire()], [CODE], myNow)).toBe(1);
    pruneExpired(myNow + 1);
    expect(recordsOfKind('text', [CODE])).toHaveLength(1);
  });

  test('heard mail and own mail get the SAME life — the asymmetry is the bug', () => {
    // composeRecord stamps own mail nowMin + ttl. If heard mail gets less,
    // only heard mail vanishes, which is precisely the shape that reads as
    // "the other phone is not sending".
    const myNow = THEIR_NOW + 9 * 60;
    acceptIncoming([wire()], [CODE], myNow);
    expect(storedLife(myNow)).toBe(MESSAGE_TTL_MIN);
  });

  test('a receiver running BEHIND does not get extra life either', () => {
    // HONEST LABEL: this one passes on the OLD code too, so it is a ceiling
    // REGRESSION GUARD, not evidence the fix works. Keeping it for what it
    // does guard — that nobody later raises the cap above policy — and
    // saying so, because a test that cannot fail on the change it sits
    // beside will otherwise be read as proof of that change.
    const myNow = THEIR_NOW - 10 * 60;
    acceptIncoming([wire()], [CODE], myNow);
    expect(storedLife(myNow)).toBe(MESSAGE_TTL_MIN);
  });

  test('a SHORT sender length survives skew — the regression I nearly shipped', () => {
    // My first attempt gave every heard row a full fresh TTL, resurrecting a
    // record its author minted with a one-minute life. crewMessages caught
    // that at ZERO skew; nothing covered it WITH skew, which is the case the
    // fix actually changed. This is that guard.
    const myNow = THEIR_NOW + 12 * 60;
    acceptIncoming(
      [wire({ created_min: THEIR_NOW, expires_min: THEIR_NOW + 1 })],
      [CODE],
      myNow,
    );
    expect(storedLife(myNow)).toBe(1);
  });
});

describe('the gate still refuses what it should', () => {
  test('a record that expires before it was written is incoherent', () => {
    // Needs no clock of ours at all — the record contradicts itself.
    // Mutation: drop this and a malformed or hostile record is stored with a
    // full fresh life, which is worse than the bug being fixed.
    expect(
      acceptIncoming(
        [wire({ expires_min: THEIR_NOW - 100, created_min: THEIR_NOW })],
        [CODE],
        THEIR_NOW,
      ),
    ).toBe(0);
  });

  test('a birth implausibly far in the FUTURE is refused', () => {
    // THIS TEST WAS STRUCTURALLY DEAD and an adversarial pass caught it.
    // Overriding created_min alone left the DEFAULT expires_min behind it, so
    // the record died at the COHERENCE check and never reached the
    // plausibility clause it claims to exercise — delete that clause entirely
    // and the test still passed.
    // The same fixture trap bit the tolerance test below, where it failed
    // LOUDLY because that one expects 1. Polarity is the only thing that
    // decided which one I noticed: an expects-0 test passes silently for the
    // wrong reason. Give every future-dated fixture a matching expiry.
    const born = THEIR_NOW + CLOCK_SKEW_TOLERANCE_MIN + 10;
    expect(
      acceptIncoming(
        [wire({ created_min: born, expires_min: born + MESSAGE_TTL_MIN })],
        [CODE],
        THEIR_NOW,
      ),
    ).toBe(0);
  });

  test('a birth older than any live record could be is refused', () => {
    expect(
      acceptIncoming(
        [
          wire({
            created_min:
              THEIR_NOW - (MESSAGE_TTL_MIN + CLOCK_SKEW_TOLERANCE_MIN + 10),
          }),
        ],
        [CODE],
        THEIR_NOW,
      ),
    ).toBe(0);
  });

  test('the tolerance is generous on purpose, and the asymmetry is deliberate', () => {
    // Too tight costs a SILENT ONE-WAY POD; too loose costs one extra day of
    // a stale record, bounded by MAX_HOPS. Those are not close, so the
    // window errs wide. Mutation: tighten it toward the beacon's 20-minute
    // replay window and the original bug comes straight back.
    expect(CLOCK_SKEW_TOLERANCE_MIN).toBeGreaterThanOrEqual(24 * 60);
    // Right at the edge, still taken.
    // NOTE the expires_min override: moving created_min alone leaves the
    // default expiry BEHIND it, which the coherence check correctly refuses.
    // My first version of this fixture did exactly that and failed for a
    // reason that had nothing to do with the tolerance it was testing.
    const born = THEIR_NOW + CLOCK_SKEW_TOLERANCE_MIN - 1;
    expect(
      acceptIncoming(
        [wire({ created_min: born, expires_min: born + MESSAGE_TTL_MIN })],
        [CODE],
        THEIR_NOW,
      ),
    ).toBe(1);
  });
});


/**
 * THE END-TO-END TEST, and it is the one that matters most in this file.
 *
 * Every other test here calls `acceptIncoming` DIRECTLY — and so did the
 * standalone harness I verified the fix against. Both proved the accept gate
 * in isolation; neither proved that the SYNC PATH REACHES IT. It did not.
 * `wantsFrom` stood one call earlier on the only production path, making the
 * same sender-stamp-versus-our-clock comparison, and `syncWithPeer` returns
 * the instant the want list comes back empty — so past ~24 h of skew the
 * phone asked for nothing and the repaired gate was never entered. Two
 * independent verifications of the same half.
 *
 * A shared EARLIER refusal masks every downstream difference. The only cure
 * is to drive the whole path.
 */
describe('a skewed sync end to end — through syncWithPeer, not the gate', () => {
  /** Swap which phone getDb() points at, so one store can serve another. */
  const onPhone = <T,>(conn: any, fn: () => T): T => {
    const prev = mockConn;
    mockConn = conn;
    try {
      return fn();
    } finally {
      mockConn = prev;
    }
  };

  test.each([
    ['clocks agree', 0],
    ['receiver 12 hours ahead', 12 * 60],
    ['receiver a full day ahead — the old blackout', 24 * 60],
    ['receiver two days ahead', 48 * 60],
  ])('%s: the mail actually arrives', async (_label, skew) => {
    const sender = makePhone();
    const receiver = makePhone();
    const myNow = THEIR_NOW + skew;

    // The sender composes on ITS clock, which is what a real phone does.
    let stride = 0;
    const rand = () => {
      stride = (stride + 0.317) % 1;
      return stride;
    };
    const mail = onPhone(sender, () =>
      composeText(CODE, SENDER, 'water at 7:30 and C', null, THEIR_NOW, rand),
    );

    const link: CrewSyncLink = {
      fetchDigest: async () => onPhone(sender, () => serveDigest([CODE], THEIR_NOW)),
      fetchMessages: async ids => onPhone(sender, () => serveMessages(ids, THEIR_NOW)),
    };

    mockConn = receiver;
    const { accepted } = await syncWithPeer(link, [CODE], myNow);

    // Before the wantsFrom fix, skew >= 24 h made this 0 — the want list
    // emptied, syncWithPeer returned early, and nothing was even requested.
    expect(accepted).toBe(1);
    expect(recordsOfKind('text', [CODE]).map(r => r.id)).toEqual([mail.id]);
  });

  test('a relayed record stays coherent for the NEXT phone', () => {
    // The failure this guards: a heard row holds the AUTHOR's created_min and
    // OUR expires_min — two clocks. Served raw, `expires - created` can go
    // NEGATIVE downstream, and every further receiver refuses it as
    // incoherent forever while we hold it happily and show it in our inbox.
    // serveMessages re-stamps into the author's frame to keep the pair sane.
    const relay = makePhone();
    mockConn = relay;
    // Author is a full day AHEAD of this relay — inside the accept tolerance,
    // and exactly the gap that used to invert the pair.
    const authorNow = THEIR_NOW + 24 * 60;
    acceptIncoming(
      [
        wire({
          created_min: authorNow,
          expires_min: authorNow + MESSAGE_TTL_MIN,
        }),
      ],
      [CODE],
      THEIR_NOW,
    );
    // Decode with the REAL codec rather than reaching into the frame — the
    // question is what a peer actually reads.
    const rows = decodeMessages(serveMessages([wire().id], THEIR_NOW)) as WireMessage[];
    expect(rows).toHaveLength(1);
    // The pair a peer receives must be coherent, or their gate refuses it —
    // permanently, for every peer, while we keep showing it in our own inbox.
    expect(rows[0].expires_min).toBeGreaterThan(rows[0].created_min);
    // And the length they read is what is LEFT, not a fresh full TTL: that is
    // what makes a relayed record decay across hops instead of restarting.
    expect(rows[0].expires_min - rows[0].created_min).toBeLessThanOrEqual(
      MESSAGE_TTL_MIN,
    );
  });
});
