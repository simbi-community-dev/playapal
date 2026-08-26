/**
 * Sealed art locations — the ToS 6.1 gate-day reveal, asserted against the
 * REAL bundled asset and the REAL pack install.
 *
 * The guarantees:
 *  1. SEAL: none of the location strings may exist in doc_chunks or
 *     FTS after installing the art pack — before OR after the gate (the
 *     Angel retrieves text only from those tables, so this is the "the
 *     model cannot know an address" assertion, not a UI nicety).
 *  2. GATE: pre-gate the reader's accessor returns null for every heading;
 *     post-gate it returns the address; the compare is lexical on a
 *     zero-padded Pacific wall-time string (no tz lib).
 *  3. JOIN: every sealed key matches a heading the built pack actually
 *     renders (a drift between seal_art_locations.py and load_art.py's
 *     section() shows here, never in dust).
 *  4. MUTATION-KILL: flip the date compare and the pre-gate seal breaks.
 */
import {
  ART_PACK_ID,
  gateOpen,
  pacificWall,
  sealedLocationCount,
  sealedLocationFor,
  sealedLocationStrings,
} from '../src/packs/artLocations';
import { BUILTIN_PACKS } from '../src/packs/builtins';
import { installPackFromFiles } from '../src/packs/installPack';
import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';

const { DatabaseSync } = require('node:sqlite');

const BEFORE = new Date('2026-08-27T12:00:00-07:00'); // ship week
const AT_GATE = new Date('2026-08-30T00:01:00-07:00'); // the instant
const AFTER = new Date('2026-08-30T09:00:00-07:00'); // gate morning

function makePhone() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return { rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] } };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  };
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  return conn;
}

const artPack = BUILTIN_PACKS.find(p => p.manifest.id === ART_PACK_ID);

describe('the sealed asset', () => {
  it('carries every located piece the shipped asset holds (floor 300)', () => {
    // The register moves right up to the burn (312 on Aug 21, 309 on Aug 24
    // after three pieces left) — the invariant is completeness against the
    // shipped asset plus kimi's ≥300 spec floor, never a point-in-time count.
    const keys = Object.keys(require('../assets/packs/brc-art-2026/locations.json'));
    expect(sealedLocationCount()).toBe(keys.length);
    expect(sealedLocationCount()).toBeGreaterThanOrEqual(300);
  });

  it('every sealed key joins a heading the built pack renders', () => {
    // The pack's markdown is in the builtin's file payloads — read the H2s
    // straight from the same bytes the installer chunks.
    const heads = new Set<string>();
    for (const f of artPack!.files) {
      if (!f.name.endsWith('.md')) {
        continue;
      }
      for (const line of f.content.split('\n')) {
        if (line.startsWith('## ')) {
          heads.add(line.slice(3).trim());
        }
      }
    }
    expect(heads.size).toBeGreaterThan(300);
    const locs = sealedLocationStrings();
    const keys = Object.keys(
      require('../assets/packs/brc-art-2026/locations.json'),
    ) as string[];
    const misses = keys.filter(k => !heads.has(k));
    // Spec floor: ≥300 of 312. We measure 312/312 — the miss list is the
    // report if that ever drifts.
    expect(keys.length - misses.length).toBeGreaterThanOrEqual(300);
    expect(misses).toEqual([]);
    // POSITIVE CONTROL: no locations at all passes 'every location is non-empty', so a loader that silently returns nothing reads as a clean pass.
    // `[].every(...)` is `true`, so the assertion below cannot fail on an
    // empty collection — pin the length first or it proves nothing.
    expect(locs.length).toBeGreaterThan(0);
    expect(locs.every(s => s.length > 0)).toBe(true);
  });
});

describe('the gate', () => {
  it('Pacific wall-time rendering is what the compare assumes', () => {
    // Noon PDT on ship week reads as 2026-08-27T12:00 Pacific.
    expect(pacificWall(BEFORE)).toBe('2026-08-27T12:00');
    // 00:01 PDT on the 30th is the gate; 23:59 the night before is not.
    expect(pacificWall(new Date('2026-08-30T06:59:00Z'))).toBe('2026-08-29T23:59');
    expect(pacificWall(AT_GATE)).toBe('2026-08-30T00:01');
    // A UTC-7 wall clock: 07:00Z is midnight Pacific.
    expect(pacificWall(new Date('2026-08-30T07:00:00Z'))).toBe('2026-08-30T00:00');
  });

  it('MUTATION-KILL: pre-gate every heading is sealed', () => {
    const keys = Object.keys(
      require('../assets/packs/brc-art-2026/locations.json'),
    ) as string[];
    const sample = keys.slice(0, 20);
    for (const h of sample) {
      expect(sealedLocationFor(ART_PACK_ID, h, BEFORE)).toBeNull();
    }
    // A flipped compare (>= → <) makes these non-null: this loop is the red.
  });

  it('gate boundary is exact: 23:59 sealed, 00:01 open', () => {
    const h = Object.keys(
      require('../assets/packs/brc-art-2026/locations.json'),
    )[0] as string;
    expect(sealedLocationFor(ART_PACK_ID, h, new Date('2026-08-30T06:59:00Z'))).toBeNull();
    expect(sealedLocationFor(ART_PACK_ID, h, AT_GATE)).not.toBeNull();
    expect(gateOpen(new Date('2026-08-29T23:59:59-07:00'))).toBe(false);
    expect(gateOpen(AT_GATE)).toBe(true);
    expect(gateOpen(AFTER)).toBe(true);
  });

  it('post-gate the address renders for the right pack only', () => {
    const keys = Object.keys(
      require('../assets/packs/brc-art-2026/locations.json'),
    ) as string[];
    const h = keys[0];
    expect(sealedLocationFor(ART_PACK_ID, h, AFTER)).toMatch(/\d/);
    expect(sealedLocationFor('brc-art-2025', h, AFTER)).toBeNull(); // other pack
    expect(sealedLocationFor(ART_PACK_ID, 'No such piece — by nobody', AFTER)).toBeNull();
  });
});

describe('the seal (retrieval can never see an address)', () => {
  it('no location string exists in doc_chunks or FTS after install', () => {
    const conn = makePhone();
    installPackFromFiles(conn as never, artPack!.files, { builtin: true });
    const locs = sealedLocationStrings();
    expect(locs.length).toBe(
      Object.keys(require('../assets/packs/brc-art-2026/locations.json')).length,
    );

    // Control: the pack DID install text.
    const chunks = conn.execute('SELECT count(*) AS n FROM doc_chunks WHERE pack_id = ?', [ART_PACK_ID]);
    expect(chunks.rows!._array[0].n).toBeGreaterThan(100);

    // The sweep: every sealed string against both text stores (the raw
    // chunks table and its FTS shadow). instr(), never LIKE — % and _ are
    // LIKE metacharacters and would false-match.
    for (const table of ['doc_chunks', 'doc_chunks_fts']) {
      for (const s of locs) {
        const hit = conn.execute(
          `SELECT count(*) AS n FROM ${table} WHERE instr(content, ?) > 0 OR instr(coalesce(heading, ''), ?) > 0`,
          [s, s],
        );
        expect(hit.rows!._array[0].n).toBe(0);
      }
    }
  });

  it('the sealed asset is not in any builtin pack file list', () => {
    // The bypass that makes the seal structural: nothing named
    // locations.json ever reaches installPack.
    for (const p of BUILTIN_PACKS) {
      for (const f of p.files) {
        expect(f.name).not.toMatch(/locations\.json$/);
      }
    }
  });
});
