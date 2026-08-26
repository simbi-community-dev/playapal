/**
 * Pod member announcements (src/crews/podMembers.ts) — how identity travels
 * a mesh where pods are joined by a CODE. The measured bug this closes, on
 * two real phones: the joiner saw the raw join code where the pod's name
 * belongs, "0 people" under a podmate who was beaconing at that moment, and
 * "someone in the pod" over a message with a perfectly good author.
 *
 * What this file pins:
 *  - the body codec, including tolerance of a version this build never
 *    minted (a v2 announcement still produces a roster row),
 *  - newest-per-author resolution, and the from_hash/cardId check that
 *    stops one author occupying another's roster slot,
 *  - the roster as announced ∪ picked, deduped by card id, me excluded,
 *  - the announce cadence: join/create/rename now, refresh at half TTL,
 *    nothing at all from a phone with no name on its card,
 *  - pod-name adoption — a placeholder adopts, a typed name never does, and
 *    only a NAMER's announcement carries a pod name,
 *  - the record relaying A -> B -> C over the real sync path,
 *  - the per-kind policy: 7-day life, 512-byte envelope, and a cap group of
 *    its own so a camp full of nameplates can never evict pod mail.
 *
 * Harness: gossipRecords.test.ts's — each "phone" is its own in-memory
 * database on the REAL shipped DDL plus its own settings map for the crew
 * store, and an in-memory CrewSyncLink serves one phone to another by
 * swapping which db the mocked getDb() returns.
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
import { hash32 } from '../src/crews/beacon';
import {
  isPlaceholderPodName,
  joinCrew,
  listCrews,
  newCrew,
  podDisplayName,
  podLabel,
  podNameSource,
  saveCrew,
  type Crew,
} from '../src/crews/crew';
import {
  HEARD_CAP,
  KIND_POLICY,
  POD_MEMBER_HEARD_CAP,
  POD_MEMBER_MAX_BYTES,
  POD_MEMBER_TTL_MIN,
  acceptIncoming,
  composeRecord,
  composeText,
  inbox,
  pruneExpired,
  recordsOfKind,
  unreadCount,
  utf8ByteLength,
  type WireRecord,
} from '../src/crews/messages';
import {
  MEMBER_NAME_MAX,
  MEMBER_REFRESH_MIN,
  POD_MEMBER_KIND,
  adoptPodName,
  announceMembership,
  announcedMembers,
  announcedNames,
  announcedPodName,
  decodeMemberBody,
  encodeMemberBody,
  myAnnouncement,
  podRoster,
  reconcilePods,
  resetAnnounceGuard,
} from '../src/crews/podMembers';
import { serveDigest, serveMessages, syncWithPeer } from '../src/crews/syncLink';
import type { CrewSyncLink } from '../src/crews/syncLink';

const { DatabaseSync } = require('node:sqlite');

interface Phone {
  conn: any;
  settings: Map<string, string>;
}

function makePhone(): Phone {
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
  return { conn, settings: new Map() };
}

/** Point the mocked store at one phone. */
function switchTo(p: Phone): void {
  mockConn = p.conn;
  mockSettings = p.settings;
  resetAnnounceGuard();
}

/** Run a block as one phone, then restore. */
function on<T>(p: Phone, fn: () => T): T {
  const prevConn = mockConn;
  const prevSettings = mockSettings;
  switchTo(p);
  try {
    return fn();
  } finally {
    mockConn = prevConn;
    mockSettings = prevSettings;
  }
}

/** A pull-sync FROM `server` INTO the current phone, over the real codec. */
function linkTo(server: Phone, nowMin: number): CrewSyncLink {
  return {
    async fetchDigest() {
      return on(server, () => serveDigest(listCrews().map(c => c.code), nowMin));
    },
    async fetchMessages(ids: string[]) {
      return on(server, () => serveMessages(ids, NOW));
    },
  };
}

const CODE = '4207';
const NOW = 29_000_000; // epoch minutes, a round number to reason about

/** Ada creates and NAMES the pod; Bo and Cy join by code. */
const ada = { card: 'aaaa1111', name: 'Ada Dust' };
const bo = { card: 'bbbb2222', name: 'Bo Lantern' };
const cy = { card: 'cccc3333', name: 'Cy Ember' };

const cardOf = (id: string, name: string, address = '') => ({
  id,
  name,
  camp: '',
  address,
  updated_at: '',
});

