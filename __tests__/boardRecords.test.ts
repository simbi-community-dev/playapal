/**
 * The camp board on the gossip mesh (src/crews/boardRecords.ts +
 * campBoard.applyGossipedPosts) — the payoff lane of the typed-record
 * substrate: a board post now propagates phone to phone by itself instead
 * of waiting for someone to beam a file.
 *
 * What this file pins:
 *  - PUBLISH: one record per post, on the 'board-post' kind's OWN policy
 *    (72 h life, 16 KiB envelope, whole-pod address) and invisible to the
 *    answering machine;
 *  - IDENTITY RECONCILIATION: a post that arrives BOTH by gossip and by
 *    beam is ONE row on the board, in either order — the join is the board
 *    post's own id inside the body, not the gossip record's card-minted id;
 *  - REVISIONS: an edit is a NEW record (nothing is mutated in place), and
 *    campBoard's seq rule picks the winner over the gossip path exactly as
 *    it does over a beam — including a beamed snapshot making an older
 *    gossiped copy stale;
 *  - the REFUSALS, in the substrate's own words rather than in silence;
 *  - a v2 body from a future build degrading to a board row, never a crash;
 *  - the gates: another camp's post never lands, and a record claiming this
 *    phone's own writer id never reaches the rows this phone SEALS.
 *
 * Harness: gossipRecords.test.ts's — each "phone" is its own in-memory
 * database on the REAL shipped DDL, and the crew store rides that database's
 * settings table, so swapping the mocked getDb() swaps the whole phone.
 */

