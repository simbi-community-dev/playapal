/**
 * The live art directory (owner, 2026-08-20: "build into the app the
 * ability to create an art directory live and beam it aggregatorily across
 * hippo-camper phones while at the event to build our own in the first
 * couple of days and during setup").
 *
 * Burning Man embargoes art LOCATIONS until Gate opens and he lands two
 * days before that, so the imported art pack ships with no locations at all
 * (tools/load_art.py). A camper's OWN sighting is not their data and is not
 * embargoed — it can carry an address and beam the moment it is typed. The
 * acceptance set:
 *   an art note rides the sealed beam A→B with its address intact, projects
 *   into the reader chunk, and mints no phantom event row;
 *   it is findable through the REAL FTS by piece name AND by artist, which
 *   is why the artist rides the title (the chunk heading);
 *   FORWARD COMPAT — a note whose kind the receiving build has never heard
 *   of degrades to 'memory' with every field intact, INCLUDING through the
 *   seal. That last clause is the one that nearly wasn't true: the receiver
 *   re-derives the payload hash from the note it parsed, so coercing the
 *   kind before hashing made an unknown kind fail the integrity check and
 *   refuse the WHOLE beam — every campmate's board with it. A camp on mixed
 *   builds would have found that on playa with no way to fix it.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import {
  CAMP_WRITER_ID_KEY,
  campIdFor,
  exportCampBundle,
  installCampBundle,
  keyIdFor,
  saveCampProfile,
  upsertCampNote,
} from '../src/camp/campBoard';
import {
  asKind,
  canonicalNotes,
  listCampNotes,
  type WireNote,
} from '../src/camp/campNotes';
import { hmacSha256Hex, sha256, utf8Bytes } from '../src/camp/hmac';
import { searchDocs } from '../src/docs/searchDocs';

const { DatabaseSync } = require('node:sqlite');

const PASSPHRASE = 'dusty hippos 2026';

type Conn = import('../src/events/engine').DbConnection;

function makePhone(writerId: string): Conn {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  } as unknown as Conn;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  return conn;
}

const mockCtx: { conn: Conn } = { conn: undefined as never };
jest.mock('../src/events/db', () => ({
  getDb: () => mockCtx.conn,
  isFtsAvailable: () => true,
}));

const join = (conn: Conn, name: string) =>
  saveCampProfile(conn, { authorName: name, passphrase: PASSPHRASE });

const refts = (conn: Conn) => {
  for (const sql of REBUILD_FTS_SQL) {
    conn.execute(sql);
  }
};

const noteChunks = (conn: Conn): { heading: string; content: string }[] =>
  conn.execute(
    "SELECT heading, content FROM doc_chunks WHERE source_file = 'camp-notes' ORDER BY id",
  ).rows!._array as { heading: string; content: string }[];

const sha256Hex = (s: string): string =>
  Array.from(sha256(utf8Bytes(s)), b => b.toString(16).padStart(2, '0')).join('');

/**
 * One envelope sealed the way a NEWER build would seal it — same primitives
 * campBoard uses, so the only thing under test is the receiver's reading of
 * a kind it does not know. The writer has no posts, so the v2 payload is
 * the record separator plus the notes half.
 */
function beamOneNote(writerId: string, authorName: string, note: WireNote): string {
  const campId = campIdFor(PASSPHRASE);
  const canonical = `\u001e\n${canonicalNotes([note])}`;
  const head = {
    format: 2,
    camp_id: campId,
    writer_id: writerId,
    author_name: authorName,
    key_id: keyIdFor(PASSPHRASE),
    seq: 1,
    payload_hash: sha256Hex(canonical),
  };
  const mac = [
    'playapal-camp-board',
    String(head.format),
    head.camp_id,
    head.writer_id,
    head.author_name,
    head.key_id,
    String(head.seq),
    head.payload_hash,
    canonical,
  ].join('\n');
  return JSON.stringify({
    kind: 'playapal-camp-board',
    format: 2,
    camp_id: campId,
    envelopes: [
      {
        ...head,
        posts: [],
        notes: [note],
        tag: hmacSha256Hex(`playapal-camp-v0:${PASSPHRASE}`, mac),
      },
    ],
  });
}

/** An art sighting as a newer build would put it on the wire. `kind` is
 * typed as a plain string on WireNote precisely so a test — like a real
 * newer sender — can put a value there that this build's union has never
 * contained. */
const sighting = (writerId: string, kind: string): WireNote => ({
  id: `${writerId}:n-bloom-1`,
  writer_id: writerId,
  author_name: 'Dusty',
  kind,
  title: 'Bloom — by Ada Weatherwax',
  when_date: '',
  time_start: '',
  time_end: '',
  where_addr: '4:36 & G',
  text: 'A steel hippo the size of a shipping container; it breathes fire at dusk.',
  subject_type: '',
  subject_key: '',
  year: '',
  supersedes: '',
  created_at: '2026-08-26T18:00:00.000Z',
  revised_at: '',
  photo: '',
});

