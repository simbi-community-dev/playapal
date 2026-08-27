import type { DbConnection } from './engine';

/** Run synchronous writes atomically. Callers must not nest transactions. */
export function inTransaction<T>(conn: DbConnection, fn: () => T): T {
  conn.execute('BEGIN');
  try {
    const out = fn();
    conn.execute('COMMIT');
    return out;
  } catch (e) {
    try {
      conn.execute('ROLLBACK');
    } catch {
      // Preserve the original write error.
    }
    throw e;
  }
}
