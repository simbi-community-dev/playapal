/**
 * SOURCE REFS — the answer's provenance, in the packs' own words.
 *
 * The retrieval layer already carries everything needed to say WHERE an
 * answer came from: searchDocs returns each passage with its pack name, its
 * source file and its heading breadcrumb, and the tool payload already ships
 * a query-focused excerpt of it to the model. Until now none of that reached
 * the screen — the asker saw prose and had to take it on faith. This module
 * turns one search outcome into the small set of refs the chat surfaces
 * (components/SourceChips), so an answer that used retrieval can be opened.
 *
 * THREE RULES, all owner-facing:
 *  1. HUMAN WORDS ONLY. The chip names the pack's DISPLAY NAME and the
 *     document's own heading. Pack ids ("dusty-star-lore-25y") and file names
 *     ("people-dusty-star.md") never leave this module — they are storage
 *     detail, and a provenance line that reads like a database row is
 *     exactly the register camp-voice rules out.
 *  2. THE EXCERPT IS THE MODEL'S. Opening a chip shows the same text the
 *     model was fed (docs/excerpt, the same cut the tool payload ships), not
 *     a fresh slice of the chunk — otherwise the chip answers "what does
 *     this document say" instead of "why did it say that".
 *  3. QUIET. At most MAX_SOURCE_REFS refs per answer. The point is one
 *     glance and one tap, never a wall of citations.
 *
 * MEMORIAL REGISTER: a passage that IS a memorial person card is flagged
 * here, structurally, by the same parse the person-card path trusts. The
 * chips read that flag and speak of the dead the way the camp does — see
 * components/SourceChips.
 */

import type { DocSearchOutcome, SourceRef } from '../types';
import { excerptForTerms } from './excerpt';
import { parsePersonCard } from '../facts/personCard';

/** Two is the usual lookup_facts payload; three is the ceiling a one-handed
 * glance can hold. search_docs' five would be the wall of citations. */
export const MAX_SOURCE_REFS = 3;

type Passage = DocSearchOutcome['results'][number];

/**
 * The document's own name for itself. The leaf of the heading breadcrumb is
 * what the pack author wrote ("Water", "Who is Marisol Vega?", "Camp board
 * — offers (Dusty)"); a headingless chunk falls back to its file name with
 * the storage chrome (extension, convention prefix, separators) taken off.
 */
function docLabel(passage: Passage): string {
  const segments = passage.heading
    .split('>')
    .map(part => part.trim())
    .filter(Boolean);
  const leaf = segments[segments.length - 1];
  if (leaf) {
    return leaf;
  }
  const plain = passage.source_file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^(?:people|about)-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : passage.pack_name;
}

/** One retrieved passage as the ref its chip renders from. */
export function sourceRef(passage: Passage, terms: string[] | undefined): SourceRef {
  return {
    id: `${passage.pack_id}:${passage.id}`,
    pack: passage.pack_name,
    doc: docLabel(passage),
    heading: passage.heading,
    passage: excerptForTerms(passage.content, terms),
    memorial: parsePersonCard(passage)?.memoriam != null,
  };
}

/** Every ref behind one doc-search outcome, in rank order, capped. */
export function sourceRefs(
  outcome: DocSearchOutcome,
  limit = MAX_SOURCE_REFS,
): SourceRef[] {
  return outcome.results.slice(0, limit).map(r => sourceRef(r, outcome.terms));
}

/** Merge refs across a turn's tool rounds: first mention of a passage wins
 * its rank, and the cap holds across the whole turn. */
export function mergeSourceRefs(
  refs: SourceRef[],
  limit = MAX_SOURCE_REFS,
): SourceRef[] {
  const seen = new Set<string>();
  const merged: SourceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id) || merged.length >= limit) {
      continue;
    }
    seen.add(ref.id);
    merged.push(ref);
  }
  return merged;
}
