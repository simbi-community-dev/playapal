import { BASE_TABLES_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { chunkDocument } from '../src/packs/chunker';
import { refreshFactGraph } from '../src/facts/factGraph';
import {
  isFactNodeExcluded,
  listHiddenPeople,
  setFactNodeExcluded,
} from '../src/facts/factExclusions';
import { identityIntent } from '../src/llm/identityIntent';
import { lookupPersonIdentity } from '../src/facts/personIdentity';
import { searchDocs } from '../src/docs/searchDocs';

const { DatabaseSync } = require('node:sqlite');
let mockConn: ReturnType<typeof makeConn>;

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  isFtsAvailable: () => false,
  isVecAvailable: () => false,
}));

function makeConn() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
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
  };
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

const PEOPLE = `# Campers

## Rook (Alex Mercer) — Dusty Star camper

### Who is Rook?

Rook is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026. Also appears on the list as Alex Mercer.

## AJM (Alex J Mercer) — Dusty Star camper

### Who is AJM?

AJM is a Dusty Star camper, active on the camp list from Apr 2010 to Oct 2011. Also appears on the list as David T. Anderson.

## María de la Cruz Santos — Dusty Star camper

### Who is María de la Cruz Santos?

María de la Cruz Santos is a Dusty Star camper, active on the camp list in Jul 2023.
`;

function cardIndex(name: string): number {
  const chunks = chunkDocument(PEOPLE);
  const index = chunks.findIndex(chunk => chunk.heading.endsWith(`Who is ${name}?`));
  if (index < 0) {
    throw new Error(`missing fixture card: ${name}`);
  }
  return index;
}

function installPeople(opts: { graphOnly?: boolean; legacy?: boolean } = {}) {
  const nodes = [
    {
      id: 'person:pug',
      type: 'person',
      name: 'Rook',
      attrs: {
        aliases: ['David', 'Alex Mercer'],
        ...(opts.legacy
          ? { card: 'people-test.md' }
          : { card_chunk: `people-test.md:${cardIndex('Rook')}` }),
      },
    },
    {
      id: 'person:dta',
      type: 'person',
      name: 'AJM',
      attrs: {
        aliases: ['David', 'Alex J Mercer'],
        card_chunk: `people-test.md:${cardIndex('AJM')}`,
      },
    },
    {
      id: 'person:maria',
      type: 'person',
      name: 'María de la Cruz Santos',
      attrs: {
        aliases: ['María'],
        card_chunk: `people-test.md:${cardIndex('María de la Cruz Santos')}`,
      },
    },
  ];
  return installPackFromFiles(mockConn as any, [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id: 'identity-test',
        name: 'Identity Test',
        description: 'fictional people fixture',
        version: 1,
      }),
    },
    { name: 'nodes.json', content: JSON.stringify(nodes) },
    { name: 'edges.json', content: '[]' },
    ...(opts.graphOnly ? [] : [{ name: 'people-test.md', content: PEOPLE }]),
  ]);
}

beforeEach(() => {
  mockConn = makeConn();
});

describe('structured person-card index', () => {
  test('installs explicit links by source-local chunk index', () => {
    installPeople();
    const rows = mockConn.execute(
      'SELECT person_id, chunk_id FROM person_card_chunks ORDER BY person_id',
    ).rows!._array as Array<{ person_id: string; chunk_id: number }>;
    expect(rows.map(row => row.person_id)).toEqual([
      'person:dta',
      'person:maria',
      'person:pug',
    ]);
    expect(new Set(rows.map(row => row.chunk_id)).size).toBe(3);
  });

  test('backfills a unique legacy filename link without retrieval rank', () => {
    installPeople({ legacy: true });
    const row = mockConn.execute(
      "SELECT chunk_id FROM person_card_chunks WHERE person_id = 'person:pug'",
    );
    expect(row.rows?.length).toBe(1);
  });

  test('keeps graph-only packs usable and leaves cards unindexed', () => {
    const result = installPeople({ graphOnly: true });
    expect(result.nodes).toBe(3);
    expect(mockConn.execute('SELECT * FROM person_card_chunks').rows?._array).toEqual([]);
  });
});