let mockConn: any;
const settingOf = (key: string) => {
  const res = mockConn.execute('SELECT value FROM settings WHERE key = ?', [key]);
  return res.rows && res.rows.length > 0 ? res.rows.item(0).value : null;
};
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  getSetting: (key: string) => settingOf(key),
  setSetting: (key: string, value: string) => {
    mockConn.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)],
    );
  },
}));

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import { hash32 } from '../src/crews/beacon';
import { joinCrew, listCrews } from '../src/crews/crew';
import {
  BOARD_POST_MAX_BYTES,
  BOARD_POST_TTL_MIN,
  KIND_POLICY,
  acceptIncoming,
  epochMinutes,
  inbox,
  unreadCount,
  utf8ByteLength,
} from '../src/crews/messages';
import {
  CAMP_OWN_SEQ_KEY,
  CAMP_WRITER_ID_KEY,
  GOSSIP_SEQ_LOOKAHEAD,
  boardPackId,
  exportCampBundle,
  getCampIdentity,
  installCampBundle,
  listCampBoard,
  ownBoardPackId,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../src/camp/campBoard';
import {
  BOARD_BODY_VERSION,
  decodeBoardBody,
  encodeBoardBody,
  importBoardPosts,
  publishBoardPosts,
  resetBoardMeshGuard,
  syncBoardOverMesh,
} from '../src/crews/boardRecords';

const { DatabaseSync } = require('node:sqlite');

const POD = '4242';
const PASS = 'purple pancake wagon';
const nowMin = epochMinutes(Date.now());

interface Phone {
  conn: any;
  writerId: string;
  cardId: string;
}

/** One simulated phone: an in-memory db on the app's own DDL. */
function makePhone(writerId: string, authorName: string, cardId: string): Phone {
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
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  const phone = { conn, writerId, cardId };
  onPhone(phone);
  saveCampProfile(conn, { authorName, passphrase: PASS });
  joinCrew(POD);
  return phone;
}

/** Whose turn it is: every module that reaches for getDb()/getSetting()
 * now talks to THIS phone. */
function onPhone(phone: Phone): Phone {
  mockConn = phone.conn;
  return phone;
}

/** The radio as a function call: every board-post record this phone carries,
 * offered to another phone's accept gate. */
function gossip(from: Phone, to: Phone): number {
  onPhone(from);
  const wire = (
    from.conn.execute("SELECT * FROM crew_messages WHERE kind = 'board-post'").rows
      ._array as any[]
  ).map(r => ({
    id: r.id,
    crew_code: r.crew_code,
    from_hash: Number(r.from_hash),
    to_hash: r.to_hash === null ? null : Number(r.to_hash),
    kind: r.kind,
    body: r.body,
    mime: r.mime,
    created_min: Number(r.created_min),
    expires_min: Number(r.expires_min),
    hops: Number(r.hops),
  }));
  onPhone(to);
  return acceptIncoming(wire, [POD], nowMin);
}

const rowsFor = (phone: Phone, postId: string) =>
  listCampBoard(phone.conn).filter(p => p.id === postId);

/** Mint a raw board-post record on a phone, bypassing the codec — how a
 * peer running a build we have never seen reaches this one. */
function plant(phone: Phone, body: unknown, fromCardId: string, id: string): void {
  phone.conn.execute(
    `INSERT INTO crew_messages
       (id, crew_code, from_hash, to_hash, kind, body, mime, created_min, expires_min, hops, origin)
     VALUES (?, ?, ?, NULL, 'board-post', ?, '', ?, ?, 1, 'heard')`,
    [
      id,
      POD,
      hash32(fromCardId),
      JSON.stringify(body),
      nowMin,
      nowMin + BOARD_POST_TTL_MIN,
    ],
  );
}

beforeEach(() => {
  resetBoardMeshGuard();
});

describe('the body codec', () => {
  it('round-trips a post and stamps the version INSIDE the body', () => {
    const body = {
      campId: 'abcd1234',
      writerId: 'aaaa1111',
      authorName: 'Dusty Otter',
      seq: 7,
      postId: 'p-1',
      type: 'offer' as const,
      text: '3 spare bike tubes at the shade dome',
      refId: '',
      createdAt: '2026-08-24T18:00:00.000Z',
      done: false,
    };
    const wire = encodeBoardBody(body);
    expect(JSON.parse(wire).v).toBe(BOARD_BODY_VERSION);
    expect(decodeBoardBody(wire)).toEqual(body);
  });

  it('reads a v2 body from the future and ignores what it cannot name', () => {
    const decoded = decodeBoardBody(
      JSON.stringify({
        v: 2,
        campId: 'abcd1234',
        writerId: 'bbbb2222',
        authorName: 'Cinder Fox',
        seq: 2,
        postId: 'p-2',
        type: 'need',
        text: 'a ride to the trash fence at 3',
        refId: '',
        createdAt: '2026-08-24T18:00:00.000Z',
        done: false,
        photo: 'AAAA',
        reactions: [{ who: 'someone', what: 'dust' }],
      }),
    );
    expect(decoded?.text).toBe('a ride to the trash fence at 3');
    expect(decoded?.type).toBe('need');
  });

  it('drops junk instead of crashing', () => {
    expect(decodeBoardBody('not json at all')).toBeNull();
    expect(decodeBoardBody(JSON.stringify({ v: 0, postId: 'p' }))).toBeNull();
    expect(
      decodeBoardBody(JSON.stringify({ v: 1, campId: 'a', writerId: 'b' })),
    ).toBeNull();
    expect(
      decodeBoardBody(
        JSON.stringify({
          v: 1,
          campId: 'abcd1234',
          writerId: 'bbbb2222',
          seq: 1,
          postId: 'p-3',
          text: 'x'.repeat(5000), // over the authoring cap: refused, not cut
          createdAt: '2026-08-24T18:00:00.000Z',
        }),
      ),
    ).toBeNull();
  });
});

describe('publishing', () => {
  it('mints one record on the board kind’s own policy, unseen by the inbox', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    upsertCampPost(a.conn, {
      type: 'offer',
      text: '3 spare bike tubes at the shade dome',
    });
    const pub = publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    expect(pub).toEqual({ published: 1, refusals: [] });

    const rec = a.conn.execute('SELECT * FROM crew_messages').rows._array[0];
    expect(rec.kind).toBe('board-post');
    expect(Number(rec.expires_min) - Number(rec.created_min)).toBe(
      BOARD_POST_TTL_MIN,
    );
    expect(utf8ByteLength(rec.body)).toBeLessThanOrEqual(BOARD_POST_MAX_BYTES);
    expect(rec.to_hash).toBeNull();
    expect(Number(rec.hops)).toBe(0);
    expect(rec.origin).toBe('mine');
    // Carried and relayed, never mail: the answering machine stays pod-only.
    expect(inbox([POD], a.cardId)).toEqual([]);
    expect(unreadCount([POD], a.cardId)).toBe(0);
  });

  it('says nothing twice — including from a phone with no saved card', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    upsertCampPost(a.conn, { type: 'need', text: 'a working bike pump' });
    expect(publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin).published).toBe(1);
    expect(publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin).published).toBe(0);
    // getMyCard() hands back a FRESH random id until a card is saved, and a
    // relaunch forgets the spin guard: only the WRITER id can recognise this
    // phone's own records, or every launch re-mints the whole board.
    resetBoardMeshGuard();
    expect(
      publishBoardPosts(a.conn, listCrews(), 'card-random-this-time', nowMin)
        .published,
    ).toBe(0);
  });

  it('publishes nothing before a camp passphrase exists', () => {
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
    for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
      conn.execute(sql);
    }
    const phone = { conn, writerId: '', cardId: 'card-nobody' };
    onPhone(phone);
    joinCrew(POD);
    upsertCampPost(conn, { type: 'offer', text: 'a pre-camp draft' });
    expect(publishBoardPosts(conn, listCrews(), phone.cardId, nowMin)).toEqual({
      published: 0,
      refusals: [],
    });
  });

  it('surfaces an over-cap refusal in the KIND’s own words', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    const identity = getCampIdentity(a.conn);
    // Authoring refuses this first (POST_TEXT_MAX); planted directly so the
    // envelope gate itself is what speaks.
    a.conn.execute(
      `INSERT INTO camp_posts (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, created_at, done)
       VALUES (?, ?, ?, ?, ?, 'offer', ?, NULL, ?, 0)`,
      [
        'p-oversize',
        boardPackId(identity.campId, identity.writerId),
        identity.campId,
        identity.writerId,
        identity.authorName,
        'x'.repeat(20000),
        new Date().toISOString(),
      ],
    );
    const pub = publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    expect(pub.published).toBe(0);
    expect(pub.refusals).toEqual([KIND_POLICY['board-post'].overCapMessage]);
    expect(
      Number(
        a.conn.execute('SELECT COUNT(*) AS n FROM crew_messages').rows.item(0).n,
      ),
    ).toBe(0);
  });
});

