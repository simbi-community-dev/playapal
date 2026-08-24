/**
 * Content-anchor recovery for lookup_facts topics — the untrusted-hint
 * pattern search_events already uses for its `day` slot, applied to the
 * topic: the executor trusts the user's raw question over the model's slot
 * extraction for the signal the 2.6B measurably drops.
 *
 * Device-measured failure (lore-reachability round, 2026-08-14): "what
 * classic car did Brook offer for the 2010 filming?" → topic "classic car
 * offered" — the proper noun AND the year are gone, and without them the
 * right lore thread cannot outrank 8k chunks of camp email. The field
 * report had already named topic extraction the secondary hit behind the
 * scope pin ("look camp memory", "camp documents say").
 *
 * Rule: append to the topic, in question order, the raw question's
 * mid-sentence Capitalized words (proper nouns; sentence-initial and
 * stopword-shaped ones excluded via sanitizeKeywords) and 4-digit years
 * that the topic does not already carry, capped at 3 so the 6-term
 * sanitize budget keeps room for the model's own words. Strictly additive:
 * a topic that already carries its anchors is returned unchanged, and a
 * noise anchor ("my friend Dave asked…") costs one extra AND term that the
 * ladder's OR rungs + the survival floor absorb.
 */

import { sanitizeKeywords } from '../events/ftsQuery';

const MAX_ANCHORS = 3;

export function anchorTopic(topic: string, rawUserText: string): string {
  const raw = rawUserText ?? '';
  if (!raw.trim()) {
    return topic;
  }
  const seen = new Set(
    `${topic}`.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean),
  );
  const tokens = raw.split(/\s+/);
  const anchors: string[] = [];
  for (let i = 0; i < tokens.length && anchors.length < MAX_ANCHORS; i++) {
    const w = tokens[i].replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
    if (!w) {
      continue;
    }
    const isYear = /^(?:19|20)\d{2}$/.test(w);
    // Proper noun = Capitalized-not-sentence-initial. The first token is
    // always suspect ("What…"); a capital after ".!?" is a new sentence.
    const prev = i > 0 ? tokens[i - 1] : '';
    const sentenceInitial = i === 0 || /[.!?]$/.test(prev);
    const isProper = !sentenceInitial && /^[A-Z][a-z]+$/.test(w);
    if (!isYear && !isProper) {
      continue;
    }
    const lower = w.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    // Stopword-shaped capitals ("Is", "The") carry no anchor signal.
    if (!isYear && sanitizeKeywords(lower).length === 0) {
      continue;
    }
    seen.add(lower);
    anchors.push(w);
  }
  return anchors.length ? `${topic} ${anchors.join(' ')}`.trim() : topic;
}
