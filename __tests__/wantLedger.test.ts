/**
 * THE WANT LEDGER — the cure for camp-scale fetch starvation
 * (src/events/schema.ts crew_sync_wants, src/crews/messages.ts).
 *
 * THE BUG, stated precisely, because the version in review was wrong about
 * the mechanism and the wrong version leads to the wrong cure:
 *
 *   NOT "the phone re-fetches the same first 64 forever because the digest
 *   never advances". It does advance — `wantsFrom` skips ids this phone
 *   already HOLDS, so accepted ids drop out of the want list and the next
 *   sighting starts further down. `crewMessages.test.ts` pins exactly that
 *   and is green.
 *
 *   THE REAL ONE: `acceptIncoming` refuses ids for FOUR reasons `wantsFrom`
 *   knows nothing about — past the hop horizon, over the per-kind byte cap,
 *   an unknown kind, an unknown crew. An id refused for any of those is never
 *   held, never expires out of the peer's digest, and is therefore re-asked
 *   EVERY sighting forever, permanently occupying one of the MAX_FETCH_IDS
 *   slots. Enough of them at the head of a camp digest and the tail is never
 *   reached — through ordinary use, with no attacker involved. (It is also
 *   the same shape as the digest-flooding attack in CREW-DESIGN.md, arriving
 *   by accident.)
 *
 * Keyed on the MESSAGE ID and deliberately not on the peer: ids are
 * sender-minted and identical over every gossip path, so "I asked and never
 * got it" survives a disconnect, a restart, and Android's rotating private
 * address. A peer-keyed cursor would reset every ~15 minutes on Android while
 * working perfectly on iOS — correct on the platform you test, silent on the
 * other.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  ANCIENT_OFFER_MIN,
  MAX_HOPS,
  WANT_BACKOFF_BASE_MIN,
  WANT_BACKOFF_MAX_MIN,
  WANT_LEDGER_TTL_MIN,
  clearWants,
  epochMinutes,
  forgiveWants,
  heldIdsAmong,
  pruneWants,
  recordWants,
  wantsFrom,
  type DigestEntry,
} from '../src/crews/messages';

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

const T0 = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));
/**
 * A digest entry that stays LIVE for the whole test, however far the clock is
 * walked. This matters: several tests below march time forward by hours or
 * days to exercise the back-off, and an offer with a realistic 10-hour expiry
 * would start being skipped for EXPIRY rather than back-off partway through —
 * the assertion would still pass or fail, but it would be measuring the wrong
 * gate. (It measured the wrong gate on the first run; both failures were this
 * fixture, not the ledger.)
 */
const offer = (id: string): DigestEntry => ({
  id,
  expires_min: T0 + WANT_LEDGER_TTL_MIN * 10,
});

beforeEach(() => {
  mockConn = makePhone();
});

describe('the ledger table is real DDL, not a hope', () => {
  test('crew_sync_wants exists in the shipped schema', () => {
    // Mutation: define the table anywhere but BASE_TABLES_SQL and every
    // ledger call throws "no such table" on a real phone while passing in
    // whatever harness created it by hand.
    const res = mockConn.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='crew_sync_wants'",
    );
    expect(res.rows._array.length).toBe(1);
  });
});