let A: Phone;
let B: Phone;

beforeEach(() => {
  A = makePhone();
  B = makePhone();
  switchTo(A);
});

// ---------------------------------------------------------------- the codec

describe('the announcement body — this lane owns it, the substrate never looks', () => {
  test('round-trips, and drops the pod name when there is none', () => {
    const withPod = decodeMemberBody(
      encodeMemberBody({ cardId: ada.card, name: ada.name, podName: 'Dawn patrol' }),
    );
    expect(withPod).toEqual({
      cardId: ada.card,
      name: ada.name,
      podName: 'Dawn patrol',
    });
    const plain = decodeMemberBody(
      encodeMemberBody({ cardId: bo.card, name: bo.name }),
    );
    expect(plain).toEqual({ cardId: bo.card, name: bo.name });
    expect(plain).not.toHaveProperty('podName');
  });

  test('the version marker rides INSIDE the body, and v2 still reads', () => {
    expect(JSON.parse(encodeMemberBody({ cardId: ada.card, name: 'Ada' })).v).toBe(1);
    // A newer phone's body: fields we know, fields we don't, and a version
    // this build never minted. A roster row beats a hole.
    const v2 = JSON.stringify({
      v: 2,
      cardId: cy.card,
      name: 'Cy',
      podName: 'Night crew',
      avatarHue: 210,
    });
    expect(decodeMemberBody(v2)).toEqual({
      cardId: cy.card,
      name: 'Cy',
      podName: 'Night crew',
    });
  });

  test('junk is null, never a blank row', () => {
    expect(decodeMemberBody('not json')).toBeNull();
    expect(decodeMemberBody('[]')).toBeNull();
    expect(decodeMemberBody(JSON.stringify({ cardId: 'x', name: 'y' }))).toBeNull(); // no v
    expect(decodeMemberBody(JSON.stringify({ v: 0, cardId: 'x', name: 'y' }))).toBeNull();
    expect(decodeMemberBody(JSON.stringify({ v: 1, cardId: 'x' }))).toBeNull();
    expect(decodeMemberBody(JSON.stringify({ v: 1, cardId: '', name: 'y' }))).toBeNull();
    expect(decodeMemberBody(JSON.stringify({ v: 1, cardId: 'x', name: '   ' }))).toBeNull();
  });

  test('names are clamped so the body always fits the envelope', () => {
    const huge = '🔥'.repeat(200); // 4-byte codepoints, the worst case
    const body = encodeMemberBody({ cardId: ada.card, name: huge, podName: huge });
    // Measured with the substrate's OWN ruler — the one the compose and
    // accept gates use.
    expect(utf8ByteLength(body)).toBeLessThanOrEqual(POD_MEMBER_MAX_BYTES);
    const back = decodeMemberBody(body)!;
    expect([...back.name]).toHaveLength(MEMBER_NAME_MAX);
    // Clamping walks CODEPOINTS: an emoji is never cut in half.
    expect(back.name.startsWith('🔥')).toBe(true);
  });
});

// -------------------------------------------------------------- the reads

describe('resolving announcements', () => {
  test('newest per author wins; the superseded copy stays carried, not shown', () => {
    announceMembership(saveCrew(newCrew('Dawn patrol')), ada.card, 'Ada', NOW);
    const crew = listCrews()[0];
    // A rename is a NEW record — nothing is edited in place on this
    // substrate, and nothing can be retracted off other phones.
    announceMembership(crew, ada.card, 'Ada Dust', NOW + MEMBER_REFRESH_MIN + 1);
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])).toHaveLength(2);
    const members = announcedMembers(crew.code);
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('Ada Dust');
  });

  test('a body claiming someone ELSE\'s card id is dropped', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    // Composed by Bo (from_hash = hash32(bo.card)) but claiming Ada's id:
    // anyone can mint a record, but nobody gets to occupy another
    // member's roster slot or overwrite their name.
    composeRecord(
      POD_MEMBER_KIND,
      crew.code,
      bo.card,
      encodeMemberBody({ cardId: ada.card, name: 'Not Ada' }),
      '',
      null,
      NOW,
    );
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])).toHaveLength(1);
    expect(announcedMembers(crew.code)).toEqual([]);
  });

  test('announcedNames maps the hash a message carries', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, bo.card, bo.name, NOW);
    expect(announcedNames(crew.code).get(hash32(bo.card))).toBe(bo.name);
    expect(announcedNames(crew.code).get(hash32(cy.card))).toBeUndefined();
  });
});

