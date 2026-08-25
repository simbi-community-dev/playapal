/**
 * SERVE ORDER, BYTE BUDGET AND KIND-PRIORITY EVICTION — the camp-scale half
 * of phase 2 (the other half is the want ledger, wantLedger.test.ts).
 *
 * This suite exists because the change it covers would otherwise land GREEN
 * WHETHER OR NOT IT WORKED. Before it, nothing in the tree exercised
 * text-vs-voice eviction at all: every existing eviction test builds an
 * all-text fixture, so a kind-priority ORDER BY that did nothing would pass
 * all of them. The same is true of the roster-first serve order — the old
 * `expires_min DESC` already put roster ahead of mail BY ACCIDENT, because
 * pod-member's TTL is 7 days against mail's 1, so a test that merely asserts
 * "roster comes first" passes on the OLD code too and proves nothing about
 * the new one.
 *
 * So the assertions below are built to distinguish the new behaviour from the
 * accident: roster records are made OLDER than the mail they must still
 * outrank, which is exactly the case a bare recency sort gets wrong.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  DIGEST_MAX_ENTRIES,
  HEARD_BYTE_BUDGET_ENABLED,
  HEARD_BYTE_CAPS,
  HEARD_CAP,
  KIND_POLICY,
  MESSAGE_TTL_MIN,
  POD_MEMBER_TTL_MIN,
  TEXT_MAX_BYTES,
  VOICE_MAX_BYTES,
  epochMinutes,
  syncDigest,
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

const CODE = 'dusty-llamas-7';
const T0 = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));

/** Insert straight to the store: these tests are about ORDER and EVICTION,
 * not about the accept gate, and going through the wire would make every
 * fixture fight four unrelated policies. */
function put(
  id: string,
  kind: string,
  opts: { createdMin?: number; ttl?: number; bytes?: number; origin?: string } = {},
): void {
  const created = opts.createdMin ?? T0;
  const ttl = opts.ttl ?? MESSAGE_TTL_MIN;
  const body = 'x'.repeat(opts.bytes ?? 8);
  mockConn.execute(
    `INSERT INTO crew_messages
      (id, crew_code, from_hash, to_hash, kind, body, mime, created_min,
       expires_min, hops, origin, read_at)
     VALUES (?,?,?,NULL,?,?,'',?,?,0,?,NULL)`,
    [id, CODE, 1, kind, body, created, created + ttl, opts.origin ?? 'heard'],
  );
}

beforeEach(() => {
  mockConn = makePhone();
});

describe('the policy table declares order, so a new kind cannot forget to', () => {
  test('every kind declares both servePriority and evictRank', () => {
    // Mutation: add a kind without them and the SQL CASE silently sorts it
    // into the ELSE bucket, which is a decision nobody made.
    for (const [kind, policy] of Object.entries(KIND_POLICY)) {
      expect(`${kind}.servePriority`).toBe(`${kind}.servePriority`);
      expect(Number.isInteger(policy.servePriority)).toBe(true);
      expect(Number.isInteger(policy.evictRank)).toBe(true);
    }
  });

  test('roster outranks every other kind in the serve order', () => {
    const member = KIND_POLICY['pod-member'].servePriority;
    for (const [kind, policy] of Object.entries(KIND_POLICY)) {
      if (kind !== 'pod-member') {
        expect(member).toBeLessThan(policy.servePriority);
      }
    }
  });

  test('voice is evicted before text, and they share a budget', () => {
    // Mutation: equal ranks and eviction falls back to expires_min alone,
    // which for two kinds with the SAME TTL is a coin flip on id.
    expect(KIND_POLICY.voice.evictRank).toBeGreaterThan(KIND_POLICY.text.evictRank);
    expect(KIND_POLICY.voice.capGroup).toBe(KIND_POLICY.text.capGroup);
  });
});

describe('the digest serves roster first — by RULE, not by TTL accident', () => {
  test('an OLD roster record still outranks FRESH mail', () => {
    // THE DISCRIMINATING TEST. A bare `created_min DESC` puts the fresh text
    // first and fails here; the old `expires_min DESC` passes for the wrong
    // reason (pod-member's 7-day TTL). Only the explicit kind prefix gets
    // this right on purpose.
    put('roster-old', 'pod-member', {
      createdMin: T0 - 3 * 24 * 60, // three days old
      ttl: POD_MEMBER_TTL_MIN,
    });
    put('text-fresh', 'text', { createdMin: T0 });
    const ids = syncDigest([CODE]).map(e => e.id);
    expect(ids[0]).toBe('roster-old');
    expect(ids).toEqual(['roster-old', 'text-fresh']);
  });

  test('within a kind, newest is offered first', () => {
    put('older', 'text', { createdMin: T0 - 100 });
    put('newer', 'text', { createdMin: T0 });
    expect(syncDigest([CODE]).map(e => e.id)).toEqual(['newer', 'older']);
  });

  test('the digest cap is a runaway BACKSTOP, not a working limit', () => {
    // Mutation: set it to HEARD_CAP (this was the first version) and a phone
    // in several pods silently stops offering mail it is holding — which at
    // camp scale is indistinguishable from the starvation this phase cures.
    // The heard cap is per (pod, cap group), and a phone's own outbox is
    // capped by nothing at all, so the backstop must clear all of that.
    expect(DIGEST_MAX_ENTRIES).toBeGreaterThan(HEARD_CAP * 4);
  });
});

