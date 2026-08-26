/**
 * Lineage ego view — a READ-ONLY projection: draw "who sponsored whom"
 * from the sponsored_by edges an installed pack
 * already ships. Pure data; LineageScreen renders it. The "say something"
 * statement flow (§6, §7 step 2) is a later lane and is absent here on purpose.
 *
 * Direction (CAMP-PACK-GRAPH-SPEC.md): a sponsored_by edge's src is the
 * SPONSEE and dst is the SPONSOR — "src was sponsored_by dst". Everything this
 * module returns is already in the human direction ("Coco sponsored Pug"), so
 * the screen never touches the storage arrow. Names come from the node, never
 * the id.
 */

import { getDb } from '../events/db';
import type { DbConnection } from '../events/engine';
import type { GraphEdge, GraphNode } from '../types';
import {
  FACT_RELATIONS,
  factNode,
  factNodes,
  factRelations,
  type FactNodeRef,
} from './factGraph';
import { normalizeFactEntity } from './normalizeFactEntity';

export interface LineagePerson {
  ref: FactNodeRef;
  name: string;
  aliases: string[];
}

/** How an edge was established (CAMP-PACK-GRAPH-SPEC.md attrs.tier + the
 * design's `stated-on-playa`). Read from the persisted edge attrs when present
 * (edges.attrs, since the 2026-08-17 additive migration); packs installed
 * before that carry '{}' and the tier falls back to the evidence_ref's leading
 * token — the spec's own tier vocabulary. 'unknown' = a ref the spec
 * doesn't name. */
export type LineageTier =
  | 'stated'
  | 'roster'
  | 'owner-stated'
  | 'inferred'
  | 'stated-on-playa'
  | 'unknown';

export type LineageFlagKind = 'backwards-chain' | 'sponsee-in-camp-before-sponsorship';

/** Same shape as a flags.json row so the pack's own flags can slot in later. */
export interface LineageFlag {
  kind: LineageFlagKind;
  severity: 'high' | 'low';
  /** Node ids the flag is about; [0] is the person it hangs on. */
  about: string[];
  why: string;
  evidence_refs: string[];
  year: number | null;
  first_attended: number | null;
}

/** One arrow touching the centered person, already in human direction. */
export interface LineageLink {
  person: LineagePerson;
  year: number | null;
  evidence_ref: string;
  tier: LineageTier;
  /** Flags hanging on `person` (the card's own "≠" / "?" chip). */
  flags: LineageFlag[];
}

export interface LineageEgoView {
  person: LineagePerson;
  /** The (earliest-dated) sponsor; null when nobody is on record. */
  sponsor: LineageLink | null;
  /** Every sponsor on record — the multi-sponsor case draws them all. */
  sponsors: LineageLink[];
  /** Sorted by year (unknown last), then name. */
  sponsees: LineageLink[];
  yearsAttended: number[];
  /** Flags hanging on the centered person. */
  flags: LineageFlag[];
}

export interface LineageStarter {
  person: LineagePerson;
  sponseeCount: number;
}

/** True iff an ENABLED installed pack carries at least one sponsored_by edge.
 * Gates the Camp-tab row (design §6): no pack, no surface. One indexed probe
 * against storage-of-record, the way factGraph reads it. */
export function hasLineageData(conn: DbConnection = getDb()): boolean {
  const rows = conn.execute(
    `SELECT 1 AS found FROM edges e
     JOIN packs p ON p.id = e.pack_id
     WHERE p.enabled = 1 AND e.type = ?
     LIMIT 1`,
    [FACT_RELATIONS.sponsorship],
  ).rows;
  return Boolean(rows?.length);
}

function aliasesOf(node: GraphNode): string[] {
  const value = node.attrs.aliases;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '' && v !== node.name)
    : [];
}

function toPerson(node: GraphNode): LineagePerson {
  return {
    ref: { pack_id: node.pack_id, id: node.id },
    name: node.name,
    aliases: aliasesOf(node),
  };
}

export function lineageTier(evidence_ref: string, attrs?: Record<string, unknown>): LineageTier {
  // Persisted tier wins (edges.attrs, CAMP-PACK-GRAPH-SPEC.md); the ref's
  // leading token is the fallback for packs installed before attrs persisted.
  const stored = typeof attrs?.tier === 'string' ? (attrs.tier as string).toLowerCase() : '';
  if (stored === 'stated' || stored === 'roster' || stored === 'inferred' || stored === 'owner-stated' || stored === 'stated-on-playa') {
    return stored;
  }
  const head = evidence_ref.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  switch (head) {
    case 'stated':
    case 'roster':
    case 'inferred':
    case 'owner-stated':
      return head;
    case 'said':
      return 'stated-on-playa';
    default:
      return 'unknown';
  }
}

