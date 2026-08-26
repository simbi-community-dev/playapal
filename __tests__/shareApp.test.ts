/**
 * Lane D — sharing the app itself is FIVE files agreeing (docs/FINAL-WEEK.md
 * "Lane D"): a Kotlin module, its ReactPackage, the registration in
 * MainApplication, a FileProvider root in res/xml, and the JS row that calls
 * it. Nothing in this chain is type-checked, and every link fails the same
 * silent way — the row is there, the tap does nothing, or Android throws
 * IllegalArgumentException("Failed to find configured root") in front of a
 * camper who cannot download the app any other way.
 *
 * No emulator is involved: this reads the real files and asserts the seams
 * line up. Each assertion below is written to DIE on a specific mutation,
 * named beside it.
 */

// Named readSource, not `read`: these suites are SCRIPTS, not modules, so a
// top-level const is global — `read` already belongs to releaseIdentity.test.ts
// and tsc rejects the redeclaration (TS2451) while jest happily runs both.
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/ShareAppModule.kt';
const PKG = 'android/app/src/main/java/com/playapal/ShareAppPackage.kt';
const APP = 'android/app/src/main/java/com/playapal/MainApplication.kt';
const PATHS = 'android/app/src/main/res/xml/file_paths.xml';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
// The JS half moved out of SettingsScreen into its own component (sharing
// audit, docs/SHARING-SURFACES.md §3.2) so it can ALSO mount on the Camp
// tab, where "someone is standing here with no app" actually happens. The
// chain is unchanged — this is still the fifth link, it just has one file
// of its own now, and the two mount points share it.
const ROW = 'src/screens/ShareAppRow.tsx';
const SETTINGS = 'src/screens/SettingsScreen.tsx';
const CAMP = 'src/screens/CampScreen.tsx';

describe('the app can hand over its own APK', () => {
  const kt = readSource(KT);
  const settings = readSource(ROW);

  test('the shared MIME is the one that offers "Install"', () => {
    // Mutation: any other MIME (application/octet-stream is the tempting one)
    // — the receiver gets a file their Files app will not install.
    const mime = /const val APK_MIME = "([^"]+)"/.exec(kt)?.[1];
    expect(mime).toBe('application/vnd.android.package-archive');
    expect(kt).toMatch(/type = APK_MIME/);
  });

  test('the native module name and the JS caller are the same string', () => {
    // Mutation: rename either side — NativeModules.ShareApp is undefined and
    // the row silently falls through to the "not available" alert.
    const name = /const val NAME = "([^"]+)"/.exec(kt)?.[1];
    expect(name).toBe('ShareApp');
    expect(kt).toMatch(/override fun getName\(\) = NAME/);
    expect(settings).toMatch(/NativeModules\.ShareApp\.describe\(\)/);
    expect(settings).toMatch(/NativeModules\.ShareApp/);
  });

  test('the package is registered in MainApplication', () => {
    // Mutation: drop the add() line — the module is compiled, shipped, and
    // never reachable from JS.
    const app = readSource(APP);
    expect(app).toMatch(/add\(ShareAppPackage\(\)\)/);
    const pkg = readSource(PKG);
    expect(pkg).toMatch(/listOf\(ShareAppModule\(reactContext\)\)/);
  });

  test('the copy target is a FileProvider root that actually exists', () => {
    // The load-bearing one. Mutation: change SHARE_DIR in Kotlin, or delete
    // the cache-path from file_paths.xml, and getUriForFile throws
    // IllegalArgumentException at share time — never at build time.
    const shareDir = /private const val SHARE_DIR = "([^"]+)"/.exec(kt)?.[1];
    expect(shareDir).toBeTruthy();
    // It must be the CACHE dir specifically: <cache-path> maps to getCacheDir().
    expect(kt).toMatch(
      new RegExp(`File\\(reactApplicationContext\\.cacheDir, SHARE_DIR\\)`),
    );
    const paths = readSource(PATHS);
    const roots = [...paths.matchAll(/<cache-path\s+name="([^"]+)"\s+path="([^"]*)"/g)];
    const covered = roots.some(
      m => m[2].replace(/\/+$/, '') === (shareDir as string).replace(/\/+$/, ''),
    );
    expect(covered).toBe(true);
  });

  test('the FileProvider authority matches the manifest', () => {
    // Mutation: hardcode an authority, or change the manifest's — same
    // IllegalArgumentException, same invisible-until-tapped failure.
    expect(kt).toMatch(/"\$\{ctx\.packageName\}\.fileprovider"/);
    expect(readSource(MANIFEST)).toMatch(
      /android:authorities="\$\{applicationId\}\.fileprovider"/,
    );
  });

  test('a partial copy can never be shared as a whole app', () => {
    // Mutation: write straight to the destination — an interrupted copy
    // leaves a truncated APK that installs as "App not installed" on playa.
    expect(kt).toMatch(/PART_SUFFIX/);
    expect(kt).toMatch(/part\.renameTo\(dest\)/);
    expect(kt).toMatch(/part\.delete\(\)/);
  });

  test('a same-size copy is reused instead of recopied', () => {
    // Mutation: always copy — a whole-APK pass per camper in line.
    expect(kt).toMatch(/dest\.exists\(\) && dest\.length\(\) == total/);
  });

  test('the progress event name agrees across the bridge', () => {
    // Mutation: rename on either side — the row sits at "Preparing… 0%" for
    // the whole copy, which reads as a hung app.
    const evt = /const val PROGRESS_EVENT = "([^"]+)"/.exec(kt)?.[1];
    const js = /const SHARE_APP_PROGRESS_EVENT = '([^']+)'/.exec(settings)?.[1];
    expect(evt).toBe('PlayaPalShareAppProgress');
    expect(js).toBe(evt);
  });

  test('a split install is refused by name, not shared broken', () => {
    // Mutation: share sourceDir regardless — the receiver installs a base
    // APK with no native libs for their ABI and gets a crash-on-launch.
    expect(kt).toMatch(/splitSourceDirs/);
    expect(kt).toMatch(/"ESPLIT"/);
  });
});