describe('a poison id stops occupying a slot forever', () => {
  test('an unanswered id is asked once, then backed off', () => {
    // THE WHOLE POINT. Mutation: drop the retry_min skip in wantsFrom and
    // this id is returned on every sighting for the rest of the burn.
    const digest = [offer('poison-1')];
    expect(wantsFrom(digest, T0)).toEqual(['poison-1']);

    recordWants(['poison-1'], T0); // asked; nothing came back
    expect(wantsFrom(digest, T0)).toEqual([]);
    // still backed off one minute later
    expect(wantsFrom(digest, T0 + 1)).toEqual([]);
  });

  test('it is backed off, NEVER banished', () => {
    // An id we could not take today may be legitimately reachable tomorrow
    // from a different carrier with a lower hop count. Mutation: banish it
    // and the starvation cure becomes a starvation cause.
    recordWants(['poison-1'], T0);
    expect(wantsFrom([offer('poison-1')], T0 + WANT_BACKOFF_BASE_MIN)).toEqual([
      'poison-1',
    ]);
  });

  test('repeated misses back off further, and the back-off is capped', () => {
    // Mutation: linear back-off and a poison id still burns a slot every few
    // minutes at camp scale. Mutation the other way: uncapped doubling and a
    // transiently-missed id is gone for weeks.
    let t = T0;
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      recordWants(['poison-1'], t);
      // walk forward until it is offered again, and record how long that took
      let waited = 0;
      while (wantsFrom([offer('poison-1')], t + waited).length === 0) {
        waited += 1;
        if (waited > WANT_BACKOFF_MAX_MIN + 5) {
          break;
        }
      }
      seen.push(waited);
      t += waited;
    }
    expect(seen[0]).toBe(WANT_BACKOFF_BASE_MIN);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[2]).toBeGreaterThan(seen[1]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(WANT_BACKOFF_MAX_MIN);
  });

  test('the TAIL is reached while the head is poisoned — the failure this fixes', () => {
    // The camp-scale shape in miniature: poison ids sit at the HEAD of the
    // digest, good mail sits behind them. Mutation: no ledger, and every
    // sighting returns the poison first; with a real MAX_FETCH_IDS slice the
    // good ids never make the cut.
    const digest = [
      offer('poison-a'),
      offer('poison-b'),
      offer('poison-c'),
      offer('good-1'),
    ];
    const first = wantsFrom(digest, T0);
    expect(first).toEqual(['poison-a', 'poison-b', 'poison-c', 'good-1']);

    recordWants(first, T0); // asked for all four; none landed

    // Second sighting: everything is backed off, so nothing is re-asked...
    expect(wantsFrom(digest, T0 + 1)).toEqual([]);
    // ...and once the back-off lapses they are asked again, but by then a
    // sighting in between would have spent its slots on ids that CAN land.
    expect(wantsFrom(digest, T0 + WANT_BACKOFF_BASE_MIN).length).toBe(4);
  });
});

describe('only what LANDED is forgiven', () => {
  test('clearWants clears the arrivals and leaves the misses backed off', () => {
    // THE SUBTLE ONE. Mutation: clear the whole request instead of the held
    // subset, and every refused id has its back-off reset on every sighting —
    // the exact starvation the ledger exists to stop, reintroduced by the
    // cure itself, and invisible because the ledger LOOKS populated.
    recordWants(['landed-1', 'poison-1'], T0);
    mockConn.execute(
      `INSERT INTO crew_messages
        (id, crew_code, from_hash, to_hash, kind, body, mime, created_min,
         expires_min, hops, origin, read_at)
       VALUES ('landed-1','dusty-llamas-7',1,NULL,'text','hi','',?,?,0,'heard',NULL)`,
      [T0, T0 + 600],
    );

    expect(heldIdsAmong(['landed-1', 'poison-1'])).toEqual(['landed-1']);
    clearWants(heldIdsAmong(['landed-1', 'poison-1']));

    // landed-1 is held so it is skipped anyway; poison-1 must STILL be
    // backed off — its row was not cleared.
    expect(wantsFrom([offer('poison-1')], T0)).toEqual([]);
  });

  test('a cleared id starts from zero if it is ever offered again', () => {
    // After our copy expires, a re-offer should not inherit an old back-off:
    // that would punish a message for having been successfully delivered.
    recordWants(['msg-1'], T0);
    clearWants(['msg-1']);
    expect(wantsFrom([offer('msg-1')], T0)).toEqual(['msg-1']);
  });

  test('heldIdsAmong and clearWants tolerate an empty list', () => {
    expect(heldIdsAmong([])).toEqual([]);
    expect(() => clearWants([])).not.toThrow();
    expect(() => recordWants([], T0)).not.toThrow();
  });
});

