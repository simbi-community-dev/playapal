/**
 * Unit tests for the deterministic FTS5/LIKE query builders behind
 * search_events. Pure string work — no SQLite needed on the dev box.
 */

import {
  sanitizeKeywords,
  shrinkTerms,
  siblingRoot,
  termVariants,
  parseOrdinalTerm,
  buildFtsMatch,
  buildFtsQuery,
  buildLikeQuery,
  buildDocsFtsQuery,
  buildDocsFtsCountQuery,
  buildDocsLikeQuery,
  buildDocsScopeCountQuery,
  escapeLike,
  TOP_N,
} from '../src/events/ftsQuery';

describe('sanitizeKeywords', () => {
  test('keeps clean keywords, lowercased', () => {
    expect(sanitizeKeywords('Sunrise Yoga')).toEqual(['sunrise', 'yoga']);
  });

  test('drops question scaffolding and stopwords', () => {
    expect(sanitizeKeywords('what is happening at the trash fence')).toEqual([
      'trash',
      'fence',
    ]);
  });

  test('drops day words — the time parser owns the day axis', () => {
    expect(sanitizeKeywords('pancake breakfast Tuesday')).toEqual([
      'pancake',
      'breakfast',
    ]);
    expect(sanitizeKeywords('welding tomorrow')).toEqual(['welding']);
  });

  test('neutralizes FTS5 operators and SQL-ish junk', () => {
    expect(sanitizeKeywords('yoga" OR 1=1 --')).toEqual(['yoga']);
    expect(sanitizeKeywords('NEAR(pancake) AND NOT breakfast*')).toEqual([
      'pancake',
      'breakfast',
    ]);
    expect(sanitizeKeywords('"quoted phrase" ^caret :colon')).toEqual([
      'quoted',
      'phrase',
      'caret',
      'colon',
    ]);
  });

  test('keeps apostrophes inside words', () => {
    expect(sanitizeKeywords("burner's bike repair")).toEqual([
      "burner's",
      'bike',
      'repair',
    ]);
  });

  test('dedupes and caps at 6 terms', () => {
    expect(sanitizeKeywords('yoga yoga YOGA')).toEqual(['yoga']);
    expect(
      sanitizeKeywords('one two three four five six seven eight'),
    ).toHaveLength(6);
  });

  test('drops single characters and empty input', () => {
    expect(sanitizeKeywords('x y z fire')).toEqual(['fire']);
    expect(sanitizeKeywords('')).toEqual([]);
    expect(sanitizeKeywords('   ')).toEqual([]);
  });

  test('keepSingleChars keeps ring letters and clock digits (docs queries)', () => {
    expect(sanitizeKeywords('corner of 7:30 and G', { keepSingleChars: true })).toEqual([
      'corner',
      '7',
      '30',
      'g',
    ]);
    // Stopwords still drop even at 1-char tolerance ("a" is a stopword).
    expect(sanitizeKeywords('a G street', { keepSingleChars: true })).toEqual([
      'g',
      'street',
    ]);
  });
});

describe('shrinkTerms (prefix-rescue rung)', () => {
  test('shortens long terms to 4-char prefixes ("moonlight" -> "moon")', () => {
    expect(shrinkTerms(['moonlight'])).toEqual(['moon']);
    expect(shrinkTerms(['moonlight', 'moop'])).toEqual(['moon', 'moop']);
  });

  test('returns null when nothing shrinks (callers skip the rung)', () => {
    expect(shrinkTerms(['moop'])).toBeNull();
    expect(shrinkTerms(['ice', 'gate'])).toBeNull();
    expect(shrinkTerms([])).toBeNull();
  });

  test('dedupes collapsed prefixes', () => {
    expect(shrinkTerms(['moonlight', 'moonless'])).toEqual(['moon']);
  });
});

describe('siblingRoot / termVariants (porter inflection fix)', () => {
  test('derivational suffixes strip to the shared root the porter stems miss', () => {
    // The lore-gate miss: "greeters" stems to "greeter", which can never
    // prefix-match corpus "greeting" (token "greet"). The root bridges them.
    expect(siblingRoot('greeters')).toBe('greet');
    expect(siblingRoot('greeting')).toBe('greet');
    expect(siblingRoot('dancers')).toBe('danc');
    expect(siblingRoot('dancing')).toBe('danc');
    expect(siblingRoot('burners')).toBe('burn');
    expect(siblingRoot('burning')).toBe('burn');
    expect(siblingRoot('welding')).toBe('weld');
  });

  test('roots under 4 chars are dropped as too promiscuous', () => {
    expect(siblingRoot('water')).toBeNull(); // "wat"
    expect(siblingRoot('doers')).toBeNull(); // "do"
  });

  test('terms without a listed suffix pass through untouched', () => {
    expect(siblingRoot('yoga')).toBeNull();
    expect(siblingRoot('moop')).toBeNull();
    expect(siblingRoot('moonlight')).toBeNull(); // compounds are the revival path
    expect(termVariants('yoga')).toEqual(['yoga']);
    expect(termVariants('greeters')).toEqual(['greeters', 'greet']);
  });
});

