/**
 * The gossip layer as a TYPED-RECORD substrate (src/crews/messages.ts +
 * src/crews/syncLink.ts). crewMessages.test.ts owns the pod answering
 * machine's contract; this file owns the generalization underneath it:
 *
 *  - pod surfaces stay pod-only while other kinds ride the same rails,
 *  - a 'board-post' relays A -> B -> C over the very same 3-phone path,
 *  - caps, TTL and the hop horizon are PER KIND, not one global policy,
 *  - an unknown kind is refused at the gate and never stored or relayed,
 *  - the heard-row budget is per cap group, so long-lived records can
 *    never evict the pod mail the answering machine is showing.
 *
 * Same harness as crewMessages.test.ts: each "phone" is its own in-memory
 * database built from the REAL shipped DDL, and an in-memory CrewSyncLink
 * serves one phone's digest/messages to another by swapping which db the
 * mocked getDb() returns during the peer's serve call.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  BOARD_POST_MAX_BYTES,
  BOARD_POST_TTL_MIN,
  CAMP_NOTE_MAX_BYTES,
  CAMP_NOTE_TTL_MIN,
  HEARD_CAP,
  KIND_POLICY,
  MAX_HOPS,
  MESSAGE_TTL_MIN,
  NOTE_MAX_HOPS,
  TEXT_MAX_BYTES,
  acceptIncoming,
  composeRecord,
  composeText,
  epochMinutes,
  inbox,
  isStorableKind,
  myOutbox,
  recordsOfKind,
  syncDigest,
  unreadCount,
  type WireRecord,
} from '../src/crews/messages';
import {
  decodeMessages,
  encodeDigest,
  encodeMessages,
  serveDigest,
  serveMessages,
  syncWithPeer,
  type CrewSyncLink,
} from '../src/crews/syncLink';
import { hash32 } from '../src/crews/beacon';

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

/** Run fn with the mocked getDb() pointing at `conn`, then restore — how
 * a peer phone "serves" while the local phone stays current. */
const onPhone = <T>(conn: any, fn: () => T): T => {
  const prev = mockConn;
  mockConn = conn;
  try {
    return fn();
  } finally {
    mockConn = prev;
  }
};

const CODES = ['dusty-llamas-7'];
const ALEX = 'aaaa1111';
const BOB = 'bbbb2222';
const CARA = 'cccc3333';
const T0 = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));

let randState = 0;
const rand = () => {
  randState = (randState + 0.317) % 1;
  return randState;
};

const linkTo = (peer: any): CrewSyncLink => ({
  fetchDigest: async () => onPhone(peer, () => serveDigest(CODES, T0)),
  fetchMessages: async ids => onPhone(peer, () => serveMessages(ids, T0)),
});

/** A valid heard-side wire record from a stranger, overridable per test.
 * Defaults to a pod text so a test only states the field it is about. */
const wireRec = (over: Partial<WireRecord> = {}): WireRecord => ({
  id: 'cafe1234-29000000-beef',
  crew_code: CODES[0],
  from_hash: hash32('ffff9999'),
  to_hash: null,
  kind: 'text',
  body: 'water at 7:30 & C',
  mime: '',
  created_min: T0,
  expires_min: T0 + 60,
  hops: 0,
  ...over,
});

/**
 * What a board post looks like on this substrate: the camp lane's own
 * CampPost fields, serialized. The store never parses it — the body is
 * opaque here — but a realistic payload keeps the size proofs honest.
 */
const BOARD_BODY = JSON.stringify({
  id: 'aaaa1111:0007',
  writer_id: 'aaaa1111',
  author_name: 'the one with the swamp cooler',
  type: 'offer',
  text: 'spare 2x4s and a working impact driver, come by any afternoon',
  ref_id: null,
  created_at: '2026-08-31T12:00:00.000Z',
  done: false,
});

/** A camp note, likewise — a photo-less art sighting. */
const NOTE_BODY = JSON.stringify({
  id: 'aaaa1111:n3',
  writer_id: 'aaaa1111',
  author_name: 'the one with the swamp cooler',
  kind: 'art',
  title: 'the mirrored whale',
  where_addr: '4:30 & E',
  text: 'lit from inside after dark, worth the walk',
  created_at: '2026-08-31T12:00:00.000Z',
});

beforeEach(() => {
  mockConn = makePhone();
  randState = 0;
});

// ---------------------------------------------------------------------------

