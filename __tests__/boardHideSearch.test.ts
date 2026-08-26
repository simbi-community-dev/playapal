/**
 * END-TO-END board-section hide regressions through the REAL searchDocs
 * (audit round 4): a hide must (a) not consume the result LIMIT slot,
 * (b) survive rematerialization's chunk-id churn, (c) refuse a stale
 * long-press key honestly, and (d) follow the first-join pack rename.
 */

import { BASE_TABLES_SQL, FTS_TABLES_SQL, REBUILD_FTS_SQL } from '../src/events/schema';
import { searchDocs } from '../src/docs/searchDocs';
import { hideItem } from '../src/facts/hiddenItems';
import {
  CAMP_WRITER_ID_KEY,
  exportCampBundle,
  installCampBundle,
  reconcileWriterIncarnation,
  rematerializeAllBoards,
  saveCampProfile,
  upsertCampPost,
} from '../src/camp/campBoard';
import { setPackEnabledFull } from '../src/events/db';

const { DatabaseSync } = require('node:sqlite');

function makeConn(writerId: string): import('../src/events/engine').DbConnection {
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
  } as unknown as import('../src/events/engine').DbConnection;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  return conn;
}

const mockCtx: { conn: ReturnType<typeof makeConn> } = { conn: undefined as never };
jest.mock('../src/events/db', () => ({
  getDb: () => mockCtx.conn,
  isFtsAvailable: () => true,
  // the conn-taking paths are real: they never touch getDb
  setPackEnabledFull: (...args: unknown[]) =>
    jest.requireActual('../src/events/db').setPackEnabledFull(...args),
  rebuildFtsIndexes: (...args: unknown[]) =>
    jest.requireActual('../src/events/db').rebuildFtsIndexes(...args),
}));

const refts = () => {
  for (const sql of REBUILD_FTS_SQL) {
    mockCtx.conn.execute(sql);
  }
};

const boardChunks = (): { pack_id: string; id: number }[] =>
  mockCtx.conn.execute(
    "SELECT pack_id, id FROM doc_chunks WHERE source_file = 'camp-board' ORDER BY id",
  ).rows!._array;

