/**
 * The search_docs tool executor — deterministic BM25 lookup over freeform
 * data-pack chunks (camp docs, guides). Same pattern as search_events: the
 * model supplies keywords, the app owns retrieval; no embedder involved.
 */

import type { DocSearchOutcome } from '../types';
import { excerptForTerms } from './excerpt';
import { getDb, isFtsAvailable } from '../events/db';
import {
  sanitizeKeywords,
  shrinkTerms,
  termVariants,
  parseOrdinalTerm,
  buildDocsFtsCountQuery,
  buildDocsFtsQuery,
  buildDocsLikeQuery,
  buildDocsScopeCountQuery,
  docsPackScope,
} from '../events/ftsQuery';
import { collectLadder, LadderRung } from '../events/ladder';
import {
  EMBEDDER_MODEL_ID,
  COSINE_FLOOR,
  fuseRanked,
  __getQueryEmbedder as currentEmbedder,
} from './vectorSearch';
import { isVecAvailable } from '../events/db';
import { parsePersonCard } from '../facts/personCard';
import { normalizeFactEntity } from '../facts/normalizeFactEntity';
import { hiddenKeys } from '../facts/hiddenItems';

export { excerptForTerms };

export interface SearchDocsArgs {
  query: string;
  /** Optional pack restriction (e.g. "survival-guide"). */
  pack_id?: string;
  /**
   * Optional ADDITIVE pack-id prefix scope (OR-combined with pack_id).
   * App-internal — never exposed in the model-facing tool schema:
   * lookup_facts passes "camp-board-" so camp items answer camp questions.
   */
  pack_prefix?: string;
  /** App-internal: specialty floor probes disable dead-term revival so a
   * manufactured prefix cannot claim a precise rung. */
  revive_dead_terms?: boolean;
}

type DocStrategy = Exclude<DocSearchOutcome['strategy'], 'none'>;
type DocRow = DocSearchOutcome['results'][number];
type PrefixPolicy = (term: string, variant: string) => boolean;

/** Resolve-time exclusions must remove the exact person-card passage before it
 * reaches cards, model context, or source chips. Durable chunks stay intact so
 * revoking the exclusion restores them without reinstalling the pack. */
function visibleResults(
  conn: ReturnType<typeof getDb>,
  results: DocSearchOutcome['results'],
): DocSearchOutcome['results'] {
  if (results.length === 0) {
    return results;
  }
  const rows = conn.execute(
    `SELECT n.pack_id, n.name
     FROM nodes n
     JOIN fact_exclusions x
       ON x.pack_id = n.pack_id AND x.node_id = n.id
     WHERE n.type = 'person'`,
  ).rows?._array ?? [];
  if (rows.length === 0) {
    return results;
  }
  const excluded = new Set(
    rows.map(row => `${String(row.pack_id)}\0${normalizeFactEntity(String(row.name))}`),
  );
  return results.filter(passage => {
    const card = parsePersonCard(passage);
    return !card || !excluded.has(
      `${passage.pack_id}\0${normalizeFactEntity(card.name)}`,
    );
  });
}

/** "Don't use this" on a passage: drop chunks the user hid, by the same
 * pack_id:chunk_id key a SourceRef carries. Sits beside the person filter
 * rather than inside it because the two are different mechanisms with the
 * same user-facing verb (see facts/hiddenItems.ts). */
function withoutHiddenPassages(
  conn: ReturnType<typeof getDb>,
  results: DocSearchOutcome['results'],
): DocSearchOutcome['results'] {
  if (results.length === 0) {
    return results;
  }
  const hidden = hiddenKeys(conn, 'passage');
  if (hidden.size === 0) {
    return results;
  }
  // Durable board-section keys (boardsec:<pack>:<type>) survive chunk-id
  // regeneration; resolve them to whatever ids the chunks carry right now.
  for (const k of Array.from(hidden)) {
    if (!k.startsWith('boardsec:')) {
      continue;
    }
    const live = conn.execute(
      'SELECT pack_id, id FROM doc_chunks WHERE note_key = ?',
      [k],
    );
    for (const r of (live.rows?._array ?? []) as { pack_id: string; id: number }[]) {
      hidden.add(`${r.pack_id}:${r.id}`);
    }
  }
  return results.filter(p => !hidden.has(`${p.pack_id}:${p.id}`));
}

