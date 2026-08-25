/**
 * The answering machine's radio-independent core (CREW-DESIGN.md §6b/§6a):
 * the message store + gossip policy (src/crews/messages.ts) and the
 * injected sync link + codec (src/crews/syncLink.ts), proven against the
 * REAL shipped DDL on node:sqlite — the favorites.test.ts harness, so the
 * crew_messages schema cannot drift from what these tests pass.
 *
 * The gossip proofs run REAL multi-phone exchanges: each "phone" is its
 * own in-memory database, and an in-memory CrewSyncLink serves one
 * phone's digest/messages to another by swapping which db the mocked
 * getDb() returns during the peer's serve call.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  ANCIENT_OFFER_MIN,
  CLOCK_SKEW_TOLERANCE_MIN,
  HEARD_CAP,
  POD_MEMBER_TTL_MIN,
  MAX_HOPS,
  MESSAGE_TTL_MIN,
  TEXT_MAX_BYTES,
  VOICE_MAX_BYTES,
  acceptIncoming,
  composeText,
  composeVoice,
  epochMinutes,
  inbox,
  markRead,
  messagesRevision,
  myOutbox,
  pruneExpired,
  subscribeMessagesChanged,
  syncDigest,
  unreadCount,
  wantsFrom,
  type WireMessage,
} from '../src/crews/messages';
import {
  MAX_FETCH_IDS,
  decodeDigest,
  decodeMessages,
  encodeDigest,
  encodeMessages,
  serveDigest,
  serveMessages,
  syncWithPeer,
  type CrewSyncLink,
} from '../src/crews/syncLink';
import { hash32 } from '../src/crews/beacon';
import { getMyCard, saveMyCard } from '../src/friends/friendCard';

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
/** Epoch minutes, late Aug 2026 — any fixed value works, time is injected. */
const T0 = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));

// Deterministic injected rand: strides through [0,1) so consecutive mints
// never collide, and resets per test for reproducible ids.
let randState = 0;
const rand = () => {
  randState = (randState + 0.317) % 1;
  return randState;
};

/** An in-memory link: this phone syncs FROM `peer` (steps 1+3 of the
 * exchange run against the peer's db through the serve side). */
const linkTo = (peer: any): CrewSyncLink => ({
  fetchDigest: async () => onPhone(peer, () => serveDigest(CODES, T0)),
  fetchMessages: async ids => onPhone(peer, () => serveMessages(ids, T0)),
});

