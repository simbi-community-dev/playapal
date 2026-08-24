/**
 * The lookup_facts tool — the model's one factual-lookup verb, backed by
 * search_docs over EVERY enabled doc-bearing pack: the survival guide, this
 * camp's needs/offers board, and any imported doc pack (e.g. the camp memory
 * bank). One tool that reaches everything the phone carries — matching the
 * persona's "the guides you carry" promise.
 *
 * HISTORY: this executor was pinned to survival-guide + camp-board-* packs.
 * The 2026-08-14 evening field campaign proved the consequence: the 2.6B
 * routes EVERY factual question to lookup_facts (16/18 tool calls; the
 * nudge's search_docs sentence never fired once), so an installed lore pack
 * was conversationally unreachable — 0/5 grounded on lore questions
 * (field-measured 2026-08-14). The fix follows the model's observed
 * grain: widen the executor, not the prompt. The model-facing tool
 * DESCRIPTION and nudge are deliberately untouched — wording is measurably
 * load-bearing at 2.6B (re-run EVAL-v11-TOOLS before editing those).
 *
 * SPECIALTY FLOORS: plain bm25 across the merged corpus buries both the
 * official guide's safety-critical answers and tiny live camp boards under
 * 25 years of camp email. When either specialty matches at the merged
 * winner's rung strength, its best chunk takes a reserved slot. Reservations
 * compose: a later guide floor cannot evict a board row (or vice versa), and
 * unrelated weak matches stay out. Scope narrowing remains the USER's
 * control: disabling a pack in Settings removes it through the enabled=1 joins.
 * Ranking is covered by lookupFactsWidenedScope.test.ts, campRetrieval.test.ts,
 * and loreReachability.test.ts.
 */

import { searchDocs, searchDocsSemantic, docsResultJson } from '../docs/searchDocs';
import { ensureQueryEmbedder } from '../llm/queryEmbedder';
import { CAMP_PACK_PREFIX } from '../camp/campBoard';
import { SURVIVAL_GUIDE_PACK_ID } from '../packs/builtins';
import type { DocSearchOutcome } from '../types';

export interface LookupFactsArgs {
  topic: string;
}

/** Higher = a more precise ladder rung. AND-tier rungs (every term present
 * in one chunk — the ordered phrase is the strictest of them) beat OR rungs
 * beat the zero-result prefix rescue; the fts/like split inside a tier is an
 * availability detail, not a precision one. The phrase rung shares the AND
 * tier ON PURPOSE: this table gates specialty RESERVATION (may the tiny live
 * camp board claim a slot beside a lore hit?), and the bar there is "every
 * term landed in one chunk", which an AND hit on the board meets. Ranking
 * phrase above it would let 80 lore chunks that happen to phrase the query
 * adjacently evict a real board hit (campRetrieval "offering bike tubes"). */
const RUNG_STRENGTH: Record<DocSearchOutcome['strategy'], number> = {
  'about-pin': 4,
  'fts-phrase': 3,
  'fts-and': 3,
  'like-and': 3,
  'fts-or': 2,
  'like-or': 2,
  'fts-prefix': 1,
  'like-prefix': 1,
  none: 0,
};

const isBoard = (packId: string) => packId.startsWith(CAMP_PACK_PREFIX);
const isSpecialty = (packId: string) =>
  isBoard(packId) || packId === SURVIVAL_GUIDE_PACK_ID;

/** Add qualifying specialty rows without letting a later floor evict an
 * earlier one. Full lists lose their lowest-ranked non-specialty row. */
function reserveSpecialties(
  merged: DocSearchOutcome,
  candidates: DocSearchOutcome['results'],
  limit: number,
): DocSearchOutcome {
  const results = [...merged.results];
  for (const candidate of candidates) {
    if (results.some(r => r.id === candidate.id)) {
      continue;
    }
    if (results.length >= limit) {
      let evict = -1;
      for (let i = results.length - 1; i >= 0; i--) {
        if (!isSpecialty(results[i].pack_id)) {
          evict = i;
          break;
        }
      }
      if (evict === -1) {
        continue;
      }
      results.splice(evict, 1);
    }
    results.push(candidate);
  }
  return { ...merged, results };
}