function visibleOutcome(
  conn: ReturnType<typeof getDb>,
  outcome: DocSearchOutcome,
): DocSearchOutcome {
  const results = withoutHiddenPassages(conn, visibleResults(conn, outcome.results));
  return results === outcome.results ? outcome : { ...outcome, results };
}

const SATURATED_PREFIX_SHARE = 0.5;
const MATERIAL_EXACT_SHARE = 0.5;

export function shouldUseFtsPrefix(
  total: number,
  prefixed: number,
  exact: number,
): boolean {
  return (
    prefixed <= total * SATURATED_PREFIX_SHARE ||
    exact >= prefixed * MATERIAL_EXACT_SHARE
  );
}

function queryCount(
  conn: ReturnType<typeof getDb>,
  query: { sql: string; params: (string | number)[] } | null,
): number | null {
  if (!query) {
    return null;
  }
  try {
    const row = (conn.execute(query.sql, query.params).rows?._array ?? [])[0] as
      | { count?: number }
      | undefined;
    return row ? Number(row.count ?? 0) : 0;
  } catch {
    return null;
  }
}

/** Porter also stems a quoted prefix: `"bus"*` becomes `bu*`, which matched
 * 83% of the measured lore corpus and flattened BM25 into install order. If a
 * prefix matches a majority of the active scope while its exact-token form is
 * less than half as broad, keep that alternative exact. The cache also covers
 * variants added later by dead-term revival and zero-result rescue. */
function scopedPrefixPolicy(
  conn: ReturnType<typeof getDb>,
  packId: string | null,
  packIdPrefix: string | null,
): PrefixPolicy {
  if (!isFtsAvailable()) {
    return () => true;
  }
  const scope = { packId, packIdPrefix };
  const total = queryCount(conn, buildDocsScopeCountQuery(scope));
  if (!total) {
    return () => true;
  }
  const cache = new Map<string, boolean>();
  return (_term, variant) => {
    const known = cache.get(variant);
    if (known !== undefined) {
      return known;
    }
    const base = {
      terms: [variant],
      mode: 'or' as const,
      ...scope,
      expand: () => [variant],
    };
    const prefixed = queryCount(
      conn,
      buildDocsFtsCountQuery({ ...base, prefix: () => true }),
    );
    const exact = queryCount(
      conn,
      buildDocsFtsCountQuery({ ...base, prefix: () => false }),
    );
    const safe =
      prefixed === null ||
      exact === null ||
      shouldUseFtsPrefix(total, prefixed, exact);
    cache.set(variant, safe);
    return safe;
  };
}

/**
 * DEAD-TERM REVIVAL (EVAL v13 "deterministic query-trap", moon question
 * 0/3): the model's near-greedy query "moonlight burn night" carried its
 * whole signal in "moonlight" — a term matching ZERO chunks (porter keeps
 * compounds whole; the corpus says "moon"/"moonless"). The fts-or rung then
 * ranked purely on high-frequency burn/night, filled the limit with junk
 * (rebar-at-night, dates, navigation), and the moon-phase chunk sat at rank
 * 4 — while the zero-result prefix rescue, which ranks that chunk FIRST,
 * could never fire because the junk kept the rungs non-empty.
 *
 * Fix: probe each term (WITH its sibling variants) against the same
 * enabled-pack/pin scope; a term that matches nothing is dead, and its
 * 4-char prefix joins its OR-variant group in the MAIN rungs — so bm25
 * re-ranks with the discriminative term revived while live terms keep full
 * precision. Strictly additive: matches only ever widen, and a query whose
 * every variant still matches nothing keeps returning empty (honest IDK).
 */
