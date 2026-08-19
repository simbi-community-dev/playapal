/** Structured event rows are authoritative. Replace only absolute generated
 * denials; qualified alternatives and positive narration pass through. */
export function reconcileEventNarration(text: string, eventCount: number): string {
  if (eventCount === 0) {
    return text;
  }
  const qualified = /\b(?:but|however)\b[\s\S]*\b(?:found|here(?:'s| are)|event)/i;
  if (qualified.test(text)) {
    return text;
  }
  const denial = [
    /\b(?:i\s+)?(?:could(?:n['’]t| not)|can(?:n?ot|['’]t| not)|did(?:n['’]t| not))\s+(?:find|locate|access)\b[\s\S]*\b(?:events?|anything|matches?)\b/i,
    /\bno\s+(?:matching\s+)?events?\s+(?:were\s+)?(?:found|available|listed|scheduled|matched)\b/i,
    /\bthere\s+(?:are|were)\s+no\s+(?:matching\s+)?events?\b/i,
    /\bi\s+(?:do not|don't)\s+have\s+access\b[\s\S]*\bevents?\b/i,
  ].some(pattern => pattern.test(text));
  if (!denial) {
    return text;
  }
  return eventCount === 1
    ? 'I found 1 event in the offline guide.'
    : `I found ${eventCount} events in the offline guide.`;
}
