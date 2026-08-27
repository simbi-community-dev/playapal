/**
 * Ruling H (docs/CAMP-NOTES-DESIGN.md): the art photo travels sealed, but
 * ONLY when it exists.
 *
 * The load-bearing property is BACK-COMPAT: a photo-less note must hash
 * byte-identically to builds that predate the field, so plain boards cross
 * the 0.6.x → 0.7.0 line in both directions. The second property is the
 * beam-breaker class from 2026-08-20 in reverse: a photo IS hash-material
 * when present, so parse bounds it but never rewrites it.
 *
 * Runs the app's real modules against node:sqlite, same harness as
 * campNotes.test.ts (two phones, real export → import).
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, ADDITIVE_COLUMNS } from '../src/events/schema';
import {
  CAMP_WRITER_ID_KEY,
  EXPORT_CEILING_BYTES,
  MAX_BEAM_BYTES,
  MAX_BEAM_ENVELOPES,
  MAX_POSTS_PER_WRITER,
  POST_TEXT_MAX,
  exportCampBeam,
  exportCampBundle,
  upsertCampPost,
  installCampBundle,
  saveCampProfile,
  upsertCampNote,
} from '../src/camp/campBoard';
import { utf8Bytes } from '../src/camp/hmac';
import {
  CampNoteError,
  NOTE_PHOTO_BUDGET_B64,
  NOTE_PHOTO_MAX_B64,
  NOTE_PHOTO_WIRE_MAX_B64,
  WireNote,
  canonicalNotes,
  listCampNotes,
  parseWireNotes,
} from '../src/camp/campNotes';

const { DatabaseSync } = require('node:sqlite');
const NodeBuffer = require('buffer').Buffer;

function makePhone(writerId: string) {
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
  } as any;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  return conn;
}

const join = (conn: any, name: string) =>
  saveCampProfile(conn, { authorName: name, passphrase: 'dusty hippos 2026' });

/** deterministic pseudo-JPEG base64 built from BYTES: real SOI (0xFFD8),
 * filler, real EOI (0xFFD9), encoded with node's base64 — so isJpegBase64
 * (prefix + trailer) accepts it the way it accepts a camera JPEG. n is a
 * floor on the encoded length; the caps have slack. */
const b64 = (n: number): string => {
  const bytes = Math.max(6, Math.ceil((n / 4) * 3));
  const buf = NodeBuffer.alloc(bytes, 0x41);
  // FF D8 FF is what '/9j/' decodes to — FF D8 alone encodes '/9hB…' and
  // fails the prefix (codex addendum: both helpers were self-rejecting).
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[bytes - 2] = 0xff;
  buf[bytes - 1] = 0xd9;
  return buf.toString('base64');
};

const wire = (over: Partial<WireNote> = {}): WireNote => ({
  id: 'writeraaaa:n-1',
  writer_id: 'writeraaaa',
  author_name: 'Dusty',
  kind: 'art',
  title: 'Bloom',
  when_date: '',
  time_start: '',
  time_end: '',
  where_addr: '3:00 & 2000ft',
  text: 'A steel flower that opens at dusk.',
  subject_type: '',
  subject_key: '',
  year: '',
  supersedes: '',
  created_at: '2026-08-21T00:00:00.000Z',
  revised_at: '',
  photo: '',
  ...over,
});

describe('ruling H: canonical payload', () => {
  test('a photo-less note hashes byte-identically to the pre-photo wire format', () => {
    // Literal captured from canonicalNotes BEFORE the photo field existed
    // (v0.6.1 shape). If this breaks, 0.6.x phones refuse 0.7.0 beams that
    // carry NO photos — the exact cross-version break ruling H forbids.
    const legacy = [
      'writeraaaa:n-1', 'art', 'Bloom', '', '', '', '3:00 & 2000ft',
      'A steel flower that opens at dusk.', '', '', '', '',
      '2026-08-21T00:00:00.000Z', '',
    ].join('\u001f');
    expect(canonicalNotes([wire()])).toBe(legacy);
  });

  test('a photo joins the sealed payload when present — as the last field', () => {
    const p = b64(64);
    expect(canonicalNotes([wire({ photo: p })])).toBe(
      canonicalNotes([wire()]) + '\u001f' + p,
    );
  });
});