/** Turn a stored evidence reference into provenance a camper can recognize.
 * Corpus coordinates stay internal; the date and source kind remain visible. */
export function describeEvidence(evidence_ref: string): string {
  const ref = evidence_ref.trim();
  let m = ref.match(/^stated\s+(\S+)\s+([A-Za-z0-9_-]+)#(\d+)$/i);
  if (m) {
    return `said on ${m[1]}`;
  }
  m = ref.match(/^stated\s+(\S+)$/i);
  if (m) {
    return `said ${m[1]}`;
  }
  m = ref.match(/^roster\s+(\d{4})$/i);
  if (m) {
    return `on the ${m[1]} camp list`;
  }
  m = ref.match(/^owner-stated\s+(\S+)$/i);
  if (m) {
    return `told to the app by the camp, ${m[1]}`;
  }
  m = ref.match(/^said\s+(\S+)\s+by\s+(.+)$/i);
  if (m) {
    return `said by ${m[2]} on playa, ${m[1]}`;
  }
  m = ref.match(/^inferred\s+(.+)$/i);
  if (m) {
    return `a guess from ${m[1]}`;
  }
  return 'source recorded in the camp pack';
}

export function tierLabel(tier: LineageTier): string {
  switch (tier) {
    case 'stated':
      return 'someone said so in the camp email';
    case 'roster':
      return 'from a camp list';
    case 'owner-stated':
      return 'told to the app by the camp';
    case 'inferred':
      return 'a guess — lower confidence';
    case 'stated-on-playa':
      return 'said on playa';
    default:
      return 'source not classified';
  }
}

interface RawLink {
  node: GraphNode;
  edge: GraphEdge;
}

// factRelations WITHOUT a relation filter reads the live graph; WITH one it
// copies the whole graph per call (relationView) — too slow for the start
// screen's 400-person sweep on a phone. Filter the edge type here instead.
function edgesOf(ref: FactNodeRef, direction: 'in' | 'out', relation: string): RawLink[] {
  return factRelations(ref, direction).filter(r => r.edge.type === relation);
}

/** Edges where `ref` is the sponsee → their sponsors (out-edges). */
function sponsorEdges(ref: FactNodeRef): RawLink[] {
  return edgesOf(ref, 'out', FACT_RELATIONS.sponsorship).filter(r => r.node.type === 'person');
}

/** Edges where `ref` is the sponsor → their sponsees (in-edges). */
function sponseeEdges(ref: FactNodeRef): RawLink[] {
  return edgesOf(ref, 'in', FACT_RELATIONS.sponsorship).filter(r => r.node.type === 'person');
}

function byYearThenName(a: RawLink, b: RawLink): number {
  const ay = a.edge.year ?? Number.MAX_SAFE_INTEGER;
  const by = b.edge.year ?? Number.MAX_SAFE_INTEGER;
  return ay - by || a.node.name.localeCompare(b.node.name);
}

function yearsAttended(ref: FactNodeRef): number[] {
  const years = edgesOf(ref, 'out', FACT_RELATIONS.attendance)
    .filter(r => r.node.type === 'year')
    .map(r => r.edge.year ?? Number(r.node.name))
    .filter(y => Number.isFinite(y));
  return [...new Set(years)].sort((a, b) => a - b);
}

/**
 * The two cheapest data-quality flags, computed in-app from edges alone.
 * TODO(flags.json): the pack ships ALL review flags in flags.json (backwards
 * chains, sponsorship-before-sponsor-first-attended, no-attendance-record,
 * duplicate-looking-names…) but installPack.ts reserves and ignores that file
 * today (playapal 516314a). When it is stored, read it here and merge; keep
 * these two as the fallback for packs that ship no flags.json.
 */
export function personFlags(ref: FactNodeRef): LineageFlag[] {
  const node = factNode(ref);
  if (!node) {
    return [];
  }
  const flags: LineageFlag[] = [];
  const sponsees = sponseeEdges(ref);
  const firstYear = yearsAttended(ref)[0] ?? null;
  for (const sponsor of sponsorEdges(ref)) {
    const year = sponsor.edge.year;
    if (year === null) {
      continue;
    }
    // Backwards chain: sponsored someone BEFORE their own sponsorship year.
    for (const s of sponsees) {
      if (s.edge.year !== null && s.edge.year < year) {
        flags.push({
          kind: 'backwards-chain',
          severity: 'high',
          about: [node.id, sponsor.node.id, s.node.id],
          why: `${node.name} sponsored ${s.node.name} in ${s.edge.year} but was sponsored in ${year} — one of these years is a statement date, not the event`,
          evidence_refs: [sponsor.edge.evidence_ref, s.edge.evidence_ref],
          year,
          first_attended: null,
        });
      }
    }
    // In camp before the sponsorship: first attended year < sponsorship year.
    if (firstYear !== null && firstYear < year) {
      flags.push({
        kind: 'sponsee-in-camp-before-sponsorship',
        severity: 'high',
        about: [node.id, sponsor.node.id],
        why: `${node.name} first attended ${firstYear} but the sponsorship is dated ${year}`,
        evidence_refs: [sponsor.edge.evidence_ref],
        year,
        first_attended: firstYear,
      });
    }
  }
  return flags;
}

/** The chip a flag draws (design §5.4): "≠" = two years contradict each
 * other; "?" = the record looks off and wants a human. */
export function flagGlyph(kind: LineageFlagKind): '≠' | '?' {
  return kind === 'backwards-chain' ? '≠' : '?';
}

function toLink(raw: RawLink): LineageLink {
  return {
    person: toPerson(raw.node),
    year: raw.edge.year,
    evidence_ref: raw.edge.evidence_ref,
    tier: lineageTier(raw.edge.evidence_ref, raw.edge.attrs),
    flags: personFlags({ pack_id: raw.node.pack_id, id: raw.node.id }),
  };
}

export function egoView(ref: FactNodeRef): LineageEgoView | null {
  const node = factNode(ref);
  if (!node || node.type !== 'person') {
    return null;
  }
  const sponsors = sponsorEdges(ref).sort(byYearThenName).map(toLink);
  const sponsees = sponseeEdges(ref).sort(byYearThenName).map(toLink);
  return {
    person: toPerson(node),
    sponsor: sponsors[0] ?? null,
    sponsors,
    sponsees,
    yearsAttended: yearsAttended(ref),
    flags: personFlags(ref),
  };
}

function starters(): LineageStarter[] {
  return factNodes('person')
    .map(node => ({
      node,
      sponseeCount: sponseeEdges({ pack_id: node.pack_id, id: node.id }).length,
    }))
    .filter(s => s.sponseeCount > 0)
    .sort((a, b) => b.sponseeCount - a.sponseeCount || a.node.name.localeCompare(b.node.name))
    .map(s => ({ person: toPerson(s.node), sponseeCount: s.sponseeCount }));
}

/** Everyone who sponsored someone, most sponsees first. */
export function topSponsors(limit = 8): LineageStarter[] {
  return starters().slice(0, limit);
}

/** People who sponsor others but are sponsored by no one — where the camp's
 * lines begin (as far as the record goes). */
export function lineageRoots(): LineageStarter[] {
  return starters().filter(s => sponsorEdges(s.person.ref).length === 0);
}

/** Name/alias prefix match, case- and accent-insensitive; a prefix of any
 * word counts too ("wellman" finds Krystal Wellman). People on the tree rank
 * before people who are only in the pack; exact name/alias hits first. */
export function lineageSearch(q: string, limit = 20): LineagePerson[] {
  const query = normalizeFactEntity(q);
  if (!query) {
    return [];
  }
  const rank = (value: string): number => {
    const norm = normalizeFactEntity(value);
    if (norm === query) {
      return 0;
    }
    if (norm.startsWith(query)) {
      return 1;
    }
    return norm.split(' ').some(word => word.startsWith(query)) ? 2 : Infinity;
  };
  return factNodes('person')
    .map(node => {
      const person = toPerson(node);
      const score = Math.min(rank(node.name), ...person.aliases.map(rank));
      const ref = person.ref;
      const onTree =
        Number.isFinite(score) &&
        (sponsorEdges(ref).length > 0 || sponseeEdges(ref).length > 0);
      return { person, score, onTree };
    })
    .filter(hit => Number.isFinite(hit.score))
    .sort(
      (a, b) =>
        Number(b.onTree) - Number(a.onTree) ||
        a.score - b.score ||
        a.person.name.localeCompare(b.person.name),
    )
    .slice(0, limit)
    .map(hit => hit.person);
}