// ------------------------------------------------------------- the roster

describe('the roster — announced ∪ picked', () => {
  test('an announced podmate with no card is a row, and it is not a fake card', () => {
    const crew = joinCrew(CODE);
    announceMembership(crew, bo.card, bo.name, NOW);
    const roster = podRoster(crew, [], ada.card);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      cardId: bo.card,
      name: bo.name,
      card: null,
      announcedMin: NOW,
    });
  });

  test('picked cards keep their rows and their order; me is never a row', () => {
    const crew = saveCrew(newCrew('Dawn patrol', [bo.card, cy.card]));
    announceMembership(crew, ada.card, ada.name, NOW); // my own announcement
    const cards = [cardOf(cy.card, 'Cy'), cardOf(bo.card, 'Bo')];
    const roster = podRoster(crew, cards, ada.card);
    expect(roster.map(m => m.cardId)).toEqual([bo.card, cy.card]);
    expect(roster.every(m => m.card !== null)).toBe(true);
  });

  test('one person, both sources, ONE row — and the card\'s spelling wins', () => {
    const crew = saveCrew(newCrew('Dawn patrol', [bo.card]));
    announceMembership(crew, bo.card, 'Bo Lantern', NOW);
    const roster = podRoster(crew, [cardOf(bo.card, 'Bo from the bus')], ada.card);
    expect(roster).toHaveLength(1);
    // One person under two names on one screen is worse than a slightly
    // stale one — and the rest of the app shows the card's spelling.
    expect(roster[0].name).toBe('Bo from the bus');
    expect(roster[0].announcedMin).toBe(NOW);
  });

  test('a picked id whose card was removed still has no row', () => {
    const crew = saveCrew(newCrew('Dawn patrol', [bo.card]));
    expect(podRoster(crew, [], ada.card)).toEqual([]);
  });
});

// ------------------------------------------------------------ the cadence

describe('announcing myself', () => {
  test('once — then nothing until something changes', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    expect(announceMembership(crew, ada.card, ada.name, NOW)).not.toBeNull();
    expect(announceMembership(crew, ada.card, ada.name, NOW + 5)).toBeNull();
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])).toHaveLength(1);
  });

  test('my rename re-announces immediately', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, 'Ada', NOW);
    expect(announceMembership(crew, ada.card, 'Ada Dust', NOW + 1)).not.toBeNull();
    expect(myAnnouncement(crew.code, ada.card)!.name).toBe('Ada Dust');
  });

  test('renaming the POD re-announces, because the pod name rides along', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, ada.name, NOW);
    const renamed = saveCrew({ ...crew, name: 'Sunrise crew' });
    expect(announceMembership(renamed, ada.card, ada.name, NOW + 1)).not.toBeNull();
    expect(myAnnouncement(renamed.code, ada.card)!.podName).toBe('Sunrise crew');
  });

  test('a refresh lands at half the TTL, so a live pod never loses its roster', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, ada.name, NOW);
    expect(
      announceMembership(crew, ada.card, ada.name, NOW + MEMBER_REFRESH_MIN - 1),
    ).toBeNull();
    expect(
      announceMembership(crew, ada.card, ada.name, NOW + MEMBER_REFRESH_MIN),
    ).not.toBeNull();
    // Refreshed at half life, expiring at full life: an announcement can
    // never expire out from under a pod whose phones are still running.
    expect(MEMBER_REFRESH_MIN * 2).toBe(POD_MEMBER_TTL_MIN);
  });

  test('a phone with no name on its card announces NOTHING', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    expect(announceMembership(crew, ada.card, '', NOW)).toBeNull();
    expect(announceMembership(crew, ada.card, '   ', NOW)).toBeNull();
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])).toEqual([]);
    // ...and the moment a name is saved, the very next reconcile speaks.
    reconcilePods(listCrews(), ada.card, 'Ada Dust', NOW + 1);
    expect(myAnnouncement(crew.code, ada.card)!.name).toBe('Ada Dust');
  });

  test('only a NAMER puts the pod name on the wire', () => {
    const mine = saveCrew(newCrew('Dawn patrol'));
    announceMembership(mine, ada.card, ada.name, NOW);
    expect(myAnnouncement(mine.code, ada.card)!.podName).toBe('Dawn patrol');
    // A joiner's pod wears a placeholder, so their announcement carries no
    // name — otherwise one typo would echo around a pod forever.
    const joined = joinCrew(CODE);
    announceMembership(joined, bo.card, bo.name, NOW);
    expect(myAnnouncement(joined.code, bo.card)!.podName).toBeUndefined();
    // And an ADOPTED name is still not mine to broadcast. Measured: the
    // first cut asked "is it a placeholder?" instead of "did I name it?",
    // and a joiner started re-announcing the name it had just adopted.
    const adopted = saveCrew({ ...joined, name: 'Dawn patrol', nameSource: 'mesh' });
    announceMembership(adopted, bo.card, bo.name, NOW + 1);
    expect(myAnnouncement(adopted.code, bo.card)!.podName).toBeUndefined();
  });

  test('reconcilePods walks EVERY pod on the phone', () => {
    saveCrew(newCrew('Dawn patrol'));
    joinCrew('1234');
    reconcilePods(listCrews(), ada.card, ada.name, NOW);
    for (const c of listCrews()) {
      expect(myAnnouncement(c.code, ada.card)).not.toBeNull();
    }
  });

  test('reconcilePods cannot spin, even against a store it can never read back', () => {
    saveCrew(newCrew('Dawn patrol'));
    const crews = listCrews();
    // A store that swallows writes is exactly the shape a UI effect meets
    // when the DB is swapped underneath it — without the guard this is an
    // announcement per render, forever.
    const blind = { execute: () => ({ rows: { _array: [] } }) };
    const real = mockConn;
    mockConn = blind;
    let composed = 0;
    blind.execute = (() => {
      composed += 1;
      return { rows: { _array: [] } };
    }) as any;
    for (let i = 0; i < 10; i++) {
      reconcilePods(crews, ada.card, ada.name, NOW);
    }
    mockConn = real;
    // One announcement's worth of statements, not ten.
    expect(composed).toBeLessThan(10);
  });
});

