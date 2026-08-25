/**
 * WHAT THE POD MAILBOX MAY NEVER LOSE — the retention fence around the
 * answering machine's read path.
 *
 * The field report this file answers, measured on two phones Aug 24: the
 * JOINER phone had rendered a received text at 16:33, then ran the same-code
 * TWIN MERGE (dedupeCrewsByCode, the residue of the pre-idempotent join),
 * and half an hour later its mailbox appeared to hold only its own outgoing
 * rows. The store was cleared of suspicion by the radio's own log — at
 * 17:07:48 the joiner read the sender's whole digest and wrote NO want list,
 * which is the receiver saying "I already hold every id you carry" — and by
 * the live UI, which renders every row. Nothing was lost. But "nothing was
 * lost" is a claim about one evening; these are the invariants that make it
 * a claim about the code, so the next report of vanished mail starts from a
 * shorter list of suspects.
 *
 * Each test below is a suspect the field report named, closed:
 *
 *  - THE TWIN MERGE. Messages key on the CODE and crews key on the ID, so
 *    dropping a duplicate crew row must be invisible to the mailbox. The pod
 *    that survives a merge inherits its twin's mail because it never owned
 *    it separately in the first place.
 *  - THE CARD IDENTITY. inbox() filters `from_hash != me AND (to_hash IS
 *    NULL OR to_hash = me)`. Crew-wide mail — which is ALL pod mail, since
 *    every composeText/composeVoice caller in the app passes toCardId null —
 *    must therefore survive a card id changing under the reader. A phone
 *    that re-mints its identity loses its OUTBOX join, never the pod's mail.
 *  - THE HEARD CAP. Eviction is a ceiling, not a policy: a mailbox holding
 *    a handful of rows must come through prune untouched, whatever the mix
 *    of kinds sharing the store.
 *
 * Harness: podMembers.test.ts's — one in-memory database on the REAL shipped
 * DDL plus a settings map for the crew store.
 */

let mockConn: any;
let mockSettings: Map<string, string>;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import { hash32, normalizeCrewCode } from '../src/crews/beacon';
import { dedupeCrewsByCode, listCrews, type Crew } from '../src/crews/crew';
import {
  HEARD_CAP,
  MESSAGE_TTL_MIN,
  acceptIncoming,
  composeText,
  inbox,
  myOutbox,
  pruneExpired,
  recordsOfKind,
  unreadCount,
  type WireRecord,
} from '../src/crews/messages';
import {
  POD_MEMBER_KIND,
  reconcilePods,
  resetAnnounceGuard,
} from '../src/crews/podMembers';

const { DatabaseSync } = require('node:sqlite');

/** The pod both phones share, in the retired word-code shape the field pair
 * is actually holding — the store normalizes, so the spelling is incidental
 * and pinning it here proves that. */
const CODE = 'Electric-Flamingo-54';
const SENDER_CARD = 'aaaa1111'; // the phone that sent the mail
const READER_CARD = 'bbbb2222'; // the joiner reading it
const POD_NAME = 'Dust Bunnies';
const NOW = 29_000_000; // epoch minutes; any fixed clock does

