/**
 * SEMANTIC ARM fixture tests — the fused vector + keyword composition.
 * Both controls per the commission:
 *   - a PARAPHRASE query that must hit via vectors (no shared keywords);
 *   - an EXACT-NAME query that must NOT be hijacked by a semantically-similar
 *     wrong person (the 437-templated-bio tail from the research).
 * Plus the inert-degrade controls (no embedder / no vectors / model
 * mismatch) and the install-time stale-vector loud failure.
 *
 * Embeddings here are SYNTHETIC unit vectors planted so the fixture's cosine
 * relationships are exact — the embedder is injected, never native.
 */

import { BASE_TABLES_SQL, VEC_TABLE_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { searchDocs, searchDocsSemantic } from '../src/docs/searchDocs';
import {
  setQueryEmbedder,
  fuseRanked,
  EMBEDDER_MODEL_ID,
} from '../src/docs/vectorSearch';

// Jest's module registry intercepts require('node:sqlite') however it is
// spelled; process.getBuiltinModule is the un-interceptable path — but the
// jest worker's exec argv still needs --experimental-sqlite on node 22
// (unlike node 23+, where it is unflagged). Passing it via the runner's
// execArgv keeps every OTHER suite's plain require('node:sqlite') working
// exactly as before. allowExtension:true is required for the sqlite-vec
// binary (the ruling's parity contract item 3: same DDL, same queries,
// same extension code, different host).
declare const process: { getBuiltinModule(m: string): any };
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const sqliteVec = require('sqlite-vec');

function makeConn() {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  sqliteVec.load(db);
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as any[]));
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
      }
      stmt.run(...(params as any[]));
      return { rows: undefined };
    },
    loadExtension(path: string) {
      db.loadExtension(path);
    },
  };
}

/** A unit vector with weight concentrated on one basis axis, plus a small
 * random-noise floor so distinct topics get a realistic weak cosine (~0.1,
 * like unrelated 384-dim embeddings) without inflating cross-axis scores. */
function basisVec(axis: number, dim = 384, noise = 0.02): number[] {
  const v = new Array(dim).fill(0).map((_, i) => ((i * 2654435761) % 97) / 97 * noise);
  v[axis] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

const AX = {
  welding: 3,
  metalwork: 3, // paraphrase twin of welding — same axis
  marina: 10,
  marinaBio: 3, // the Marina bio's topic IS metalwork — a paraphrase query
  // on the metalwork axis must retrieve it (the must-hit control)
  wrongPerson: 10, // the templated-bio twin lives on a NEAR-BUT-DIFFERENT
  // axis: close enough to be tempting, far enough that the exact-name
  // keyword hit must still win (the must-not-hijack control)
  water: 20,
};

const FIXTURE_MD = [
  '# Bios',
  '',
  '## Who is Marina?',
  '',
  'Marina welds the camp structures and teaches metalwork each year.',
  '',
  '## Who is Martina?',
  '',
  'Martina welds too, and also teaches metalwork each year.',
  '',
  '## Water',
  '',
  'Bring 1.5 gallons of water per person per day.',
].join('\n');

/** Deterministic synthetic vector per fixture chunk, keyed by content. */
function synthVec(content: string): number[] {
  if (content.includes('Marina welds')) {
    return basisVec(AX.marinaBio);
  }
  if (content.includes('Martina welds')) {
    // Same template, same words minus a name — the wrong-similar-person
    // tail: high cosine to a Marina-axis query (shared words) but a
    // distinct axis (she is a different person).
    const v = basisVec(AX.wrongPerson);
    v[AX.marina] = 0.7; // strong pull toward Marina's axis — tempting
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / n);
  }
  if (content.includes('gallons of water')) {
    return basisVec(AX.water);
  }
  return basisVec(1);
}

function fixtureFiles() {
  // The chunker splits on headings: our fixture yields 3 chunks. We embed
  // each chunk's content with the same deterministic function the pack
  // builder would use at build time.
  const { chunkDocument } = require('../src/packs/chunker');
  const chunks = chunkDocument(FIXTURE_MD);
  const vectors: Record<string, number[]> = {};
  const perSource = new Map<string, number>();
  for (const c of chunks) {
    const idx = perSource.get('bios.md') ?? 0;
    perSource.set('bios.md', idx + 1);
    vectors[`bios.md:${idx}`] = synthVec(c.content);
  }
  return [
    {
      name: 'pack.json',
      content: JSON.stringify({
        id: 'fixture-pack',
        name: 'Fixture Pack',
        version: 1,
      }),
    },
    { name: 'bios.md', content: FIXTURE_MD },
    {
      name: 'embeddings.json',
      content: JSON.stringify({
        model: EMBEDDER_MODEL_ID,
        dim: 384,
        vectors,
      }),
    },
  ];
}

let mockConn: ReturnType<typeof makeConn>;

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  isFtsAvailable: () => false, // LIKE rungs only — keyword arm still works
  isVecAvailable: () => true, // the shim loads the real sqlite-vec extension
}));

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, VEC_TABLE_SQL]) {
    mockConn.execute(sql);
  }
  installPackFromFiles(mockConn as any, fixtureFiles());
});

