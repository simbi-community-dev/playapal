import type { FactCard, GraphNode, PersonRef } from '../types';
import { normalizeFactEntity } from './normalizeFactEntity';
export { normalizeFactEntity } from './normalizeFactEntity';
import {
  attendanceByPerson,
  factNode,
  factNodes,
  peopleInYear,
  projectsByPerson,
  shortestFactPath,
  sponsorshipLineage,
  type FactNodeRef,
} from './factGraph';

export const HISTORY_QUERIES = [
  'attendance',
  'projects',
  'sponsors',
  'sponsees',
  'cohort',
  'path',
] as const;

export type HistoryQuery = (typeof HISTORY_QUERIES)[number];

/**
 * A lookup that RAN and proved the camp pack carries nothing for the question
 * — either the camper is not in the graph at all (`not_found`) or they are and
 * the relation has no rows (`no_match`). Both are honest absences, and both
 * are the app's to voice: see llm/factNarration.campHistoryAbsenceNarration
 * for why the model may not be left to narrate over them.
 */
export interface HistoryAbsence {
  query: HistoryQuery;
  /** The camper as the asker named them, or as the graph resolved them. For
   * a cohort question, the year — the only subject that question has. */
  entity: string;
  /** The far end of a `path` question, when the question got that far. */
  target?: string;
}

export interface HistoryAmbiguity {
  query: string;
  candidates: FactEntityCandidate[];
}

export interface HistoryLookupOutcome {
  json: string;
  cards: FactCard[];
  /** The camper this lookup matched EXACTLY, by name or alias, in the fact
   * graph. The session commits it only when a singular structured answer
   * survives final reconciliation; a no_match remains an absence, not a new
   * discourse anchor. */
  resolvedPerson?: PersonRef;
  /** Set when the answer is a proven absence rather than an answer. */
  absence?: HistoryAbsence;
  /** Multiple exact person matches. The app asks instead of leaving candidate
   * selection to model prose or row order. */
  ambiguity?: HistoryAmbiguity;
}

export interface FactEntityCandidate extends PersonRef {}

export type FactEntityResolution =
  | { status: 'resolved'; node: GraphNode }
  | { status: 'ambiguous' | 'not_found'; candidates: FactEntityCandidate[] };

function aliases(node: GraphNode): string[] {
  const value = node.attrs.aliases;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function trigrams(value: string): Set<string> {
  const text = `  ${normalizeFactEntity(value)}  `;
  const out = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    out.add(text.slice(i, i + 3));
  }
  return out;
}

function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, left.size + right.size - overlap);
}

export function resolveFactEntity(
  value: string,
  type: string,
  packId?: string,
): FactEntityResolution {
  const query = normalizeFactEntity(value);
  if (!query) {
    return { status: 'not_found', candidates: [] };
  }
  const nodes = factNodes(type).filter(node => !packId || node.pack_id === packId);
  const exact = nodes.filter(node => {
    return (
      node.id.toLowerCase() === value.trim().toLowerCase() ||
      normalizeFactEntity(node.name) === query ||
      aliases(node).some(alias => normalizeFactEntity(alias) === query)
    );
  });
  if (exact.length === 1) {
    return { status: 'resolved', node: exact[0] };
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exact.map(node => ({ id: node.id, name: node.name, pack_id: node.pack_id })),
    };
  }

  const fuzzy = nodes
    .map(node => ({
      node,
      score: Math.max(similarity(value, node.name), ...aliases(node).map(alias => similarity(value, alias))),
    }))
    .filter(candidate => candidate.score >= 0.3)
    .sort((a, b) => {
      return (
        b.score - a.score ||
        a.node.name.localeCompare(b.node.name) ||
        a.node.pack_id.localeCompare(b.node.pack_id)
      );
    })
    .slice(0, 3)
    .map(({ node }) => ({ id: node.id, name: node.name, pack_id: node.pack_id }));
  return { status: 'not_found', candidates: fuzzy };
}

function ref(node: GraphNode): FactNodeRef {
  return { pack_id: node.pack_id, id: node.id };
}