function reviveDeadTerms(
  conn: ReturnType<typeof getDb>,
  terms: string[],
  packId: string | null,
  packIdPrefix: string | null,
  prefix: PrefixPolicy,
): (t: string) => string[] {
  if (!isFtsAvailable()) {
    return termVariants;
  }
  const revived = new Map<string, string>();
  for (const term of terms) {
    if (term.length <= 4) {
      continue; // the prefix would not shrink anything
    }
    const probe = buildDocsFtsQuery({
      terms: [term],
      mode: 'or',
      packId,
      packIdPrefix,
      limit: 1,
      prefix,
    });
    if (!probe) {
      continue;
    }
    try {
      const res = conn.execute(probe.sql, probe.params);
      if ((res.rows?._array ?? []).length === 0) {
        revived.set(term, term.slice(0, 4));
      }
    } catch {
      // FTS hiccup: skip revival for this term; the ladder's LIKE rungs and
      // the zero-result rescue still stand behind it.
    }
  }
  if (revived.size === 0) {
    return termVariants;
  }
  return t => {
    const root = revived.get(t);
    return root ? [...termVariants(t), root] : termVariants(t);
  };
}

/** Words that ride along with a pack's own name in identity questions
 * without breaking the identity shape ("the CAMP dusty star"). */
const IDENTITY_EXTRAS = new Set(['camp', 'group', 'crew', 'project']);

/**
 * THE IDENTITY RUNG (about-pin): a pack cannot win BM25 for its own name —
 * the name saturates its every chunk (measured: "dusty star" in 4,697 of
 * 8,240, IDF ≈ 0, the About card sat one slot outside the top-2 cut), and a
 * hand-tuned card that DOES win raw BM25 then hijacks adjacent queries
 * (measured: "hippo bus" returned the card). So identity questions are
 * answered structurally: when EVERY query term is a token (or 4+-char
 * prefix) of an enabled pack's own name/id — plus IDENTITY_EXTRAS — that
 * pack's about-* chunks answer directly. Any foreign term ("bus") fails the
 * shape and flows to the normal ladder. Generalizes to every camp's
 * imported pack: ship an about-*.md and "what is <your camp>" just works.
 */
