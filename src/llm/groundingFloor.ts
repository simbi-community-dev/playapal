/**
 * The grounding floor's two pure helpers (LlamaSession forces the call; these
 * decide WHEN and WITH WHAT). Split out for direct testing.
 *
 * isFactualTurn: everything is factual except unmistakable smalltalk — the
 * floor's cost when it misfires is one lookup round, its cost when it FAILS
 * to fire is a confabulated answer with the app's voice behind it (the
 * 2026-08-18 Pixel session: "Burning Man began in 1988 at the Reno County
 * Fairgrounds"). Bias accordingly: short greetings, thanks, bare
 * acknowledgements and pure-emoji turns are exempt; questions are never
 * exempt, whatever their length.
 */
import { EVENT_REQUEST } from './eventClarification';

const SMALLTALK_RE =
  /^(hi+|hey+|hello+|yo|sup|howdy|thanks?( you| u)?|thank you|ty|ok(ay)?|k|cool|nice|great|awesome|lol|haha+|good (morning|evening|night|day)|gm|gn|bye|see ya|later|yes|no|yep|nope|sure)[!.,\s]*$/i;

export function isFactualTurn(userText: string): boolean {
  const t = userText.trim();
  if (t.length === 0) {
    return false;
  }
  if (EVENT_REQUEST.test(t)) {
    // The events machinery owns this shape (search_events routing + the
    // day-only clarification, which only arms on a tool-less turn).
    return false;
  }
  if (t.includes('?')) {
    return true;
  }
  if (SMALLTALK_RE.test(t)) {
    return false;
  }
  // Very short non-question fragments ("wow", "hmm ok") — let them pass
  // ungated only when they carry no letters beyond two words.
  if (t.length < 8 && t.split(/\s+/).length <= 2 && !/[A-Z]/.test(t.slice(1))) {
    return false;
  }
  return true;
}

/** The lookup topic = the question itself, minus pure question scaffolding.
 * searchDocs sanitizes + stems terms and OR-descends, so leaving nouns intact
 * matters more than trimming; only leading interrogative boilerplate goes. */
export function groundingTopic(userText: string): string {
  const t = userText.trim().replace(/\?+$/, '');
  const LEAD =
    /^(what|who|whats|who's|what's|when|where|why|how|is|are|was|were|does|do|did|can|could|will|should|about|the|a|an|tell me about|tell me)\s+/i;
  let stripped = t;
  for (let i = 0; i < 4; i++) {
    const next = stripped.replace(LEAD, '');
    if (next === stripped) {
      break;
    }
    stripped = next;
  }
  return (stripped.length >= 4 ? stripped : t).slice(0, 120);
}
