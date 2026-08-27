/**
 * Narrow field router and deterministic slot filler for structured camp-history
 * questions. The model still selects lookup_history; once selected, these
 * confidently parsed slots replace small-model drift outside the enum schema.
 *
 * PRONOUNS RESOLVE AGAINST THE SESSION'S ANCHOR (llm/priorPerson). The device
 * receipt: "Who is Coco" rendered Coco's card, then "who sponsored her?"
 * filled entity:"her" — a camper who does not exist, so the lookup could only
 * fail. Pass the anchor and a bare third-person pronoun becomes the person the
 * app itself last resolved; pass null (or run a session that has resolved
 * nobody) and every slot is filled exactly as it is today.
 */
import type { PersonRef } from '../types';
import { resolvePersonArgument } from './priorPerson';

export type HistoryToolArgs =
  | { query: 'attendance'; entity: string; year?: number; pack_id?: string }
  | { query: 'projects' | 'sponsors' | 'sponsees'; entity: string; pack_id?: string }
  | { query: 'cohort'; year: number }
  | { query: 'path'; entity: string; target: string; pack_id?: string };

function person(value: string, anchor: PersonRef | string | null) {
  return resolvePersonArgument(
    value.trim().replace(/^["']|["']$/g, ''),
    anchor,
  );
}

function personArgs(value: string, anchor: PersonRef | string | null) {
  const resolved = person(value, anchor);
  return {
    entity: resolved.value,
    ...(resolved.pack_id ? { pack_id: resolved.pack_id } : {}),
  };
}

function pathArgs(left: string, right: string, anchor: PersonRef | string | null) {
  const from = person(left, anchor);
  const to = person(right, anchor);
  return {
    entity: from.value,
    target: to.value,
    ...(from.pack_id || to.pack_id ? { pack_id: from.pack_id ?? to.pack_id } : {}),
  };
}

/**
 * COMPOUND QUESTIONS AND SENTENCE-LOCAL PRONOUNS (owner phone test,
 * 2026-08-17 07:45): "Who is pug and who has he sponsored" matched nothing
 * here — every shape below is anchored to the whole string — so it fell to
 * the model, which called lookup_history(query='pug') (three sibling tools
 * use `query` for free text; a 2.6B model generalizes) and then, with the
 * camp pack absent, said "Pug is a dog, not a person". Two people-question
 * classes were missing, not one question:
 *   - a relational clause after "and"/","/";" — split into clauses and try
 *     each (whole string first, so every existing shape keeps its behavior);
 *   - a bare pronoun whose antecedent is EARLIER IN THE SAME SENTENCE ("who
 *     is X and who has HE sponsored"), which the session anchor cannot know
 *     on a fresh conversation. The antecedent is the identity topic of a
 *     preceding clause ("who is X" / "about X"); if none, the pronoun stays
 *     unresolved and the clause yields null, exactly as before.
 * The tense/aspect variants ("who has X sponsored", "whom did X sponsor",
 * "who has sponsored X") are added below the originals for the same reason:
 * the phrasing a person actually types, not the one the regex author did.
 */
const CLAUSE_SPLIT =
  /\s*(?:,|;|[?!.]|\band\b|\bthen\b|\balso\b)\s+(?=(?:who|whom|what|which|when|where|how|did|does|do|has|have|had|is|are|was|were|show|list|find|tell|give|provide|say|write|explain|describe|make|keep)\b)/i;

const ABBREVIATION_PERIOD =
  /\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sr|Jr|St)\./gi;
const PROTECTED_PERIOD = '';

export function splitClauses(text: string): string[] {
  return text
    .replace(ABBREVIATION_PERIOD, value =>
      `${value.slice(0, -1)}${PROTECTED_PERIOD}`
    )
    .trim()
    .replace(/[?!.]+$/g, '')
    .split(CLAUSE_SPLIT)
    .map(c => c
      .replaceAll(PROTECTED_PERIOD, '.')
      .trim()
      .replace(/[,;:]+$/g, '')
      .trim()
    )
    .filter(Boolean);
}

const PRONOUN = /^(?:he|him|his|she|her|hers|they|them|their|theirs)$/i;

/** The identity topic of a clause ("who is X", "tell me about X", "what do
 * you know about X"), used only as a same-sentence pronoun antecedent. */
function clauseTopic(clause: string): string | null {
  const m =
    clause.match(/^who(?:\s+(?:is|was)|['’]?s)\s+(.+)$/i) ??
    clause.match(/^(?:tell\s+me\s+(?:a\s+bit\s+|more\s+)?about|what\s+do\s+you\s+know\s+about)\s+(.+)$/i);
  if (!m) {
    return null;
  }
  const topic = m[1].trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  return topic && !PRONOUN.test(topic) ? topic : null;
}

export interface HistoryToolPlan {
  args: HistoryToolArgs;
  rawUserText: string;
}

export function historyToolPlans(
  text: string,
  anchor: PersonRef | string | null = null,
): HistoryToolPlan[] {
  const split = splitClauses(text);
  const clauses = split.length > 1 ? split : [text];
  return clauses.reduce<HistoryToolPlan[]>((plans, clause, index) => {
    // A pronoun in clause i resolves to the nearest earlier identity topic
    // when the session has no anchor; an existing session anchor still wins.
    const localAnchor = anchor ?? clauses
      .slice(0, index)
      .reverse()
      .map(clauseTopic)
      .find((topic): topic is string => topic !== null) ?? null;
    const args = historyToolArgsOneClause(clause, localAnchor);
    const unresolvedCompoundPronoun =
      clauses.length > 1 &&
      args !== null &&
      'entity' in args &&
      PRONOUN.test(args.entity);
    return args && !unresolvedCompoundPronoun
      ? [...plans, { args, rawUserText: clause }]
      : plans;
  }, []);
}

export function historyToolArgs(
  text: string,
  anchor: PersonRef | string | null = null,
): HistoryToolArgs | null {
  return historyToolPlans(text, anchor)[0]?.args ?? null;
}

function historyToolArgsOneClause(
  text: string,
  anchor: PersonRef | string | null,
): HistoryToolArgs | null {
  const q = text.trim().replace(/[?!.]+$/g, '').trim();
  let m = q.match(/(?:sponsorship\s+)?(?:path|connection)\s+between\s+(.+?)\s+and\s+(.+)$/i);
  if (m) {
    return { query: 'path', ...pathArgs(m[1], m[2], anchor) };
  }
  m = q.match(/^how (?:is|are) (.+?) (?:and|to) (.+?) connected$/i);
  if (m) {
    return { query: 'path', ...pathArgs(m[1], m[2], anchor) };
  }

  m = q.match(/\b(\d{4})\s+cohort\b/i) ?? q.match(/\bcohort(?:\s+for|\s+in)?\s+(\d{4})\b/i);
  if (m) {
    return { query: 'cohort', year: Number(m[1]) };
  }

  m = q.match(/^who (?:sponsored|sponsors) (.+)$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^who (?:was|is) (.+?) sponsored by$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^who (?:is|was) (.+?)(?:'s|’s) sponsor$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^(?:what is )?(?:the )?(?:sponsorship\s+)?(?:lineage|sponsors?|ancestors?) (?:of|for) (.+)$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }

  m = q.match(/^who(?:m)? did (.+?) sponsor$/i);
  if (m) {
    return { query: 'sponsees', ...personArgs(m[1], anchor) };
  }
  // Tense/aspect variants (owner phrasing, 2026-08-17). Subject position
  // decides direction: "who has X sponsored" asks for X's sponsees; "who has
  // sponsored X" asks for X's sponsors.
  m = q.match(/^who(?:m)? (?:has|have|had|does|do) (?!sponsor|been\b)(.+?) (?:sponsored|sponsor|brought in|brought|vouched for)$/i);
  if (m) {
    return { query: 'sponsees', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^who(?:m)? (?:has|have|had) (?:been )?(?:sponsored|sponsoring|brought in|vouched for) (.+)$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^who(?:m)? did (.+?) (?:bring in|bring|vouch for)$/i);
  if (m) {
    return { query: 'sponsees', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^who (?:brought in|brought|vouched for) (.+)$/i);
  if (m) {
    return { query: 'sponsors', ...personArgs(m[1], anchor) };
  }
  m =
    q.match(/^(?:show|list|find)\s+(.+?)\s+sponsees?$/i) ??
    q.match(/^(?:show|list|find)?\s*(?:the )?(?:sponsees?|descendants?) (?:of|for) (.+)$/i);
  if (m) {
    return { query: 'sponsees', ...personArgs(m[1], anchor) };
  }

  m = q.match(/^(?:which|what) years? did (.+?) attend(?: camp)?$/i);
  if (m) {
    return { query: 'attendance', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^when did (.+?) attend(?: camp)?$/i);
  if (m) {
    return { query: 'attendance', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^did (.+?) attend(?: camp)? in (\d{4})$/i);
  if (m) {
    return { query: 'attendance', ...personArgs(m[1], anchor), year: Number(m[2]) };
  }

  m = q.match(/^(?:what|which) projects? did (.+?) (?:work on|do|build)$/i);
  if (m) {
    return { query: 'projects', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^(?:show|list|find)\s+(.+?)(?:'s|’s) projects?$/i);
  if (m) {
    return { query: 'projects', ...personArgs(m[1], anchor) };
  }
  m = q.match(/^projects? (?:by|for|of) (.+)$/i);
  if (m) {
    return { query: 'projects', ...personArgs(m[1], anchor) };
  }
  return null;
}

export function shouldForceHistoryTool(
  text: string,
  anchor: PersonRef | string | null = null,
): boolean {
  return historyToolArgs(text, anchor) !== null;
}
