/**
 * lookup_facts = search_docs over ALL enabled doc-bearing packs (the
 * lore-reachability fix — the 2.6B routes every factual question here, so
 * the executor must reach everything the phone carries) PLUS the survival
 * floor: when the merged top-N buries the guide, a same-rung-strength
 * survival hit takes the last slot. Ranking against real corpora is covered
 * by lookupFactsWidenedScope.test.ts (synthetic) and loreReachability.test.ts
 * (real lore pack); query building itself by ftsQuery.test.ts.
 */

import { lookupFacts } from '../src/facts/lookupFacts';
import { searchDocs } from '../src/docs/searchDocs';
import { SURVIVAL_GUIDE_PACK_ID } from '../src/packs/builtins';
import { CAMP_PACK_PREFIX } from '../src/camp/campBoard';
import { buildDocsFtsQuery } from '../src/events/ftsQuery';

jest.mock('../src/docs/searchDocs', () => ({
  searchDocs: jest.fn(() => ({ results: [], strategy: 'none' })),
  docsResultJson: jest.fn(() => '{}'),
}));

const mockSearch = searchDocs as jest.Mock;
const row = (pack_id: string, id: number) =>
  ({ id, pack_id, pack_name: pack_id, source_file: 'f.md', heading: 'h', content: 'c' } as any);

describe('lookupFacts scope', () => {
  beforeEach(() => jest.clearAllMocks());

  it('searches UNSCOPED (all enabled doc packs) and defaults to top 2', () => {
    lookupFacts({ topic: 'water' });
    expect(mockSearch).toHaveBeenCalledWith({ query: 'water' }, 2);
    // The old survival+camp pin must NOT come back — that pin is what made
    // the lore pack conversationally unreachable (field report 2026-08-14).
    const args = mockSearch.mock.calls[0][0];
    expect(args.pack_id).toBeUndefined();
    expect(args.pack_prefix).toBeUndefined();
  });

  it('respects an explicit limit (shrink path)', () => {
    lookupFacts({ topic: 'exodus' }, 4);
    expect(mockSearch).toHaveBeenCalledWith({ query: 'exodus' }, 4);
  });
});

describe('board and survival specialty floors', () => {
  const none = { results: [], strategy: 'none' };

  beforeEach(() => jest.clearAllMocks());

  it('does not re-probe a specialty already in the merged top-N', () => {
    mockSearch
      .mockReturnValueOnce({
        results: [row(`camp-board-camp-writer`, 1), row(SURVIVAL_GUIDE_PACK_ID, 2)],
        strategy: 'fts-and',
      });
    const out = lookupFacts({ topic: 'MOOP' });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(out.results.map(r => r.id)).toEqual([1, 2]);
  });

  it('reserves a same-strength board row when lore filled the budget', () => {
    mockSearch
      .mockReturnValueOnce({ results: [row('lore', 1), row('lore', 2)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row('camp-board-camp-writer', 8)], strategy: 'fts-and' })
      .mockReturnValueOnce(none);
    const out = lookupFacts({ topic: 'bike tubes' });
    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
      {
        query: 'bike tubes',
        pack_prefix: CAMP_PACK_PREFIX,
        revive_dead_terms: false,
      },
      1,
    );
    expect(out.results.map(r => r.id)).toEqual([1, 8]);
  });

  it('reserves a same-strength survival row when lore filled the budget', () => {
    mockSearch
      .mockReturnValueOnce({ results: [row('lore', 1), row('lore', 2)], strategy: 'fts-and' })
      .mockReturnValueOnce(none)
      .mockReturnValueOnce({ results: [row(SURVIVAL_GUIDE_PACK_ID, 9)], strategy: 'fts-and' });
    const out = lookupFacts({ topic: 'water' });
    expect(mockSearch).toHaveBeenNthCalledWith(
      3,
      {
        query: 'water',
        pack_id: SURVIVAL_GUIDE_PACK_ID,
        revive_dead_terms: false,
      },
      1,
    );
    expect(out.results.map(r => r.id)).toEqual([1, 9]);
    expect(out.strategy).toBe('fts-and');
  });

  it('keeps both specialties when both qualify inside the two-row budget', () => {
    mockSearch
      .mockReturnValueOnce({ results: [row('lore', 1), row('lore', 2)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row('camp-board-camp-writer', 8)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row(SURVIVAL_GUIDE_PACK_ID, 9)], strategy: 'fts-and' });
    const out = lookupFacts({ topic: 'water offer' });
    expect(out.results.map(r => r.id)).toEqual([8, 9]);
  });

  it('appends specialties instead of replacing when the merged list is under-full', () => {
    mockSearch
      .mockReturnValueOnce({ results: [row('lore', 1)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row('camp-board-camp-writer', 8)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row(SURVIVAL_GUIDE_PACK_ID, 9)], strategy: 'fts-and' });
    const out = lookupFacts({ topic: 'water offer' }, 3);
    expect(out.results.map(r => r.id)).toEqual([1, 8, 9]);
  });

  it('rejects specialty matches from a weaker rung', () => {
    mockSearch
      .mockReturnValueOnce({ results: [row('lore', 1), row('lore', 2)], strategy: 'fts-and' })
      .mockReturnValueOnce({ results: [row('camp-board-camp-writer', 8)], strategy: 'fts-or' })
      .mockReturnValueOnce({ results: [row(SURVIVAL_GUIDE_PACK_ID, 9)], strategy: 'fts-or' });
    const out = lookupFacts({ topic: 'Brook classic car 2010 filming' });
    expect(out.results.map(r => r.id)).toEqual([1, 2]);
  });

  it('never fires at limit 1 (floors cannot claim the only slot)', () => {
    mockSearch.mockReturnValueOnce({ results: [row('lore', 1)], strategy: 'fts-and' });
    lookupFacts({ topic: 'water' }, 1);
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('skips on an empty merged result (nothing matched anywhere, honest IDK)', () => {
    mockSearch.mockReturnValueOnce({ results: [], strategy: 'none' });
    const out = lookupFacts({ topic: 'quantum blockchain webinar' });
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([]);
  });
});

describe('the FTS query lookup_facts ultimately runs', () => {
  it('is UNSCOPED across packs but still gated on enabled packs, BM25-ranked', () => {
    const q = buildDocsFtsQuery({
      terms: ['water'],
      mode: 'and',
      limit: 2,
    });
    expect(q).not.toBeNull();
    expect(q!.sql).toContain('doc_chunks_fts MATCH ?');
    expect(q!.sql).toContain('p.enabled = 1'); // Packs-tab toggle = the scope control
    expect(q!.sql).not.toContain('d.pack_id = ?');
    expect(q!.sql).toContain('bm25(');
    expect(q!.params).toEqual(['"water"*', 2]);
  });

  it('the builders still support scoping for search_docs pack_id + the floor + camp internals', () => {
    const q = buildDocsFtsQuery({
      terms: ['water'],
      mode: 'and',
      packId: SURVIVAL_GUIDE_PACK_ID,
      packIdPrefix: CAMP_PACK_PREFIX,
      limit: 2,
    });
    expect(q!.sql).toContain("(d.pack_id = ? OR d.pack_id LIKE ? ESCAPE '\\')");
    expect(q!.params).toEqual([
      '"water"*',
      SURVIVAL_GUIDE_PACK_ID,
      'camp-board-%',
      2,
    ]);
  });
});
