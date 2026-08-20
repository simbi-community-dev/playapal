/**
 * Camp-board adversarial regression suite — each test named by the review
 * finding it cures:
 *
 *  F1  duplicate writer envelopes INSIDE ONE BEAM: [new,old], [old,new],
 *      [same,same], [same-seq hash A, same-seq hash B], and the
 *      re-export-of-merged-board round trip.
 *  F2  local mutations are transactional: failure injection at the seq
 *      bump, materialization, done-flag, profile, and prune boundaries.
 *  F3  camp boundary: pre-camp drafts adopt into the first join; switching
 *      camps hides + never exports the old camp's posts; same writer in two
 *      camps lands in two distinct packs.
 *  F4  writer incarnation: a restored clone (settings without the
 *      non-backed-up token) ROTATES instead of forking the original.
 *  F6  forks are durable + idempotent (full-tuple camp_forks record,
 *      16-hex pack ids, re-import = no-op).
 *  F7  import rollback holds across ALL camp tables (posts, packs,
 *      writers, chunks), injected after the high-water write too.
 *  F8  the own-writer fork branch, exercised with VALID seals (the old
 *      test only ever failed MAC verification).
 *  F9  deletion-by-omission honesty: an all-pruned (empty) snapshot
 *      empties the receiver's pack; the pre-prune beam is then stale.
 *
 * All against the real DDL via node:sqlite.
 */

import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
} from '../src/events/schema';
import {
  CAMP_BUNDLE_FORMAT,
  CAMP_BUNDLE_KIND,
  CAMP_INCARNATION_KEY,
  CAMP_POST_MAX_AGE_DAYS,
  CAMP_WRITER_ID_KEY,
  boardPackId,
  campIdFor,
  exportCampBundle,
  getCampIdentity,
  installCampBundle,
  listCampBoard,
  migrateLegacyOwnPack,
  pruneCampPosts,
  reconcileWriterIncarnation,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../src/camp/campBoard';

const { DatabaseSync } = require('node:sqlite');

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
  const table = (name: string): any[] =>
    conn.execute(`SELECT * FROM ${name} ORDER BY rowid`).rows!._array;
  const snapshot = (): string =>
    JSON.stringify({
      posts: table('camp_posts'),
      packs: table('packs'),
      writers: table('camp_writers'),
      forks: table('camp_forks'),
      chunks: table('doc_chunks'),
      settings: table('settings'),
    });
  const openBoard = (): string[] =>
    listCampBoard(conn)
      .filter((p: any) => !p.ref_id && !p.done)
      .map((p: any) => p.text)
      .sort();
  return { conn, table, snapshot, openBoard };
}

type Phone = ReturnType<typeof makePhone>;

const CAMP = campIdFor('dusty mary');
const join = (phone: Phone, name: string, passphrase = 'dusty mary') =>
  saveCampProfile(phone.conn, { authorName: name, passphrase });

/** Build a bundle from envelopes plucked out of real exports. */
const splice = (envelopes: any[]): string =>
  JSON.stringify({
    kind: CAMP_BUNDLE_KIND,
    format: CAMP_BUNDLE_FORMAT,
    camp_id: CAMP,
    envelopes,
  });

const envOf = (beam: string, writerId: string): any =>
  JSON.parse(beam).envelopes.find((e: any) => e.writer_id === writerId);

/** A conn wrapper that throws on the first statement matching `pattern`. */
const dyingConn = (phone: Phone, pattern: RegExp) =>
  ({
    execute: (sql: string, params?: unknown[]) => {
      if (pattern.test(sql)) {
        throw new Error(`injected failure on: ${sql.slice(0, 40)}`);
      }
      return phone.conn.execute(sql, params);
    },
  } as any);

// ---------------------------------------------------------------------------
// F1 — duplicate writer envelopes inside one beam
// ---------------------------------------------------------------------------