/**
 * THE DOMAIN INSTRUCTION for a proven camp-history absence. A bare
 * `{"status":"not_found","candidates":[]}` is a shrug, and the device receipt
 * shows what a 2.6B does with a shrug: "who sponsored her?" closed with
 * "check Playa Info at Esplanade & 5:45". That address is REAL — it is
 * verbatim in the survival guide — which is exactly what makes it the wrong
 * answer and one no fabrication detector would ever catch. Playa Info is a
 * Black Rock City services desk: lost and found, tows, lockouts, directions.
 * It cannot say who sponsored a camper into this camp, ever, for anybody. So
 * the tool result names the domain boundary the model cannot infer.
 */
function absenceInstruction(subject: string): string {
  return (
    `The camp pack carries nothing for ${subject} yet. Say plainly that you ` +
    `do not have it. If you point anywhere, point to their campmates or the ` +
    `camp list — never to Playa Info, Center Camp, a Ranger station or any ` +
    `other Black Rock City services desk: those answer city logistics, not ` +
    `camp history, and cannot help with this question.`
  );
}

function result(
  status: string,
  query: HistoryQuery | null,
  cards: FactCard[] = [],
  extra: Record<string, unknown> = {},
  absence?: HistoryAbsence,
): HistoryLookupOutcome {
  return {
    json: JSON.stringify({
      status,
      query,
      ...extra,
      instruction:
        cards.length > 0
          ? 'Structured cards are attached. Do not restate years, dates, counts, or relationships in prose.'
          : absence
            ? absenceInstruction(
                absence.target
                  ? `${absence.entity} and ${absence.target}`
                  : absence.entity,
              )
            : undefined,
    }),
    cards,
    ...(absence ? { absence } : {}),
  };
}

function validYear(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999
    ? value
    : null;
}

function relationships(
  edges: { pack_id: string; src: string; dst: string; year: number | null; evidence_ref: string }[],
) {
  return edges.flatMap(edge => {
    const from = factNode({ pack_id: edge.pack_id, id: edge.src });
    const to = factNode({ pack_id: edge.pack_id, id: edge.dst });
    return from && to
      ? [
          {
            from: from.name,
            to: to.name,
            year: edge.year,
            pack_id: edge.pack_id,
            evidence_ref: edge.evidence_ref,
          },
        ]
      : [];
  });
}