describe('board-section hides through real searchDocs', () => {
  beforeEach(() => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    upsertCampPost(mockCtx.conn, { type: 'offer', text: 'Glowsticks at the dome all night.' });
    const b = makeConn('writerbbbb');
    saveCampProfile(b, { authorName: 'Marisol', passphrase: 'dusty hippos 2026' });
    upsertCampPost(b, { type: 'offer', text: 'Glowsticks trade table at center camp.' });
    installCampBundle(mockCtx.conn, exportCampBundle(b));
    refts();
  });

  test('a hidden rank-1 board hit does not consume the LIMIT slot', () => {
    const both = searchDocs({ query: 'glowsticks' }, 2);
    expect(both.results).toHaveLength(2);
    const first = both.results[0];
    hideItem(mockCtx.conn, {
      kind: 'passage',
      key: `${first.pack_id}:${first.id}`,
      label: 'glowsticks section',
    });
    const after = searchDocs({ query: 'glowsticks' }, 1);
    expect(after.results).toHaveLength(1); // the slot filled with the OTHER chunk
    expect(after.results[0].pack_id).not.toBe(first.pack_id);
  });

  test('the hide survives rematerialization id churn', () => {
    const first = searchDocs({ query: 'glowsticks' }, 1).results[0];
    hideItem(mockCtx.conn, {
      kind: 'passage',
      key: `${first.pack_id}:${first.id}`,
      label: 'glowsticks section',
    });
    mockCtx.conn.execute(
      "INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES ('x', 'x.md', 'x', 'occupier')",
    );
    rematerializeAllBoards(mockCtx.conn);
    refts();
    const ids = boardChunks();
    expect(ids.some(c => c.id === first.id && c.pack_id === first.pack_id)).toBe(false);
    const after = searchDocs({ query: 'glowsticks' }, 2);
    expect(after.results.every(r => r.pack_id !== first.pack_id)).toBe(true);
    expect(after.results).toHaveLength(1); // only the visible writer's chunk
  });

  test('MULTIPLE hidden rows ahead still cannot false-empty a limit-1 search', () => {
    const c = makeConn('writercccc');
    saveCampProfile(c, { authorName: 'Rook', passphrase: 'dusty hippos 2026' });
    upsertCampPost(c, { type: 'offer', text: 'Glowsticks wholesale, ask for Rook.' });
    installCampBundle(mockCtx.conn, exportCampBundle(c));
    refts();
    const three = searchDocs({ query: 'glowsticks' }, 3);
    expect(three.results).toHaveLength(3);
    for (const r of three.results.slice(0, 2)) {
      hideItem(mockCtx.conn, {
        kind: 'passage',
        key: `${r.pack_id}:${r.id}`,
        label: 'hidden section',
      });
    }
    const after = searchDocs({ query: 'glowsticks' }, 1);
    expect(after.results).toHaveLength(1); // two hidden rows ahead — slot still fills
    expect(after.results[0].pack_id).toBe(three.results[2].pack_id);
  });

  test('55 REAL matching hidden passages ahead cannot false-empty a limit-1 search (kills the 50 cap)', () => {
    // 55 genuine matching chunks, every one hidden, plus Dusty's hidden
    // board chunk = 56 hidden rows that all RANK for the query. Under the
    // old Math.min(hidden, 50) cap, fetchLimit = 51 returned only hidden
    // rows and post-filter false-emptied; uncapped, the one visible chunk
    // (Marisol's) must come back.
    mockCtx.conn.execute(
      "INSERT INTO packs (id, name, description, version, builtin, enabled) VALUES ('filler-pack', 'Filler', 'x', 1, 0, 1)",
    );
    Array.from({ length: 55 }).forEach((_, i) => {
      mockCtx.conn.execute(
        "INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES ('filler-pack', 'f.md', ?, ?)",
        [`filler ${i}`, `Filler glowsticks stash number ${i} behind the water truck.`],
      );
    });
    refts();
    const fillers = mockCtx.conn.execute(
      "SELECT pack_id, id FROM doc_chunks WHERE pack_id = 'filler-pack'",
    ).rows!._array as { pack_id: string; id: number }[];
    expect(fillers).toHaveLength(55);
    for (const f of fillers) {
      hideItem(mockCtx.conn, { kind: 'passage', key: `${f.pack_id}:${f.id}`, label: 'filler' });
    }
    const dusty = boardChunks().find(c => c.pack_id.endsWith('writeraaaa'))!;
    hideItem(mockCtx.conn, {
      kind: 'passage',
      key: `${dusty.pack_id}:${dusty.id}`,
      label: 'dusty board',
    });
    const after = searchDocs({ query: 'glowsticks' }, 1);
    expect(after.results).toHaveLength(1);
    expect(after.results[0].pack_id.endsWith('writerbbbb')).toBe(true);
  });

  test('the prefix-rescue rung itself honors hides (revival disabled, strategy asserted)', () => {
    // revive_dead_terms: false closes the dead-term path, so the ONLY way
    // 'glowstickery' returns anything is the zero-result prefix rescue —
    // asserted via the strategy so disabling the rescue branch fails here.
    const first = searchDocs({ query: 'glowsticks' }, 1).results[0];
    hideItem(mockCtx.conn, {
      kind: 'passage',
      key: `${first.pack_id}:${first.id}`,
      label: 'glowsticks section',
    });
    const rescued = searchDocs({ query: 'glowstickery', revive_dead_terms: false }, 2);
    expect(rescued.results.length).toBeGreaterThan(0);
    expect(rescued.strategy).toMatch(/prefix/); // the rescue rung, not the ladder
    expect(rescued.results.every(r => r.pack_id !== first.pack_id)).toBe(true);
  });

  test('a stale long-press key (chunk gone) is refused honestly', () => {
    const first = boardChunks()[0];
    mockCtx.conn.execute(
      "INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES ('x', 'x.md', 'x', 'occupier')",
    );
    rematerializeAllBoards(mockCtx.conn); // regenerates every board chunk id
    expect(() =>
      hideItem(mockCtx.conn, {
        kind: 'passage',
        key: `${first.pack_id}:${first.id}`,
        label: 'stale',
      }),
    ).toThrow(/moved since it was shown/);
  });

  test('a pre-camp hide follows the first-join pack rename', () => {
    const solo = makeConn('writercccc');
    mockCtx.conn = solo;
    saveCampProfile(solo, { authorName: 'Nomad', passphrase: '' });
    upsertCampPost(solo, { type: 'offer', text: 'Sunrise coffee cart rides at dawn.' });
    refts();
    const chunk = boardChunks()[0];
    expect(chunk.pack_id).toContain('local');
    hideItem(solo, {
      kind: 'passage',
      key: `${chunk.pack_id}:${chunk.id}`,
      label: 'coffee section',
    });
    saveCampProfile(solo, { authorName: 'Nomad', passphrase: 'dusty hippos 2026' });
    refts();
    const migrated = solo
      .execute("SELECT key FROM hidden_items WHERE kind = 'passage'")
      .rows!.item(0);
    expect(String(migrated.key)).not.toContain('local');
    const res = searchDocs({ query: 'sunrise coffee' }, 2);
    expect(res.results.filter(r => r.pack_id.startsWith('camp-board-'))).toHaveLength(0);
  });
});

