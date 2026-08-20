/**
 * Deterministic SQL builders for the search_events and search_docs tools.
 *
 * The model supplies KEYWORDS ONLY (prototype: "query strings: reliably
 * good"). Everything here is pure string/array work so it can be unit-tested
 * on the dev box without SQLite or a device. All queries are scoped to
 * ENABLED data packs via a join on the packs table.
 *
 * Strategy ladder (executed in searchEvents.ts):
 *   1. FTS5 MATCH, all terms AND     (precise)
 *   2. FTS5 MATCH, terms OR          (recall)
 *   3. LIKE, all terms AND           (FTS5 unavailable / MATCH error)
 *   4. LIKE, terms OR
 * Results are capped at TOP_N and, for FTS, ranked by BM25.
 */

import { EVENTS_NOT_HIDDEN_SQL } from '../facts/hiddenItems';

export const TOP_N = 5;

/** Columns indexed by the FTS table / searched by the LIKE fallback. */
export const SEARCH_COLUMNS = ['title', 'desc', 'camp', 'location'] as const;

// Words that carry no lookup signal. Deliberately includes day-words: the day
// axis is handled by the app-side time parser, never by keyword match.
/** Ordinals → digits, carried as per-term OR-VARIANTS (termVariants) so the
 * precise AND rung still fires: "second principle" builds
 * ("second"* OR "2"*) AND "principle"*, which the corpus heading
 * "Principle 2: Gifting" satisfies. The c25fb12 shape (digit APPENDED as its
 * own term) starved the AND rung — no chunk spells "second" — and the OR
 * fallback let BM25 rank rare-term junk ("seconds" in Fuel/Whiteout chunks)
 * over the principle, while the appended "2"* was IDF-diluted to noise by
 * the ubiquitous "[2026-confirmed]" tags (EVAL-v16 v-p2, 0/3 deterministic;
 * grader-confirmed junk pattern across all three runs). Numeral forms
 * ("2nd") are in the map too — they match nothing in the corpus by
 * themselves. Ordinals only — cardinals ("one", "second"-as-time) are too
 * ambiguous to map safely. */
const ORDINAL_WORDS: Record<string, string> = {
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5',
  '6th': '6', '7th': '7', '8th': '8', '9th': '9', '10th': '10',
  // Spelled cardinals that name canonical lists ("the ten principles"):
  // "ten" is unambiguous on-playa; smaller cardinals stay unmapped (EVAL-v18
  // flake: "second ten principles" defeated the map and invented a principle).
  ten: '10',
};

/** Parse an ordinal query term into its 1-based position. The cardinal "ten"
 * remains a retrieval variant for list names but is not itself an ordinal. */
export function parseOrdinalTerm(term: string): number | null {
  if (term === 'ten') {
    return null;
  }
  const digit = ORDINAL_WORDS[term.toLowerCase()];
  return digit ? Number(digit) : null;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'being',
  // 'much'/'many' = the quantifier half of the question shell ("how much
  // water per person") — kept terms starved fts-and for chunks that answer
  // in amounts, not quantifier words (lore-reachability round, 2026-08-14).
  'any', 'some', 'what', 'whats', 'when', 'where', 'who', 'which', 'how',
  'much', 'many',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'there',
  'do', 'does', 'can', 'could', 'will', 'would', 'should',
  'at', 'on', 'in', 'to', 'for', 'of', 'with', 'near', 'around', 'about',
  'and', 'or', 'not',
  'event', 'events', 'happening', 'going', 'scheduled', 'stuff', 'things',
  'today', 'tonight', 'tomorrow', 'tmrw', 'week',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
]);

/**
 * Turn a raw model-supplied query string into clean lowercase keyword terms.
 * Strips FTS5 operators/punctuation (quotes, *, ^, :, parens, NEAR/AND/OR/NOT
 * are neutralized by quoting anyway, but we drop the bare operator words as
 * stopwords), drops stopwords and 1-char fragments, dedupes, caps at 6 terms.
 *
 * `keepSingleChars` keeps 1-char alphanumeric terms — the DOCS path uses it
 * because ring letters ("G") and clock digits ("7") carry real signal there
 * (EVAL-v11-TOOLS: addressing queries died in this filter). Events queries
 * keep the strict filter.
 */