function aboutPin(
  conn: ReturnType<typeof getDb>,
  terms: string[],
  packId: string | null,
  packIdPrefix: string | null,
  limit: number,
): DocSearchOutcome | null {
  let packs: Array<{ id: string; name: string }>;
  try {
    const params: (string | number)[] = [];
    const res = conn.execute(
      `SELECT DISTINCT p.id, p.name FROM packs p
       JOIN doc_chunks d ON d.pack_id = p.id
       WHERE p.enabled = 1 AND d.source_file LIKE 'about-%'` +
        docsPackScope({ packId, packIdPrefix }, params),
      params,
    );
    packs = (res.rows?._array ?? []) as Array<{ id: string; name: string }>;
  } catch {
    return null;
  }
  for (const pack of packs) {
    const tokens = `${pack.name} ${pack.id}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const isNameish = (t: string) =>
      tokens.some(
        tok =>
          tok === t ||
          (t.length >= 4 && tok.startsWith(t)) ||
          (tok.length >= 4 && t.startsWith(tok)),
      );
    if (!terms.every(t => IDENTITY_EXTRAS.has(t) || isNameish(t))) {
      continue;
    }
    try {
      const res = conn.execute(
        `SELECT d.id, d.pack_id, d.source_file, d.heading, d.content, p.name AS pack_name
         FROM doc_chunks d JOIN packs p ON p.id = d.pack_id
         WHERE d.pack_id = ? AND d.source_file LIKE 'about-%'
         ORDER BY d.id LIMIT ?`,
        [pack.id, limit],
      );
      const rows = (res.rows?._array ?? []) as DocSearchOutcome['results'];
      if (rows.length > 0) {
        return { results: rows, strategy: 'about-pin', terms };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function docRungs(
  terms: string[],
  packId: string | null,
  packIdPrefix: string | null,
  limit: number,
  expand: (t: string) => string[],
  prefix: PrefixPolicy,
): LadderRung<DocStrategy>[] {
  const scope = { packId, packIdPrefix };
  const rungs: LadderRung<DocStrategy>[] = [];
  if (isFtsAvailable()) {
    if (terms.length >= 2) {
      // Ordered-adjacent phrase first (see buildFtsMatch 'phrase' for the
      // measured "Man burn" failure it exists for). One term is not a
      // phrase; the AND rung already is that query.
      rungs.push({
        q: buildDocsFtsQuery({ terms, mode: 'phrase', ...scope, limit }),
        strategy: 'fts-phrase',
      });
    }
    rungs.push(
      {
        q: buildDocsFtsQuery({
          terms,
          mode: 'and',
          ...scope,
          limit,
          expand,
          prefix,
        }),
        strategy: 'fts-and',
      },
      {
        q: buildDocsFtsQuery({
          terms,
          mode: 'or',
          ...scope,
          limit,
          expand,
          prefix,
        }),
        strategy: 'fts-or',
      },
    );
  }
  rungs.push(
    { q: buildDocsLikeQuery({ terms, mode: 'and', ...scope, limit, expand }), strategy: 'like-and' },
    { q: buildDocsLikeQuery({ terms, mode: 'or', ...scope, limit, expand }), strategy: 'like-or' },
  );
  return rungs;
}

/**
 * THE SEMANTIC ARM (RAG-ARCHITECTURE-RESEARCH lane B Tier 1, fused — never
 * overriding): fetch the pack-build-precomputed chunk vectors whose model id
 * matches the query embedder's, rank by brute-force cosine (8.6K×384-dim ≈
 * single-digit ms; no ANN at this scale), and RRF-fuse with the keyword
 * ladder's ranked list. Guards from the research, encoded:
 *  - inert unless a query embedder is loaded (keyword-only graceful degrade);
 *  - inert on packs with no vectors (builtin packs carry none today);
 *  - inert on model-id mismatch (index and query must share the embedder);
 *  - a cosine floor cuts the noise tail;
 *  - keyword rows keep their EXACT positions — vector-only candidates may
 *    only fill slots the ladder left empty (exact-name hits always survive).
 * Returns vector-ranked chunk ids, or [] when the arm cannot fire.
 */
function vectorRankedIds(
  conn: ReturnType<typeof getDb>,
  queryVector: number[],
  packId: string | null,
  packIdPrefix: string | null,
  limit: number,
): number[] {
  if (!isVecAvailable()) {
    return [];
  }
  // C-side cosine via sqlite-vec (the Ember ruling: no hand-rolled vector
  // math). The KNN walk runs against chunks whose model id matches the
  // query embedder — a mismatch makes the arm INERT, never wrong.
  let rows: Array<{ chunk_id: number; distance: number }>;
  try {
    const params: (string | number)[] = [
      JSON.stringify(queryVector),
      EMBEDDER_MODEL_ID,
    ];
    const res = conn.execute(
      `SELECT m.chunk_id, vec_distance_cosine(v.embedding, ?) AS distance
       FROM doc_chunk_vectors v
       JOIN doc_chunk_vectors_meta m ON m.chunk_id = v.rowid
       JOIN doc_chunks d ON d.id = m.chunk_id
       JOIN packs p ON p.id = d.pack_id AND p.enabled = 1
       WHERE m.model = ?` +
        docsPackScope({ packId, packIdPrefix }, params) +
        ' ORDER BY distance LIMIT ?',
      [...params, limit],
    );
    rows = (res.rows?._array ?? []) as Array<{ chunk_id: number; distance: number }>;
  } catch {
    return []; // vec table absent (older db) — keyword-only degrade
  }
  return rows
    .filter(r => 1 - r.distance >= COSINE_FLOOR)
    .map(r => r.chunk_id);
}

function rowsByIds(
  conn: ReturnType<typeof getDb>,
  ids: number[],
  packId: string | null,
  packIdPrefix: string | null,
): DocSearchOutcome['results'] {
  if (ids.length === 0) {
    return [];
  }
  const marks = ids.map(() => '?').join(',');
  const params: (string | number)[] = [...ids];
  const res = conn.execute(
    `SELECT d.id, d.pack_id, d.source_file, d.heading, d.content, p.name AS pack_name
     FROM doc_chunks d JOIN packs p ON p.id = d.pack_id AND p.enabled = 1
     WHERE d.id IN (${marks})` +
      docsPackScope({ packId, packIdPrefix }, params),
    params,
  );
  const byId = new Map<number, DocSearchOutcome['results'][number]>();
  for (const r of (res.rows?._array ?? []) as DocSearchOutcome['results']) {
    byId.set(r.id, r);
  }
  return ids.map(id => byId.get(id)!).filter(Boolean);
}

/** The async twin of searchDocs — identical keyword ladder, then the
 * semantic-arm fuse when an embedder is loaded. searchDocs stays synchronous
 * (tool executor contract); searchDocsSemantic is the upgrade path the
 * executor calls when semanticEnabled(). */
export async function searchDocsSemantic(
  args: SearchDocsArgs,
  limit = 5,
): Promise<DocSearchOutcome> {
  const keyword = searchDocs(args, limit);
  const embedder = currentEmbedder();
  if (!embedder) {
    return keyword;
  }
  const packId = args.pack_id?.trim() || null;
  const packIdPrefix = args.pack_prefix?.trim() || null;
  const conn = getDb();
  const qv = await embedder(args.query);
  if (!qv) {
    return keyword;
  }
  const vectorIds = vectorRankedIds(
    conn,
    qv,
    packId,
    packIdPrefix,
    limit,
  );
  if (vectorIds.length === 0) {
    return keyword;
  }
  const keywordIds = keyword.results.map(r => r.id);
  const fusedIds = fuseRanked(keywordIds, vectorIds, limit);
  if (fusedIds.join(',') === keywordIds.join(',')) {
    return keyword; // vectors added nothing new — keep the ladder outcome
  }
  const fused = rowsByIds(conn, fusedIds, packId, packIdPrefix);
  return visibleOutcome(conn, {
    results: fused,
    strategy: keyword.strategy,
    terms: keyword.terms,
  });
}

// The embedder is re-read per call (via currentEmbedder) so tests can swap
// it without module-cache juggling.

export function searchDocs(args: SearchDocsArgs, limit = 5): DocSearchOutcome {
  // Docs queries keep 1-char terms: ring letters and clock digits matter here.
  const terms = sanitizeKeywords(args.query, { keepSingleChars: true });
  if (terms.length === 0) {
    return { results: [], strategy: 'none' };
  }
  const packId = args.pack_id?.trim() || null;
  const packIdPrefix = args.pack_prefix?.trim() || null;
  const conn = getDb();
  // Hides filter AFTER retrieval: a hidden rank-1 hit would otherwise
  // consume the LIMIT slot and suppress a visible rank-2 (audit round 4).
  // Overfetch by the hidden count, filter, then cap back to the ask.
  // Uncapped: with N hidden rows ranked ahead, anything less than
  // limit + N can still false-empty (audit round 5). N is the user's own
  // hide count — small in practice, and correctness beats a cap here.
  const fetchLimit = limit + hiddenKeys(conn, 'passage').size;
  const cap = (o: DocSearchOutcome): DocSearchOutcome =>
    o.results.length > limit ? { ...o, results: o.results.slice(0, limit) } : o;
  const pinned = aboutPin(conn, terms, packId, packIdPrefix, fetchLimit);
  if (pinned) {
    return cap(visibleOutcome(conn, pinned));
  }
  const prefix = scopedPrefixPolicy(conn, packId, packIdPrefix);
  const expand =
    args.revive_dead_terms === false
      ? termVariants
      : reviveDeadTerms(conn, terms, packId, packIdPrefix, prefix);
  const found = collectLadder<DocStrategy, DocRow>(
    conn,
    docRungs(terms, packId, packIdPrefix, fetchLimit, expand, prefix),
    fetchLimit,
  );
  if (found.rows.length > 0) {
    return cap(
      visibleOutcome(conn, {
        results: found.rows,
        strategy: found.strategy,
        terms,
      }),
    );
  }
  // Zero-result rescue: retry with 4-char prefix terms so a derived query
  // word still reaches its corpus root ("moonlight" -> "moon"*). Strictly
  // additive — only runs when every full-term rung came back empty.
  const shrunk = shrinkTerms(terms);
  if (shrunk) {
    const rescue = collectLadder<'fts-prefix' | 'like-prefix', DocRow>(
      conn,
      [
        isFtsAvailable()
          ? {
              q: buildDocsFtsQuery({
                terms: shrunk,
                mode: 'or',
                packId,
                packIdPrefix,
                limit: fetchLimit,
                prefix,
              }),
              strategy: 'fts-prefix' as const,
            }
          : { q: null, strategy: 'fts-prefix' as const },
        { q: buildDocsLikeQuery({ terms: shrunk, mode: 'or', packId, packIdPrefix, limit: fetchLimit }), strategy: 'like-prefix' as const },
      ],
      fetchLimit,
    );
    if (rescue.rows.length > 0) {
      return cap(
        visibleOutcome(conn, {
          results: rescue.rows,
          strategy: rescue.strategy,
          terms,
        }),
      );
    }
  }
  return { results: [], strategy: 'none' };
}

interface NumberedHeading {
  position: number;
  total: number | null;
  label: string;
  title: string;
}

/** Read an explicit list position from the final heading breadcrumb. A total
 * may ride in that heading ("Part 2 of 5") or an ancestor ("10 Principles"). */
function numberedHeading(heading: string): NumberedHeading | null {
  const parts = heading.split('>').map(p => p.trim()).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? '';
  const named = leaf.match(
    /^(.+?)\s+(\d+)(?:\s*(?:of|\/)\s*(\d+))?\s*(?::|[.)-])?\s*(.*)$/i,
  );
  const bare = leaf.match(
    /^(\d+)(?:\s*(?:of|\/)\s*(\d+))?[.)-]\s*(.+)$/i,
  );
  if (!named && !bare) {
    return null;
  }
  const label = named ? named[1].trim() : 'Item';
  const position = Number(named ? named[2] : bare![1]);
  let total = Number(named ? named[3] : bare![2]) || null;
  const title = (named ? named[4] : bare![3]).trim();
  if (!total) {
    const words = label.toLowerCase().split(/\s+/);
    const noun = words[words.length - 1]?.replace(/s$/, '');
    for (const ancestor of parts.slice(0, -1).reverse()) {
      const collection = ancestor.match(/\b(\d+)\s+([a-z][a-z-]*)\b/i);
      if (
        collection &&
        collection[2].toLowerCase().replace(/s$/, '') === noun
      ) {
        total = Number(collection[1]);
        break;
      }
    }
  }
  return { position, total, label, title };
}

function passageJson(
  c: DocSearchOutcome['results'][number],
  terms: string[] | undefined,
  item: string,
) {
  return {
    item,
    pack: c.pack_name,
    source: c.source_file,
    heading: c.heading,
    text: excerptForTerms(c.content, terms),
  };
}

/** Shape a doc-search outcome for the model's tool-result message. Ordinal
 * questions receive one explicit copyable list item instead of asking the
 * model to derive list position from ranked passages. */
export function docsResultJson(outcome: DocSearchOutcome): string {
  const ordinal = outcome.terms
    ?.map(parseOrdinalTerm)
    .find((n): n is number => n !== null);
  if (ordinal) {
    const hit = outcome.results.find(c => numberedHeading(c.heading)?.position === ordinal);
    if (hit) {
      const numbered = numberedHeading(hit.heading)!;
      const total = numbered.total ? ` of ${numbered.total}` : '';
      const title = numbered.title ? `: ${numbered.title}` : '';
      const item = `${numbered.label} ${numbered.position}${total}${title}`;
      return JSON.stringify({
        count: 1,
        passages: [passageJson(hit, outcome.terms, item)],
      });
    }
  }
  return JSON.stringify({
    count: outcome.results.length,
    passages: outcome.results.map((c, i) =>
      passageJson(c, outcome.terms, `${i + 1}. ${c.heading || c.source_file}`),
    ),
  });
}
