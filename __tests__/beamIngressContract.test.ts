/**
 * Beam ingress contract guard (ds4pro lane — docs/BEAM-INGRESS-CONTRACT.md
 * §1, §5, §7). A node test that parses the two file-type declaration surfaces
 * — android/app/src/main/AndroidManifest.xml and ios/PlayaPal/Info.plist —
 * and asserts the contract's filters are present and the pre-existing friend
 * filters are unchanged. Its whole job is to turn a LATER edit that breaks
 * either declaration into a red suite, so it is written against the SPEC, not
 * against what is checked in today.
 *
 * Cross-lane note: the Android beam filters are pug-claude-5's lane (§8 owns
 * android/**) and the iOS UTI/document-types are codex's (§8 owns ios/**).
 * Until those land this guard is RED by design — that redness IS the proof it
 * bites. It goes green the moment the native declarations ship; from then on,
 * any drift (a mimeType dropped, application/json accidentally claimed for
 * VIEW, a pathPattern added, the /f filter shadowed) fails here first.
 *
 * Parsing is hand-rolled string/regex over the exact shapes the contract
 * mandates — the same no-dependency discipline as releaseIdentity.test.ts. No
 * XML parser, no new dependency, nothing in package.json.
 */

export {}; // module scope: top-level consts must not collide with other suites

const fs: any = require('fs');
const path: any = require('path');

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };

const ROOT = path.resolve(__dirname, '..');

// Env overrides let a mutation-kill proof point the guard at an injected
// copy of the manifest/plist without editing the real (other-lane-owned)
// files. Default is the real paths; the shipped guard always reads those.
const MANIFEST =
  process.env.BEAM_CONTRACT_MANIFEST || 'android/app/src/main/AndroidManifest.xml';
const PLIST = process.env.BEAM_CONTRACT_PLIST || 'ios/PlayaPal/Info.plist';

const read = (p: string): string =>
  fs.readFileSync(path.join(ROOT, p), 'utf8');

const all = (src: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    out.push(m[1]);
  }
  return out;
};

/** One `<intent-filter>…</intent-filter>` body (attributes stripped). */
const filterBlocks = (xml: string): string[] =>
  all(xml, /<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g);

const mimeTypesOf = (block: string): string[] =>
  all(block, /android:mimeType="([^"]+)"/g);

describe('Android beam ingress filters (contract §1)', () => {
  const manifest = read(MANIFEST);
  const blocks = filterBlocks(manifest);

  const withAction = (action: string): string[] =>
    blocks.filter(b => b.includes(`android.intent.action.${action}`));

  const viewMimes = withAction('VIEW').flatMap(mimeTypesOf);
  const sendMimes = withAction('SEND').flatMap(mimeTypesOf);

  test('ACTION_VIEW claims our MIME AND octet-stream, never application/json', () => {
    expect(viewMimes).toEqual(
      expect.arrayContaining([
        'application/vnd.playapal.beam+json',
        'application/octet-stream',
      ]),
    );
    // RULING §1: application/json for VIEW would be "every JSON on the phone".
    expect(viewMimes).not.toContain('application/json');
  });

  test('ACTION_SEND claims all three (share sheet over-offering is the norm)', () => {
    expect(sendMimes).toEqual(
      expect.arrayContaining([
        'application/vnd.playapal.beam+json',
        'application/octet-stream',
        'application/json',
      ]),
    );
  });

  test('no pathPattern anywhere (it matches provider paths, not display names)', () => {
    expect(manifest).not.toMatch(/android:pathPattern/);
  });

  test('the friend-card deep links are preserved byte-for-byte', () => {
    expect(manifest).toMatch(
      // EXACT path, not a prefix. pathPrefix="/p" also claimed /privacy —
      // live, and the Play Console privacy-policy URL — so all three filters
      // moved to android:path. The fragment is not part of Uri.getPath(), so
      // #frag payloads still match. Do not put the prefix back.
      /<data android:scheme="https" android:host="playapal\.lol" android:path="\/f" \/>/,
    );
    expect(manifest).toMatch(
      /<data android:scheme="https" android:host="www\.playapal\.lol" android:path="\/f" \/>/,
    );
    expect(manifest).toMatch(
      /<data android:scheme="playapal" android:host="friend" \/>/,
    );
  });

  test('the beam deep links get sibling filters (§1 / §5)', () => {
    expect(manifest).toMatch(/android:path="\/b"/);
    expect(manifest).toMatch(
      /<data android:scheme="playapal" android:host="beam" \/>/,
    );
  });
});

describe('iOS beam file type (contract §1, codex lane)', () => {
  const plist = read(PLIST);

  test('declares the UTI and its tags', () => {
    expect(plist).toContain('UTExportedTypeDeclarations');
    expect(plist).toContain('com.playapal.beam');
    expect(plist).toContain('public.json'); // conforms to public.json
    expect(plist).toContain('public.filename-extension');
    expect(plist).toContain('public.mime-type');
    expect(plist).toContain('application/vnd.playapal.beam+json');
  });

  test('registers the document type as a Viewer/Owner', () => {
    expect(plist).toContain('CFBundleDocumentTypes');
    expect(plist).toContain('LSItemContentTypes');
    expect(plist).toContain('<string>Viewer</string>');
    expect(plist).toContain('<string>Owner</string>');
  });
});