function makePhone(): void {
  const db = new DatabaseSync(':memory:');
  mockConn = {
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
  mockSettings = new Map();
  for (const sql of BASE_TABLES_SQL) {
    mockConn.execute(sql);
  }
  resetAnnounceGuard();
}

/** The crews setting exactly as the pre-idempotent join left it: two rows,
 * one code, both wearing the name the mesh handed them. */
function seedTwins(): [Crew, Crew] {
  const newer: Crew = {
    id: 'crew-1756000200000-222222',
    name: POD_NAME,
    code: CODE,
    memberIds: ['friend-one'],
    nameSource: 'mesh',
  };
  const older: Crew = {
    id: 'crew-1756000100000-111111',
    name: POD_NAME,
    code: CODE,
    memberIds: ['friend-two'],
    nameSource: 'mesh',
  };
  // saveCrew unshifts, so the SECOND join sits at the head of the list.
  mockSettings.set('crews', JSON.stringify([newer, older]));
  return [newer, older];
}

/** One crew-wide record off the wire, minted the way composeRecord does. */
function heard(
  body: string,
  createdMin: number,
  kind: WireRecord['kind'] = 'text',
): WireRecord {
  const from = hash32(SENDER_CARD);
  return {
    id: `${from.toString(16)}-${createdMin}-${body.slice(0, 4).padEnd(4, '0')}`,
    crew_code: normalizeCrewCode(CODE),
    from_hash: from,
    to_hash: null, // every pod compose in the app is crew-wide
    kind,
    body,
    mime: kind === 'voice' ? 'audio/aac' : '',
    created_min: createdMin,
    expires_min: createdMin + MESSAGE_TTL_MIN,
    hops: 0,
  };
}

beforeEach(makePhone);

describe('the twin merge is invisible to the mailbox', () => {
  it('keeps received mail when two same-code pods collapse into one', () => {
    seedTwins();
    expect(acceptIncoming([heard('probeB1', NOW - 2)], [CODE], NOW)).toBe(1);
    expect(inbox([CODE], READER_CARD).map(m => m.body)).toEqual(['probeB1']);

    expect(dedupeCrewsByCode()).toBe(true);
    expect(listCrews()).toHaveLength(1);

    // The survivor is the OLDEST row, with both twins' picks unioned — and
    // it carries the same code, which is the whole reason the mail survives.
    const [survivor] = listCrews();
    expect(survivor.id).toBe('crew-1756000100000-111111');
    expect(survivor.memberIds.sort()).toEqual(['friend-one', 'friend-two']);
    expect(normalizeCrewCode(survivor.code)).toBe(normalizeCrewCode(CODE));

    expect(inbox([survivor.code], READER_CARD).map(m => m.body)).toEqual([
      'probeB1',
    ]);
    expect(unreadCount([survivor.code], READER_CARD)).toBe(1);
  });

  it('survives the reconcile pass that runs the merge, mail and all', () => {
    seedTwins();
    acceptIncoming([heard('probeB1', NOW - 2)], [CODE], NOW);
    composeText(CODE, READER_CARD, 'reply from the joiner', null, NOW);

    // reconcilePods merges FIRST and returns; the store's own notify re-fires
    // the effect, so the app calls it again against the merged rows.
    reconcilePods(listCrews(), READER_CARD, 'Nine', NOW);
    reconcilePods(listCrews(), READER_CARD, 'Nine', NOW);

    const [survivor] = listCrews();
    expect(inbox([survivor.code], READER_CARD).map(m => m.body)).toEqual([
      'probeB1',
    ]);
    expect(myOutbox([survivor.code], READER_CARD).map(m => m.body)).toEqual([
      'reply from the joiner',
    ]);
    // The announcement the reconcile minted rides the same store and stays
    // OUT of the mailbox — carried, never shown.
    expect(recordsOfKind(POD_MEMBER_KIND, [survivor.code])).toHaveLength(1);
    expect(inbox([survivor.code], READER_CARD)).toHaveLength(1);
  });
});

describe('crew-wide mail outlives the reader’s own identity', () => {
  it('still renders after the card id changes under the reader', () => {
    seedTwins();
    acceptIncoming(
      [heard('probeB1', NOW - 2), heard('QQQQ'.repeat(1130), NOW - 1, 'voice')],
      [CODE],
      NOW,
    );
    composeText(CODE, READER_CARD, 'reply from the joiner', null, NOW);
    dedupeCrewsByCode();

    const reminted = 'cccc3333';
    const bodies = inbox([CODE], reminted).map(m => m.body.slice(0, 7));
    // Both received records, plus the reader's OWN row — which re-keys out of
    // the outbox and into the inbox, and still renders as "You" because the
    // row's origin, not the query it arrived through, is what names a sender.
    expect(bodies).toContain('probeB1');
    expect(bodies).toContain('QQQQQQQ');
    expect(myOutbox([CODE], reminted)).toHaveLength(0);
    expect(
      inbox([CODE], reminted).filter(m => m.origin === 'mine'),
    ).toHaveLength(1);
  });

  it('is the SENDER hash, not the origin column, that the inbox excludes', () => {
    seedTwins();
    acceptIncoming([heard('probeB1', NOW - 2)], [CODE], NOW);
    // Reading as the sender is the one identity that hides the sender's mail,
    // and no path in the app can put another phone's card id here.
    expect(inbox([CODE], SENDER_CARD)).toHaveLength(0);
    expect(inbox([CODE], READER_CARD)).toHaveLength(1);
  });
});

describe('the heard cap is a ceiling, never a policy', () => {
  it('leaves a small mailbox untouched through a prune', () => {
    seedTwins();
    const batch = Array.from({ length: 40 }, (_, i) =>
      heard(`note-${String(i).padStart(2, '0')}`, NOW - 60 + i),
    );
    expect(acceptIncoming(batch, [CODE], NOW)).toBe(40);
    composeText(CODE, READER_CARD, 'mine too', null, NOW);

    expect(pruneExpired(NOW)).toBe(0);
    expect(inbox([CODE], READER_CARD)).toHaveLength(40);
    expect(myOutbox([CODE], READER_CARD)).toHaveLength(1);
    // Well under the budget it would take to evict anything at all.
    expect(HEARD_CAP).toBeGreaterThan(40);
  });
});
