/**
 * Camp board v0 core semantics against the REAL DDL (node:sqlite), including
 * the refutation's permutation acceptance set (the tests required before
 * anything may say "sync"):
 *   duplicate import → no-op; old-after-new → rejected (no rollback);
 *   new-after-old → installs; interrupted install → prior state intact
 *   (transaction); multi-hop re-export (A→B→C without A meeting C);
 *   equal-seq/different-hash → fork surfaced, never overwritten.
 * Plus the lifecycle addendum: done-before-open ordering, reply threading
 * across a beam round-trip, fresh-filter boundary, and the 30-day local
 * prune (own-prune bumps seq so the next beam supersedes, not forks).
 */

import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import {
  CAMP_BUNDLE_FORMAT,
  CAMP_FRESH_HOURS,
  CAMP_PACK_PREFIX,
  boardPackId,
  CAMP_POST_MAX_AGE_DAYS,
  CAMP_WRITER_ID_KEY,
  CAMP_OWN_SEQ_KEY,
  CampBeamError,
  type CampPost,
  ageLabel,
  campIdFor,
  deriveBoard,
  exportCampBundle,
  getCampIdentity,
  hydrateStoredCampNotes,
  installCampBundle,
  isFresh,
  listCampBoard,
  migrateCampBundleFormat,
  normalizePassphrase,
  parseCampBundle,
  pruneCampPosts,
  rematerializeAllBoards,
  saveCampProfile,
  setPostDone,
  upsertCampNote,
  upsertCampPost,
} from '../src/camp/campBoard';
import { hmacSha256Hex, sha256Hex } from '../src/camp/hmac';

const { DatabaseSync } = require('node:sqlite');

/** One simulated phone: an in-memory db running the app's own DDL. */
function makePhone(writerId?: string) {
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
  if (writerId) {
    conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
      CAMP_WRITER_ID_KEY,
      writerId,
    ]);
  }
  const rebuild = () => {
    for (const sql of REBUILD_FTS_SQL) {
      conn.execute(sql);
    }
  };
  const postRows = (): any[] =>
    conn.execute('SELECT * FROM camp_posts ORDER BY pack_id, id').rows!._array;
  const packRows = (): any[] =>
    conn.execute(
      `SELECT * FROM packs WHERE id LIKE '${CAMP_PACK_PREFIX}%' ORDER BY id`,
    ).rows!._array;
  const openBoard = (): string[] =>
    listCampBoard(conn)
      .filter((p: any) => !p.ref_id && !p.done)
      .map((p: any) => p.text)
      .sort();
  return { conn, rebuild, postRows, packRows, openBoard };
}

type Phone = ReturnType<typeof makePhone>;

const join = (phone: Phone, name: string, passphrase = 'dusty mary') =>
  saveCampProfile(phone.conn, { authorName: name, passphrase });

/** Fixed format-2 posts+notes beam, sealed outside the implementation under test. */
const FIXED_V2_BEAM = '{"kind":"playapal-camp-board","format":2,"camp_id":"0b7868f0","envelopes":[{"format":2,"camp_id":"0b7868f0","writer_id":"aaaa1111","author_name":"Maria","key_id":"85a39429","seq":7,"payload_hash":"8e8e2128bac3199b631f4e22cc4a149b02c5fa9096a4eb63621cee5d2c3c9ebb","posts":[{"id":"p-fixed-v2","writer_id":"aaaa1111","author_name":"Maria","type":"offer","text":"fixed v2 tubes","ref_id":null,"created_at":"2026-08-20T12:00:00.000Z","done":false}],"notes":[{"id":"aaaa1111:n-fixed","writer_id":"aaaa1111","author_name":"Maria","kind":"resource","title":"Shade map","when_date":"","time_start":"","time_end":"","where_addr":"5:30 & E","text":"Pinned v2 note","subject_type":"","subject_key":"","year":"","supersedes":"","created_at":"2026-08-20T12:01:00.000Z","revised_at":"2026-08-20T12:01:00.000Z","photo":""}],"tag":"cf407068577acd9e2630e0d2024903e2a367edc3350255d4f496b74a5a498d4d"}]}';