// ------------------------------------------------------------- the pod name

describe('the pod\'s name — it travels, and it never overwrites a choice', () => {
  test('a joiner adopts the namer\'s pod name, and stops showing the code', () => {
    // Ada names the pod and announces.
    const adaCrew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(adaCrew, ada.card, ada.name, NOW);
    const wire = on(A, () =>
      recordsOfKind(POD_MEMBER_KIND, [adaCrew.code]).map(toWire),
    );

    // Bo joins by code on the OTHER phone: no name, no roster, nothing.
    switchTo(B);
    const joined = joinCrew(adaCrew.code);
    expect(isPlaceholderPodName(joined)).toBe(true);
    expect(podDisplayName(joined)).toBe(`Pod ${adaCrew.code}`);
    expect(podLabel(joined)).toBe('this pod'); // never "Share with 4207"

    // Ada's announcement arrives over the radio.
    acceptIncoming(wire, [joined.code], NOW);
    reconcilePods(listCrews(), bo.card, bo.name, NOW);
    const named = listCrews()[0];
    expect(named.name).toBe('Dawn patrol');
    expect(podNameSource(named)).toBe('mesh');
    expect(podLabel(named)).toBe('Dawn patrol');
    // And Ada is a member row on Bo's phone without a single card swap.
    expect(podRoster(named, [], bo.card).map(m => m.name)).toEqual([ada.name]);
  });

  test('a name the user TYPED is never overwritten by the mesh', () => {
    const mine = joinCrew(CODE, 'Karl pod');
    expect(podNameSource(mine)).toBe('mine');
    composeRecord(
      POD_MEMBER_KIND,
      CODE,
      ada.card,
      encodeMemberBody({ cardId: ada.card, name: ada.name, podName: 'Dawn patrol' }),
      '',
      null,
      NOW,
    );
    expect(adoptPodName(mine, bo.card)).toBeNull();
    expect(listCrews()[0].name).toBe('Karl pod');
  });

  test('an ADOPTED name is still the mesh\'s to update — newest wins', () => {
    const joined = joinCrew(CODE);
    const announce = (who: string, podName: string, at: number) =>
      composeRecord(
        POD_MEMBER_KIND,
        CODE,
        who,
        encodeMemberBody({ cardId: who, name: who, podName }),
        '',
        null,
        at,
      );
    announce(ada.card, 'Dawn patrol', NOW);
    expect(adoptPodName(joined, cy.card)!.name).toBe('Dawn patrol');
    // Two members who each named the same code differently is a
    // disagreement no algorithm settles: the most recent human wins, the
    // way it does in every shared document.
    announce(bo.card, 'Sunrise crew', NOW + 10);
    expect(announcedPodName(CODE, cy.card)).toBe('Sunrise crew');
    expect(adoptPodName(listCrews()[0], cy.card)!.name).toBe('Sunrise crew');
    expect(podNameSource(listCrews()[0])).toBe('mesh');
  });

  test('joining is idempotent on the CODE — never a duplicate pod', () => {
    // Measured on two phones, Aug 24: typing your own pod's code minted a
    // second identical pod, and every message then had two places to live.
    const mine = saveCrew(newCrew('Dawn patrol'));
    expect(joinCrew(mine.code).id).toBe(mine.id);
    expect(joinCrew(`  ${mine.code.toUpperCase()} `).id).toBe(mine.id);
    expect(listCrews()).toHaveLength(1);
    // A name typed while re-joining fills a placeholder...
    const joined = joinCrew(CODE);
    expect(joinCrew(CODE, 'Karl pod').id).toBe(joined.id);
    expect(listCrews().find(c => c.id === joined.id)!.name).toBe('Karl pod');
    // ...and never overwrites one already chosen.
    joinCrew(CODE, 'Something else');
    expect(listCrews().find(c => c.id === joined.id)!.name).toBe('Karl pod');
    // The "two pods may share a NAME" invariant is untouched: the code is
    // the identity, the name is a label.
    saveCrew(newCrew('Karl pod'));
    expect(listCrews().filter(c => c.name === 'Karl pod')).toHaveLength(2);
  });

  test('my own announcement never names my pod for me', () => {
    const joined = joinCrew(CODE);
    announceMembership(joined, bo.card, bo.name, NOW);
    expect(announcedPodName(CODE, bo.card)).toBeNull();
    expect(adoptPodName(joined, bo.card)).toBeNull();
  });
});

