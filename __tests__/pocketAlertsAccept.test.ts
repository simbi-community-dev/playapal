/**
 * The accept-only hook at its TRUE layer (src/crews/messages.ts
 * subscribeRecordsAccepted), proven against the real shipped DDL on
 * node:sqlite — the crewMessages.test.ts harness. The pocket-alert lane's
 * accept-not-compose law is only as strong as this hook's own discipline:
 * it must fire from acceptIncoming with the rows AS STORED, and from
 * nothing else the store does.
 */

let mockConn: any;
const mockNotify = jest.fn(
  async (_category: string, _title: string, _body: string, _crewCode: string) =>
    true,
);
jest.mock('react-native', () => ({
  NativeModules: {
    PocketAlerts: {
      notify: (...a: [string, string, string, string]) => mockNotify(...a),
    },
  },
  AppState: { currentState: 'background' },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  Platform: { OS: 'android', Version: 33 },
}));

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  getSetting: (key: string) => {
    const rows = mockConn.execute(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    ).rows._array;
    return rows.length > 0 ? String(rows[0].value) : null;
  },
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  acceptIncoming,
  composeText,
  composeVoice,
  epochMinutes,
  markRead,
  POD_MEMBER_TTL_MIN,
  subscribeRecordsAccepted,
  type CrewRecord,
  type WireMessage,
} from '../src/crews/messages';
import { hash32 } from '../src/crews/beacon';
import { encodeMemberBody } from '../src/crews/podMembers';
import {
  POCKET_ALERTS_CHOICE_KEY,
  defaultPodIdentity,
  startPocketAlerts,
  stopPocketAlerts,
} from '../src/crews/pocketAlerts';
import { FRIEND_SELF_KEY, saveMyCard } from '../src/friends/friendCard';

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

const memberMsg = (
  cardId: string,
  name: string,
  createdMin: number,
  id: string,
  fromHash = hash32(cardId),
): WireMessage =>
  wireMsg({
    id,
    from_hash: fromHash,
    kind: 'pod-member',
    body: encodeMemberBody({ cardId, name }),
    created_min: createdMin,
    expires_min: createdMin + POD_MEMBER_TTL_MIN,
  });

function setSelfCard(name: string, seq: number): void {
  mockConn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [
      FRIEND_SELF_KEY,
      JSON.stringify({
        id: ME,
        seq,
        name,
        camp: '',
        address: '',
        note: '',
        updated_at: '',
        scope: 'crew',
      }),
    ],
  );
}

function grantPocketAlerts(): void {
  mockConn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?)',
    [POCKET_ALERTS_CHOICE_KEY, 'granted'],
  );
}

let batches: CrewRecord[][];
let unsub: () => void;

beforeEach(() => {
  mockConn = makePhone();
  randState = 0;
  batches = [];
  mockNotify.mockClear();
  unsub = subscribeRecordsAccepted(records => {
    batches.push(records);
  });
});

afterEach(() => {
  stopPocketAlerts();
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

describe('mention identity at the accept seam', () => {
  beforeEach(() => {
    grantPocketAlerts();
    startPocketAlerts(() => ME);
  });

  it('a delayed message still mentions the stable self card by its retained old name', () => {
    setSelfCard('OldName', 1);
    acceptIncoming(
      [memberMsg(ME, 'OldName', T0 - 10, 'cafe1234-29000000-b010')],
      CODES,
      T0,
    );
    saveMyCard(
      mockConn,
      { name: 'NewName', camp: '', address: '', note: '' },
      new Date('2026-08-31T12:01:00Z'),
    );
    acceptIncoming(
      [memberMsg(ME, 'NewName', T0 - 5, 'cafe1234-29000000-b011')],
      CODES,
      T0 + 1,
    );
    const identity = defaultPodIdentity(CODES[0])!;
    expect(identity.selfNames).toEqual(['NewName', 'OldName']);
    expect(identity.names.get(hash32(ME))).toBe('NewName');
    expect([...identity.names.values()]).not.toContain('OldName');

    acceptIncoming(
      [wireMsg({ id: 'cafe1234-29000000-b012', body: '@OldName bring water' })],
      CODES,
      T0 + 2,
    );

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('mention');
  });

  it('a current podmate who owns the old spelling prevents a self mention', () => {
    setSelfCard('OldName', 1);
    acceptIncoming(
      [memberMsg(ME, 'OldName', T0 - 15, 'cafe1234-29000000-b015')],
      CODES,
      T0,
    );
    setSelfCard('NewName', 2);
    acceptIncoming(
      [
        memberMsg(ME, 'NewName', T0 - 10, 'cafe1234-29000000-b016'),
        memberMsg(BOB, '  oldname  ', T0 - 5, 'cafe1234-29000000-b017'),
      ],
      CODES,
      T0 + 1,
    );

    acceptIncoming(
      [wireMsg({ id: 'cafe1234-29000000-b018', body: '@OldName bring water' })],
      CODES,
      T0 + 2,
    );

    expect(defaultPodIdentity(CODES[0])!.selfNames).toEqual(['NewName']);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('message');
  });

  it('keeps multiple unclaimed renames when the newest self row is stale', () => {
    setSelfCard('OldName', 1);
    acceptIncoming(
      [memberMsg(ME, 'OldName', T0 - 15, 'cafe1234-29000000-b040')],
      CODES,
      T0,
    );
    setSelfCard('MiddleName', 2);
    acceptIncoming(
      [memberMsg(ME, 'MiddleName', T0 - 10, 'cafe1234-29000000-b041')],
      CODES,
      T0 + 1,
    );
    setSelfCard('NewName', 3);

    expect(defaultPodIdentity(CODES[0])!.selfNames).toEqual([
      'NewName',
      'MiddleName',
      'OldName',
    ]);
    acceptIncoming(
      [wireMsg({ id: 'cafe1234-29000000-b042', body: '@OldName bring water' })],
      CODES,
      T0 + 2,
    );

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('mention');
  });

  it('unrelated and forged retained announcements cannot become self aliases', () => {
    setSelfCard('NewName', 2);
    acceptIncoming(
      [
        memberMsg('cccc3333', 'OldName', T0 - 10, 'cafe1234-29000000-b020'),
        memberMsg(
          ME,
          'OldName',
          T0 - 5,
          'cafe1234-29000000-b021',
          hash32(BOB),
        ),
      ],
      CODES,
      T0,
    );
    expect(defaultPodIdentity(CODES[0])!.selfNames).toEqual(['NewName']);

    acceptIncoming(
      [wireMsg({ id: 'cafe1234-29000000-b022', body: '@OldName bring water' })],
      CODES,
      T0 + 1,
    );

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('message');
  });

  it('the current self-card name still mentions normally', () => {
    setSelfCard('NewName', 2);

    acceptIncoming(
      [wireMsg({ id: 'cafe1234-29000000-b030', body: '@NewName bring water' })],
      CODES,
      T0,
    );

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('mention');
  });
});