describe('ruling H: the wire boundary', () => {
  test('a photo over the wire cap refuses the notes section', () => {
    expect(() =>
      parseWireNotes([wire({ photo: b64(NOTE_PHOTO_WIRE_MAX_B64 + 4) })], 'writeraaaa', 'Dusty'),
    ).toThrow(CampNoteError);
  });

  test('a photo that is not base64 refuses (it is hash-material, never rewritten)', () => {
    expect(() =>
      parseWireNotes([wire({ photo: 'not base64!!' })], 'writeraaaa', 'Dusty'),
    ).toThrow(CampNoteError);
  });

  test('valid base64 that is not a JPEG (no SOI) refuses — the render labels image/jpeg', () => {
    expect(() =>
      parseWireNotes([wire({ photo: 'iVBORw0KGgoAAAANSUhEUg==' })], 'writeraaaa', 'Dusty'),
    ).toThrow(/not a JPEG/);
  });

  test('a valid SOI with a missing EOI (truncation, the realistic corruption) refuses', () => {
    const truncated = b64(1024).slice(0, -8) + 'AAAAAAAA'; // tail no longer FF D9
    expect(() =>
      parseWireNotes([wire({ photo: truncated })], 'writeraaaa', 'Dusty'),
    ).toThrow(/not a JPEG/);
  });

  test('a photo on a KNOWN non-art kind refuses; on an UNKNOWN kind it rides (forward compat)', () => {
    expect(() =>
      parseWireNotes([wire({ kind: 'memory', photo: b64(64) })], 'writeraaaa', 'Dusty'),
    ).toThrow(/cannot carry one/);
    const future = parseWireNotes(
      [wire({ kind: 'sculpture', photo: b64(64) })],
      'writeraaaa',
      'Dusty',
    );
    expect(future[0].photo).toBe(b64(64));
  });

  test('a valid photo survives parse byte-for-byte', () => {
    const p = b64(1024);
    const parsed = parseWireNotes([wire({ photo: p })], 'writeraaaa', 'Dusty');
    expect(parsed[0].photo).toBe(p);
  });
});

describe('ruling H: authoring caps', () => {
  test('over the authoring cap refuses with words about snapping again', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    expect(() =>
      upsertCampNote(a, { kind: 'art', text: 'big', photo: b64(NOTE_PHOTO_MAX_B64 + 4) }),
    ).toThrow(/too big/);
  });

  test('the per-writer photo budget bounds beam PRESSURE from photos (not a beamability guarantee)', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const chunk = NOTE_PHOTO_MAX_B64; // 40 KB per note
    const fits = Math.floor(NOTE_PHOTO_BUDGET_B64 / chunk);
    for (let i = 0; i < fits; i++) {
      upsertCampNote(a, { kind: 'art', text: `piece ${i}`, photo: b64(chunk) });
    }
    expect(() =>
      upsertCampNote(a, { kind: 'art', text: 'one too many', photo: b64(chunk) }),
    ).toThrow(/full load of photos/);
    // photo-less notes are still welcome — the budget is about beams
    expect(() => upsertCampNote(a, { kind: 'art', text: 'no photo' })).not.toThrow();
  });
});

describe('ruling H: the beam, end to end', () => {
  test('a photo note authored on A arrives on B with the photo intact', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    const p = b64(2048);
    upsertCampNote(a, {
      kind: 'art',
      title: 'Bloom — by Ada',
      where_addr: '3:00 & 2000ft',
      text: 'A steel flower that opens at dusk.',
      photo: p,
    });
    const res = installCampBundle(b, exportCampBundle(a));
    expect(res.notes).toBe(1);
    const got = listCampNotes(b, res.campId);
    expect(got[0].photo).toBe(p);
    // and the projection stayed text-only: the photo is never in a chunk
    const chunks = b
      .execute("SELECT content FROM doc_chunks WHERE source_file = 'camp-notes'")
      .rows!._array.map((r: any) => r.content)
      .join(' ');
    expect(chunks).not.toContain(p.slice(0, 32));
  });

  test('a tampered photo fails the seal and refuses the whole beam', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampNote(a, { kind: 'art', text: 'real piece', photo: b64(512) });
    const bundle = JSON.parse(exportCampBundle(a));
    // The envelope carries notes DIRECTLY (no nested payload string): the
    // receiver re-derives the canonical payload from these parsed notes and
    // checks the tag over it. Tamper one photo char in place.
    const env = bundle.envelopes.find((e: any) => (e.notes ?? []).length > 0);
    expect(env).toBeDefined();
    expect(env.notes[0].photo).toBe(b64(512));
    // Tamper a MIDDLE char: past the SOI prefix, before the EOI tail —
    // inside every structural validator's blind spot, so only the SEAL can
    // see it. This site is stable by construction: a validator can only
    // ever inspect structure (prefix, grammar, trailer), and the middle of
    // the body is structure-free. (B17 flipped the first char and died at
    // the SOI check; B20 flipped the last and died at the EOI check —
    // the same wrong-gate class, three validators in a row.)
    const orig = b64(512);
    const mid = Math.floor(orig.length / 2);
    const flipped = orig[mid] === 'A' ? 'B' : 'A';
    env.notes[0].photo = orig.slice(0, mid) + flipped + orig.slice(mid + 1);
    expect(env.notes[0].photo).not.toBe(orig);
    // The INTEGRITY gate specifically, and the all-or-nothing result —
    // a bare toThrow() would pass on any parse error long before the seal
    // (codex reverify; campNotes.test.ts models the shape).
    expect(() => installCampBundle(b, JSON.stringify(bundle))).toThrow(/integrity/);
    expect(listCampNotes(b, bundle.camp_id)).toHaveLength(0);
  });
});