describe('an art note travels and lands as art', () => {
  test('A→B: the address survives the seal, the chunk carries it, no event row appears', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');

    upsertCampNote(a, {
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G',
      text: 'A steel hippo the size of a shipping container; it breathes fire at dusk.',
    });

    const res = installCampBundle(b, exportCampBundle(a));
    expect(res.notes).toBe(1);
    const landed = listCampNotes(b, res.campId);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G',
    });

    const chunks = noteChunks(b);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Bloom — by Ada Weatherwax');
    expect(chunks[0].content).toContain('Art on playa at 4:36 & G');
    expect(chunks[0].content).toContain('breathes fire at dusk');
    // Art is a place, not a happening: an art note must not mint a Now-tab
    // event row the way an event-kind note does.
    expect(
      b.execute("SELECT * FROM events WHERE source_kind = 'camp_note'").rows!._array,
    ).toHaveLength(0);
  });

  test('the reader can find it by the piece OR by the artist, through real FTS', () => {
    mockCtx.conn = makePhone('writeraaaa');
    join(mockCtx.conn, 'Dusty');
    upsertCampNote(mockCtx.conn, {
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G',
      text: 'A steel hippo the size of a shipping container; it breathes fire at dusk.',
    });
    refts(mockCtx.conn);

    for (const query of ['Bloom', 'Weatherwax']) {
      const found = searchDocs({ query }, 5).results;
      expect(
        found.some(r => r.heading === 'Bloom — by Ada Weatherwax'),
      ).toBe(true);
      // The address is the whole point of logging it ourselves: whatever
      // the Angel retrieves must be able to answer "where is it?".
      expect(
        found.some(r => r.content.includes('4:36 & G')),
      ).toBe(true);
    }
  });
});

describe('forward compatibility: a kind this build has never heard of', () => {
  test('asKind degrades an unknown kind to memory and knows the kinds we ship', () => {
    for (const known of ['memory', 'event', 'fix', 'resource', 'art']) {
      expect(asKind(known)).toBe(known);
    }
    expect(asKind('installation')).toBe('memory');
    expect(asKind(undefined)).toBe('memory');
  });

  test('a sealed note with an unknown kind IMPORTS, degrades to memory, and keeps every word', () => {
    const b = makePhone('writerbbbb');
    join(b, 'Marisol');

    const res = installCampBundle(
      b,
      beamOneNote('writeraaaa', 'Dusty', sighting('writeraaaa', 'installation')),
    );

    expect(res.installed).toHaveLength(1);
    expect(res.notes).toBe(1);
    const landed = listCampNotes(b, res.campId);
    expect(landed).toHaveLength(1);
    // Degraded — but nothing was thrown away with the label.
    expect(landed[0].kind).toBe('memory');
    expect(landed[0].title).toBe('Bloom — by Ada Weatherwax');
    expect(landed[0].where_addr).toBe('4:36 & G');
    expect(landed[0].text).toContain('breathes fire at dusk');
    // And it is readable/searchable, not a silent orphan row.
    const chunks = noteChunks(b);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Bloom — by Ada Weatherwax');
    expect(chunks[0].content).toContain('4:36 & G');
  });

  test('an unknown kind relays intact: B re-beams to C, which reads it the same way', () => {
    const b = makePhone('writerbbbb');
    const c = makePhone('writercccc');
    join(b, 'Marisol');
    join(c, 'Kupo');

    installCampBundle(
      b,
      beamOneNote('writeraaaa', 'Dusty', sighting('writeraaaa', 'installation')),
    );
    // The relay re-exports A's stored envelope verbatim: if the receiver
    // had rewritten the kind before storing, this hop would fail the seal.
    const res = installCampBundle(c, exportCampBundle(b));
    expect(res.notes).toBe(1);
    const landed = listCampNotes(c, res.campId);
    expect(landed[0].kind).toBe('memory');
    expect(landed[0].where_addr).toBe('4:36 & G');
  });

  test('the seal still binds an unknown kind: flipping it in transit is refused', () => {
    const b = makePhone('writerbbbb');
    join(b, 'Marisol');
    const beam = JSON.parse(
      beamOneNote('writeraaaa', 'Dusty', sighting('writeraaaa', 'installation')),
    );
    beam.envelopes[0].notes[0].kind = 'fix';
    expect(() => installCampBundle(b, JSON.stringify(beam))).toThrow(/integrity/);
    expect(listCampNotes(b, campIdFor(PASSPHRASE))).toHaveLength(0);
  });
});
