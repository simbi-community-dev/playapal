/**
 * Board posts must surface through the Angel's retrieval tools (doc 30 pilot
 * — the payoff demo: "anyone offering bike tubes?" answers from the beamed
 * union). Real FTS5 via node:sqlite, the REAL survival guide installed
 * beside the board packs, so ranking competition is honest: board chunks
 * must reach lookup_facts' top-2 cut with the guide's own chunks in the
 * ring. Done posts leave retrieval (the "stale/superseded rows" acceptance
 * point); replies ride inline under their item.
 */

import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS, SURVIVAL_GUIDE_PACK_ID } from '../src/packs/builtins';
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
import { searchDocs } from '../src/docs/searchDocs';
import { lookupFacts, withSpecialtyFloors } from '../src/facts/lookupFacts';
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

const rebuild = () => {
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
};

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  // The REAL survival guide — the ranking competition board posts must win.
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
  // A lore-sized distractor in miniature: many exact AND matches fill raw BM25
  // before the tiny live board. The reserved board probe must still claim one
  // of lookup_facts' two passages.
  const lore = Array.from(
    { length: 80 },
    (_, i) =>
      `## Offering bike tubes workshop ${i + 1}\n` +
      `An old thread discussed offering bike tubes during workshop ${i + 1}.`,
  ).join('\n\n');
  installPackFromFiles(mockConn as any, [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id: 'large-lore-test',
        name: 'Large Lore Test',
        description: 'synthetic ranking contention',
        version: 1,
      }),
    },
    { name: 'lore.md', content: lore },
  ]);

  // This phone (Maria) posts two offers…
  mockConn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    'aaaa1111',
  ]);
  saveCampProfile(mockConn as any, { authorName: 'Maria', passphrase: 'dusty mary' });
  upsertCampPost(mockConn as any, {
    type: 'offer',
    text: '3 spare bike tubes at the dome',
  });
  upsertCampPost(mockConn as any, { type: 'offer', text: 'sewing kit, ask for Maria' });

  // …and Ben's beamed board joins the union (import path, envelope-real),
  // carrying a need and a reply to Maria's tubes.
  const ben = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    ben.execute(sql);
  }
  ben.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    'bbbb2222',
  ]);
  saveCampProfile(ben as any, { authorName: 'Ben', passphrase: 'dusty mary' });
  installCampBundle(ben as any, exportCampBundle(mockConn as any));
  upsertCampPost(ben as any, { type: 'need', text: 'ride to Reno on Tuesday' });
  const tubes = listCampBoard(ben as any).find(p => p.text.includes('tubes'))!;
  upsertCampPost(ben as any, { type: 'need', text: 'took one tube, thanks!', ref_id: tubes.id });
  installCampBundle(mockConn as any, exportCampBundle(ben as any));

  rebuild();
});

describe('lookup_facts reaches the board (survival guide still in the ring)', () => {
  test('"offering bike tubes" reserves the board despite lore contention', () => {
    const raw = searchDocs({ query: 'offering bike tubes' }, LOOKUP_FACTS_TOP_N);
    expect(raw.results.every(r => !r.pack_id.startsWith('camp-board-'))).toBe(true);

    const outcome = lookupFacts({ topic: 'offering bike tubes' }, LOOKUP_FACTS_TOP_N);
    expect(outcome.results.length).toBeGreaterThan(0);
    const joined = outcome.results.map(r => `${r.heading}\n${r.content}`).join('\n');
    expect(joined).toMatch(/3 spare bike tubes at the dome \(Maria\)/);
    // Ben's reply rides inline under Maria's offer — the model sees the thread.
    expect(joined).toMatch(/reply: took one tube, thanks! \(Ben\)/);
  });

  test('a beamed campmate need answers too ("ride to Reno")', () => {
    const outcome = lookupFacts({ topic: 'ride to Reno' }, LOOKUP_FACTS_TOP_N);
    const joined = outcome.results.map(r => `${r.heading}\n${r.content}`).join('\n');
    expect(joined).toMatch(/need: ride to Reno on Tuesday \(Ben\)/);
    expect(joined).toContain('needs (Ben)');
  });

  test('the survival guide is still answerable (scope widened, not moved)', () => {
    const outcome = lookupFacts({ topic: 'MOOP' }, 3);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.some(r => r.pack_id === SURVIVAL_GUIDE_PACK_ID)).toBe(true);
  });
});