describe('F1: one beam, one writer, many envelopes', () => {
  function mariaTwoRevisions() {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    upsertCampPost(a.conn, { type: 'offer', text: 'bike tubes' });
    const oldEnv = envOf(exportCampBundle(a.conn), 'aaaa1111');
    upsertCampPost(a.conn, { type: 'offer', text: 'sunscreen' });
    const newEnv = envOf(exportCampBundle(a.conn), 'aaaa1111');
    return { oldEnv, newEnv };
  }

  it('[new, old] applies only the new snapshot — no rollback', () => {
    const { oldEnv, newEnv } = mariaTwoRevisions();
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    const res = installCampBundle(b.conn, splice([newEnv, oldEnv]));
    expect(res.installed).toEqual(['Maria']);
    expect(res.stale).toBe(1);
    expect(res.forks).toEqual([]);
    expect(b.openBoard()).toEqual(['bike tubes', 'sunscreen']);
  });

  it('[old, new] converges to the same state (order independence)', () => {
    const { oldEnv, newEnv } = mariaTwoRevisions();
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    const res = installCampBundle(b.conn, splice([oldEnv, newEnv]));
    expect(res.installed).toEqual(['Maria']);
    expect(res.stale).toBe(1);
    expect(b.openBoard()).toEqual(['bike tubes', 'sunscreen']);
    // And the receiver's stored high-water is the NEW revision.
    const hw = b.table('camp_writers').find(w => w.writer_id === 'aaaa1111');
    expect(hw.seq).toBe(newEnv.seq);
  });

  it('[same, same] collapses to one install, no duplicated rows', () => {
    const { newEnv } = mariaTwoRevisions();
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    const res = installCampBundle(b.conn, splice([newEnv, newEnv]));
    expect(res.installed).toEqual(['Maria']);
    expect(res.unchanged).toBe(1);
    expect(
      b.table('camp_posts').filter(r => r.writer_id === 'aaaa1111'),
    ).toHaveLength(2);
  });

  it('[seq-N hash A, seq-N hash B] for an unknown writer: deterministic winner + surfaced fork', () => {
    // Two divergent phones legitimately sharing one writer id (a clone).
    const a1 = makePhone('aaaa1111');
    join(a1, 'Maria');
    upsertCampPost(a1.conn, { type: 'offer', text: 'variant one' });
    const envA = envOf(exportCampBundle(a1.conn), 'aaaa1111');
    const a2 = makePhone('aaaa1111');
    join(a2, 'Maria');
    upsertCampPost(a2.conn, { type: 'offer', text: 'variant two' });
    const envB = envOf(exportCampBundle(a2.conn), 'aaaa1111');
    expect(envA.seq).toBe(envB.seq);
    expect(envA.payload_hash).not.toBe(envB.payload_hash);

    const winner =
      envA.payload_hash < envB.payload_hash ? 'variant one' : 'variant two';
    const forked = winner === 'variant one' ? 'variant two' : 'variant one';

    for (const order of [
      [envA, envB],
      [envB, envA],
    ]) {
      const b = makePhone('bbbb2222');
      join(b, 'Ben');
      const res = installCampBundle(b.conn, splice(order));
      expect(res.installed).toEqual(['Maria']);
      expect(res.forks).toEqual(['Maria']);
      // Winner is chosen by hash, NOT bundle order.
      const live = listCampBoard(b.conn).find(p => !p.fork && p.writer_id === 'aaaa1111')!;
      expect(live.text).toBe(winner);
      const fork = listCampBoard(b.conn).find(p => p.fork)!;
      expect(fork.text).toBe(forked);
      // Fork pack id carries 16 hex of the payload hash; record is durable.
      const rec = b.table('camp_forks')[0];
      expect(rec.pack_id).toMatch(/-fork-[0-9a-f]{16}$/);
      expect(rec.payload_hash).toHaveLength(64);
      // Re-importing the same bundle is a full no-op (F6 idempotence).
      const again = installCampBundle(b.conn, splice(order));
      expect(again.installed).toEqual([]);
      expect(again.forks).toEqual([]);
      expect(b.table('camp_forks')).toHaveLength(1);
    }
  });

  it('re-export of a merged board round-trips as pure no-ops', () => {
    const a = makePhone('aaaa1111');
    const b = makePhone('bbbb2222');
    const c = makePhone('cccc3333');
    join(a, 'Maria');
    join(b, 'Ben');
    join(c, 'Caro');
    upsertCampPost(a.conn, { type: 'offer', text: 'bike tubes' });
    upsertCampPost(b.conn, { type: 'need', text: 'ride to Reno' });
    installCampBundle(b.conn, exportCampBundle(a.conn)); // A -> B
    installCampBundle(c.conn, exportCampBundle(b.conn)); // B -> C (carries A)
    // C's merged re-export back into B: C is new; A and B's own are no-ops.
    const back = installCampBundle(b.conn, exportCampBundle(c.conn));
    expect(back.installed).toEqual(['Caro']);
    expect(back.forks).toEqual([]);
    expect(back.unchanged).toBe(2); // A's copy + B's own copy
    // Once more: everything is a no-op now.
    const again = installCampBundle(b.conn, exportCampBundle(c.conn));
    expect(again.installed).toEqual([]);
    expect(again.forks).toEqual([]);
    expect(again.stale).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F8 + F6 — the own-writer fork branch, with VALID seals
// ---------------------------------------------------------------------------

describe('F8: a validly sealed clone of THIS writer forks, never overwrites', () => {
  it('equal-seq divergent clone surfaces as a fork; own board and seq untouched; idempotent', () => {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    upsertCampPost(a.conn, { type: 'offer', text: 'the real board' });
    const clone = makePhone('aaaa1111'); // same writer id, same passphrase
    join(clone, 'Maria');
    upsertCampPost(clone.conn, { type: 'offer', text: 'the clone board' });

    const before = {
      posts: JSON.stringify(a.table('camp_posts').filter(r => !r.pack_id.includes('-fork-'))),
      seq: a.table('settings').find(s => s.key === 'camp_own_seq').value,
    };
    const res = installCampBundle(a.conn, exportCampBundle(clone.conn));
    expect(res.forks).toEqual(['Maria']);
    expect(res.installed).toEqual([]);
    // Own live pack + own seq unchanged.
    expect(
      JSON.stringify(a.table('camp_posts').filter(r => !r.pack_id.includes('-fork-'))),
    ).toBe(before.posts);
    expect(a.table('settings').find(s => s.key === 'camp_own_seq').value).toBe(
      before.seq,
    );
    // Both boards visible; fork is marked.
    const texts = listCampBoard(a.conn).map(p => `${p.text}${p.fork ? '!' : ''}`);
    expect(texts.sort()).toEqual(['the clone board!', 'the real board']);
    // Durable full-tuple record + idempotent re-import.
    expect(a.table('camp_forks')).toHaveLength(1);
    const again = installCampBundle(a.conn, exportCampBundle(clone.conn));
    expect(again.forks).toEqual([]);
    expect(a.table('camp_forks')).toHaveLength(1);
  });

  it('a HIGHER-seq clone copy also forks (never installs over the live board)', () => {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    upsertCampPost(a.conn, { type: 'offer', text: 'the real board' });
    const clone = makePhone('aaaa1111');
    join(clone, 'Maria');
    upsertCampPost(clone.conn, { type: 'offer', text: 'clone v1' });
    upsertCampPost(clone.conn, { type: 'offer', text: 'clone v2' }); // seq ahead
    const res = installCampBundle(a.conn, exportCampBundle(clone.conn));
    expect(res.forks).toEqual(['Maria']);
    expect(
      listCampBoard(a.conn).filter(p => !p.fork).map(p => p.text),
    ).toEqual(['the real board']);
  });
});

// ---------------------------------------------------------------------------
// F2 — transactional local mutations (failure injection per boundary)
// ---------------------------------------------------------------------------

describe('F2: local mutations are atomic with their seq bump + materialization', () => {
  const boundaries: [string, RegExp][] = [
    ['seq bump', /INSERT INTO settings/i],
    ['pack row', /INSERT INTO packs/i],
    ['materialization', /INSERT INTO doc_chunks/i],
  ];

  for (const [name, pattern] of boundaries) {
    it(`a post that dies at the ${name} leaves NOTHING behind`, () => {
      const phone = makePhone('aaaa1111');
      join(phone, 'Maria');
      upsertCampPost(phone.conn, { type: 'offer', text: 'stable' });
      const before = phone.snapshot();
      expect(() =>
        upsertCampPost(dyingConn(phone, pattern), { type: 'offer', text: 'doomed' }),
      ).toThrow(/injected failure/);
      expect(phone.snapshot()).toBe(before);
    });
  }

  it('a done-toggle that dies mid-materialization rolls the flag back', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const post = upsertCampPost(phone.conn, { type: 'offer', text: 'stable' });
    // A second OPEN post keeps materialization non-empty, so the injected
    // doc_chunks failure actually fires inside the transaction.
    upsertCampPost(phone.conn, { type: 'need', text: 'still open' });
    const before = phone.snapshot();
    expect(() =>
      setPostDone(dyingConn(phone, /INSERT INTO doc_chunks/i), post.id, true),
    ).toThrow(/injected failure/);
    expect(phone.snapshot()).toBe(before);
  });

  it('a profile save that dies mid-way changes no settings and no rows', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    upsertCampPost(phone.conn, { type: 'offer', text: 'stable' });
    const before = phone.snapshot();
    expect(() =>
      saveCampProfile(dyingConn(phone, /INSERT INTO doc_chunks/i), {
        authorName: 'Renamed',
        passphrase: 'dusty mary',
      }),
    ).toThrow(/injected failure/);
    expect(phone.snapshot()).toBe(before);
    expect(getCampIdentity(phone.conn).authorName).toBe('Maria');
  });

  it('an interrupted prune rolls back whole (no partial deletion, no throw)', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    const old = upsertCampPost(phone.conn, { type: 'offer', text: 'ancient' });
    // A fresh post survives the prune, so re-materialization inserts and the
    // injected failure fires mid-transaction.
    upsertCampPost(phone.conn, { type: 'offer', text: 'fresh tubes' });
    phone.conn.execute('UPDATE camp_posts SET created_at = ? WHERE id = ?', [
      new Date(Date.now() - (CAMP_POST_MAX_AGE_DAYS + 1) * 86400_000).toISOString(),
      old.id,
    ]);
    const before = phone.snapshot();
    pruneCampPosts(dyingConn(phone, /INSERT INTO doc_chunks/i)); // must not throw
    expect(phone.snapshot()).toBe(before); // and must not half-delete
  });
});

// ---------------------------------------------------------------------------
// F7 — import rollback across ALL camp tables, injected late
// ---------------------------------------------------------------------------

describe('F7: interrupted import leaves every camp table intact', () => {
  const late: [string, RegExp][] = [
    ['high-water write', /INSERT INTO camp_writers/i],
    ['materialization (after the high-water write)', /INSERT INTO doc_chunks/i],
  ];
  for (const [name, pattern] of late) {
    it(`injection at the ${name} rolls back posts, packs, writers, forks, and chunks`, () => {
      const a = makePhone('aaaa1111');
      join(a, 'Maria');
      upsertCampPost(a.conn, { type: 'offer', text: 'bike tubes' });
      const b = makePhone('bbbb2222');
      join(b, 'Ben');
      upsertCampPost(b.conn, { type: 'need', text: 'ride' });
      const before = b.snapshot();
      expect(() =>
        installCampBundle(dyingConn(b, pattern), exportCampBundle(a.conn)),
      ).toThrow(/injected failure/);
      expect(b.snapshot()).toBe(before);
      // The real conn still accepts the beam afterwards.
      const res = installCampBundle(b.conn, exportCampBundle(a.conn));
      expect(res.installed).toEqual(['Maria']);
    });
  }
});

// ---------------------------------------------------------------------------
// F3 — the camp boundary
// ---------------------------------------------------------------------------

describe('F3: posts belong to the camp they were authored under', () => {
  it('pre-camp drafts adopt into the FIRST camp joined and beam from it', () => {
    const phone = makePhone('aaaa1111');
    upsertCampPost(phone.conn, { type: 'offer', text: 'pre-camp draft' });
    expect(phone.openBoard()).toEqual(['pre-camp draft']); // visible at N=1
    join(phone, 'Maria');
    expect(phone.openBoard()).toEqual(['pre-camp draft']); // adopted
    const beam = exportCampBundle(phone.conn);
    expect(beam).toContain('pre-camp draft');
    const row = phone.table('camp_posts')[0];
    expect(row.camp_id).toBe(CAMP);
    expect(row.pack_id).toBe(boardPackId(CAMP, 'aaaa1111'));
  });

  it('switching camps hides and NEVER exports the old camp; switching back restores it', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria', 'dusty mary');
    upsertCampPost(phone.conn, { type: 'offer', text: 'dusty star secret plans' });
    join(phone, 'Maria', 'other camp phrase');
    expect(phone.openBoard()).toEqual([]); // clean context
    upsertCampPost(phone.conn, { type: 'need', text: 'other camp firewood' });
    expect(phone.openBoard()).toEqual(['other camp firewood']);
    // The beam sealed for the OTHER camp must not disclose the first camp.
    const beam = exportCampBundle(phone.conn);
    expect(beam).not.toContain('dusty star secret plans');
    // Old rows are untouched on disk, behind their camp boundary.
    expect(
      phone.table('camp_posts').find(r => r.text === 'dusty star secret plans')
        .camp_id,
    ).toBe(CAMP);
    // Switching back restores the first camp and hides the second.
    join(phone, 'Maria', 'dusty mary');
    expect(phone.openBoard()).toEqual(['dusty star secret plans']);
  });

  it('the same writer imported under two camps lands in two distinct packs', () => {
    const w = makePhone('aaaa1111');
    join(w, 'Maria', 'dusty mary');
    upsertCampPost(w.conn, { type: 'offer', text: 'camp one offer' });
    const beam1 = exportCampBundle(w.conn);
    join(w, 'Maria', 'camp two phrase');
    upsertCampPost(w.conn, { type: 'offer', text: 'camp two offer' });
    const beam2 = exportCampBundle(w.conn);

    const r = makePhone('bbbb2222');
    join(r, 'Ben', 'dusty mary');
    installCampBundle(r.conn, beam1);
    expect(r.openBoard()).toEqual(['camp one offer']);
    join(r, 'Ben', 'camp two phrase');
    installCampBundle(r.conn, beam2);
    expect(r.openBoard()).toEqual(['camp two offer']); // camp 2 context only
    // Two physically distinct packs; camp 1 remains intact underneath.
    const packs = r
      .table('packs')
      .filter(p => p.id.includes('aaaa1111'))
      .map(p => p.id)
      .sort();
    expect(packs).toEqual([
      boardPackId(campIdFor('camp two phrase'), 'aaaa1111'),
      boardPackId(CAMP, 'aaaa1111'),
    ].sort());
    join(r, 'Ben', 'dusty mary');
    expect(r.openBoard()).toEqual(['camp one offer']);
  });
});