/** A valid heard-side wire message, overridable per test. */
const wireMsg = (over: Partial<WireMessage> = {}): WireMessage => ({
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

beforeEach(() => {
  mockConn = makePhone();
  randState = 0;
});

// ---------------------------------------------------------------------------

describe('compose + inbox + unread + markRead', () => {
  test('crew-wide and directed messages land in the right inboxes, newest first', () => {
    composeText(CODES[0], ALEX, 'meet at the trash fence at 3', null, T0, rand);
    const direct = composeText(CODES[0], ALEX, 'bob: bring the pump', BOB, T0 + 1, rand);

    const bobs = inbox(CODES, BOB);
    expect(bobs.map(m => m.body)).toEqual([
      'bob: bring the pump', // T0+1, newest first
      'meet at the trash fence at 3',
    ]);
    // Cara sees only the crew-wide note; Bob's directed mail is not hers
    expect(inbox(CODES, CARA).map(m => m.body)).toEqual([
      'meet at the trash fence at 3',
    ]);
    // my own messages never appear in my inbox
    expect(inbox(CODES, ALEX)).toEqual([]);
    // …but they are my outbox, origin mine, hops 0
    const out = myOutbox(CODES, ALEX);
    expect(out).toHaveLength(2);
    expect(out.every(m => m.origin === 'mine' && m.hops === 0)).toBe(true);

    expect(unreadCount(CODES, BOB)).toBe(2);
    markRead(direct.id, T0 + 5);
    expect(unreadCount(CODES, BOB)).toBe(1);
    expect(inbox(CODES, BOB).find(m => m.id === direct.id)?.read_at).toBe(T0 + 5);
  });

  test('markRead is a silent no-op for unknown or already-read ids', () => {
    const m = composeText(CODES[0], ALEX, 'hi', null, T0, rand);
    markRead(m.id, T0 + 1);
    const after = messagesRevision();
    markRead(m.id, T0 + 2); // already read
    markRead('nope', T0 + 2); // unknown
    expect(messagesRevision()).toBe(after);
  });

  test('crew codes normalize everywhere — dusty typing joins one mailbox', () => {
    composeText(' Dusty-Llamas-7 ', ALEX, 'howdy', null, T0, rand);
    expect(inbox(['DUSTY-LLAMAS-7'], BOB)).toHaveLength(1);
    expect(syncDigest([' dusty-llamas-7'])).toHaveLength(1);
  });

  test('compose enforces the same caps the accept gate does', () => {
    expect(() => composeText(CODES[0], ALEX, '   ', null, T0, rand)).toThrow();
    expect(() =>
      composeText(CODES[0], ALEX, 'x'.repeat(TEXT_MAX_BYTES + 1), null, T0, rand),
    ).toThrow();
    expect(() =>
      composeVoice(CODES[0], ALEX, 'A'.repeat(VOICE_MAX_BYTES + 1), 'audio/opus', null, T0, rand),
    ).toThrow();
    const v = composeVoice(CODES[0], ALEX, 'QUJD', 'audio/opus', BOB, T0, rand);
    expect(v.kind).toBe('voice');
    expect(v.mime).toBe('audio/opus');
    expect(inbox(CODES, BOB)[0].body).toBe('QUJD');
  });

  // The seam that shipped a phantom badge (blocker 2026-08-24): the tab bar
  // recomputes unreadCount on every revision bump with a FRESH getMyCard read,
  // while the open pod holds the id it read at mount. When an unsaved card
  // re-minted its id per read, those two disagreed and the camper's own
  // message counted as waiting mail — which markRead cannot clear, because it
  // is skipped for mail I sent. The identity source is the fix; this is the
  // arithmetic that proves it, on a phone that never saved a card.
  test('a phone that skipped setup never counts its own mail', () => {
    const me = () => getMyCard(mockConn).id;
    expect(getMyCard(mockConn).name).toBe(''); // "Skip setup" state

    const mountId = me(); // what PodMessages froze at mount
    composeText(CODES[0], me(), 'anyone got a spare bike pump?', null, T0, rand);

    expect(unreadCount(CODES, me())).toBe(0); // the tab bar
    expect(unreadCount(CODES, mountId)).toBe(0); // the open pod — and they agree
    expect(inbox(CODES, me())).toEqual([]);
    expect(myOutbox(CODES, me())).toHaveLength(1);

    // Still zero as the camper keeps talking…
    composeText(CODES[0], me(), 'coffee at sunrise', null, T0 + 1, rand);
    composeText(CODES[0], me(), 'back by 4', null, T0 + 2, rand);
    expect(unreadCount(CODES, me())).toBe(0);

    // …and a crewmate's note is still counted, so the badge is not just dead.
    composeText(CODES[0], ALEX, 'pump is at the shade structure', null, T0 + 3, rand);
    expect(unreadCount(CODES, me())).toBe(1);

    // Naming yourself later keeps the identity: the pre-name mail stays mine.
    saveMyCard(mockConn, { name: 'Juniper', camp: '', address: '', note: '' });
    expect(getMyCard(mockConn).id).toBe(mountId);
    expect(unreadCount(CODES, me())).toBe(1);
    expect(myOutbox(CODES, me())).toHaveLength(3);
  });

  test('a compose notifies subscribers and bumps the revision', () => {
    const before = messagesRevision();
    const fired = jest.fn();
    const off = subscribeMessagesChanged(fired);
    composeText(CODES[0], ALEX, 'ping', null, T0, rand);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(messagesRevision()).toBeGreaterThan(before);
    off();
    composeText(CODES[0], ALEX, 'pong', null, T0, rand);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('retention — TTL and the heard cap', () => {
  test('messages die a playa day after composing', () => {
    const m = composeText(CODES[0], ALEX, 'ephemeral', null, T0, rand);
    expect(m.expires_min).toBe(T0 + MESSAGE_TTL_MIN);
    expect(pruneExpired(T0 + MESSAGE_TTL_MIN - 1)).toBe(0);
    expect(inbox(CODES, BOB)).toHaveLength(1);
    expect(pruneExpired(T0 + MESSAGE_TTL_MIN)).toBe(1);
    expect(inbox(CODES, BOB)).toHaveLength(0);
  });

  test('heard rows cap at HEARD_CAP, oldest-expiring evicted first; mine survive', () => {
    const mine = composeText(CODES[0], ALEX, 'my own note', null, T0, rand);
    const shortIds = ['dies-0', 'dies-1', 'dies-2', 'dies-3', 'dies-4'];
    const longIds = ['lives-0', 'lives-1', 'lives-2', 'lives-3', 'lives-4'];
    const batch: WireMessage[] = [
      ...shortIds.map(id => wireMsg({ id, expires_min: T0 + 3 })),
      ...Array.from({ length: HEARD_CAP + 90 }, (_, i) =>
        wireMsg({ id: `fill-${String(i).padStart(4, '0')}`, expires_min: T0 + 500 }),
      ),
      ...longIds.map(id => wireMsg({ id, expires_min: T0 + 1400 })),
    ];
    expect(acceptIncoming(batch, CODES, T0)).toBe(batch.length);
    const carried = new Set(syncDigest(CODES).map(e => e.id));
    // 2000 heard survive + my own message rides above the cap
    expect(carried.size).toBe(HEARD_CAP + 1);
    expect(carried.has(mine.id)).toBe(true);
    for (const id of shortIds) {
      expect(carried.has(id)).toBe(false); // soonest-expiring went first
    }
    for (const id of longIds) {
      expect(carried.has(id)).toBe(true); // freshest mail is safe
    }
  });
});

// ---------------------------------------------------------------------------

describe('the accept gate', () => {
  test('rejects unknown crews, expired mail, oversized bodies, junk shapes', () => {
    const good = wireMsg();
    expect(
      acceptIncoming(
        [
          wireMsg({ id: 'a', crew_code: 'someone-elses-crew' }),
          wireMsg({ id: 'b', expires_min: T0 }), // dead on arrival
          wireMsg({ id: 'c', body: 'x'.repeat(TEXT_MAX_BYTES + 1) }),
          wireMsg({ id: 'd', kind: 'voice', body: 'A'.repeat(VOICE_MAX_BYTES + 1) }),
          wireMsg({ id: 'e', from_hash: -1 }),
          wireMsg({ id: 'f', hops: -1 }),
          { total: 'junk' },
          null,
          good,
        ],
        CODES,
        T0,
      ),
    ).toBe(1);
    const [row] = inbox(CODES, BOB);
    expect(row.id).toBe(good.id);
    expect(row.origin).toBe('heard');
    expect(row.hops).toBe(1);
    expect(row.read_at).toBeNull();
  });

  test('a lying peer cannot mint immortal mail — expiry clamps to now + TTL', () => {
    acceptIncoming([wireMsg({ expires_min: T0 + 999_999 })], CODES, T0);
    expect(inbox(CODES, BOB)[0].expires_min).toBe(T0 + MESSAGE_TTL_MIN);
  });

  test('the hop horizon: hops 7 lands as 8 and then stops spreading', () => {
    expect(acceptIncoming([wireMsg({ hops: MAX_HOPS - 1 })], CODES, T0)).toBe(1);
    const stored = inbox(CODES, BOB)[0];
    expect(stored.hops).toBe(MAX_HOPS);
    // offering it onward: the next phone refuses the at-horizon copy
    const served = serveMessages([stored.id], T0);
    const next = makePhone();
    expect(onPhone(next, () => acceptIncoming(decodeMessages(served), CODES, T0))).toBe(0);
    // and a straight at-horizon arrival never lands at all
    expect(acceptIncoming([wireMsg({ id: 'h8', hops: MAX_HOPS })], CODES, T0)).toBe(0);
  });

  test('dedupe: the same batch twice writes once', () => {
    const batch = [wireMsg(), wireMsg({ id: 'other-1' })];
    expect(acceptIncoming(batch, CODES, T0)).toBe(2);
    expect(acceptIncoming(batch, CODES, T0)).toBe(0);
    expect(inbox(CODES, BOB)).toHaveLength(2);
  });

  test('a phone CARRIES mail addressed to someone else without showing it', () => {
    const forCara = wireMsg({ to_hash: hash32(CARA) });
    acceptIncoming([forCara], CODES, T0);
    expect(inbox(CODES, BOB)).toHaveLength(0); // not shown to Bob…
    expect(syncDigest(CODES).map(e => e.id)).toEqual([forCara.id]); // …but offered onward
    expect(inbox(CODES, CARA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('gossip — store-and-forward across phones', () => {
  test('THE RELAY PROOF: A composes, B hears from A, C hears from B', async () => {
    const phoneA = makePhone();
    const phoneB = makePhone();
    const phoneC = makePhone();

    mockConn = phoneA;
    const sent = composeText(CODES[0], ALEX, 'whiteout — regroup at camp', null, T0, rand);

    mockConn = phoneB;
    expect((await syncWithPeer(linkTo(phoneA), CODES, T0)).accepted).toBe(1);
    const heardByB = inbox(CODES, BOB);
    expect(heardByB.map(m => ({ id: m.id, hops: m.hops, origin: m.origin }))).toEqual([
      { id: sent.id, hops: 1, origin: 'heard' },
    ]);

    // C never meets A — B physically carries the mail across camp
    mockConn = phoneC;
    expect((await syncWithPeer(linkTo(phoneB), CODES, T0)).accepted).toBe(1);
    const heardByC = inbox(CODES, CARA);
    expect(heardByC[0].body).toBe('whiteout — regroup at camp');
    expect(heardByC[0].hops).toBe(2);

    // convergence: every further exchange is a no-op
    mockConn = phoneB;
    expect((await syncWithPeer(linkTo(phoneA), CODES, T0)).accepted).toBe(0);
    expect((await syncWithPeer(linkTo(phoneC), CODES, T0)).accepted).toBe(0);
    mockConn = phoneA; // the author never re-hears their own message
    expect((await syncWithPeer(linkTo(phoneC), CODES, T0)).accepted).toBe(0);
    expect(myOutbox(CODES, ALEX)).toHaveLength(1);
  });

  test('nothing new offered -> the message fetch is skipped entirely', async () => {
    const emptyPeer = makePhone();
    const fetchMessages = jest.fn(async (ids: string[]) =>
      onPhone(emptyPeer, () => serveMessages(ids, T0)),
    );
    const link: CrewSyncLink = {
      fetchDigest: async () => onPhone(emptyPeer, () => serveDigest(CODES, T0)),
      fetchMessages,
    };
    expect((await syncWithPeer(link, CODES, T0)).accepted).toBe(0);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  test('a big mailbox syncs across sightings, MAX_FETCH_IDS at a time', async () => {
    const peer = makePhone();
    const batch = Array.from({ length: MAX_FETCH_IDS + 6 }, (_, i) =>
      wireMsg({ id: `bulk-${String(i).padStart(3, '0')}`, expires_min: T0 + 100 + i }),
    );
    onPhone(peer, () => acceptIncoming(batch, CODES, T0));
    expect((await syncWithPeer(linkTo(peer), CODES, T0)).accepted).toBe(MAX_FETCH_IDS);
    expect((await syncWithPeer(linkTo(peer), CODES, T0)).accepted).toBe(6);
    expect((await syncWithPeer(linkTo(peer), CODES, T0)).accepted).toBe(0);
  });

  test('a dead link rejects with a human-actionable error, original cause kept', async () => {
    const link: CrewSyncLink = {
      fetchDigest: async () => {
        throw new Error('gatt: peer disconnected');
      },
      fetchMessages: async () => new Uint8Array(),
    };
    await expect(syncWithPeer(link, CODES, T0)).rejects.toThrow(/next sighting/);
    await expect(syncWithPeer(link, CODES, T0)).rejects.toThrow(/gatt: peer disconnected/);
  });

  test('expired mail is pruned before serving, never offered', () => {
    acceptIncoming([wireMsg({ id: 'dying', expires_min: T0 + 1 })], CODES, T0);
    expect(decodeDigest(serveDigest(CODES, T0 + 2))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('the wire codec', () => {
  test('digest round-trips', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      id: `d-${i}`,
      expires_min: T0 + i,
    }));
    expect(decodeDigest(encodeDigest(entries))).toEqual(entries);
    expect(decodeDigest(encodeDigest([]))).toEqual([]);
  });

  test('messages round-trip, multi-KB voice base64 and unicode intact', () => {
    const voice = composeVoice(
      CODES[0],
      ALEX,
      'QUJDREVGRw+/'.repeat(6000), // ~70 KB of base64-looking payload
      'audio/opus',
      null,
      T0,
      rand,
    );
    const text = composeText(CODES[0], ALEX, '¡nos vemos en la 7:30! 🦩 深夜', BOB, T0 + 1, rand);
    const decoded = decodeMessages(encodeMessages([voice, text])) as WireMessage[];
    expect(decoded).toHaveLength(2);
    expect(decoded[0].body).toBe(voice.body);
    expect(decoded[1].body).toBe('¡nos vemos en la 7:30! 🦩 深夜');
    expect(decoded[1].to_hash).toBe(hash32(BOB));
    // local-only fields never ride the wire
    expect('origin' in (decoded[0] as object)).toBe(false);
    expect('read_at' in (decoded[0] as object)).toBe(false);
  });

  test('wire rows re-accept on the far side — codec and gate agree', () => {
    const m = composeText(CODES[0], ALEX, 'over the wire', null, T0, rand);
    const far = makePhone();
    const bytes = encodeMessages([m]);
    expect(onPhone(far, () => acceptIncoming(decodeMessages(bytes), CODES, T0))).toBe(1);
    expect(onPhone(far, () => inbox(CODES, BOB)[0].body)).toBe('over the wire');
  });

  test('truncated, garbled, and wrong-shape frames throw instead of mis-parsing', () => {
    const whole = encodeDigest([{ id: 'x', expires_min: T0 + 1 }]);
    expect(() => decodeDigest(whole.slice(0, whole.length - 3))).toThrow(/cut short/);
    expect(() => decodeDigest(new Uint8Array([1, 2]))).toThrow();
    // valid frame around non-JSON bytes
    const junk = new Uint8Array([0, 0, 0, 3, 0x68, 0x69, 0x21]); // "hi!"
    expect(() => decodeMessages(junk)).toThrow(/JSON/);
    // valid frame + valid JSON, wrong shape (not a list)
    const obj = encodeDigest([]).slice();
    const notList = new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]); // "{}"
    expect(() => decodeDigest(notList)).toThrow(/list/);
    expect(obj.length).toBeGreaterThan(0);
  });

  test('serveMessages honors the id cap and skips unknown ids', () => {
    for (let i = 0; i < 3; i++) {
      composeText(CODES[0], ALEX, `note ${i}`, null, T0 + i, rand);
    }
    const ids = syncDigest(CODES).map(e => e.id);
    const asked = [...ids, 'ghost-id', ...Array.from({ length: 200 }, (_, i) => `pad-${i}`)];
    const served = decodeMessages(serveMessages(asked, T0)) as WireMessage[];
    expect(served.map(m => m.body).sort()).toEqual(['note 0', 'note 1', 'note 2']);
  });
});

// ---------------------------------------------------------------------------

describe('wantsFrom — the want-list gate', () => {
  test('skips held ids, ANCIENT offers, junk entries, and duplicate offers', () => {
    // NOTE what is no longer skipped: an offer expiring "now".
    //
    // `expires_min` is the OFFERING phone's stamp on the OFFERING phone's
    // clock, and playa phones have no cell or NTP. An offer that reads as
    // just-expired to us is genuinely AMBIGUOUS: either it died with the
    // clocks agreeing, or it is perfectly live and we are running a day fast.
    // A digest entry carries nothing that can tell those apart.
    //
    // Filtering it here was the bug: this gate stands one call BEFORE
    // acceptIncoming on the only sync path, and syncWithPeer returns the
    // moment the want list is empty — so past ~24 h of receiver-ahead skew
    // the phone asked for nothing and the repaired accept gate was never
    // reached. Fetching one corpse is the cheap half of that trade, and the
    // want ledger backs the id off when it does not land.
    const held = composeText(CODES[0], ALEX, 'already have this', null, T0, rand);
    const want = wantsFrom(
      [
        { id: held.id, expires_min: T0 + 100 },
        { id: 'fresh-1', expires_min: T0 + 100 },
        { id: 'fresh-1', expires_min: T0 + 100 }, // duplicate offer
        { id: 'ambiguous', expires_min: T0 }, // expired by OUR clock — WANTED now
        { id: 'ancient', expires_min: T0 - ANCIENT_OFFER_MIN - 1 }, // past any skew
        { id: '', expires_min: T0 + 100 }, // junk
        { id: 'x'.repeat(200), expires_min: T0 + 100 }, // oversized id
      ],
      T0,
    );
    expect(want).toEqual(['fresh-1', 'ambiguous']);
  });

  test('the ancient bound is derived from the longest TTL, not hardcoded', () => {
    // Mutation: hardcode it to MESSAGE_TTL_MIN and every 7-day kind
    // (camp-note, pod-member) starts being skipped as ancient while it is
    // still perfectly alive — a silent roster and camp-note blackout.
    expect(ANCIENT_OFFER_MIN).toBeGreaterThanOrEqual(
      POD_MEMBER_TTL_MIN + CLOCK_SKEW_TOLERANCE_MIN,
    );
  });
});