describe('mute toggle contract through the real core (audit round 6 coverage)', () => {
  test('setPackEnabledFull: cross-writer reply leaves the host chunk on mute, rollback keeps the toggle, no manual reindex needed', () => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    const offered = upsertCampPost(mockCtx.conn, { type: 'offer', text: 'Glowsticks at the dome.' });
    const b = makeConn('writerbbbb');
    saveCampProfile(b, { authorName: 'Marisol', passphrase: 'dusty hippos 2026' });
    installCampBundle(b, exportCampBundle(mockCtx.conn));
    const reply = upsertCampPost(b, {
      type: 'offer',
      text: 'Marisol will restock the glowsticks pile tonight.',
      ref_id: offered.id,
    });
    expect(reply.ref_id).toBe(offered.id);
    installCampBundle(mockCtx.conn, exportCampBundle(b));

    const dustyChunk = () =>
      String(
        mockCtx.conn
          .execute(
            "SELECT content FROM doc_chunks WHERE source_file = 'camp-board' AND pack_id LIKE '%writeraaaa'",
          )
          .rows!.item(0).content,
      );
    const marisolPackId = String(
      mockCtx.conn
        .execute("SELECT id FROM packs WHERE id LIKE 'camp-board-%writerbbbb'")
        .rows!.item(0).id,
    );
    // the reply is INLINED in Dusty's own chunk — the seam the JOIN cannot mute
    expect(dustyChunk()).toContain('restock the glowsticks pile');

    // ROLLBACK INJECTION: a failure mid-rematerialize must roll the toggle
    // back — never "muted" state with the replies still present.
    const original = mockCtx.conn.execute.bind(mockCtx.conn);
    const throwing = {
      execute(sql: string, params: unknown[] = []) {
        if (sql.includes('DELETE FROM doc_chunks')) {
          throw new Error('injected failure');
        }
        return original(sql, params);
      },
    } as typeof mockCtx.conn;
    expect(() => setPackEnabledFull(throwing, marisolPackId, false)).toThrow(/injected/);
    expect(
      mockCtx.conn.execute('SELECT enabled FROM packs WHERE id = ?', [marisolPackId]).rows!.item(0)
        .enabled,
    ).toBe(1); // rolled back whole
    expect(dustyChunk()).toContain('restock the glowsticks pile');

    // REAL MUTE: chunk-content assertions, deliberately NO manual FTS
    // rebuild — the rematerialized content is the source of truth here.
    setPackEnabledFull(mockCtx.conn, marisolPackId, false);
    expect(dustyChunk()).not.toContain('restock the glowsticks pile');

    setPackEnabledFull(mockCtx.conn, marisolPackId, true);
    expect(dustyChunk()).toContain('restock the glowsticks pile');
  });
});

const junkEnvelope = (w: string) => ({
  camp_id: '', writer_id: w, author_name: w, key_id: 'x', seq: 1,
  payload_hash: 'x', posts: [], notes: [], format: 2, tag: 'nottheseal',
});
const bundleOf = (campId: string, writers: string[]) =>
  JSON.stringify({
    kind: 'playapal-camp-board',
    format: 2,
    camp_id: campId,
    envelopes: writers.map(junkEnvelope),
  });

