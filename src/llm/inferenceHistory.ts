/** Compact no-tool inability answers poison small-model context: the next
 * question can copy them verbatim instead of routing. Keep them in the field
 * log/transcript, but mark them for omission from later inference. */
export function isNoToolFailure(text: string, toolRounds: number): boolean {
  if (toolRounds > 0) {
    return false;
  }
  const compact = text.trim();
  if (compact.length === 0 || compact.length > 280) {
    return false;
  }
  return [
    /\bi\s+(?:do not|don't)\s+(?:know|remember|recognize)\b/i,
    /\bi\s+(?:do not|don't)\s+have\s+(?:access|information|details|a record|anything)\b/i,
    /\bi\s+(?:can(?:n?ot|['’]t)|could(?:n['’]t| not))\s+(?:find|tell|answer|help|locate|recall|access)\b/i,
    /\bi(?:'m| am)\s+not\s+sure\b/i,
    /\bi\s+have\s+no\s+(?:information|details|record|way)\b/i,
    /\b(?:no idea|not enough information|nothing (?:in|about) my (?:guides|packs))\b/i,
  ].some(pattern => pattern.test(compact));
}

/** Meta follow-ups need the failure they explicitly refer to. */
export function refersToPriorFailure(text: string): boolean {
  return [
    /\bwhy\s+(?:could(?:n['’]t| not)|can(?:n?ot|['’]t| not)|did(?:n['’]t| not)|not)\b/i,
    /\bwhat\s+do\s+you\s+mean\b/i,
    /\b(?:that|your)\s+(?:answer|response|refusal|failure)\b/i,
    /\btry\s+(?:that|it)\s+again\b/i,
  ].some(pattern => pattern.test(text));
}
