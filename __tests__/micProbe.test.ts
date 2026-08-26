/**
 * MicProbe — the controlled mic smoke test (iOS). Kotlin/Swift cannot be
 * unit-run here, so these pins read the real sources, each naming the
 * mutation it dies on.
 *
 * REBUILT 2026-08-26 with the probe itself, after the research sweep
 * (`research-voicechat-zero-buffers.md`) found the first revision could not
 * make the distinction the walkie's failure actually turns on. "The walkie
 * is silent" is TWO bugs wearing one word:
 *
 *   - NO BUFFERS — the render callback never fires. An enablement/ordering
 *     failure: nothing is asking the microphone for samples.
 *   - BUFFERS, ALL ZERO — callbacks fire on cadence and carry silence. A
 *     mute (voice-processing, or iOS 17's app-wide input mute, which zeroes
 *     samples without stopping callbacks).
 *
 * Different fixes, and they used to print the same word. The pins below
 * hold the physics that separates them — buffer count, peak magnitude, and
 * the ordering A/B that reproduces what the walkie actually does — plus the
 * session hygiene, because an arm running on the previous arm's residue
 * reports about the residue.
 */
export {}; // module scope: 'read'/'SETTINGS' collide with sibling script-scope suites

const read = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const SWIFT = 'ios/PlayaPal/MicProbe.swift';
const BRIDGE = 'ios/PlayaPal/MicProbeBridge.m';
const PBX = 'ios/PlayaPal.xcodeproj/project.pbxproj';
const SETTINGS = 'src/screens/SettingsScreen.tsx';