/** Leading discourse-marker phrases, stripped repeatedly (longest-match
 * first) BEFORE tokenizing. Byte-for-byte mirror of the v18 harness list
 * (MIX-V18.md): a natural "thanks! one more thing — how much water" must
 * yield water keywords, not politeness fragments — junk topics retrieve
 * junk passages (the ceremonial-tool-call class, EVAL-v17). Leading-only:
 * mid-sentence "also"/"now" carry real signal and are untouched. */
const DISCOURSE_MARKERS = [
  'thanks so much', 'thanks a lot', 'thank you', 'that makes sense',
  'sounds good', 'good to know', 'one more thing', 'one more',
  'real quick', 'quick question', 'by the way',
  'thanks', 'thank', 'thx', 'okay', 'ok', 'noted', 'makes sense',
  'got it', 'gotcha', 'cool', 'nice', 'sweet', 'awesome', 'great',
  'perfect', 'alright', 'btw', 'also', 'oh', 'ohh', 'hmm', 'yeah',
  'yep', 'sure', 'anyway',
];

/** Strip leading discourse markers (and any punctuation between them). */
export function stripDiscourseMarkers(raw: string): string {
  let s = raw;
  let changed = true;
  while (changed) {
    changed = false;
    const t = s.replace(/^[\s,.!?;:—–-]+/, '');
    if (t !== s) {
      s = t;
      changed = true;
    }
    const lower = s.toLowerCase();
    for (const m of DISCOURSE_MARKERS) {
      if (
        lower.startsWith(m) &&
        (s.length === m.length || !/[a-z0-9']/i.test(s[m.length]))
      ) {
        s = s.slice(m.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

export function sanitizeKeywords(
  raw: string,
  opts?: { keepSingleChars?: boolean },
): string[] {
  if (!raw) {
    return [];
  }
  raw = stripDiscourseMarkers(raw);
  const minLen = opts?.keepSingleChars ? 1 : 2;
  const terms = raw
    .toLowerCase()
    // Keep letters, digits, and apostrophes inside words; everything else is a separator.
    .replace(/[^a-z0-9']+/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^'+|'+$/g, ''))
    .filter(t => t.length >= minLen && !STOPWORDS.has(t));
  return [...new Set(terms)].slice(0, 6);
}

/**
 * Shorten every term longer than `len` to its first `len` chars, for a
 * last-resort prefix-search rung: "moonlight" -> "moon"* reaches corpus
 * "moon"/"moonless", which neither stemming nor OR mode can (verified —
 * porter keeps "moonlight" whole). Returns null when nothing shrinks, so
 * callers skip the extra rung entirely.
 */
export function shrinkTerms(terms: string[], len = 4): string[] | null {
  const shrunk = [...new Set(terms.map(t => (t.length > len ? t.slice(0, len) : t)))];
  return shrunk.some((t, i) => t !== terms[i]) || shrunk.length !== terms.length
    ? shrunk
    : null;
}

/**
 * PORTER INFLECTION FIX (lore-pack retrieval gate miss #7, 2026-08-14):
 * porter stems the QUERY term and the CORPUS independently, and prefix
 * rescue only runs query->corpus. "greeters" stems to "greeter", which can
 * NEVER prefix-match corpus "greeting" (indexed token "greet") — the
 * siblings meet only if the query also carries the shorter common root.
 * Strip the common derivational suffixes BEFORE stemming and offer the root
 * as an ADDITIVE OR-variant of the term. Conservative by construction:
 * variants only ever widen a match, and a root shorter than 4 chars is
 * dropped as too promiscuous ("water" -> "wat" would match everything).
 * Note the invariant used by orRelevanceFloor: the root is a prefix of the
 * term, so its first 4 chars equal the term's first 4 chars.
 */
const SIBLING_SUFFIXES = ['ions', 'ers', 'ing', 'ion', 'ed', 'er'];

/** "greeters" -> "greet", "burning" -> "burn"; null when no suffix applies
 * or the remaining root is under 4 chars. First (longest) suffix wins. */
export function siblingRoot(term: string): string | null {
  for (const suffix of SIBLING_SUFFIXES) {
    if (term.length > suffix.length && term.endsWith(suffix)) {
      const root = term.slice(0, -suffix.length);
      return root.length >= 4 ? root : null;
    }
  }
  return null;
}

/** The default per-term expansion: the term itself, its ordinal digit
 * ("second" -> "2", "2nd" -> "2"), and its sibling root — each an ADDITIVE
 * OR-alternative inside the term's own concept group, so AND rungs keep
 * per-concept precision while any alternative satisfies the conjunct. */
export function termVariants(term: string): string[] {
  const out = [term];
  const digit = ORDINAL_WORDS[term];
  if (digit) {
    out.push(digit);
  }
  const root = siblingRoot(term);
  if (root) {
    out.push(root);
  }
  return out;
}

/**
 * Build an FTS5 MATCH expression. Every term is double-quoted (so sqlite
 * treats it as a string, never an operator) with a `*` prefix-search suffix,
 * joined by AND or OR. A term with expansion variants becomes a
 * parenthesized OR-group, so AND semantics stay per-CONCEPT while any
 * morphological sibling can satisfy the conjunct:
 *   ["sunrise","yoga"] and-> '"sunrise"* AND "yoga"*'
 *   ["greeters"]       -> '("greeters"* OR "greet"*)'
 * `expand` defaults to the sibling-root expansion; searchDocs passes an
 * enriched version that also revives dead terms (see reviveDeadTerms).
 */
export type FtsMode = 'and' | 'or' | 'phrase';

export function buildFtsMatch(
  terms: string[],
  mode: FtsMode,
  expand: (t: string) => string[] = termVariants,
  prefix: (term: string, variant: string) => boolean = () => true,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  if (mode === 'phrase') {
    // THE PHRASE RUNG: the terms as one ordered, adjacent FTS5 phrase — no
    // prefix `*`, no sibling variants. It exists because of a measured
    // failure of the AND rung on this corpus (2026-08-17 hand audit of the
    // v4.0 battery): "Man burn" -> AND("man"*, "burn"*) matches EVERY chunk,
    // because every heading carries "Burning Man" and porter stems
    // "burning" to "burn"; bm25's length normalization then hands the top-2
    // to the two shortest chunks (single-sentence Principles), and the
    // sentence "Man burn: Saturday night, September 5" — sitting right there
    // in the corpus — never reaches the model. Order-preserving adjacency
    // is what "Burning Man" fails and "Man burn:" passes. Measured on 46
    // probe queries: +2 hits, 0 regressions; NEAR() did not help (it is
    // order-free, so "Burning Man" still matches). Fill-to-limit means the
    // AND/OR rungs still top up beneath it, so a query the corpus never
    // phrases that way loses nothing.
    return `"${terms.map(t => t.replace(/"/g, '')).join(' ')}"`;
  }
  const groups = terms.map(t => {
    // Belt-and-suspenders: a term can no longer contain a double quote after
    // sanitizeKeywords, but strip any that would break the quoting.
    const quoted = [...new Set(expand(t))].map(v =>
      `"${v.replace(/"/g, '')}"${prefix(t, v) ? '*' : ''}`,
    );
    return quoted.length === 1 ? quoted[0] : `(${quoted.join(' OR ')})`;
  });
  return groups.join(mode === 'and' ? ' AND ' : ' OR ');
}

export interface BuiltQuery {
  sql: string;
  params: (string | number)[];
}

interface QueryOpts {
  terms: string[];
  mode: FtsMode;
  /** Inclusive ISO date range (dates only — intra-day times are filtered in JS). */
  dateRange?: { startDate: string; endDate: string } | null;
  limit?: number;
  /** Per-term variant expansion; defaults to termVariants (sibling roots). */
  expand?: (t: string) => string[];
  /** Whether each FTS alternative carries `*`; exact alternatives omit it. */
  prefix?: (term: string, variant: string) => boolean;
}

/**
 * Full FTS5 query joining the external-content FTS table back to events,
 * ranked by BM25 (title weighted above desc/camp/location). Only events from
 * ENABLED data packs are searched.
 */
export function buildFtsQuery(opts: QueryOpts): BuiltQuery | null {
  const match = buildFtsMatch(
    opts.terms,
    opts.mode,
    opts.expand ?? termVariants,
    opts.prefix,
  );
  if (!match) {
    return null;
  }
  const params: (string | number)[] = [match];
  let sql =
    'SELECT e.* FROM events e ' +
    'JOIN events_fts f ON f.rowid = e.id ' +
    'JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 ' +
    'WHERE f.events_fts MATCH ? AND ' + EVENTS_NOT_HIDDEN_SQL;
  if (opts.dateRange) {
    sql += ' AND e.date BETWEEN ? AND ?';
    params.push(opts.dateRange.startDate, opts.dateRange.endDate);
  }
  // bm25() returns lower-is-better; weights: title, desc, camp, location.
  sql += ' ORDER BY bm25(f.events_fts, 10.0, 4.0, 6.0, 6.0) LIMIT ?';
  params.push(opts.limit ?? TOP_N);
  return { sql, params };
}

/** Escape LIKE wildcards in a term; used with ESCAPE '\'. */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * LIKE fallback for when FTS5 is unavailable (not compiled in) or MATCH
 * errors. Each term must (AND) / may (OR) appear in one of the searchable
 * columns. Ordered chronologically since there is no BM25 here.
 */
export function buildLikeQuery(opts: QueryOpts): BuiltQuery | null {
  if (opts.terms.length === 0) {
    return null;
  }
  const params: (string | number)[] = [];
  const expand = opts.expand ?? termVariants;
  const groups = opts.terms.map(term => {
    const alts = [...new Set(expand(term))].flatMap(v => {
      const like = `%${escapeLike(v)}%`;
      return SEARCH_COLUMNS.map(c => {
        params.push(like);
        return `e.${c} LIKE ? ESCAPE '\\'`;
      });
    });
    return `(${alts.join(' OR ')})`;
  });
  let sql =
    'SELECT e.* FROM events e ' +
    'JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 WHERE ' +
    '(' + groups.join(opts.mode === 'and' ? ' AND ' : ' OR ') + ') AND ' +
    EVENTS_NOT_HIDDEN_SQL;
  if (opts.dateRange) {
    sql += ' AND e.date BETWEEN ? AND ?';
    params.push(opts.dateRange.startDate, opts.dateRange.endDate);
  }
  sql += ' ORDER BY e.date, e.time_start LIMIT ?';
  params.push(opts.limit ?? TOP_N);
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Freeform docs (data-pack chunks) — same deterministic FTS5/BM25 pattern.
// ---------------------------------------------------------------------------

interface DocsScopeOpts {
  /** Restrict to one pack (e.g. lookup_facts targets "survival-guide"). */
  packId?: string | null;
  /** Optional additive pack-id prefix scope, OR-combined with packId. */
  packIdPrefix?: string | null;
}

interface DocsQueryOpts extends DocsScopeOpts {
  terms: string[];
  mode: FtsMode;
  limit?: number;
  /** Per-term variant expansion; defaults to termVariants (sibling roots). */
  expand?: (t: string) => string[];
  /** Whether each FTS alternative carries `*`; exact alternatives omit it. */
  prefix?: (term: string, variant: string) => boolean;
}

/** Shared pack-scope clause for the docs builders. */
function docsPackScope(
  opts: DocsScopeOpts,
  params: (string | number)[],
): string {
  const prefix = opts.packIdPrefix
    ? `${escapeLike(opts.packIdPrefix)}%`
    : null;
  if (opts.packId && prefix) {
    params.push(opts.packId, prefix);
    return " AND (d.pack_id = ? OR d.pack_id LIKE ? ESCAPE '\\')";
  }
  if (opts.packId) {
    params.push(opts.packId);
    return ' AND d.pack_id = ?';
  }
  if (prefix) {
    params.push(prefix);
    return " AND d.pack_id LIKE ? ESCAPE '\\'";
  }
  return '';
}

/**
 * FTS5 query over doc_chunks from ENABLED packs, ranked by BM25 with the
 * heading breadcrumb weighted above body text. Returns the pack name too so
 * the UI can attribute the source.
 */
export function buildDocsFtsQuery(opts: DocsQueryOpts): BuiltQuery | null {
  const match = buildFtsMatch(
    opts.terms,
    opts.mode,
    opts.expand ?? termVariants,
    opts.prefix,
  );
  if (!match) {
    return null;
  }
  const params: (string | number)[] = [match];
  let sql =
    'SELECT d.*, p.name AS pack_name FROM doc_chunks d ' +
    'JOIN doc_chunks_fts f ON f.rowid = d.id ' +
    'JOIN packs p ON p.id = d.pack_id AND p.enabled = 1 ' +
    'WHERE f.doc_chunks_fts MATCH ?';
  sql += docsPackScope(opts, params);
  // Weights: heading, content.
  sql += ' ORDER BY bm25(f.doc_chunks_fts, 5.0, 1.0) LIMIT ?';
  params.push(opts.limit ?? TOP_N);
  return { sql, params };
}

/** Count enabled chunks in the same optional pack scope as doc retrieval. */
export function buildDocsScopeCountQuery(
  opts: DocsScopeOpts,
): BuiltQuery {
  const params: (string | number)[] = [];
  let sql =
    'SELECT COUNT(*) AS count FROM doc_chunks d ' +
    'JOIN packs p ON p.id = d.pack_id AND p.enabled = 1 WHERE 1 = 1';
  sql += docsPackScope(opts, params);
  return { sql, params };
}

/** Count one FTS shape without materializing/ranking its matching rows. */
export function buildDocsFtsCountQuery(
  opts: Omit<DocsQueryOpts, 'limit'>,
): BuiltQuery | null {
  const match = buildFtsMatch(
    opts.terms,
    opts.mode,
    opts.expand ?? termVariants,
    opts.prefix,
  );
  if (!match) {
    return null;
  }
  const params: (string | number)[] = [match];
  let sql =
    'SELECT COUNT(*) AS count FROM doc_chunks d ' +
    'JOIN doc_chunks_fts f ON f.rowid = d.id ' +
    'JOIN packs p ON p.id = d.pack_id AND p.enabled = 1 ' +
    'WHERE f.doc_chunks_fts MATCH ?';
  sql += docsPackScope(opts, params);
  return { sql, params };
}

/** LIKE fallback over doc_chunks (heading + content). */
export function buildDocsLikeQuery(opts: DocsQueryOpts): BuiltQuery | null {
  if (opts.terms.length === 0) {
    return null;
  }
  const params: (string | number)[] = [];
  const expand = opts.expand ?? termVariants;
  const groups = opts.terms.map(term => {
    const alts = [...new Set(expand(term))].map(v => {
      const like = `%${escapeLike(v)}%`;
      params.push(like, like);
      return "d.heading LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\'";
    });
    return `(${alts.join(' OR ')})`;
  });
  let sql =
    'SELECT d.*, p.name AS pack_name FROM doc_chunks d ' +
    'JOIN packs p ON p.id = d.pack_id AND p.enabled = 1 WHERE ' +
    '(' + groups.join(opts.mode === 'and' ? ' AND ' : ' OR ') + ')';
  sql += docsPackScope(opts, params);
  sql += ' ORDER BY d.pack_id, d.source_file, d.id LIMIT ?';
  params.push(opts.limit ?? TOP_N);
  return { sql, params };
}
