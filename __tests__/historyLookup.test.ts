import { BASE_TABLES_SQL } from '../src/events/schema';
import { refreshFactGraph } from '../src/facts/factGraph';
import {
  HISTORY_QUERIES,
  lookupHistory,
  resolveFactEntity,
} from '../src/facts/historyLookup';
import { installPackFromFiles, type PackFilePayload } from '../src/packs/installPack';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  };
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

const NODES = [
  {
    id: 'person:river',
    type: 'person',
    name: 'River Moon',
    attrs: { aliases: ['Riv', 'Moon River'] },
  },
  { id: 'person:blair', type: 'person', name: 'Blair' },
  { id: 'person:drew', type: 'person', name: 'Drew' },
  { id: 'person:evan', type: 'person', name: 'Evan' },
  { id: 'year:2023', type: 'year', name: '2023' },
  { id: 'project:shade', type: 'project', name: 'Shade Build' },
];

const EDGES = [
  {
    src: 'person:river',
    dst: 'person:blair',
    type: 'sponsored_by',
    year: 2019,
    evidence_ref: 'history.md#river-blair',
  },
  {
    src: 'person:blair',
    dst: 'person:drew',
    type: 'sponsored_by',
    year: 2014,
    evidence_ref: 'history.md#blair-drew',
  },
  {
    src: 'person:river',
    dst: 'year:2023',
    type: 'attended',
    evidence_ref: 'history.md#river-2023',
  },
  {
    src: 'person:blair',
    dst: 'year:2023',
    type: 'attended',
    year: 2023,
    evidence_ref: 'history.md#blair-2023',
  },
  {
    src: 'person:river',
    dst: 'project:shade',
    type: 'worked_on',
    year: 2022,
    evidence_ref: 'history.md#shade',
  },
];

function pack(id = 'history'): PackFilePayload[] {
  return [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id,
        name: `History ${id}`,
        description: 'fictional graph fixture',
        version: 1,
      }),
    },
    { name: 'nodes.json', content: JSON.stringify(NODES) },
    { name: 'edges.json', content: JSON.stringify(EDGES) },
  ];
}

function load(...ids: string[]) {
  const conn = makeConn();
  for (const id of ids) {
    installPackFromFiles(conn as any, pack(id));
  }
  refreshFactGraph(conn as any);
}

function payload(outcome: ReturnType<typeof lookupHistory>) {
  return JSON.parse(outcome.json);
}

