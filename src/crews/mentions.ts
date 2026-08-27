/**
 * @-mentions — the one place where a name inside a sentence becomes a
 * DECISION, shared by the two ends that must agree about it: the composer
 * offering podmates while a thumb types, and the arrival seam
 * (pocketAlerts.ts) deciding whether a message earns the loud buzz.
 *
 * THE OWNER'S ASK, 2026-08-26: "if kupo is in a pod with me, and i type
 * @kupo in chat, it would send her phone a real buzz."
 *
 * AND THE TRUTH UNDER IT. There is no push server anywhere in this app and
 * no internet at BRC. "@kupo buzzes her phone" means HER phone raises a
 * local notification at the moment it RECEIVES the message over the mesh —
 * instant when the two phones are linked, at the next radio meeting
 * otherwise. Every sentence this app says about mentions has to survive
 * that: the buzz is real, its TIMING belongs to the radio. Copy that
 * implies otherwise would be teaching a camper to expect a delivery
 * guarantee nobody can keep in a dust storm.
 *
 * NOTHING NEW RIDES THE WIRE. A mention is the plain characters '@' plus
 * the name, sitting in the message body that every build already carries
 * and renders. messages.ts gained no field, no kind and no flag — a phone
 * running last week's build shows "@Kupo bring water" exactly as typed and
 * simply does not escalate, which is the correct degrade and the reason
 * this file parses TEXT rather than reading a marker.
 *
 * LONGEST NAME FIRST, and it is not a nicety. Playa names contain spaces
 * ("Dusty Boots"), and a pod can hold both "Kupo" and "Kupo Two". Scanning
 * shortest-first would let every message for Kupo Two buzz Kupo, forever,
 * with no way for either of them to see why. So the roster is sorted by
 * length and the FIRST match at an '@' wins, which is the same rule a
 * human eye applies.
 *
 * NO REGEX IS EVER BUILT FROM A NAME. Names arrive over the mesh from
 * other people's phones — a name is untrusted text, and compiling one into
 * a pattern is both an injection seam and a backtracking hazard on the
 * arrival path. Matching here is plain lowercase index comparison, so a
 * name made of regex metacharacters is just a name.
 */

/** The character that starts a mention. Not configurable: it is what every
 * chat app on the phone already taught the camper. */
export const MENTION_SIGIL = '@';

/**
 * How much of a half-typed name the composer will still treat as a
 * mention-in-progress. Names cap at 40 codepoints (podMembers.ts
 * MEMBER_NAME_MAX); past this, the '@' is far behind and what follows is a
 * sentence, not a name being spelled.
 */
export const MENTION_QUERY_MAX = 40;

/** Letters, digits and underscore, in any script — the boundary test. A
 * name may hold spaces and punctuation; what it must not do is start
 * mid-word (so `mail@camp` is an address, never a mention of "camp"). */
const WORD = /[\p{L}\p{N}_]/u;

const isWord = (c: string | undefined): boolean =>
  c !== undefined && WORD.test(c);

const fold = (s: string): string => s.toLowerCase();

interface Candidate {
  /** The roster's own spelling, which is what gets returned. */
  name: string;
  /** Lowercased, for the comparison. */
  folded: string;
}

/** Deduped, blank-free, longest-first (see the header).
 *
 * NAMED FOR ITS ROSTER, not for "candidates": src/facts/personIdentity.ts
 * already owns a `candidates` that does something else entirely, and the
 * repo's noDuplicatedFunctions guard treats a shared name over differing
 * bodies as a decision to make rather than a coincidence to keep. Renaming
 * is the cheaper half of that decision when one side is a day old. */
function rosterCandidates(names: readonly string[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) {
      continue;
    }
    const folded = fold(name);
    if (seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    out.push({ name, folded });
  }
  return out.sort((a, b) => b.folded.length - a.folded.length);
}

/**
 * Every roster name this text mentions, in the order they appear, each at
 * most once — the roster's own spelling, not the typist's.
 *
 * A match needs all three: an '@' that does not sit inside a word, the
 * name immediately after it (case-insensitive), and a non-word character
 * (or the end of the message) after that. The last one is what keeps
 * "@Kupo" from firing on "@Kupolicious", and the roster's longest-first
 * order is what keeps it from firing on "@Kupo Two".
 */
