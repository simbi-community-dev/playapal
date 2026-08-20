/**
 * Shared types for Playa Pal.
 */

/**
 * A data pack: a folder (or zip, planned) with a pack.json manifest plus
 * content files. Structured content (events-style JSON/CSV) lands in typed
 * SQLite tables; freeform content (md/txt) is chunked into an FTS table;
 * relational facts use generic nodes.json and edges.json graph rows.
 * The BRC events and the survival guide ship as the two built-in packs.
 */
export interface PackManifest {
  /** Stable identifier, lowercase kebab-case, e.g. "brc-events-2026". */
  id: string;
  name: string;
  description: string;
  version: number;
}

/** One row of the packs table. */
export interface PackRow extends PackManifest {
  enabled: boolean;
  builtin: boolean;
  eventCount: number;
  chunkCount: number;
  /** Camp board posts (board packs only; 0 elsewhere). */
  postCount: number;
  nodeCount: number;
  edgeCount: number;
}

export interface GraphNodeInput {
  id: string;
  type: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export interface GraphEdgeInput {
  src: string;
  dst: string;
  type: string;
  year?: number | null;
  evidence_ref: string;
  /** Provenance beyond the ref (CAMP-PACK-GRAPH-SPEC.md): tier, stated_on,
   * year_source, said_names… Persisted verbatim; the Lineage view reads it. */
  attrs?: Record<string, unknown>;
}

export interface GraphNode extends GraphNodeInput {
  pack_id: string;
  attrs: Record<string, unknown>;
}

/** One exact person identity in one pack. Names and aliases are presentation;
 * this pack-local key is what pronoun anchors and direct card links retain. */
export interface PersonRef {
  pack_id: string;
  id: string;
  name: string;
}

export interface GraphEdge extends GraphEdgeInput {
  id: number;
  pack_id: string;
  year: number | null;
}

/** One freeform-content chunk (~500 tokens) with its heading breadcrumb. */
export interface DocChunk {
  id: number;
  pack_id: string;
  source_file: string;
  /** Heading breadcrumb, e.g. "Survival Guide > Water". */
  heading: string;
  content: string;
}

/** Structured result of a search_docs / lookup_facts execution. */
export interface DocSearchOutcome {
  results: (DocChunk & { pack_name: string })[];
  /** The sanitized query terms that produced the results — drives the
   * query-focused tool-payload excerpting (searchDocs.excerptForTerms). */
  terms?: string[];
  /** *-prefix = the zero-result rescue rung (4-char prefix terms) answered.
   * about-pin = the identity rung: every query term matched the pack's own
   * name/id tokens, so the pack's about-* chunks answer directly. */
  strategy:
    | 'about-pin'
    | 'fts-phrase'
    | 'fts-and'
    | 'fts-or'
    | 'like-and'
    | 'like-or'
    | 'fts-prefix'
    | 'like-prefix'
    | 'none';
}

/**
 * WHERE AN ANSWER CAME FROM — one retrieved passage, shaped for the chip the
 * asker can tap open (components/SourceChips). Every field is the pack's own
 * words: the pack's display NAME and the document's own heading, never a
 * pack id and never a filename. A provenance line that reads like a database
 * row is the thing this shape exists to avoid — most of all under a memorial
 * (camp-voice), which is why the register rides along on the ref itself.
 */
export interface SourceRef {
  /** Stable identity for dedup + React keys: pack and chunk. */
  id: string;
  /** The pack's display name, e.g. "Dusty Star 25 Years". */
  pack: string;
  /** The document's own leaf heading, e.g. "Water", "Who is Marisol Vega?". */
  doc: string;
  /** The full heading breadcrumb, shown when the chip is opened. */
  heading: string;
  /** The passage text that actually grounded the answer — the SAME excerpt
   * the model was fed, so opening a chip shows what it read, not a re-cut. */
  passage: string;
  /** True when this passage remembers someone who died: the chips take the
   * gentle register instead of the record one. */
  memorial: boolean;
}

/** One row of the events table (and one object in a pack's events JSON). */
export interface EventRow {
  id: number;
  title: string;
  desc: string;
  /** Weekday name, e.g. "Tuesday". Derived from `date`; stored for display + matching. */
  day: string;
  /** ISO date, e.g. "2026-09-01". */
  date: string;
  /** 24h "HH:MM". */
  time_start: string;
  /** 24h "HH:MM"; empty string when open-ended. */
  time_end: string;
  camp: string;
  /** Playa address, e.g. "7:30 & G" or "Center Camp". */
  location: string;
}

/**
 * A resolved local-time window derived APP-SIDE from the user's words and the
 * device clock. Never derived from model output (prototype finding: the model
 * fabricates plausible calendar dates ~40% of the time on vague queries).
 */
export interface DateWindow {
  /** Local datetime "YYYY-MM-DDTHH:MM" inclusive. */
  startISO: string;
  /** Local datetime "YYYY-MM-DDTHH:MM" inclusive. */
  endISO: string;
  /** Human label for the UI, e.g. "tonight", "Tuesday morning". */
  label: string;
}

/** Structured result of one search_events execution — this is what event cards render from. */
export interface EventSearchOutcome {
  results: EventRow[];
  window: DateWindow | null;
  /** True when the date/time filter had to be dropped to find anything. */
  windowRelaxed: boolean;
  /** Which query strategy produced the rows (for debugging/telemetry). */
  strategy: 'fts-phrase' | 'fts-and' | 'fts-or' | 'like-and' | 'like-or' | 'none';
}

export interface FactEntry {
  topic: string;
  aliases: string[];
  body: string;
}

export interface FactEvidence {
  pack_id: string;
  evidence_ref: string;
}

export interface FactRelationship extends FactEvidence {
  from: string;
  to: string;
  year: number | null;
}

/**
 * One camper's identity card, parsed APP-SIDE out of a retrieved people-pack
 * passage — never synthesized by the model (device-measured false IDK over
 * retrieved evidence; see facts/personCard.ts for the failure and the
 * detection rule). Every field is either the pack's own words or a value
 * lifted structurally out of them.
 */
export interface PersonFactCard extends FactEvidence {
  kind: 'person';
  /** Exact graph identity when the card was fetched through the structured
   * person index. Opportunistic legacy retrieval cards deliberately omit it. */
  person_ref?: PersonRef;
  /** The name the card's own headings declare ("Marisol Vega", "Coco"). */
  name: string;
  /** The heading parenthetical — playa name or legal name, the pack's choice. */
  alsoKnownAs: string | null;
  /** Other forms the list carried, from the card's own "Also appears" line. */
  aliases: string[];
  /** Activity window, lifted from the card's own summary sentence. */
  tenure: { from: string; to: string | null };
  /** The card's own summary sentence, verbatim. */
  summary: string;
  /** The camp's own in-memoriam wording; null for a living camper. */
  memoriam: string | null;
}

export type FactCard =
  | {
      kind: 'attendance';
      person: string;
      years: (FactEvidence & { year: number })[];
    }
  | {
      kind: 'projects';
      person: string;
      projects: (FactEvidence & { name: string; year: number | null })[];
    }
  | {
      kind: 'lineage';
      person: string;
      direction: 'sponsors' | 'sponsees';
      relationships: FactRelationship[];
    }
  | {
      kind: 'cohort';
      year: number;
      people: (FactEvidence & { name: string })[];
    }
  | {
      kind: 'path';
      from: string;
      to: string;
      relationships: FactRelationship[];
    }
  | PersonFactCard;

export type ChatCard = { kind: 'event'; event: EventRow } | FactCard;

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** App-owned structured cards; dates and counts render from these, never prose. */
  cards?: ChatCard[];
  /** The passages this answer stood on, tappable under the bubble. Absent on
   * a turn that used no retrieval — an untooled answer cites nothing. */
  sources?: SourceRef[];
  /** True while tokens are still streaming into this message. */
  streaming?: boolean;
  /** Which one the Angel used: the packs (cards/passages), its own voice
   * (an honest close), or memory (model prose with nothing retrieved under
   * it). The bubble marks 'memory' so it is never mistaken for a lookup. */
  answeredFrom?: 'packs' | 'app' | 'memory';
}

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'copying'; detail: string }
  | { state: 'loading'; detail: string }
  | { state: 'ready'; modelName: string }
  | { state: 'error'; detail: string };
