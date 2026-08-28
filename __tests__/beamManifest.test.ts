/**
 * The Android manifest half of docs/BEAM-INGRESS-CONTRACT.md §1.
 *
 * Two things must stay true for a .playapal file to open in Playa Pal with
 * one tap, and one thing must NEVER become true:
 *   - VIEW claims our exact MIME AND application/octet-stream — a custom
 *     extension has no MimeTypeMap entry, so Quick Share / Downloads hand
 *     us octet-stream on a content:// URI with no filename in its path;
 *   - SEND claims the three MIMEs so "Share → Playa Pal" works from any app;
 *   - VIEW never claims application/json (every JSON on the phone would
 *     offer Playa Pal).
 * And the friend-card filters are preserved byte for byte — the families
 * must not shadow each other.
 */
const xml = require('fs').readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8') as string;

// No XML dependency in the app, and none added for a test: intent-filters
// are flat enough that a block split + attribute scan is exact.
type Filter = { actions: string[]; mimes: string[]; schemes: string[]; hosts: string[]; paths: string[] };
const attrs = (block: string, tag: string, name: string): string[] =>
  Array.from(block.matchAll(new RegExp(`<${tag}\\b[^>]*\\bandroid:${name}="([^"]+)"`, 'g'))).map(m => m[1]);
const filters: Filter[] = Array.from(
  xml.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g),
).map(m => ({
  actions: attrs(m[1], 'action', 'name'),
  mimes: attrs(m[1], 'data', 'mimeType'),
  schemes: attrs(m[1], 'data', 'scheme'),
  hosts: attrs(m[1], 'data', 'host'),
  // EXACT paths now, not prefixes: pathPrefix="/p" also claimed
  // /privacy, which is live and is the Play Console privacy-policy URL.
  // Harvesting only 'pathPrefix' after that switch would have left every
  // assertion below comparing an EMPTY array and passing — the silent kind.
  // Both are read so the suite cannot be fooled by either spelling.
  paths: [...attrs(m[1], 'data', 'path'), ...attrs(m[1], 'data', 'pathPrefix')],
}));
const view = filters.filter(f => f.actions.includes('android.intent.action.VIEW'));
const send = filters.filter(f => f.actions.includes('android.intent.action.SEND'));

describe('beam file intent filters', () => {
  test('VIEW claims the beam MIME and octet-stream on content:// and file://', () => {
    const f = view.find(v => v.mimes.includes('application/vnd.playapal.beam+json'));
    expect(f).toBeDefined();
    expect(f!.mimes).toContain('application/octet-stream');
    expect(f!.schemes).toEqual(expect.arrayContaining(['content', 'file']));
  });

  test('VIEW never claims application/json', () => {
    for (const f of view) {
      expect(f.mimes).not.toContain('application/json');
    }
  });

  test('SEND and SEND_MULTIPLE claim beam, octet-stream and json', () => {
    const f = send.find(s => s.mimes.includes('application/vnd.playapal.beam+json'));
    expect(f).toBeDefined();
    expect(f!.actions).toContain('android.intent.action.SEND_MULTIPLE');
    expect(f!.mimes).toEqual(
      expect.arrayContaining(['application/octet-stream', 'application/json']),
    );
  });

  test('the pod invite path is claimed, and it is EXACT', () => {
    // The pod filters shipped with no guard at all, so a manifest tidy-up
    // could delete them with a green suite.
    expect(
      view.some(v => v.hosts.includes('playapal.lol') && v.paths.includes('/p')),
    ).toBe(true);
    // And it must not be a PREFIX: /p as a prefix swallows /privacy, which is
    // live and is the store listing's privacy-policy URL.
    expect(xml).not.toMatch(/android:pathPrefix="\/p"/);
  });

  test('the harvester actually found paths — positive control', () => {
    // Guards the guard: if the attribute spelling changes again, every path
    // assertion in this file would compare empty arrays and pass. This one
    // fails instead.
    expect(view.flatMap(v => v.paths).length).toBeGreaterThanOrEqual(6);
  });

  test('no pathPattern anywhere (provider paths are not display names)', () => {
    expect(xml).not.toMatch(/pathPattern/);
  });
});

describe('the friend-card filters are untouched and the beam link is a sibling', () => {
  test('https://playapal.lol/f and playapal://friend still declared', () => {
    expect(view.some(v => v.hosts.includes('playapal.lol') && v.paths.includes('/f'))).toBe(true);
    expect(view.some(v => v.schemes.includes('playapal') && v.hosts.includes('friend'))).toBe(true);
  });
  test('https://playapal.lol/b and playapal://beam declared beside them', () => {
    expect(view.some(v => v.hosts.includes('playapal.lol') && v.paths.includes('/b'))).toBe(true);
    expect(view.some(v => v.schemes.includes('playapal') && v.hosts.includes('beam'))).toBe(true);
  });
  test('a link filter never carries a MIME (it would swallow files) and a file filter never carries a host', () => {
    for (const f of view) {
      if (f.hosts.length > 0) {
        expect(f.mimes).toEqual([]);
      }
      if (f.mimes.length > 0) {
        expect(f.hosts).toEqual([]);
      }
    }
  });
});

describe('the native ingress takes FILES only — links flow to RCTLinkingManager', () => {
  // A static guard on the Kotlin: the scan-path gate on the emulator found
  // that consume() swallowed https://playapal.lol/b (and would have swallowed
  // the shipped friend cards) because any VIEW with a data URI was copied as
  // a file. The gate proves it on device; this keeps the gate from being
  // removed in a refactor that never runs the device gate.
  const kt = require('fs').readFileSync(
    'android/app/src/main/java/com/playapal/BeamIngressModule.kt',
    'utf8',
  ) as string;
  const code = kt.replace(/^\s*\/\/.*$/gm, '');

  test('consume() returns false for any scheme other than content/file, before copying', () => {
    const gate = code.indexOf('scheme != "content" && scheme != "file"');
    const copy = code.indexOf('copyIn(app, uri');
    expect(gate).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(gate);
    expect(code.slice(gate, gate + 120)).toMatch(/return false/);
  });
});