describe('lookupPersonIdentity', () => {
  beforeEach(() => {
    installPeople();
    refreshFactGraph(mockConn as any);
  });

  test('resolves an exact alias to one ID and fetches only its linked card', () => {
    const intent = identityIntent('Who is Alex Mercer?')!;
    const outcome = lookupPersonIdentity(intent);
    expect(outcome.status).toBe('resolved');
    if (outcome.status !== 'resolved') {
      return;
    }
    expect(outcome.person).toEqual({
      pack_id: 'identity-test',
      id: 'person:pug',
      name: 'Rook',
    });
    expect(outcome.card.person_ref).toEqual(outcome.person);
    expect(outcome.card.name).toBe('Rook');
    expect(outcome.source.doc).toBe('Who is Rook?');
  });

  test('asks on an alias shared by two people instead of choosing by row order', () => {
    const outcome = lookupPersonIdentity(identityIntent('Who is David?')!);
    expect(outcome.status).toBe('ambiguous');
    if (outcome.status === 'ambiguous') {
      expect(outcome.candidates.map(candidate => candidate.id)).toEqual([
        'person:dta',
        'person:pug',
      ]);
    }
  });

  test('Unicode and four-plus-token canonical names resolve exactly', () => {
    const outcome = lookupPersonIdentity(
      identityIntent('Who is María de la Cruz Santos?')!,
    );
    expect(outcome.status).toBe('resolved');
    if (outcome.status === 'resolved') {
      expect(outcome.person.id).toBe('person:maria');
    }
  });

  test('an excluded person is invisible at resolve time and revocable', () => {
    const person = {
      pack_id: 'identity-test',
      id: 'person:pug',
      name: 'Rook',
    };
    expect(isFactNodeExcluded(mockConn as any, person)).toBe(false);
    expect(searchDocs({ query: 'Rook' }, 5).results.length).toBeGreaterThan(0);

    const hidden = setFactNodeExcluded(mockConn as any, person, true);
    expect(hidden.warnings).toEqual([]);
    expect(hidden.graph).toEqual({ nodes: 2, edges: 0 });
    expect(isFactNodeExcluded(mockConn as any, person)).toBe(true);
    expect(
      mockConn.execute(
        "SELECT * FROM person_card_chunks WHERE person_id = 'person:pug'",
      ).rows?._array,
    ).toEqual([]);
    expect(
      lookupPersonIdentity(identityIntent('Who is Alex Mercer?')!).status,
    ).toBe('not_found');
    expect(
      lookupPersonIdentity(identityIntent('Tell me about him', person)!).status,
    ).toBe('not_found');
    expect(searchDocs({ query: 'Rook' }, 5).results).toEqual([]);

    const restored = setFactNodeExcluded(mockConn as any, person, false);
    expect(restored.warnings).toEqual([]);
    expect(restored.graph).toEqual({ nodes: 3, edges: 0 });
    expect(
      lookupPersonIdentity(identityIntent('Who is Alex Mercer?')!).status,
    ).toBe('resolved');
    expect(searchDocs({ query: 'Rook' }, 5).results.length).toBeGreaterThan(0);
  });

  test('the Settings undo list mirrors the exclusion set exactly', () => {
    // THE PROMISE THE DIALOG MAKES. Hiding a person from a card tells the
    // user they can bring them back from Settings › Hidden people. This is
    // that surface's read side, and the contract is exact mirroring: every
    // hide appears with the name the pack gave them and the pack's display
    // name, every restore removes it, and nothing else is ever listed. A
    // hide with no visible way back is a delete with extra steps.
    installPeople();
    const rook = { pack_id: 'identity-test', id: 'person:pug' };
    const ajm = { pack_id: 'identity-test', id: 'person:dta' };
    expect(listHiddenPeople(mockConn as any)).toEqual([]);

    setFactNodeExcluded(mockConn as any, rook, true);
    expect(listHiddenPeople(mockConn as any)).toEqual([
      { pack_id: 'identity-test', id: 'person:pug', name: 'Rook',
        pack_name: 'Identity Test' },
    ]);

    setFactNodeExcluded(mockConn as any, ajm, true);
    // sorted by name, so the order is deterministic for the UI
    expect(listHiddenPeople(mockConn as any).map(h => h.name)).toEqual([
      'AJM', 'Rook',
    ]);

    // idempotent hide does not duplicate a row (INSERT OR IGNORE)
    setFactNodeExcluded(mockConn as any, rook, true);
    expect(listHiddenPeople(mockConn as any)).toHaveLength(2);

    setFactNodeExcluded(mockConn as any, rook, false);
    expect(listHiddenPeople(mockConn as any).map(h => h.name)).toEqual(['AJM']);
    setFactNodeExcluded(mockConn as any, ajm, false);
    expect(listHiddenPeople(mockConn as any)).toEqual([]);

    // a stale exclusion row whose node no longer exists (pack removed) must
    // NOT surface as a ghost the user cannot restore -- the JOIN drops it
    mockConn.execute(
      "INSERT INTO fact_exclusions (pack_id, node_id) VALUES ('gone-pack', 'person:x')",
    );
    expect(listHiddenPeople(mockConn as any)).toEqual([]);
  });

  test('an exclusion rolls back when the replacement graph is invalid', () => {
    const person = {
      pack_id: 'identity-test',
      id: 'person:pug',
      name: 'Rook',
    };
    mockConn.execute(
      `INSERT INTO nodes (pack_id, id, type, name, attrs)
       VALUES (?, ?, ?, ?, ?)`,
      ['identity-test', 'person:broken', 'person', 'Broken', '{'],
    );

    expect(() => setFactNodeExcluded(mockConn as any, person, true)).toThrow(
      'Invalid graph attrs for identity-test/person:broken',
    );
    expect(isFactNodeExcluded(mockConn as any, person)).toBe(false);
    expect(
      lookupPersonIdentity(identityIntent('Who is Alex Mercer?')!).status,
    ).toBe('resolved');
  });

  test('an exact structured anchor bypasses canonical-name ambiguity', () => {
    const anchor = { pack_id: 'identity-test', id: 'person:pug', name: 'Rook' };
    const outcome = lookupPersonIdentity(identityIntent('Tell me about him', anchor)!);
    expect(outcome.status).toBe('resolved');
    if (outcome.status === 'resolved') {
      expect(outcome.person).toEqual(anchor);
    }
  });
});