describe('a post that arrives twice renders once', () => {
  it('gossip first, then the beam of the same post', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    const post = upsertCampPost(a.conn, {
      type: 'offer',
      text: '3 spare bike tubes at the shade dome',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);

    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    expect(gossip(a, b)).toBe(1);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(rowsFor(b, post.id)[0].text).toBe(post.text);
    expect(rowsFor(b, post.id)[0].author_name).toBe('Dusty Otter');
    // Re-importing the same records is a no-op, not a rewrite.
    expect(importBoardPosts(b.conn, [POD])).toMatchObject({
      applied: 0,
      unchanged: 1,
    });

    onPhone(a);
    const beam = exportCampBundle(a.conn);
    const installed = installCampBundle(b.conn, beam);
    expect(installed.forks).toEqual([]);
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(listCampBoard(b.conn)).toHaveLength(1);
    // And the gossiped copy is now behind the beamed high-water: stale.
    expect(importBoardPosts(b.conn, [POD])).toMatchObject({
      applied: 0,
      stale: 1,
    });
    expect(rowsFor(b, post.id)).toHaveLength(1);
  });

  it('beam first, then the gossiped copy', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    const post = upsertCampPost(a.conn, { type: 'need', text: 'a spare headlamp' });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const beam = exportCampBundle(a.conn);

    const c = makePhone('cccc3333', 'Sage Wren', 'card-sage-wren');
    installCampBundle(c.conn, beam);
    expect(rowsFor(c, post.id)).toHaveLength(1);
    gossip(a, c);
    expect(importBoardPosts(c.conn, [POD]).applied).toBe(0);
    expect(rowsFor(c, post.id)).toHaveLength(1);
    expect(listCampBoard(c.conn)).toHaveLength(1);
  });
});

