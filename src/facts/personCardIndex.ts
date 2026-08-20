import type { DbConnection } from '../events/engine';
import { normalizeFactEntity } from './normalizeFactEntity';
import { parsePersonCardHeading } from './personCard';

interface PersonNodeRow {
  pack_id: string;
  id: string;
  name: string;
  attrs: Record<string, unknown>;
}

interface ChunkRow {
  id: number;
  pack_id: string;
  source_file: string;
  heading: string;
  key: string;
}

interface CardPointer {
  source_file: string;
  index: number;
}

function rows(result: ReturnType<DbConnection['execute']>): any[] {
  if (result.rows?._array) {
    return result.rows._array;
  }
  const out: any[] = [];
  for (let i = 0; i < (result.rows?.length ?? 0); i++) {
    out.push(result.rows!.item(i));
  }
  return out;
}

function parseAttrs(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cardPointer(value: unknown): CardPointer | null {
  if (typeof value === 'string') {
    const match = /^(.*):(\d+)$/.exec(value.trim());
    return match
      ? { source_file: match[1], index: Number(match[2]) }
      : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const pointer = value as Record<string, unknown>;
  return typeof pointer.source_file === 'string' &&
    Number.isInteger(pointer.index) &&
    Number(pointer.index) >= 0
    ? { source_file: pointer.source_file, index: Number(pointer.index) }
    : null;
}

function personNodes(conn: DbConnection, packId?: string): PersonNodeRow[] {
  const result = conn.execute(
    `SELECT n.pack_id, n.id, n.name, n.attrs FROM nodes n
     WHERE n.type = 'person'
       AND NOT EXISTS (
         SELECT 1 FROM fact_exclusions x
         WHERE x.pack_id = n.pack_id AND x.node_id = n.id
       )${packId ? ' AND n.pack_id = ?' : ''}
     ORDER BY n.pack_id, n.id`,
    packId ? [packId] : [],
  );
  return rows(result).map(row => ({
    pack_id: String(row.pack_id),
    id: String(row.id),
    name: String(row.name),
    attrs: parseAttrs(row.attrs),
  }));
}

function documentChunks(conn: DbConnection, packId?: string): ChunkRow[] {
  const result = conn.execute(
    `SELECT id, pack_id, source_file, heading FROM doc_chunks
     ${packId ? 'WHERE pack_id = ?' : ''}
     ORDER BY pack_id, id`,
    packId ? [packId] : [],
  );
  const sourceIndexes = new Map<string, number>();
  return rows(result).map(row => {
    const pack_id = String(row.pack_id);
    const source_file = String(row.source_file);
    const source = `${pack_id}\0${source_file}`;
    const index = sourceIndexes.get(source) ?? 0;
    sourceIndexes.set(source, index + 1);
    return {
      id: Number(row.id),
      pack_id,
      source_file,
      heading: String(row.heading),
      key: `${source_file}:${index}`,
    };
  });
}

/** Rebuild the derived person->document index for one pack or every installed
 * pack. Nodes and documents remain the sources of truth; invalid optional links
 * warn and stay unindexed rather than making a graph-only pack unusable. */
export function rebuildPersonCardIndex(
  conn: DbConnection,
  packId?: string,
): string[] {
  const warnings: string[] = [];
  const nodes = personNodes(conn, packId);
  const chunks = documentChunks(conn, packId);
  const packs = new Set([
    ...nodes.map(node => node.pack_id),
    ...chunks.map(chunk => chunk.pack_id),
    ...(packId ? [packId] : []),
  ]);
  for (const id of packs) {
    conn.execute('DELETE FROM person_card_chunks WHERE pack_id = ?', [id]);
  }

  const byPack = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    const list = byPack.get(chunk.pack_id) ?? [];
    list.push(chunk);
    byPack.set(chunk.pack_id, list);
  }
  const nameCounts = new Map<string, number>();
  for (const node of nodes) {
    const key = `${node.pack_id}\0${normalizeFactEntity(node.name)}`;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const used = new Set<number>();

  for (const node of nodes) {
    const packChunks = byPack.get(node.pack_id) ?? [];
    const explicit = cardPointer(node.attrs.card_chunk);
    let matches: ChunkRow[] = [];
    if (explicit) {
      const key = `${explicit.source_file}:${explicit.index}`;
      matches = packChunks.filter(chunk => chunk.key === key);
      if (matches.length !== 1) {
        warnings.push(`${node.id}: card_chunk "${key}" is unavailable; person card not indexed`);
        continue;
      }
    } else if (node.attrs.card !== undefined) {
      if (typeof node.attrs.card !== 'string' || !node.attrs.card.trim()) {
        warnings.push(`${node.id}: attrs.card must name a source file; person card not indexed`);
        continue;
      }
      const uniqueName = nameCounts.get(
        `${node.pack_id}\0${normalizeFactEntity(node.name)}`,
      ) === 1;
      if (!uniqueName) {
        continue;
      }
      matches = packChunks.filter(chunk => {
        if (chunk.source_file !== node.attrs.card) {
          return false;
        }
        const heading = parsePersonCardHeading(chunk.heading);
        return heading !== null &&
          normalizeFactEntity(heading.name) === normalizeFactEntity(node.name);
      });
      if (matches.length !== 1) {
        if (packChunks.some(chunk => chunk.source_file === node.attrs.card)) {
          warnings.push(`${node.id}: legacy card link was not unique; person card not indexed`);
        }
        continue;
      }
    } else {
      continue;
    }

    const chunk = matches[0];
    const heading = parsePersonCardHeading(chunk.heading);
    if (!heading || normalizeFactEntity(heading.name) !== normalizeFactEntity(node.name)) {
      warnings.push(`${node.id}: linked chunk names another person; person card not indexed`);
      continue;
    }
    if (used.has(chunk.id)) {
      warnings.push(`${node.id}: linked chunk is already assigned; person card not indexed`);
      continue;
    }
    conn.execute(
      'INSERT INTO person_card_chunks (pack_id, person_id, chunk_id) VALUES (?, ?, ?)',
      [node.pack_id, node.id, chunk.id],
    );
    used.add(chunk.id);
  }
  return warnings;
}
