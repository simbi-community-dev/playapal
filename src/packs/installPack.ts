/**
 * Data-pack installer core.
 *
 * Operates on in-memory file payloads (name + content string) so the same
 * code path serves both the bundled built-in packs and packs imported through
 * the document picker. No filesystem access here — importPack.ts does the
 * reading.
 *
 * Pack format (see README "Data packs"):
 *   pack.json            — { id, name, description, version }
 *   *.json / *.csv       — STRUCTURED events (array of event rows / CSV with
 *                          a header row) -> typed `events` table
 *   *.md / *.txt         — FREEFORM docs -> chunked into `doc_chunks`
 *   nodes.json           — generic fact nodes: { id, type, name, attrs }
 *   edges.json           — typed relationships: { src, dst, type, year, evidence_ref }
 */

import type { DbConnection as QuickSQLiteConnection } from '../events/engine';
import type { GraphEdgeInput, GraphNodeInput, PackManifest } from '../types';
import { inTransaction } from '../events/transaction';
import { chunkDocument } from './chunker';
import { weekdayName } from '../events/timeParser';
import { rebuildPersonCardIndex } from '../facts/personCardIndex';

export interface PackFilePayload {
  /** File name including extension, e.g. "events.json" or "guide.md". */
  name: string;
  content: string;
}

export interface InstallResult {
  packId: string;
  name: string;
  events: number;
  chunks: number;
  nodes: number;
  edges: number;
  /** Open board posts installed — present only for camp beams (importPack). */
  items?: number;
  /** Friend cards added/updated — present only for friend imports. */
  friends?: number;
  /** Human summary for friend imports ("added Micah; 1 older copy skipped"). */
  detail?: string;
  /** Files that were skipped, with reasons — surfaced in the Packs UI. */
  warnings: string[];
}

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function parseManifest(content: string): PackManifest {
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('pack.json is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pack.json must be a JSON object');
  }
  if (typeof raw.id !== 'string' || !PACK_ID_RE.test(raw.id)) {
    throw new Error('pack.json "id" must be lowercase kebab-case (e.g. "my-camp-docs")');
  }
  // camp-board-* / camp-notes-* are app-managed dynamic packs; an imported
  // pack in that namespace would be swept by camp maintenance (set-aside,
  // writer removal) — refuse at the door instead of destroying it later.
  if (raw.id.startsWith('camp-board-') || raw.id.startsWith('camp-notes-')) {
    throw new Error(
      'pack.json "id" may not start with "camp-board-" or "camp-notes-" — those names belong to the app\'s own camp packs',
    );
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    throw new Error('pack.json "name" is required');
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    throw new Error('pack.json "version" must be an integer');
  }
  return {
    id: raw.id,
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    version: raw.version,
  };
}