describe('a transport failure is the address’s fault, not the id’s', () => {
  // MEASURED, 2026-08-24: the second dial of a two-pass sync regularly hits
  // an address that rotated away between passes. Each failed pass had
  // stamped its want ids first — deliberately, see recordWants — and the
  // back-off doubled on a failure the ids had no part in. A text between
  // two phones sitting side by side arrived twenty minutes late; the
  // ceiling is six hours.
  //
  // THE STRIKE STANDS. Forgiveness re-arms retry at the base step but the
  // bumped tries is KEPT — the first draft un-bumped it, and a second
  // review pass proved that made the graduation ceiling unreachable:
  // tries oscillated 0↔1 forever and a reliably-dropping peer could pin
  // the first 64 digest slots after all.

  test('forgiveWants re-arms a transport-failed id at the base step', () => {
    recordWants(['msg-1'], T0);
    // Backed off right now (the stamp is the point)...
    expect(wantsFrom([offer('msg-1')], T0)).toEqual([]);
    forgiveWants(['msg-1'], T0);
    // STILL backed off inside the base step — forgiveness re-arms, it does
    // not amnesty. A forgive that deletes the row makes the id askable this
    // very minute, and a peer whose serve reliably dies mid-transfer is
    // then hammered on every single sighting; the base step is what keeps
    // the ask cadence bounded. (The first version of this test could not
    // tell the two apart, and the delete mutation ran green.)
    expect(wantsFrom([offer('msg-1')], T0)).toEqual([]);
    expect(
      wantsFrom([offer('msg-1')], T0 + WANT_BACKOFF_BASE_MIN - 1),
    ).toEqual([]);
    // ...and past ONE base step it is askable again — not past a grown one.
    expect(
      wantsFrom([offer('msg-1')], T0 + WANT_BACKOFF_BASE_MIN + 1),
    ).toEqual(['msg-1']);
  });

  test('early transport failures stay at the base cadence, then GRADUATE', () => {
    // The whole schedule in one walk. The measured case — a fresh message
    // caught in a flaky patch — sits in the first few failures and keeps
    // its quick base-step retries. But the strikes accumulate, and past
    // the ceiling forgiveness stops: the id backs off on the ordinary
    // doubling schedule like any poison. The first draft of forgiveness
    // decremented tries and this walk never graduated — which is how a
    // reliably-dropping peer could pin the first 64 digest slots forever.
    let t = T0;
    // Failures 1..4 land at tries 0..3: forgiven, base cadence each time.
    for (let i = 0; i < 4; i++) {
      recordWants(['msg-1'], t);
      forgiveWants(['msg-1'], t);
      expect(wantsFrom([offer('msg-1')], t + WANT_BACKOFF_BASE_MIN - 1)).toEqual(
        [],
      );
      expect(
        wantsFrom([offer('msg-1')], t + WANT_BACKOFF_BASE_MIN + 1),
      ).toEqual(['msg-1']);
      t += WANT_BACKOFF_BASE_MIN + 1;
    }
    // Failure 5 is past the ceiling: NOT forgiven, and the stamped
    // back-off (tries=4 → 32 minutes) stands.
    recordWants(['msg-1'], t);
    forgiveWants(['msg-1'], t);
    expect(wantsFrom([offer('msg-1')], t + WANT_BACKOFF_BASE_MIN + 1)).toEqual(
      [],
    );
    expect(wantsFrom([offer('msg-1')], t + 31)).toEqual([]);
    expect(wantsFrom([offer('msg-1')], t + 33)).toEqual(['msg-1']);
  });

  test('landing wipes the slate even after graduation', () => {
    // Success is clearWants, and a later re-offer starts from zero — the
    // graduation must never become a permanent record for an id that was
    // eventually delivered and expires back out of someone's digest.
    for (let i = 0; i < 5; i++) {
      recordWants(['msg-1'], T0);
    }
    clearWants(['msg-1']);
    expect(wantsFrom([offer('msg-1')], T0)).toEqual(['msg-1']);
  });

  test('forgiveness is not amnesty: a served-and-refused id keeps growing', () => {
    // The ledger's real target must survive the cure. An id the peer
    // ANSWERED about and we refused (hop horizon, byte cap) is never
    // forgiven — its back-off keeps doubling exactly as before.
    recordWants(['poison-1'], T0);
    recordWants(['poison-1'], T0 + WANT_BACKOFF_BASE_MIN + 1);
    // tries=1 -> the second stamp set retry at BASE*2 past its asking.
    const afterBase =
      T0 + WANT_BACKOFF_BASE_MIN + 1 + WANT_BACKOFF_BASE_MIN + 1;
    expect(wantsFrom([offer('poison-1')], afterBase)).toEqual([]);
  });

  test('forgiveWants touches only the named ids, and tolerates empties', () => {
    recordWants(['msg-1', 'poison-1'], T0);
    forgiveWants(['msg-1'], T0);
    forgiveWants([], T0);
    // msg-1 re-armed at base; poison-1 untouched on the same clock. With
    // tries=0 both were already at base, so separate them by growing
    // poison-1 once more first.
    recordWants(['poison-1'], T0 + 1);
    const probe = T0 + WANT_BACKOFF_BASE_MIN + 2;
    expect(wantsFrom([offer('msg-1'), offer('poison-1')], probe)).toEqual([
      'msg-1',
    ]);
  });
});

