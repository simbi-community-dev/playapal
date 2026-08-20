/**
 * Pack reader helpers on the app's own DDL (in-memory node:sqlite, the
 * friendCard.test.ts pattern). The load-bearing assertion is ORDER: the
 * reader reproduces each source document exactly by insertion ordinal
 * (doc_chunks.id — the rowid, assigned in insert order), even when two
 * sources' inserts interleave.
 */
import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  contentParagraphs,
  headingSegments,
  humanizeSource,
  listDocSources,
  markHeadingChanges,
  readDocSource,
} from '../src/docs/readPack';

const { DatabaseSync } = require('node:sqlite');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  for (const sql of BASE_TABLES_SQL) {
    db.exec(sql);
  }
  // The app's DbConnection facade over node:sqlite (friendCard.test.ts shape).
  return {
    execute: (sql: string, args: unknown[] = []) => {
      const stmt = db.prepare(sql);
      if (/^\s*select/i.test(sql)) {
        const rows = stmt.all(...(args as any[]));
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
      }
      stmt.run(...(args as any[]));
      return { rows: undefined };
    },
  } as any;
}

/** Seed one chunk the way installPack does: no explicit id, insert order IS
 * document order. */
function addChunk(
  conn: any,
  packId: string,
  source: string,
  heading: string,
  content: string,
) {
  conn.execute(
    'INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, ?, ?, ?)',
    [packId, source, heading, content],
  );
}

/** Two sources with interleaved inserts and interleaved headings — source
 * names chosen so alphabetical order would CONTRADICT insertion order. */
function seedLore(conn: any) {
  addChunk(conn, 'lore', 'zebra-guide.md', 'Survival > Water', 'w1');
  addChunk(conn, 'lore', 'alpha-history.md', 'History', 'h1');
  addChunk(conn, 'lore', 'zebra-guide.md', 'Survival > Water', 'w2');
  addChunk(conn, 'lore', 'zebra-guide.md', 'Survival > Shade', 's1');
  addChunk(conn, 'lore', 'alpha-history.md', 'History > Founding', 'h2');
  // Another pack sharing a filename: scope must hold.
  addChunk(conn, 'other', 'zebra-guide.md', 'Elsewhere', 'x1');
}

describe('listDocSources', () => {
  it('lists sources in first-insert order with counts and first headings', () => {
    const conn = makeDb();
    seedLore(conn);
    expect(listDocSources(conn, 'lore')).toEqual([
      { source: 'zebra-guide.md', chunkCount: 3, firstHeading: 'Survival > Water' },
      { source: 'alpha-history.md', chunkCount: 2, firstHeading: 'History' },
    ]);
  });

  it('returns nothing for a pack with no chunks', () => {
    const conn = makeDb();
    seedLore(conn);
    expect(listDocSources(conn, 'empty')).toEqual([]);
  });
});

describe('readDocSource', () => {
  it('preserves document order exactly, across interleaved inserts', () => {
    const conn = makeDb();
    seedLore(conn);
    expect(readDocSource(conn, 'lore', 'zebra-guide.md').map(c => c.content)).toEqual([
      'w1',
      'w2',
      's1',
    ]);
    expect(readDocSource(conn, 'lore', 'alpha-history.md')).toEqual([
      { heading: 'History', content: 'h1' },
      { heading: 'History > Founding', content: 'h2' },
    ]);
  });

  it('never leaks a same-named source from another pack', () => {
    const conn = makeDb();
    seedLore(conn);
    expect(readDocSource(conn, 'other', 'zebra-guide.md').map(c => c.content)).toEqual([
      'x1',
    ]);
  });
});

describe('markHeadingChanges', () => {
  it('flags a heading only where it differs from the previous chunk', () => {
    const chunk = (heading: string, content = 'c') => ({ heading, content });
    const marked = markHeadingChanges([
      chunk('A'),
      chunk('A'),
      chunk('B'),
      chunk(''),
      chunk('B'),
    ]);
    expect(marked.map(c => c.newHeading)).toEqual([true, false, true, false, true]);
  });
});

describe('headingSegments', () => {
  it('splits the chunker breadcrumb and drops empties', () => {
    expect(headingSegments('Survival > Water > Storage')).toEqual([
      'Survival',
      'Water',
      'Storage',
    ]);
    expect(headingSegments('')).toEqual([]);
  });
});

describe('humanizeSource', () => {
  it('a single-source pack reads as the pack, not its filename', () => {
    expect(humanizeSource('guide.md', 'Survival guide', 1)).toBe('Survival guide');
  });

  it('multi-source packs humanize the filename stem', () => {
    expect(humanizeSource('camp-history.md', 'Camp Lore', 2)).toBe('Camp history');
    expect(humanizeSource('docs/sub_file.txt', 'Camp Lore', 3)).toBe('Sub file');
  });
});

describe('contentParagraphs', () => {
  it('strips #s, bullets become •, blank lines split paragraphs', () => {
    expect(
      contentParagraphs('# Title\nBody line\n\n- one\n* two\n\n\nLast'),
    ).toEqual(['Title\nBody line', '• one\n• two', 'Last']);
  });

  it('keeps plain prose intact', () => {
    expect(contentParagraphs('Just a sentence.')).toEqual(['Just a sentence.']);
  });
});
