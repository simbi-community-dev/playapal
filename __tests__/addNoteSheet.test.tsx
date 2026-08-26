/**
 * AddNoteSheet — the "Add to camp knowledge" composer against the REAL
 * model layer (node:sqlite, same rig as campNotes.test.ts). The sheet is
 * presentation over upsertCampNote, so the acceptance set is end-to-end
 * through the rendered inputs:
 *   memory kind saves and the canonical camp_notes row (+ chunk
 *   projection) lands;
 *   event kind with an impossible date renders the model's validation
 *   message inline and saves NOTHING;
 *   fix kind opened with a typed prefill (ruling C) stores
 *   subject_type/subject_key and shows the non-editable "Fixing:" line;
 *   authoring before a camp passphrase surfaces that CampNoteError inline;
 * plus direct unit coverage of buildNoteInput, the pure per-kind mapping
 * Save hands to the model.
 */
import React from 'react';
import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import {
  CAMP_WRITER_ID_KEY,
  getCampIdentity,
  saveCampProfile,
} from '../src/camp/campBoard';
import { listCampNotes } from '../src/camp/campNotes';
import {
  AddNoteSheet,
  buildNoteInput,
  type NoteFields,
} from '../src/screens/AddNoteSheet';

// The component reaches the db only through getDb(); point it at the
// node:sqlite phone. FTS rebuild is a no-op here (no fts5 contract in the
// unit rig — campRetrieval.test.ts owns that surface).
let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  rebuildFtsIndexes: jest.fn(),
}));
// The picker is native; the mock is SELF-CONTAINED (babel-plugin-jest-hoist
// forbids a factory capturing outer consts — codex P0.1) and it PINS the two
// native contracts codex measured: assetRepresentationMode 'compatible'
// must be requested (B3: iOS HEIC default) and the returned type is
// 'image/jpg' — iOS image-picker's own MIME word for JPEG (B4). A build
// that drops either gets no photo here and the wiring tests go red.
jest.mock('react-native-image-picker', () => {
  const NodeBuffer = require('buffer').Buffer;
  const buf = NodeBuffer.alloc(48, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff; // '/9j/' decodes FF D8 FF — FF D8 alone encodes '/9hB…'
  buf[46] = 0xff;
  buf[47] = 0xd9;
  const FAKE = buf.toString('base64');
  const pick = async (opts: any) =>
    opts?.assetRepresentationMode === 'compatible'
      ? { assets: [{ base64: FAKE, type: 'image/jpg' }] }
      : { errorCode: 'no-compatible-representation-requested' };
  return {
    __FAKE_JPEG_B64: FAKE,
    launchCamera: jest.fn(pick),
    launchImageLibrary: jest.fn(pick),
  };
});
const FAKE_JPEG_B64: string = (require('react-native-image-picker') as any)
  .__FAKE_JPEG_B64;

const { DatabaseSync } = require('node:sqlite');
const TestRenderer = require('react-test-renderer');
const RN = require('react-native');

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

const myNotes = () =>
  listCampNotes(mockConn, getCampIdentity(mockConn).campId);

// ---------------------------------------------------------------------------
// Render plumbing (the rightNowEmptyState pattern, plus input driving)
// ---------------------------------------------------------------------------

function render(props: {
  onClose?: () => void;
  onSaved?: (label: string) => void;
  prefill?: any;
} = {}) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(
      <AddNoteSheet
        visible
        onClose={props.onClose ?? (() => {})}
        onSaved={props.onSaved ?? (() => {})}
        prefill={props.prefill}
      />,
    );
  });
  return root;
}

const flat = (c: any): string =>
  Array.isArray(c) ? c.map(flat).join('') : String(c ?? '');

function textOf(root: any): string {
  return root.root
    .findAllByType(RN.Text)
    .map((t: any) => flat(t.props.children))
    .join('\n');
}

function typeInto(root: any, placeholderStart: string, value: string) {
  const input = root.root
    .findAllByType(RN.TextInput)
    .find((i: any) =>
      String(i.props.placeholder ?? '').startsWith(placeholderStart),
    );
  expect(input).toBeTruthy();
  TestRenderer.act(() => input.props.onChangeText(value));
}