/** Minimal CSV parser: quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip rows that are entirely empty (trailing newline artifacts).
    if (row.length > 1 || row[0].trim().length > 0) {
      rows.push(row);
    }
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch !== '\r') {
      field += ch;
    }
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

interface ParsedEvent {
  title: string;
  desc: string;
  day: string;
  date: string;
  time_start: string;
  time_end: string;
  camp: string;
  location: string;
}

function normalizeEvent(raw: any, file: string, index: number): ParsedEvent {
  const title = String(raw.title ?? '').trim();
  const date = String(raw.date ?? '').trim();
  if (title.length === 0) {
    throw new Error(`${file} row ${index + 1}: "title" is required`);
  }
  if (!DATE_RE.test(date)) {
    throw new Error(`${file} row ${index + 1}: "date" must be YYYY-MM-DD (got "${date}")`);
  }
  const time = (v: unknown): string => {
    const s = String(v ?? '').trim();
    return TIME_RE.test(s) ? s : '';
  };
  return {
    title,
    desc: String(raw.desc ?? '').trim(),
    // day is ALWAYS derived from date — a pack cannot ship a mismatched pair.
    day: weekdayName(date),
    date,
    time_start: time(raw.time_start),
    time_end: time(raw.time_end),
    camp: String(raw.camp ?? '').trim(),
    location: String(raw.location ?? '').trim(),
  };
}

function parseEventsJson(content: string, file: string): ParsedEvent[] {
  const raw = JSON.parse(content);
  if (!Array.isArray(raw)) {
    throw new Error(`${file}: expected a JSON array of event objects`);
  }
  return raw.map((r, i) => normalizeEvent(r, file, i));
}

function parseEventsCsv(content: string, file: string): ParsedEvent[] {
  const rows = parseCsv(content);
  if (rows.length < 2) {
    throw new Error(`${file}: CSV needs a header row plus at least one event`);
  }
  const header = rows[0].map(h => h.trim().toLowerCase());
  if (!header.includes('title') || !header.includes('date')) {
    throw new Error(`${file}: CSV header must include "title" and "date"`);
  }
  return rows.slice(1).map((cells, i) => {
    const obj: Record<string, string> = {};
    header.forEach((h, c) => {
      obj[h] = cells[c] ?? '';
    });
    return normalizeEvent(obj, file, i);
  });
}

const GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GRAPH_TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function parseGraphArray(content: string, file: string): any[] {
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${file}: expected a JSON array`);
  }
  return raw;
}

function graphString(raw: any, field: string, file: string, index: number): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} row ${index + 1}: expected a JSON object`);
  }
  const value = typeof raw[field] === 'string' ? raw[field].trim() : '';
  if (!value) {
    throw new Error(`${file} row ${index + 1}: "${field}" is required`);
  }
  return value;
}

export function parseGraphNodes(content: string, file = 'nodes.json'): GraphNodeInput[] {
  const seen = new Set<string>();
  return parseGraphArray(content, file).map((raw, i) => {
    const id = graphString(raw, 'id', file, i);
    const type = graphString(raw, 'type', file, i);
    const name = graphString(raw, 'name', file, i);
    if (!GRAPH_ID_RE.test(id)) {
      throw new Error(`${file} row ${i + 1}: invalid node id "${id}"`);
    }
    if (!GRAPH_TYPE_RE.test(type)) {
      throw new Error(`${file} row ${i + 1}: invalid node type "${type}"`);
    }
    if (seen.has(id)) {
      throw new Error(`${file}: duplicate node id "${id}"`);
    }
    seen.add(id);
    const attrs = raw.attrs ?? {};
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
      throw new Error(`${file} row ${i + 1}: "attrs" must be a JSON object`);
    }
    return { id, type, name, attrs };
  });
}

export function parseGraphEdges(content: string, file = 'edges.json'): GraphEdgeInput[] {
  const seen = new Set<string>();
  return parseGraphArray(content, file).map((raw, i) => {
    const src = graphString(raw, 'src', file, i);
    const dst = graphString(raw, 'dst', file, i);
    const type = graphString(raw, 'type', file, i);
    const evidence_ref = graphString(raw, 'evidence_ref', file, i);
    if (!GRAPH_ID_RE.test(src) || !GRAPH_ID_RE.test(dst)) {
      throw new Error(`${file} row ${i + 1}: invalid edge endpoint`);
    }
    if (!GRAPH_TYPE_RE.test(type)) {
      throw new Error(`${file} row ${i + 1}: invalid edge type "${type}"`);
    }
    const year = raw.year == null ? null : raw.year;
    if (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999)) {
      throw new Error(`${file} row ${i + 1}: "year" must be an integer from 1 to 9999`);
    }
    const attrs = raw.attrs ?? {};
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
      throw new Error(`${file} row ${i + 1}: "attrs" must be a JSON object`);
    }
    const key = JSON.stringify([src, dst, type, year, evidence_ref]);
    if (seen.has(key)) {
      throw new Error(`${file}: duplicate edge at row ${i + 1}`);
    }
    seen.add(key);
    return { src, dst, type, year, evidence_ref, attrs };
  });
}

const ext = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

function namedFile(files: PackFilePayload[], name: string): PackFilePayload | null {
  const found = files.filter(f => f.name.toLowerCase() === name);
  if (found.length > 1) {
    throw new Error(`Pack contains more than one ${name}`);
  }
  return found[0] ?? null;
}

function tableExists(conn: QuickSQLiteConnection, name: string): boolean {
  const row = conn.execute(
    "SELECT 1 AS found FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
    [name],
  );
  return Boolean(row.rows?.length);
}

/** Delete every ordinary content row owned by a pack. The pack row and camp
 * replication tables are intentionally separate concerns. */
