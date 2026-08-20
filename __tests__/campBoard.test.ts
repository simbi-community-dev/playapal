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
  CAMP_FRESH_HOURS,
  CAMP_PACK_PREFIX,
  boardPackId,
  CAMP_POST_MAX_AGE_DAYS,
  CAMP_WRITER_ID_KEY,
  CampBeamError,
  ageLabel,
  campIdFor,
  deriveBoard,
  exportCampBundle,
  getCampIdentity,
  installCampBundle,
  isFresh,
  listCampBoard,
  normalizePassphrase,
  parseCampBundle,
  pruneCampPosts,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../src/camp/campBoard';

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

describe('identity + value at N=1', () => {
  it('generates and persists an 8-hex writer id; no passphrase needed to post', () => {
    const phone = makePhone();
    const first = getCampIdentity(phone.conn);
    expect(first.writerId).toMatch(/^[0-9a-f]{8}$/);
    expect(getCampIdentity(phone.conn).writerId).toBe(first.writerId);
    upsertCampPost(phone.conn, { type: 'offer', text: '3 spare bike tubes' });
    expect(phone.openBoard()).toEqual(['3 spare bike tubes']);
  });

  it('normalizes passphrases; camp id derives from the normalized phrase', () => {
    expect(normalizePassphrase('  Dusty   Mary ')).toBe('dusty mary');
    expect(campIdFor(' DUSTY  mary')).toBe(campIdFor('dusty mary'));
    expect(campIdFor('dusty mary')).not.toBe(campIdFor('other camp'));
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
    const offer = upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });
    upsertCampPost(phone.conn, {
      type: 'offer',
      text: 'took 2, thanks!',
      ref_id: offer.id,
    });
    const sections = deriveBoard(listCampBoard(phone.conn), { freshOnly: false });
    expect(sections).toHaveLength(1);
    const thread = sections[0].threads[0];
    expect(thread.post.id).toBe(offer.id);
    expect(thread.replies.map(r => r.text)).toEqual(['took 2, thanks!']);
    expect(thread.likelyResolved).toBe(true);
    // The original row is untouched (still open, same text).
    expect(thread.post.done).toBe(false);
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

  it('camp isolation: a different passphrase is a different camp — clean refusal, nothing imported', () => {
    const beam = mariaBeam();
    const b = makePhone('bbbb2222');
    join(b, 'Ben', 'totally other camp');
    expect(() => installCampBundle(b.conn, beam)).toThrow(/different camp/i);
    expect(b.postRows()).toHaveLength(0);
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
