import { splitClauses } from './historyIntent';

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
const SMALLTALK_RE =
  /^(hi+|hey+|hello+|yo|sup|howdy|thanks?( you| u)?|thank you|ty|ok(ay)?|k|cool|nice|great|awesome|lol|haha+|good (morning|evening|night|day)|gm|gn|bye|see ya|later|yes|no|yep|nope|sure)[!.,\s]*$/i;

const CREATIVE_REQUEST =
  /^(?:(?:say|write|sing|compose|recite|make up|invent|imagine)(?:\s+(?:me|us))?\s+(?:(?:a|an|some|your)\s+)?(?:[\p{L}\p{N}'-]+(?:,\s*|\s+)){0,3}(?:story|poem|haiku|song|verse|joke|toast|blessing|riddle)|say\s+something\s+(?:poetic|funny|beautiful|weird)|tell (?:me|us)\s+(?:a|an|some|your)\s+(?:story|poem|haiku|song|verse|joke|toast|blessing|riddle)|(?:make|keep)\s+(?:it|that)\s+(?:poetic|funny|beautiful|weird))\b/iu;

function isCreativeClause(clause: string): boolean {
  const text = clause.trim();
  const match = CREATIVE_REQUEST.exec(text);
  if (!match) {
    return false;
  }
  const remainder = text.slice(match[0].length).trim();
  return remainder.length === 0 ||
    /^(?:about|for|in\s+the\s+style\s+of|with\s+(?:a|an|some))\b/i.test(remainder);
}

export function isFactualTurn(userText: string): boolean {
  const t = userText.trim();
  if (t.length === 0) {
    return false;
  }
  if (t.includes('?')) {
    // ...unless the question has nothing to LOOK UP: a bare-pronoun
    // follow-up ("Where is it?", "What about that?") grounds on an
    // antecedent the retrieval layer cannot see, and forcing lookup_facts
    // on the pronoun buries the model's honest ask-for-the-name — which
    // is the right answer when nothing upstream anchored the reference
    // (Angel-batch integration, 2026-08-25: the reserved-follow-up path
    // answers the ANCHORED case deterministically before the model; this
    // exemption is only ever reached by the unanchored one).
    // Strip interrogative scaffolding REPEATEDLY (groundingTopic strips one
    // leading token; "Where is it" needs two passes to reach the pronoun).
    const STOP =
      /^(what|whats|what's|who|who's|whos|when|where|why|how|is|are|was|were|does|do|did|can|could|will|would|should|about|the|a|an|tell|me|us)$/i;
    const words = t
      .replace(/\?+$/, '')
      .split(/\s+/)
      .filter(w => w.length > 0);
    while (words.length > 0 && STOP.test(words[0])) {
      words.shift();
    }
    const topic = words.join(' ');
    if (
      topic.length < 3 ||
      /^(it|that|this|those|these|they|them|he|she|there|one)$/i.test(topic)
    ) {
      return false;
    }
    return true;
  }
  if (SMALLTALK_RE.test(t)) {
    return false;
  }
  // An imperative earns the generation exemption from the OBJECT it asks for,
  // not its opening verb. Every compound clause must be creative; one factual
  // obligation makes the whole turn factual and therefore grounded.
  const clauses = splitClauses(t);
  if (clauses.length > 0 && clauses.every(isCreativeClause)) {
    return false;
  }
  // A bare calendar word is an ANSWER to a clarification, not a topic —
  // "Wednesday" fed to lookup_facts retrieves nothing a camper meant, and
  // the clarified-event flow upstream already consumed the real intent.
  if (
    /^(sun|mon|tues|wednes|thurs|fri|satur)day$/i.test(t) ||
    /^(today|tonight|tomorrow|yesterday)$/i.test(t)
  ) {
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