describe('pod surfaces stay pod-only while other kinds ride along', () => {
  test('inbox, unread and outbox ignore board posts and camp notes', () => {
    composeText(CODES[0], ALEX, 'meet at the trash fence at 3', null, T0, rand);
    composeRecord('board-post', CODES[0], ALEX, BOARD_BODY, '', null, T0, rand);
    acceptIncoming(
      [wireRec({ id: 'note-1', kind: 'camp-note', body: NOTE_BODY })],
      CODES,
      T0,
    );

    // The answering machine sees exactly one thing: the text someone left.
    expect(inbox(CODES, BOB).map(m => m.kind)).toEqual(['text']);
    expect(unreadCount(CODES, BOB)).toBe(1);
    expect(myOutbox(CODES, ALEX).map(m => m.kind)).toEqual(['text']);

    // …while the mesh carries and offers all three.
    expect(syncDigest(CODES)).toHaveLength(3);
    expect(recordsOfKind('board-post', CODES).map(r => r.body)).toEqual([
      BOARD_BODY,
    ]);
    expect(recordsOfKind('camp-note', CODES).map(r => r.body)).toEqual([
      NOTE_BODY,
    ]);
    expect(recordsOfKind('text', CODES)).toHaveLength(1);
  });

  test('recordsOfKind normalizes crew codes and is empty for a crew we are not in', () => {
    composeRecord('board-post', ' Dusty-Llamas-7 ', ALEX, BOARD_BODY, '', null, T0, rand);
    expect(recordsOfKind('board-post', ['DUSTY-LLAMAS-7'])).toHaveLength(1);
    expect(recordsOfKind('board-post', ['someone-elses-crew'])).toHaveLength(0);
    expect(recordsOfKind('board-post', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('gossip — a board post crosses camp on the pod rails', () => {
  test('THE RELAY PROOF, board edition: A composes, B hears from A, C from B', async () => {
    const phoneA = makePhone();
    const phoneB = makePhone();
    const phoneC = makePhone();

    mockConn = phoneA;
    const post = composeRecord(
      'board-post',
      CODES[0],
      ALEX,
      BOARD_BODY,
      '',
      null,
      T0,
      rand,
    );
    expect(post.origin).toBe('mine');
    expect(post.hops).toBe(0);

    mockConn = phoneB;
    expect((await syncWithPeer(linkTo(phoneA), CODES, T0)).accepted).toBe(1);
    expect(recordsOfKind('board-post', CODES)).toMatchObject([
      { id: post.id, hops: 1, origin: 'heard', body: BOARD_BODY },
    ]);
    // carried, never shown: B's answering machine is untouched by it
    expect(inbox(CODES, BOB)).toEqual([]);
    expect(unreadCount(CODES, BOB)).toBe(0);

    // C never meets A — B physically carries the post across camp
    mockConn = phoneC;
    expect((await syncWithPeer(linkTo(phoneB), CODES, T0)).accepted).toBe(1);
    const atC = recordsOfKind('board-post', CODES)[0];
    expect(atC.body).toBe(BOARD_BODY);
    expect(atC.hops).toBe(2);
    expect(inbox(CODES, CARA)).toEqual([]);

    // convergence: every further exchange is a no-op
    mockConn = phoneB;
    expect((await syncWithPeer(linkTo(phoneC), CODES, T0)).accepted).toBe(0);
    mockConn = phoneA;
    expect((await syncWithPeer(linkTo(phoneC), CODES, T0)).accepted).toBe(0);
  });

  test('one sighting moves every kind at once — the transport is kind-blind', () => {
    const text = composeText(CODES[0], ALEX, 'dust storm, sit tight', null, T0, rand);
    const post = composeRecord('board-post', CODES[0], ALEX, BOARD_BODY, '', null, T0 + 1, rand);
    const note = composeRecord('camp-note', CODES[0], ALEX, NOTE_BODY, '', null, T0 + 2, rand);

    const served = decodeMessages(
      serveMessages(syncDigest(CODES).map(e => e.id), T0),
    ) as WireRecord[];
    expect(served.map(m => m.kind).sort()).toEqual([
      'board-post',
      'camp-note',
      'text',
    ]);

    const far = makePhone();
    expect(onPhone(far, () => acceptIncoming(served, CODES, T0 + 3))).toBe(3);
    expect(onPhone(far, () => recordsOfKind('board-post', CODES)[0].body)).toBe(post.body);
    expect(onPhone(far, () => recordsOfKind('camp-note', CODES)[0].body)).toBe(note.body);
    expect(onPhone(far, () => inbox(CODES, BOB).map(m => m.id))).toEqual([text.id]);
  });
});

// ---------------------------------------------------------------------------

describe('per-kind policy — one table, four different costs', () => {
  test('size caps are per kind: a note may be far bigger than a pod text', () => {
    const big = 'n'.repeat(60 * 1024); // past TEXT_MAX_BYTES, inside the note cap
    expect(
      acceptIncoming(
        [wireRec({ id: 'note-ok', kind: 'camp-note', body: big })],
        CODES,
        T0,
      ),
    ).toBe(1);
    // the SAME bytes as a pod text are refused — the cap follows the kind
    expect(
      acceptIncoming([wireRec({ id: 'text-too-big', body: big })], CODES, T0),
    ).toBe(0);
    // and each kind's own ceiling still holds
    expect(
      acceptIncoming(
        [
          wireRec({
            id: 'note-huge',
            kind: 'camp-note',
            body: 'n'.repeat(CAMP_NOTE_MAX_BYTES + 1),
          }),
          wireRec({
            id: 'post-huge',
            kind: 'board-post',
            body: 'p'.repeat(BOARD_POST_MAX_BYTES + 1),
          }),
          wireRec({ id: 'text-huge', body: 'x'.repeat(TEXT_MAX_BYTES + 1) }),
        ],
        CODES,
        T0,
      ),
    ).toBe(0);
    expect(syncDigest(CODES).map(e => e.id)).toEqual(['note-ok']);
  });

  test('compose refuses the same sizes, in the kind’s own words', () => {
    expect(() =>
      composeRecord(
        'camp-note',
        CODES[0],
        ALEX,
        'n'.repeat(CAMP_NOTE_MAX_BYTES + 1),
        '',
        null,
        T0,
        rand,
      ),
    ).toThrow(KIND_POLICY['camp-note'].overCapMessage);
    expect(() =>
      composeRecord(
        'board-post',
        CODES[0],
        ALEX,
        'p'.repeat(BOARD_POST_MAX_BYTES + 1),
        '',
        null,
        T0,
        rand,
      ),
    ).toThrow(KIND_POLICY['board-post'].overCapMessage);
    // pod text is still capped at exactly 2048 bytes
    expect(TEXT_MAX_BYTES).toBe(2048);
    expect(() =>
      composeText(CODES[0], ALEX, 'x'.repeat(TEXT_MAX_BYTES + 1), null, T0, rand),
    ).toThrow(KIND_POLICY.text.overCapMessage);
    expect(
      composeText(CODES[0], ALEX, 'x'.repeat(TEXT_MAX_BYTES), null, T0, rand).id,
    ).toBeTruthy();
    // an empty body is refused per kind too
    expect(() =>
      composeRecord('board-post', CODES[0], ALEX, '', '', null, T0, rand),
    ).toThrow(KIND_POLICY['board-post'].emptyMessage);
  });

  test('TTL is per kind, at compose and at the lying-peer clamp', () => {
    const post = composeRecord('board-post', CODES[0], ALEX, BOARD_BODY, '', null, T0, rand);
    const note = composeRecord('camp-note', CODES[0], ALEX, NOTE_BODY, '', null, T0, rand);
    const text = composeText(CODES[0], ALEX, 'brief', null, T0, rand);
    expect(post.expires_min).toBe(T0 + BOARD_POST_TTL_MIN);
    expect(note.expires_min).toBe(T0 + CAMP_NOTE_TTL_MIN);
    expect(text.expires_min).toBe(T0 + MESSAGE_TTL_MIN);

    acceptIncoming(
      [
        wireRec({ id: 'liar-note', kind: 'camp-note', expires_min: T0 + 999_999 }),
        wireRec({ id: 'liar-post', kind: 'board-post', expires_min: T0 + 999_999 }),
        wireRec({ id: 'liar-text', expires_min: T0 + 999_999 }),
      ],
      CODES,
      T0,
    );
    expect(recordsOfKind('camp-note', CODES)[0].expires_min).toBe(T0 + CAMP_NOTE_TTL_MIN);
    expect(recordsOfKind('board-post', CODES)[0].expires_min).toBe(T0 + BOARD_POST_TTL_MIN);
    expect(
      inbox(CODES, BOB).find(m => m.id === 'liar-text')?.expires_min,
    ).toBe(T0 + MESSAGE_TTL_MIN);
  });

  test('the hop horizon is per kind: a note outlives a text at the pod horizon', () => {
    // hops 8 is the pod horizon — a text stops there, a longer-lived note
    // still has room, because its horizon scales with its lifetime
    expect(
      acceptIncoming(
        [wireRec({ id: 'note-h8', kind: 'camp-note', hops: MAX_HOPS })],
        CODES,
        T0,
      ),
    ).toBe(1);
    expect(acceptIncoming([wireRec({ id: 'text-h8', hops: MAX_HOPS })], CODES, T0)).toBe(0);
    expect(recordsOfKind('camp-note', CODES)[0].hops).toBe(MAX_HOPS + 1);
    // …and the note's own horizon still stops it
    expect(
      acceptIncoming(
        [wireRec({ id: 'note-h12', kind: 'camp-note', hops: NOTE_MAX_HOPS })],
        CODES,
        T0,
      ),
    ).toBe(0);
  });

  test('heard budgets are per cap group — long-lived records never evict pod mail', () => {
    // Board posts here expire SOONER than the pod fill, so a single global
    // oldest-expiring-first budget would evict them first. Separate groups
    // mean neither kind can starve the other.
    const fill = Array.from({ length: HEARD_CAP + 5 }, (_, i) =>
      wireRec({ id: `fill-${String(i).padStart(4, '0')}`, expires_min: T0 + 500 }),
    );
    const postIds = ['post-0', 'post-1', 'post-2'];
    const posts = postIds.map(id =>
      wireRec({ id, kind: 'board-post', body: BOARD_BODY, expires_min: T0 + 400 }),
    );
    expect(acceptIncoming([...fill, ...posts], CODES, T0)).toBe(fill.length + 3);

    const carried = new Set(syncDigest(CODES).map(e => e.id));
    expect(carried.size).toBe(HEARD_CAP + 3);
    for (const id of postIds) {
      expect(carried.has(id)).toBe(true);
    }
    expect(recordsOfKind('text', CODES)).toHaveLength(HEARD_CAP);
  });

  test('the budget is per POD too — a chatty camp pod cannot starve a quiet one', () => {
    // The defect this pins (cross-family review, Aug 24): with ONE budget
    // across every pod, a 60-person camp pod fills the store and eviction —
    // oldest-expiring first — deletes the 3-person friend pod's mail. The
    // intimate channel dies first precisely because it has less traffic
    // defending it. Here the quiet pod's mail expires soonest, so a global
    // budget would take exactly it.
    const QUIET = 'best-friends-2';
    const both = [...CODES, QUIET];
    const quietMail = [
      wireRec({ id: 'quiet-1', crew_code: QUIET, expires_min: T0 + 60 }),
      wireRec({ id: 'quiet-2', crew_code: QUIET, expires_min: T0 + 61 }),
    ];
    const loud = Array.from({ length: HEARD_CAP + 50 }, (_, i) =>
      wireRec({ id: `loud-${String(i).padStart(5, '0')}`, expires_min: T0 + 1000 }),
    );
    expect(acceptIncoming(quietMail, both, T0)).toBe(2);
    acceptIncoming(loud, both, T0);
    expect(recordsOfKind('text', CODES)).toHaveLength(HEARD_CAP);
    expect(recordsOfKind('text', [QUIET])).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('an unknown kind is refused, never stored, never relayed', () => {
  test('acceptIncoming drops it and keeps the rest of the batch', () => {
    expect(
      acceptIncoming(
        [
          { ...wireRec({ id: 'alien-1' }), kind: 'lost-and-found' },
          { ...wireRec({ id: 'alien-2' }), kind: '' },
          { ...wireRec({ id: 'alien-3' }), kind: 42 },
          wireRec({ id: 'good-1' }),
        ],
        CODES,
        T0,
      ),
    ).toBe(1);
    // nothing of the alien kind reached the table, so nothing is offered on
    expect(syncDigest(CODES).map(e => e.id)).toEqual(['good-1']);
    expect(recordsOfKind('text', CODES)).toHaveLength(1);
  });

  test('isStorableKind names only the five kinds — object prototype keys are not kinds', () => {
    expect(isStorableKind('text')).toBe(true);
    expect(isStorableKind('voice')).toBe(true);
    expect(isStorableKind('board-post')).toBe(true);
    expect(isStorableKind('camp-note')).toBe(true);
    expect(isStorableKind('pod-member')).toBe(true);
    expect(isStorableKind('toString')).toBe(false);
    expect(isStorableKind('constructor')).toBe(false);
    expect(isStorableKind(undefined)).toBe(false);
    expect(Object.keys(KIND_POLICY).sort()).toEqual([
      'board-post',
      'camp-note',
      'pod-member',
      'text',
      'voice',
    ]);
  });

  test('composeRecord refuses to mint one', () => {
    expect(() =>
      composeRecord(
        'lost-and-found' as WireRecord['kind'],
        CODES[0],
        ALEX,
        'x',
        '',
        null,
        T0,
        rand,
      ),
    ).toThrow();
    expect(syncDigest(CODES)).toEqual([]);
  });

  test('a peer offering an unknown kind over a real sync moves nothing', async () => {
    const alien = {
      ...wireRec({ id: 'alien-sync', expires_min: T0 + 100 }),
      kind: 'lost-and-found',
    };
    const alienLink: CrewSyncLink = {
      fetchDigest: async () =>
        encodeDigest([{ id: 'alien-sync', expires_min: T0 + 100 }]),
      fetchMessages: async () => encodeMessages([alien as any]),
    };
    expect((await syncWithPeer(alienLink, CODES, T0)).accepted).toBe(0);
    expect(syncDigest(CODES)).toEqual([]);
  });
});