describe('lookup_history', () => {
  beforeEach(() => load('history'));

  test('locks the query enum and validates runtime slots independently of the schema', () => {
    expect(payload(lookupHistory({ query: 'sql' }))).toEqual({
      status: 'invalid_query',
      query: null,
      allowed: HISTORY_QUERIES,
    });
    expect(
      payload(lookupHistory({ query: 'attendance', entity: 'River', extra: true })),
    ).toMatchObject({ status: 'invalid_arguments', unknown: ['extra'] });
    expect(
      payload(lookupHistory({ query: 'attendance', entity: 42 })),
    ).toMatchObject({ status: 'invalid_arguments', invalid: ['entity'] });
    expect(
      payload(lookupHistory({ query: 'attendance', entity: 'River', year: '2023' })),
    ).toMatchObject({ status: 'invalid_year' });
    expect(payload(lookupHistory({ query: 'projects' }))).toMatchObject({
      status: 'missing_entity',
    });
    expect(
      payload(lookupHistory({ query: 'path', entity: 'River Moon' })),
    ).toMatchObject({ status: 'missing_target' });
  });

  test('resolves exact aliases and keeps attendance values out of tool prose', () => {
    const outcome = lookupHistory({ query: 'attendance', entity: 'riv' });

    expect(payload(outcome)).toEqual({
      status: 'cards_attached',
      query: 'attendance',
      instruction:
        'Structured cards are attached. Do not restate years, dates, counts, or relationships in prose.',
    });
    expect(outcome.json).not.toContain('2023');
    expect(outcome.cards).toEqual([
      {
        kind: 'attendance',
        person: 'River Moon',
        years: [
          {
            year: 2023,
            pack_id: 'history',
            evidence_ref: 'history.md#river-2023',
          },
        ],
      },
    ]);
  });

  test('returns app-owned project, cohort, and lineage cards with provenance', () => {
    expect(lookupHistory({ query: 'projects', entity: 'River Moon' }).cards).toEqual([
      {
        kind: 'projects',
        person: 'River Moon',
        projects: [
          {
            name: 'Shade Build',
            year: 2022,
            pack_id: 'history',
            evidence_ref: 'history.md#shade',
          },
        ],
      },
    ]);

    expect(lookupHistory({ query: 'cohort', year: 2023 }).cards).toEqual([
      {
        kind: 'cohort',
        year: 2023,
        people: [
          {
            name: 'River Moon',
            pack_id: 'history',
            evidence_ref: 'history.md#river-2023',
          },
          {
            name: 'Blair',
            pack_id: 'history',
            evidence_ref: 'history.md#blair-2023',
          },
        ],
      },
    ]);

    expect(
      lookupHistory({ query: 'sponsors', entity: 'River Moon' }).cards[0],
    ).toMatchObject({
      kind: 'lineage',
      person: 'River Moon',
      direction: 'sponsors',
      relationships: [
        {
          from: 'River Moon',
          to: 'Blair',
          year: 2019,
          pack_id: 'history',
          evidence_ref: 'history.md#river-blair',
        },
        {
          from: 'Blair',
          to: 'Drew',
          year: 2014,
          pack_id: 'history',
          evidence_ref: 'history.md#blair-drew',
        },
      ],
    });
  });

  test('finds sponsorship paths in either question direction and rejects disconnected nodes', () => {
    const forward = lookupHistory({
      query: 'path',
      entity: 'River Moon',
      target: 'Drew',
    });
    expect(forward.cards[0]).toMatchObject({
      kind: 'path',
      from: 'River Moon',
      to: 'Drew',
      relationships: [
        { from: 'River Moon', to: 'Blair' },
        { from: 'Blair', to: 'Drew' },
      ],
    });

    const reverse = lookupHistory({
      query: 'path',
      entity: 'Drew',
      target: 'River Moon',
    });
    expect(reverse.cards[0]).toMatchObject({
      kind: 'path',
      from: 'Drew',
      to: 'River Moon',
      relationships: [
        { from: 'Blair', to: 'Drew' },
        { from: 'River Moon', to: 'Blair' },
      ],
    });
    expect(
      payload(lookupHistory({ query: 'path', entity: 'River Moon', target: 'Evan' })),
    ).toMatchObject({ status: 'no_match' });
  });

  test('never silently selects fuzzy or cross-pack ambiguous people', () => {
    const fuzzy = resolveFactEntity('Rivr Mon', 'person');
    expect(fuzzy).toEqual({
      status: 'not_found',
      candidates: [
        { id: 'person:river', name: 'River Moon', pack_id: 'history' },
      ],
    });

    load('history', 'other-history');
    expect(resolveFactEntity('River Moon', 'person')).toEqual({
      status: 'ambiguous',
      candidates: [
        { id: 'person:river', name: 'River Moon', pack_id: 'history' },
        {
          id: 'person:river',
          name: 'River Moon',
          pack_id: 'other-history',
        },
      ],
    });
    expect(resolveFactEntity('River Moon', 'person', 'other-history')).toMatchObject({
      status: 'resolved',
      node: { pack_id: 'other-history', id: 'person:river' },
    });
  });
});

/**
 * A CAMP-HISTORY ABSENCE is a fact the lookup established, not a gap.
 *
 * Device receipt (2026-08-16): "who sponsored her?" -> not_found, and the
 * turn closed by sending the asker to "Playa Info at Esplanade & 5:45". That
 * address is real — it is verbatim in the shipped survival guide — which is
 * what makes it insidious: a true sentence, a useless answer, and one no
 * fabrication check would catch. So the tool result carries the domain
 * boundary the model cannot infer, and the outcome carries the structured
 * absence the app narrates from.
 */
