/**
 * Camp notes: the human overlay over mecha-packs.
 *
 * Design: docs/CAMP-NOTES-DESIGN.md (rulings A-G are binding). The bulk of
 * camp knowledge arrives as LLM-built structured packs; THIS layer is how a
 * camper adds to it from the app — a memory, an event the WWWW missed, a
 * fix to a wrong fact, a resource — with no file formats anywhere in the
 * human's path.
 *
 * camp_notes is the CANONICAL store. The doc_chunks rows (searchable text)
 * and events rows (event-kind notes on the Now tab) are PROJECTIONS,
 * rematerialized wholesale after every mutation exactly like board packs
 * (campBoard.rematerializeAllBoards is the prior art); their generated ids
 * are never identity, provenance, or hide keys. The one hide key across
 * every surface is the note id (hidden_items kind 'camp_note').
 *
 * Sync rides the camp beam: notes travel inside the writer's sealed
 * envelope next to board posts (CAMP_BUNDLE_FORMAT 2), under the SAME
 * writer seq — any note mutation bumps it. Notes never sync on their own.
 */
import type { DbConnection as QuickSQLiteConnection } from '../events/engine';

export type NoteKind = 'memory' | 'event' | 'fix' | 'resource';

export interface CampNote {
  /** '<origin_writer_id>:<local id>' — stable across rotation forever. */
  id: string;
  writer_id: string;
  author_name: string;
  kind: NoteKind;
  title: string;
  /** event kind only: a real calendar date, validated at authoring. */
  when_date: string;
  time_start: string;
  time_end: string;
  where_addr: string;
  text: string;
  /** fix kind: what the fix attaches to. 'person' subject_key is
   * '<pack_id>|<node_id>'; '' means free-text subject (title names it). */
  subject_type: '' | 'person';
  subject_key: string;
  /** memory kind: optional burn year the memory belongs to. */
  year: string;
  /** A replacement authored after writer rotation points at its ancestor;
   * ownership never transfers silently (ruling F). */
  supersedes: string;
  created_at: string;
  revised_at: string;
}

export interface NoteInput {
  id?: string;
  kind: NoteKind;
  title?: string;
  when_date?: string;
  time_start?: string;
  time_end?: string;
  where_addr?: string;
  text: string;
  subject_type?: '' | 'person';
  subject_key?: string;
  year?: string;
}

export class CampNoteError extends Error {}

/** Ruling A bounds: a beam stays beam-sized. */
export const MAX_NOTES_PER_WRITER = 500;
export const NOTE_TEXT_MAX = 2000;
export const NOTE_FIELD_MAX = 120;

const KINDS: NoteKind[] = ['memory', 'event', 'fix', 'resource'];

const clean = (raw: string): string =>
  raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();


export const asKind = (raw: unknown): NoteKind =>
  KINDS.includes(raw as NoteKind) ? (raw as NoteKind) : 'memory';

/** Real-calendar validation (ruling E): the projector and the Now tab must
 * never meet an impossible date, and live authoring cannot lean on the
 * offline pack doctor. */