afterEach(() => setQueryEmbedder(null));

describe('install-time vector handling', () => {
  it('installs one vector row per embedded chunk', () => {
    const res = mockConn.execute(
      'SELECT COUNT(*) AS n FROM doc_chunk_vectors_meta WHERE model = ?',
      [EMBEDDER_MODEL_ID],
    );
    expect(res.rows!._array[0].n).toBe(3);
  });

  it('fails loudly on a stale vector build (orphan key)', () => {
    const files = fixtureFiles();
    const emb = JSON.parse(files[2].content);
    emb.vectors['bios.md:99'] = basisVec(5);
    files[2].content = JSON.stringify(emb);
    const conn = makeConn();
    for (const sql of BASE_TABLES_SQL) {
      conn.execute(sql);
    }
    expect(() => installPackFromFiles(conn as any, files)).toThrow(
      /stale vector build/,
    );
  });
});

describe('RRF fusion', () => {
  it('fuseRanked keeps keyword rows in exact order and appends vector-only', () => {
    const fused = fuseRanked([7, 9], [9, 12, 15], 4);
    expect(fused.slice(0, 2)).toEqual([7, 9]); // keyword immune to displacement
    expect(fused).toContain(12); // vector-only fills remaining slots
  });

  it('sqlite-vec C-side cosine: near beats far (the extension itself)', () => {
    // The ruling's parity contract: the REAL extension's distance function,
    // not a JS re-implementation. Same axis ≈ distance 0; far axis > near.
    const near = mockConn.execute(
      `SELECT vec_distance_cosine(?, ?) AS d`,
      [JSON.stringify(basisVec(3)), JSON.stringify(basisVec(3))],
    );
    const far = mockConn.execute(
      `SELECT vec_distance_cosine(?, ?) AS d`,
      [JSON.stringify(basisVec(3)), JSON.stringify(basisVec(20))],
    );
    expect(near.rows!._array[0].d).toBeLessThan(0.05);
    expect(far.rows!._array[0].d).toBeGreaterThan(0.5);
  });
});

describe('the two commissioned controls', () => {
  it('PARAPHRASE must-hit: a no-shared-keyword query surfaces the chunk via vectors', async () => {
    // Query axis = welding/metalwork twin; the fixture chunks' keywords
    // don't share the query's surface form (we ask with a synonym axis).
    setQueryEmbedder(async () => basisVec(AX.metalwork));
    const out = await searchDocsSemantic({ query: 'arc joining practice' });
    const texts = out.results.map(r => r.content).join('\n');
    expect(texts).toMatch(/welds/);
  });

  it('EXACT-NAME must-not-hijack: keyword winner keeps its slot over the similar wrong person', async () => {
    // "Marina" as a keyword hits the Marina chunk via the LIKE ladder.
    // The vector arm (Marina-axis query) ranks Martina nearly as high —
    // the fused result MUST keep Marina's chunk ahead of Martina's.
    setQueryEmbedder(async () => basisVec(AX.marina));
    const out = await searchDocsSemantic({ query: 'Marina' });
    expect(out.results.length).toBeGreaterThan(0);
    const marinaIdx = out.results.findIndex(r => r.content.includes('Marina welds'));
    const martinaIdx = out.results.findIndex(r => r.content.includes('Martina welds'));
    expect(marinaIdx).toBeGreaterThanOrEqual(0);
    if (martinaIdx >= 0) {
      expect(marinaIdx).toBeLessThan(martinaIdx);
    }
    // And the SYNC path (tool executor contract) is untouched by the arm:
    const sync = searchDocs({ query: 'Marina' });
    expect(sync.results[0]?.content).toContain('Marina welds');
  });
});

describe('graceful degrade (inert arm)', () => {
  it('no embedder -> identical to keyword-only', async () => {
    setQueryEmbedder(null);
    const out = await searchDocsSemantic({ query: 'Marina' });
    const sync = searchDocs({ query: 'Marina' });
    expect(out.results.map(r => r.id)).toEqual(sync.results.map(r => r.id));
  });

  it('embedder returning null (model load failed) -> keyword-only', async () => {
    setQueryEmbedder(async () => null);
    const out = await searchDocsSemantic({ query: 'Marina' });
    expect(out.results[0]?.content).toContain('Marina welds');
  });

  it('model-id mismatch: pack vectors under another model are inert', async () => {
    // Reinstall the fixture with vectors stamped to a DIFFERENT model id;
    // the arm must not fire even with an embedder loaded.
    const conn2 = makeConn();
    for (const sql of BASE_TABLES_SQL) {
      conn2.execute(sql);
    }
    const files = fixtureFiles();
    const emb = JSON.parse(files[2].content);
    emb.model = 'some-other-embedder';
    files[2].content = JSON.stringify(emb);
    installPackFromFiles(conn2 as any, files);
    const saved = mockConn;
    mockConn = conn2;
    try {
      setQueryEmbedder(async () => basisVec(AX.metalwork));
      const out = await searchDocsSemantic({ query: 'arc joining practice' });
      expect(out.results.map(r => r.content).join('\n')).not.toMatch(/welds/);
    } finally {
      mockConn = saved;
    }
  });
});
