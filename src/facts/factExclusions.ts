import type { DbConnection } from '../events/engine';
import { inTransaction } from '../events/transaction';
import {
  refreshFactGraph,
  type FactNodeRef,
  type FactGraphStats,
} from './factGraph';
import { rebuildPersonCardIndex } from './personCardIndex';

export interface FactExclusionUpdate {
  warnings: string[];
  graph: FactGraphStats;
}

/**
 * Add or revoke one entry in the pack-generic EXCLUDE list. The durable node
 * and document rows stay untouched; only the derived person-card index and
 * runtime graph are rebuilt, so the decision is immediate and reversible.
 */
export function setFactNodeExcluded(
  conn: DbConnection,
  ref: FactNodeRef,
  excluded: boolean,
): FactExclusionUpdate {
  return inTransaction(conn, () => {
    if (excluded) {
      conn.execute(
        'INSERT OR IGNORE INTO fact_exclusions (pack_id, node_id) VALUES (?, ?)',
        [ref.pack_id, ref.id],
      );
    } else {
      conn.execute(
        'DELETE FROM fact_exclusions WHERE pack_id = ? AND node_id = ?',
        [ref.pack_id, ref.id],
      );
    }
    const warnings = rebuildPersonCardIndex(conn, ref.pack_id);
    // Build and swap the runtime graph before COMMIT. A malformed unrelated row
    // leaves both SQLite and the previous graph unchanged instead of exposing
    // contradictory identity and history visibility.
    const graph = refreshFactGraph(conn);
    return { warnings, graph };
  });
}

export function isFactNodeExcluded(
  conn: DbConnection,
  ref: FactNodeRef,
): boolean {
  const result = conn.execute(
    'SELECT 1 FROM fact_exclusions WHERE pack_id = ? AND node_id = ? LIMIT 1',
    [ref.pack_id, ref.id],
  );
  return (result.rows?.length ?? 0) > 0;
}

export interface HiddenPerson extends FactNodeRef {
  /** The node's display name from the pack, for the Settings list. */
  name: string;
  /** The installed pack's display name, so two camps' packs read apart. */
  pack_name: string;
}

/**
 * Every person currently hidden on this phone, joined to the name the pack
 * gave them. This is the READ side of the exclusion list — the surface a
 * user needs to UNDO a hide, which the confirmation dialog promises exists.
 * A hide with no visible way back is a delete with extra steps.
 */
export function listHiddenPeople(conn: DbConnection): HiddenPerson[] {
  const rows =
    conn.execute(
      `SELECT x.pack_id, x.node_id AS id, n.name,
              COALESCE(p.name, x.pack_id) AS pack_name
       FROM fact_exclusions x
       JOIN nodes n ON n.pack_id = x.pack_id AND n.id = x.node_id
       LEFT JOIN packs p ON p.id = x.pack_id
       WHERE n.type = 'person'
       ORDER BY n.name`,
    ).rows?._array ?? [];
  return rows.map(r => ({
    pack_id: String(r.pack_id),
    id: String(r.id),
    name: String(r.name),
    pack_name: String(r.pack_name),
  }));
}
