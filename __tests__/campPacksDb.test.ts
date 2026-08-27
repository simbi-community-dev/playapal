/**
 * The db layer's board composition: the REAL src/events/db.ts (schema init +
 * builtin seeding + FTS probe) over a node:sqlite shim — listPacks post
 * counts, the own-board-pack removal guard, and cross-pack reply lifecycle
 * across toggle, done/reopen, removal, and deliberate re-import restore.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';

const { DatabaseSync } = require('node:sqlite');

const mockRealDb = new DatabaseSync(':memory:');
let mockFailDocFtsRebuild = false;

// The storage-engine seam (quick-sqlite → op-sqlite migration): db.ts opens
// through src/events/engine, so the test engine mocks THE SEAM — same
// node:sqlite backing, same conn.execute shape, no native module needed.
jest.mock('../src/events/engine', () => ({
  // SPREAD THE REAL MODULE, override only what the test must fake.
  //
  // This mock used to hand-LIST its exports, so the moment db.ts started
  // calling engine.getSettingOn the suite died with "is not a function" —
  // five tests, none of them about settings. A hand-listed module mock is a
  // second copy of that module's surface, and it drifts exactly like any other
  // duplicated fact. Spreading requireActual means it cannot: engine.ts has no
  // imports of its own, so pulling it in is free and nothing native loads.
  ...jest.requireActual('../src/events/engine'),
  openAppDb: () => ({
    execute: (sql: string, params: unknown[] = []) => {
      if (mockFailDocFtsRebuild && sql.includes('doc_chunks_fts(doc_chunks_fts)')) {
        mockFailDocFtsRebuild = false;
        throw new Error('injected FTS rebuild failure');
      }
      const stmt = mockRealDb.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  }),
  loadVecExtension: () => {
    throw new Error('no sqlite-vec in this suite — semantic arm inert');
  },
}));

import {
  getDb,
  listPacks,
  removePack,
  rebuildFtsAfterCommit,
  rebuildFtsIndexes,
  setPackEnabled,
} from '../src/events/db';
import {
  CAMP_WRITER_ID_KEY,
  boardPackId,
  campIdFor,
  exportCampBundle,
  installCampBundle,
  listCampBoard,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../src/camp/campBoard';

describe('db layer board composition (real db.ts over node:sqlite)', () => {
  beforeAll(() => {
    const conn = getDb(); // runs the real initSchema + seedBuiltinPacks
    saveCampProfile(conn, { authorName: 'Maria', passphrase: 'dusty mary' });
    upsertCampPost(conn, { type: 'offer', text: '3 spare bike tubes' });
    rebuildFtsIndexes(conn);
  });

  it('listPacks shows the own board pack with a post count (builtins at 0)', () => {
    const packs = listPacks();
    const own = packs.find(p => p.id.startsWith('camp-board-'))!;
    expect(own.name).toBe('Camp board — Maria (this phone)');
    expect(own.postCount).toBe(1);
    expect(own.builtin).toBe(false);
    for (const b of packs.filter(p => p.builtin)) {
      expect(b.postCount).toBe(0);
    }
  });

  it("refuses to remove or disable this phone's own board pack", () => {
    const own = listPacks().find(p => p.id.startsWith('camp-board-'))!;
    expect(() => removePack(own.id)).toThrow(/Camp tab/);
    expect(() => setPackEnabled(own.id, false)).toThrow(/stays enabled/);
    expect(listPacks().find(p => p.id === own.id)?.enabled).toBe(true);
  });

  it('reports post-commit index failures without duplicating post/edit/done writes', () => {
    const conn = getDb();
    const post = upsertCampPost(conn, { type: 'need', text: 'one canonical write' });
    mockFailDocFtsRebuild = true;
    expect(rebuildFtsAfterCommit(conn, 'post save')).toMatch(/indexing hiccuped/i);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM camp_posts WHERE id = ?', [post.id])
        .rows!.item(0).n,
    ).toBe(1);

    upsertCampPost(conn, {
      id: post.id,
      type: 'need',
      text: 'one canonical edit',
    });
    mockFailDocFtsRebuild = true;
    expect(rebuildFtsAfterCommit(conn, 'post edit')).toMatch(/indexing hiccuped/i);
    expect(
      conn.execute('SELECT text FROM camp_posts WHERE id = ?', [post.id]).rows!.item(0)
        .text,
    ).toBe('one canonical edit');

    setPostDone(conn, post.id, true);
    mockFailDocFtsRebuild = true;
    expect(rebuildFtsAfterCommit(conn, 'post status')).toMatch(/indexing hiccuped/i);
    expect(
      conn.execute('SELECT done FROM camp_posts WHERE id = ?', [post.id]).rows!.item(0)
        .done,
    ).toBe(1);
    rebuildFtsIndexes(conn);
  });

  it('does not treat a manifest id prefix as board provenance', () => {
    const conn = getDb();
    const id = 'camp-board-ordinary-manifest';
    conn.execute(
      'INSERT INTO packs (id, name, description, version, enabled, builtin) VALUES (?, ?, ?, 1, 1, 0)',
      [id, 'Ordinary docs', 'not a camp board'],
    );
    conn.execute(
      "INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, 'notes.md', 'Notes', 'ordinary prefix content')",
      [id],
    );
    expect(setPackEnabled(id, false)).toBeNull();
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM doc_chunks WHERE pack_id = ?', [id])
        .rows!.item(0).n,
    ).toBe(1);
    expect(setPackEnabled(id, true)).toBeNull();
    removePack(id);
  });

  it('rematerializes cross-pack replies through disable, done, removal, and restore', () => {
    // Build Ben's beam on a scratch db and install it through the real layer.
    const scratch = new DatabaseSync(':memory:');
    const ben = {
      execute(sql: string, params: unknown[] = []) {
        const stmt = scratch.prepare(sql);
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
      ben.execute(sql);
    }
    ben.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
      CAMP_WRITER_ID_KEY,
      'bbbb2222',
    ]);
    saveCampProfile(ben, { authorName: 'Ben', passphrase: 'dusty mary' });

    const conn = getDb();
    installCampBundle(ben, exportCampBundle(conn));
    const root = listCampBoard(ben).find(p => p.text === '3 spare bike tubes')!;
    const reply = upsertCampPost(ben, {
      type: 'offer',
      text: 'azure torque wrench is beside the tubes',
      ref_id: root.id,
    });
    upsertCampPost(ben, { type: 'need', text: 'ride to Reno' });

    const campId = campIdFor('dusty mary');
    const mariaPack = listPacks().find(p => p.name.includes('(this phone)'))!.id;
    const benPack = boardPackId(campId, 'bbbb2222');
    const rootChunk = () =>
      String(
        conn.execute(
          'SELECT content FROM doc_chunks WHERE pack_id = ? AND content LIKE ?',
          [mariaPack, '%3 spare bike tubes%'],
        ).rows!.item(0).content,
      );
    const replyFtsCount = () =>
      Number(
        conn.execute(
          "SELECT COUNT(*) AS n FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'azure AND torque AND wrench'",
        ).rows!.item(0).n,
      );

    installCampBundle(conn, exportCampBundle(ben));
    rebuildFtsIndexes(conn);
    expect(rootChunk()).toContain(reply.text);
    expect(replyFtsCount()).toBeGreaterThan(0);
    expect(listPacks().find(p => p.id === benPack)!.postCount).toBe(2);

    mockFailDocFtsRebuild = true;
    expect(setPackEnabled(benPack, false)).toMatch(/indexing hiccuped/i);
    expect(rootChunk()).not.toContain(reply.text);
    // Canonical state committed; the next recovery rebuild catches FTS up.
    rebuildFtsIndexes(conn);
    expect(replyFtsCount()).toBe(0);

    expect(setPackEnabled(benPack, true)).toBeNull();
    expect(rootChunk()).toContain(reply.text);
    expect(replyFtsCount()).toBeGreaterThan(0);

    setPostDone(ben, reply.id, true);
    installCampBundle(conn, exportCampBundle(ben));
    rebuildFtsIndexes(conn);
    expect(rootChunk()).not.toContain(reply.text);
    expect(replyFtsCount()).toBe(0);

    setPostDone(ben, reply.id, false);
    installCampBundle(conn, exportCampBundle(ben));
    rebuildFtsIndexes(conn);
    expect(rootChunk()).toContain(reply.text);
    expect(replyFtsCount()).toBeGreaterThan(0);

    // Surface a same-sequence fork immediately before removal. The canonical
    // writer pack owns this conflicted copy as one replication unit.
    ben.execute(
      "UPDATE camp_posts SET text = 'forked ride to Reno' WHERE text = 'ride to Reno'",
    );
    expect(installCampBundle(conn, exportCampBundle(ben)).forks).toEqual(['Ben']);
    const benForkPack = listPacks().find(
      pack => pack.id.includes('bbbb2222-fork-'),
    )!.id;
    const benNotesPack = `camp-notes-${campId}-bbbb2222`;
    conn.execute(
      `INSERT INTO camp_notes VALUES (?, ?, ?, 'Ben', 'resource', '', '', '', '', '',
       'orphan candidate', '', '', '', '', '', '', '')`,
      ['bbbb2222:n1', campId, 'bbbb2222'],
    );
    conn.execute(
      `INSERT INTO packs (id, name, description, version, enabled, builtin)
       VALUES (?, 'Ben notes', '', 1, 1, 0)`,
      [benNotesPack],
    );
    conn.execute(
      `INSERT INTO doc_chunks (pack_id, source_file, heading, content)
       VALUES (?, 'camp-notes', '', 'orphan candidate')`,
      [benNotesPack],
    );

    mockFailDocFtsRebuild = true;
    expect(removePack(benPack)).toMatch(/indexing hiccuped/i);
    expect(listPacks().some(p => p.id === benPack)).toBe(false);
    expect(listPacks().some(p => p.id === benForkPack)).toBe(false);
    expect(listPacks().some(p => p.id === benNotesPack)).toBe(false);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM camp_notes WHERE writer_id = ?', [
        'bbbb2222',
      ]).rows!.item(0).n,
    ).toBe(0);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM camp_forks WHERE writer_id = ?', [
        'bbbb2222',
      ]).rows!.item(0).n,
    ).toBe(0);
    expect(rootChunk()).not.toContain(reply.text);
    rebuildFtsIndexes(conn);
    expect(replyFtsCount()).toBe(0);
    for (const [table, col] of [
      ['camp_posts', 'pack_id'],
      ['doc_chunks', 'pack_id'],
    ] as const) {
      const left = conn.execute(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`,
        [benPack],
      );
      expect(left.rows!.item(0).n).toBe(0);
    }
    const hw = conn.execute(
      'SELECT COUNT(*) AS n FROM camp_writers WHERE writer_id = ?',
      ['bbbb2222'],
    );
    expect(hw.rows!.item(0).n).toBe(0);
    // Gone from re-export too: the next beam carries only the own envelope.
    const removedBundle = JSON.parse(exportCampBundle(conn)) as {
      envelopes: Array<{ author_name: string }>;
    };
    expect(removedBundle.envelopes.map(e => e.author_name)).toEqual(['Maria']);

    // Removing the high-water makes a deliberate re-import a coherent restore.
    installCampBundle(conn, exportCampBundle(ben));
    rebuildFtsIndexes(conn);
    expect(listPacks().some(p => p.id === benPack)).toBe(true);
    expect(rootChunk()).toContain(reply.text);
    expect(replyFtsCount()).toBeGreaterThan(0);

    conn.execute(
      `INSERT INTO camp_notes VALUES (?, ?, ?, 'Ben', 'resource', '', '', '', '', '',
       'remove from notes surface', '', '', '', '', '', '', '')`,
      ['bbbb2222:n2', campId, 'bbbb2222'],
    );
    conn.execute(
      `INSERT INTO packs (id, name, description, version, enabled, builtin)
       VALUES (?, 'Ben notes', '', 1, 1, 0)`,
      [benNotesPack],
    );
    removePack(benNotesPack);
    expect(listPacks().some(p => p.id === benPack)).toBe(false);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM camp_writers WHERE writer_id = ?', [
        'bbbb2222',
      ]).rows!.item(0).n,
    ).toBe(0);
  });
});