/** Press the nearest onPress ancestor of the Text with exactly `label`. */
function press(root: any, label: string) {
  const t = root.root
    .findAllByType(RN.Text)
    .find((n: any) => n.props.children === label);
  expect(t).toBeTruthy();
  let node: any = t;
  while (node && typeof node.props?.onPress !== 'function') {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  TestRenderer.act(() => node.props.onPress());
}

beforeEach(() => {
  mockConn = makePhone('writeraaaa');
  join(mockConn, 'Pug');
});

// ---------------------------------------------------------------------------
// End-to-end through the rendered sheet
// ---------------------------------------------------------------------------

describe('AddNoteSheet: saving through the real model layer', () => {
  test('memory kind saves — canonical row + chunk projection land, onSaved/onClose fire, fields reset', () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const root = render({ onSaved, onClose });

    typeInto(root, 'Year', '2019');
    typeInto(root, 'The memory', 'The year the shade structure ate a rebar mallet.');
    press(root, 'Save note');

    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'memory',
      year: '2019',
      text: 'The year the shade structure ate a rebar mallet.',
      writer_id: 'writeraaaa',
      subject_type: '',
      subject_key: '',
    });
    // The projection materialized through the same Save (ruling B).
    const chunks = mockConn.execute(
      "SELECT content FROM doc_chunks WHERE source_file = 'camp-notes'",
    ).rows!._array;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('rebar mallet');

    expect(onSaved).toHaveBeenCalledWith('Memory', false);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Fields reset for the next note.
    const values = root.root
      .findAllByType(RN.TextInput)
      .map((i: any) => i.props.value);
    // POSITIVE CONTROL: an empty field list passes 'every field was cleared' without any field existing to clear.
    // `[].every(...)` is `true`, so the assertion below cannot fail on an
    // empty collection — pin the length first or it proves nothing.
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v: string) => v === '')).toBe(true);
  });

  test('event kind with an impossible date renders the validation message and saves NOTHING', () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const root = render({ onSaved, onClose });

    press(root, 'Event');
    typeInto(root, 'Date*', '2026-13-45');
    typeInto(root, 'Start*', '19:30');
    typeInto(root, "What's happening", 'Sunset tea ceremony at the dome');
    press(root, 'Save note');

    expect(textOf(root)).toContain('That date does not exist on the calendar.');
    expect(myNotes()).toHaveLength(0);
    expect(
      mockConn.execute("SELECT * FROM events WHERE source_kind = 'camp_note'")
        .rows!._array,
    ).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The message is the model's own: fixing the date clears it and saves.
    typeInto(root, 'Date*', '2026-09-02');
    press(root, 'Save note');
    expect(textOf(root)).not.toContain('does not exist on the calendar');
    expect(myNotes()).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith('Event', false);
  });

  test('fix kind with a typed prefill stores subject_type/subject_key and shows the Fixing line', () => {
    const onSaved = jest.fn();
    const root = render({
      onSaved,
      prefill: {
        kind: 'fix',
        subject_type: 'person',
        subject_key: 'hippo-graph|dusty',
        subjectLabel: 'Dusty',
      },
    });

    expect(textOf(root)).toContain('Fixing: ');
    expect(textOf(root)).toContain('Dusty');
    // No free-text subject input when the subject arrived typed.
    const subjectInput = root.root
      .findAllByType(RN.TextInput)
      .find((i: any) =>
        String(i.props.placeholder ?? '').startsWith('What needs fixing'),
      );
    expect(subjectInput).toBeUndefined();

    typeInto(root, 'The correction', 'Dusty was sponsored by Marrow, not Ember.');
    press(root, 'Save note');

    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'fix',
      subject_type: 'person',
      subject_key: 'hippo-graph|dusty',
      title: 'Dusty',
      text: 'Dusty was sponsored by Marrow, not Ember.',
    });
    expect(onSaved).toHaveBeenCalledWith('Fix a fact', false);
  });

  test('art kind opened with a where prefill: the address is SEEDED, editable, and saved', () => {
    const onSaved = jest.fn();
    const root = render({ onSaved, prefill: { kind: 'art', where: '4:36 & G' } });

    // Seeded, not locked: the camper standing at the piece can sharpen an
    // address the map could only estimate.
    const whereInput = root.root
      .findAllByType(RN.TextInput)
      .find((i: any) => String(i.props.placeholder ?? '').startsWith('Where'));
    expect(whereInput).toBeTruthy();
    expect(whereInput.props.value).toBe('4:36 & G');

    typeInto(root, 'Name of the piece', 'Bloom');
    typeInto(root, 'Artist', 'Ada Weatherwax');
    typeInto(root, 'Where', '4:36 & G, 200ft out');
    typeInto(root, 'What it looks like', 'A steel hippo that breathes fire at dusk.');
    press(root, 'Save note');

    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G, 200ft out',
      text: 'A steel hippo that breathes fire at dusk.',
    });
    expect(onSaved).toHaveBeenCalledWith('Art', false);

    // The projection went with it: the address is in the retrievable text.
    const chunks = mockConn.execute(
      "SELECT heading, content FROM doc_chunks WHERE source_file = 'camp-notes'",
    ).rows!._array;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Bloom — by Ada Weatherwax');
    expect(chunks[0].content).toContain('4:36 & G, 200ft out');
  });

  test('no camp passphrase yet: the CampNoteError shows inline, nothing saves', () => {
    mockConn = makePhone('writerbbbb'); // never joined a camp
    const onSaved = jest.fn();
    const root = render({ onSaved });

    typeInto(root, 'The memory', 'A note from before the camp existed.');
    press(root, 'Save note');

    expect(textOf(root)).toContain('Set your camp passphrase first');
    expect(
      mockConn.execute('SELECT * FROM camp_notes').rows!._array,
    ).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildNoteInput — the pure per-kind mapping Save hands to the model
// ---------------------------------------------------------------------------

const fields = (over: Partial<NoteFields> = {}): NoteFields => ({
  year: '',
  title: '',
  artist: '',
  date: '',
  start: '',
  end: '',
  where: '',
  subject: '',
  text: '',
  ...over,
});

describe('buildNoteInput: per-kind field mapping', () => {
  test('memory carries text + year only', () => {
    expect(
      buildNoteInput('memory', fields({ year: '2019', text: 'the mallet', title: 'ignored' })),
    ).toEqual({ kind: 'memory', text: 'the mallet', year: '2019' });
  });

  test('event maps every field to the model names', () => {
    expect(
      buildNoteInput(
        'event',
        fields({
          title: 'Tea',
          date: '2026-09-02',
          start: '19:30',
          end: '21:00',
          where: '7:32 & C',
          text: 'sunset tea',
        }),
      ),
    ).toEqual({
      kind: 'event',
      title: 'Tea',
      when_date: '2026-09-02',
      time_start: '19:30',
      time_end: '21:00',
      where_addr: '7:32 & C',
      text: 'sunset tea',
    });
  });

  test('fix free-text subject maps into title, subject stays untyped', () => {
    expect(
      buildNoteInput('fix', fields({ subject: 'the WWWW start time', text: 'it is 8pm' })),
    ).toEqual({
      kind: 'fix',
      title: 'the WWWW start time',
      subject_type: '',
      subject_key: '',
      text: 'it is 8pm',
    });
  });

  test('fix with a typed prefill: prefill subject wins over free text', () => {
    expect(
      buildNoteInput(
        'fix',
        fields({ subject: 'typed anyway', text: 'wrong sponsor' }),
        {
          kind: 'fix',
          subject_type: 'person',
          subject_key: 'hippo-graph|dusty',
          subjectLabel: 'Dusty',
        },
      ),
    ).toEqual({
      kind: 'fix',
      title: 'Dusty',
      subject_type: 'person',
      subject_key: 'hippo-graph|dusty',
      text: 'wrong sponsor',
    });
  });

  test('resource carries title + text only', () => {
    expect(
      buildNoteInput('resource', fields({ title: 'Water', text: 'behind the dome', year: '9999' })),
    ).toEqual({ kind: 'resource', title: 'Water', text: 'behind the dome' });
  });

  test('art folds the artist into the title, because the title IS the chunk heading', () => {
    expect(
      buildNoteInput(
        'art',
        fields({
          title: 'Bloom',
          artist: 'Ada Weatherwax',
          where: '4:36 & G',
          text: 'A steel hippo that breathes fire at dusk.',
        }),
      ),
    ).toEqual({
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G',
      text: 'A steel hippo that breathes fire at dusk.',
    });
  });

  test('art with no artist keeps the bare name — so re-saving an edit is idempotent', () => {
    expect(
      buildNoteInput(
        'art',
        fields({ title: 'Bloom — by Ada Weatherwax', where: '4:36 & G', text: 'still there' }),
      ),
    ).toEqual({
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: '4:36 & G',
      text: 'still there',
    });
  });
});

// ---------------------------------------------------------------------------
// Art photo: the save wiring (the stale-closure class, pinned)
// ---------------------------------------------------------------------------

describe('art photo save wiring', () => {
  test('a chosen photo reaches upsertCampNote — killed if save() drops or forgets photo', async () => {
    mockConn = makePhone('writerphoto');
    join(mockConn, 'Dusty');
    const root = render({ prefill: { kind: 'art', where: '3:00 & 2000ft' } });
    typeInto(root, 'What it looks like', 'A steel flower that opens at dusk.');
    press(root, 'Choose photo');
    // the picker resolves async; let the state land before saving
    await TestRenderer.act(async () => {});
    press(root, 'Save note');
    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].photo).toBe(FAKE_JPEG_B64);
  });

  test('remove-photo before save means no photo saved', async () => {
    mockConn = makePhone('writerphoto2');
    join(mockConn, 'Dusty');
    const root = render({ prefill: { kind: 'art', where: '3:00 & 2000ft' } });
    typeInto(root, 'What it looks like', 'A quiet piece.');
    press(root, 'Choose photo');
    await TestRenderer.act(async () => {});
    press(root, 'Remove photo');
    press(root, 'Save note');
    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].photo).toBe('');
  });
});