describe('search_docs gets the same specialty floors as lookup_facts (2026-08-17)', () => {
  // Owner phone: "Tell me the history of burning Man" -> search_docs over a
  // big lore pack returned five lore threads and the survival guide's own
  // section never surfaced. The 80-chunk synthetic lore here plays the same
  // role: every "offering bike tubes" chunk outranks the guide and the tiny
  // board on raw bm25; the floored search must still seat the board hit.
  test('unscoped: a same-tier board hit claims a slot despite lore contention', () => {
    const raw = searchDocs({ query: 'offering bike tubes' }, 5);
    expect(raw.results.every(r => !r.pack_id.startsWith('camp-board-'))).toBe(true);
    const floored = withSpecialtyFloors(raw, 'offering bike tubes', 5);
    expect(floored.results.length).toBeLessThanOrEqual(5);
    expect(floored.results.some(r => r.pack_id.startsWith('camp-board-'))).toBe(true);
    expect(floored.results.map(r => `${r.heading}\n${r.content}`).join('\n'))
      .toMatch(/3 spare bike tubes at the dome \(Maria\)/);
  });

  test('pack-scoped search is left alone (the caller asked for one pack)', () => {
    const scoped = searchDocs({ query: 'offering bike tubes', pack_id: 'large-lore-test' }, 5);
    // The executor only floors when no pack_id was given; the function itself
    // is a no-op when the merged list already carries the specialty or when
    // the specialty has no same-tier hit — asserted via lookupFacts' existing
    // tests. Here: scoped results are all from the requested pack.
    // POSITIVE CONTROL: a pack-scoped search that returns NOTHING satisfies 'every result is in the pack' vacuously — the scope filter could be dropping everything and this would still be green.
    // `[].every(...)` is `true`, so the assertion below cannot fail on an
    // empty collection — pin the length first or it proves nothing.
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(scoped.results.every(r => r.pack_id === 'large-lore-test')).toBe(true);
  });
});

describe('search_docs sees board chunks like any other enabled pack', () => {
  test('"sewing kit" finds the offers chunk with no pack pin', () => {
    const outcome = searchDocs({ query: 'sewing kit' }, 5);
    expect(
      outcome.results.some(
        r => /sewing kit, ask for Maria/.test(r.content) && /Camp board/.test(r.heading),
      ),
    ).toBe(true);
  });

  test('disabling the board pack removes it from retrieval (re-enabling restores)', () => {
    mockConn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [
      boardPackId(campIdFor('dusty mary'), 'aaaa1111'),
    ]);
    const off = searchDocs({ query: 'sewing kit' }, 5);
    expect(off.results.some(r => /sewing kit/.test(r.content))).toBe(false);
    const offFacts = lookupFacts({ topic: 'sewing kit' }, LOOKUP_FACTS_TOP_N);
    expect(offFacts.results.some(r => /sewing kit/.test(r.content))).toBe(false);
    mockConn.execute('UPDATE packs SET enabled = 1 WHERE id = ?', [
      boardPackId(campIdFor('dusty mary'), 'aaaa1111'),
    ]);
    const on = searchDocs({ query: 'sewing kit' }, 5);
    expect(on.results.some(r => /sewing kit/.test(r.content))).toBe(true);
    const onFacts = lookupFacts({ topic: 'sewing kit' }, LOOKUP_FACTS_TOP_N);
    expect(onFacts.results.some(r => /sewing kit/.test(r.content))).toBe(true);
  });

  test('a DONE post leaves retrieval after the FTS rebuild (superseded rows ignored)', () => {
    const sewing = listCampBoard(mockConn as any).find(p =>
      p.text.includes('sewing kit'),
    )!;
    setPostDone(mockConn as any, sewing.id, true);
    rebuild();
    const outcome = searchDocs({ query: 'sewing kit' }, 5);
    expect(outcome.results.some(r => /sewing kit/.test(r.content))).toBe(false);
  });
});
