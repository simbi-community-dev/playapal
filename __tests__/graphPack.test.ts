import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  installPackFromFiles,
  parseGraphEdges,
  parseGraphNodes,
  type PackFilePayload,
} from '../src/packs/installPack';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  let fail: ((sql: string, params: unknown[]) => boolean) | null = null;
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      if (fail?.(sql, params)) {
        fail = null;
        throw new Error('injected graph write failure');
      }
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
      }
      stmt.run(...params);
      return { rows: undefined };
    },
    failNext(predicate: (sql: string, params: unknown[]) => boolean) {
      fail = predicate;
    },
  };
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

function pack(
  version: number,
  nodes: unknown[],
  edges: unknown[],
  extra: PackFilePayload[] = [],
): PackFilePayload[] {
  return [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id: 'test-facts',
        name: 'Test Facts',
        description: 'fictional graph fixture',
        version,
      }),
    },
    { name: 'nodes.json', content: JSON.stringify(nodes) },
    { name: 'edges.json', content: JSON.stringify(edges) },
    ...extra,
  ];
}

const NODES = [
  {
    id: 'person:alex',
    type: 'person',
    name: 'Alex',
    attrs: { aliases: ['A'], note: 'fictional fixture' },
  },
  { id: 'year:2024', type: 'year', name: '2024' },
  { id: 'project:shade', type: 'project', name: 'Shade Build' },
];

const EDGES = [
  {
    src: 'person:alex',
    dst: 'year:2024',
    type: 'attended',
    year: 2024,
    evidence_ref: 'fixture.md#attendance',
  },
  {
    src: 'person:alex',
    dst: 'project:shade',
    type: 'worked_on',
    year: 2024,
    evidence_ref: 'fixture.md#project',
  },
];

describe('graph pack parsing', () => {
  test('accepts generic node and edge types as rows', () => {
    expect(parseGraphNodes(JSON.stringify(NODES))).toEqual([
      NODES[0],
      { ...NODES[1], attrs: {} },
      { ...NODES[2], attrs: {} },
    ]);
    expect(parseGraphEdges(JSON.stringify(EDGES))).toEqual(EDGES.map(e => ({ ...e, attrs: {} })));
  });

  test('rejects malformed rows, duplicate node ids, malformed attrs, and duplicate edges', () => {
    expect(() => parseGraphNodes(JSON.stringify([null]))).toThrow(
      /expected a JSON object/,
    );
    expect(() => parseGraphEdges(JSON.stringify([null]))).toThrow(
      /expected a JSON object/,
    );
    expect(() => parseGraphNodes(JSON.stringify([NODES[0], NODES[0]]))).toThrow(
      /duplicate node id/,
    );
    expect(() =>
      parseGraphNodes(JSON.stringify([{ ...NODES[0], attrs: [] }])),
    ).toThrow(/attrs.*JSON object/);
    expect(() => parseGraphEdges(JSON.stringify([EDGES[0], EDGES[0]]))).toThrow(
      /duplicate edge/,
    );
  });
});

describe('transactional graph pack installation', () => {
  test('flags.json (the pack\'s own data-quality flags) is inert to the installer — never parsed as events', () => {
    // CAMP-PACK-GRAPH-SPEC.md: a pack ships its uncertainty as flags.json.
    // Every unreserved .json is an EVENTS file to this installer, so an
    // unreserved flags.json would either throw or install garbage events.
    const flags = [
      { kind: 'backwards-chain', severity: 'high', about: ['person:alex'], why: 'fixture', evidence_refs: ['fixture.md#x'] },
    ];
    const conn = makeConn();
    const result = installPackFromFiles(
      conn as any,
      pack(1, NODES, EDGES, [{ name: 'flags.json', content: JSON.stringify(flags) }]),
    );
    expect(result).toMatchObject({ events: 0, chunks: 0, nodes: 3, edges: 2 });
    expect(result.warnings ?? []).toEqual([]);
  });

  test('installs a graph-only pack with provenance and JSON attrs', () => {
    const conn = makeConn();
    const result = installPackFromFiles(conn as any, pack(1, NODES, EDGES));

    expect(result).toMatchObject({
      packId: 'test-facts',
      events: 0,
      chunks: 0,
      nodes: 3,
      edges: 2,
    });
    const nodes = conn.execute(
      'SELECT pack_id, id, type, name, attrs FROM nodes ORDER BY id',
    ).rows!._array;
    expect(nodes).toHaveLength(3);
    expect(JSON.parse(nodes[0].attrs)).toEqual({
      aliases: ['A'],
      note: 'fictional fixture',
    });
    const edge = conn.execute(
      'SELECT pack_id, src, dst, type, year, evidence_ref FROM edges WHERE type = ?',
      ['attended'],
    ).rows!.item(0);
    expect(edge).toEqual({
      pack_id: 'test-facts',
      src: 'person:alex',
      dst: 'year:2024',
      type: 'attended',
      year: 2024,
      evidence_ref: 'fixture.md#attendance',
    });
  });

  test('replacement preserves enabled state and removes omitted graph rows', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack(1, NODES, EDGES));
    conn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', ['test-facts']);

    const nextNodes = NODES.slice(0, 2);
    const nextEdges = EDGES.slice(0, 1);
    installPackFromFiles(conn as any, pack(2, nextNodes, nextEdges));

    const manifest = conn.execute(
      'SELECT version, enabled FROM packs WHERE id = ?',
      ['test-facts'],
    ).rows!.item(0);
    expect(manifest).toEqual({ version: 2, enabled: 0 });
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM nodes WHERE pack_id = ?', [
        'test-facts',
      ]).rows!.item(0).n,
    ).toBe(2);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM edges WHERE pack_id = ?', [
        'test-facts',
      ]).rows!.item(0).n,
    ).toBe(1);
  });

  test('missing endpoints fail before replacing the installed pack', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack(1, NODES, EDGES));
    const broken = [{ ...EDGES[0], dst: 'year:missing' }];

    expect(() =>
      installPackFromFiles(conn as any, pack(2, NODES, broken)),
    ).toThrow(/endpoint missing/);

    expect(
      conn.execute('SELECT version FROM packs WHERE id = ?', ['test-facts']).rows!
        .item(0).version,
    ).toBe(1);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM edges WHERE pack_id = ?', [
        'test-facts',
      ]).rows!.item(0).n,
    ).toBe(2);
  });

  test('a mid-write failure rolls the whole replacement back', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, pack(1, NODES, EDGES));
    conn.failNext(sql => /INSERT INTO edges/.test(sql));

    expect(() =>
      installPackFromFiles(
        conn as any,
        pack(2, NODES.slice(0, 2), EDGES.slice(0, 1)),
      ),
    ).toThrow(/injected graph write failure/);

    expect(
      conn.execute('SELECT version FROM packs WHERE id = ?', ['test-facts']).rows!
        .item(0).version,
    ).toBe(1);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM nodes WHERE pack_id = ?', [
        'test-facts',
      ]).rows!.item(0).n,
    ).toBe(3);
    expect(
      conn.execute('SELECT COUNT(*) AS n FROM edges WHERE pack_id = ?', [
        'test-facts',
      ]).rows!.item(0).n,
    ).toBe(2);
  });
});

