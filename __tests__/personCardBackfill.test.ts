import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  backfillPersonCards,
  identityAffiliationTerms,
  PERSON_CARD_INDEX_VERSION,
} from '../src/events/db';

const { DatabaseSync } = require('node:sqlite');

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

type Conn = ReturnType<typeof makeConn>;

function addPack(
  conn: Conn,
  id: string,
  name: string,
  enabled = true,
): void {
  conn.execute(
    'INSERT INTO packs (id, name, enabled) VALUES (?, ?, ?)',
    [id, name, enabled ? 1 : 0],
  );
}

function addLinkedPerson(conn: Conn, packId = 'people-pack'): void {
  addPack(conn, packId, 'Robot Heart History');
  conn.execute(
    'INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, ?, ?, ?)',
    [
      packId,
      'people-test.md',
      'Campers > Bob — Robot Heart camper > Who is Bob?',
      'Bob is a Robot Heart camper, active on the camp list in Aug 2026.',
    ],
  );
  conn.execute(
    'INSERT INTO nodes (pack_id, id, type, name, attrs) VALUES (?, ?, ?, ?, ?)',
    [
      packId,
      'person:bob',
      'person',
      'Bob',
      JSON.stringify({ card_chunk: 'people-test.md:0' }),
    ],
  );
}

function stamp(conn: Conn, value: string): void {
  conn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['person_card_index_version', value],
  );
}

function storedStamp(conn: Conn): string {
  return String(
    conn.execute(
      "SELECT value FROM settings WHERE key = 'person_card_index_version'",
    ).rows!.item(0).value,
  );
}

describe('person-card startup backfill receipts', () => {
  test('invalidates the legacy v1 stamp, rebuilds, and records evidence', () => {
    const conn = makeConn();
    addLinkedPerson(conn);
    stamp(conn, '1');

    backfillPersonCards(conn as any);

    expect(
      conn.execute('SELECT person_id FROM person_card_chunks').rows?._array,
    ).toEqual([{ person_id: 'person:bob' }]);
    expect(JSON.parse(storedStamp(conn))).toEqual({
      version: PERSON_CARD_INDEX_VERSION,
      packs: [
        {
          pack_id: 'people-pack',
          graphPeople: 1,
          explicitCardChunks: 1,
          legacyCards: 0,
          excludedLinkedPeople: 0,
          indexedRows: 1,
        },
      ],
    });
  });

  test('refuses to stamp a linked pack whose rebuild produces zero rows', () => {
    const conn = makeConn();
    addPack(conn, 'broken-pack', 'Broken People');
    conn.execute(
      'INSERT INTO nodes (pack_id, id, type, name, attrs) VALUES (?, ?, ?, ?, ?)',
      [
        'broken-pack',
        'person:missing',
        'person',
        'Missing',
        JSON.stringify({ card_chunk: 'people-missing.md:0' }),
      ],
    );
    stamp(conn, '1');

    expect(() => backfillPersonCards(conn as any)).toThrow(
      'Person card backfill produced zero rows for linked pack broken-pack',
    );
    expect(storedStamp(conn)).toBe('1');
  });

  test('allows an empty index when every linked person is excluded', () => {
    const conn = makeConn();
    addLinkedPerson(conn);
    conn.execute(
      'INSERT INTO fact_exclusions (pack_id, node_id) VALUES (?, ?)',
      ['people-pack', 'person:bob'],
    );
    stamp(conn, '1');

    backfillPersonCards(conn as any);

    expect(
      conn.execute('SELECT * FROM person_card_chunks').rows?._array,
    ).toEqual([]);
    expect(JSON.parse(storedStamp(conn)).packs[0]).toMatchObject({
      pack_id: 'people-pack',
      excludedLinkedPeople: 1,
      indexedRows: 0,
    });
  });
});

describe('identity affiliation terms', () => {
  test('uses enabled person-bearing packs, not generic document packs', () => {
    const conn = makeConn();
    addPack(conn, 'survival-guide', 'Survival Guide');
    addLinkedPerson(conn, 'robot-heart-history');
    addPack(conn, 'disabled-people', 'Dusty Star Archive', false);
    conn.execute(
      'INSERT INTO nodes (pack_id, id, type, name) VALUES (?, ?, ?, ?)',
      ['disabled-people', 'person:pug', 'person', 'Rook'],
    );

    expect(identityAffiliationTerms(conn as any)).toEqual([
      'Robot Heart History',
      'Robot',
      'Heart',
      'robot-heart-history',
    ]);
  });
});