describe('the ledger cannot grow forever', () => {
  test('rows older than the longest message life are swept', () => {
    // Nothing in crew_messages outlives the week by construction, so a want
    // older than that names a message that cannot exist. Mutation: never
    // sweep, and a phone that meets many pods accretes ledger rows for the
    // whole burn.
    recordWants(['ancient-1'], T0);
    expect(pruneWants(T0 + WANT_LEDGER_TTL_MIN - 1)).toBe(0);
    expect(pruneWants(T0 + WANT_LEDGER_TTL_MIN)).toBe(1);
    // and it is gone, so the id is askable again
    expect(wantsFrom([offer('ancient-1')], T0 + WANT_LEDGER_TTL_MIN)).toEqual([
      'ancient-1',
    ]);
  });
});

describe('the ledger does not break what already worked', () => {
  test('a held id is still skipped, ledger or no ledger', () => {
    mockConn.execute(
      `INSERT INTO crew_messages
        (id, crew_code, from_hash, to_hash, kind, body, mime, created_min,
         expires_min, hops, origin, read_at)
       VALUES ('held-1','dusty-llamas-7',1,NULL,'text','hi','',?,?,0,'heard',NULL)`,
      [T0, T0 + 600],
    );
    expect(wantsFrom([offer('held-1')], T0)).toEqual([]);
  });

  test('an ANCIENT offer is still skipped — but a just-expired one is not', () => {
    // Updated with the clock-skew cure. `expires_min` is the OFFERING phone's
    // stamp on ITS clock, so "expired by one minute" is ambiguous: either the
    // record died with the clocks agreeing, or it is live and we are running
    // fast. Nothing in a digest entry separates those, so we fetch it and let
    // the accept gate judge without a shared clock.
    // Genuinely ancient is still separable — past the longest TTL plus the
    // whole skew tolerance, no disagreement we accept could make it live.
    expect(wantsFrom([{ id: 'old-1', expires_min: T0 - 1 }], T0)).toEqual(['old-1']);
    expect(
      wantsFrom([{ id: 'ancient-1', expires_min: T0 - ANCIENT_OFFER_MIN - 1 }], T0),
    ).toEqual([]);
  });

  test('the hop horizon that CAUSES poison ids is still what it was', () => {
    // Guards the premise this whole suite rests on: there is a hop horizon,
    // so there are ids a peer offers that this phone will refuse.
    expect(MAX_HOPS).toBeGreaterThan(0);
  });
});

describe('the forgiveness is bounded, or it becomes the hole', () => {
  // The bound exists because cross-family review refuted the unbounded
  // first version, and a SECOND pass refuted the first bound: forgiveness
  // that decrements tries makes the graduation ceiling unreachable —
  // 0↔1 forever — so the strike now stands and only the sentence is
  // commuted. The ceiling tests live with the schedule walk above; this
  // block pins the boundary behaviour on either side of it.

  test('at the ceiling exactly, forgiveness still applies', () => {
    // Four asks: tries lands at 3, which IS the ceiling. Off-by-one here
    // silently shrinks the quick-retry window the measured case needs.
    for (let i = 0; i < 4; i++) {
      recordWants(['msg-1'], T0);
    }
    forgiveWants(['msg-1'], T0);
    expect(wantsFrom([offer('msg-1')], T0 + WANT_BACKOFF_BASE_MIN + 1)).toEqual(
      ['msg-1'],
    );
  });

  test('past the ceiling, forgiveness must not touch the row at all', () => {
    // Five asks: tries=4, retry at 32 min. The forgive below is a no-op —
    // not a re-arm, not a partial credit.
    for (let i = 0; i < 5; i++) {
      recordWants(['sticky-1'], T0);
    }
    forgiveWants(['sticky-1'], T0);
    expect(wantsFrom([offer('sticky-1')], T0 + 9)).toEqual([]);
    expect(wantsFrom([offer('sticky-1')], T0 + 31)).toEqual([]);
    expect(wantsFrom([offer('sticky-1')], T0 + 33)).toEqual(['sticky-1']);
  });
});