describe('buildFtsMatch', () => {
  it('phrase mode = one ordered adjacent phrase, no prefix, no variants', () => {
    // The rung that exists because AND("man"*,"burn"*) matches every chunk
    // whose heading says "Burning Man" (porter: burning -> burn). Order
    // matters: the phrase "man burn" must NOT be satisfied by "Burning Man".
    expect(buildFtsMatch(['man', 'burn'], 'phrase')).toBe('"man burn"');
    // Sibling variants and ordinal digits are AND/OR-rung machinery; a
    // phrase carries the terms exactly as the model typed them.
    expect(buildFtsMatch(['greeters', 'station'], 'phrase')).toBe('"greeters station"');
    expect(buildFtsMatch([], 'phrase')).toBeNull();
  });
  test('AND mode quotes every term with prefix search', () => {
    expect(buildFtsMatch(['sunrise', 'yoga'], 'and')).toBe('"sunrise"* AND "yoga"*');
  });

  test('OR mode', () => {
    expect(buildFtsMatch(['sunrise', 'yoga'], 'or')).toBe('"sunrise"* OR "yoga"*');
  });

  test('a term with a sibling root becomes an OR-group; AND stays per-concept', () => {
    expect(buildFtsMatch(['greeters', 'advice'], 'and')).toBe(
      '("greeters"* OR "greet"*) AND "advice"*',
    );
  });

  test('custom expand replaces the default sibling expansion', () => {
    expect(buildFtsMatch(['greeters'], 'and', t => [t])).toBe('"greeters"*');
    expect(buildFtsMatch(['moonlight'], 'or', t => [t, 'moon'])).toBe(
      '("moonlight"* OR "moon"*)',
    );
  });

  test('prefix policy can keep one saturated alternative exact', () => {
    expect(
      buildFtsMatch(
        ['testcamp', 'bus'],
        'and',
        t => [t],
        (_term, variant) => variant !== 'bus',
      ),
    ).toBe('"testcamp"* AND "bus"');
  });

  test('empty terms yield null', () => {
    expect(buildFtsMatch([], 'and')).toBeNull();
  });
});

describe('buildFtsQuery', () => {
  test('joins the FTS table to events and ranks by BM25', () => {
    const q = buildFtsQuery({ terms: ['welding'], mode: 'and' });
    expect(q).not.toBeNull();
    expect(q!.sql).toContain('JOIN events_fts f ON f.rowid = e.id');
    expect(q!.sql).toContain('MATCH ?');
    expect(q!.sql).toContain('ORDER BY (lower(e.title) = ?) DESC, bm25(f.events_fts');
    // "welding" carries its sibling root so corpus "welder(s)"/"welded" meet it.
    expect(q!.params).toEqual(['("welding"* OR "weld"*)', 'welding', TOP_N]);
  });

  test('searches only enabled data packs', () => {
    const q = buildFtsQuery({ terms: ['welding'], mode: 'and' });
    expect(q!.sql).toContain('JOIN packs p ON p.id = e.pack_id AND p.enabled = 1');
  });

  test('date range adds BETWEEN with start/end params in order', () => {
    const q = buildFtsQuery({
      terms: ['yoga'],
      mode: 'or',
      dateRange: { startDate: '2026-09-01', endDate: '2026-09-02' },
    });
    expect(q!.sql).toContain('e.date BETWEEN ? AND ?');
    expect(q!.params).toEqual(['"yoga"*', '2026-09-01', '2026-09-02', 'yoga', TOP_N]);
  });

  test('custom limit is honored', () => {
    const q = buildFtsQuery({ terms: ['art'], mode: 'and', limit: 3 });
    expect(q!.params[q!.params.length - 1]).toBe(3);
  });

  test('no terms yields null (caller skips the query)', () => {
    expect(buildFtsQuery({ terms: [], mode: 'and' })).toBeNull();
  });
});

