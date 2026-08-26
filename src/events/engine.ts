/**
 * THE STORAGE ENGINE SEAM (semantic-arm migration, Ember design ruling):
 * the app's whole SQLite surface — conn.execute(sql, params) with
 * rows._array/length/item — is engine-agnostic; exactly ONE call site opens
 * the database. The migration quick-sqlite → op-sqlite therefore changes
 * this module and nothing else:
 *
 *   - OP_SQLITE_PATH: @op-engineering/op-sqlite (same-author lineage of
 *     quick-sqlite; ships sqlite-vec as a build flag — the vector arm's
 *     C-side distance, no hand-rolled math).
 *   - The returned connection keeps the quick-sqlite RESULT SHAPE so every
 *     caller (db.ts, ladder, installPack, campBoard, chatLog) and every
 *     test shim (node:sqlite with the same shape) works unchanged — the
 *     ruling's parity contract item (2).
 *
 * op-sqlite's open() returns an async execute() plus a blocking executeSync().
 * The app's established DB contract is synchronous, so the adapter calls
 * executeSync() and restores the quick-sqlite row collection shape.
 */

export interface SqlRows {
  _array: any[];
  length: number;
  item: (i: number) => any;
}

export interface SqlResult {
  rows?: SqlRows;
}

/** The one connection type the app speaks. Identical surface to
 * QuickSQLiteConnection as USED by this codebase (execute only). */
export interface DbConnection {
  execute(sql: string, params?: any[]): SqlResult;
}

interface OpSqliteConnection {
  executeSync(sql: string, params?: any[]): { rows?: any[] };
}

/** Restore the synchronous quick-sqlite result shape used by app callers. */
export function adaptOpSqliteConnection(conn: OpSqliteConnection): DbConnection {
  return {
    execute(sql: string, params: any[] = []) {
      const res = conn.executeSync(sql, params);
      const rows = Array.isArray(res.rows) ? res.rows : [];
      return {
        rows: {
          _array: rows,
          length: rows.length,
          item: (i: number) => rows[i],
        },
      };
    },
  };
}

/** Open the app database synchronously on op-sqlite. Native feature flags are
 * read from package.json at build time, not from open() options. */
export function openAppDb(name: string): DbConnection {
  const { open, ANDROID_FILES_PATH, IOS_DOCUMENT_PATH } = require('@op-engineering/op-sqlite');
  const { Platform } = require('react-native');
  const location = Platform.OS === 'ios' ? IOS_DOCUMENT_PATH : ANDROID_FILES_PATH;
  return adaptOpSqliteConnection(open({ name, location }));
}

/**
 * Load the sqlite-vec extension on an already-open connection. On-device
 * (op-sqlite built with sqliteVec enabled) the module is compiled in and this is a
 * no-op that simply succeeds; in TESTS (node:sqlite) the npm package's
 * platform binary is loaded through the host's loadExtension — the ruling's
 * parity contract item (3): same DDL, same queries, same extension code,
 * different host. A load failure throws; the caller (db.ts) catches and
 * degrades to keyword-only.
 */
export function loadVecExtension(conn: DbConnection): void {
  // The vec0 probe: on-device, op-sqlite's sqliteVec build flag compiles
  // the module in, so this succeeds and the function is a verification,
  // not a loader. A throw here means vec is genuinely unavailable; the
  // caller (db.ts) catches and degrades to keyword-only.
  //
  // METRO CONSTRAINT (certification build 2026-08-15 caught this): app
  // code must never require('sqlite-vec') — the npm package is the NODE
  // TEST host's loader only, and Metro statically follows any require it
  // can see, then dies on the package's node builtins. The node loading
  // lives in __tests__/support where only jest resolves it.
  //
  // THE PROBE'S OWN DDL MUST BE ONE EVERY sqlite-vec ACCEPTS. The first
  // probe was `__vec_probe USING vec0(__p float[1])`: the node test host's
  // sqlite-vec took it, the op-sqlite build on the Pixel 7 did not —
  // "vec0 constructor error: could not parse table option '__p float[1]'"
  // (2026-08-17, every cold start) — so the probe threw, vec was recorded
  // unavailable, the real table was never created, packs installed without
  // their vectors, and the whole semantic arm sat inert on the phone while
  // the tests stayed green. A plain column name and a real dimension.
  conn.execute('CREATE VIRTUAL TABLE IF NOT EXISTS vec_probe_tmp USING vec0(probe_embedding float[8])');
  conn.execute('DROP TABLE IF EXISTS vec_probe_tmp');
}