export function validateEventWhen(dateStr: string, start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return 'Date needs to look like 2026-08-30.';
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return 'That date does not exist on the calendar.';
  }
  const timeOk = (t: string) => /^\d{2}:\d{2}$/.test(t) && Number(t.slice(0, 2)) < 24 && Number(t.slice(3)) < 60;
  if (!timeOk(start)) {
    return 'Start time needs to look like 19:30 (24-hour).';
  }
  if (end !== '' && !timeOk(end)) {
    return 'End time needs to look like 21:00 (24-hour), or be left empty.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical reads
// ---------------------------------------------------------------------------

interface NoteRow extends Omit<CampNote, 'subject_type'> {
  subject_type: string;
  camp_id: string;
}

const fromRow = (r: NoteRow): CampNote => ({
  id: r.id,
  writer_id: r.writer_id,
  author_name: r.author_name,
  kind: asKind(r.kind),
  title: r.title,
  when_date: r.when_date,
  time_start: r.time_start,
  time_end: r.time_end,
  where_addr: r.where_addr,
  text: r.text,
  subject_type: r.subject_type === 'person' ? 'person' : '',
  subject_key: r.subject_key,
  year: r.year,
  supersedes: r.supersedes,
  created_at: r.created_at,
  revised_at: r.revised_at,
});

export function listCampNotes(
  conn: QuickSQLiteConnection,
  campId: string,
): CampNote[] {
  const res = conn.execute(
    'SELECT * FROM camp_notes WHERE camp_id = ? ORDER BY created_at, id',
    [campId],
  );
  return ((res.rows?._array ?? []) as NoteRow[]).map(fromRow);
}

export function ownNoteRows(
  conn: QuickSQLiteConnection,
  campId: string,
  writerId: string,
): CampNote[] {
  const res = conn.execute(
    'SELECT * FROM camp_notes WHERE camp_id = ? AND writer_id = ? ORDER BY id',
    [campId, writerId],
  );
  return ((res.rows?._array ?? []) as NoteRow[]).map(fromRow);
}

/** Ruling C: direct adjacency. Visible fix notes for a typed subject —
 * ranking luck is not a retrieval mechanism. */
export function fixNotesForSubject(
  conn: QuickSQLiteConnection,
  campId: string,
  subjectType: 'person',
  subjectKey: string,
): CampNote[] {
  // camp-scoped: a fix recorded in camp A must never override evidence
  // while this phone operates in camp B (audit 2026-08-20).
  const res = conn.execute(
    `SELECT n.* FROM camp_notes n
     WHERE n.camp_id = ? AND n.kind = 'fix' AND n.subject_type = ? AND n.subject_key = ?
       AND EXISTS (SELECT 1 FROM packs p
                   WHERE p.id = 'camp-notes-' || n.camp_id || '-' || n.writer_id
                     AND p.enabled = 1)
       AND NOT EXISTS (SELECT 1 FROM hidden_items h
                       WHERE h.kind = 'camp_note' AND h.key = n.id)
       AND NOT EXISTS (SELECT 1 FROM camp_notes s
                       WHERE s.supersedes = n.id)
     ORDER BY n.created_at`,
    [campId, subjectType, subjectKey],
  );
  return ((res.rows?._array ?? []) as NoteRow[]).map(fromRow);
}

// ---------------------------------------------------------------------------
// Wire canonicalization (sealed inside the camp envelope, ruling A)
// ---------------------------------------------------------------------------

/** Field-ordered, id-sorted, unit-separated — the notes half of the
 * envelope's canonical payload. Same discipline as canonicalPosts. */
export const canonicalNotes = (notes: CampNote[]): string =>
  notes
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(n =>
      [
        n.id,
        n.kind,
        n.title,
        n.when_date,
        n.time_start,
        n.time_end,
        n.where_addr,
        n.text,
        n.subject_type,
        n.subject_key,
        n.year,
        n.supersedes,
        n.created_at,
        n.revised_at,
      ].join('\u001f'),
    )
    .join('\n');

/** Parse + bound one envelope's notes at import (before any write). Throws
 * CampNoteError on structural damage; the beam importer converts that into
 * its own all-or-nothing refusal. */
export function parseWireNotes(raw: unknown, writerId: string, authorName: string): CampNote[] {
  if (raw == null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_NOTES_PER_WRITER) {
    throw new CampNoteError('notes section damaged or over-size');
  }
  return raw.map((r: any): CampNote => {
    const id = String(r?.id ?? '');
    if (!id.startsWith(`${writerId}:`) || id.length > 64) {
      throw new CampNoteError('note id does not belong to its writer');
    }
    const text = clean(String(r?.text ?? '')).slice(0, NOTE_TEXT_MAX);
    if (text.length === 0) {
      throw new CampNoteError('a note without text');
    }
    if (asKind(r?.kind) === 'event') {
      // Authoring refuses impossible whens; a sealed beam carrying one is
      // manufactured or damaged — refuse it whole (audit 2026-08-20).
      const whenErr = validateEventWhen(
        clean(String(r?.when_date ?? '')).slice(0, 10),
        clean(String(r?.time_start ?? '')).slice(0, 5),
        clean(String(r?.time_end ?? '')).slice(0, 5),
      );
      if (whenErr) {
        throw new CampNoteError('an event note with an impossible date/time');
      }
    }
    return {
      id,
      writer_id: writerId,
      author_name: authorName,
      kind: asKind(r?.kind),
      title: clean(String(r?.title ?? '')).slice(0, NOTE_FIELD_MAX),
      when_date: clean(String(r?.when_date ?? '')).slice(0, 10),
      time_start: clean(String(r?.time_start ?? '')).slice(0, 5),
      time_end: clean(String(r?.time_end ?? '')).slice(0, 5),
      where_addr: clean(String(r?.where_addr ?? '')).slice(0, NOTE_FIELD_MAX),
      text,
      subject_type: r?.subject_type === 'person' ? 'person' : '',
      subject_key: clean(String(r?.subject_key ?? '')).slice(0, NOTE_FIELD_MAX),
      year: clean(String(r?.year ?? '')).slice(0, 4),
      supersedes: clean(String(r?.supersedes ?? '')).slice(0, 64),
      created_at: clean(String(r?.created_at ?? '')).slice(0, 32),
      revised_at: clean(String(r?.revised_at ?? '')).slice(0, 32),
    };
  });
}

/** Replace one writer's canonical notes (import path; runs inside the beam
 * transaction, after every envelope verified). */
export function replaceWriterNotes(
  conn: QuickSQLiteConnection,
  campId: string,
  writerId: string,
  notes: CampNote[],
): void {
  conn.execute('DELETE FROM camp_notes WHERE camp_id = ? AND writer_id = ?', [
    campId,
    writerId,
  ]);
  for (const n of notes) {
    conn.execute(
      `INSERT INTO camp_notes
         (id, camp_id, writer_id, author_name, kind, title, when_date,
          time_start, time_end, where_addr, text, subject_type, subject_key,
          year, supersedes, created_at, revised_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        n.id, campId, n.writer_id, n.author_name, n.kind, n.title,
        n.when_date, n.time_start, n.time_end, n.where_addr, n.text,
        n.subject_type, n.subject_key, n.year, n.supersedes,
        n.created_at, n.revised_at,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Projections: rematerialized wholesale, like board packs
// ---------------------------------------------------------------------------

export const NOTES_PACK_PREFIX = 'camp-notes-';

export const notesPackId = (campId: string, writerId: string): string =>
  `${NOTES_PACK_PREFIX}${campId}-${writerId}`;

const kindWord: Record<NoteKind, string> = {
  memory: 'Camp memory',
  event: 'Camp event',
  fix: 'Correction',
  resource: 'Camp resource',
};

const noteHidden = (conn: QuickSQLiteConnection, id: string): boolean => {
  const r = conn.execute(
    "SELECT 1 FROM hidden_items WHERE kind = 'camp_note' AND key = ?",
    [id],
  );
  return (r.rows?.length ?? 0) > 0;
};

/**
 * Rebuild every notes projection for a camp: one derived pack row + one
 * doc chunk per note per writer, plus one events row per event-kind note.
 * Hidden notes (ONE key: the note id) vanish from every projection at
 * once; superseded notes project only through their successor.
 */
export function rematerializeNotes(
  conn: QuickSQLiteConnection,
  campId: string,
): void {
  const all = listCampNotes(conn, campId);
  const superseded = new Set(all.map(n => n.supersedes).filter(Boolean));
  const byWriter = new Map<string, CampNote[]>();
  for (const n of all) {
    const list = byWriter.get(n.writer_id) ?? [];
    list.push(n);
    byWriter.set(n.writer_id, list);
  }

  // Scope to THIS camp's packs: a global sweep here erased other camps'
  // projections on every edit/import (independent audit, 2026-08-20).
  const stale = conn.execute('SELECT id FROM packs WHERE id LIKE ?', [
    `${NOTES_PACK_PREFIX}${campId}-%`,
  ]);
  const packIds = new Set<string>(
    ((stale.rows?._array ?? []) as { id: string }[]).map(r => r.id),
  );
  for (const w of byWriter.keys()) {
    packIds.add(notesPackId(campId, w));
  }

  for (const packId of packIds) {
    conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [packId]);
    conn.execute("DELETE FROM events WHERE pack_id = ? AND source_kind = 'camp_note'", [packId]);
  }

  for (const [writerId, notes] of byWriter) {
    const packId = notesPackId(campId, writerId);
    const visible = notes.filter(
      n => !superseded.has(n.id) && !noteHidden(conn, n.id),
    );
    const author = notes[0]?.author_name || 'a campmate';
    if (visible.length === 0) {
      // Keep the row: deleting it forgot the user's enabled toggle, and a
      // later reappearance recreated the pack enabled=1 (audit 2026-08-20).
      continue;
    }
    conn.execute(
      `INSERT INTO packs (id, name, description, version, builtin, enabled)
       VALUES (?, ?, ?, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         version = excluded.version`,
      [
        packId,
        `Camp notes — ${author}`,
        `Notes ${author} added in the app: memories, events, fixes, resources. They travel with the camp beam.`,
        visible.length,
      ],
    );
    for (const n of visible) {
      const when =
        n.kind === 'event' && n.when_date
          ? ` on ${n.when_date}${n.time_start ? ` at ${n.time_start}` : ''}`
          : '';
      const heading = n.title || `${kindWord[n.kind]} from ${n.author_name}`;
      const body =
        `${kindWord[n.kind]}${when}${n.where_addr ? ` at ${n.where_addr}` : ''}` +
        `${n.year ? ` (about ${n.year})` : ''}: ${n.text} ` +
        `(recorded by ${n.author_name}, ${n.created_at.slice(0, 10)}; camp-passphrase verified, not authenticated)`;
      conn.execute(
        'INSERT INTO doc_chunks (pack_id, source_file, heading, content, note_key) VALUES (?, ?, ?, ?, ?)',
        [packId, 'camp-notes', heading, body, n.id],
      );
      if (n.kind === 'event' && n.when_date) {
        conn.execute(
          `INSERT INTO events
             (pack_id, title, desc, day, date, time_start, time_end, camp,
              location, source_kind, note_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'camp_note', ?)`,
          [
            packId,
            n.title || n.text.slice(0, 60),
            `${n.text} — added by ${n.author_name} in Playa Pal.`,
            '',
            n.when_date,
            n.time_start,
            n.time_end,
            n.author_name,
            n.where_addr,
            n.id,
          ],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Change subscription (ruling G; the friends revision emitter pattern)
// ---------------------------------------------------------------------------

let revision = 0;
const watchers = new Set<() => void>();

export function notesRevision(): number {
  return revision;
}

export function subscribeNotesChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

export function notifyNotesChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}
