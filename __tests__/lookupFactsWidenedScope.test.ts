/**
 * The lore-reachability fix, synthetic half: lookup_facts now searches ALL
 * enabled doc-bearing packs (survival guide + camp board + imported doc
 * packs), bm25-ranked together — because the 2.6B routes every factual
 * question to lookup_facts and never chooses search_docs unprompted
 * (field-measured 2026-08-14: 16/18 calls, lore pack 0/5 grounded).
 *
 * This suite proves the merged ranking with the REAL survival-guide pack v4
 * beside a SYNTHETIC imported memory-bank pack written in the lore pack's
 * shape (thread headings + "Name wrote on YYYY-MM-DD:" attribution, entirely
 * fictional content — the real pack is private camp data and lives only in
 * local archives; loreReachability.test.ts runs the same probes against it
 * where present). Both domains must win top-3 for their own queries, and the
 * survival controls must win within the app's top-2 cut (LOOKUP_FACTS_TOP_N).
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS, SURVIVAL_GUIDE_PACK_ID } from '../src/packs/builtins';
import { searchDocs } from '../src/docs/searchDocs';
import { lookupFacts } from '../src/facts/lookupFacts';
import { LOOKUP_FACTS_TOP_N } from '../src/llm/toolExecutor';

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

const MEMORY_BANK_ID = 'test-memory-bank';

/** Fictional camp-lore in the real pack's emitted shape. Deliberately
 * overlaps survival vocabulary (water, MOOP, shade, medical) so the merged
 * bm25 competition is honest, not a vocabulary-disjoint free win. */
const MEMORY_BANK_MD = `## The parade float · 2011 · Vera, Otto, June · May–Jun
3 messages · 2011-05-02 to 2011-06-10

Vera wrote on 2011-05-02: My uncle says we can borrow his 1963 Rambler wagon
for the parade filming this year. It still runs! We just have to wash the
playa dust out of it afterwards.

Otto wrote on 2011-05-04: The Rambler is perfect. Last year's borrowed truck
leaked oil on the street and we spent the whole morning on MOOP patrol
before the filming could even start.

June wrote on 2011-06-10: Filming wrapped. The wagon made the shot.

## Camp roster and plans · 2019 · Vera, Otto · Jul
2 messages · 2019-07-01 to 2019-07-08

Vera wrote on 2019-07-01: Final count for 2019: we are a camp of 31 this
year, two shade domes, one swamp cooler, and far too many bikes.

Otto wrote on 2019-07-08: 31 people means the water order goes up again.
I'll bump the truck order — better too much water than too little.

## The windstorm and the shade structure · 2015 · Otto, June · Sep
2 messages · 2015-09-01 to 2015-09-03

Otto wrote on 2015-09-01: The windstorm on Tuesday took the big shade
structure clean off its rebar. We chased tarps halfway to the trash fence.

June wrote on 2015-09-03: Next year we anchor the shade structure properly.
Someone at medical told me they splinted two tarp-chasing ankles that
afternoon alone.

## Ruckus — Testcamp camper

Ruckus organized the camp build and kept the volunteer roster moving.

## Ruckus and the mutant wagon · 2017 · Vera, Ruckus · Aug

Vera wrote on 2017-08-10: Ruckus repaired the mutant wagon before departure.
`;

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  const guidePack = BUILTIN_PACKS.find(p => p.manifest.id === SURVIVAL_GUIDE_PACK_ID)!;
  // INSTALL THE GUIDE THE WAY THE APP DOES: src/events/db.ts passes the
// registry's chunkMaxChars through, and the guide declares 700 (see
// GUIDE_CHUNK_MAX_CHARS). Dropping it here chunked the guide at the
// 2,000 default, so these retrieval assertions were measuring a
// chunking production does not ship — a silent divergence until the
// pack's precomputed vectors (keyed to the real 700-char chunks) made
// it fail loudly.
  installPackFromFiles(mockConn as any, guidePack.files, {
    builtin: true,
    ...(guidePack.chunkMaxChars ? { chunkMaxChars: guidePack.chunkMaxChars } : {}),
  });
  installPackFromFiles(mockConn as any, [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id: MEMORY_BANK_ID,
        name: 'Test Memory Bank',
        description: 'fictional camp lore in the lore pack shape',
        version: 1,
      }),
    },
    { name: 'lore-test.md', content: MEMORY_BANK_MD },
  ]);
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

const joined = (rs: { heading: string; content: string }[]) =>
  rs.map(r => `${r.heading}\n${r.content}`).join('\n');

