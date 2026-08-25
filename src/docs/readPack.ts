/**
 * Pack reader — the pure helpers behind the offline reader (owner
 * commission 2026-08-19): "a nice offline reader of saved materials will be
 * preferred by many people over being forced to ask an llm about something
 * and wait for replies." So the saved materials open directly: no
 * retrieval, no ranking, no model — the doc_chunks read back whole.
 *
 * ORDER CONTRACT: installPack.ts inserts a pack's chunks in document order
 * with no explicit ids, so doc_chunks.id (the rowid) IS the insertion
 * ordinal. `ORDER BY id` is already how aboutPin and the vector backfill
 * walk a document; reading the same way reproduces the source exactly.
 */

import type { DbConnection } from '../events/engine';

export interface DocSource {
  source: string;
  chunkCount: number;
  firstHeading: string;
}

export interface DocChunk {
  heading: string;
  content: string;
  /** camp-note provenance: the note id this chunk projects, '' otherwise.
   * The reader uses it to show an art note's photo beside its passage. */
  noteKey: string;
}

/** A DocChunk stamped with whether its heading differs from the previous
 * chunk's — the reader prints a heading once per run, never per chunk. */
export interface ReaderChunk extends DocChunk {
  newHeading: boolean;
}

/** The pack's table of contents: one row per source file, in first-insert
 * order (the order the pack shipped its files, not alphabetical). */
export function listDocSources(conn: DbConnection, packId: string): DocSource[] {
  // MIN(id) makes the bare `heading` come from that same first row —
  // documented SQLite min()/bare-column semantics, identical in the app
  // engine (op-sqlite) and the test engine (node:sqlite).
  const res = conn.execute(
    `SELECT source_file AS source, COUNT(*) AS chunkCount,
            MIN(id) AS firstId, heading AS firstHeading
     FROM doc_chunks WHERE pack_id = ?
     GROUP BY source_file ORDER BY firstId`,
    [packId],
  );
  const rows = (res.rows?._array ?? []) as Array<{
    source: string;
    chunkCount: number;
    firstHeading: string | null;
  }>;
  return rows.map(r => ({
    source: String(r.source),
    chunkCount: Number(r.chunkCount),
    firstHeading: String(r.firstHeading ?? ''),
  }));
}

/** One source document, every chunk, in document order (see the ORDER
 * CONTRACT above). */
export function readDocSource(
  conn: DbConnection,
  packId: string,
  source: string,
): DocChunk[] {
  const res = conn.execute(
    `SELECT heading, content, note_key FROM doc_chunks
     WHERE pack_id = ? AND source_file = ? ORDER BY id`,
    [packId, source],
  );
  const rows = (res.rows?._array ?? []) as Array<{
    heading: string | null;
    content: string;
    note_key: string | null;
  }>;
  return rows.map(r => ({
    heading: String(r.heading ?? ''),
    content: String(r.content),
    noteKey: String(r.note_key ?? ''),
  }));
}

/** Consecutive chunks usually share a heading (the chunker splits long
 * sections); the reader shows the heading only where it changes. */
export function markHeadingChanges(chunks: DocChunk[]): ReaderChunk[] {
  let prev: string | null = null;
  return chunks.map(c => {
    const newHeading = c.heading !== '' && c.heading !== prev;
    prev = c.heading;
    return { ...c, newHeading };
  });
}

/** Heading breadcrumbs are ' > '-joined by the chunker; the LAST segment is
 * the section the reader stands in, the full trail is context. */
export function headingSegments(heading: string): string[] {
  return heading
    .split('>')
    .map(s => s.trim())
    .filter(Boolean);
}

/** A single-source pack's one entry reads as the pack itself ("Survival
 * guide"), never as its packaging ("guide"). Multi-source packs fall back
 * to the humanized filename stem. */
export function humanizeSource(
  source: string,
  packName: string,
  sourceCount: number,
): string {
  if (sourceCount === 1) {
    return packName;
  }
  const stem = (source.split('/').pop() ?? source).replace(/\.[a-z0-9]+$/i, '');
  const words = stem.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : source;
}

/** Markdown-ish prose to plain paragraphs, no markdown dependency (the
 * reader reads, it does not typeset): leading #s drop, -/* bullets become
 * •, blank lines split paragraphs. */
export function contentParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map(p =>
      p
        .split('\n')
        .map(line =>
          line.replace(/^\s*#{1,6}\s+/, '').replace(/^(\s*)[-*]\s+/, '$1• '),
        )
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}