describe('escapeLike', () => {
  test('escapes %, _ and backslash', () => {
    expect(escapeLike('50%_x')).toBe('50\\%\\_x');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('buildLikeQuery', () => {
  test('each term gets a 4-column OR group; groups joined by AND', () => {
    const q = buildLikeQuery({ terms: ['bike', 'repair'], mode: 'and' });
    expect(q).not.toBeNull();
    // 2 terms x 4 columns + limit
    expect(q!.params).toHaveLength(9);
    expect(q!.params[0]).toBe('%bike%');
    expect(q!.params[4]).toBe('%repair%');
    expect(q!.sql).toContain(") AND (");
    expect(q!.sql.match(/LIKE \? ESCAPE '\\'/g)).toHaveLength(8);
    expect(q!.sql).toContain('ORDER BY e.date, e.time_start');
  });

  test('OR mode joins groups with OR', () => {
    const q = buildLikeQuery({ terms: ['bike', 'repair'], mode: 'or' });
    expect(q!.sql).toContain(') OR (');
  });

  test('date range appends two params before the limit', () => {
    const q = buildLikeQuery({
      terms: ['yoga'],
      mode: 'and',
      dateRange: { startDate: '2026-09-01', endDate: '2026-09-01' },
    });
    expect(q!.params).toEqual([
      '%yoga%',
      '%yoga%',
      '%yoga%',
      '%yoga%',
      '2026-09-01',
      '2026-09-01',
      TOP_N,
    ]);
  });

  test('wildcards inside a term are escaped', () => {
    const q = buildLikeQuery({ terms: ['100%'], mode: 'and' });
    expect(q!.params[0]).toBe('%100\\%%');
  });

  test('no terms yields null', () => {
    expect(buildLikeQuery({ terms: [], mode: 'and' })).toBeNull();
  });

  test('searches only enabled data packs', () => {
    const q = buildLikeQuery({ terms: ['bike'], mode: 'and' });
    expect(q!.sql).toContain('JOIN packs p ON p.id = e.pack_id AND p.enabled = 1');
  });
});

describe('buildDocsFtsQuery (freeform pack chunks)', () => {
  test('joins chunks FTS to doc_chunks and enabled packs, ranks by BM25', () => {
    const q = buildDocsFtsQuery({ terms: ['moop'], mode: 'and' });
    expect(q).not.toBeNull();
    expect(q!.sql).toContain('JOIN doc_chunks_fts f ON f.rowid = d.id');
    expect(q!.sql).toContain('JOIN packs p ON p.id = d.pack_id AND p.enabled = 1');
    expect(q!.sql).toContain('ORDER BY bm25(f.doc_chunks_fts');
    expect(q!.sql).toContain('pack_name');
    expect(q!.params).toEqual(['"moop"*', TOP_N]);
  });

  test('optional pack_id restricts the search (lookup_facts pattern)', () => {
    const q = buildDocsFtsQuery({
      terms: ['water'],
      mode: 'or',
      packId: 'survival-guide',
      limit: 2,
    });
    expect(q!.sql).toContain('AND d.pack_id = ?');
    expect(q!.params).toEqual(['"water"*', 'survival-guide', 2]);
  });

  test('count probes preserve enabled-pack and optional scope semantics', () => {
    const scope = buildDocsScopeCountQuery({ packIdPrefix: 'camp-board-' });
    expect(scope.sql).toContain('p.enabled = 1');
    expect(scope.sql).toContain("d.pack_id LIKE ? ESCAPE '\\'");
    expect(scope.params).toEqual(['camp-board-%']);

    const exact = buildDocsFtsCountQuery({
      terms: ['bus'],
      mode: 'or',
      packId: 'testcamp-lore',
      prefix: () => false,
    });
    expect(exact!.sql).toContain('COUNT(*) AS count');
    expect(exact!.sql).toContain('p.enabled = 1');
    expect(exact!.params).toEqual(['"bus"', 'testcamp-lore']);
  });

  test('no terms yields null', () => {
    expect(buildDocsFtsQuery({ terms: [], mode: 'and' })).toBeNull();
  });
});

describe('buildDocsLikeQuery', () => {
  test('two LIKE params per term (heading + content), enabled packs only', () => {
    const q = buildDocsLikeQuery({ terms: ['exodus', 'pulse'], mode: 'and' });
    expect(q!.sql).toContain('JOIN packs p ON p.id = d.pack_id AND p.enabled = 1');
    // 2 terms x 2 columns + limit
    expect(q!.params).toEqual(['%exodus%', '%exodus%', '%pulse%', '%pulse%', TOP_N]);
    expect(q!.sql).toContain(') AND (');
  });

  test('pack_id param lands between LIKE params and the limit', () => {
    const q = buildDocsLikeQuery({ terms: ['ice'], mode: 'or', packId: 'survival-guide' });
    expect(q!.params).toEqual(['%ice%', '%ice%', 'survival-guide', TOP_N]);
  });

  test('sibling-root variants widen the LIKE group too (FTS-unavailable parity)', () => {
    const q = buildDocsLikeQuery({ terms: ['greeters'], mode: 'and' });
    // 2 variants x 2 columns + limit; the group is one parenthesized OR.
    expect(q!.params).toEqual(['%greeters%', '%greeters%', '%greet%', '%greet%', TOP_N]);
    expect(q!.sql.match(/LIKE \? ESCAPE '\\'/g)).toHaveLength(4);
  });
});

describe('ordinal digits as term VARIANTS (EVAL-v16 v-p2: appended digits starved the AND rung)', () => {
  // c25fb12 appended the digit as its own term; "second principle" then
  // required "second"* in AND mode (no chunk spells ordinals -> starve),
  // and the OR fallback let BM25 rank rare-term junk (Fuel/Whiteout
  // "seconds") over "Principle 2: Gifting" while the appended "2"* was
  // IDF-diluted by the corpus-wide "[2026-confirmed]" tags. Deterministic
  // 0/3 in all three v16 runs. As a VARIANT, the digit rides inside the
  // word's own concept group and the precise AND rung fires.
  test('sanitizeKeywords no longer appends digits as standalone terms', () => {
    expect(sanitizeKeywords('the eighth principle')).toEqual(['eighth', 'principle']);
    expect(sanitizeKeywords('what is the second principle')).toEqual([
      'second',
      'principle',
    ]);
  });
  test('ordinal words carry their digit as an OR-variant', () => {
    expect(termVariants('eighth')).toEqual(['eighth', '8']);
    expect(termVariants('tenth')).toEqual(['tenth', '10']);
    expect(termVariants('second')).toEqual(['second', '2']);
  });
  test('numeral ordinals ("2nd") map too — they match nothing by themselves', () => {
    expect(termVariants('2nd')).toEqual(['2nd', '2']);
    expect(termVariants('10th')).toEqual(['10th', '10']);
  });
  test('ordinal parser shares the variant map but rejects the list-size cardinal', () => {
    expect(parseOrdinalTerm('eighth')).toBe(8);
    expect(parseOrdinalTerm('2nd')).toBe(2);
    expect(parseOrdinalTerm('ten')).toBeNull();
    expect(parseOrdinalTerm('water')).toBeNull();
  });
  test('the v-p2 AND shape: ("second"* OR "2"*) AND "principle"*', () => {
    expect(buildFtsMatch(['second', 'principle'], 'and')).toBe(
      '("second"* OR "2"*) AND "principle"*',
    );
    expect(buildFtsMatch(['eighth', 'principle'], 'and')).toBe(
      '("eighth"* OR "8"*) AND "principle"*',
    );
  });
  test('non-ordinal queries are unchanged', () => {
    expect(sanitizeKeywords('water per person')).toEqual(['water', 'per', 'person']);
    expect(termVariants('yoga')).toEqual(['yoga']);
  });
});

describe('leading discourse-marker strip (v18 harness mirror — the ceremonial-topic class)', () => {
  test('politeness prefix dies, content survives (MIX-V18 probe 1)', () => {
    // Delta from the v18 harness mirror: 'much' now dies as a stopword too
    // (quantifier half of the question shell — lore-reachability round; it
    // starved the survival floor's fts-and on "how much water per person").
    // Mirror to the eval-harness port when re-syncing.
    expect(sanitizeKeywords('thanks! one more thing — how much water per person'))
      .toEqual(['water', 'per', 'person']);
  });
  test('stacked markers strip repeatedly, trailing markers survive (probe 2)', () => {
    expect(sanitizeKeywords('okay noted, now who are the greeters anyway'))
      .toEqual(['now', 'greeters', 'anyway']);
  });
  test('unchanged queries unaffected (probe 3; digits ride termVariants now)', () => {
    expect(sanitizeKeywords('second principle')).toEqual(['second', 'principle']);
  });
  test('mid-sentence markers keep their signal', () => {
    expect(sanitizeKeywords('water and also ice')).toEqual(['water', 'also', 'ice']);
  });
});


describe('cardinal "ten" maps (EVAL-v18 flake: "second ten principles" defeated the map)', () => {
  test('ten expands to 10 as an OR-variant', () => {
    expect(termVariants('ten')).toContain('10');
  });
});