describe('identity + value at N=1', () => {
  it('generates and persists an 8-hex writer id; no passphrase needed to post', () => {
    const phone = makePhone();
    const first = getCampIdentity(phone.conn);
    expect(first.writerId).toMatch(/^[0-9a-f]{8}$/);
    expect(getCampIdentity(phone.conn).writerId).toBe(first.writerId);
    upsertCampPost(phone.conn, { type: 'offer', text: '3 spare bike tubes' });
    expect(phone.openBoard()).toEqual(['3 spare bike tubes']);
  });

  it('advances own sequence once when the sealed payload format changes', () => {
    const phone = makePhone('aaaa1111');
    phone.conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
      CAMP_OWN_SEQ_KEY,
      '7',
    ]);
    migrateCampBundleFormat(phone.conn);
    expect(
      phone.conn.execute('SELECT value FROM settings WHERE key = ?', [
        CAMP_OWN_SEQ_KEY,
      ]).rows!.item(0).value,
    ).toBe('8');
    migrateCampBundleFormat(phone.conn);
    expect(
      phone.conn.execute('SELECT value FROM settings WHERE key = ?', [
        CAMP_OWN_SEQ_KEY,
      ]).rows!.item(0).value,
    ).toBe('8');
  });

  it('qualifies legacy own replies before sealing format 3', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const root = upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    const reply = upsertCampPost(phone.conn, {
      type: 'offer',
      text: 'thanks',
      ref_id: root.id,
      ref_writer_id: root.writer_id,
    });
    phone.conn.execute(
      'UPDATE camp_posts SET ref_writer_id = NULL WHERE id = ?',
      [reply.id],
    );
    migrateCampBundleFormat(phone.conn);
    const wireReply = JSON.parse(exportCampBundle(phone.conn)).envelopes[0].posts.find(
      (post: { id: string }) => post.id === reply.id,
    );
    expect(wireReply.ref_writer_id).toBe('aaaa1111');
  });

  it('bounds local posts before they can make the next beam inadmissible', () => {
    const phone = makePhone('aaaa1111');
    expect(() =>
      upsertCampPost(phone.conn, { type: 'offer', text: 'x'.repeat(2001) }),
    ).toThrow(/2000 characters/i);
  });

  it('carries locally authored notes when rebased onto the notes schema', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    phone.conn.execute(
      `INSERT INTO camp_notes
         (id, camp_id, writer_id, author_name, kind, title, when_date,
          time_start, time_end, where_addr, text, subject_type, subject_key,
          year, supersedes, created_at, revised_at, photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'aaaa1111:n-own', campIdFor('dusty mary'), 'aaaa1111', 'Maria',
        'resource', 'Shade', '', '', '', '5:30 & E', 'Own note', '', '', '', '',
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', '',
      ],
    );
    expect(JSON.parse(exportCampBundle(phone.conn)).envelopes[0].notes).toEqual([
      expect.objectContaining({ id: 'aaaa1111:n-own', text: 'Own note' }),
    ]);
  });

  it('names the own pack without doubling the unnamed fallback ("this phone" once, suffix only behind a real name)', () => {
    const phone = makePhone('aaaa1111');
    upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    expect(phone.packRows()[0].name).toBe('Camp board — this phone');
    join(phone, 'Maria');
    expect(phone.packRows()[0].name).toBe('Camp board — Maria (this phone)');
  });

  it('normalizes passphrases; camp id derives from the normalized phrase', () => {
    expect(normalizePassphrase('  Dusty   Mary ')).toBe('dusty mary');
    expect(campIdFor(' DUSTY  mary')).toBe(campIdFor('dusty mary'));
    expect(campIdFor('dusty mary')).not.toBe(campIdFor('other camp'));
  });

  it('rejects an edit whose target disappeared instead of recreating it', () => {
    const phone = makePhone('aaaa1111');
    const post = upsertCampPost(phone.conn, { type: 'offer', text: 'gone soon' });
    phone.conn.execute('DELETE FROM camp_posts WHERE id = ?', [post.id]);
    expect(() =>
      upsertCampPost(phone.conn, { id: post.id, type: 'offer', text: 'resurrected' }),
    ).toThrow(/no longer/);
    expect(phone.postRows()).toEqual([]);
  });

  it('rejects an empty post and strips control characters from typed text', () => {
    const phone = makePhone('aaaa1111');
    expect(() => upsertCampPost(phone.conn, { type: 'offer', text: '  ' })).toThrow(
      CampBeamError,
    );
    const p = upsertCampPost(phone.conn, { type: 'need', text: 'zip\nties\u001fnow' });
    expect(p.text).toBe('zip ties now');
  });

  it('editing your own post keeps its id and created_at (age not resettable)', () => {
    const phone = makePhone('aaaa1111');
    const p = upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    const edited = upsertCampPost(phone.conn, {
      id: p.id,
      type: 'offer',
      text: 'bike tubes — 2 left',
    });
    expect(edited.id).toBe(p.id);
    expect(edited.created_at).toBe(p.created_at);
    expect(phone.postRows()).toHaveLength(1);
  });
});

describe('lifecycle: done, replies, freshness, prune', () => {
  it('done is an author-only superseding flag: still stored, still beamed, out of the open board', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const p = upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    setPostDone(phone.conn, p.id, true);
    expect(phone.openBoard()).toEqual([]);
    expect(phone.postRows()[0].done).toBe(1);
    const bundle = JSON.parse(exportCampBundle(phone.conn));
    expect(bundle.envelopes[0].posts[0].done).toBe(true);
  });

  it('replies thread under items and derive "likely resolved" without writing to the original', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const offer = upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    const reply = upsertCampPost(phone.conn, {
      type: 'offer',
      text: 'took 2, thanks!',
      ref_id: offer.id,
      ref_writer_id: offer.writer_id,
    });
    const sections = deriveBoard(listCampBoard(phone.conn), { freshOnly: false });
    expect(sections).toHaveLength(1);
    const thread = sections[0].threads[0];
    expect(thread.post.id).toBe(offer.id);
    expect(thread.replies.map(r => r.text)).toEqual(['took 2, thanks!']);
    expect(thread.likelyResolved).toBe(true);
    const bundle = JSON.parse(exportCampBundle(phone.conn));
    expect(bundle.format).toBe(CAMP_BUNDLE_FORMAT);
    expect(bundle.envelopes[0].format).toBe(CAMP_BUNDLE_FORMAT);
    expect(bundle.envelopes[0].posts.find(
      (post: { id: string }) => post.id === offer.id,
    ).ref_writer_id).toBeNull();
    expect(bundle.envelopes[0].posts.find(
      (post: { id: string }) => post.id === reply.id,
    ).ref_writer_id).toBe(offer.writer_id);
    setPostDone(phone.conn, reply.id, true);
    const retracted = deriveBoard(listCampBoard(phone.conn), { freshOnly: false });
    expect(retracted[0].threads[0].replies).toEqual([]);
    expect(retracted[0].threads[0].likelyResolved).toBe(false);
    // The original row is untouched (still open, same text).
    expect(thread.post.done).toBe(false);
  });

  it('qualifies reply targets across writers and drops ambiguous legacy refs', () => {
    const a = makePhone('aaaa1111');
    const b = makePhone('bbbb2222');
    const c = makePhone('cccc3333');
    join(a, 'Maria');
    join(b, 'Ben');
    join(c, 'Caro');
    const ar = upsertCampPost(a.conn, { type: 'offer', text: 'Maria root' });
    const br = upsertCampPost(b.conn, { type: 'offer', text: 'Ben root' });
    a.conn.execute('UPDATE camp_posts SET id = ? WHERE id = ?', ['same-root', ar.id]);
    b.conn.execute('UPDATE camp_posts SET id = ? WHERE id = ?', ['same-root', br.id]);
    installCampBundle(c.conn, exportCampBundle(a.conn));
    installCampBundle(c.conn, exportCampBundle(b.conn));
    upsertCampPost(c.conn, {
      type: 'offer',
      text: 'reply only to Maria',
      ref_id: 'same-root',
      ref_writer_id: 'aaaa1111',
    });
    c.conn.execute(
      `INSERT INTO camp_posts
         (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, ref_writer_id, created_at, done)
       VALUES ('legacy', ?, ?, 'cccc3333', 'Caro', 'offer', 'ambiguous legacy', 'same-root', NULL, ?, 0)`,
      [
        boardPackId(campIdFor('dusty mary'), 'cccc3333'),
        campIdFor('dusty mary'),
        new Date().toISOString(),
      ],
    );
    const sections = deriveBoard(listCampBoard(c.conn), { freshOnly: false });
    const threads = sections.flatMap(s => s.threads);
    expect(threads.find(t => t.post.writer_id === 'aaaa1111')!.replies.map(r => r.text)).toEqual([
      'reply only to Maria',
    ]);
    expect(threads.find(t => t.post.writer_id === 'bbbb2222')!.replies).toEqual([]);
    const chunks = c.conn.execute(
      'SELECT pack_id, content FROM doc_chunks WHERE content LIKE ?',
      ['%root%'],
    ).rows!._array as Array<{ pack_id: string; content: string }>;
    expect(
      chunks.find(r => r.pack_id.includes('aaaa1111'))?.content,
    ).toContain('reply only to Maria');
    expect(
      chunks.find(r => r.pack_id.includes('bbbb2222'))?.content,
    ).not.toContain('reply only to Maria');
  });

  it('rejects orphan and cross-camp qualified reply targets', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const root = upsertCampPost(phone.conn, { type: 'offer', text: 'camp one root' });
    join(phone, 'Maria', 'another camp');
    expect(() =>
      upsertCampPost(phone.conn, {
        type: 'offer',
        text: 'cross-camp reply',
        ref_id: root.id,
        ref_writer_id: root.writer_id,
      }),
    ).toThrow(/no longer in this camp/);
    expect(() =>
      upsertCampPost(phone.conn, {
        type: 'offer',
        text: 'orphan reply',
        ref_id: 'missing',
        ref_writer_id: 'bbbb2222',
      }),
    ).toThrow(/no longer in this camp/);
  });

  it('fresh filter boundary: 71h shows, 73h hides under Fresh, shows under All', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const at = (hoursAgo: number) =>
      new Date(now.getTime() - hoursAgo * 3600_000).toISOString();
    expect(isFresh(at(71), now)).toBe(true);
    expect(isFresh(at(CAMP_FRESH_HOURS + 1), now)).toBe(false);

    const phone = makePhone('aaaa1111');
    const fresh = upsertCampPost(phone.conn, { type: 'offer', text: 'fresh tubes' });
    const old = upsertCampPost(phone.conn, { type: 'offer', text: 'ancient tubes' });
    phone.conn.execute('UPDATE camp_posts SET created_at = ? WHERE id = ?', [
      at(71),
      fresh.id,
    ]);
    phone.conn.execute('UPDATE camp_posts SET created_at = ? WHERE id = ?', [
      at(73),
      old.id,
    ]);
    const freshView = deriveBoard(listCampBoard(phone.conn), { freshOnly: true, now });
    expect(freshView[0].threads.map(t => t.post.text)).toEqual(['fresh tubes']);
    const allView = deriveBoard(listCampBoard(phone.conn), { freshOnly: false, now });
    expect(allView[0].threads.map(t => t.post.text).sort()).toEqual([
      'ancient tubes',
      'fresh tubes',
    ]);
  });

  it('ages label sanely', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    expect(ageLabel(at(5), now)).toBe('5m');
    expect(ageLabel(at(5 * 60), now)).toBe('5h');
    expect(ageLabel(at(3 * 24 * 60), now)).toBe('3d');
  });

  it('30-day local prune drops old rows and bumps own seq so the next beam supersedes (not forks)', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const keep = upsertCampPost(phone.conn, { type: 'offer', text: 'fresh tubes' });
    const old = upsertCampPost(phone.conn, { type: 'offer', text: 'ancient tubes' });
    const now = new Date();
    phone.conn.execute('UPDATE camp_posts SET created_at = ? WHERE id = ?', [
      new Date(
        now.getTime() - (CAMP_POST_MAX_AGE_DAYS + 1) * 86400_000,
      ).toISOString(),
      old.id,
    ]);
    const seqBefore = JSON.parse(exportCampBundle(phone.conn)).envelopes[0].seq;
    pruneCampPosts(phone.conn, now);
    expect(phone.postRows().map((r: any) => r.id)).toEqual([keep.id]);
    const env = JSON.parse(exportCampBundle(phone.conn)).envelopes[0];
    expect(env.seq).toBeGreaterThan(seqBefore);
    // A receiver holding the pre-prune snapshot sees a clean supersede.
    const peer = makePhone('bbbb2222');
    join(peer, 'Ben');
    const res = installCampBundle(peer.conn, exportCampBundle(phone.conn));
    expect(res.forks).toEqual([]);
    expect(res.installed).toEqual(['Maria']);
  });
});

describe('beam permutations (the refutation acceptance set)', () => {
  it('accepts format-2 notes on the pre-photo notes schema', () => {
    const phone = makePhone('bbbb2222');
    phone.conn.execute(`CREATE TABLE IF NOT EXISTS camp_notes (
      id TEXT PRIMARY KEY, camp_id TEXT NOT NULL, writer_id TEXT NOT NULL,
      author_name TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      when_date TEXT NOT NULL, time_start TEXT NOT NULL, time_end TEXT NOT NULL,
      where_addr TEXT NOT NULL, text TEXT NOT NULL, subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL, year TEXT NOT NULL, supersedes TEXT NOT NULL,
      created_at TEXT NOT NULL, revised_at TEXT NOT NULL
    )`);
    join(phone, 'Ben');
    expect(() => installCampBundle(phone.conn, FIXED_V2_BEAM)).not.toThrow();
    expect(
      phone.conn.execute('SELECT text FROM camp_notes WHERE id = ?', [
        'aaaa1111:n-fixed',
      ]).rows!.item(0).text,
    ).toBe('Pinned v2 note');
  });

  it('hydrates stored notes once when the notes owner table first appears', () => {
    const phone = makePhone('bbbb2222');
    join(phone, 'Ben');
    installCampBundle(phone.conn, FIXED_V2_BEAM);

    hydrateStoredCampNotes(phone.conn);
    expect(
      phone.conn.execute('SELECT text FROM camp_notes WHERE id = ?', [
        'aaaa1111:n-fixed',
      ]).rows!.item(0).text,
    ).toBe('Pinned v2 note');

    phone.conn.execute('UPDATE camp_notes SET text = ? WHERE id = ?', [
      'locally rematerialized',
      'aaaa1111:n-fixed',
    ]);
    hydrateStoredCampNotes(phone.conn);
    expect(
      phone.conn.execute('SELECT text FROM camp_notes WHERE id = ?', [
        'aaaa1111:n-fixed',
      ]).rows!.item(0).text,
    ).toBe('locally rematerialized');
  });

  it('accepts, stores, and relays a pinned format-2 posts+notes envelope verbatim', () => {
    const phone = makePhone('bbbb2222');
    join(phone, 'Ben');

    expect(installCampBundle(phone.conn, FIXED_V2_BEAM).installed).toEqual(['Maria']);
    expect(
      phone.conn.execute('SELECT text FROM camp_notes WHERE writer_id = ?', [
        'aaaa1111',
      ]).rows!.item(0).text,
    ).toBe('Pinned v2 note');
    const relayed = JSON.parse(exportCampBundle(phone.conn));
    const maria = relayed.envelopes.find(
      (env: { writer_id: string }) => env.writer_id === 'aaaa1111',
    );
    expect(maria).toEqual(JSON.parse(FIXED_V2_BEAM).envelopes[0]);
  });

  function boardPair() {
    const a = makePhone('aaaa1111');
    const b = makePhone('bbbb2222');
    join(a, 'Maria', 'Dusty Mary');
    join(b, 'Ben', '  dusty   mary '); // sloppier typing, same camp
    upsertCampPost(a.conn, { type: 'offer', text: '3 spare bike tubes' });
    upsertCampPost(b.conn, { type: 'need', text: 'ride to Reno Tuesday' });
    return { a, b };
  }

  it('round-trips: B imports A → union, labeled by author; duplicate import is a no-op', () => {
    const { a, b } = boardPair();
    const beam = exportCampBundle(a.conn);
    expect(parseCampBundle(beam)!.kind).toBe('playapal-camp-board');

    const res = installCampBundle(b.conn, beam);
    expect(res.installed).toEqual(['Maria']);
    expect(res.posts).toBe(1);
    expect(b.openBoard()).toEqual(['3 spare bike tubes', 'ride to Reno Tuesday']);
    const maria = listCampBoard(b.conn).find(p => p.text.includes('tubes'))!;
    expect(maria.author_name).toBe('Maria');
    expect(maria.fork).toBe(false);

    // Permutation 1: duplicate import → unchanged, nothing doubled.
    const res2 = installCampBundle(b.conn, beam);
    expect(res2.installed).toEqual([]);
    expect(res2.unchanged).toBe(1);
    expect(b.openBoard()).toEqual(['3 spare bike tubes', 'ride to Reno Tuesday']);
  });

  it('old-after-new is rejected as stale; new-after-old installs (no rollback either way)', () => {
    const { a, b } = boardPair();
    const beamOld = exportCampBundle(a.conn);
    upsertCampPost(a.conn, { type: 'offer', text: 'sunscreen, half a bottle' });
    const beamNew = exportCampBundle(a.conn);

    // new-after-old
    installCampBundle(b.conn, beamOld);
    const up = installCampBundle(b.conn, beamNew);
    expect(up.installed).toEqual(['Maria']);
    expect(b.openBoard()).toContain('sunscreen, half a bottle');

    // old-after-new → stale, state intact
    const back = installCampBundle(b.conn, beamOld);
    expect(back.stale).toBe(1);
    expect(back.installed).toEqual([]);
    expect(b.openBoard()).toContain('sunscreen, half a bottle');
  });

  it('done-before-open ordering: the done snapshot survives an older open snapshot arriving later', () => {
    const { a, b } = boardPair();
    const openBeam = exportCampBundle(a.conn); // tubes still open here
    const tubes = listCampBoard(a.conn).find(p => p.text.includes('tubes'))!;
    setPostDone(a.conn, tubes.id, true);
    const doneBeam = exportCampBundle(a.conn);

    // Multi-hop delivery order flips: the DONE beam arrives first…
    installCampBundle(b.conn, doneBeam);
    expect(b.openBoard()).toEqual(['ride to Reno Tuesday']);
    // …then the older OPEN beam trickles in. It must NOT resurrect the offer.
    const late = installCampBundle(b.conn, openBeam);
    expect(late.stale).toBe(1);
    expect(b.openBoard()).toEqual(['ride to Reno Tuesday']);
  });

  it('multi-hop: A reaches C through B without A and C meeting; reply threads survive the round-trip', () => {
    const { a, b } = boardPair();
    // A → B
    installCampBundle(b.conn, exportCampBundle(a.conn));
    // B replies to A's offer (B's OWN row referencing A's id).
    const tubes = listCampBoard(b.conn).find(p => p.text.includes('tubes'))!;
    upsertCampPost(b.conn, { type: 'offer', text: 'took 2, thanks!', ref_id: tubes.id });
    // B → C (C never met A).
    const c = makePhone('cccc3333');
    join(c, 'Caro');
    const res = installCampBundle(c.conn, exportCampBundle(b.conn));
    expect(res.installed.sort()).toEqual(['Ben', 'Maria']);
    expect(c.openBoard()).toEqual(['3 spare bike tubes', 'ride to Reno Tuesday']);
    // The thread renders on C: A's offer with B's reply, derived likely-resolved.
    const sections = deriveBoard(listCampBoard(c.conn), { freshOnly: false });
    const offerThread = sections
      .find(s => s.type === 'offer')!
      .threads.find(t => t.post.text.includes('tubes'))!;
    expect(offerThread.replies.map(r => r.text)).toEqual(['took 2, thanks!']);
    expect(offerThread.likelyResolved).toBe(true);
    // And B → A: the reply arrives back on the author's phone too.
    installCampBundle(a.conn, exportCampBundle(b.conn));
    const aSections = deriveBoard(listCampBoard(a.conn), { freshOnly: false });
    const aThread = aSections
      .find(s => s.type === 'offer')!
      .threads.find(t => t.post.text.includes('tubes'))!;
    expect(aThread.replies).toHaveLength(1);
    expect(aThread.likelyResolved).toBe(true);
  });

  it('equal seq + different hash surfaces a FORK beside the original — never overwrites', () => {
    const { a, b } = boardPair();
    const beam1 = exportCampBundle(a.conn);
    // Simulate a cloned writer: mutate A's row content directly (no seq bump),
    // then re-export — same seq, different payload.
    a.conn.execute("UPDATE camp_posts SET text = 'FIVE bike tubes' WHERE text LIKE '3 spare%'");
    const beam2 = exportCampBundle(a.conn);

    installCampBundle(b.conn, beam1);
    const res = installCampBundle(b.conn, beam2);
    expect(res.forks).toEqual(['Maria']);
    expect(res.installed).toEqual([]);
    // Both versions visible; original untouched.
    const texts = listCampBoard(b.conn).map(p => p.text);
    expect(texts).toContain('3 spare bike tubes');
    expect(texts).toContain('FIVE bike tubes');
    const forkRow = listCampBoard(b.conn).find(p => p.text === 'FIVE bike tubes')!;
    expect(forkRow.fork).toBe(true);
    const forkPack = b.packRows().find((p: any) => p.id.includes('-fork-'));
    expect(forkPack.name).toContain('conflicted copy');
    // The fork does NOT advance the high-water and is NOT re-exported.
    const reExport = JSON.parse(exportCampBundle(b.conn));
    const mariaEnvs = reExport.envelopes.filter(
      (e: any) => e.writer_id === 'aaaa1111',
    );
    expect(mariaEnvs).toHaveLength(1);
    expect(mariaEnvs[0].posts[0].text).toBe('3 spare bike tubes');
  });

  it('a notes-only fork projects its notes read-only under the fork pack (batch 4.1)', () => {
    const { a, b } = boardPair();
    upsertCampNote(a.conn, {
      kind: 'resource',
      title: 'Shade map',
      text: 'shade at 5:30 & E',
    });
    installCampBundle(b.conn, exportCampBundle(a.conn));
    // Clone divergence in NOTES only: mutate the note directly (no seq bump)
    // — posts identical, so the fork's whole difference is its notes.
    a.conn.execute("UPDATE camp_notes SET text = 'shade MOVED to 6:00 & F'");
    const forkBeam = exportCampBundle(a.conn);
    const res = installCampBundle(b.conn, forkBeam);
    expect(res.forks).toEqual(['Maria']);
    // The canonical owner store never absorbs the fork's notes.
    expect(
      b.conn
        .execute('SELECT text FROM camp_notes')
        .rows!._array.map((r: any) => r.text),
    ).toEqual(['shade at 5:30 & E']);
    // The divergent note IS readable — searchable text under the fork pack.
    const forkPack = b
      .packRows()
      .find((p: any) => p.id.includes('-fork-'))!.id;
    const chunks = () =>
      b.conn.execute(
        'SELECT heading, content, note_key FROM doc_chunks WHERE pack_id = ?',
        [forkPack],
      ).rows!._array as any[];
    const noteChunks = chunks().filter(c =>
      c.heading.includes('conflicted copy'),
    );
    expect(noteChunks).toHaveLength(1);
    expect(noteChunks[0].content).toContain('shade MOVED');
    // Never an events row: a conflicted snapshot is not calendar authority.
    expect(
      b.conn.execute('SELECT COUNT(*) AS n FROM events WHERE pack_id = ?', [
        forkPack,
      ]).rows!.item(0).n,
    ).toBe(0);
    // Idempotent re-import: recorded fork no-ops, chunks do not duplicate.
    const before = chunks().length;
    const again = installCampBundle(b.conn, forkBeam);
    expect(again.forks).toEqual([]);
    expect(chunks().length).toBe(before);
    // ONE hide key across every surface: hiding the note id hides the fork
    // copy too (they share their origin id).
    b.conn.execute(
      "INSERT INTO hidden_items (kind, key, label, ts) VALUES ('camp_note', ?, '', '')",
      [noteChunks[0].note_key],
    );
    rematerializeAllBoards(b.conn);
    expect(chunks().filter(c => c.heading.includes('conflicted copy'))).toEqual([]);
    b.conn.execute("DELETE FROM hidden_items WHERE kind = 'camp_note'");
    // Removal is the camp_forks row's own lifecycle: retire it and the
    // projection rebuilds nothing.
    b.conn.execute('DELETE FROM camp_forks WHERE pack_id = ?', [forkPack]);
    rematerializeAllBoards(b.conn);
    expect(chunks().filter(c => c.heading.includes('conflicted copy'))).toEqual([]);
  });

  it('an incoming newer copy of THIS writer surfaces as a conflicted copy, own board untouched', () => {
    const { a, b } = boardPair();
    installCampBundle(b.conn, exportCampBundle(a.conn));
    // B beams back to A; the bundle contains A's own envelope (unchanged: no-op)…
    const back1 = installCampBundle(a.conn, exportCampBundle(b.conn));
    expect(back1.unchanged).toBe(1); // A's own copy
    // …now simulate a clone of A that raced ahead: bump the copy's seq.
    const bundle = JSON.parse(exportCampBundle(b.conn));
    const mine = bundle.envelopes.find((e: any) => e.writer_id === 'aaaa1111');
    mine.seq += 5; // higher than A's real seq — but the tag no longer matches
    const tampered = JSON.stringify(bundle);
    expect(() => installCampBundle(a.conn, tampered)).toThrow(/integrity/i);
    // (A truly forked clone would carry a VALID tag; covered by the fork test.)
  });

  it('interrupted install leaves the prior valid state intact (single transaction)', () => {
    const { a, b } = boardPair();
    installCampBundle(b.conn, exportCampBundle(a.conn));
    const before = JSON.stringify(b.postRows()) + JSON.stringify(b.packRows());

    upsertCampPost(a.conn, { type: 'offer', text: 'sunscreen' });
    const beamNew = exportCampBundle(a.conn);
    // Wire a conn that dies mid-write (after the transaction has started).
    let executes = 0;
    const dying = {
      execute: (sql: string, params?: unknown[]) => {
        if (/INSERT INTO packs/i.test(sql)) {
          throw new Error('disk exploded');
        }
        executes += 1;
        return b.conn.execute(sql, params);
      },
    } as any;
    expect(() => installCampBundle(dying, beamNew)).toThrow(/disk exploded/);
    expect(executes).toBeGreaterThan(0);
    expect(JSON.stringify(b.postRows()) + JSON.stringify(b.packRows())).toBe(before);
    // And the real conn still works + accepts the beam afterwards.
    const retry = installCampBundle(b.conn, beamNew);
    expect(retry.installed).toEqual(['Maria']);
  });
});

describe('beam refusals (friendly, showable messages; camp isolation)', () => {
  function mariaBeam() {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    upsertCampPost(a.conn, { type: 'offer', text: '3 spare bike tubes' });
    return exportCampBundle(a.conn);
  }

  it('export requires the passphrase', () => {
    const phone = makePhone('aaaa1111');
    upsertCampPost(phone.conn, { type: 'offer', text: 'tubes' });
    expect(() => exportCampBundle(phone.conn)).toThrow(/camp passphrase/i);
  });

  it('reserves one envelope slot for this phone before accepting a new writer', () => {
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    const campId = campIdFor('dusty mary');
    for (let i = 0; i < 63; i++) {
      const writerId = `w${i.toString(36).padStart(3, '0')}`;
      b.conn.execute(
        `INSERT INTO camp_writers
           (camp_id, writer_id, author_name, seq, payload_hash, envelope_json, updated_at)
         VALUES (?, ?, '', 0, '', '{}', '')`,
        [campId, writerId],
      );
    }
    expect(() => installCampBundle(b.conn, mariaBeam())).toThrow(/as many campmate boards/i);
    expect(
      b.conn.execute('SELECT COUNT(*) AS n FROM camp_writers').rows!.item(0).n,
    ).toBe(63);
  });

  it('camp isolation: a different passphrase is a different camp — clean refusal, nothing imported', () => {
    const beam = mariaBeam();
    const b = makePhone('bbbb2222');
    join(b, 'Ben', 'totally other camp');
    expect(() => installCampBundle(b.conn, beam)).toThrow(/different camp/i);
    expect(b.postRows()).toHaveLength(0);
  });

  it('rejects a correctly sealed format-3 reply without qualified writer identity', () => {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    const root = upsertCampPost(a.conn, { type: 'offer', text: 'bike tubes' });
    upsertCampPost(a.conn, {
      type: 'offer',
      text: 'thanks',
      ref_id: root.id,
      ref_writer_id: root.writer_id,
    });
    const bundle = JSON.parse(exportCampBundle(a.conn));
    const env = bundle.envelopes[0];
    env.posts.find((post: { ref_id: string | null }) => post.ref_id)!.ref_writer_id = null;
    const posts = (env.posts as CampPost[])
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id));
    const canonicalPosts = posts
      .map(post => [
        post.id,
        post.ref_id ?? '',
        post.ref_writer_id ?? '',
        post.type,
        post.text,
        post.author_name,
        post.created_at,
        post.done ? '1' : '0',
      ].join(''))
      .join('\n');
    const canonical = `${canonicalPosts}\n`;
    env.payload_hash = sha256Hex(canonical);
    env.tag = hmacSha256Hex(
      'playapal-camp-v0:dusty mary',
      [
        bundle.kind,
        String(env.format),
        env.camp_id,
        env.writer_id,
        env.author_name,
        env.key_id,
        String(env.seq),
        env.payload_hash,
        canonical,
      ].join('\n'),
    );
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    expect(() => installCampBundle(b.conn, JSON.stringify(bundle))).toThrow(/damaged/i);
  });

  it('tampered content fails the integrity check; nothing imported', () => {
    const beam = mariaBeam();
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    expect(() =>
      installCampBundle(b.conn, beam.replace('3 spare', 'ZERO')),
    ).toThrow(/integrity/i);
    expect(b.postRows()).toHaveLength(0);
  });

  it('no local passphrase → friendly setup message', () => {
    const beam = mariaBeam();
    const b = makePhone('bbbb2222');
    expect(() => installCampBundle(b.conn, beam)).toThrow(
      /set your camp passphrase first/i,
    );
  });

  it('not a beam / damaged / future format', () => {
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    expect(parseCampBundle('not json')).toBeNull();
    expect(parseCampBundle('{"kind":"other"}')).toBeNull();
    expect(() => installCampBundle(b.conn, 'not json')).toThrow(/not a camp-board beam/i);
    const camp = campIdFor('dusty mary');
    const damaged = JSON.stringify({
      kind: 'playapal-camp-board',
      format: 1,
      camp_id: camp,
      envelopes: [{ camp_id: camp, writer_id: '!!', seq: 1, posts: [], tag: 'x', payload_hash: 'y', author_name: 'X', key_id: 'z' }],
    });
    expect(() => installCampBundle(b.conn, damaged)).toThrow(/damaged/i);
    const future = JSON.stringify({
      kind: 'playapal-camp-board',
      format: 99,
      camp_id: camp,
      envelopes: [],
    });
    expect(() => installCampBundle(b.conn, future)).toThrow(/newer version/i);
  });

  it('disabling a beamed board pack hides its posts without losing data', () => {
    const beam = mariaBeam();
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    upsertCampPost(b.conn, { type: 'need', text: 'ride to Reno' });
    installCampBundle(b.conn, beam);
    b.conn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [boardPackId(campIdFor('dusty mary'), 'aaaa1111')]);
    expect(b.openBoard()).toEqual(['ride to Reno']);
    expect(
      b.postRows().filter((r: any) => r.pack_id === boardPackId(campIdFor('dusty mary'), 'aaaa1111')),
    ).toHaveLength(1);
  });
});
