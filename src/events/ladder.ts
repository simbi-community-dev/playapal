/**
 * Shared strategy-ladder executor with FILL-TO-LIMIT semantics, used by both
 * search_docs/lookup_facts and search_events.
 *
 * The old behavior returned the first non-empty rung alone, so a precise
 * AND match with 1 row starved the model of context that the OR rung had
 * ranked and ready (EVAL-v11-TOOLS "retrieval brittleness"). Now every rung
 * tops up the running result until `limit` rows are collected, deduped by row
 * id, earlier (more precise) rungs first. The reported strategy is the first
 * rung that contributed.
 */

import type { DbConnection as QuickSQLiteConnection } from '../events/engine';
import type { BuiltQuery } from './ftsQuery';

export interface LadderRung<S extends string> {
  q: BuiltQuery | null;
  strategy: S;
  /** Optional relevance floor: rows failing it are skipped (not consumed —
   * a later rung may still accept them). Used by search_events to keep
   * OR-rung top-ups from dragging one-term matches into an unrelated answer
   * (owner field bug 2026-08-13: a MOOP clarify follow-up surfaced a
   * packing-for-exodus event). Docs/facts rungs pass none — looser matching
   * is right for prose lookups. */
  accept?: (row: { id: number }) => boolean;
}

export function collectLadder<S extends string, R extends { id: number }>(
  conn: QuickSQLiteConnection,
  rungs: LadderRung<S>[],
  limit: number,
): { rows: R[]; strategy: S | 'none' } {
  const rows: R[] = [];
  const seen = new Set<number>();
  let strategy: S | 'none' = 'none';
  for (const { q, strategy: s, accept } of rungs) {
    if (limit >= 0 && rows.length >= limit) {
      break;
    }
    if (!q) {
      continue;
    }
    try {
      const res = conn.execute(q.sql, q.params);
      for (const row of (res.rows?._array ?? []) as R[]) {
        if (limit >= 0 && rows.length >= limit) {
          break;
        }
        if (seen.has(row.id)) {
          continue;
        }
        if (accept && !accept(row)) {
          continue;
        }
        seen.add(row.id);
        rows.push(row);
        if (strategy === 'none') {
          strategy = s;
        }
      }
    } catch (e) {
      // A malformed MATCH (should be impossible post-sanitize) or missing FTS
      // table falls through to the next rung.
      console.warn(`[ladder] ${s} failed:`, e);
    }
  }
  return { rows, strategy };
}