describe('the byte axis is OFF for this train, and says so', () => {
  test('the flag is false — the budget is written, not running', () => {
    // Coordinator ruling for 0.8: the cheap pre-filter only short-circuits
    // under ~192 rows against a 2000-row cap, and past that the measurement
    // reads every body — twice per peer sighting, since pruneExpired sits at
    // the top of both serveDigest and syncWithPeer. Correct, and too
    // expensive to switch on three days before a burn.
    // Mutation: flip this to true without landing the body_bytes column and
    // a full-store blob read returns to the hot path silently.
    expect(HEARD_BYTE_BUDGET_ENABLED).toBe(false);
  });

  test('the eviction query does NOT read body lengths while it is off', () => {
    // The cost IS the read, so the guard has to remove the read, not just
    // ignore the result. Pinned against the source because nothing else can
    // tell "measured then discarded" from "never measured".
    const src = require('fs').readFileSync('src/crews/messages.ts', 'utf8');
    expect(src).toMatch(/HEARD_BYTE_BUDGET_ENABLED \? 'length\(CAST\(body AS BLOB\)\)' : '0'/);
  });

  test('the ROW cap and kind priority still run — this is not eviction off', () => {
    // The honest scope of the ruling: a voice-saturated pod is bounded at
    // 2000 rows rather than at 48 MiB, which is the PRE-EXISTING behaviour.
    // Eviction itself, and voice-before-text within a pod, are untouched.
    expect(HEARD_CAP).toBeGreaterThan(0);
    expect(KIND_POLICY.voice.evictRank).toBeGreaterThan(KIND_POLICY.text.evictRank);
  });
});

describe('the byte budget is sized to BIND, not to sound safe (when enabled)', () => {
  test('the pod budget can actually be reached by voice', () => {
    // Mutation: raise it above the row ceiling (a flat 256 MiB was the
    // proposal) and the byte axis is DEAD CODE — it reads as protection
    // while never once firing.
    expect(HEARD_BYTE_CAPS.pod).toBeLessThan(HEARD_CAP * VOICE_MAX_BYTES);
  });

  test('it can never be reached by text alone — rows govern there', () => {
    // The two axes must not collapse into one. A text-only pod is governed
    // by the ROW cap; if the byte budget could bind on text it would be
    // evicting words to make room for words.
    expect(HEARD_BYTE_CAPS.pod).toBeGreaterThan(HEARD_CAP * TEXT_MAX_BYTES);
  });

  test('every cap group has a declared byte budget', () => {
    for (const policy of Object.values(KIND_POLICY)) {
      expect(typeof HEARD_BYTE_CAPS[policy.capGroup]).toBe('number');
    }
  });

  test('the member budget is declared and CANNOT bind — stated, not hidden', () => {
    // 200 rows x 512 B is 100 KB. The budget exists so the roster has a
    // stated policy rather than an implied one; the row cap governs there.
    // Mutation: quietly lower it and the roster starts being evicted by a
    // budget nobody believes is active.
    const memberMax = KIND_POLICY['pod-member'].maxBytes;
    expect(HEARD_BYTE_CAPS.member).toBeGreaterThan(200 * memberMax);
  });
});

describe('eviction prefers voice over text inside one pod', () => {
  test('a pod over the ROW cap loses its voice notes first', () => {
    // THE ONE WITH NO PRIOR COVERAGE. Every existing eviction test is
    // all-text, so a kind-priority ORDER BY that did nothing passes them
    // all. Here text and voice share a TTL and a pod, so the ONLY thing that
    // can separate them is evictRank.
    const voiceIds: string[] = [];
    const textIds: string[] = [];
    // Same created_min and TTL for both, so expires_min cannot decide.
    for (let i = 0; i < 40; i++) {
      const id = `v-${String(i).padStart(4, '0')}`;
      put(id, 'voice', { bytes: 64 });
      voiceIds.push(id);
    }
    for (let i = 0; i < HEARD_CAP - 10; i++) {
      const id = `t-${String(i).padStart(4, '0')}`;
      put(id, 'text', { bytes: 8 });
      textIds.push(id);
    }
    // total = HEARD_CAP + 30 heard rows in the pod group -> 30 must go
    mockConn.execute('SELECT 1');
    const { pruneExpired } = require('../src/crews/messages');
    pruneExpired(T0);

    const left = new Set(syncDigest([CODE]).map(e => e.id));
    const voiceLeft = voiceIds.filter(id => left.has(id)).length;
    const textLeft = textIds.filter(id => left.has(id)).length;
    // 30 evictions, all of which should be voice
    expect(voiceLeft).toBe(10);
    expect(textLeft).toBe(HEARD_CAP - 10);
  }, 30_000);
});
