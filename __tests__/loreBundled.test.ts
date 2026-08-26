import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS } from '../src/packs/builtins';
import { buildDocsFtsQuery } from '../src/events/ftsQuery';
const { DatabaseSync } = require('node:sqlite');

let mockConn: any;
jest.mock('../src/events/db', () => ({ getDb: () => mockConn, isFtsAvailable: () => true, eventDates: () => [] }));

test('the bundled lore pack installs and answers a culture question', () => {
  const db = new DatabaseSync(':memory:');
  mockConn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return { rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] } };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  };
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) mockConn.execute(sql);
  const lore = BUILTIN_PACKS.find(p => p.manifest.id === 'playa-lore')!;
  expect(lore).toBeDefined();
  const res = installPackFromFiles(mockConn, lore.files, { builtin: true });
  expect(res.chunks).toBeGreaterThan(50);
  for (const sql of REBUILD_FTS_SQL) mockConn.execute(sql);

  // Every summary must carry its creator credit — that is the licensing
  // posture, not a nicety.
  const credited = mockConn.execute(
    "SELECT COUNT(*) AS n FROM doc_chunks WHERE pack_id = 'playa-lore' AND content LIKE '%youtube.com/watch%'",
  ).rows.item(0).n;
  expect(credited).toBeGreaterThan(0);

  // The owner's own failing question class: camp culture / history.
  const q = buildDocsFtsQuery({ terms: ['temple'], limit: 5 } as any)!;
  const hits = mockConn.execute(q.sql, q.params).rows._array;
  expect(hits.length).toBeGreaterThan(0);
});
