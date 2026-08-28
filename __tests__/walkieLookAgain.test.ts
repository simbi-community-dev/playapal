/**
 * "LOOK AGAIN", and the scan that learned to say why — the two halves of
 * the 2026-08-26 diagnosability slice, pinned in the house source-grep
 * style (__tests__/walkieCap.test.ts is the pattern).
 *
 * WHY A SOURCE SUITE AND NOT A BEHAVIOUR ONE. Nothing in this repo runs
 * Kotlin or Swift, and both halves are native by construction: a control
 * that exists on one platform is worse than one that exists on neither,
 * because the camper who taps it on the other phone learns that Playa
 * Pal's buttons sometimes do nothing. What these tests can hold is that
 * the seams AGREE — that the JS verb, the two natives, the Objective-C
 * bridge line that makes the iOS half reachable at all, and the panel that
 * calls it are all present and all spelled the same.
 *
 * THE FIELD FINDING BEHIND IT, measured on three phones: an iPhone carried
 * live BLE voice to an Android for the first time, and neither Android
 * could see that iPhone in their channel. P7's logcat proved the other
 * Pixel's PV hash over and over and never once attempted the iPhone's —
 * and the four `return`s in onScanResult that could have said which gate
 * ate it were all silent. A rung that fails by returning is a rung nobody
 * can debug from a phone in the dust.
 *
 * Each assertion names the mutation it dies on.
 */
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const BLE_KT = 'android/app/src/main/java/com/playapal/WalkieBleLink.kt';
const MODULE_KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const AWARE_KT = 'android/app/src/main/java/com/playapal/WalkieAwareLink.kt';
const WALKIE_SWIFT = 'ios/PlayaPal/Walkie.swift';
const BLE_SWIFT = 'ios/PlayaPal/WalkieBleVoice.swift';
const BRIDGE_M = 'ios/PlayaPal/WalkieBridge.m';
const PANEL_TSX = 'src/crews/WalkiePanel.tsx';

import {
  WALKIE_REFRESH_COPY,
  refreshWalkieDiscovery,
  walkieRefreshPresent,
} from '../src/crews/walkie';