describe('lookup_facts reaches an imported doc pack (the lore-reachability fix)', () => {
  test('a lore-shaped question surfaces the memory-bank chunk top-3', () => {
    const outcome = lookupFacts({ topic: 'classic wagon 2011 parade filming' }, 3);
    expect(outcome.results.length).toBeGreaterThan(0);
    const hit = outcome.results.find(r => r.pack_id === MEMORY_BANK_ID);
    expect(hit).toBeDefined();
    expect(`${hit!.heading}\n${hit!.content}`).toMatch(/1963 Rambler/);
  });

  test('a camp-history question ("camp size 2019") answers from the memory bank', () => {
    const outcome = lookupFacts({ topic: 'camp size 2019' }, 3);
    const lore = outcome.results.filter(r => r.pack_id === MEMORY_BANK_ID);
    expect(lore.length).toBeGreaterThan(0);
    expect(joined(lore)).toMatch(/camp of 31/);
  });

  test('disabling the imported pack removes it (Packs tab = the scope control now)', () => {
    mockConn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [MEMORY_BANK_ID]);
    const off = lookupFacts({ topic: 'classic wagon 2011 parade filming' }, 3);
    expect(off.results.some(r => r.pack_id === MEMORY_BANK_ID)).toBe(false);
    mockConn.execute('UPDATE packs SET enabled = 1 WHERE id = ?', [MEMORY_BANK_ID]);
    const on = lookupFacts({ topic: 'classic wagon 2011 parade filming' }, 3);
    expect(on.results.some(r => r.pack_id === MEMORY_BANK_ID)).toBe(true);
  });

  test('a revived survival substring cannot evict a legitimate Ruckus result', () => {
    const revived = searchDocs(
      { query: 'Ruckus', pack_id: SURVIVAL_GUIDE_PACK_ID },
      1,
    );
    expect(['fts-and', 'like-and']).toContain(revived.strategy);
    expect(joined(revived.results)).toMatch(/truck/i);

    const plain = searchDocs(
      {
        query: 'Ruckus',
        pack_id: SURVIVAL_GUIDE_PACK_ID,
        revive_dead_terms: false,
      },
      1,
    );
    expect(['fts-prefix', 'like-prefix', 'none']).toContain(plain.strategy);

    const outcome = lookupFacts({ topic: 'Ruckus' }, 2);
    expect(outcome.strategy).toBe('fts-and');
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every(r => r.pack_id === MEMORY_BANK_ID)).toBe(true);
    expect(joined(outcome.results)).toMatch(/Ruckus/);
  });
});

describe('survival probes still win their own queries with lore in the ring (r6-era set)', () => {
  test('water: the real ration stays inside the app top-2 cut', () => {
    const outcome = lookupFacts({ topic: 'water' }, LOOKUP_FACTS_TOP_N);
    expect(joined(outcome.results)).toContain('1.5 gallons of water per person per day');
    expect(outcome.results[0].pack_id).toBe(SURVIVAL_GUIDE_PACK_ID);
  });

  test('MOOP: the guide definition beats the lore mentions, top-2', () => {
    const outcome = lookupFacts({ topic: 'MOOP' }, LOOKUP_FACTS_TOP_N);
    expect(joined(outcome.results)).toMatch(/Matter Out of Place/i);
    expect(outcome.results[0].pack_id).toBe(SURVIVAL_GUIDE_PACK_ID);
  });

  test('medical: stations/addresses answer from the guide, top-2', () => {
    const outcome = lookupFacts({ topic: 'medical' }, LOOKUP_FACTS_TOP_N);
    expect(outcome.results[0].pack_id).toBe(SURVIVAL_GUIDE_PACK_ID);
    expect(joined(outcome.results)).toMatch(/medical/i);
  });

  test('v4 burn.life anchor technique wins over lore shade-lore, credit line intact', () => {
    const outcome = lookupFacts({ topic: 'anchor shade structure' }, 3);
    const lag = outcome.results.find(r => /lag screw/i.test(`${r.heading}\n${r.content}`));
    expect(lag).toBeDefined();
    expect(lag!.pack_id).toBe(SURVIVAL_GUIDE_PACK_ID);
    expect(lag!.content).toContain('Credit: [Burn.Life');
  });
});

describe('search_docs is unchanged (already spanned packs)', () => {
  test('unscoped search reaches both packs; pack_id restriction still narrows', () => {
    const all = searchDocs({ query: 'shade structure' }, 5);
    const packs = new Set(all.results.map(r => r.pack_id));
    expect(packs.has(SURVIVAL_GUIDE_PACK_ID)).toBe(true);
    expect(packs.has(MEMORY_BANK_ID)).toBe(true);
    const pinned = searchDocs({ query: 'shade structure', pack_id: MEMORY_BANK_ID }, 5);
    // POSITIVE CONTROL: an empty pinned result set passes 'every row is from the memory bank' without a single row ever having come from it.
    // `[].every(...)` is `true`, so the assertion below cannot fail on an
    // empty collection — pin the length first or it proves nothing.
    expect(pinned.results.length).toBeGreaterThan(0);
    expect(pinned.results.every(r => r.pack_id === MEMORY_BANK_ID)).toBe(true);
  });
});
