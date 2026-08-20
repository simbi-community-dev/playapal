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
});