describe('the Android scan says why it dropped an advertisement', () => {
  test('all four silent returns in onScanResult now name themselves', () => {
    // THE LOAD-BEARING ONE. Mutation: drop any one noteScanDrop call and
    // that gate goes back to being invisible — which is exactly the state
    // the bench was in when an iPhone sat in the room advertising and no
    // Android could say what it was doing with the advertisement.
    const kt = readSource(BLE_KT);
    for (const reason of ['no-carrier', 'bad-header', 'other-pod', 'self']) {
      expect(kt).toContain(`noteScanDrop("${reason}"`);
    }
  });

  test('the line is the agreed shape, on the agreed tag', () => {
    // Mutation: reword the log line. It is read by a human squinting at
    // `adb logcat -s PlayaPalBleVoice` in the dust, and by whatever grep
    // the next bench writes — the reason, the address and the advertised
    // name are the three fields that turn "nothing happened" into "that
    // phone, that gate".
    const kt = readSource(BLE_KT);
    expect(kt).toContain('private const val TAG = "PlayaPalBleVoice"');
    expect(kt).toMatch(
      /"voice\/\/scan-drop reason=" \+ reason \+ " addr=" \+ addr \+/,
    );
    expect(kt).toContain('" name=" + (if (name.isNullOrEmpty()) "-" else name)');
  });

  test('it is rate limited per (device, reason) and bounded in memory', () => {
    // Mutation: drop the window check and a stranger's headphones, which a
    // LOW_LATENCY scan re-reports several times a second, fill the log
    // buffer and push out the podmate's one line that mattered. Drop the
    // LruCache bound and the diagnostic becomes a leak at a 70,000-person
    // festival — the posture CrewBeaconModule already takes toward
    // anything a stranger can make us hold.
    const kt = readSource(BLE_KT);
    expect(kt).toContain('private const val DROP_LOG_WINDOW_MS = 5 * 60_000L');
    expect(kt).toContain('android.util.LruCache<String, Long>(DROP_LOG_KEYS)');
    expect(kt).toContain('val key = addr + "|" + reason');
    expect(kt).toMatch(
      /if \(last != null && now - last < DROP_LOG_WINDOW_MS\) \{\s*return/,
    );
  });

  test('the accepted path never reaches the diagnostic', () => {
    // THE HOT-PATH PIN. Mutation: log every sighting, or move noteScanDrop
    // above the gates "to see everything" — and rung 3's scan callback,
    // which fires several times a second per visible device, starts
    // allocating a key and taking a lock for every podmate's healthy
    // advertisement. A podmate's good advert must cost the gate
    // comparisons it already cost and nothing else.
    const kt = readSource(BLE_KT);
    const body = kt.slice(
      kt.indexOf('override fun onScanResult('),
      kt.indexOf('handler.post { maybeConnect(hash, device) }'),
    );
    expect(body).not.toEqual('');
    // EVERY noteScanDrop in the callback is immediately followed by a
    // return — so the count of calls and the count of drop-then-return
    // pairs must be the same number, and that number must be five. Count
    // only the pairs and a sixth call added on the accepted path ("just
    // log every sighting while we debug") slips through unseen; that is
    // the mutation this pair of assertions was rewritten to catch.
    //
    // Five since the churn damper (3fdb5a9): "already-reached" is the
    // fifth REJECTING path, which is the shape this pin permits — it left
    // the literal stale, not the invariant.
    const all = body.match(/noteScanDrop\(/g) ?? [];
    const returning = body.match(/noteScanDrop\([^\n]*\n\s*return/g) ?? [];
    expect(all).toHaveLength(5);
    expect(returning).toHaveLength(all.length);
  });
});

describe('"look again" exists on BOTH platforms', () => {
  test('Android exposes refreshDiscovery and asks all three rungs', () => {
    // Mutation: ship the control on iOS only. The panel renders it from a
    // single JS capability check, so an Android build with no native
    // method would show a button that resolves and does nothing — the
    // worst shape a diagnostic control can take, because it teaches the
    // camper that the app's buttons are decorative.
    const kt = readSource(MODULE_KT);
    expect(kt).toMatch(/@ReactMethod\s*\n\s*fun refreshDiscovery\(promise: Promise\)/);
    expect(kt).toContain('startDiscovery(manager)');
    expect(kt).toContain('bleLink?.refresh()');
    expect(kt).toContain('aware?.refresh()');
    expect(readSource(BLE_KT)).toMatch(/fun refresh\(\) \{/);
    expect(readSource(AWARE_KT)).toMatch(/fun refresh\(\) \{/);
  });

  test('iOS exposes refreshDiscovery — and the bridge line that makes it real', () => {
    // Mutation: write the Swift and forget WalkieBridge.m. Everything
    // compiles, nothing warns, and JS sees `typeof refreshDiscovery ===
    // 'undefined'` forever — so walkieRefreshPresent() answers false and
    // the control silently never appears on iPhone.
    expect(readSource(WALKIE_SWIFT)).toContain('@objc(refreshDiscovery:rejecter:)');
    expect(readSource(BLE_SWIFT)).toMatch(/func refresh\(\) \{/);
    expect(readSource(BRIDGE_M)).toContain(
      'RCT_EXTERN_METHOD(refreshDiscovery:(RCTPromiseResolveBlock)resolve',
    );
  });

  test('it restarts the LOOKING, never a live datapath or the engine', () => {
    // THE SAFETY PIN, and the reason this control can be offered at all: a
    // camper taps it because the channel looks wrong, which is exactly
    // when somebody may be mid-sentence on it. Mutation: reach for the
    // obvious "restart everything" — stopInternal(), a socket close, a
    // teardown of the Aware datapath — and the control becomes the
    // dropout it was added to explain.
    const kt = readSource(MODULE_KT);
    const refresh = kt.slice(
      kt.indexOf('fun refreshDiscovery(promise: Promise)'),
      kt.indexOf('fun stop(promise: Promise)'),
    );
    expect(refresh).not.toEqual('');
    expect(refresh).not.toMatch(/stopInternal|socket\?\.close|unregisterService/);
    const swift = readSource(WALKIE_SWIFT);
    const iosRefresh = swift.slice(
      swift.indexOf('@objc(refreshDiscovery:rejecter:)'),
      swift.indexOf('@objc(stop:rejecter:)'),
    );
    expect(iosRefresh).not.toEqual('');
    expect(iosRefresh).not.toMatch(/stopInternal|listener\?\.cancel|engine/);
    // …and the LAN rung's browser is replaced only when it is DOWN: a
    // fresh NWBrowser reports an empty world until its first results
    // arrive, so rebuilding a healthy one would cancel every LAN peer's
    // connection and re-add it a moment later — the flap, caused by the
    // cure.
    expect(iosRefresh).toContain('if browserDown {');
  });

  test('the JS verb is capability-gated and cannot reject', () => {
    // Mutation: drop the typeof check and an older native build throws on
    // every tap; drop the catch and a radio that says no becomes an
    // unhandled rejection over a stage with a live mic on it.
    expect(walkieRefreshPresent()).toBe(false); // no native in the test env
    return expect(refreshWalkieDiscovery()).resolves.toBeUndefined();
  });

  test('the panel wires the verb, its copy, and no raw Text', () => {
    // Mutation (the wiring): import the verb and never call it, or render
    // the control unconditionally — a button with no handler, or one that
    // appears on a build whose native cannot serve it.
    const tsx = readSource(PANEL_TSX);
    expect(tsx).toContain('walkieRefreshPresent()');
    expect(tsx).toContain('void refreshWalkieDiscovery();');
    expect(tsx).toContain('onPress={lookAgain}');
    expect(tsx).toContain('<InfoTap topic="looking again" text={WALKIE_REFRESH_COPY} />');
    // Mutation (the copy): promise a stronger thing than the natives do.
    // The honest sentence is the whole reason the owner can trust the
    // control mid-conversation.
    expect(WALKIE_REFRESH_COPY).toContain('look again right now');
    expect(WALKIE_REFRESH_COPY).toContain('links that are healthy are untouched');
    // Mutation (the wrapper): `import { Text } from 'react-native'` here
    // and every word this panel says stops obeying the text-size dial.
    // __tests__/textSize.test.tsx holds this repo-wide; this line holds it
    // for the file the new control lives in, where it would be introduced.
    expect(tsx).toContain("import { Text } from '../components/Text';");
    expect(tsx).not.toMatch(/import \{[^}]*\bText\b[^}]*\} from 'react-native'/);
  });
});
