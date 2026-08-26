/**
 * The PICKER/JS ingress seam enforces the byte cap ITSELF (codex P1.3 +
 * reverifies 2-5): installPayloads refuses an oversize camp-shaped payload
 * with the size words BEFORE any camp parsing or installing runs. The
 * downstream installCampBundle gate says the same words, so words alone
 * cannot pin the seam — the oracle here is the SPY: on the oversize case
 * neither parseCampBundle nor installCampBundle may ever be invoked, which
 * a seam revert cannot fake. A real signed beam through the same seam
 * proves the gate admits what it should.
 */

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: { allFiles: '*/*' },
}));
jest.mock('@dr.pogodin/react-native-fs', () => ({
  readFile: jest.fn(),
}));

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  rebuildFtsIndexes: jest.fn(),
}));
jest.mock('../src/log/chatLog', () => ({ logSystemNote: jest.fn() }));
jest.mock('../src/facts/factGraph', () => ({ refreshFactGraphSafe: jest.fn(() => ({})) }));
// Pass-through spies: real behavior, observable invocation — the seam's
// oracle is "never called", which a reverted seam cannot satisfy.
jest.mock('../src/camp/campBoard', () => {
  const actual = jest.requireActual('../src/camp/campBoard');
  return {
    ...actual,
    parseCampBundle: jest.fn(actual.parseCampBundle),
    installCampBundle: jest.fn(actual.installCampBundle),
  };
});

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import { installPayloads } from '../src/packs/importPack';
import {
  CAMP_WRITER_ID_KEY,
  MAX_BEAM_BYTES,
  exportCampBundle,
  installCampBundle,
  parseCampBundle,
  saveCampProfile,
} from '../src/camp/campBoard';

const { DatabaseSync } = require('node:sqlite');

function makePhone(writerId = 'writerseam') {
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
  } as any;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  return conn;
}

const campCounts = () =>
  (['camp_posts', 'camp_notes', 'camp_writers'] as const).map(
    t => mockConn.execute(`SELECT COUNT(*) AS n FROM ${t}`).rows!.item(0).n as number,
  );

describe('installPayloads: the byte cap at the seam', () => {
  test('camp-shaped content under the cap in UNITS but over it in BYTES never installs', () => {
    mockConn = makePhone();
    // '中' = 1 UTF-16 unit, 3 UTF-8 bytes: ~2M units (fits), ~6MB bytes (busts)
    const wide = '中'.repeat(2 * 1024 * 1024);
    const fake = `{"kind":"playapal-camp-board","format":1,"camp_id":"c","envelopes":[],"pad":"${wide}"}`;
    expect(fake.length).toBeLessThanOrEqual(MAX_BEAM_BYTES); // units admit it
    const before = campCounts();
    // failure ATTRIBUTION is part of the contract (codex reverify 3): the
    // refusal must say what actually happened — the beam is too big — not
    // fall through to the generic-pack path's "not a pack" words
    (parseCampBundle as jest.Mock).mockClear();
    (installCampBundle as jest.Mock).mockClear();
    expect(() =>
      installPayloads([{ name: 'camp-beam.playapal', content: fake }], 'android-view'),
    ).toThrow(/far larger than any camp board/);
    // THE SEAM ORACLE (codex tail reverify 1): the downstream camp gate
    // says the same words, so the proof the SEAM refused is that no camp
    // machinery ever ran — a seam revert cannot keep these at zero.
    expect(parseCampBundle).not.toHaveBeenCalled();
    expect(installCampBundle).not.toHaveBeenCalled();
    expect(campCounts()).toEqual(before);
  });

  test('the sniff window is BOUNDED at 256 chars — both mutations red (codex boundary oracle)', () => {
    mockConn = makePhone();
    const wide = '中'.repeat(2 * 1024 * 1024);
    // kind marker BEYOND the 256-char window: the bounded sniff must NOT
    // attribute this as a camp beam — it falls to the generic-pack path
    // with different words and zero camp machinery. WIDENING the sniff to
    // scan the whole oversized payload flips this to /far larger/ → red.
    const pad = 'P'.repeat(300);
    const beyond = `{"pad":"${pad}","kind":"playapal-camp-board","wide":"${wide}"}`;
    (installCampBundle as jest.Mock).mockClear();
    expect(() =>
      installPayloads([{ name: 'x.playapal', content: beyond }], 'android-view'),
    ).toThrow();
    expect(() =>
      installPayloads([{ name: 'x.playapal', content: beyond }], 'android-view'),
    ).not.toThrow(/far larger/);
    expect(installCampBundle).not.toHaveBeenCalled();
    // kind marker near the END of the window (offset ~200): NARROWING the
    // sniff drastically misses it and loses the honest attribution → red.
    const pad2 = 'P'.repeat(180);
    const inside = `{"pad":"${pad2}","kind":"playapal-camp-board","wide":"${wide}"}`;
    expect(() =>
      installPayloads([{ name: 'x.playapal', content: inside }], 'android-view'),
    ).toThrow(/far larger/);
  });

  test('a REAL signed beam through the same seam installs (the gate admits what it should)', () => {
    // author phone A: identity + one post, exported for real
    mockConn = makePhone('writerdusty');
    saveCampProfile(mockConn, { authorName: 'Dusty', passphrase: 'dusty hippos 2026' });
    const { upsertCampPost } = jest.requireActual('../src/camp/campBoard');
    upsertCampPost(mockConn, { type: 'offer', text: 'cold brew at 7:32 & C' });
    const beam = exportCampBundle(mockConn);
    // receiver phone B, same passphrase, imports THROUGH THE SEAM
    mockConn = makePhone('writermaris');
    saveCampProfile(mockConn, { authorName: 'Marisol', passphrase: 'dusty hippos 2026' });
    (installCampBundle as jest.Mock).mockClear();
    const result = installPayloads(
      [{ name: 'camp-beam.playapal', content: beam }],
      'picker',
    );
    expect(installCampBundle).toHaveBeenCalledTimes(1);
    expect(result.items).toBeGreaterThan(0);
    expect(campCounts()[0]).toBeGreaterThan(0); // camp_posts landed
  });

  test('the same shape under BOTH measures reaches the camp path (the filter is not simply dead)', () => {
    mockConn = makePhone();
    const small = '{"kind":"playapal-camp-board","format":1,"camp_id":"c","envelopes":[]}';
    // no passphrase set on this phone → the CAMP path's own honest refusal,
    // which proves the filter ADMITTED it (a dead filter would have sent it
    // to the generic-pack path with a different error)
    expect(() =>
      installPayloads([{ name: 'camp-beam.playapal', content: small }], 'android-view'),
    ).toThrow(/passphrase/);
  });
});