describe('revisions travel the mesh', () => {
  it('an edit is a new record, and the newer revision wins', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    const post = upsertCampPost(a.conn, {
      type: 'offer',
      text: '3 spare bike tubes at the shade dome',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    gossip(a, b);
    importBoardPosts(b.conn, [POD]);

    onPhone(a);
    const edited = upsertCampPost(a.conn, {
      id: post.id,
      type: 'offer',
      text: '1 spare bike tube left at the shade dome',
    });
    resetBoardMeshGuard();
    expect(publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin).published).toBe(1);
    const carried = a.conn.execute(
      "SELECT body FROM crew_messages WHERE kind = 'board-post'",
    ).rows._array as { body: string }[];
    expect(carried).toHaveLength(2); // nothing is edited in place, ever
    const seqs = carried.map(r => JSON.parse(r.body).seq).sort((x, y) => x - y);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);

    gossip(a, b);
    const merged = importBoardPosts(b.conn, [POD]);
    expect(merged.applied).toBe(1);
    expect(merged.superseded).toBe(1);
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(rowsFor(b, post.id)[0].text).toBe(edited.text);
  });

  it('a done flip supersedes the same way', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    const post = upsertCampPost(a.conn, { type: 'offer', text: 'iced coffee at 2pm' });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    gossip(a, b);
    importBoardPosts(b.conn, [POD]);
    expect(rowsFor(b, post.id)[0].done).toBe(false);

    onPhone(a);
    setPostDone(a.conn, post.id, true);
    resetBoardMeshGuard();
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    importBoardPosts(b.conn, [POD]);
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(rowsFor(b, post.id)[0].done).toBe(true);
  });
});

describe('the gates', () => {
  it('another camp’s post never reaches this board', () => {
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    onPhone(b);
    plant(
      b,
      {
        v: 1,
        campId: 'deadbeef',
        writerId: 'dddd4444',
        authorName: 'Marlow Pike',
        seq: 4,
        postId: 'p-othercamp',
        type: 'offer',
        text: 'chai at the other camp',
        refId: '',
        createdAt: new Date().toISOString(),
        done: false,
      },
      'card-marlow-pike',
      'ffff-1-aaaa',
    );
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(0);
    expect(rowsFor(b, 'p-othercamp')).toHaveLength(0);
  });

  it('a record claiming MY writer id never touches the rows I seal', () => {
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    onPhone(b);
    const identity = getCampIdentity(b.conn);
    plant(
      b,
      {
        v: 1,
        campId: identity.campId,
        writerId: identity.writerId,
        authorName: 'Cinder Fox',
        seq: 99,
        postId: 'p-impersonation',
        type: 'offer',
        text: 'free everything, take it all',
        refId: '',
        createdAt: new Date().toISOString(),
        done: false,
      },
      'card-impostor',
      'ffff-2-bbbb',
    );
    expect(importBoardPosts(b.conn, [POD]).refused).toBeGreaterThan(0);
    expect(rowsFor(b, 'p-impersonation')).toHaveLength(0);
    expect(
      Number(
        b.conn
          .execute('SELECT COUNT(*) AS n FROM camp_posts WHERE pack_id = ?', [
            ownBoardPackId(b.conn),
          ])
          .rows.item(0).n,
      ),
    ).toBe(0);
  });

  it('a gossiped row never advances a high-water or rides out under my seal', () => {
    const a = makePhone('aaaa1111', 'Dusty Otter', 'card-dusty-otter');
    onPhone(a);
    upsertCampPost(a.conn, { type: 'offer', text: 'shade for four at midday' });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);

    // The beam's high-water is the beam's word alone: one post is not a
    // snapshot, and claiming the seq would make A's real beam read as a fork.
    expect(
      Number(
        b.conn
          .execute('SELECT COUNT(*) AS n FROM camp_writers WHERE writer_id = ?', [
            'aaaa1111',
          ])
          .rows.item(0).n,
      ),
    ).toBe(0);
    onPhone(b);
    const bundle = JSON.parse(exportCampBundle(b.conn));
    const mine = bundle.envelopes.find((e: any) => e.writer_id === 'bbbb2222');
    expect(mine.posts).toEqual([]);
    expect(bundle.envelopes.some((e: any) => e.writer_id === 'aaaa1111')).toBe(false);
  });

  it('a v2 post from the future lands as a board row; a broken one does not', () => {
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    onPhone(b);
    const campId = getCampIdentity(b.conn).campId;
    plant(
      b,
      {
        v: 2,
        campId,
        writerId: 'dddd4444',
        authorName: 'Marlow Pike',
        seq: 3,
        postId: 'p-fromfuture',
        type: 'need',
        text: 'a ride to the trash fence at 3',
        refId: '',
        createdAt: new Date().toISOString(),
        done: false,
        photo: 'AAAA',
        mood: 'giddy',
      },
      'card-marlow-pike',
      'ffff-3-cccc',
    );
    plant(
      b,
      { v: 2, campId, writerId: 'eeee5555', seq: 1, postId: 'p-broken' },
      'card-broken',
      'ffff-4-dddd',
    );
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    expect(rowsFor(b, 'p-fromfuture')).toHaveLength(1);
    expect(rowsFor(b, 'p-fromfuture')[0].text).toBe('a ride to the trash fence at 3');
    expect(rowsFor(b, 'p-fromfuture')[0].type).toBe('need');
    expect(rowsFor(b, 'p-broken')).toHaveLength(0);
  });
});