describe('the row tells the truth', () => {
  const settings = readSource(ROW);

  test('there is exactly one Share Playa Pal row', () => {
    expect(settings).toMatch(/accessibilityLabel="Share Playa Pal"/);
    expect(settings.match(/'Share Playa Pal'/g)?.length).toBe(1);
  });

  // LENGTH INVARIANT (opus, 2026-08-21): this row is the ONLY surface that
  // reaches the installing person AT install time — the share sheet cannot
  // carry text and the receiver has no signal for playapal.lol. Every
  // sentence below was bought with a real field incident; the copy cannot
  // be shortened by moving half of it to the website, only by dropping
  // something a camper needs while standing in dust.
  test('the row names BOTH install gates, in the words on the buttons', () => {
    // Measured on a real virgin install, P7 -> P9, 2026-08-21: a receiver who
    // has never had Playa Pal hits TWO dialogs, and the second is the one that
    // stops people. Gate 1 is "isn't allowed to install unknown apps from this
    // source" -> Settings -> "Allow from this source". Gate 2 is GOOGLE PLAY
    // PROTECT — "App blocked to protect your device … hasn't seen an app from
    // this developer before" — whose escape is a small plain "Install anyway"
    // under "More details", while the big filled button ("Got it") ABANDONS the
    // install. Play Protect never appears on an update to an already-installed
    // app, which is why every earlier test missed it.
    // Mutation: drop either gate, or the button words, and a camper stalls at
    // the dialog our copy never mentioned.
    expect(settings).toMatch(/Allow from this source/);
    expect(settings).toMatch(/Play Protect/);
    expect(settings).toMatch(/More details/);
    expect(settings).toMatch(/Install anyway/);
    expect(settings).toMatch(/big button cancels/);
    // the owner's real P9 transfer: the popup's Open launched a hijacking
    // third-party app — the copy must route receivers through Files instead
    expect(settings).toMatch(/from Files/);
    expect(settings).toMatch(/wrong app/);
    // two-signer reality (Play App Signing key != our beam key, measured
    // B2:0D… vs 5C:95… 2026-08-21): cross-channel installs REFUSE, and the
    // naive remedy (uninstall) destroys camp data — the copy must route
    // Play-installed phones back to Play
    expect(settings).toMatch(/from the Play Store updates from the Play Store/);
  });

  test('the iOS link is a real TestFlight join link, or honestly absent', () => {
    // Mutation: a placeholder ('TODO', 'https://example.com', an http link)
    // ships a row that opens nothing. Empty is allowed and handled — the row
    // says the build is not published yet.
    const link = /const TESTFLIGHT_PUBLIC_LINK = '([^']*)'/.exec(settings)?.[1];
    expect(link).toBeDefined();
    if (link !== '') {
      expect(link).toMatch(/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/);
    } else {
      expect(settings).toMatch(/not published yet/);
    }
  });

  test('the row is disabled while the copy runs', () => {
    // Mutation: drop `disabled` — a double tap queues a second whole-APK job
    // behind the first.
    expect(settings).toMatch(/disabled=\{preparingPct !== null\}/);
  });
});

/**
 * TWO DOORS, ONE IMPLEMENTATION (sharing audit, docs/SHARING-SURFACES.md
 * §3.3). Handing the app over is the only path that reaches a person with no
 * Playa Pal, and two different instincts look for it: "where do I get this
 * app" goes to Settings, "someone is standing right here" goes to the Camp
 * tab's Share section. Both are real, so both mount — but a COPY of the row
 * in either screen would fork the field-bought install copy above, and the
 * two would drift the first time one was edited.
 */
describe('the hand-over row mounts in both places, implemented once', () => {
  const settings = readSource(SETTINGS);
  const camp = readSource(CAMP);

  test('Settings and Camp both render the shared component', () => {
    for (const [name, src] of [
      ['Settings', settings],
      ['Camp', camp],
    ] as const) {
      // Mutation: drop either mount and one of the two instincts dead-ends.
      expect(`${name}: ${src}`).toMatch(/import \{ ShareAppRow \} from '\.\/ShareAppRow'/);
      expect(`${name}: ${src}`).toMatch(/<ShareAppRow \/>/);
    }
  });

  test('neither screen re-implements the native call or the copy', () => {
    // Mutation: paste the row back into a screen — two sources of truth for
    // install instructions that a camper reads while standing in dust.
    for (const src of [settings, camp]) {
      expect(src).not.toMatch(/NativeModules\.ShareApp/);
      expect(src).not.toMatch(/Play Protect/);
      expect(src).not.toMatch(/TESTFLIGHT_PUBLIC_LINK/);
    }
  });
});
