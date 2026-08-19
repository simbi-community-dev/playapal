/**
 * Deterministic tool dispatch for the chat loop. Extracted from LlamaSession
 * so routing can be unit-tested without llama.rn or SQLite (the executors are
 * mockable module imports).
 *
 * Every tool returns a ToolOutcome: the JSON fed back to the model, the
 * app-owned structured cards, and a `shrink` rebuilder
 * for the context-overflow retry (iBurn withContextWindowRetry pattern).
 */

import type { ToolCall } from 'llama.rn';
import type { ChatCard, PersonRef, SourceRef } from '../types';
import { searchEvents, toolResultJson } from '../events/searchEvents';
import { searchDocs, docsResultJson } from '../docs/searchDocs';
import { sourceRefs } from '../docs/sourceRef';
import { lookupFactsSemantic, factsResultJson, withSpecialtyFloors } from '../facts/lookupFacts';
import { anchorTopic } from '../facts/anchorTopic';
import {
  lookupHistory,
  type HistoryAbsence,
  type HistoryAmbiguity, HISTORY_QUERIES } from '../facts/historyLookup';
import { personCardFromResults } from '../facts/personCard';
import { identityToolArgs } from './identityIntent';
import { resolvePersonArgument } from './priorPerson';

/** lookup_facts returns the top 3 survival-guide chunks (with headings). */
/** Phone-latency tuning (owner field report 2026-08-13: a 30 s tooled turn
 * felt long): 2 chunks instead of 3 cuts the tool-result prefill the model
 * re-reads before answering; the retrieval suite shows the right chunk ranks
 * first or second for the eval's fact questions. */
export const LOOKUP_FACTS_TOP_N = 3;
// 2 -> 3 on 2026-08-17 WITHOUT raising the token budget: the guide is now
// chunked at the 700-char excerpt budget (avg chunk ~430 chars, none cut),
// so three whole passages cost what two windowed ones did (~1,300 chars) and
// carry complete facts instead of the best 700-char window of a 1,500-char
// section. Imported packs keep 2,000-char chunks and get their excerpts;
// the phone-latency reasoning above still holds per token.

export interface ToolOutcome {
  json: string;
  cards: ChatCard[];
  /** The passages this call put under the answer, for the tappable source
   * chips. Only the doc-retrieval tools carry them: event and relational
   * answers already render their own rows with their own evidence. */
  sources?: SourceRef[];
  /** Rebuild the result with fewer candidates (context-overflow retry). */
  shrink: (
    limit: number,
  ) => Promise<{ json: string; cards: ChatCard[]; sources?: SourceRef[] }>;
  /** The person this call proved the packs do NOT cover. Set only for an
   * identity question whose lookup came back with zero passages — a KNOWABLE
   * absence, which the turn must voice plainly (LlamaSession.runTurn). */
  noCoverage?: string;
  /** A doc lookup RAN and came back with nothing. The turn's own honest
   * close reads off this: "found nothing in your packs" is a fact this call
   * established, and it must never be dressed up as a shrug. */
  emptyLookup?: boolean;
  /** The camper this call matched EXACTLY in the fact graph. The session
   * keeps it as the anchor a later pronoun binds to (llm/priorPerson). */
  resolvedPerson?: PersonRef;
  /** A CAMP-HISTORY lookup ran and the camp pack carries nothing for it —
   * the sibling of `noCoverage`, for the relational half. Kept structured
   * rather than as one entity string because the honest sentence depends on
   * what was asked (llm/factNarration.campHistoryAbsenceNarration). */
  historyAbsence?: HistoryAbsence;
  /** Multiple exact people matched a history slot. Candidate choice belongs to
   * the asker, never to retrieval rank or model prose. */
  historyAmbiguity?: HistoryAmbiguity;
}

/**
 * HONEST ABSENCE. `{"count":0,"passages":[]}` is a shrug, and a 2.6B is free
 * to narrate over a shrug — which is how "Who is Coco" became a camp in the
 * 9:00 sector. When an identity question's lookup returns nothing, the tool
 * result says so in words and names the person, so the only faithful
 * completion is the honest one. Empty results for any other question keep
 * today's payload byte-for-byte.
 */
export function noCoverageJson(entity: string): string {
  return JSON.stringify({
    count: 0,
    passages: [],
    status: 'no_coverage',
    entity,
    instruction:
      `Nothing in the traveler's packs covers ${entity}. Say plainly that ` +
      `you have nothing about ${entity} in the packs they are carrying. ` +
      `Never describe, place, or guess at ${entity}.`,
  });
}

