/**
 * The identity rung (about-pin): a pack cannot win BM25 for its own name
 * (the name saturates its chunks — measured on-device: "dusty star" in
 * 4,697 of 8,240 chunks, About card one slot outside the top-2 cut), so
 * identity-shaped queries answer from the pack's about-* chunks directly.
 * Same real-SQLite fixture as searchDocsRetrieval.test.ts.
 */

import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { searchDocs, shouldUseFtsPrefix } from '../src/docs/searchDocs';
import { lookupFacts } from '../src/facts/lookupFacts';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...params);
      return { rows: undefined };
    },
  };
}

let mockConn: ReturnType<typeof makeConn>;

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  isFtsAvailable: () => true,
}));

const SATURATED_LORE = `# Lore

${Array.from(
  { length: 24 },
  (_, i) =>
    `## Testcamp build note ${i + 1}\n\nTestcamp burners built a busy structure in year ${
      2000 + i
    }.`,
).join('\n\n')}

## Testcamp bus adventures

The Testcamp bus ran to the burn in 2012.

## Testcamp shift sheet

Sign up for Testcamp shifts, via Testcamp.
`;

const CAMP_PACK = [
  {
    name: 'pack.json',
    content: JSON.stringify({
      id: 'testcamp-lore',
      name: 'Testcamp Memory Bank',
      description: 'test',
      version: 1,
    }),
  },
  {
    name: 'about-testcamp.md',
    content:
      '# Testcamp\n\n## What is Testcamp?\n\nTestcamp is a Burning Man theme camp serving pancakes.\n',
  },
  { name: 'lore.md', content: SATURATED_LORE },
];

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  installPackFromFiles(mockConn as any, CAMP_PACK as any, {});
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

test('bare pack-name query answers from about chunks (about-pin)', () => {
  const out = searchDocs({ query: 'testcamp' }, 2);
  expect(out.strategy).toBe('about-pin');
  expect(out.results[0].source_file).toBe('about-testcamp.md');
});

test('identity extras keep the identity shape ("the camp testcamp")', () => {
  const out = searchDocs({ query: 'camp testcamp' }, 2);
  expect(out.strategy).toBe('about-pin');
});

test('a saturated porter prefix stays exact, so bus beats install-order build notes', () => {
  const out = searchDocs({ query: 'testcamp bus' }, 2);
  // The phrase rung (2026-08-17) now answers this adjacent pair outright;
  // either precise rung is the point — the saturated "bus" prefix must not
  // flatten bm25 into install order.
  expect(['fts-phrase', 'fts-and']).toContain(out.strategy);
  expect(out.results[0].heading).toContain('bus');
  expect(out.results[0].source_file).toBe('lore.md');
});

test('the saturation threshold is strict and exact breadth can retain a prefix', () => {
  expect(shouldUseFtsPrefix(100, 50, 0)).toBe(true);
  expect(shouldUseFtsPrefix(100, 51, 25)).toBe(false);
  expect(shouldUseFtsPrefix(100, 51, 26)).toBe(true);
});

test('lookup_facts inherits the pin for identity topics', () => {
  const out = lookupFacts({ topic: 'testcamp' });
  expect(out.strategy).toBe('about-pin');
  expect(out.results[0].source_file).toBe('about-testcamp.md');
});

test('a disabled pack neither pins nor contributes to prefix probes', () => {
  mockConn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', ['testcamp-lore']);
  expect(searchDocs({ query: 'testcamp' }, 2).strategy).not.toBe('about-pin');
  expect(searchDocs({ query: 'testcamp bus' }, 2).results).toEqual([]);
  mockConn.execute('UPDATE packs SET enabled = 1 WHERE id = ?', ['testcamp-lore']);
});
