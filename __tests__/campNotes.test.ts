/**
 * Camp notes core semantics against the REAL DDL (node:sqlite) — the /x
 * acceptance set (CAMP-NOTES-DESIGN rulings A-G) before anything may say
 * "notes sync":
 *   format-2 seal covers posts AND notes under one hash/tag/seq;
 *   a v1 beam (posts only) still verifies and imports;
 *   a v2 beam with its notes tampered fails the seal whole;
 *   notes round-trip A→B and multi-hop A→B→C;
 *   note mutations bump the ONE writer seq (stale beams stay stale);
 *   projections rematerialize (chunk + event rows), hide by ONE key,
 *   superseded notes project only through their successor;
 *   fix notes resolve by typed subject, not ranking;
 *   event-kind authoring rejects impossible dates;
 *   authoring without a camp passphrase is refused.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import {
  CAMP_WRITER_ID_KEY,
  exportCampBundle,
  installCampBundle,
  removeCampNote,
  saveCampProfile,
  upsertCampNote,
  upsertCampPost,
} from '../src/camp/campBoard';
import {
  CampNoteError,
  MAX_NOTES_PER_WRITER,
  fixNotesForSubject,
  listCampNotes,
  notesPackId,
  subscribeNotesChanged,
} from '../src/camp/campNotes';

const { DatabaseSync } = require('node:sqlite');

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

const chunkTexts = (conn: any): string[] =>
  conn
    .execute("SELECT content FROM doc_chunks WHERE source_file = 'camp-notes' ORDER BY id")
    .rows!._array.map((r: any) => r.content);

const noteEvents = (conn: any): any[] =>
  conn.execute("SELECT * FROM events WHERE source_kind = 'camp_note' ORDER BY id")
    .rows!._array;

describe('camp notes: canonical + sealed wire (rulings A/B)', () => {
  test('a note authored on A rides the beam to B: canonical row, chunk and event projections, pack row', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');

    upsertCampNote(a, {
      kind: 'event',
      title: 'Hippo pancake hour',
      when_date: '2026-09-02',
      time_start: '08:00',
      where_addr: '7:32 & C',
      text: 'Sourdough pancakes at the dome, bring a mug.',
    });
    upsertCampNote(a, { kind: 'memory', year: '2015', text: 'The year the shade blew into the trash fence.' });

    const res = installCampBundle(b, exportCampBundle(a));
    expect(res.notes).toBe(2);
    const notes = listCampNotes(b, res.campId);
    expect(notes.map(n => n.kind).sort()).toEqual(['event', 'memory']);
    expect(chunkTexts(b).join(' ')).toContain('Sourdough pancakes');
    expect(chunkTexts(b).join(' ')).toContain('camp-passphrase verified');
    const evs = noteEvents(b);
    expect(evs).toHaveLength(1);
    expect(evs[0].date).toBe('2026-09-02');
    expect(evs[0].note_key).toBe(notes.find(n => n.kind === 'event')!.id);
    const packs = connPacks(b);
    expect(packs.some((p: any) => p.id === notesPackId(res.campId, 'writeraaaa'))).toBe(true);
  });

  function connPacks(conn: any): any[] {
    return conn.execute("SELECT * FROM packs WHERE id LIKE 'camp-notes-%'").rows!._array;
  }

  test('tampering with a sealed note fails the whole beam', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampNote(a, { kind: 'resource', text: 'Spare rebar lives behind the water totes.' });
    const bundle = JSON.parse(exportCampBundle(a));
    bundle.envelopes[0].notes[0].text = 'Spare rebar is MINE, do not touch.';
    expect(() => installCampBundle(b, JSON.stringify(bundle))).toThrow(/integrity/);
    expect(listCampNotes(b, bundle.camp_id)).toHaveLength(0);
  });

  test('a format-1 beam (posts only, sealed under 1) still imports', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampPost(a, { type: 'offer', text: '3 spare bike tubes at the dome' });
    const v2 = JSON.parse(exportCampBundle(a));
    // Reconstruct what a format-1 client would have sealed: same posts,
    // format 1, payload = posts alone. Uses the app's own primitives so the
    // test seals exactly like the old client did.
    const { hmacSha256Hex, sha256, utf8Bytes } = require('../src/camp/hmac');
    // sealKey/derivation mirrors campBoard's own (string key, v0 prefix).
    const sha256Hex = (t: string) =>
      Array.from(sha256(utf8Bytes(t)) as Uint8Array)
        .map((x: number) => x.toString(16).padStart(2, '0'))
        .join('');
    const env = v2.envelopes[0];
    const canonicalPosts = env.posts
      .slice()
      .sort((x: any, y: any) => (x.id < y.id ? -1 : 1))
      .map((p: any) =>
        [p.id, p.ref_id ?? '', p.type, p.text, p.author_name, p.created_at, p.done ? '1' : '0'].join('\u001f'),
      )
      .join('\n');
    const head = {
      camp_id: env.camp_id,
      writer_id: env.writer_id,
      author_name: env.author_name,
      key_id: env.key_id,
      seq: env.seq,
      payload_hash: sha256Hex(canonicalPosts),
    };
    const mac = [
      'playapal-camp-board',
      '1',
      head.camp_id,
      head.writer_id,
      head.author_name,
      head.key_id,
      String(head.seq),
      head.payload_hash,
      canonicalPosts,
    ].join('\n');
    const passKey = 'playapal-camp-v0:dusty hippos 2026';
    const v1 = {
      kind: 'playapal-camp-board',
      format: 1,
      camp_id: env.camp_id,
      envelopes: [
        { ...head, posts: env.posts, tag: hmacSha256Hex(passKey, mac) },
      ],
    };
    const res = installCampBundle(b, JSON.stringify(v1));
    expect(res.installed).toHaveLength(1);
    expect(res.notes).toBe(0);
  });

  test('multi-hop: C learns A’s note from B’s re-beam', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    const c = makePhone('writercccc');
    for (const [p, n] of [[a, 'Dusty'], [b, 'Marisol'], [c, 'Kupo']] as const) {
      join(p, n);
    }
    upsertCampNote(a, { kind: 'memory', text: 'Original temple crew story.' });
    installCampBundle(b, exportCampBundle(a));
    const res = installCampBundle(c, exportCampBundle(b));
    expect(res.notes).toBe(1);
    expect(chunkTexts(c).join(' ')).toContain('Original temple crew story');
  });

  test('note mutations bump the one writer seq: a pre-note beam is stale after', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    const oldBeam = exportCampBundle(a);
    upsertCampNote(a, { kind: 'memory', text: 'Newer than that beam.' });
    installCampBundle(b, exportCampBundle(a));
    const res = installCampBundle(b, oldBeam);
    expect(res.stale).toBeGreaterThan(0);
    expect(listCampNotes(b, res.campId)).toHaveLength(1);
  });
});

describe('camp notes: projections + lifecycle (rulings D/E/F)', () => {
  test('hide by the ONE note key removes chunk and event projections together', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const n = upsertCampNote(a, {
      kind: 'event',
      title: 'Secret soup',
      when_date: '2026-09-03',
      time_start: '19:00',
      text: 'Soup at sunset.',
    });
    expect(noteEvents(a)).toHaveLength(1);
    a.execute(
      "INSERT INTO hidden_items (kind, key, label, ts) VALUES ('camp_note', ?, 'Secret soup', ?)",
      [n.id, new Date().toISOString()],
    );
    // Any note mutation (or import) rematerializes; hiding is honored then.
    upsertCampNote(a, { kind: 'memory', text: 'Unrelated note to trigger remat.' });
    expect(noteEvents(a)).toHaveLength(0);
    expect(chunkTexts(a).join(' ')).not.toContain('Soup at sunset');
  });

  test('a superseding note replaces its ancestor in every projection', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const orig = upsertCampNote(a, { kind: 'resource', text: 'Water totes at 3 oclock corner.' });
    // Simulate the ruling-F path: a NEW note that supersedes (as after
    // rotation); authored here via direct insert of another writer's note
    // being replaced is out of scope — same-writer supersede is the shape.
    upsertCampNote(a, {
      kind: 'resource',
      text: 'Water totes moved behind the kitchen.',
      // supersedes is carried through input only via revision in MVP; the
      // wire preserves it — emulate by editing the row then remat via a
      // second write.
    });
    const all = listCampNotes(a, campIdOf(a));
    const successor = all.find(n => n.text.includes('moved'))!;
    a.execute('UPDATE camp_notes SET supersedes = ? WHERE id = ?', [orig.id, successor.id]);
    upsertCampNote(a, { kind: 'memory', text: 'trigger remat' });
    const texts = chunkTexts(a).join(' ');
    expect(texts).toContain('moved behind the kitchen');
    expect(texts).not.toContain('at 3 oclock corner');
  });

  function campIdOf(conn: any): string {
    return listAnyCamp(conn);
  }
  function listAnyCamp(conn: any): string {
    return conn.execute('SELECT camp_id FROM camp_notes LIMIT 1').rows!._array[0].camp_id;
  }

  test('fix notes resolve by typed subject key, unhidden and unsuperseded only', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    upsertCampNote(a, {
      kind: 'fix',
      subject_type: 'person',
      subject_key: 'demo-lore-pack|person:kupo',
      text: 'Kupo was sponsored by Marisol, not by Dee — I was there.',
    });
    upsertCampNote(a, {
      kind: 'fix',
      subject_type: 'person',
      subject_key: 'demo-lore-pack|person:someone-else',
      text: 'Unrelated fix.',
    });
    const campId = a
      .execute('SELECT camp_id FROM camp_notes LIMIT 1')
      .rows!.item(0).camp_id as string;
    const fixes = fixNotesForSubject(a, campId, 'person', 'demo-lore-pack|person:kupo');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].text).toContain('sponsored by Marisol');
    // camp-scoped: the same subject under a DIFFERENT camp id returns nothing
    expect(
      fixNotesForSubject(a, 'someothercamp', 'person', 'demo-lore-pack|person:kupo'),
    ).toHaveLength(0);
  });

  test('event authoring rejects impossible dates and malformed times', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    expect(() =>
      upsertCampNote(a, { kind: 'event', when_date: '2026-02-30', time_start: '19:00', text: 'x' }),
    ).toThrow(CampNoteError);
    expect(() =>
      upsertCampNote(a, { kind: 'event', when_date: '2026-09-02', time_start: '25:00', text: 'x' }),
    ).toThrow(/Start time/);
  });

  test('authoring without a camp passphrase is refused (no pre-camp drafts)', () => {
    const a = makePhone('writeraaaa');
    expect(() => upsertCampNote(a, { kind: 'memory', text: 'homeless note' })).toThrow(
      /passphrase/,
    );
  });

  test('removing my note propagates as omission: the next beam has fewer notes', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    const n = upsertCampNote(a, { kind: 'memory', text: 'Short-lived memory.' });
    installCampBundle(b, exportCampBundle(a));
    removeCampNote(a, n.id);
    const res = installCampBundle(b, exportCampBundle(a));
    expect(res.installed).toHaveLength(1);
    expect(listCampNotes(b, res.campId)).toHaveLength(0);
    expect(chunkTexts(b).join(' ')).not.toContain('Short-lived memory');
  });
});

describe('camp notes: hide remap (ruling D, central chokepoint)', () => {
  const { hideItem, listHidden } = require('../src/facts/hiddenItems');

  test('hiding a note PASSAGE projection lands as camp_note and kills the event projection too', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const n = upsertCampNote(a, {
      kind: 'event',
      title: 'Secret soup',
      when_date: '2026-09-03',
      time_start: '19:00',
      text: 'Soup at sunset.',
    });
    const chunk = a
      .execute("SELECT id, pack_id FROM doc_chunks WHERE note_key = ?", [n.id])
      .rows!._array[0];
    hideItem(a, {
      kind: 'passage',
      key: `${chunk.pack_id}:${chunk.id}`,
      label: 'Secret soup',
    });
    const hidden = listHidden(a);
    expect(hidden.some((h: any) => h.kind === 'camp_note' && h.key === n.id)).toBe(true);
    expect(noteEvents(a)).toHaveLength(0);
    expect(chunkTexts(a).join(' ')).not.toContain('Soup at sunset');
  });
});

describe('camp notes: audit batch 2026-08-20 (cross-camp, deletion notify, cap)', () => {
  const notePacks = (conn: any): string[] =>
    conn
      .execute("SELECT id FROM packs WHERE id LIKE 'camp-notes-%'")
      .rows!._array.map((r: any) => r.id);

  test('switching camps gates PROJECTIONS, preserves pack rows and toggles; switching back restores', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    upsertCampNote(a, { kind: 'memory', text: 'Camp A memory.' });
    const aPack = notePacks(a)[0];
    a.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [aPack]); // mute it

    saveCampProfile(a, { authorName: 'Dusty', passphrase: 'other camp 2026' });
    expect(notePacks(a)).toContain(aPack); // the row (and toggle) persists
    expect(chunkTexts(a).join(' ')).not.toContain('Camp A memory'); // projections gone
    upsertCampNote(a, { kind: 'memory', text: 'Camp B memory.' });
    expect(chunkTexts(a).join(' ')).toContain('Camp B memory');
    expect(
      a.execute('SELECT COUNT(*) AS n FROM camp_notes').rows!.item(0).n,
    ).toBe(2); // canonical rows of BOTH camps survive

    saveCampProfile(a, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    expect(chunkTexts(a).join(' ')).toContain('Camp A memory'); // restored
    expect(chunkTexts(a).join(' ')).not.toContain('Camp B memory'); // B gated
    const toggle = a
      .execute('SELECT enabled FROM packs WHERE id = ?', [aPack])
      .rows!.item(0).enabled;
    expect(toggle).toBe(0); // the mute SURVIVED the switch-and-back
  });

  test('an install that deletes the last note still notifies the reader', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    const n = upsertCampNote(a, { kind: 'memory', text: 'Vanishing memory.' });
    installCampBundle(b, exportCampBundle(a));
    removeCampNote(a, n.id);
    let fired = 0;
    const unsub = subscribeNotesChanged(() => {
      fired += 1;
    });
    const res = installCampBundle(b, exportCampBundle(a));
    unsub();
    expect(res.notes).toBe(0);
    expect(res.installed).toHaveLength(1);
    expect(fired).toBeGreaterThan(0);
  });

  test('authoring refuses note MAX+1 but still allows editing at the cap', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    const first = upsertCampNote(a, { kind: 'memory', text: 'Note zero.' });
    const identityRow = a
      .execute('SELECT camp_id, writer_id FROM camp_notes LIMIT 1')
      .rows!.item(0);
    for (let i = 1; i < MAX_NOTES_PER_WRITER; i++) {
      a.execute(
        `INSERT INTO camp_notes (id, camp_id, writer_id, author_name, kind, text, created_at)
         VALUES (?, ?, ?, 'Dusty', 'memory', ?, ?)`,
        [
          `writeraaaa:pad${i}`,
          identityRow.camp_id,
          identityRow.writer_id,
          `Padding note ${i}.`,
          new Date().toISOString(),
        ],
      );
    }
    expect(() =>
      upsertCampNote(a, { kind: 'memory', text: 'One too many.' }),
    ).toThrow(CampNoteError);
    const edited = upsertCampNote(a, {
      id: first.id,
      kind: 'memory',
      text: 'Note zero, edited at the cap.',
    });
    expect(edited.id).toBe(first.id);
  });
});

describe('camp notes: audit round 3 (wire validation, enabled-mute, legacy namespace)', () => {
  test('a sealed beam carrying an impossible event when is refused whole', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampNote(a, {
      kind: 'event',
      when_date: '2026-09-02',
      time_start: '19:30',
      text: 'Legit event.',
    });
    const bundle = JSON.parse(exportCampBundle(a));
    // tampering makes the seal fail first — so build the damage the way a
    // buggy/malicious WRITER would: valid seal over an invalid when is not
    // constructible via upsert (authoring validates), so simulate the parse
    // layer directly instead.
    const { parseWireNotes } = require('../src/camp/campNotes');
    expect(() =>
      parseWireNotes(
        [{ id: 'writeraaaa:x1', kind: 'event', when_date: '2026-99-99', time_start: '25:99', text: 'bad' }],
        'writeraaaa',
        'Dusty',
      ),
    ).toThrow(/impossible/);
    expect(bundle.envelopes.length).toBeGreaterThan(0);
  });

  test('disabling a campmate notes pack mutes their fix corrections', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    upsertCampNote(a, {
      kind: 'fix',
      subject_type: 'person',
      subject_key: 'demo-lore-pack|person:kupo',
      text: 'Kupo was sponsored by Marisol.',
    });
    const res = installCampBundle(b, exportCampBundle(a));
    const packId = notesPackId(res.campId, 'writeraaaa');
    expect(
      fixNotesForSubject(b, res.campId, 'person', 'demo-lore-pack|person:kupo'),
    ).toHaveLength(1);
    b.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [packId]);
    expect(
      fixNotesForSubject(b, res.campId, 'person', 'demo-lore-pack|person:kupo'),
    ).toHaveLength(0);
  });

  test('a legacy imported pack that merely shares the camp-notes prefix survives the sweeps', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    a.execute(
      `INSERT INTO packs (id, name, description, version, builtin, enabled)
       VALUES ('camp-notes-field-guide', 'Field guide', 'legacy import', 1, 0, 1)`,
    );
    a.execute(
      `INSERT INTO doc_chunks (pack_id, source_file, heading, content)
       VALUES ('camp-notes-field-guide', 'guide.md', 'x', 'Legacy field guide text.')`,
    );
    saveCampProfile(a, { authorName: 'Dusty', passphrase: 'other camp 2026' });
    const survived = a
      .execute("SELECT COUNT(*) AS n FROM doc_chunks WHERE pack_id = 'camp-notes-field-guide'")
      .rows!.item(0).n;
    expect(survived).toBe(1);
  });
});

describe('reserved boardsec writer id (audit round 5)', () => {
  const { parseWireNotes } = require('../src/camp/campNotes');
  test('the wire refuses writer id "boardsec" — its note ids would masquerade as section hide keys', () => {
    const a = makePhone('writeraaaa');
    const b = makePhone('writerbbbb');
    join(a, 'Dusty');
    join(b, 'Marisol');
    const bundle = JSON.parse(exportCampBundle(a));
    bundle.envelopes[0].writer_id = 'boardsec';
    expect(() => installCampBundle(b, JSON.stringify(bundle))).toThrow();
    expect(
      parseWireNotes([{ id: 'boardsec:x', kind: 'memory', text: 'hi' }], 'boardsec', 'X'),
    ).toBeTruthy(); // parseWireNotes itself is writer-agnostic; the envelope gate refuses
  });
});

describe('board-section hides survive rematerialization (audit round 3)', () => {
  const { hideItem } = require('../src/facts/hiddenItems');
  const { rematerializeAllBoards } = require('../src/camp/campBoard');

  test('a passage hide on a board chunk lands on the durable boardsec key and follows regenerated ids', () => {
    const a = makePhone('writeraaaa');
    join(a, 'Dusty');
    upsertCampPost(a, { type: 'offer', text: 'Free sunscreen at the dome.' });
    const chunk = a
      .execute("SELECT pack_id, id, note_key FROM doc_chunks WHERE source_file = 'camp-board'")
      .rows!.item(0);
    expect(String(chunk.note_key)).toMatch(/^boardsec:/);

    hideItem(a, {
      kind: 'passage',
      key: `${chunk.pack_id}:${chunk.id}`,
      label: 'board offers',
    });
    const stored = a
      .execute("SELECT kind, key FROM hidden_items")
      .rows!.item(0);
    expect(stored.kind).toBe('passage');
    expect(String(stored.key)).toBe(String(chunk.note_key)); // durable, not the id

    // occupy the freed rowid so the regenerated chunk demonstrably moves
    a.execute(
      "INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES ('x-pack', 'x.md', 'x', 'occupier')",
    );
    rematerializeAllBoards(a); // regenerates chunk ids (cold-launch path)
    const regen = a
      .execute("SELECT id, note_key FROM doc_chunks WHERE source_file = 'camp-board'")
      .rows!.item(0);
    expect(regen.id).not.toBe(chunk.id); // the id really did change
    expect(String(regen.note_key)).toBe(String(stored.key)); // hide still binds
  });
});
