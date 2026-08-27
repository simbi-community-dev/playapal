/**
 * The release APK ships arm64-v8a ONLY (docs/BEAM-INGRESS-CONTRACT.md §6).
 *
 * On playa the app itself travels phone-to-phone over Quick Share, so every
 * byte of the APK is a byte pushed through dust on a battery. Measured on
 * v0.6.1: x86 (emulator-only) and armeabi-v7a (~2015 phones) were 87 MB of
 * a 292.5 MB APK. Debug must keep every ABI — the x86_64 emulator is how
 * agents dogfood — so the split is gated on a release task being requested.
 *
 * It is a splits.abi block, NOT buildTypes.release.ndk.abiFilters: the RN
 * gradle plugin addAll()s every reactNativeArchitectures entry into
 * defaultConfig.ndk.abiFilters and AGP unions abiFilters across
 * defaultConfig/buildType, so a release-only filter silently did nothing
 * (measured 2026-08-21: 306,757,399 bytes with it, identical to without).
 */
const gradle = require('fs').readFileSync('android/app/build.gradle', 'utf8') as string;
// the explanation of WHY lives in comments and names the thing it forbids
const code = gradle.replace(/^\s*\/\/.*$/gm, '');


describe('release ABI split', () => {
  const splits = gradle.slice(gradle.indexOf('\n    splits {'));

  test('uses splits.abi (the plugin honours it), never a buildType abiFilters (unioned away)', () => {
    expect(splits).toMatch(/splits\s*\{\s*abi\s*\{/);
    expect(code).not.toMatch(/abiFilters/);
  });

  test('includes arm64-v8a only, no universal APK', () => {
    expect(splits).toMatch(/reset\(\)/);
    expect(splits).toMatch(/include\s+"arm64-v8a"/);
    expect(splits).not.toMatch(/include[^\n]*(x86|armeabi)/);
    expect(splits).toMatch(/universalApk\s+false/);
  });

  test('is gated on a release APK task being requested (debug keeps every ABI)', () => {
    expect(splits).toMatch(/enable\s+releaseApkRequested/);
    expect(gradle).toMatch(/releaseApkRequested = gradle\.startParameter\.taskNames\.any/);
    expect(gradle).toMatch(/\(assemble\|install\|package\)Release/);
  });

  test('the dev-time ABI list still includes the emulator', () => {
    const props = require('fs').readFileSync('android/gradle.properties', 'utf8') as string;
    expect(props).toMatch(/^reactNativeArchitectures=.*x86_64/m);
  });
});