export function lookupHistory(args: Record<string, unknown>): HistoryLookupOutcome {
  const query =
    typeof args.query === 'string' && HISTORY_QUERIES.includes(args.query as HistoryQuery)
      ? (args.query as HistoryQuery)
      : null;
  if (!query) {
    return result('invalid_query', null, [], { allowed: HISTORY_QUERIES });
  }

  const allowed = new Set(['query', 'entity', 'year', 'target', 'pack_id']);
  const unknown = Object.keys(args).filter(key => !allowed.has(key));
  const stringSlots = ['entity', 'target', 'pack_id'] as const;
  const invalidSlots = stringSlots.filter(
    key => args[key] !== undefined && typeof args[key] !== 'string',
  );
  if (unknown.length > 0 || invalidSlots.length > 0) {
    return result('invalid_arguments', query, [], {
      unknown,
      invalid: invalidSlots,
    });
  }

  const year = validYear(args.year);
  if (year === null) {
    return result('invalid_year', query);
  }
  const entity = typeof args.entity === 'string' ? args.entity.trim() : '';
  const target = typeof args.target === 'string' ? args.target.trim() : '';
  const packId = typeof args.pack_id === 'string' && args.pack_id.trim()
    ? args.pack_id.trim()
    : undefined;

  if (query === 'cohort') {
    if (year === undefined && !entity) {
      return result('missing_entity_or_year', query);
    }
    const term = year === undefined ? entity : String(year);
    const resolved = resolveFactEntity(term, 'year', packId);
    if (resolved.status !== 'resolved') {
      return result(
        resolved.status,
        query,
        [],
        { candidates: resolved.candidates },
        resolved.status === 'not_found' ? { query, entity: term } : undefined,
      );
    }
    const resolvedYear = year ?? Number(resolved.node.name);
    if (!Number.isInteger(resolvedYear)) {
      return result('invalid_year_node', query);
    }
    const people = peopleInYear(ref(resolved.node)).map(relation => ({
      name: relation.node.name,
      pack_id: relation.edge.pack_id,
      evidence_ref: relation.edge.evidence_ref,
    }));
    return people.length
      ? result('cards_attached', query, [
          { kind: 'cohort', year: resolvedYear, people },
        ])
      : result('no_match', query, [], {}, { query, entity: String(resolvedYear) });
  }

  if (!entity) {
    return result('missing_entity', query);
  }
  const resolved = resolveFactEntity(entity, 'person', packId);
  if (resolved.status !== 'resolved') {
    const outcome = result(
      resolved.status,
      query,
      [],
      { candidates: resolved.candidates },
      // AMBIGUOUS IS NOT ABSENCE: the pack holds two campers by that name and
      // the honest answer is to ask which one, not to close the door.
      resolved.status === 'not_found' ? { query, entity } : undefined,
    );
    return resolved.status === 'ambiguous'
      ? {
          ...outcome,
          ambiguity: { query: entity, candidates: resolved.candidates },
        }
      : outcome;
  }
  const person = resolved.node;
  /** Every answer past this point resolved a real camper — the anchor a later
   * pronoun binds to, whether or not the relation itself had rows. */
  const withPerson = (outcome: HistoryLookupOutcome): HistoryLookupOutcome => ({
    ...outcome,
    resolvedPerson: {
      pack_id: person.pack_id,
      id: person.id,
      name: person.name,
    },
  });
  const noRows = (): HistoryLookupOutcome =>
    withPerson(result('no_match', query, [], {}, { query, entity: person.name }));

  if (query === 'attendance') {
    const years = attendanceByPerson(ref(person), year).flatMap(relation => {
      const value = relation.edge.year ?? Number(relation.node.name);
      return Number.isInteger(value)
        ? [
            {
              year: value,
              pack_id: relation.edge.pack_id,
              evidence_ref: relation.edge.evidence_ref,
            },
          ]
        : [];
    });
    return years.length
      ? withPerson(
          result('cards_attached', query, [
            { kind: 'attendance', person: person.name, years },
          ]),
        )
      : noRows();
  }

  if (query === 'projects') {
    const projects = projectsByPerson(ref(person)).map(relation => ({
      name: relation.node.name,
      year: relation.edge.year,
      pack_id: relation.edge.pack_id,
      evidence_ref: relation.edge.evidence_ref,
    }));
    return projects.length
      ? withPerson(
          result('cards_attached', query, [
            { kind: 'projects', person: person.name, projects },
          ]),
        )
      : noRows();
  }

  if (query === 'sponsors' || query === 'sponsees') {
    const lineage = sponsorshipLineage(ref(person), query);
    const rows = relationships(lineage.edges);
    return rows.length
      ? withPerson(
          result('cards_attached', query, [
            {
              kind: 'lineage',
              person: person.name,
              direction: query,
              relationships: rows,
            },
          ]),
        )
      : noRows();
  }

  if (!target) {
    return withPerson(result('missing_target', query));
  }
  const resolvedTarget = resolveFactEntity(target, 'person', packId);
  if (resolvedTarget.status !== 'resolved') {
    return withPerson(
      result(
        resolvedTarget.status,
        query,
        [],
        { target: true, candidates: resolvedTarget.candidates },
        resolvedTarget.status === 'not_found'
          ? { query, entity: person.name, target }
          : undefined,
      ),
    );
  }
  if (resolvedTarget.node.pack_id !== person.pack_id) {
    return withPerson(result('disconnected_packs', query));
  }
  const source = ref(person);
  const destination = ref(resolvedTarget.node);
  const path =
    shortestFactPath(source, destination, 'out', ['sponsored_by']) ??
    shortestFactPath(source, destination, 'in', ['sponsored_by']);
  return path && path.edges.length > 0
    ? withPerson(
        result('cards_attached', query, [
          {
            kind: 'path',
            from: person.name,
            to: resolvedTarget.node.name,
            relationships: relationships(path.edges),
          },
        ]),
      )
    : withPerson(
        result(
          'no_match',
          query,
          [],
          {},
          { query, entity: person.name, target: resolvedTarget.node.name },
        ),
      );
}