export function deletePackData(conn: QuickSQLiteConnection, packId: string): void {
  if (tableExists(conn, 'doc_chunk_vectors')) {
    conn.execute(
      'DELETE FROM doc_chunk_vectors WHERE rowid IN (SELECT id FROM doc_chunks WHERE pack_id = ?)',
      [packId],
    );
  }
  conn.execute(
    'DELETE FROM doc_chunk_vectors_meta WHERE chunk_id IN (SELECT id FROM doc_chunks WHERE pack_id = ?)',
    [packId],
  );
  conn.execute('DELETE FROM person_card_chunks WHERE pack_id = ?', [packId]);
  conn.execute('DELETE FROM edges WHERE pack_id = ?', [packId]);
  conn.execute('DELETE FROM nodes WHERE pack_id = ?', [packId]);
  conn.execute('DELETE FROM events WHERE pack_id = ?', [packId]);
  conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [packId]);
}

const VECTOR_DIM = 384;

interface EmbeddingsPayload {
  model: string;
  dim: number;
  vectors: Record<string, number[]>;
}

function chunkKeys(chunks: { source: string }[]): string[] {
  const perSource = new Map<string, number>();
  return chunks.map(c => {
    const i = perSource.get(c.source) ?? 0;
    perSource.set(c.source, i + 1);
    return `${c.source}:${i}`;
  });
}

function parseEmbeddings(
  file: PackFilePayload | null,
  validKeys: Set<string>,
): EmbeddingsPayload | null {
  if (!file) {
    return null;
  }
  let raw: any;
  try {
    raw = JSON.parse(file.content);
  } catch {
    throw new Error('embeddings.json is not valid JSON');
  }
  if (
    typeof raw.model !== 'string' ||
    !raw.model.trim() ||
    raw.dim !== VECTOR_DIM ||
    !raw.vectors ||
    typeof raw.vectors !== 'object' ||
    Array.isArray(raw.vectors)
  ) {
    throw new Error(`embeddings.json must carry { model, dim: ${VECTOR_DIM}, vectors }`);
  }
  for (const [key, vector] of Object.entries(raw.vectors as Record<string, unknown>)) {
    if (!validKeys.has(key)) {
      throw new Error(
        `embeddings.json stale vector build — key has no chunk in this pack: ${key}`,
      );
    }
    if (
      !Array.isArray(vector) ||
      vector.length !== VECTOR_DIM ||
      vector.some(v => typeof v !== 'number' || !Number.isFinite(v))
    ) {
      throw new Error(`embeddings.json ${key}: expected ${VECTOR_DIM} finite numbers`);
    }
  }
  return {
    model: raw.model.trim(),
    dim: raw.dim,
    vectors: raw.vectors,
  };
}

