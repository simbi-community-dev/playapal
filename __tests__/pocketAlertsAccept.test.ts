/**
 * The accept-only hook at its TRUE layer (src/crews/messages.ts
 * subscribeRecordsAccepted), proven against the real shipped DDL on
 * node:sqlite — the crewMessages.test.ts harness. The pocket-alert lane's
 * accept-not-compose law is only as strong as this hook's own discipline:
 * it must fire from acceptIncoming with the rows AS STORED, and from
 * nothing else the store does.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  acceptIncoming,
  composeText,
  composeVoice,
  epochMinutes,
  markRead,
  subscribeRecordsAccepted,
  type CrewRecord,
  type WireMessage,
} from '../src/crews/messages';
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

const CODES = ['dusty-llamas-7'];
const ME = 'aaaa1111';
const BOB = 'bbbb2222';
const T0 = epochMinutes(Date.parse('2026-08-31T12:00:00Z'));

let randState = 0;
const rand = () => {
  randState = (randState + 0.317) % 1;
  return randState;
};

const wireMsg = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'cafe1234-29000000-beef',
  crew_code: CODES[0],
  from_hash: hash32(BOB),
  to_hash: null,
  kind: 'text',
  body: 'ice run at noon',
  mime: '',
  created_min: T0 - 5,
  expires_min: T0 + 60,
  hops: 1,
  ...over,
});

let batches: CrewRecord[][];
let unsub: () => void;

beforeEach(() => {
  mockConn = makePhone();
  randState = 0;
  batches = [];
  unsub = subscribeRecordsAccepted(records => {
    batches.push(records);
  });
});

afterEach(() => {
  unsub();
});

it('acceptIncoming fires ONE batch with the rows AS THIS PHONE STORED them', () => {
  const accepted = acceptIncoming([wireMsg(), wireMsg({ id: 'cafe1234-29000000-bee2', kind: 'voice', mime: 'audio/aac' })], CODES, T0);
  expect(accepted).toBe(2);
  // One accept call = one batch (the burst-batching law's substrate).
  // Mutation: fire per record inside the loop — this length becomes 2.
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(2);
  const row = batches[0][0];
  // The hook's rows are the STORED truth, not the wire's claims:
  // origin stamped 'heard', the hop counted, unread.
  // Mutation: push the raw wire message — origin is undefined, hops is 1.
  expect(row.origin).toBe('heard');
  expect(row.hops).toBe(2);
  expect(row.read_at).toBeNull();
  // And the expiry the hook reports IS the expiry the table holds — the
  // hoisted expiresLocal cannot drift from the INSERT.
  const dbRow = mockConn.execute(
    'SELECT expires_min FROM crew_messages WHERE id = ?',
    [row.id],
  ).rows._array[0];
  expect(Number(dbRow.expires_min)).toBe(row.expires_min);
});

it('ACCEPT-NOT-COMPOSE: this phone writing its own store fires nothing', () => {
  // Mutation: call notifyRecordsAccepted from composeRecord (or reuse the
  // messagesChanged emitter) — a camper's own message reaches the buzz
  // lane wearing an "arrival" costume.
  composeText(CODES[0], ME, 'my own words', null, T0, rand);
  composeVoice(CODES[0], ME, 'QUJD', 'audio/aac', null, T0, rand);
  expect(batches).toHaveLength(0);
  // …and the local-only read stamp is a write too, not an arrival.
  markRead('nonexistent', T0);
  expect(batches).toHaveLength(0);
});

it('refused records fire nothing — the hook reports arrivals, not attempts', () => {
  // A stranger's crew and a hops-dead copy are both turned away at the
  // gate; an empty accept must not wake any listener with an empty batch.
  acceptIncoming(
    [
      wireMsg({ crew_code: 'not-my-crew-1' }),
      wireMsg({ id: 'cafe1234-29000000-bee3', hops: 99 }),
    ],
    CODES,
    T0,
  );
  expect(batches).toHaveLength(0);
  // A duplicate of something already held is a no-op, not a re-arrival —
  // re-buzzing on every re-offer of the same id would turn gossip's
  // dedupe into a vibration loop.
  acceptIncoming([wireMsg()], CODES, T0);
  expect(batches).toHaveLength(1);
  acceptIncoming([wireMsg()], CODES, T0);
  expect(batches).toHaveLength(1);
});