/**
 * THE REVISION FIGHT (pre-train review, Aug 24). The winner of a revision
 * fight is the highest writer seq, and a griefer inside the pod can relay a
 * post under a campmate's writer id at any seq they like. Unbounded, that
 * owned the post forever — including across a beam re-sync, because the
 * reinstalled snapshot never reached 2^30 and the self-heal re-applied the
 * forgery on the next pass. campBoard bounds it: at most
 * GOSSIP_SEQ_LOOKAHEAD above the writer's last SEALED seq.
 *
 * The four "still works" cases below are the counterweight — they fail if the
 * cap is drawn bluntly (an absolute ceiling, a cap on the beam path, a cap
 * that needs an anchor before first contact, or a window too tight for a
 * phone that has been off the mesh for days).
 */
describe('how far ahead a gossiped revision may claim to be', () => {
  /** What the griefer relays: a campmate's writer id, a real post's id, a
   * number no author will ever count to. */
  const forgery = (
    campId: string,
    writerId: string,
    postId: string,
    seq: number,
    text: string,
  ) => ({
    v: 1,
    campId,
    writerId,
    authorName: 'Marlow Pike',
    seq,
    postId,
    type: 'offer',
    text,
    refId: '',
    createdAt: new Date().toISOString(),
    done: false,
  });

  /** N legitimate own-payload revisions, fast-forwarded: the counter is the
   * only part of them this gate reads. */
  const fastForward = (phone: Phone, seq: number) =>
    phone.conn.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [CAMP_OWN_SEQ_KEY, String(seq)],
    );

  const REAL = 'shade and cold water at 7:15 & Dandelion, knock any time';
  const FORGED = 'moved — find us at 2:00 & Awe instead';
  const MINTED = 2 ** 30;

  it('refuses a minted far-future seq, without losing the post it fought', () => {
    const a = makePhone('aaaa1111', 'Marlow Pike', 'card-marlow-pike');
    onPhone(a);
    const post = upsertCampPost(a.conn, { type: 'offer', text: REAL });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);

    const campId = getCampIdentity(b.conn).campId;
    plant(
      b,
      forgery(campId, a.writerId, post.id, MINTED, FORGED),
      'card-griefer',
      'ffff-9-aaaa',
    );
    const held = importBoardPosts(b.conn, [POD]);
    expect(held.refusedFuture).toBe(1);
    expect(held.refused).toBeGreaterThanOrEqual(1);
    // The gate runs BEFORE the in-batch election, or the forgery would win
    // the fight and then be dropped — and the reader would keep neither copy.
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(rowsFor(b, post.id)[0].text).toBe(REAL);

    // The author edits, with the forgery still circulating in the pod.
    onPhone(a);
    const edited = upsertCampPost(a.conn, {
      id: post.id,
      type: 'offer',
      text: 'shade and cold water at 7:15 & Dandelion — out of ice until dark',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    importBoardPosts(b.conn, [POD]);
    expect(rowsFor(b, post.id)[0].text).toBe(edited.text);

    // ...and a full beam re-sync does not bring the minted copy back.
    onPhone(a);
    installCampBundle(b.conn, exportCampBundle(a.conn));
    onPhone(b);
    expect(importBoardPosts(b.conn, [POD]).refusedFuture).toBe(1);
    expect(rowsFor(b, post.id)).toHaveLength(1);
    expect(rowsFor(b, post.id)[0].text).toBe(edited.text);
  });

  it('shows the held-back post as held back, never as never-sent', () => {
    const a = makePhone('aaaa1111', 'Marlow Pike', 'card-marlow-pike');
    onPhone(a);
    const post = upsertCampPost(a.conn, { type: 'offer', text: REAL });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    gossip(a, b);
    importBoardPosts(b.conn, [POD]);
    plant(
      b,
      forgery(getCampIdentity(b.conn).campId, a.writerId, post.id, MINTED, FORGED),
      'card-griefer',
      'ffff-9-bbbb',
    );
    onPhone(b);
    const pass = syncBoardOverMesh(b.conn, listCrews(), b.cardId, nowMin);
    // The same line under the board the publish refusals use.
    expect(pass.refusals).toHaveLength(1);
    expect(pass.refusals[0]).toMatch(/revision/i);
  });

  it('still installs a beamed snapshot 600 revisions ahead — and what follows it', () => {
    // The beam is the case most likely to look like an attack: a sealed
    // snapshot carries a whole revision history in one jump. It is sealed
    // with the camp passphrase, so it is the thing that SETS the anchor.
    const a = makePhone('cccc3333', 'Sage Wren', 'card-sage-wren');
    onPhone(a);
    const post = upsertCampPost(a.conn, {
      type: 'need',
      text: 'a bike pump with a presta head, any time before Thursday',
    });
    fastForward(a, 600);
    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    onPhone(a);
    const installed = installCampBundle(b.conn, exportCampBundle(a.conn));
    expect(installed.installed).toHaveLength(1);
    expect(rowsFor(b, post.id)).toHaveLength(1);

    onPhone(a);
    const next = upsertCampPost(a.conn, {
      type: 'offer',
      text: 'coffee at sunrise, corner of 6:00 & Bellwether',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    expect(rowsFor(b, next.id)[0].text).toBe(next.text);
  });

  it('lands the first post of a writer this phone has never seen', () => {
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    onPhone(b);
    plant(
      b,
      {
        v: 1,
        campId: getCampIdentity(b.conn).campId,
        writerId: 'eeee5555',
        authorName: 'Dusty Otter',
        seq: 12,
        postId: 'p-firstcontact',
        type: 'need',
        text: 'lost a green water bottle near the temple, no rush',
        refId: '',
        createdAt: new Date().toISOString(),
        done: false,
      },
      'card-dusty-otter',
      'ffff-9-cccc',
    );
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    expect(rowsFor(b, 'p-firstcontact')[0].text).toBe(
      'lost a green water bottle near the temple, no rush',
    );
  });

  it('catches up after days offline against a chatty writer', () => {
    const a = makePhone('cccc3333', 'Sage Wren', 'card-sage-wren');
    onPhone(a);
    upsertCampPost(a.conn, { type: 'offer', text: 'tea, all afternoon' });
    fastForward(a, 40);
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    onPhone(a);
    installCampBundle(b.conn, exportCampBundle(a.conn));
    // ...b is off the mesh for days while Sage keeps working.
    fastForward(a, 300);
    onPhone(a);
    const later = upsertCampPost(a.conn, {
      type: 'need',
      text: 'someone to watch the tea urn from 4 to 6',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    expect(rowsFor(b, later.id)[0].text).toBe(later.text);
  });

  it('holds back an install far past its own seal — and one beam repairs it', () => {
    // The cost of anchoring at 0 for a stranger, stated as a test rather than
    // discovered in the dust: a phone whose counter has run far past its last
    // sealed snapshot cannot introduce itself over the mesh alone.
    const a = makePhone('cccc3333', 'Sage Wren', 'card-sage-wren');
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    onPhone(a);
    fastForward(a, 900);
    const post = upsertCampPost(a.conn, {
      type: 'offer',
      text: 'spare goggles, two pairs, at the kitchen tent',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD])).toMatchObject({
      applied: 0,
      refusedFuture: 1,
    });
    expect(rowsFor(b, post.id)).toHaveLength(0);

    onPhone(a);
    installCampBundle(b.conn, exportCampBundle(a.conn));
    const after = upsertCampPost(a.conn, {
      type: 'need',
      text: 'a shade tarp, 10x10 or bigger, for the kitchen tent',
    });
    publishBoardPosts(a.conn, listCrews(), a.cardId, nowMin);
    gossip(a, b);
    expect(importBoardPosts(b.conn, [POD]).refusedFuture).toBe(0);
    expect(rowsFor(b, post.id)[0].text).toBe(post.text);
    expect(rowsFor(b, after.id)[0].text).toBe(after.text);
  });

  it('never lets the mesh raise its own ceiling', () => {
    // If an accepted gossiped copy became the anchor, a griefer would climb
    // their own ladder a window at a time and be back at 2^30 in a few passes.
    const a = makePhone('aaaa1111', 'Marlow Pike', 'card-marlow-pike');
    onPhone(a);
    upsertCampPost(a.conn, { type: 'offer', text: REAL });
    const b = makePhone('bbbb2222', 'Juno Bramble', 'card-juno-bramble');
    onPhone(a);
    installCampBundle(b.conn, exportCampBundle(a.conn));
    const hw = Number(
      b.conn
        .execute('SELECT seq FROM camp_writers WHERE writer_id = ?', [a.writerId])
        .rows.item(0).seq,
    );
    const campId = getCampIdentity(b.conn).campId;
    plant(
      b,
      forgery(campId, a.writerId, 'p-ceiling', hw + GOSSIP_SEQ_LOOKAHEAD, 'at the ceiling'),
      'card-griefer',
      'ffff-9-dddd',
    );
    onPhone(b);
    expect(importBoardPosts(b.conn, [POD]).applied).toBe(1);
    plant(
      b,
      forgery(campId, a.writerId, 'p-rung', hw + GOSSIP_SEQ_LOOKAHEAD + 1, 'one rung up'),
      'card-griefer',
      'ffff-9-eeee',
    );
    expect(importBoardPosts(b.conn, [POD]).refusedFuture).toBe(1);
    expect(rowsFor(b, 'p-rung')).toHaveLength(0);
  });
});

describe('the pass the screen runs', () => {
  it('publishes, imports, and then settles', () => {
    const d = makePhone('ffff6666', 'Juno Bramble', 'card-juno-bramble');
    onPhone(d);
    upsertCampPost(d.conn, { type: 'need', text: 'a working bike pump, any size' });
    const first = syncBoardOverMesh(d.conn, listCrews(), d.cardId, nowMin);
    expect(first.published).toBe(1);
    expect(first.refusals).toEqual([]);

    const b = makePhone('bbbb2222', 'Cinder Fox', 'card-cinder-fox');
    gossip(d, b);
    onPhone(b);
    const landed = syncBoardOverMesh(b.conn, listCrews(), b.cardId, nowMin);
    expect(landed.imported).toBe(1);
    expect(landed.writers).toEqual(['Juno Bramble']);
    expect(
      listCampBoard(b.conn).some(p => p.text === 'a working bike pump, any size'),
    ).toBe(true);
    // Idempotent: the effect that calls this re-fires on the store change it
    // causes, so a second pass must write nothing at all.
    expect(syncBoardOverMesh(b.conn, listCrews(), b.cardId, nowMin)).toMatchObject({
      published: 0,
      imported: 0,
    });
  });
});