/** The variant list only — so counting arms cannot catch the struct decl. */
const armList = (swift: string): string => {
  const from = swift.indexOf('let variants: [Variant] = [');
  const to = swift.indexOf('for v in variants', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return swift.slice(from, to);
};

/** run()'s own body: the two gates, not the sweep they stand in front of. */
const runBody = (swift: string): string => {
  const from = swift.indexOf('  @objc(run:rejecter:)');
  const to = swift.indexOf('private static func claim()', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return swift.slice(from, to);
};

/** One arm's body: probe(), stopping before the shared hygiene helpers. */
const armBody = (swift: string): string => {
  const from = swift.indexOf('private static func probe(');
  const to = swift.indexOf('private static func release()', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return swift.slice(from, to);
};

test('permission is answered BEFORE the first arm, and a no runs nothing', () => {
  // Mutation: move the sweep above the gate, or delete the gate — on a fresh
  // install (undetermined) or a phone where someone once said no, every
  // engine arm taps a microphone that renders nothing, and the report is
  // nine NO-AUDIO/ZEROED lines plus NOT-RECORDING. That is letter for letter
  // the fingerprint of the enablement bug this probe exists to FIND, so the
  // probe would be confidently mislabelling a dialog nobody has answered —
  // the one thing a diagnostic must never be.
  const body = runBody(read(SWIFT));
  const gate = body.indexOf('Self.withRecordPermission { granted in');
  const denied = body.indexOf('guard granted else {');
  const sweep = body.indexOf('Self.sweep()');
  expect(gate).toBeGreaterThan(-1);
  expect(denied).toBeGreaterThan(gate);
  expect(sweep).toBeGreaterThan(denied);
  // The arms live behind the gate, not beside it: nothing in run() builds a
  // Variant or touches the session on its own.
  expect(body).not.toContain('let variants');
  expect(body).not.toContain('AVAudioSession');
  // The denied path answers in ONE line and names the door out of it — and
  // it resolves, because "this phone says no" is a measurement, not a
  // broken probe (the WifiAware probe's posture, same reasoning).
  const refusal = body.slice(denied, sweep);
  expect(refusal).toContain('resolve(Self.deniedLine)');
  expect(refusal).not.toContain('probe(');
  expect(read(SWIFT)).toContain(
    '"microphone permission denied — enable in Settings > Playa Pal"',
  );
});

test('the ask happens only for the state that has no answer yet', () => {
  // Mutation: request unconditionally — a second dialog for a camper who
  // already answered (iOS shows none, so the callback answers from the
  // stored choice and the arm order is unchanged, which is why this one
  // hides). Or read the state and never ask — a fresh install can then only
  // ever print the denied line, and the probe never runs on a new phone.
  const swift = read(SWIFT);
  const from = swift.indexOf('private static func withRecordPermission(');
  expect(from).toBeGreaterThan(-1);
  const body = swift.slice(from, swift.indexOf('// ---', from));
  expect(body).toContain('switch session.recordPermission {');
  expect(body).toMatch(/case \.granted:\s*\n\s*then\(true\)/);
  expect(body).toMatch(/case \.denied:\s*\n\s*then\(false\)/);
  // .undetermined (and whatever a later OS adds) is the ONLY ask.
  expect(body).toMatch(/default:[\s\S]*requestRecordPermission \{ then\(\$0\) \}/);
});

test('one sweep at a time, claimed before anything is dispatched', () => {
  // Mutation: drop the lock, or claim inside the async block — every arm
  // drives the SAME AVAudioSession singleton and the control writes ONE
  // fixed file, so two sweeps do not run twice, they run into each other:
  // arm N of one deactivates the session arm M of the other is measuring,
  // and both reports describe a session neither of them owned. Claiming
  // after the dispatch leaves a window exactly as wide as the dispatch,
  // which is the window the double tap lands in.
  const swift = read(SWIFT);
  expect(swift).toContain('private static let gate = NSLock()');
  expect(swift).toContain('private static var running = false');
  const body = runBody(swift);
  const claim = body.indexOf('guard Self.claim() else {');
  expect(claim).toBeGreaterThan(-1);
  expect(claim).toBeLessThan(body.indexOf('Self.withRecordPermission'));
  expect(claim).toBeLessThan(body.indexOf('DispatchQueue.global'));
  expect(body).toContain('reject("busy", "busy — a check is already running", nil)');
  // Every path out of a successful claim hands it back — including the
  // denied one, which runs no arm and would otherwise wedge the row for the
  // life of the process.
  expect(body).toMatch(/guard granted else \{\s*\n\s*Self\.relinquish\(\)/);
  expect(body).toContain('defer { Self.relinquish() }');
  // The flag is read and set under the same lock, or it is not a lock.
  const claimBody = swift.slice(
    swift.indexOf('private static func claim()'),
    swift.indexOf('private static func withRecordPermission('),
  );
  expect(claimBody).toMatch(/gate\.lock\(\)\s*\n\s*defer \{ gate\.unlock\(\) \}/);
  expect(claimBody).toMatch(/if running \{\s*\n\s*return false/);
  expect(claimBody).toContain('running = true');
  expect(claimBody).toMatch(/gate\.lock\(\)\s*\n\s*running = false\s*\n\s*gate\.unlock\(\)/);
});

test('the matrix still covers the mode fork the field narrowed to', () => {
  // Mutation: drop a mode — the sweep stops separating .voiceChat (the
  // voice-processing mode) from .spokenAudio (the mode voice notes record
  // in successfully) from .default (what the walkie asks for today).
  const swift = read(SWIFT);
  for (const mode of ['.voiceChat', '.spokenAudio', '.default', '.measurement']) {
    expect(swift).toContain('mode: ' + mode);
  }
  expect(swift).toMatch(/useInputFormat: true/);
  // The recorder arm is the control: AVAudioRecorder capturing while every
  // engine arm fails is a different diagnosis from nothing capturing at all.
  expect(swift).toMatch(/recorderProbe/);
});

test('the ordering enum carries all three positions of the first inputNode touch', () => {
  // Mutation: delete a case — the input node is built ON DEMAND at first
  // access and its enabled-ness is decided from the session and route AT
  // THAT MOMENT, so "when did you first touch it" is not style, it is the
  // experiment. Two cases can only ask half of it.
  const swift = read(SWIFT);
  const from = swift.indexOf('private enum Order {');
  expect(from).toBeGreaterThan(-1);
  const body = swift.slice(from, swift.indexOf('\n  }', from));
  // The exact set, not a substring sweep: a renamed case still contains the
  // old name, and a fourth position added without an arm to run it is an
  // ordering nobody measures.
  const cases = (body.match(/^\s*case \w+$/gm) ?? []).map((c) => c.trim());
  expect(cases).toEqual([
    'case tapBeforeStart',
    'case startThenInput',
    'case inputThenStartThenTap',
  ]);
});

test('arms 7 and 8 each run BOTH orderings, and the pair is repeated last', () => {
  // Mutation: collapse 7b into 7a — an A/B with one arm proves nothing, and
  // the sweep is back to the state that made an arm labelled "walkie today"
  // the one thing a diagnostic must never be: confidently mislabelled.
  const arms = armList(read(SWIFT));
  const before = (arms.match(/order: \.startThenInput/g) ?? []).length;
  const after = (arms.match(/order: \.inputThenStartThenTap/g) ?? []).length;
  expect(before).toBe(2); // 7a and 8a
  expect(after).toBe(2); // 7b and 8b
  expect(arms).toMatch(/"7a [^"]*"/);
  expect(arms).toMatch(/"7b [^"]*"/);
  expect(arms).toMatch(/"8a [^"]*"/);
  expect(arms).toMatch(/"8b [^"]*"/);
});

test('the ordering is the ONLY variable inside the A/B pair', () => {
  // Mutation: give one half a different mode (or the input format) — a
  // failure on one side no longer isolates ordering, which is the single
  // thing these four arms exist to isolate.
  const arms = armList(read(SWIFT));
  for (const label of ['7a', '7b', '8a', '8b']) {
    const at = arms.indexOf('"' + label + ' ');
    expect(at).toBeGreaterThan(-1);
    // Name through the `order:` line — the arm names themselves carry
    // parentheses, so the closing paren is not the delimiter it looks like.
    const arm = arms.slice(at, arms.indexOf('\n', arms.indexOf('order: .', at)));
    expect(arm).toContain('mode: .default');
    expect(arm).not.toContain('useInputFormat');
  }
});

test('the arms that reproduce the walkie build the walkie’s output-only graph first', () => {
  // Mutation: drop the player attach/connect — arms 7 and 8 start a BARE
  // engine, which is not what the walkie does. The whole point is an IO unit
  // initialised with no input element that is then asked to grow one while
  // it renders; without a playback graph there is nothing rendering.
  const swift = read(SWIFT);
  expect(swift).toMatch(/if v\.order != \.tapBeforeStart \{/);
  expect(swift).toMatch(/engine\.attach\(player\)/);
  expect(swift).toMatch(/engine\.connect\(player, to: engine\.mainMixerNode, format: wire\)/);
});

test('the WHOLE arm runs under the ObjC catcher, not just the tap install', () => {
  // Mutation: move any of these out of ObjCTry.run — attach, connect, the
  // first inputNode access and the format read are all AVFAudio precondition
  // sites, and an ObjC raise from any of them is UNCATCHABLE by Swift
  // do/catch: it aborts the app on the exact device this probe exists to
  // diagnose (project law, CLAUDE.md iOS native-exception law).
  const swift = read(SWIFT);
  const from = swift.indexOf('let exc = ObjCTry.run {');
  const to = swift.indexOf('if let exc {', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const caught = swift.slice(from, to);
  expect(caught).toContain('engine.attach(player)');
  expect(caught).toContain('let input = engine.inputNode');
  expect(caught).toContain('fmt = format(of: input)');
  expect(caught).toContain('input.installTap(');
  expect(caught).toContain('try engine.start()');
  expect(swift).toMatch(/RAISE " \+ \(exc\.reason \?\? exc\.name\.rawValue\)/);
  // Cleanup is under it too — a probe that aborts during its own teardown
  // reports nothing at all, having measured everything.
  expect(swift).toMatch(
    /_ = ObjCTry\.run \{\s*\n\s*engine\.inputNode\.removeTap\(onBus: 0\)\s*\n\s*engine\.stop\(\)/,
  );
});

test('every arm reports buffer COUNT and PEAK — the ZEROED/NO-AUDIO discriminator', () => {
  // Mutation: drop peak (or count) — "silent" collapses back into one word
  // for two bugs with different fixes. Buffers that never arrive is an
  // enablement failure; buffers full of zeros is a mute.
  const swift = read(SWIFT);
  expect(swift).toMatch(/" bufs=" \+ String\(count\)/);
  expect(swift).toMatch(/" peak=" \+ String\(format: "%\.4f", peak\)/);
  expect(swift).toMatch(/if count == 0 \{\s*\n\s*return "NO-AUDIO \(tap installed, no buffers\)"/);
  expect(swift).toMatch(/if peak == 0 \{\s*\n\s*return "ZEROED \(buffers flowed, every sample 0\)"/);
});

test('the vitals ride every outcome line, the healthy one included', () => {
  // Mutation: attach vitals only to the failures — a field report then has
  // no healthy baseline beside it, and "peak=0.0031" means nothing without
  // a line from an arm that worked on the same phone.
  const body = armBody(read(SWIFT));
  for (const outcome of ['"NO-AUDIO', '"ZEROED', '"OK "']) {
    const at = body.indexOf(outcome);
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, body.indexOf('\n', body.indexOf('vitals', at)))).toContain('vitals');
  }
  // The four cheap facts that name the rest of the suspect list.
  expect(body).toMatch(/" \[run=" \+ yn\(startedRunning\) \+ ">" \+ yn\(stillRunning\)/);
  expect(body).toMatch(/" fmt=" \+ describe\(fmt\)/);
  expect(body).toMatch(/" mute=" \+ mute/);
  expect(body).toMatch(/routeLine\(session\)/);
});

test('count and peak are measured over a WINDOW, not read off the first callback', () => {
  // Mutation: restore the semaphore that returned on buffer #1 — a mute
  // that emits buffers on cadence reports OK, which is the exact failure
  // this rebuild exists to stop misreporting.
  const swift = read(SWIFT);
  expect(swift).not.toContain('DispatchSemaphore');
  expect(swift).toMatch(/Thread\.sleep\(forTimeInterval: window\)/);
  expect(swift).toMatch(/let \(count, peak, got, unread\) = meter\.read\(\)/);
  // The tap closure runs on the render thread; the probe thread reads after
  // removeTap. Without the lock the numbers are a race, i.e. a lie.
  expect(swift).toMatch(/private let lock = NSLock\(\)/);
  // Read live, while the session is still active: a route or a mute flag
  // read after deactivation describes a session nobody used.
  expect(swift).toMatch(
    /let stillRunning = engine\.isRunning\s*\n\s*let route = routeLine\(session\)\s*\n\s*let mute = muteLine\(\)\s*\n\s*cleanUp\(engine\)/,
  );
});

test('peak walks an interleaved buffer without walking off the allocation', () => {
  // Mutation: iterate `channels` planes unconditionally — an interleaved
  // buffer has ONE channel pointer, so plane 1 reads off the end of the
  // allocation. That is a crash in the diagnostic, not a wrong number.
  const swift = read(SWIFT);
  expect(swift).toMatch(/let interleaved = buf\.format\.isInterleaved/);
  expect(swift).toMatch(/let planes = interleaved \? 1 : channels/);
  expect(swift).toMatch(/let perPlane = interleaved \? frames \* channels : frames/);
  // Both sample layouts, because which one arrives is the device's choice.
  expect(swift).toMatch(/buf\.floatChannelData/);
  expect(swift).toMatch(/buf\.int16ChannelData/);
});

test('the session is handed back between arms, loudly enough for other apps', () => {
  // Mutation: drop .notifyOthersOnDeactivation — every other audio client on
  // the phone is left believing Playa Pal still holds the microphone. Or
  // `try?` the failure away — a session that will NOT release is itself the
  // diagnosis, and it explains every arm printed after it.
  const swift = read(SWIFT);
  expect(swift).toMatch(
    /setActive\(\s*\n?\s*false, options: \[\.notifyOthersOnDeactivation\]\s*\n?\s*\)/,
  );
  expect(swift).toMatch(/return " release-fail\(" \+ error\.localizedDescription \+ "\)"/);
});

test('arm N cannot run on arm N-1’s residue, and no arm exits without releasing', () => {
  // Mutation: remove a `+ notes` from any exit path — that arm silently
  // keeps the session, and the arms after it measure the leftover rather
  // than themselves.
  const body = armBody(read(SWIFT));
  expect(body).toMatch(/var notes = release\(\)/);
  const returns = body.match(/^\s*return .*$/gm) ?? [];
  expect(returns.length).toBeGreaterThanOrEqual(6);
  for (const r of returns) {
    expect(r).toContain('notes');
  }
  // The recorder control observes the same rule.
  const rec = read(SWIFT).slice(read(SWIFT).indexOf('private static func recorderProbe('));
  expect(rec).toMatch(/var notes = release\(\)/);
  expect(rec).toMatch(/notes \+= release\(\)/);
});

test('the run itself ends released, and says whether the release worked', () => {
  // Mutation: drop the final release — the walkie inherits whatever the
  // last arm left behind, so the diagnostic becomes a cause of the bug it
  // was opened to explain.
  const swift = read(SWIFT);
  expect(swift).toMatch(/let last = Self\.release\(\)/);
  expect(swift).toMatch(/lines\.append\("session released -> " \+ \(last\.isEmpty \? "ok" : last\)\)/);
});

test('the whole sweep still fits inside the Settings row’s promise', () => {
  // Mutation: lengthen the window, or add arms without re-timing — the row
  // promises a number of seconds to a camper standing in dust, and a
  // diagnostic that overruns its promise gets tapped a second time, which
  // starts a fresh sweep on top of the running one.
  const swift = read(SWIFT);
  const window = Number(/let window: TimeInterval = ([\d.]+)/.exec(swift)?.[1]);
  const arms = (armList(swift).match(/Variant\(/g) ?? []).length;
  const recorder = Number(/Thread\.sleep\(forTimeInterval: ([\d.]+)\)/.exec(swift)?.[1]);
  expect(window).toBeGreaterThan(0);
  expect(arms).toBeGreaterThanOrEqual(9);
  expect(recorder).toBeGreaterThan(0);

  const words: Record<string, number> = {
    four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15,
  };
  const promised = /takes about (\w+) seconds/.exec(read(SETTINGS))?.[1];
  expect(promised).toBeDefined();
  expect(words[promised as string]).toBeDefined();
  // Sleeps alone — session setup, engine start and teardown are overhead on
  // top of this, so the arithmetic must fit with room, not exactly.
  expect(arms * window + recorder).toBeLessThanOrEqual(words[promised as string]);
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

test('the row says it is running, and stops taking taps while it does', () => {
  // Mutation: drop the busy state — the row shows NOTHING for the eight
  // seconds the sweep takes, so it reads as untapped and gets tapped again.
  // That second tap is the concurrent sweep; the native lock now refuses it,
  // but a camper standing in dust should never have to be refused. Or drop
  // the .finally — the row stays on "Listening…" forever after the one
  // ending that is easiest to forget: the reject.
  const st = read(SETTINGS);
  expect(st).toContain('const [micChecking, setMicChecking] = useState(false);');
  const at = st.indexOf('NativeModules.MicProbe.run()');
  const onPress = st.slice(st.lastIndexOf('onPress={() => {', at), at);
  expect(onPress).toContain('setMicChecking(true);');
  expect(st.slice(at)).toMatch(/\.finally\(\(\) => setMicChecking\(false\)\)/);
  // Disabled AND announced: a Pressable that only looks busy still fires.
  expect(st).toContain('disabled={micChecking}');
  expect(st).toContain('busy: micChecking');
  expect(st).toMatch(/micChecking\s*\n?\s*\? 'Listening…'/);
  // The idle copy — and its eight-second promise — survives the branch.
  expect(st).toMatch(/takes about (\w+) seconds/);
});
