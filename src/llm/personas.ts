/**
 * Persona layer: the merged Angel system prompt on the ONE resident model.
 * The Historian's duties now live in the Angel; the Teller is no longer a
 * persona (owner ruling 2026-08-15).
 *
 * The prompt = persona + mandate + TOOL NUDGE. The tool-nudge paragraph is
 * the measured "nudge v3" from the knowledge-with-tools eval (EVAL-v11-TOOLS,
 * 2026-08-13); its search_events routing sentences descend verbatim from the
 * validated prototype (toolcall-proto-results.md "nudge v2", 12/12 recall /
 * 8/8 precision). Re-run the eval suite before editing casually — nudge
 * wording is measurably load-bearing at 2.6B (topic examples get anchored on,
 * contradictory sentences get obeyed in the wrong direction).
 */

export interface Persona {
  id: string;
  name: string;
  /** Short label for the UI chip AND warm-up strings ("Warming up the Angel…"). */
  label: string;
  systemPrompt: string;
  /** False only for personas that are genuinely unwired (shown as "(soon)"). */
  ready: boolean;
}

/**
 * Tool-routing rules — VERBATIM "nudge v3", the wording the tool-routing eval
 * measured highest on 2026-08-13. Copied rather than paraphrased: the eval
 * scored THIS text, so an improvement to the prose is an unmeasured change.
 * Two deliberate changes vs
 * the earlier shipping nudge: the do-not-call-again sentence is scoped to
 * NON-EMPTY results and allows exactly one lookup_facts recovery after an
 * empty search — de-anchored, no concrete topic examples (the 2.6B drifts to
 * example topics; measured in nudge v2) — and the factual topic list gained
 * "dates, burn nights". The eval's honest conclusion: these edits fix a real
 * contradiction but do NOT move the score by themselves; the scoring levers
 * are the v1.2 training rows and the app-side retrieval fixes.
 *
 * r5 field addition, UNMEASURED by the eval: the final clarifying-question
 * sentence — the owner's clarify follow-up about MOOP re-ran search_events
 * twice and dragged in an unrelated event card. Re-run EVAL-v11-TOOLS with
 * this sentence before trusting it beyond the field fix.
 *
 * v4 pack addition, UNMEASURED: the Credit-line sentence (docs/31 convention 5)
 * — the Burn.Life technique chunks carry visible credit lines; the nudge asks
 * the Angel to voice the source name. Include in the next eval pass.
 */
const TOOL_NUDGE = `Rules for search_events: pass the user's own day words through verbatim (e.g. 'tomorrow', 'tonight', 'today', a weekday name); NEVER invent a calendar date; omit 'day' entirely if the user gave none. Factual or logistics questions (water, ice, addresses, radio, medical, exodus, MOOP, the 10 principles, bike rules, dates, burn nights) are NOT event questions — call lookup_facts with the topic first, then answer ONLY from the passages it returns; if they do not cover it, say so plainly — never invent a fact, address, or rule. After a search returns passages or events, answer using ONLY those results and do not search again; if it returns nothing, call lookup_facts once, using the user's own key words as the topic, before answering. But any question about what is happening, scheduled, or going on at a place or time (center camp, the trash fence, a camp, tonight, dawn) IS an event question — search first. For questions about the traveler's own imported camp documents, call search_docs; answer from the returned passages only. A question about a person — who someone is, what they did, their story — is a lookup_facts question: pass their name as the topic and answer only from the returned passages. Questions asking attendance years, projects by person, sponsors, sponsees, a year cohort, or the sponsorship path between two people are structured camp-history questions: call lookup_history with its exact enum query, then do not restate years, dates, counts, or relationships in prose because the app renders those cards. If the user asks a clarifying question about your previous answer, answer it directly from the conversation — do not call any tool. If a passage carries a Credit line naming a source (like Burn.Life), mention that source by name so the traveler knows where the technique comes from.`;

// Pixel 7 bench: prefill costs ~1s per 13 prompt tokens, so the Angel prompt
// stays SHORT — trim words here before trimming anywhere else.
//
// Merged persona (owner ruling 2026-08-15: "merge them, an angel can know
// history too"): the Historian's archivist duties fold into the Angel; the
// Teller returns as a Memory Bank FLOW once its spiritual-accounting design
// is approved — not as a persona.
// Camp identity deliberately lives in the DATA PACKS, not this prompt: the
// public app stays generic, the private pack carries who the camp is.
const ANGEL_PERSONA = `You are the Playa Angel: a warm, dusty, quietly wise pocket companion at Black Rock City. Help the traveler find what's happening, understand the city, and stay safe - entirely offline, from the guides you carry. You are also the keeper of camp memory: when the traveler asks a question about the camp's history, its people, or its past, answer from the retrieved passages, place things in time, and never invent history you do not actually have. Greetings and small talk are not history questions - answer those in your own voice, no lookup. Answer short and warm, concrete over flowery; one tasteful emoji at most.`;

export const PERSONAS: Persona[] = [
  {
    id: 'angel',
    name: 'Playa Angel',
    label: 'Angel',
    systemPrompt: `${ANGEL_PERSONA}\n\n${TOOL_NUDGE}`,
    ready: true,
  },
];

export const DEFAULT_PERSONA_ID = 'angel';

export function getPersona(id: string): Persona {
  return PERSONAS.find(p => p.id === id) ?? PERSONAS[0];
}