// ------------------------------------------------------------ on the wire

const toWire = (m: any): WireRecord => ({
  id: m.id,
  crew_code: m.crew_code,
  from_hash: m.from_hash,
  to_hash: m.to_hash,
  kind: m.kind,
  body: m.body,
  mime: m.mime,
  created_min: m.created_min,
  expires_min: m.expires_min,
  hops: m.hops,
});

describe('an announcement is a record like any other', () => {
  test('it relays A -> B -> C: a stranger\'s phone carries the introduction', async () => {
    const C = makePhone();
    // A: Ada names the pod and announces.
    switchTo(A);
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, ada.name, NOW);
    // B and C are in the pod by code and have never met Ada.
    switchTo(B);
    joinCrew(crew.code);
    switchTo(C);
    joinCrew(crew.code);

    // B syncs from A, then C syncs from B — the second hop never touches A.
    switchTo(B);
    await syncWithPeer(linkTo(A, NOW), [crew.code], NOW);
    expect(announcedMembers(crew.code).map(m => m.name)).toEqual([ada.name]);

    switchTo(C);
    await syncWithPeer(linkTo(B, NOW), [crew.code], NOW);
    const heard = announcedMembers(crew.code);
    expect(heard.map(m => m.name)).toEqual([ada.name]);
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])[0].hops).toBe(2);
  });

  test('it is NOT mail: never in the inbox, never in the unread badge', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, ada.name, NOW);
    // Someone else's announcement, arriving off the radio.
    acceptIncoming(
      [
        {
          id: 'bo-1',
          crew_code: crew.code,
          from_hash: hash32(bo.card),
          to_hash: null,
          kind: POD_MEMBER_KIND,
          body: encodeMemberBody({ cardId: bo.card, name: bo.name }),
          mime: '',
          created_min: NOW,
          expires_min: NOW + POD_MEMBER_TTL_MIN,
          hops: 0,
        },
      ],
      [crew.code],
      NOW,
    );
    expect(announcedMembers(crew.code)).toHaveLength(2);
    expect(inbox([crew.code], ada.card)).toEqual([]);
    expect(unreadCount([crew.code], ada.card)).toBe(0);
  });

  test('the policy: a week of life, its own budget, and pod mail untouched', () => {
    expect(KIND_POLICY[POD_MEMBER_KIND].pod).toBe(false);
    expect(KIND_POLICY[POD_MEMBER_KIND].ttlMin).toBe(7 * 24 * 60);
    expect(KIND_POLICY[POD_MEMBER_KIND].maxBytes).toBe(512);
    // Its own cap group is the load-bearing part: sharing the pod group
    // would let a camp full of nameplates evict the answering machine's
    // mail, oldest-expiring first, every time the store filled.
    expect(KIND_POLICY[POD_MEMBER_KIND].capGroup).not.toBe(
      KIND_POLICY.text.capGroup,
    );
    expect(POD_MEMBER_HEARD_CAP).toBeLessThan(HEARD_CAP);

    const crew = saveCrew(newCrew('Dawn patrol'));
    composeText(crew.code, ada.card, 'meet at the trash fence at 3', null, NOW);
    announceMembership(crew, ada.card, ada.name, NOW);
    // A flood of heard announcements, well past their budget.
    for (let i = 0; i < POD_MEMBER_HEARD_CAP + 25; i++) {
      acceptIncoming(
        [
          {
            id: `ann-${i}`,
            crew_code: crew.code,
            from_hash: hash32(`card-${i}`),
            to_hash: null,
            kind: POD_MEMBER_KIND,
            body: encodeMemberBody({ cardId: `card-${i}`, name: `Member ${i}` }),
            mime: '',
            created_min: NOW,
            expires_min: NOW + POD_MEMBER_TTL_MIN,
            hops: 0,
          },
        ],
        [crew.code],
        NOW,
      );
    }
    const carried = recordsOfKind(POD_MEMBER_KIND, [crew.code]);
    // The cap counts HEARD rows: my own announcement is mine until it
    // expires, exactly like my own mail.
    expect(carried.filter(m => m.origin === 'heard').length).toBeLessThanOrEqual(
      POD_MEMBER_HEARD_CAP,
    );
    expect(carried.some(m => m.origin === 'mine')).toBe(true);
    // The pod's mail is still there.
    expect(myOutboxLike(crew, ada.card)).toBe(1);
  });

  test('an oversized body is refused at the gate, not stored', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    acceptIncoming(
      [
        {
          id: 'fat-1',
          crew_code: crew.code,
          from_hash: hash32(bo.card),
          to_hash: null,
          kind: POD_MEMBER_KIND,
          body: JSON.stringify({ v: 1, cardId: bo.card, name: 'x'.repeat(600) }),
          mime: '',
          created_min: NOW,
          expires_min: NOW + POD_MEMBER_TTL_MIN,
          hops: 0,
        },
      ],
      [crew.code],
      NOW,
    );
    expect(recordsOfKind(POD_MEMBER_KIND, [crew.code])).toEqual([]);
  });

  test('a nameplate fades a week after its author walks away', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, bo.card, bo.name, NOW);
    // There is no retraction on a store-and-forward mesh: leaving is a
    // record that simply stops being refreshed.
    expect(announcedMembers(crew.code)).toHaveLength(1);
    pruneExpired(NOW + POD_MEMBER_TTL_MIN - 1);
    expect(announcedMembers(crew.code)).toHaveLength(1);
    pruneExpired(NOW + POD_MEMBER_TTL_MIN);
    expect(announcedMembers(crew.code)).toEqual([]);
  });

  test('a disbanded pod\'s records stop moving the same minute', () => {
    const crew = saveCrew(newCrew('Dawn patrol'));
    announceMembership(crew, ada.card, ada.name, NOW);
    const digest = () => serveDigest(listCrews().map(c => c.code), NOW);
    expect(digest().length).toBeGreaterThan(4); // a framed, non-empty list
    mockSettings.set('crews', JSON.stringify([])); // disband
    // The code left listCrews, so nothing offers, accepts or reads those
    // rows again; pruneExpired takes them at their TTL.
    expect(digest().length).toBe(6); // frame + "[]"
  });
});

/** Rows I composed in this pod — the answering machine's tape, read
 * without importing the pod-only reader into every assertion. */
function myOutboxLike(crew: Crew, myCardId: string): number {
  return recordsOfKind('text', [crew.code]).filter(
    m => m.from_hash === hash32(myCardId),
  ).length;
}