/** Install or replace one pack atomically. Existing enabled state survives. */
export function installPackFromFiles(
  conn: QuickSQLiteConnection,
  files: PackFilePayload[],
  opts: { builtin?: boolean; chunkMaxChars?: number } = {},
): InstallResult {
  const manifestFile = namedFile(files, 'pack.json');
  if (!manifestFile) {
    throw new Error('A data pack needs a pack.json manifest');
  }
  const manifest = parseManifest(manifestFile.content);
  const nodeFile = namedFile(files, 'nodes.json');
  const edgeFile = namedFile(files, 'edges.json');
  const nodes = nodeFile ? parseGraphNodes(nodeFile.content, nodeFile.name) : [];
  const edges = edgeFile ? parseGraphEdges(edgeFile.content, edgeFile.name) : [];
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.src) || !nodeIds.has(edge.dst)) {
      throw new Error(
        `edges.json endpoint missing from nodes.json: ${edge.src} -> ${edge.dst}`,
      );
    }
  }

  const events: ParsedEvent[] = [];
  const chunks: { source: string; heading: string; content: string }[] = [];
  const warnings: string[] = [];
  // flags.json = the pack's own data-quality flags (CAMP-PACK-GRAPH-SPEC.md):
  // shipped for the Lineage view, inert to the installer. Reserved so it is
  // never mistaken for an events file (every unreserved .json IS events).
  const reserved = new Set(['pack.json', 'nodes.json', 'edges.json', 'embeddings.json', 'flags.json']);

  for (const f of files) {
    if (reserved.has(f.name.toLowerCase())) {
      continue;
    }
    const e = ext(f.name);
    if (e === 'json') {
      events.push(...parseEventsJson(f.content, f.name));
    } else if (e === 'csv') {
      events.push(...parseEventsCsv(f.content, f.name));
    } else if (e === 'md' || e === 'txt') {
      for (const c of chunkDocument(f.content, opts.chunkMaxChars ? { maxChars: opts.chunkMaxChars } : undefined)) {
        chunks.push({ source: f.name, heading: c.heading, content: c.content });
      }
    } else {
      warnings.push(`${f.name}: unsupported type ".${e}" - skipped`);
    }
  }
  if (!events.length && !chunks.length && !nodes.length && !edges.length) {
    throw new Error(
      'Pack has no usable content (need events, docs, or nodes.json/edges.json)',
    );
  }

  const keys = chunkKeys(chunks);
  const embeddings = parseEmbeddings(namedFile(files, 'embeddings.json'), new Set(keys));
  const prev = conn.execute('SELECT enabled FROM packs WHERE id = ?', [manifest.id]);
  const enabled = prev.rows?.length ? prev.rows.item(0).enabled : 1;

  inTransaction(conn, () => {
    deletePackData(conn, manifest.id);
    conn.execute(
      `INSERT INTO packs (id, name, description, version, enabled, builtin)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         version = excluded.version, builtin = excluded.builtin`,
      [
        manifest.id,
        manifest.name,
        manifest.description,
        manifest.version,
        enabled,
        opts.builtin ? 1 : 0,
      ],
    );
    for (const ev of events) {
      conn.execute(
        `INSERT INTO events (pack_id, title, desc, day, date, time_start, time_end, camp, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          manifest.id,
          ev.title,
          ev.desc,
          ev.day,
          ev.date,
          ev.time_start,
          ev.time_end,
          ev.camp,
          ev.location,
        ],
      );
    }
    for (const c of chunks) {
      conn.execute(
        'INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, ?, ?, ?)',
        [manifest.id, c.source, c.heading, c.content],
      );
    }
    for (const node of nodes) {
      conn.execute(
        'INSERT INTO nodes (pack_id, id, type, name, attrs) VALUES (?, ?, ?, ?, ?)',
        [manifest.id, node.id, node.type, node.name, JSON.stringify(node.attrs ?? {})],
      );
    }
    for (const edge of edges) {
      conn.execute(
        `INSERT INTO edges (pack_id, src, dst, type, year, evidence_ref, attrs)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [manifest.id, edge.src, edge.dst, edge.type, edge.year ?? null, edge.evidence_ref,
         JSON.stringify(edge.attrs ?? {})],
      );
    }
    warnings.push(...rebuildPersonCardIndex(conn, manifest.id));

    if (embeddings && tableExists(conn, 'doc_chunk_vectors')) {
      const installed = conn.execute(
        'SELECT id FROM doc_chunks WHERE pack_id = ? ORDER BY id',
        [manifest.id],
      );
      if (installed.rows?.length !== chunks.length) {
        throw new Error('Installed chunk count does not match vector payload');
      }
      chunks.forEach((_chunk, i) => {
        const vector = embeddings.vectors[keys[i]];
        if (!vector) {
          return;
        }
        const chunkId = installed.rows!.item(i).id;
        conn.execute(
          'INSERT INTO doc_chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)',
          [chunkId, JSON.stringify(vector)],
        );
        conn.execute(
          'INSERT INTO doc_chunk_vectors_meta (chunk_id, model) VALUES (?, ?)',
          [chunkId, embeddings.model],
        );
      });
    }
  });

  return {
    packId: manifest.id,
    name: manifest.name,
    events: events.length,
    chunks: chunks.length,
    nodes: nodes.length,
    edges: edges.length,
    warnings,
  };
}