describe('edge provenance attrs (CAMP-PACK-GRAPH-SPEC.md) persist and migrate', () => {
  test('edge attrs round-trip through install and read back as JSON', () => {
    const conn = makeConn();
    const edges = [
      {
        ...EDGES[0],
        attrs: { tier: 'stated', stated_on: '2013-06-02', year_source: 'explicit', said_names: ['Alex', 'Cricket'] },
      },
    ];
    installPackFromFiles(conn as any, pack(1, NODES, edges));
    const rows = conn.execute('SELECT attrs FROM edges').rows!._array;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].attrs)).toEqual(edges[0].attrs);
    // an edge with no attrs stores '{}' — never NULL, never a missing column
    installPackFromFiles(conn as any, pack(2, NODES, EDGES));
    for (const r of conn.execute('SELECT attrs FROM edges').rows!._array) {
      expect(typeof r.attrs).toBe('string');
      expect(() => JSON.parse(r.attrs)).not.toThrow();
    }
  });

  test('a device DB created before the attrs column gains it additively (ADDITIVE_COLUMNS)', () => {
    // Simulate the pre-2026-08-17 shape: edges WITHOUT attrs, with a row in it.
    const { ADDITIVE_COLUMNS } = require('../src/events/schema');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE edges (
      id INTEGER PRIMARY KEY, pack_id TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
      type TEXT NOT NULL, year INTEGER, evidence_ref TEXT NOT NULL)`);
    db.exec(`INSERT INTO edges (pack_id, src, dst, type, year, evidence_ref)
             VALUES ('old', 'person:a', 'person:b', 'sponsored_by', 2009, 'stated 2010-06-17 t000062#10')`);
    // initSchema's actual order: BASE_TABLES_SQL first (CREATE IF NOT EXISTS
    // is a no-op on the old edges table but creates every OTHER registered
    // table, e.g. friend_cards), THEN the additive loop. Replaying the loop
    // against a partial DB is not a shape production can reach.
    const { BASE_TABLES_SQL } = require('../src/events/schema');
    for (const sql of BASE_TABLES_SQL) {
      db.exec(sql);
    }
    // The migration step exactly as db.ts initSchema applies it.
    for (const m of ADDITIVE_COLUMNS) {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all().map((c: any) => c.name);
      if (!cols.includes(m.column)) {
        db.exec(m.ddl);
      }
    }
    const cols = db.prepare('PRAGMA table_info(edges)').all().map((c: any) => c.name);
    expect(cols).toContain('attrs');
    // the pre-existing row reads as '{}' (DEFAULT), so every reader parses it
    const row = db.prepare('SELECT attrs FROM edges').get() as any;
    expect(row.attrs).toBe('{}');
    // idempotent: running the migration again is a no-op, not a duplicate-column error
    for (const m of ADDITIVE_COLUMNS) {
      const cols2 = db.prepare(`PRAGMA table_info(${m.table})`).all().map((c: any) => c.name);
      expect(cols2.includes(m.column)).toBe(true);
    }
  });
});