export async function executeTool(
  call: ToolCall,
  rawUserText: string,
  /** The person this session last resolved, for a question that refers to
   * them by pronoun ("who sponsored her?"). Null on a fresh session, and
   * null means every slot is read exactly as it is written. */
  personAnchor: PersonRef | null = null,
  affiliations: readonly string[] = [],
): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    const parsed =
      typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : call.function.arguments;
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed arguments: run with empty args rather than crash the turn.
  }
  if (call.function.name === 'lookup_history' && personAnchor) {
    for (const slot of ['entity', 'target'] as const) {
      if (typeof args[slot] !== 'string') {
        continue;
      }
      const resolved = resolvePersonArgument(args[slot] as string, personAnchor);
      if (resolved.anchored) {
        args = { ...args, [slot]: resolved.value, pack_id: resolved.pack_id };
      }
    }
  }
  switch (call.function.name) {
    case 'search_events': {
      const run = async (limit: number) => {
        const outcome = await searchEvents(
          { query: String(args.query ?? ''), day: args.day ? String(args.day) : undefined },
          rawUserText,
        );
        const results = outcome.results.slice(0, limit);
        return {
          json: toolResultJson({ ...outcome, results }),
          cards: results.map(event => ({ kind: 'event' as const, event })),
        };
      };
      const full = await run(5);
      return { ...full, shrink: run };
    }
    case 'search_docs': {
      const run = async (limit: number) => {
        const query = String(args.query ?? '');
        const packId = args.pack_id ? String(args.pack_id) : undefined;
        const raw = searchDocs({ query, pack_id: packId }, limit);
        // Unscoped search gets the same specialty floors lookup_facts has:
        // a same-tier survival-guide / camp-board hit claims one of the
        // slots instead of drowning under a big lore pack (see
        // withSpecialtyFloors). A pack-scoped search is the caller's choice.
        const outcome = packId ? raw : withSpecialtyFloors(raw, query, limit);
        // The model may reach a people-pack card through THIS tool too (it
        // picks between search_docs and lookup_facts unreliably — the whole
        // reason identityIntent exists). Same card path, same two gates: a
        // "who is X" answer is a card here as well, never bare prose.
        const person = personCardFromResults(
          outcome.results,
          rawUserText,
          personAnchor,
          affiliations,
        );
        return {
          json: docsResultJson(outcome),
          cards: person ? [person] : [],
          sources: sourceRefs(outcome),
          emptyLookup: outcome.results.length === 0,
        };
      };
      const full = await run(5);
      return { ...full, shrink: run };
    }
    case 'lookup_facts': {
      // The topic is an untrusted hint (same as search_events' day slot):
      // re-anchor it with the proper nouns/years the model dropped from the
      // user's own question (device-measured — see anchorTopic.ts).
      const topic = anchorTopic(String(args.topic ?? ''), rawUserText);
      // The person the asker named, read off their own words by the same
      // deterministic parse that pre-routes this call upstream. Non-null only
      // for an identity question — the gate on the no-coverage payload.
      // "tell me about her" IS "tell me about Coco" once the anchor is bound:
      // the app resolved that pronoun itself, one turn after rendering her
      // card. Both this gate and the card gates below read the same anchor.
      const named = identityToolArgs(
        rawUserText,
        personAnchor,
        affiliations,
      )?.topic ?? null;
      const run = async (limit: number) => {
        // The semantic-arm path: fused keyword+vector when the embedder is
        // wired, plain keyword ladder when it is not (same degrade contract).
        const outcome = await lookupFactsSemantic({ topic }, limit);
        // Person-identity questions leave the model's mouth entirely: when
        // the top passage IS a people-pack card for someone the asker
        // named, the app renders it (device-measured false IDK over exactly
        // this passage — see facts/personCard.ts). Anything else keeps the
        // prose path byte-for-byte.
        const person = personCardFromResults(
          outcome.results,
          rawUserText,
          personAnchor,
          affiliations,
        );
        // A named person with nothing behind them is a knowable absence, not
        // an empty search: say so, and never let it read as a shrug.
        const absent = named !== null && outcome.results.length === 0 ? named : null;
        return {
          json: absent ? noCoverageJson(absent) : factsResultJson(outcome),
          cards: person ? [person] : [],
          // The chips show what the model read: the same passages, the same
          // excerpts, in the same rank order.
          sources: sourceRefs(outcome),
          noCoverage: absent ?? undefined,
          emptyLookup: outcome.results.length === 0,
        };
      };
      const full = await run(LOOKUP_FACTS_TOP_N);
      return { ...full, shrink: run };
    }
    case 'lookup_history': {
      // THE FREE-TEXT FALLBACK. lookup_history's `query` is an enum, but three
      // sibling tools use `query` for free text and the v4.0 model never saw
      // this tool in training, so it writes lookup_history(query='shade
      // structure', entity='camp') — twice, then answers from nothing (owner
      // phone, 2026-08-17). The intent was plainly a search. When the enum
      // rejects the value and no deterministic parse of the user's own text
      // rescued it upstream, run the words through search_docs and hand the
      // model passages instead of an error it cannot act on. An honest
      // relational miss (valid enum, no records) is left exactly as it is.
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const enumOk = (HISTORY_QUERIES as readonly string[]).includes(q);
      if (q && !enumOk) {
        const words = [q, typeof args.entity === 'string' ? args.entity : '']
          .filter(Boolean)
          .join(' ');
        const run = async (limit: number) => {
          const raw = searchDocs({ query: words }, limit);
          const outcome = withSpecialtyFloors(raw, words, limit);
          const person = personCardFromResults(outcome.results, rawUserText, personAnchor, affiliations);
          return {
            json: JSON.stringify({
              note: `lookup_history takes one of ${HISTORY_QUERIES.join('|')}; searched the packs for "${words}" instead`,
              ...JSON.parse(docsResultJson(outcome)),
            }),
            cards: person ? [person] : [],
            sources: sourceRefs(outcome),
            emptyLookup: outcome.results.length === 0,
          };
        };
        const full = await run(5);
        return { ...full, shrink: run };
      }
      const full = lookupHistory(args);
      const stable = { json: full.json, cards: full.cards };
      return {
        ...stable,
        shrink: async () => stable,
        resolvedPerson: full.resolvedPerson,
        historyAbsence: full.absence,
        historyAmbiguity: full.ambiguity,
      };
    }
    default: {
      const fallback = {
        json: JSON.stringify({ error: `unknown tool: ${call.function.name}` }),
        cards: [] as ChatCard[],
      };
      return { ...fallback, shrink: async () => fallback };
    }
  }
}
