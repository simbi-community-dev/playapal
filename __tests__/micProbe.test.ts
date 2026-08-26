/**
 * MicProbe — the controlled mic smoke test (iOS). Kotlin/Swift cannot be
 * unit-run here, so these pins read the real sources, each naming the
 * mutation it dies on.
 */
export {}; // module scope: 'read'/'SETTINGS' collide with sibling script-scope suites

const read = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const SWIFT = 'ios/PlayaPal/MicProbe.swift';
const BRIDGE = 'ios/PlayaPal/MicProbeBridge.m';
const PBX = 'ios/PlayaPal.xcodeproj/project.pbxproj';
const SETTINGS = 'src/screens/SettingsScreen.tsx';

test('the probe covers the strategy fork the field narrowed to', () => {
  // Mutation: drop a variant — the matrix stops separating voiceChat (the
  // failing walkie mode) from spokenAudio (the working voice-note mode).
  const swift = read(SWIFT);
  for (const mode of ['.voiceChat', '.spokenAudio', '.default', '.measurement']) {
    expect(swift).toContain('mode: ' + mode);
  }
  expect(swift).toMatch(/useInputFormat: true/);
  expect(swift).toMatch(/recorderProbe/);
});

test('every tap install runs under the ObjC catcher and reports the reason', () => {
  // Mutation: install outside ObjCTry — the probe itself aborts the app
  // on the exact device it exists to diagnose.
  const swift = read(SWIFT);
  expect(swift).toMatch(/ObjCTry\.run \{\s*\n\s*input\.installTap/);
  expect(swift).toMatch(/RAISE " \+ \(exc\.reason \?\? exc\.name\.rawValue\)/);
});

test('the module is in the build: bridge selector + pbxproj Sources', () => {
  // Mutation: drop a pbxproj row — EAS builds green and the module is
  // silently absent (reads to JS as an older native).
  expect(read(BRIDGE)).toMatch(/RCT_EXTERN_MODULE\(MicProbe, NSObject\)/);
  expect(read(BRIDGE)).toMatch(/RCT_EXTERN_METHOD\(run:\(RCTPromiseResolveBlock\)resolve/);
  const pbx = read(PBX);
  expect(pbx).toMatch(/MicProbe\.swift in Sources/);
  expect(pbx).toMatch(/MicProbeBridge\.m in Sources/);
});

test('the Settings row exists and is presence-gated (Android renders nothing)', () => {
  // Mutation: unwire the row — the diagnostic exists with no door; or
  // drop the gate — Android taps a missing module.
  const st = read(SETTINGS);
  expect(st).toMatch(/NativeModules\.MicProbe != null \?/);
  expect(st).toMatch(/NativeModules\.MicProbe\.run\(\)/);
  expect(st).toMatch(/Run the microphone check/);
});