describe('campmate closure boundary (audit round 6 coverage)', () => {

  test('63 stored + 1 fresh passes the cap; +2 fresh refuses; own echo never counts', () => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    const campId = String(
      mockCtx.conn.execute("SELECT value FROM settings WHERE key = 'camp_passphrase'").rows!.item(0)
        .value && JSON.parse(exportCampBundle(mockCtx.conn)).camp_id,
    );
    const seedKnown = (i: number) =>
      mockCtx.conn.execute(
        'INSERT INTO camp_writers (camp_id, writer_id, seq, payload_hash, envelope_json, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
        [campId, `w${String(i).padStart(6, '0')}`, `h${i}`, '{}', new Date().toISOString()],
      );
    Array.from({ length: 62 }).forEach((_, i) => seedKnown(i));
    // 62 stored + 1 fresh = 63 total: passes the cap, dies later at the seal
    expect(() =>
      installCampBundle(mockCtx.conn, bundleOf(campId, ['freshaaaa'])),
    ).toThrow(/(damaged|reject|seal|match|verify)/i);
    // 62 stored + 2 fresh = 64: the CAP refuses, before any seal work
    expect(() =>
      installCampBundle(mockCtx.conn, bundleOf(campId, ['freshaaaa', 'freshbbbb'])),
    ).toThrow(/as many campmate boards/);
    // own echo among 2: only 1 is genuinely fresh -> cap passes
    expect(() =>
      installCampBundle(mockCtx.conn, bundleOf(campId, ['writeraaaa', 'freshaaaa'])),
    ).not.toThrow(/as many campmate boards/);
    // EXACT 63 known + own-only echo: nothing fresh -> cap passes
    seedKnown(62); // 63rd stored foreign writer
    expect(() =>
      installCampBundle(mockCtx.conn, bundleOf(campId, ['writeraaaa'])),
    ).not.toThrow(/as many campmate boards/);
    // ...and at exactly 63 known, ONE genuinely fresh writer refuses
    expect(() =>
      installCampBundle(mockCtx.conn, bundleOf(campId, ['freshcccc'])),
    ).toThrow(/as many campmate boards/);
  });

  test('exact envelope-count edge: 64 admits (dies later at the seal), 65 refuses at the door', () => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    const campId = JSON.parse(exportCampBundle(mockCtx.conn)).camp_id as string;
    const writers64 = Array.from({ length: 63 }, (_, i) => `fresh${String(i).padStart(4, '0')}`).concat([
      'writeraaaa',
    ]);
    expect(() => installCampBundle(mockCtx.conn, bundleOf(campId, writers64))).not.toThrow(
      /more campmate boards than one camp/,
    );
    const writers65 = writers64.concat(['freshxxxx']);
    expect(() => installCampBundle(mockCtx.conn, bundleOf(campId, writers65))).toThrow(
      /more campmate boards than one camp/,
    );
  });
});

describe('incarnation rotation migrates board-section hides (audit round 6 coverage)', () => {
  test('a hidden section key follows the writer rename on rotation', () => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    upsertCampPost(mockCtx.conn, { type: 'offer', text: 'Sunrise glowsticks giveaway.' });
    refts();
    const chunk = boardChunks()[0];
    hideItem(mockCtx.conn, {
      kind: 'passage',
      key: `${chunk.pack_id}:${chunk.id}`,
      label: 'sunrise section',
    });
    const beforeKey = String(
      mockCtx.conn.execute("SELECT key FROM hidden_items WHERE kind = 'passage'").rows!.item(0).key,
    );
    expect(beforeKey).toContain('writeraaaa');

    // a stored token that MISMATCHES the file token is what rotates
    mockCtx.conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'camp_incarnation',
      'storedtoken',
    ]);
    const out = reconcileWriterIncarnation(mockCtx.conn, 'not-the-stored-token');
    expect(out.rotated).toBe(true);
    const afterKey = String(
      mockCtx.conn.execute("SELECT key FROM hidden_items WHERE kind = 'passage'").rows!.item(0).key,
    );
    expect(afterKey).not.toContain('writeraaaa');
    expect(afterKey).toMatch(/^boardsec:camp-board-/);
    // the rotated board rematerialized under the NEW pack — a live chunk
    // must exist carrying exactly the migrated key, or the hide binds air
    const live = mockCtx.conn.execute(
      'SELECT COUNT(*) AS n FROM doc_chunks WHERE note_key = ?',
      [afterKey],
    );
    expect(live.rows!.item(0).n).toBe(1);
    refts();
    const res = searchDocs({ query: 'sunrise glowsticks' }, 2);
    expect(res.results.filter(r => r.pack_id.startsWith('camp-board-'))).toHaveLength(0);
  });
});