export function mentionedNames(
  text: string,
  names: readonly string[],
): string[] {
  const pool = rosterCandidates(names);
  if (pool.length === 0) {
    return [];
  }
  const lower = fold(text);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] !== MENTION_SIGIL || isWord(lower[i - 1])) {
      continue;
    }
    for (const c of pool) {
      const end = i + 1 + c.folded.length;
      if (!lower.startsWith(c.folded, i + 1) || isWord(lower[end])) {
        continue;
      }
      if (!seen.has(c.folded)) {
        seen.add(c.folded);
        out.push(c.name);
      }
      // Consume the whole name, so a name containing its own '@' (or a
      // second sigil inside one) cannot start a second match mid-name.
      i = end - 1;
      break;
    }
  }
  return out;
}

/**
 * Does this message name ME? `podNames` is the pod's whole '@' vocabulary
 * as this phone knows it, and my own name is folded in whether or not the
 * caller remembered — the longest-first rule only protects me from a
 * podmate whose name CONTAINS mine if that podmate is in the pool.
 */
export function mentionsMe(
  text: string,
  myName: string,
  podNames: readonly string[],
): boolean {
  const me = fold(myName.trim());
  if (me.length === 0) {
    // A phone whose card has no name cannot be mentioned — the same rule
    // podMembers.ts applies to announcements.
    //
    // STATED HERE, ENFORCED IN rosterCandidates(). The blank-name filter is
    // what actually keeps an empty needle out of the pool, and that is
    // where the suite kills the mutation; removing this early return
    // changes no behaviour. It says the intent out loud and skips the scan
    // — it must not be mistaken for the guard.
    return false;
  }
  return mentionedNames(text, [...podNames, myName]).some(
    n => fold(n.trim()) === me,
  );
}

// ------------------------------------------------------------- composing

/**
 * The half-typed name under the cursor, or null when the draft is not in a
 * mention right now. Read from the END of the draft rather than a caret
 * position: the composer's TextInput reports text, not selection, and a
 * camper types a mention where they are typing.
 *
 * Returns '' for a bare '@' — that is the moment the whole roster should
 * appear, which is the entire discovery mechanism for this feature.
 */
export function mentionQuery(draft: string): string | null {
  const at = draft.lastIndexOf(MENTION_SIGIL);
  if (at < 0 || isWord(draft[at - 1])) {
    return null;
  }
  const q = draft.slice(at + 1);
  if (q.length > MENTION_QUERY_MAX || q.includes('\n')) {
    // The '@' is behind a line break or a paragraph — this is prose that
    // happens to contain an address, not a name being spelled.
    return null;
  }
  return q;
}

/**
 * Who to offer for the mention being typed. Prefix match on the RAW query
 * (never trimmed): typing the space after a finished one-word name has to
 * close the row, while a two-word name has to stay offered across its own
 * space — which is the same comparison doing both.
 */
export function mentionSuggestions(
  draft: string,
  names: readonly string[],
  limit = 5,
): string[] {
  const q = mentionQuery(draft);
  if (q === null) {
    return [];
  }
  const needle = fold(q);
  return rosterCandidates(names)
    .filter(c => c.folded.startsWith(needle))
    // Back to roster order for display: longest-first is a MATCHING rule,
    // and a suggestion row that reorders itself by name length as you type
    // moves the target out from under a thumb.
    .sort((a, b) => a.folded.localeCompare(b.folded))
    .slice(0, limit)
    .map(c => c.name);
}

/**
 * Complete the mention being typed with this name, as PLAIN TEXT plus a
 * trailing space — the wire carries characters, so what lands on the far
 * phone is a sentence any build can render.
 */
export function applyMention(draft: string, name: string): string {
  const at = draft.lastIndexOf(MENTION_SIGIL);
  const head = at < 0 ? draft : draft.slice(0, at);
  return `${head}${MENTION_SIGIL}${name} `;
}
