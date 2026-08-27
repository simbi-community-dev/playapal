/**
 * THE SEMANTIC ARM — fusion and guards only (post-Ember-ruling shape).
 *
 * Division of labor, each piece where someone else already debugged it:
 * - Vector STORAGE + DISTANCE: sqlite-vec (C) via op-sqlite — the vec0
 *   virtual table in schema.ts; KNN runs as vec_distance_cosine in SQL
 *   (searchDocs.ts). NO vector math in JS anywhere.
 * - Corpus vectors PRECOMPUTED at pack build (embeddings.json, model-id
 *   stamped); the phone embeds QUERIES ONLY via llama.rn's embedding().
 * - Same-model rule (research §3.1): pack vectors and the query embedder
 *   must report the same EMBEDDER_MODEL_ID or the arm goes INERT
 *   (keyword-only degrade) — never silently wrong.
 * - THIS MODULE: the RRF fusion (k=60, positions only — BM25 and cosine
 *   scores never compared) and the never-override guard: chunks surfaced
 *   by the keyword ladder are immune to vector displacement, so the
 *   measured wrong-similar-person tail can only ADD candidates into empty
 *   slots, never evict an exact-name hit.
 * - Embedder injected (QueryEmbedder) so all of this tests without native
 *   code; production wires llama.rn behind a fail-soft model load.
 */

import type { DocSearchOutcome } from '../types';

/** Vector dimension of the shipped embedder (bge-small-en-v1.5 class). */
export const VECTOR_DIM = 384;

/** Cosine floor for a vector hit to count at all — below this the vector
 * list is noise and the arm silently degrades to keyword-only. 0.35 is the
 * conventional "related at all" line for 384-dim MiniLM/bge models. */
export const COSINE_FLOOR = 0.35;

/** RRF smoothing constant — the standard k from the 2009 paper; guild's
 * hybrid uses the same. Rank 1 ≈ 1/61, rank 10 ≈ 1/70 — position matters,
 * score magnitudes (incomparable across BM25 and cosine) never enter. */
export const RRF_K = 60;

/** Embedder model id the SHIPPED pack vectors were computed with. A query
 * embedder must report the same id or the arm stays inert (the same-model
 * rule from research §3.1). Bump when the shipped embedder changes; packs
 * built with the old id then degrade to keyword-only until rebuilt. */
export const EMBEDDER_MODEL_ID = 'bge-small-en-v1.5-q8';

export type QueryEmbedder = (text: string) => Promise<number[] | null>;

/** Global, set by the LLM layer when an embedding-capable context is loaded
 * with the matching model id. Null = keyword-only (the shipped default
 * until the embedder GGUF ships). */
let queryEmbedder: QueryEmbedder | null = null;

export function setQueryEmbedder(embedder: QueryEmbedder | null): void {
  queryEmbedder = embedder;
}

/** Internal accessor so callers re-read the CURRENT embedder per call (tests
 * swap it without module-cache juggling). */
export function __getQueryEmbedder(): QueryEmbedder | null {
  return queryEmbedder;
}

export function semanticEnabled(): boolean {
  return queryEmbedder !== null;
}

// NOTE: the original int16 hand-rolled cosine was SUPERSEDED by the Ember
// design ruling (2026-08-15, #playapal): all vector math is sqlite-vec
// C-side (vec_distance_cosine in SQL). What remains in this module is the
// JS half the ruling kept: embedder plumbing, the RRF fusion, and the
// never-override guard.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RRF fusion (guild's design, ~10 lines): each list contributes
// 1/(k + rank) per row; scores add across lists. Rows in BOTH lists win
// naturally — the exact behavior wanted on a true hit.
// ---------------------------------------------------------------------------

export interface RankedId {
  id: number;
}

export function rrfFuse(
  keywordIds: number[],
  vectorIds: number[],
  k = RRF_K,
): Map<number, number> {
  const score = new Map<number, number>();
  keywordIds.forEach((id, i) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
  });
  vectorIds.forEach((id, i) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
  });
  return score;
}

/**
 * Compose the final ranked id list under the NEVER-OVERRIDE guard: every
 * keyword-surfaced row keeps its exact ladder position; vector-only rows
 * fill the remaining slots by fused score. The keyword arm can therefore
 * never lose a row to the vector arm — the wrong-similar-person tail can
 * only ADD candidates below the ladder's own picks, and only when the
 * ladder under-fills.
 */
export function fuseRanked(
  keywordIds: number[],
  vectorIds: number[],
  limit: number,
): number[] {
  const fused = rrfFuse(keywordIds, vectorIds);
  const vectorOnly = vectorIds
    .filter(id => !keywordIds.includes(id))
    .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0));
  const out = keywordIds.slice(0, limit);
  for (const id of vectorOnly) {
    if (out.length >= limit) {
      break;
    }
    out.push(id);
  }
  return out;
}

/** Compose a fused outcome from ladder rows + fetched vector rows. Pure:
 * the caller does the DB reads (keeps this module SQLite-free for tests). */
export function fuseOutcomes<T extends { id: number }>(
  ladderRows: T[],
  vectorRows: T[],
  _strategy: DocSearchOutcome['strategy'],
): T[] {
  const byId = new Map<number, T>();
  for (const r of [...ladderRows, ...vectorRows]) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
    }
  }
  const ids = fuseRanked(
    ladderRows.map(r => r.id),
    vectorRows.map(r => r.id),
    Math.max(ladderRows.length, vectorRows.length),
  );
  return ids.map(id => byId.get(id)!).filter(Boolean);
}