describe('camp-history absences degrade honestly', () => {
  beforeEach(() => load('history'));

  test('an unknown camper is an absence, and the payload says so', () => {
    const outcome = lookupHistory({ query: 'sponsors', entity: 'Coco' });
    expect(outcome.absence).toEqual({ query: 'sponsors', entity: 'Coco' });
    expect(outcome.resolvedPerson).toBeUndefined();

    const body = payload(outcome);
    expect(body.status).toBe('not_found');
    expect(body.instruction).toContain('Coco');
    // The domain rule, stated to the model in words: refer into the camp,
    // never to a Black Rock City services desk.
    expect(body.instruction).toMatch(/campmates or the camp list/);
    expect(body.instruction).toMatch(/never to Playa Info/);
  });

  test('a real camper with no rows carries the exact resolved identity', () => {
    // Drew is the root of the fixture's lineage: a real camper the graph
    // resolved exactly, who simply has no sponsor recorded.
    const outcome = lookupHistory({ query: 'sponsors', entity: 'Drew' });
    expect(payload(outcome).status).toBe('no_match');
    expect(outcome.absence).toEqual({ query: 'sponsors', entity: 'Drew' });
    expect(outcome.resolvedPerson).toEqual({
      id: 'person:drew',
      name: 'Drew',
      pack_id: 'history',
    });
  });

  test('an answered lookup carries its exact camper identity and no absence', () => {
    const outcome = lookupHistory({ query: 'sponsors', entity: 'Riv' });
    expect(outcome.absence).toBeUndefined();
    // The graph ID and canonical name, not the alias the asker typed, are what
    // a later pronoun may bind to after the final card survives.
    expect(outcome.resolvedPerson).toEqual({
      id: 'person:river',
      name: 'River Moon',
      pack_id: 'history',
    });
  });

  test('ambiguity is not absence: two campers by that name means ask, not close', () => {
    load('history', 'other-history');
    const outcome = lookupHistory({ query: 'sponsors', entity: 'River Moon' });
    expect(payload(outcome).status).toBe('ambiguous');
    expect(outcome.absence).toBeUndefined();
    expect(outcome.ambiguity).toEqual({
      query: 'River Moon',
      candidates: [
        { id: 'person:river', name: 'River Moon', pack_id: 'history' },
        {
          id: 'person:river',
          name: 'River Moon',
          pack_id: 'other-history',
        },
      ],
    });
    expect(payload(outcome).instruction).toBeUndefined();
  });

  test.each([
    ['attendance', 'Evan'],
    ['projects', 'Evan'],
    ['sponsees', 'Evan'],
  ])('%s with no rows degrades honestly for %s', (query, entity) => {
    const outcome = lookupHistory({ query, entity });
    expect(payload(outcome).status).toBe('no_match');
    expect(outcome.absence).toEqual({ query, entity });
    expect(outcome.resolvedPerson).toEqual({
      id: 'person:evan',
      name: entity,
      pack_id: 'history',
    });
  });

  test('a path with no connection names both ends', () => {
    const outcome = lookupHistory({
      query: 'path',
      entity: 'River Moon',
      target: 'Evan',
    });
    expect(outcome.absence).toEqual({
      query: 'path',
      entity: 'River Moon',
      target: 'Evan',
    });
    expect(payload(outcome).instruction).toContain('River Moon and Evan');
  });

  test('an unknown cohort year is an absence', () => {
    const outcome = lookupHistory({ query: 'cohort', year: 1998 });
    expect(outcome.absence).toEqual({ query: 'cohort', entity: '1998' });
  });

  test('answers and argument errors are untouched — no instruction, no absence', () => {
    const answered = lookupHistory({ query: 'attendance', entity: 'River Moon' });
    expect(answered.absence).toBeUndefined();
    expect(payload(answered).instruction).toMatch(/Structured cards are attached/);

    const invalid = lookupHistory({ query: 'attendance' });
    expect(payload(invalid).status).toBe('missing_entity');
    expect(invalid.absence).toBeUndefined();
    expect(payload(invalid).instruction).toBeUndefined();
  });
});