describe('the additive migration exists and applies', () => {
  test('an existing pre-photo camp_notes table gains the column', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE camp_notes (id TEXT PRIMARY KEY, camp_id TEXT NOT NULL,
      writer_id TEXT NOT NULL, author_name TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', when_date TEXT NOT NULL DEFAULT '',
      time_start TEXT NOT NULL DEFAULT '', time_end TEXT NOT NULL DEFAULT '',
      where_addr TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT '', subject_key TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '', supersedes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, revised_at TEXT NOT NULL DEFAULT '')`);
    const mig = ADDITIVE_COLUMNS.find(
      m => m.table === 'camp_notes' && m.column === 'photo',
    );
    expect(mig).toBeDefined();
    db.exec(mig!.ddl);
    const cols = db.prepare('PRAGMA table_info(camp_notes)').all() as any[];
    const photo = cols.find(c => c.name === 'photo');
    expect(photo).toBeDefined();
    expect(String(photo.dflt_value)).toBe("''");
  });
});

describe('the bundle admits itself at export (codex blocker 7)', () => {
  test('a bundle over the ceiling sheds FOREIGN envelopes, keeps its own, and stays importable', () => {
    // three writers, each near their own photo budget: any two exceed the
    // 4 MiB import ceiling, so a full multi-hop bundle can no longer ride
    const phones = ['writeraaaa', 'writerbbbb', 'writercccc'].map(w => {
      const c = makePhone(w);
      join(c, `Camper-${w.slice(-4)}`);
      const per = NOTE_PHOTO_MAX_B64;
      const n = Math.floor(NOTE_PHOTO_BUDGET_B64 / per);
      for (let i = 0; i < n; i++) {
        upsertCampNote(c, { kind: 'art', text: `piece ${i}`, photo: b64(per) });
      }
      return c;
    });
    const [a, b, c] = phones;
    // b learns a's board, c learns b's (which now carries a's if it fits)
    installCampBundle(b, exportCampBundle(a));
    const fromB = exportCampBeam(b);
    expect(utf8Bytes(fromB.bundle).length).toBeLessThanOrEqual(EXPORT_CEILING_BYTES);
    // b's own envelope is ~2.5 MB, a's is too — a must have been shed
    expect(fromB.shedAuthors).toContain('Camper-aaaa');
    // and what b actually beams still imports cleanly on c
    const res = installCampBundle(c, fromB.bundle);
    expect(res.installed.length).toBeGreaterThan(0);
  });

  test('under the ceiling nothing is shed', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampNote(a, { kind: 'art', text: 'small', photo: b64(1024) });
    installCampBundle(b, exportCampBundle(a));
    const out = exportCampBeam(b);
    expect(out.shedAuthors).toEqual([]);
    expect(JSON.parse(out.bundle).envelopes).toHaveLength(2);
  });
});

describe('a photo-saturated board still beams (the common case stays under the ceiling)', () => {
  test('photo budget saturated + full text on those notes exports without shedding', () => {
    // NOT an "own can never outgrow" claim — legal aggregate state CAN
    // exceed the ceiling (independent caps; codex P1.6) and then export
    // refuses with words, which the byte-vs-units test proves. This pins
    // the COMMON case: a board that is photos-plus-text stays beamable.
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const per = NOTE_PHOTO_MAX_B64;
    const n = Math.floor(NOTE_PHOTO_BUDGET_B64 / per);
    const longText = 'x'.repeat(2000);
    for (let i = 0; i < n; i++) {
      upsertCampNote(a, { kind: 'art', text: `${i} ${longText}`, photo: b64(per) });
    }
    const out = exportCampBeam(a);
    expect(out.shedAuthors).toEqual([]);
    expect(utf8Bytes(out.bundle).length).toBeLessThanOrEqual(EXPORT_CEILING_BYTES);
  });
});

describe('board posts are bounded at authoring (B13 reachability: the one uncapped writer surface)', () => {
  test('a post over the text limit refuses with words', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    expect(() =>
      upsertCampPost(a, { type: 'offer', text: 'x'.repeat(POST_TEXT_MAX + 1) }),
    ).toThrow(/board limit/);
  });

  test('post N+1 refuses; an EDIT of an existing post still saves', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    let firstId = '';
    for (let i = 0; i < MAX_POSTS_PER_WRITER; i++) {
      const p = upsertCampPost(a, { type: 'offer', text: `post ${i}` });
      if (i === 0) {
        firstId = p.id;
      }
    }
    expect(() => upsertCampPost(a, { type: 'offer', text: 'one too many' })).toThrow(
      /board posts/,
    );
    // THE BYPASS ARM, closed harder than first filed: a supplied id whose
    // row does not exist is refused OUTRIGHT now (Angel batch) — supplied
    // ids mean EDIT, and no legitimate caller creates through upsert with
    // one. The novel-id-at-cap bypass is subsumed: it cannot reach the
    // INSERT at any cap level.
    expect(() =>
      upsertCampPost(a, { id: 'p-novel-bypass', type: 'offer', text: 'sneaky' }),
    ).toThrow(/no longer on this board/);
    expect(() =>
      upsertCampPost(a, { id: firstId, type: 'offer', text: 'edited fine' }),
    ).not.toThrow();
  });
});

describe('bytes, not UTF-16 units (codex B16/B19 — the discrimination is the refusal)', () => {
  test('an own board whose UTF-16 units fit the ceiling but whose UTF-8 bytes do not is REFUSED at export; a .length revert would export it', () => {
    // '中' is 1 UTF-16 unit, 3 UTF-8 bytes. Photos (ASCII) saturate the
    // budget; every note's text is wide. The bundle measures under the
    // ceiling in UNITS and over it in BYTES — so with the correct byte
    // measure export refuses with the own-board words, and with a .length
    // revert it would "succeed" and hand every receiver a beam their
    // native byte cap refuses. This expect(throw) is what goes red then.
    const a = makePhone('writeraaaa');
    join(a, 'Wide');
    const per = NOTE_PHOTO_MAX_B64;
    const photoNotes = Math.floor(NOTE_PHOTO_BUDGET_B64 / per);
    const wideText = '中'.repeat(2000);
    for (let i = 0; i < photoNotes; i++) {
      upsertCampNote(a, { kind: 'art', text: `${i} ${wideText}`, photo: b64(per) });
    }
    for (let i = photoNotes; i < 500; i++) {
      upsertCampNote(a, { kind: 'memory', text: `${i} ${wideText}` });
    }
    expect(() => exportCampBundle(a)).toThrow(/own board has grown/);
    // the fixture genuinely discriminates: wide text is 1 unit but 3 bytes
    // per char, so a .length measure reads this same board as ~2.4M under
    // the ceiling and exports it — turning the expect(throw) above red.
    expect(utf8Bytes(wideText).length).toBe(wideText.length * 3);
  });
});

describe('the foreign byte gate discriminates too (codex P2.7 — mutation-pin)', () => {
  test('two wide-text foreign boards: units fit together, bytes do not — one is shed and the beam imports', () => {
    const hub = makePhone('writerhub0');
    join(hub, 'Hub');
    const wideText = '中'.repeat(2000); // 2000 units, 6000 bytes per note
    for (const w of ['writerwide1', 'writerwide2']) {
      const c = makePhone(w);
      join(c, `Wide-${w.slice(-1)}`);
      for (let i = 0; i < 250; i++) {
        upsertCampNote(c, { kind: 'memory', text: `${i} ${wideText}` });
      }
      for (let i = 0; i < 100; i++) {
        upsertCampPost(c, { type: 'offer', text: wideText.slice(0, 1900) });
      }
      installCampBundle(hub, exportCampBundle(c)); // each alone exports+imports fine
    }
    const out = exportCampBeam(hub);
    // ~2.1 MB bytes per wide envelope: both together exceed the ceiling in
    // BYTES while fitting comfortably in UNITS — a .length revert on the
    // foreign candidate gate keeps both, and the byte assertion goes red.
    expect(out.shedAuthors.length).toBe(1);
    expect(utf8Bytes(out.bundle).length).toBeLessThanOrEqual(EXPORT_CEILING_BYTES);
    expect(out.bundle.length).toBeLessThan(utf8Bytes(out.bundle).length); // discriminating fixture
    const fresh = makePhone('writerrecv2');
    join(fresh, 'Recv');
    expect(() => installCampBundle(fresh, out.bundle)).not.toThrow();
  });
});

describe('the writer-count closure (codex B15, retracted on the import predicate)', () => {
  test('durable state stops at the camp ceiling with honest words, and the export always fits it', () => {
    const hub = makePhone('writerhub0');
    join(hub, 'Hub');
    let refusals = 0;
    for (let i = 0; i < MAX_BEAM_ENVELOPES + 3; i++) {
      const w = makePhone(`writer${String(i).padStart(4, '0')}`);
      join(w, `W${i}`);
      upsertCampPost(w, { type: 'offer', text: `tiny ${i}` });
      try {
        installCampBundle(hub, exportCampBundle(w));
      } catch (e: any) {
        refusals++;
        expect(String(e?.message)).toMatch(/more campmate|can hold/i);
      }
    }
    // import bounds durable state at own+63; export must go one further —
    // a FRESH receiver sees every envelope as foreign, so an importable
    // bundle carries at most MAX_BEAM_ENVELOPES - 1 (the definitive batch
    // proved a 64-bundle is refused by exactly the fresh phone below)
    expect(refusals).toBeGreaterThanOrEqual(3);
    const out = exportCampBeam(hub);
    expect(JSON.parse(out.bundle).envelopes.length).toBeLessThanOrEqual(MAX_BEAM_ENVELOPES - 1);
    expect(out.shedAuthors.length).toBeGreaterThanOrEqual(1);
    const fresh = makePhone('writerrecv');
    join(fresh, 'Recv');
    expect(() => installCampBundle(fresh, out.bundle)).not.toThrow();
  });
});

describe('art→non-art edit drops the photo at the owner layer (codex P1.4)', () => {
  test('re-kinding an art note to memory zeroes the photo it carried', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const note = upsertCampNote(a, { kind: 'art', text: 'was art', photo: b64(256) });
    expect(note.photo).not.toBe('');
    const edited = upsertCampNote(a, { id: note.id, kind: 'memory', text: 'now a memory' });
    expect(edited.photo).toBe('');
    const rows = listCampNotes(a, getRowCampId(a));
    expect(rows[0].photo).toBe('');
  });
});

// campId helper for the transition test (identity read, no export needed)
function getRowCampId(conn: any): string {
  return conn
    .execute('SELECT camp_id FROM camp_notes LIMIT 1')
    .rows!.item(0).camp_id as string;
}

describe('receiver byte gates (codex P1.3 — units floor, bytes contract)', () => {
  test('a bundle under the ceiling in units but over it in bytes is refused before parse', () => {
    const wide = '中'.repeat(2 * 1024 * 1024); // 2M units, 6MB bytes
    const fake = `{"kind":"playapal-camp-board","pad":"${wide}"}`;
    expect(fake.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    const b = makePhone('writerbbbb');
    join(b, 'Marisol');
    const counts = () =>
      (['camp_posts', 'camp_notes', 'camp_writers'] as const).map(
        t => b.execute(`SELECT COUNT(*) AS n FROM ${t}`).rows!.item(0).n as number,
      );
    const before = counts();
    expect(() => installCampBundle(b, fake)).toThrow(/far larger/);
    expect(counts()).toEqual(before); // refusal means untouched, not half-written
  });
});

describe('the caps are a CONTRACT, pinned literally (codex reverify 4)', () => {
  // Fixtures elsewhere derive from the exported constants, so an
  // accidental constant change would move implementation and oracle
  // together. This block is the anchor: literal numbers, no imports on the
  // right-hand side. Changing a cap is a WIRE-CONTRACT decision — update
  // ruling H and this block in the same commit, deliberately.
  test('note photo caps', () => {
    expect(NOTE_PHOTO_MAX_B64).toBe(40 * 1024);
    expect(NOTE_PHOTO_WIRE_MAX_B64).toBe(64 * 1024);
    expect(NOTE_PHOTO_BUDGET_B64).toBe(2_500_000);
  });
  test('board post caps', () => {
    expect(POST_TEXT_MAX).toBe(2000);
    expect(MAX_POSTS_PER_WRITER).toBe(500);
  });
  test('beam admission caps', () => {
    expect(MAX_BEAM_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_BEAM_ENVELOPES).toBe(64);
    expect(EXPORT_CEILING_BYTES).toBe(4 * 1024 * 1024 - 256 * 1024);
  });
});
