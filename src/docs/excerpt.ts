/**
 * QUERY-FOCUSED EXCERPTING — the passage text that actually reaches a reader.
 *
 * Lifted out of searchDocs so it stays a PURE string function with no
 * database import behind it: the tool payload cuts passages with it, and so
 * do the source chips (docs/sourceRef), which run in the UI layer and must
 * carry the model's exact excerpt, not a re-cut of the chunk.
 */

/** The tool-payload budget per passage. Phone-latency tuning: ~700 chars ≈
 * 175 tokens of round-2 prefill per passage on the Pixel 7. */
const EXCERPT_BUDGET = 700;

/**
 * QUERY-FOCUSED excerpting (lore-reachability round, device-measured): the
 * old head-slice (`content.slice(0, 697)`) fed the model the FIRST 700
 * chars of a chunk — for email-thread lore chunks that is thread metadata,
 * and the fact that made the chunk rank sat past the cut (Brook's car at
 * offset 1112 of 1643: retrieval returned the right chunk, the model saw
 * none of the answer and honestly IDK'd — chat_log rows 172-175). Every v4
 * technique chunk was also shipping WITHOUT its credit line (Credit: at
 * ~1200 of ~1300, always cut), silently defeating the nudge's attribution
 * sentence.
 *
 * The window with the most query-term hits (4-char-prefix tolerant, the
 * ladder's own matching grain) wins, snapped back to a whitespace boundary,
 * ellipsized on the cut sides. A Credit: line outside the window is
 * APPENDED — attribution is licensing intent, never latency ballast. Chunks
 * within budget pass through byte-identical.
 */
export function excerptForTerms(
  content: string,
  terms: string[] | undefined,
  budget = EXCERPT_BUDGET,
): string {
  if (content.length <= budget) {
    return content;
  }
  const lower = content.toLowerCase();
  const positions: number[] = [];
  for (const t of terms ?? []) {
    const needle = t.length > 4 ? t.slice(0, 4).toLowerCase() : t.toLowerCase();
    if (!needle) {
      continue;
    }
    let at = lower.indexOf(needle);
    while (at !== -1) {
      positions.push(at);
      at = lower.indexOf(needle, at + needle.length);
    }
  }
  const body = budget - 3; // room for the trailing '...'
  let start = 0;
  if (positions.length > 0) {
    positions.sort((a, b) => a - b);
    let best = -1;
    for (const p of positions) {
      const s = Math.min(Math.max(0, p - 150), content.length - body);
      const hits = positions.filter(q2 => q2 >= s && q2 < s + body).length;
      if (hits > best) {
        best = hits;
        start = s;
      }
    }
    // Snap to a whitespace boundary so the excerpt starts on a word.
    if (start > 0) {
      const ws = content.lastIndexOf('\n', start);
      const sp = content.indexOf(' ', start);
      if (ws >= start - 80 && ws > 0) {
        start = ws + 1;
      } else if (sp !== -1 && sp < start + 40) {
        start = sp + 1;
      }
    }
  }
  const end = Math.min(content.length, start + body);
  let text =
    (start > 0 ? '…' : '') +
    content.slice(start, end) +
    (end < content.length ? '...' : '');
  // The credit line always rides (see doc-comment). Tolerates markdown
  // emphasis/bullet prefixes: the v4 chunks write "*Credit: [Burn.Life — …]".
  const credit = content.match(/^[\s*_>-]*(Credit: .*?)[*_\s]*$/m);
  if (credit && !text.includes(credit[1].slice(0, 40))) {
    text += `\n${credit[1].slice(0, 200)}`;
  }
  return text;
}
