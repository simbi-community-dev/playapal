/**
 * Porter-inflection sibling retrieval, end-to-end on real FTS5 (node:sqlite)
 * with the app's own DDL — the lore-pack retrieval-gate miss #7 regression
 * net. Porter stems query and corpus independently: "greeters" -> "greeter"
 * can NEVER prefix-match corpus "greeting" -> "greet"; the prefix-rescue
 * rung only rescues the other direction (and only on zero results). The
 * sibling-root variants in the shared query builder make morphological
 * siblings meet in BOTH directions, in the MAIN rungs.
 *
 * Fixture discipline: "burning"/"burn" is deliberately high-frequency here —
 * those tests assert no recall LOSS (the right chunk is still returned),
 * never absolute rankings.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import { searchDocs } from '../src/docs/searchDocs';

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

/** id -> [heading, content]. Lore-shaped prose, one inflection per chunk. */
const CHUNKS: Record<number, [string, string]> = {
  1: [
    'Camp culture > Arrival',
    'Marina wrote about the art of greeting new arrivals at the gate: a hug, cold water, and no questions until they have had both.',
  ],
  2: [
    'Camp culture > Conclave',
    'The fire dancing performance at the conclave drew the whole neighborhood before the Man ceremony.',
  ],
  3: [
    'Camp culture > Veterans',
    'Veteran burners share their shade-structure tips during build week, one lesson per campfire.',
  ],
  4: [
    'Camp culture > The Man',
    'The burning of the Man is the peak night of the week; the camp watches together from the 9:00 keyhole.',
  ],
  5: [
    'Camp culture > Kitchen',
    'The kitchen crew posts a duty roster every morning; miss your shift and you owe the camp pancakes.',
  ],
};

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  mockConn.execute(
    "INSERT INTO packs (id, name, enabled, builtin) VALUES ('lore', 'Lore', 1, 0)",
  );
  for (const [id, [heading, content]] of Object.entries(CHUNKS)) {
    mockConn.execute(
      "INSERT INTO doc_chunks (id, pack_id, source_file, heading, content) VALUES (?, 'lore', 'lore.md', ?, ?)",
      [Number(id), heading, content],
    );
  }
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

const contents = (q: string, limit = 3) =>
  searchDocs({ query: q }, limit).results.map(r => r.content).join('\n');

describe('morphological siblings meet (lore-gate miss #7 class)', () => {
  test('greeters -> greeting: the direction porter + prefix rescue could never bridge', () => {
    expect(contents('greeters advice')).toMatch(/greeting new arrivals/);
  });

  test('greeting -> greeters-shaped corpus still works (no loss of the old direction)', () => {
    // porter already bridged query "greeting" -> corpus "greeters"
    // ("greet"* prefix-matches token "greeter"); assert it survived.
    expect(contents('greeting arrivals')).toMatch(/greeting new arrivals/);
  });

  test('dancers -> dancing', () => {
    expect(contents('dancers conclave')).toMatch(/fire dancing/);
  });

  test('burners -> its own chunk is still recalled (no recall loss on high-frequency stems)', () => {
    expect(contents('burners tips')).toMatch(/Veteran burners/);
  });

  test('burning -> the Man chunk is still recalled', () => {
    expect(contents('burning man ceremony', 5)).toMatch(/burning of the Man/);
  });

  test('burners now ALSO reaches burning prose (additive recall, rank not asserted)', () => {
    expect(contents('burners', 5)).toMatch(/burning of the Man/);
  });

  test('unrelated chunks stay out of sibling matches', () => {
    expect(contents('greeters advice')).not.toMatch(/duty roster/);
  });

  test('a genuinely absent topic still returns empty (revival never invents matches)', () => {
    const outcome = searchDocs({ query: 'submarine racing' }, 3);
    expect(outcome.results).toEqual([]);
    expect(outcome.strategy).toBe('none');
  });
});