describe('full toggle path owns its FTS reindex (audit round 6e)', () => {
  test('mute then unmute through setPackEnabledFull is search-correct with NO test-side rebuild', () => {
    mockCtx.conn = makeConn('writeraaaa');
    saveCampProfile(mockCtx.conn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    upsertCampPost(mockCtx.conn, { type: 'offer', text: 'Glowsticks at the dome.' });
    const b = makeConn('writerbbbb');
    saveCampProfile(b, { authorName: 'Marisol', passphrase: 'dusty hippos 2026' });
    upsertCampPost(b, { type: 'offer', text: 'Marisol glowsticks trade table.' });
    installCampBundle(mockCtx.conn, exportCampBundle(b));
    refts(); // baseline index only — everything AFTER this is the path's job
    const marisolPack = searchDocs({ query: 'glowsticks' }, 3).results.find(r =>
      r.pack_id.endsWith('writerbbbb'),
    )!;
    expect(marisolPack).toBeTruthy();

    setPackEnabledFull(mockCtx.conn, marisolPack.pack_id, false);
    const muted = searchDocs({ query: 'glowsticks' }, 3);
    expect(muted.results.some(r => r.pack_id === marisolPack.pack_id)).toBe(false);
    // FTS honesty probe: Dusty's chunk must still be FINDABLE through the
    // index the path itself rebuilt (a stale index would ghost or miss)
    expect(muted.results.some(r => r.pack_id.endsWith('writeraaaa'))).toBe(true);
    expect(muted.strategy).toMatch(/fts/); // served by FTS, not the LIKE fallback

    setPackEnabledFull(mockCtx.conn, marisolPack.pack_id, true);
    const restored = searchDocs({ query: 'glowsticks' }, 3);
    expect(restored.results.some(r => r.pack_id === marisolPack.pack_id)).toBe(true);
    expect(restored.strategy).toMatch(/fts/);
  });
});

describe('board row callback wiring (audit round 6e)', () => {
  const { boardRowOnChanged } = require('../src/screens/boardRowOnChanged');
  const campScreenSource = require('fs').readFileSync(
    'src/screens/CampScreen.tsx',
    'utf8',
  );

  test('boardRowOnChanged refreshes BOTH the pack rows and the rendered board', () => {
    const calls: string[] = [];
    const handler = boardRowOnChanged(
      () => calls.push('packs'),
      () => calls.push('board'),
    );
    handler();
    expect(calls).toEqual(['packs', 'board']);
  });

  test('the boardPacks row BINDS the helper to onChanged (AST assertion)', () => {
    // Structural, not lexical (audit round 6e: the helper expression hidden
    // in a harmless prop fooled a source-window check): parse CampScreen,
    // find JSX under the boardPacks.map callback, and assert its onChanged
    // attribute VALUE is a call to boardRowOnChanged.
    const parser = require('@babel/parser');
    const ast = parser.parse(campScreenSource, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });
    const found: string[] = [];
    const isBoardMapCall = (n: Record<string, unknown>): boolean =>
      n.type === 'CallExpression' &&
      JSON.stringify(n.callee).includes('"name":"boardPacks"') &&
      JSON.stringify(n.callee).includes('"name":"map"');
    const walk = (node: unknown, inBoardMap: boolean): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      const n = node as Record<string, unknown> & { type?: string };
      const hereBoardMap = inBoardMap || isBoardMapCall(n);
      if (hereBoardMap && n.type === 'JSXAttribute') {
        const attr = n as unknown as {
          name: { name: string };
          value?: { expression?: { type: string; callee?: { name?: string } } };
        };
        if (attr.name?.name === 'onChanged') {
          const expr = attr.value?.expression;
          found.push(
            expr?.type === 'CallExpression' && expr.callee?.name === 'boardRowOnChanged'
              ? 'boardRowOnChanged-call'
              : `other:${expr?.type ?? 'none'}`,
          );
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'range') {
          continue;
        }
        const v = (n as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          v.forEach(c => walk(c, hereBoardMap));
        } else if (v && typeof v === 'object') {
          walk(v, hereBoardMap);
        }
      }
    };
    walk(ast, false);
    expect(found).toEqual(['boardRowOnChanged-call']);
  });
});
