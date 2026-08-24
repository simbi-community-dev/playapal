import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  attendanceByPerson,
  factGraphStats,
  factNeighborNodes,
  factNodes,
  peopleInYear,
  projectsByPerson,
  factGraphRefreshError,
  refreshFactGraph,
  refreshFactGraphSafe,
  shortestFactPath,
  sponsorshipLineage,
  traverseFacts,
} from '../src/facts/factGraph';
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
  { id: 'person:alex', type: 'person', name: 'Alex', attrs: { aliases: ['A'] } },
  { id: 'person:blair', type: 'person', name: 'Blair' },
  { id: 'person:casey', type: 'person', name: 'Casey' },
  { id: 'person:drew', type: 'person', name: 'Drew' },
  { id: 'person:evan', type: 'person', name: 'Evan' },
  { id: 'year:2023', type: 'year', name: '2023' },
  { id: 'project:shade', type: 'project', name: 'Shade Build' },
];

const EDGES = [
  {
    src: 'person:alex',
    dst: 'person:blair',
    type: 'sponsored_by',
    year: 2019,
    evidence_ref: 'fixture.md#alex-blair',
  },
  {
    src: 'person:alex',
    dst: 'person:casey',
    type: 'sponsored_by',
    year: 2020,
    evidence_ref: 'fixture.md#alex-casey',
  },
  {
    src: 'person:blair',
    dst: 'person:drew',
    type: 'sponsored_by',
    year: 2014,
    evidence_ref: 'fixture.md#blair-drew',
  },
  {
    src: 'person:casey',
    dst: 'person:drew',
    type: 'sponsored_by',
    year: 2015,
    evidence_ref: 'fixture.md#casey-drew',
  },
  {
    src: 'person:drew',
    dst: 'person:alex',
    type: 'sponsored_by',
    year: 2010,
    evidence_ref: 'fixture.md#cycle',
  },
  {
    src: 'person:alex',
    dst: 'year:2023',
    type: 'attended',
    year: 2023,
    evidence_ref: 'fixture.md#alex-2023',
  },
  {
    src: 'person:casey',
    dst: 'year:2023',
    type: 'attended',
    year: 2023,
    evidence_ref: 'fixture.md#casey-2023',
  },
  {
    src: 'person:alex',
    dst: 'project:shade',
    type: 'worked_on',
    year: 2023,
    evidence_ref: 'fixture.md#shade',
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

const ref = (id: string, pack_id = 'history') => ({ pack_id, id });

describe('Graphology fact cache', () => {
  test('hydrates enabled rows and keeps pack-local ids distinct', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    installPackFromFiles(conn as any, pack('other-history'));

    expect(refreshFactGraph(conn as any)).toEqual({ nodes: 14, edges: 16 });
    expect(factNodes('person')).toHaveLength(10);
    expect(factNeighborNodes(ref('person:alex'), 'out', ['sponsored_by']).map(n => n.id)).toEqual([
      'person:blair',
      'person:casey',
    ]);
    expect(factNeighborNodes(ref('person:alex', 'other-history'), 'out', ['sponsored_by'])).toHaveLength(2);
  });

  test('library BFS and DFS terminate on a cycle and dedupe diamond ancestry', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);

    const bfs = sponsorshipLineage(ref('person:alex'));
    expect(bfs.nodes.map(item => [item.node.id, item.depth])).toEqual([
      ['person:blair', 1],
      ['person:casey', 1],
      ['person:drew', 2],
    ]);
    expect(bfs.edges).toHaveLength(5);

    const dfs = traverseFacts(ref('person:alex'), 'out', 'dfs', ['sponsored_by']);
    expect(new Set(dfs.nodes.map(item => item.node.id))).toEqual(
      new Set(['person:blair', 'person:casey', 'person:drew']),
    );
    expect(dfs.nodes).toHaveLength(3);
  });

  test('shortest path crosses the diamond and rejects a disconnected node', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);

    const path = shortestFactPath(
      ref('person:alex'),
      ref('person:drew'),
      'out',
      ['sponsored_by'],
    );
    expect(path?.nodes.map(node => node.id)).toEqual([
      'person:alex',
      'person:blair',
      'person:drew',
    ]);
    expect(path?.edges).toHaveLength(2);
    const inbound = shortestFactPath(
      ref('person:drew'),
      ref('person:alex'),
      'in',
      ['sponsored_by'],
    );
    expect(inbound?.nodes.map(node => node.id)).toEqual([
      'person:drew',
      'person:blair',
      'person:alex',
    ]);
    expect(inbound?.edges).toHaveLength(2);
    expect(
      shortestFactPath(ref('person:alex'), ref('person:evan'), 'out', [
        'sponsored_by',
      ]),
    ).toBeNull();
  });

  test('answers attendance, projects, and year cohorts from typed edges', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);

    expect(attendanceByPerson(ref('person:alex'), 2023).map(r => r.node.name)).toEqual([
      '2023',
    ]);
    expect(projectsByPerson(ref('person:alex')).map(r => r.node.name)).toEqual([
      'Shade Build',
    ]);
    expect(peopleInYear(ref('year:2023')).map(r => r.node.name)).toEqual([
      'Alex',
      'Casey',
    ]);
  });

  test('refresh excludes disabled packs', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);
    conn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', ['history']);

    expect(refreshFactGraph(conn as any)).toEqual({ nodes: 0, edges: 0 });
    expect(factNeighborNodes(ref('person:alex'))).toEqual([]);
  });

  test('failed hydration leaves the previous cache intact', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);
    const before = factGraphStats();
    conn.execute(
      `INSERT INTO edges (pack_id, src, dst, type, year, evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['history', 'person:alex', 'person:missing', 'sponsored_by', 2024, 'bad'],
    );

    expect(() => refreshFactGraph(conn as any)).toThrow(/Dangling graph edge/);
    expect(factGraphStats()).toEqual(before);
    expect(sponsorshipLineage(ref('person:alex')).nodes).toHaveLength(3);
  });
});

describe('safe runtime refresh (boot/toggle/remove/import must never brick)', () => {
  it('bad on-disk row: returns null, exposes the error, keeps the old graph', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack());
    refreshFactGraph(conn as any);
    const before = factGraphStats();
    conn.execute(
      `INSERT INTO edges (pack_id, src, dst, type, year, evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['history', 'person:alex', 'person:missing', 'sponsored_by', 2024, 'bad'],
    );

    expect(refreshFactGraphSafe(conn as any)).toBeNull();
    expect(factGraphRefreshError()).toMatch(/Dangling graph edge/);
    expect(factGraphStats()).toEqual(before);

    conn.execute("DELETE FROM edges WHERE evidence_ref = 'bad'");
    expect(refreshFactGraphSafe(conn as any)).toEqual(before);
    expect(factGraphRefreshError()).toBeNull();
  });
});