function qualifies(
  probe: DocSearchOutcome,
  merged: DocSearchOutcome,
): boolean {
  return (
    probe.results.length > 0 &&
    RUNG_STRENGTH[probe.strategy] >= RUNG_STRENGTH[merged.strategy]
  );
}

/** The semantic-arm twin of lookupFacts: identical survival/board floor
 * composition, but the merged search is the FUSED ladder+vector one. The
 * embedder loads lazily on this first call (never at boot); if it fails or
 * no pack carries vectors, searchDocsSemantic returns the keyword outcome
 * unchanged — same degrade contract as everything else in this file. */
export async function lookupFactsSemantic(
  args: LookupFactsArgs,
  limit = 2,
): Promise<DocSearchOutcome> {
  await ensureQueryEmbedder();
  const merged = await searchDocsSemantic({ query: args.topic }, limit);
  if (limit < 2 || merged.results.length === 0) {
    return merged;
  }
  const candidates: DocSearchOutcome['results'] = [];
  if (!merged.results.some(r => isBoard(r.pack_id))) {
    const board = searchDocs(
      {
        query: args.topic,
        pack_prefix: CAMP_PACK_PREFIX,
        revive_dead_terms: false,
      },
      1,
    );
    if (qualifies(board, merged)) {
      candidates.push(board.results[0]);
    }
  }
  if (!merged.results.some(r => r.pack_id === SURVIVAL_GUIDE_PACK_ID)) {
    const survival = searchDocs(
      {
        query: args.topic,
        pack_id: SURVIVAL_GUIDE_PACK_ID,
        revive_dead_terms: false,
      },
      1,
    );
    if (qualifies(survival, merged)) {
      candidates.push(survival.results[0]);
    }
  }
  return reserveSpecialties(merged, candidates, limit);
}

/**
 * THE SPECIALTY FLOORS, as one step any doc search can take: when a merged
 * search over every enabled pack has no camp-board row / no survival-guide
 * row, probe each specialty by itself and let a same-tier hit claim one slot.
 * Written for lookup_facts, where a tiny live board and the survival guide
 * would otherwise be buried under a large lore pack; now ALSO applied to an
 * unscoped search_docs (toolExecutor), because the model picks between the
 * two tools unreliably and the burying is the same either way. Owner phone,
 * 2026-08-17: "Tell me the history of burning Man" -> search_docs over 8,390
 * lore chunks + 79 guide chunks returned five lore threads (meal policies,
 * lost-and-found) and the guide's own history section never surfaced. A
 * pack-scoped search_docs (pack_id given) is left alone: the caller asked
 * for one pack.
 */
export function withSpecialtyFloors(
  merged: DocSearchOutcome,
  query: string,
  limit: number,
): DocSearchOutcome {
  if (limit < 2 || merged.results.length === 0) {
    return merged;
  }
  const candidates: DocSearchOutcome['results'] = [];
  if (!merged.results.some(r => isBoard(r.pack_id))) {
    const board = searchDocs(
      {
        query,
        pack_prefix: CAMP_PACK_PREFIX,
        revive_dead_terms: false,
      },
      1,
    );
    if (qualifies(board, merged)) {
      candidates.push(board.results[0]);
    }
  }
  if (!merged.results.some(r => r.pack_id === SURVIVAL_GUIDE_PACK_ID)) {
    const survival = searchDocs(
      {
        query,
        pack_id: SURVIVAL_GUIDE_PACK_ID,
        revive_dead_terms: false,
      },
      1,
    );
    if (qualifies(survival, merged)) {
      candidates.push(survival.results[0]);
    }
  }
  return reserveSpecialties(merged, candidates, limit);
}

/** FTS5/BM25 (LIKE fallback) over ALL enabled doc-bearing packs; top 2 with
 * headings (phone-latency tuning — see LOOKUP_FACTS_TOP_N). */
export function lookupFacts(args: LookupFactsArgs, limit = 2): DocSearchOutcome {
  const merged = searchDocs({ query: args.topic }, limit);
  return withSpecialtyFloors(merged, args.topic, limit);
}

export { docsResultJson as factsResultJson };
