/**
 * END-TO-END retrieval tests for search_docs / lookup_facts against a REAL
 * SQLite (node:sqlite, in-memory) running the app's own DDL — porter
 * tokenizer included — with the REAL bundled survival-guide pack installed
 * through the real installer. This is the EVAL-v11-TOOLS "retrieval
 * brittleness" regression net:
 *
 *   - "moonlight" vs corpus "moon"/"moonless"  -> prefix-rescue rung
 *   - stem drift ("gifts" vs "Gifting")        -> porter tokenizer
 *   - AND under-fill                           -> fill-to-limit OR top-up
 *   - clock digits / ring letters ("7:30 & G") -> 1-char terms kept for docs
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS, SURVIVAL_GUIDE_PACK_ID } from '../src/packs/builtins';
import { docsResultJson, searchDocs } from '../src/docs/searchDocs';
import { lookupFacts } from '../src/facts/lookupFacts';

// node:sqlite ships in Node >= 22.5 with FTS5 compiled in (verified: porter
// tokenizer + external-content tables + bm25()). require() keeps tsc happy
// without needing DOM/node lib juggling in the RN tsconfig.
const { DatabaseSync } = require('node:sqlite');

/** Minimal QuickSQLiteConnection shim over node:sqlite. */
function makeConn() {
  const db = new DatabaseSync(':memory:');
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
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
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

describe('search_docs retrieval robustness (real FTS5 + real pack)', () => {
  test('v4.0 hand-audit class: "Man burn" reaches the burn-night sentence via the phrase rung', () => {
    // Before the phrase rung (2026-08-17 battery, base/p2/p3 alike):
    // lookup_facts("Man burn") returned two one-sentence Principles chunks
    // and the model never saw "Man burn: Saturday night, September 5" —
    // question #1 of the whole app, unanswerable from a corpus that holds
    // the answer. AND matched every chunk ("Burning Man" in every heading;
    // porter stems burning->burn) and bm25 length-normalization promoted the
    // shortest. Ordered adjacency is what "Burning Man" fails.
    const lf = lookupFacts({ topic: 'Man burn' }); // app limit: 2
    expect(lf.strategy).toBe('fts-phrase');
    expect(lf.results.map(r => r.content).join('\n')).toMatch(
      /Man burn: Saturday night, September 5/,
    );
    // The model's other observed phrasing for the same question.
    const lf2 = lookupFacts({ topic: 'When does the Man burn' });
    expect(lf2.results.map(r => r.content).join('\n')).toMatch(/Man burn: Saturday/);
    // Temple burn already worked (rare token) and must keep working.
    const t = lookupFacts({ topic: 'Temple burn' });
    expect(t.results.map(r => r.content).join('\n')).toMatch(/Temple burn: Sunday/);
  });

  test('phrase rung is fill-to-limit: a query the corpus never phrases still tops up from AND/OR', () => {
    // No chunk contains the adjacent phrase "greywater dump"; the phrase
    // rung contributes nothing and the AND/OR rungs answer as before.
    const lf = lookupFacts({ topic: 'greywater dump' });
    expect(lf.results.length).toBeGreaterThan(0);
    expect(['fts-and', 'fts-or']).toContain(lf.strategy);
    expect(lf.results.map(r => r.content).join('\n')).toMatch(/greywater/i);
  });

  test('EVAL moon-question shape: "moonlight" reaches the moon-conditions chunk', () => {
    const outcome = searchDocs({ query: 'moonlight' }, 3);
    expect(outcome.results.length).toBeGreaterThan(0);
    // Was 'fts-prefix' (zero-result rescue); dead-term revival now carries
    // the moon* variant into the main rungs, so the precise AND rung hits.
    expect(outcome.strategy).toBe('fts-and');
    // The chunk that answers "will there be moonlight on burn night?"
    expect(outcome.results.map(r => r.content).join('\n')).toMatch(/moonless/);
  });

  test('EVAL v13 deterministic query-trap: "moonlight burn night" ranks the moon chunk FIRST', () => {
    // The near-greedy vendor sampler emits this exact query every run. Before
    // the dead-term revival, "moonlight" matched zero chunks, fts-or ranked on
    // high-frequency burn/night alone, and the moon chunk sat at rank 4 —
    // below lookup_facts' top-2/top-3 cut — while the rescue (which ranks it
    // first) could not fire because the junk kept the rungs non-empty.
    const lf = lookupFacts({ topic: 'moonlight burn night' }); // app limit: 2
    expect(lf.strategy).toBe('fts-and');
    expect(lf.results[0].content).toMatch(/moonless/);

    const lf3 = lookupFacts({ topic: 'moonlight burn night' }, 3); // eval-harness limit
    expect(lf3.results[0].content).toMatch(/moonless/);

    const sd = searchDocs({ query: 'moonlight burn night' }, 5);
    expect(sd.results[0].content).toMatch(/moonless/);
    // Fill-to-limit still tops the remainder up from the OR rung, deduped.
    expect(sd.results.length).toBe(5);
    const ids = sd.results.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('porter stemming: "gifts" reaches the Gifting principle', () => {
    const outcome = searchDocs({ query: 'gifts' }, 3);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(['fts-and', 'fts-or']).toContain(outcome.strategy);
    expect(outcome.results.map(r => r.content).join('\n')).toMatch(/Gifting/);
  });

  test('fill-to-limit: an under-full AND rung is topped up with OR rows, deduped, AND hit first', () => {
    // "electrolyte" appears in exactly one chunk; "water" in many. Old
    // behavior returned the 1 AND row alone.
    const outcome = searchDocs({ query: 'water electrolytes' }, 5);
    expect(outcome.strategy).toBe('fts-and');
    expect(outcome.results.length).toBe(5);
    expect(outcome.results[0].content).toMatch(/[Ee]lectrolyte/);
    const ids = outcome.results.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('clock digits and ring letters survive for docs: "7:30 & G" finds the addressing chunk', () => {
    const outcome = searchDocs({ query: 'address 7:30 G' }, 3);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.map(r => r.content).join('\n')).toMatch(/7:30 & G/);
  });

  test('lookup_facts end-to-end: water question returns the real ration, pack-pinned', () => {
    const outcome = lookupFacts({ topic: 'water' });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.length).toBeLessThanOrEqual(3);
    expect(outcome.results[0].pack_id).toBe(SURVIVAL_GUIDE_PACK_ID);
    expect(outcome.results.map(r => r.content).join('\n')).toContain(
      '1.5 gallons of water per person per day',
    );
  });

  test('lookup_facts end-to-end: coffee question returns the discontinuation, not the placeholder claim', () => {
    const outcome = lookupFacts({ topic: 'coffee center camp' });
    const text = outcome.results.map(r => `${r.heading}\n${r.content}`).join('\n');
    expect(text).toContain('stopped selling coffee');
    expect(text).not.toMatch(/except ice and coffee/i);
  });

  test('EVAL-v16 v-p2 shape: "second principle" reaches Principle 2, not Fuel/Whiteout junk', () => {
    // The model's near-greedy tool query for "what's the second principle?".
    // Pre-fix (digit appended as its own term): fts-and starved, fts-or
    // returned Fuel-safety/Whiteouts/Principle-4 in all three v16 runs.
    const lf = lookupFacts({ topic: 'second principle' }); // app limit: 2
    expect(lf.strategy).toBe('fts-and');
    expect(lf.results[0].heading).toMatch(/principle 2: gifting/i);
    const lf3 = lookupFacts({ topic: 'second principle' }, 3); // harness limit
    expect(lf3.results[0].heading).toMatch(/principle 2: gifting/i);
  });

  test('ordinal variants: retrieval and payload select one pre-numbered principle', () => {
    const p8 = lookupFacts({ topic: 'eighth principle' });
    expect(p8.results[0].heading).toMatch(/principle 8: leaving no trace/i);
    const payload = JSON.parse(docsResultJson(p8));
    expect(payload.count).toBe(1);
    expect(payload.passages[0].item).toBe(
      'Principle 8 of 10: Leaving No Trace',
    );

    const p2n = lookupFacts({ topic: '2nd principle' });
    expect(p2n.results[0].heading).toMatch(/principle 2: gifting/i);
    expect(JSON.parse(docsResultJson(p2n)).passages[0].item).toBe(
      'Principle 2 of 10: Gifting',
    );
  });

  test('task-27 corpus gap closed: "who are the greeters" reaches the Greeters chunk first', () => {
    const outcome = lookupFacts({ topic: 'greeters' });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0].heading).toMatch(/greeters/i);
    // MEASURED 2026-08-24, at the guide's real 700-char budget: the Greeters
    // section is 872 chars, so it is TWO chunks (600 + 271) that share a
    // heading, and BM25's length normalization ranks the thin 271-char tail
    // first — it wins on brevity, not on merit. lookup_facts hands the model
    // its top TWO (the app's limit), and both of those chunks are Greeters
    // chunks, so the "welcome home" answer does reach the Angel. Assert the
    // app's actual contract — the answer is in what the model receives —
    // rather than a rank-0 position the app never promised. The ranking
    // artifact itself is real and tracked (orphan tails outranking their own
    // section's substance); a balanced-splitter fix was tried and REFUTED by
    // measurement — it did not fix this and it broke the Man-burn phrase
    // rung, so it was reverted rather than re-tuned.
    expect(
      outcome.results.some(r => /welcome home/i.test(r.content)),
    ).toBe(true);
    // The fuller model-shaped query lands the same chunk.
    const sd = searchDocs({ query: 'who are the greeters what do they do' }, 3);
    expect(sd.results[0].heading).toMatch(/greeters/i);
  });

  test('v4 burn.life layer: "how do I anchor my shade structure" surfaces the lag-screw chunk top-3', () => {
    // The technique layer's flagship chunk. The credit line rides in the
    // retrieved content, so attribution reaches the Angel with the answer.
    const sd = searchDocs({ query: 'how do I anchor my shade structure' }, 3);
    expect(sd.results.length).toBeGreaterThan(0);
    const hit = sd.results.find(r => /lag screw/i.test(`${r.heading}\n${r.content}`));
    expect(hit).toBeDefined();
    expect(hit!.content).toContain('Credit: [Burn.Life');

    const lf = lookupFacts({ topic: 'anchor shade structure' }, 3);
    expect(
      lf.results.some(r => /lag screw/i.test(`${r.heading}\n${r.content}`)),
    ).toBe(true);
  });

  test('a genuinely uncovered topic still returns empty (honest IDK stays possible)', () => {
    const outcome = searchDocs({ query: 'quantum blockchain webinar' }, 3);
    expect(outcome.results).toEqual([]);
    expect(outcome.strategy).toBe('none');
  });
});