// ---------------------------------------------------------------------------
// F4 — writer incarnation (restore-clone rotates, never forks)
// ---------------------------------------------------------------------------

describe('F4: incarnation token reconciliation', () => {
  it('fresh install mints a token once and is then a no-op', () => {
    const phone = makePhone('aaaa1111');
    const first = reconcileWriterIncarnation(phone.conn, null);
    expect(first.rotated).toBe(false);
    expect(first.token).toMatch(/^[0-9a-f]{16}$/);
    const second = reconcileWriterIncarnation(phone.conn, first.token);
    expect(second).toEqual({ token: first.token, rotated: false });
    expect(getCampIdentity(phone.conn).writerId).toBe('aaaa1111');
  });

  it('a restored clone (token missing) rotates the writer and carries its posts', () => {
    const phone = makePhone('aaaa1111');
    reconcileWriterIncarnation(phone.conn, null);
    join(phone, 'Maria');
    upsertCampPost(phone.conn, { type: 'offer', text: 'bike tubes' });

    // Restore: settings (incl. token) came back, the Caches file did not.
    const out = reconcileWriterIncarnation(phone.conn, null);
    expect(out.rotated).toBe(true);
    const newWriter = getCampIdentity(phone.conn).writerId;
    expect(newWriter).not.toBe('aaaa1111');
    // Own posts carried to the new incarnation; board unchanged for the user.
    expect(phone.openBoard()).toEqual(['bike tubes']);
    expect(phone.table('camp_posts')[0].writer_id).toBe(newWriter);
    expect(phone.table('camp_posts')[0].pack_id).toBe(boardPackId(CAMP, newWriter));

    // THE cure: the rotated clone's beam lands as a NEW writer on the
    // original phone — additive union, no equal-seq fork ever constructed.
    const original = makePhone('aaaa1111');
    reconcileWriterIncarnation(original.conn, 'ffffffffffffffff');
    // (original keeps its own token; different value is fine — it has its file)
    original.conn.execute(
      `UPDATE settings SET value = 'ffffffffffffffff' WHERE key = '${CAMP_INCARNATION_KEY}'`,
    );
    join(original, 'Maria');
    upsertCampPost(original.conn, { type: 'offer', text: 'the original board' });
    const res = installCampBundle(original.conn, exportCampBundle(phone.conn));
    expect(res.forks).toEqual([]);
    expect(res.installed).toEqual(['Maria']);
    expect(original.openBoard().sort()).toEqual([
      'bike tubes',
      'the original board',
    ]);
  });

  it('a mismatched token also rotates (token is the source of truth)', () => {
    const phone = makePhone('aaaa1111');
    const first = reconcileWriterIncarnation(phone.conn, null);
    const out = reconcileWriterIncarnation(phone.conn, 'not-' + first.token);
    expect(out.rotated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy migration + F9 honesty
// ---------------------------------------------------------------------------

describe('legacy r9 pack-id migration', () => {
  it('moves old-format own rows into the current camp context, once', () => {
    const phone = makePhone('aaaa1111');
    join(phone, 'Maria');
    // Simulate the r9 bench db: rows under camp-board-<writer>, camp_id ''.
    phone.conn.execute(
      `INSERT INTO camp_posts (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, created_at, done)
       VALUES ('p1', 'camp-board-aaaa1111', '', 'aaaa1111', 'Rook', 'offer', '3 spare bike tubes', NULL, ?, 0)`,
      [new Date().toISOString()],
    );
    phone.conn.execute(
      `INSERT INTO packs (id, name, description, version, enabled, builtin)
       VALUES ('camp-board-aaaa1111', 'Camp board — Rook (this phone)', '', 4, 1, 0)`,
    );
    migrateLegacyOwnPack(phone.conn);
    const row = phone.table('camp_posts').find(r => r.id === 'p1');
    expect(row.pack_id).toBe(boardPackId(CAMP, 'aaaa1111'));
    expect(row.camp_id).toBe(CAMP);
    expect(phone.table('packs').some(p => p.id === 'camp-board-aaaa1111')).toBe(false);
    expect(phone.openBoard()).toContain('3 spare bike tubes');
    const snap = phone.snapshot();
    migrateLegacyOwnPack(phone.conn); // idempotent
    expect(phone.snapshot()).toBe(snap);
  });
});

describe('F9: age-prune is deletion by omission, made replay-safe by seq', () => {
  it('an all-pruned (empty) snapshot empties the receiver; the fat old beam is then stale', () => {
    const a = makePhone('aaaa1111');
    join(a, 'Maria');
    const post = upsertCampPost(a.conn, { type: 'offer', text: 'ancient tubes' });
    const fatBeam = exportCampBundle(a.conn);
    const b = makePhone('bbbb2222');
    join(b, 'Ben');
    installCampBundle(b.conn, fatBeam);
    expect(b.openBoard()).toEqual(['ancient tubes']);

    a.conn.execute('UPDATE camp_posts SET created_at = ? WHERE id = ?', [
      new Date(Date.now() - (CAMP_POST_MAX_AGE_DAYS + 1) * 86400_000).toISOString(),
      post.id,
    ]);
    pruneCampPosts(a.conn);
    const emptyBeam = exportCampBundle(a.conn);
    expect(JSON.parse(emptyBeam).envelopes[0].posts).toHaveLength(0);

    const res = installCampBundle(b.conn, emptyBeam);
    expect(res.installed).toEqual(['Maria']);
    expect(b.openBoard()).toEqual([]);
    // Replaying the pre-prune beam cannot resurrect the pruned row.
    const back = installCampBundle(b.conn, fatBeam);
    expect(back.stale).toBe(1);
    expect(b.openBoard()).toEqual([]);
  });
});
