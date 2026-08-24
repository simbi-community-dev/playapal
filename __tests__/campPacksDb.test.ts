/**
 * The db layer's board composition: the REAL src/events/db.ts (schema init +
 * builtin seeding + FTS probe) over a node:sqlite shim — listPacks post
 * counts, the own-board-pack removal guard, and removePack's cascade
 * (posts + high-water/envelope row) for beamed packs.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';

const { DatabaseSync } = require('node:sqlite');

const mockRealDb = new DatabaseSync(':memory:');

// The storage-engine seam (quick-sqlite → op-sqlite migration): db.ts opens
// through src/events/engine, so the test engine mocks THE SEAM — same
// node:sqlite backing, same conn.execute shape, no native module needed.
jest.mock('../src/events/engine', () => ({
  openAppDb: () => ({
    execute: (sql: string, params: unknown[] = []) => {
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

import { getDb, listPacks, removePack, rebuildFtsIndexes } from '../src/events/db';
import {
  CAMP_WRITER_ID_KEY,
  boardPackId,
  campIdFor,
  exportCampBundle,
  installCampBundle,
  saveCampProfile,
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

  it("refuses to remove this phone's own board pack, with a friendly message", () => {
    const own = listPacks().find(p => p.id.startsWith('camp-board-'))!;
    expect(() => removePack(own.id)).toThrow(/Camp tab/);
    expect(listPacks().some(p => p.id === own.id)).toBe(true);
  });

  it('removes a BEAMED board pack fully: packs row, posts, chunks, and the writer high-water', () => {
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
    upsertCampPost(ben, { type: 'need', text: 'ride to Reno' });

    const benPack = boardPackId(campIdFor('dusty mary'), 'bbbb2222');
    const conn = getDb();
    installCampBundle(conn, exportCampBundle(ben));
    rebuildFtsIndexes(conn);
    expect(listPacks().find(p => p.id === benPack)!.postCount).toBe(1);

    removePack(benPack);
    expect(listPacks().some(p => p.id === benPack)).toBe(false);
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
    const bundle = JSON.parse(exportCampBundle(conn));
    expect(bundle.envelopes.map((e: any) => e.author_name)).toEqual(['Maria']);
  });
});
