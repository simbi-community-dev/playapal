/**
 * THE CAMP HOTSPOT — a shared Wi-Fi the pod makes for itself, so a video
 * call has an IP network to ride when there is no camp Wi-Fi at all.
 *
 * What is pinned here, and why each pin exists:
 *
 *  - ONE REQUEST PER APP. Android grants one local-only hotspot request per
 *    application. A second `arm` while starting or on must be a no-op, or
 *    the second callback strands and the switch lies about what the radio
 *    is doing.
 *  - STOP WHILE STARTING OWES A LATE ARRIVAL CLOSED. Bringing an access
 *    point up takes seconds and the switch can go off inside them. The
 *    reservation that lands afterwards has no card bound to it and nothing
 *    in JS can ever reach it — so the native half has to recognise it as
 *    stale and close it where it lands, or the phone broadcasts a network
 *    nobody can see until it reboots.
 *  - FAILED AND LIVE CANNOT BOTH BE TRUE. Every failure the JS side knows
 *    means "no radio is running". A refusal raised AFTER the access point
 *    came up (empty credentials, a read that throws) must therefore close
 *    it on the way out, or the card says off while the antenna says on.
 *  - NO SILENT STOPS. The system can take the hotspot away. That lands in
 *    `failed` with its own reason, never quietly in `off` — because the QR
 *    was on screen and somebody was about to scan it.
 *  - THE ESCAPING IS THE FEATURE. The `WIFI:` payload is delimited by `;`
 *    and `:`. An unescaped one in a passphrase truncates the field and the
 *    scanner offers to join with half a password — silently, looking
 *    exactly like a mistyped one.
 *  - EVERY REFUSAL HAS ITS OWN SENTENCE. "Allow the permission" and "turn
 *    Location on" are different fixes; telling someone to allow a grant
 *    they already gave is how a camper decides the app is broken.
 *  - THE SEAM NEVER REJECTS. A rejecting native call collapses eleven
 *    distinct, actionable reasons into one 'error'.
 *  - THE NATIVE HALF IS REGISTERED AND GUARDED. Source pins, because
 *    nothing type-checks Kotlin against TypeScript and the failure mode is
 *    a switch that does nothing on a real phone and everything in a test.
 */
// Paths are repo-relative, as in walkieCap.test.ts: jest runs from rootDir.
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/HotspotModule.kt';
const KT_PACKAGE = 'android/app/src/main/java/com/playapal/HotspotPackage.kt';
const KT_APP = 'android/app/src/main/java/com/playapal/MainApplication.kt';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const TS_SEAM = 'src/crews/campHotspot.ts';
const TSX_CARD = 'src/crews/CampHotspotCard.tsx';
const TSX_MOUNT = 'src/crews/CrewSection.tsx';

/**
 * The slice of a source file between two markers, so a pin about ONE
 * callback cannot be satisfied by the right line sitting in a different
 * one — the failure mode of a whole-file regex, and the difference between
 * "the close exists somewhere" and "the close is on the stale path".
 */
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import React from 'react';
import { NativeModules } from 'react-native';
import {
  HOTSPOT_STOPPED_EVENT,
  type HotspotCreds,
  type HotspotEvent,
  type HotspotModel,
  type HotspotReason,
  escapeWifiField,
  hotspotOff,
  hotspotQrPayload,
  hotspotReasonCopy,
  isHotspotReason,
  reduceHotspot,
  wifiQrPayload,
} from '../src/crews/campHotspot';
import { CampHotspotView, HOTSPOT_WHY } from '../src/crews/CampHotspotCard';

const TestRenderer = require('react-test-renderer');

const CREDS: HotspotCreds = {
  ssid: 'AndroidShare_4417',
  passphrase: 'dusty7horse',
  security: 'wpa2',
};

/** Drive the table from `off` and hand back the last step. */
function run(events: HotspotEvent[]): { model: HotspotModel; effects: string[] } {
  let model = hotspotOff;
  let effects: string[] = [];
  for (const e of events) {
    const step = reduceHotspot(model, e);
    model = step.model;
    effects = step.effects;
  }
  return { model, effects };
}

/** Every effect the whole run emitted, in order. */
function allEffects(events: HotspotEvent[]): string[] {
  let model = hotspotOff;
  const out: string[] = [];
  for (const e of events) {
    const step = reduceHotspot(model, e);
    model = step.model;
    out.push(...step.effects);
  }
  return out;
}

describe('one hotspot, one request, and no silent stops', () => {
  test('flipping the switch on asks the radio and says it is starting', () => {
    const step = reduceHotspot(hotspotOff, { type: 'arm' });
    expect(step.model.phase).toBe('starting');
    expect(step.effects).toEqual(['start-hotspot']);
  });

  test('a second flip WHILE STARTING does not ask the radio twice', () => {
    // THE LOAD-BEARING ONE. Mutation: drop the phase guard in 'arm' and a
    // double tap spends the app's single allowed request, leaving the
    // second callback with nobody waiting on it and the switch describing
    // a radio state that never happened.
    expect(allEffects([{ type: 'arm' }, { type: 'arm' }])).toEqual([
      'start-hotspot',
    ]);
  });

  test('a flip while it is already ON keeps the live network', () => {
    // Mutation: re-arm from 'on' and a working hotspot with podmates on it
    // is torn down and rebuilt with a different name mid-call.
    expect(
      allEffects([
        { type: 'arm' },
        { type: 'started', creds: CREDS },
        { type: 'arm' },
      ]),
    ).toEqual(['start-hotspot']);
  });

  test('credentials land as the on state, carrying exactly what was read', () => {
    const { model } = run([{ type: 'arm' }, { type: 'started', creds: CREDS }]);
    expect(model.phase).toBe('on');
    expect(model.creds).toEqual(CREDS);
    expect(model.reason).toBeNull();
  });

  test('a start with an empty name is a failure, not a QR of nothing', () => {
    // Mutation: pass an empty SSID straight through and the card draws a
    // scannable code for the network `WIFI:T:WPA;S:;P:...;;` — every phone
    // that scans it fails to find anything, in front of the person who
    // just asked them to scan.
    const { model, effects } = run([
      { type: 'arm' },
      { type: 'started', creds: { ...CREDS, ssid: '' } },
    ]);
    expect(model.phase).toBe('failed');
    expect(model.reason).toBe('no-credentials');
    expect(effects).toEqual(['stop-hotspot']);
  });

  test('a late start after the switch went off does not resurrect the card', () => {
    // Mutation: accept 'started' from any phase and a hotspot the camper
    // turned off comes back on screen with a QR, while the radio is
    // already being torn down.
    const { model } = run([
      { type: 'arm' },
      { type: 'disarm' },
      { type: 'started', creds: CREDS },
    ]);
    expect(model.phase).toBe('off');
    expect(model.creds).toBeNull();
  });

  test('turning it off stops the radio — including mid-start', () => {
    // Mutation: only stop from 'on' and a reservation that lands a beat
    // after the switch went off broadcasts an access point nobody can see
    // and nobody can turn off, on the owner's battery.
    expect(allEffects([{ type: 'arm' }, { type: 'disarm' }])).toEqual([
      'start-hotspot',
      'stop-hotspot',
    ]);
  });

  test('turning off a FAILED card stops nothing — there is nothing running', () => {
    expect(
      allEffects([
        { type: 'arm' },
        { type: 'failed', reason: 'no-channel' },
        { type: 'disarm' },
      ]),
    ).toEqual(['start-hotspot']);
  });

  test('the system taking it away lands in failed, never quietly in off', () => {
    // Mutation: map 'stopped-outside' to hotspotOff and the QR simply
    // vanishes. Everyone standing there with a camera up learns nothing,
    // and the host has no idea the network died.
    const { model } = run([
      { type: 'arm' },
      { type: 'started', creds: CREDS },
      { type: 'stopped-outside' },
    ]);
    expect(model.phase).toBe('failed');
    expect(model.reason).toBe('stopped');
    expect(model.creds).toBeNull();
  });

  test('a stray teardown event while off changes nothing', () => {
    const { model } = run([{ type: 'stopped-outside' }]);
    expect(model).toEqual(hotspotOff);
  });

  test('a failure reported while off is ignored, not rendered', () => {
    const { model } = run([{ type: 'failed', reason: 'error' }]);
    expect(model).toEqual(hotspotOff);
  });

  test('dismissing a failure clears the reason with it', () => {
    // Mutation: keep the reason on dismiss and a stale sentence reappears
    // the next time the card renders anything at all.
    const { model } = run([
      { type: 'arm' },
      { type: 'failed', reason: 'no-permission' },
      { type: 'dismiss' },
    ]);
    expect(model).toEqual(hotspotOff);
  });

  test('the failure detail survives the trip when there is one', () => {
    const { model } = run([
      { type: 'arm' },
      { type: 'failed', reason: 'error', detail: 'code 1' },
    ]);
    expect(model.detail).toBe('code 1');
  });
});

describe('stop while starting owes a late arrival CLOSED', () => {
  test('nothing in JS can reach a late reservation — which is why Kotlin must', () => {
    // THE WHOLE CASE FOR THE NATIVE GUARD, stated from this side. The stop
    // effect fires at 'disarm', while the reservation does not exist yet;
    // the 'started' that lands afterwards produces NO further effect,
    // because the reducer is right to ignore it. So there is no second
    // stop coming, ever. The access point that lands after that point can
    // only be closed where it lands, by the callback holding it.
    expect(
      allEffects([
        { type: 'arm' },
        { type: 'disarm' },
        { type: 'started', creds: CREDS },
      ]),
    ).toEqual(['start-hotspot', 'stop-hotspot']);
  });

  test('the cancelled answer lands on a card that stays off', () => {
    // Mutation: render 'failed' from 'off' and the receipt for a hotspot
    // the camper switched off paints a refusal onto a card they already
    // finished with.
    const { model } = run([
      { type: 'arm' },
      { type: 'disarm' },
      { type: 'failed', reason: 'cancelled' },
    ]);
    expect(model).toEqual(hotspotOff);
  });

  test('stop() bumps the request generation even with nothing to close', () => {
    // THE P1, at its root. Mutation: leave stop() a no-op while the
    // reservation is still null (its shape before this fix) and the switch
    // going off DURING start records nothing anywhere. The reservation
    // lands a beat later, is stored as a live hotspot, and broadcasts on
    // the owner's battery with no switch on screen bound to it — invisible
    // until the phone reboots.
    const stop = between(readSource(KT), 'fun stop(promise: Promise)', 'if (live == null)');
    expect(stop).toMatch(/generation\.incrementAndGet\(\)/);
    // ...and the bump is BEFORE the reservation is read, so the null case
    // (a start still in flight) cannot skip past it.
    expect(stop.indexOf('generation.incrementAndGet()')).toBeLessThan(
      stop.indexOf('val live = reservation'),
    );
  });

  test('every start captures the generation it belongs to', () => {
    // Mutation: read the counter at callback time instead of capturing it
    // and every callback always looks current — the guard is decorative.
    const kt = readSource(KT);
    expect(kt).toMatch(
      /val gen = generation\.incrementAndGet\(\)[\s\S]{0,400}startLocalOnlyHotspot\(/,
    );
  });

  test('a late onStarted closes its reservation and never stores it', () => {
    // THE HALF-ARC PIN. Mutation: store the reservation before comparing
    // the generation and the module owns an access point the card cannot
    // see; drop the close and it broadcasts with nobody holding it at all.
    const onStarted = between(
      readSource(KT),
      'override fun onStarted(',
      'override fun onFailed(',
    );
    expect(onStarted).toContain('generation.get() != gen');
    expect(onStarted).toContain('closeQuietly(res)');
    expect(onStarted.indexOf('closeQuietly(res)')).toBeLessThan(
      onStarted.indexOf('reservation = res'),
    );
    // It returns before it can store or describe anything...
    expect(onStarted).toMatch(/closeQuietly\(res\)[\s\S]{0,120}return/);
    // ...and it says which refusal this was, so the promise cannot strand.
    expect(onStarted).toMatch(/fail\("cancelled"\)/);
  });

  test('a cancelled request emits no teardown event to a card that is off', () => {
    // Mutation: emit the stopped event unconditionally and closing our own
    // stale reservation (which calls onStopped straight back) announces a
    // system teardown — repainting a card that is correctly showing
    // nothing, or flipping a re-armed one into the wrong reason.
    const onStopped = between(readSource(KT), 'override fun onStopped(', 'handler,');
    expect(onStopped).toContain('generation.get() == gen');
    // Both anchors asserted PRESENT before they are ordered: a missing
    // guard indexes to -1, which sorts before everything and would let the
    // ordering assertion pass over a guard that is not there at all.
    expect(onStopped).toContain('if (!current) {');
    expect(onStopped).toContain('emit(EVENT_STOPPED');
    expect(onStopped.indexOf('if (!current) {')).toBeLessThan(
      onStopped.indexOf('emit(EVENT_STOPPED'),
    );
  });

  test('a React teardown cancels the request as well as the reservation', () => {
    // Mutation: close only what is held and a dev reload during start
    // leaves the phone hosting for a module with no JS side left.
    const kt = readSource(KT);
    expect(kt).toMatch(
      /override fun invalidate\(\)\s*\{\s*generation\.incrementAndGet\(\)/,
    );
  });
});

describe('a refusal after the radio came up closes the radio', () => {
  test('a post-start failure closes and forgets before it reports', () => {
    // THE P2. Mutation: return the no-credentials failure with the
    // reservation still held and the card shows 'failed' — which every
    // other reason means "nothing is running" — while the access point is
    // still up, with no switch anywhere bound to it.
    const fn = between(
      readSource(KT),
      'private fun describeOrClose(',
      'private fun describeReservation(',
    );
    expect(fn).toMatch(/getBoolean\("ok"\)/);
    expect(fn).toMatch(/closeQuietly\(res\)[\s\S]{0,120}reservation = null/);
  });

  test('nothing hands a reservation to JS except through that close', () => {
    // Mutation: answer with the raw read on either path — the first read
    // after onStarted, or the idempotent re-read of a live one — and the
    // failure escapes without the close attached to it.
    const kt = readSource(KT);
    const onStarted = between(kt, 'override fun onStarted(', 'override fun onFailed(');
    expect(onStarted).toContain('answer(describeOrClose(res))');
    expect(onStarted).not.toContain('answer(describeReservation(');
    expect(kt).toContain('promise.resolve(describeOrClose(live))');
    expect(kt).not.toContain('promise.resolve(describeReservation(');
  });

  test('the empty-credentials arc is a refusal on BOTH sides of the seam', () => {
    // The reducer's half of the same law: an empty SSID is 'failed' AND a
    // stop effect, so even a native half that somehow kept the radio gets
    // told to let go of it.
    const { model, effects } = run([
      { type: 'arm' },
      { type: 'started', creds: { ...CREDS, ssid: '' } },
    ]);
    expect(model.phase).toBe('failed');
    expect(effects).toEqual(['stop-hotspot']);
    expect(readSource(KT)).toMatch(/return fail\("no-credentials"\)/);
  });
});

describe('the grouped permission ask Android 12 actually requires', () => {
  const ask = () =>
    between(readSource(TSX_CARD), 'async function runStart(', 'await startCampHotspot');

  test('below 13 both location grants go in ONE request', () => {
    // THE P1. Mutation: ask for ACCESS_FINE_LOCATION alone (its shape
    // before this fix) and Android 12 — API 31 and 32 — ignores the
    // request outright: no dialog appears, the callback returns denied,
    // and a clean install reports 'no-permission' forever for a grant the
    // camper was never once offered. The native half agrees there is no
    // permission, so nothing anywhere looks broken.
    const src = ask();
    expect(src).toMatch(/Number\(Platform\.Version\) >= 33/);
    expect(src).toMatch(
      /requestMultiple\(\[\s*PermissionsAndroid\.PERMISSIONS\.ACCESS_FINE_LOCATION,\s*PermissionsAndroid\.PERMISSIONS\.ACCESS_COARSE_LOCATION,?\s*\]\)/,
    );
    // ...and FINE is never asked for on its own again.
    expect(src).not.toMatch(/request\(\s*PermissionsAndroid\.PERMISSIONS\.ACCESS_FINE_LOCATION/);
  });

  test('the 33+ branch still asks the one permission that era uses', () => {
    // Mutation: send the location pair to Android 13+ and the ask is for a
    // grant that no longer governs this API — the dialog is answered, the
    // radio still refuses.
    const src = ask();
    expect(src).toMatch(
      /Version\) >= 33[\s\S]{0,160}PermissionsAndroid\.PERMISSIONS\.NEARBY_WIFI_DEVICES/,
    );
    expect(src.indexOf('NEARBY_WIFI_DEVICES')).toBeLessThan(
      src.indexOf('requestMultiple'),
    );
  });

  test('approximate-only is a refusal, because precise is what the radio needs', () => {
    // Mutation: accept the grouped result when EITHER grant lands and an
    // "Approximate" tap reports success into a native half that checks
    // ACCESS_FINE_LOCATION and refuses — the card contradicts itself, and
    // the camper is told to allow something they just allowed.
    expect(ask()).toMatch(
      /got\[PermissionsAndroid\.PERMISSIONS\.ACCESS_FINE_LOCATION\][\s\S]{0,80}RESULTS\.GRANTED/,
    );
    expect(readSource(KT)).toContain('Manifest.permission.ACCESS_FINE_LOCATION');
  });

  test('the refusal copy carries what the lost rationale dialog used to say', () => {
    // Mutation: leave the sentence naming only "nearby Wi-Fi" and an
    // Android 12 camper meets a LOCATION dialog for a Wi-Fi feature with
    // no explanation anywhere — requestMultiple has no rationale argument,
    // so this copy is the only surface left that can say why, and that
    // nothing about their position goes anywhere.
    const perm = hotspotReasonCopy('no-permission');
    expect(perm).toMatch(/Location/);
    expect(perm).toMatch(/precise/i);
    expect(perm).toMatch(/position/i);
  });

  test('both names are declared, or neither dialog can appear', () => {
    // Mutation: ask for a permission the manifest does not carry and
    // Android denies it without asking anyone anything.
    const manifest = readSource(MANIFEST);
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION');
  });
});

describe('the QR is the join flow, so its escaping IS the feature', () => {
  test('the payload is the WIFI: format every phone camera already reads', () => {
    expect(wifiQrPayload(CREDS)).toBe(
      'WIFI:T:WPA;S:AndroidShare_4417;P:dusty7horse;;',
    );
  });

  test('a semicolon in the password cannot end the field early', () => {
    // THE LOAD-BEARING ESCAPE. Mutation: drop ';' from the escape set and
    // the scanner reads the password as everything before the semicolon,
    // then offers to join. It looks exactly like a typo, in the dark, with
    // no way to tell the difference.
    const out = wifiQrPayload({ ...CREDS, passphrase: 'a;b' });
    expect(out).toBe('WIFI:T:WPA;S:AndroidShare_4417;P:a\\;b;;');
    expect(out).not.toContain('P:a;b');
  });

  test('a colon in the network name is escaped too', () => {
    expect(wifiQrPayload({ ...CREDS, ssid: 'camp:hq' })).toContain(
      'S:camp\\:hq;',
    );
  });

  test('a comma and a quote are escaped', () => {
    expect(escapeWifiField('a,b"c')).toBe('a\\,b\\"c');
  });

  test('backslash is escaped FIRST, so an escape is never escaped twice', () => {
    // Mutation: run the backslash replacement after the delimiters and the
    // '\;' this code just wrote becomes '\\;' — the reader then sees a
    // literal backslash followed by an UNESCAPED field terminator, which
    // is the exact truncation the escaping exists to prevent.
    expect(escapeWifiField('a\\;b')).toBe('a\\\\\\;b');
    expect(escapeWifiField('\\')).toBe('\\\\');
  });

  test('an all-hex network name is quoted so it is not read as raw bytes', () => {
    // Mutation: drop the quoting and a hotspot named 'AB12CD' is decodable
    // as three bytes of hex; a conforming reader is entitled to join a
    // network whose name is nonsense.
    expect(wifiQrPayload({ ...CREDS, ssid: 'AB12CD' })).toContain('S:"AB12CD";');
    // ...and a name that merely LOOKS hexish but is odd-length or has a
    // non-hex character stays unquoted, so ordinary names are untouched.
    expect(wifiQrPayload({ ...CREDS, ssid: 'ABC' })).toContain('S:ABC;');
    expect(wifiQrPayload({ ...CREDS, ssid: 'AndroidShare_4417' })).toContain(
      'S:AndroidShare_4417;',
    );
  });

  test('an open network gets nopass and NO password field at all', () => {
    // Mutation: emit 'P:;' for an open network and some readers prompt for
    // a password the network does not have.
    const out = wifiQrPayload({ ssid: 'open-camp', passphrase: '', security: 'open' });
    expect(out).toBe('WIFI:T:nopass;S:open-camp;;');
    expect(out).not.toContain('P:');
  });

  test('an empty passphrase is treated as open even when the type says WPA', () => {
    expect(
      wifiQrPayload({ ssid: 'x', passphrase: '', security: 'wpa2' }),
    ).toBe('WIFI:T:nopass;S:x;;');
  });

  test('WPA3-only says SAE; transition mode says WPA, which is its whole point', () => {
    expect(wifiQrPayload({ ...CREDS, security: 'wpa3' })).toContain('T:SAE;');
    expect(wifiQrPayload({ ...CREDS, security: 'wpa3-transition' })).toContain(
      'T:WPA;',
    );
  });

  test('there is no code until the hotspot is actually up', () => {
    // Mutation: render the payload from creds regardless of phase and a
    // stale QR outlives the network it names.
    expect(hotspotQrPayload(hotspotOff)).toBeNull();
    expect(
      hotspotQrPayload(reduceHotspot(hotspotOff, { type: 'arm' }).model),
    ).toBeNull();
    const on = run([{ type: 'arm' }, { type: 'started', creds: CREDS }]).model;
    expect(hotspotQrPayload(on)).toBe(wifiQrPayload(CREDS));
    const dead = reduceHotspot(on, { type: 'stopped-outside' }).model;
    expect(hotspotQrPayload(dead)).toBeNull();
  });
});

describe('every refusal has its own sentence', () => {
  const REASONS: HotspotReason[] = [
    'absent',
    'ios',
    'os-too-old',
    'no-hardware',
    'no-permission',
    'location-off',
    'no-channel',
    'incompatible-mode',
    'tethering-off',
    'busy',
    'no-credentials',
    'cancelled',
    'stopped',
    'generic',
    'error',
  ];

  test('none of them is empty, and none of them is a stack trace', () => {
    for (const r of REASONS) {
      const copy = hotspotReasonCopy(r);
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).not.toMatch(/undefined|null|Exception|error code/i);
    }
    // Guard the guard: an empty list would pass every assertion above.
    expect(REASONS.length).toBe(15);
  });

  test('being switched off mid-start is not the system taking it away', () => {
    // Mutation: answer a cancelled request with 'stopped' and a camper who
    // turned the switch off is told something else on their phone seized
    // the Wi-Fi — sending them hunting a problem they created on purpose.
    const cancelled = hotspotReasonCopy('cancelled');
    expect(cancelled).not.toBe(hotspotReasonCopy('stopped'));
    expect(cancelled).toMatch(/switched off while it was still starting/);
    expect(isHotspotReason('cancelled')).toBe(true);
  });

  test('the permission sentence and the location sentence are different', () => {
    // Mutation: collapse them into one "check your permissions" and a
    // camper who already granted the permission is told to grant it again,
    // which is how a working app gets read as broken.
    const perm = hotspotReasonCopy('no-permission');
    const loc = hotspotReasonCopy('location-off');
    expect(perm).not.toBe(loc);
    expect(loc).toMatch(/Location/);
    expect(perm).toMatch(/permission/i);
  });

  test('the one fixable radio refusal says the fix out loud', () => {
    // no-channel is almost always "this phone is on a Wi-Fi network", and
    // that is a ten-second fix a camper can actually make.
    expect(hotspotReasonCopy('no-channel')).toMatch(/disconnect/i);
  });

  test('an iPhone is told it joins rather than hosts, and how', () => {
    expect(hotspotReasonCopy('ios')).toMatch(/camera/i);
    expect(hotspotReasonCopy('ios')).toBe(hotspotReasonCopy('absent'));
  });

  test('ok has nothing to say', () => {
    expect(hotspotReasonCopy('ok')).toBe('');
  });
});

describe('the native seam never rejects', () => {
  const seamWith = (stub: unknown) => {
    (NativeModules as unknown as Record<string, unknown>).CampHotspot = stub;
    let seam: typeof import('../src/crews/campHotspot');
    jest.isolateModules(() => {
      seam = require('../src/crews/campHotspot');
    });
    return seam!;
  };

  afterEach(() => {
    delete (NativeModules as unknown as Record<string, unknown>).CampHotspot;
  });

  test('no native module at all is an answer, not a crash', async () => {
    const seam = seamWith(undefined);
    expect(seam.campHotspotPresent()).toBe(false);
    await expect(seam.describeCampHotspot()).resolves.toEqual({
      supported: false,
      // Platform.OS is 'ios' under the react-native jest preset, which is
      // exactly the arm an iPhone takes in the field.
      reason: 'ios',
    });
    await expect(seam.startCampHotspot()).resolves.toEqual({
      ok: false,
      reason: 'ios',
    });
    await expect(seam.stopCampHotspot()).resolves.toBeUndefined();
  });

  test('a refusal keeps its own reason all the way to the caller', async () => {
    // Mutation: let the seam map anything non-ok to 'error' and eleven
    // actionable sentences become one shrug.
    const seam = seamWith({
      start: async () => ({ ok: false, reason: 'no-channel', detail: 'code 2' }),
    });
    await expect(seam.startCampHotspot()).resolves.toEqual({
      ok: false,
      reason: 'no-channel',
      detail: 'code 2',
    });
  });

  test('a native call that THROWS becomes a reason, not an unhandled rejection', async () => {
    const seam = seamWith({
      describe: async () => {
        throw new Error('boom');
      },
      start: async () => {
        throw new Error('boom');
      },
      stop: async () => {
        throw new Error('boom');
      },
    });
    await expect(seam.describeCampHotspot()).resolves.toEqual({
      supported: false,
      reason: 'error',
    });
    const started = await seam.startCampHotspot();
    expect(started).toMatchObject({ ok: false, reason: 'error', detail: 'boom' });
    await expect(seam.stopCampHotspot()).resolves.toBeUndefined();
  });

  test('a reason string the JS side does not know becomes error, never itself', async () => {
    // Mutation: pass the raw string through and an unknown token from a
    // future native build reaches hotspotReasonCopy, whose exhaustive
    // switch returns undefined — a blank card where a sentence goes.
    const seam = seamWith({ start: async () => ({ ok: false, reason: 'wat' }) });
    const r = await seam.startCampHotspot();
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  test('an ok start with no ssid is a refusal, not a hotspot with no name', async () => {
    const seam = seamWith({ start: async () => ({ ok: true, ssid: '' }) });
    expect(await seam.startCampHotspot()).toMatchObject({ ok: false });
  });

  test('every security the native half can report survives the crossing', async () => {
    for (const security of ['open', 'wpa2', 'wpa3', 'wpa3-transition']) {
      const seam = seamWith({
        start: async () => ({ ok: true, ssid: 's', passphrase: 'p', security }),
      });
      const r = await seam.startCampHotspot();
      expect(r).toEqual({
        ok: true,
        creds: { ssid: 's', passphrase: 'p', security },
      });
    }
    // ...and anything else falls to the conservative WPA2 rather than a
    // QR type no reader understands.
    const odd = seamWith({
      start: async () => ({ ok: true, ssid: 's', passphrase: 'p', security: 'wep' }),
    });
    expect((await odd.startCampHotspot()) as { creds: HotspotCreds }).toMatchObject({
      creds: { security: 'wpa2' },
    });
  });

  test('the probe reports support without promising success', async () => {
    const seam = seamWith({
      describe: async () => ({ supported: true, reason: 'ok', running: false, sdkInt: 34 }),
    });
    await expect(seam.describeCampHotspot()).resolves.toEqual({
      supported: true,
      reason: 'ok',
      running: false,
      sdkInt: 34,
    });
  });
});

describe('what the card actually says', () => {
  const render = (props: Partial<React.ComponentProps<typeof CampHotspotView>>) => {
    let tree: { root: { findAllByType: (t: string) => unknown[] } } | null = null;
    TestRenderer.act(() => {
      tree = TestRenderer.create(
        <CampHotspotView
          model={hotspotOff}
          supported
          unsupportedReason={null}
          onArm={() => {}}
          onDisarm={() => {}}
          onDismiss={() => {}}
          {...props}
        />,
      );
    });
    return tree!;
  };

  const text = (tree: unknown): string =>
    JSON.stringify((tree as { toJSON: () => unknown }).toJSON());

  test('it says WHY before it says how — capability, not jargon', () => {
    // Mutation: drop the why line and the card is a switch labelled
    // "hotspot" on a pod card, which nobody turns on.
    expect(HOTSPOT_WHY).toMatch(/Video calls need a shared Wi-Fi/);
    expect(HOTSPOT_WHY).toMatch(/no internet/i);
    expect(text(render({}))).toContain('Video calls need a shared Wi-Fi');
  });

  test('a phone that cannot host shows the reason instead of a dead switch', () => {
    // Mutation: render the switch anyway and an iPhone offers to host a
    // network it can never make.
    const out = text(render({ supported: false, unsupportedReason: 'ios' }));
    expect(out).toContain('an iPhone joins one');
    expect(out).not.toContain('Host it on this phone');
  });

  test('starting says so out loud rather than showing nothing', () => {
    const model = reduceHotspot(hotspotOff, { type: 'arm' }).model;
    expect(text(render({ model }))).toContain('Starting the hotspot');
  });

  test('the live card carries the code AND the name and password in text', () => {
    // Mutation: ship only the QR and the phone with a cracked lens, or the
    // Android whose Settings scanner will not focus, never gets on.
    const model = run([{ type: 'arm' }, { type: 'started', creds: CREDS }]).model;
    const out = text(render({ model }));
    expect(out).toContain(wifiQrPayload(CREDS));
    expect(out).toContain(CREDS.ssid);
    expect(out).toContain(CREDS.passphrase);
    expect(out).toMatch(/Camera app/);
    expect(out).toMatch(/Settings/);
  });

  test('the live card admits the battery cost and the walkie risk', () => {
    // Mutation: delete either sentence and the camper pays for a truth
    // nobody told them — a hot radio they cannot see, or a walkie that
    // went quiet for a reason the app knew and did not say.
    const model = run([{ type: 'arm' }, { type: 'started', creds: CREDS }]).model;
    const out = text(render({ model }));
    expect(out).toMatch(/battery/i);
    expect(out).toMatch(/walkie/i);
  });

  test('a failure shows its sentence and a way out', () => {
    const model = run([
      { type: 'arm' },
      { type: 'failed', reason: 'no-channel' },
    ]).model;
    const out = text(render({ model }));
    expect(out).toContain(hotspotReasonCopy('no-channel'));
    expect(out).not.toContain(wifiQrPayload(CREDS));
  });
});

describe('the native half is registered, guarded and speaks the same tokens', () => {
  test('the module is in the package list, or nothing on a real phone works', () => {
    // THE MOUNT PIN. Mutation: drop the registration and every call falls
    // to the 'absent' arm — which renders a polite iPhone sentence on an
    // Android that could have hosted perfectly well.
    expect(readSource(KT_APP)).toMatch(/add\(HotspotPackage\(\)\)/);
    expect(readSource(KT_PACKAGE)).toMatch(/listOf\(HotspotModule\(reactContext\)\)/);
  });

  test('the JS name and the Kotlin name are the same string', () => {
    // Mutation: rename either side and the seam silently reports 'absent'
    // forever, with no error anywhere.
    const name = /const val NAME = "([A-Za-z]+)"/.exec(readSource(KT))?.[1];
    expect(name).toBe('CampHotspot');
    expect(readSource(TS_SEAM)).toContain(`NativeModules.${name}`);
  });

  test('the teardown event is one string in two languages', () => {
    const kt = /const val EVENT_STOPPED = "([A-Za-z]+)"/.exec(readSource(KT))?.[1];
    expect(kt).toBe(HOTSPOT_STOPPED_EVENT);
  });

  test('every reason the Kotlin can emit is a reason the TypeScript knows', () => {
    // THE SHARP ONE. Mutation: add a native failure token without adding
    // it to the union and the seam maps it to 'error', throwing away the
    // one sentence that would have told the camper what to do.
    const kt = readSource(KT);
    const tokens = new Set<string>();
    for (const m of kt.matchAll(/fail\(\s*"([a-z0-9-]+)"/g)) {
      tokens.add(m[1]);
    }
    for (const m of kt.matchAll(/putString\("reason",\s*"([a-z0-9-]+)"\)/g)) {
      tokens.add(m[1]);
    }
    for (const m of kt.matchAll(/->\s*"([a-z0-9-]+)"\n/g)) {
      tokens.add(m[1]);
    }
    // Security types are not reasons; they cross on their own field.
    for (const s of ['open', 'wpa2', 'wpa3', 'wpa3-transition']) {
      tokens.delete(s);
    }
    // Guard the guard: an empty set satisfies every() vacuously.
    expect(tokens.size).toBeGreaterThanOrEqual(8);
    for (const t of tokens) {
      expect(isHotspotReason(t)).toBe(true);
    }
  });

  test('the permission asked matches the Android version, on both sides', () => {
    // Mutation: ask only for location on Android 13+ and the call throws
    // SecurityException on every modern phone; ask only for nearby-Wi-Fi
    // below 13 and the grant does not exist, so it can never be held.
    const kt = readSource(KT);
    expect(kt).toMatch(
      /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU[\s\S]{0,120}NEARBY_WIFI_DEVICES[\s\S]{0,120}ACCESS_FINE_LOCATION/,
    );
    // The card's two eras, in the same order — the shape of each ask (one
    // permission above 13, the location PAIR below it) is pinned in 'the
    // grouped permission ask Android 12 actually requires'.
    const card = readSource(TSX_CARD);
    expect(card).toMatch(
      /Platform\.Version\) >= 33[\s\S]{0,160}NEARBY_WIFI_DEVICES[\s\S]{0,600}ACCESS_FINE_LOCATION/,
    );
    // ...and the manifest actually declares both, or neither can be asked.
    const manifest = readSource(MANIFEST);
    expect(manifest).toContain('android.permission.NEARBY_WIFI_DEVICES');
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).toContain('android.permission.CHANGE_WIFI_STATE');
  });

  test('the API is version-guarded — minSdk is below the API that carries it', () => {
    // Mutation: call startLocalOnlyHotspot without the O guard and the app
    // dies with NoSuchMethodError on the Android 7 phones minSdk 24 admits.
    const kt = readSource(KT);
    expect(kt).toMatch(/Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.O/);
    expect(kt).toMatch(/startLocalOnlyHotspot\(/);
    const gradle = readSource('android/build.gradle');
    expect(/minSdkVersion = (\d+)/.exec(gradle)?.[1]).toBe('24');
  });

  test('the credentials read branches on the API that changed underneath it', () => {
    // Mutation: use getSoftApConfiguration unconditionally and Android 8-10
    // throws; use the legacy path without unquoting and the QR carries a
    // network name with literal quote marks in it.
    const kt = readSource(KT);
    expect(kt).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R/);
    expect(kt).toMatch(/softApConfiguration/);
    expect(kt).toMatch(/wifiConfiguration/);
    expect(kt).toMatch(/private fun unquote/);
  });

  test('the native half NEVER rejects a promise', () => {
    // Mutation: reject on failure and the JS catch collapses every
    // distinct, actionable reason into 'error' — the seam cannot tell a
    // refusal from a bug, and neither can the camper.
    const kt = readSource(KT);
    expect(kt).toMatch(/promise\.resolve\(/);
    expect(kt).not.toMatch(/promise\.reject\(/);
  });

  test('all four framework failure codes get their own token', () => {
    const kt = readSource(KT);
    expect(kt).toMatch(/ERROR_NO_CHANNEL -> "no-channel"/);
    expect(kt).toMatch(/ERROR_INCOMPATIBLE_MODE -> "incompatible-mode"/);
    expect(kt).toMatch(/ERROR_TETHERING_DISALLOWED -> "tethering-off"/);
    expect(kt).toMatch(/else -> "generic"/);
  });

  test('a React teardown closes the reservation', () => {
    // Mutation: drop the close and a dev reload (or a bridgeless restart)
    // leaves an access point broadcasting with no switch anywhere to turn
    // it off.
    const kt = readSource(KT);
    expect(kt).toMatch(/override fun invalidate\(\)[\s\S]{0,200}reservation\?\.close\(\)/);
  });

  test('the card is mounted on the pod card, beside the walkie', () => {
    // Mutation: build the whole feature and never mount it — a capability
    // with no caller, which every gate in this repo would still pass.
    const mount = readSource(TSX_MOUNT);
    expect(mount).toContain("import CampHotspotCard from './CampHotspotCard'");
    expect(mount).toMatch(/<CampHotspotCard \/>/);
  });

  test('the two truth surfaces point at the feature', () => {
    // Mutation: ship the hotspot and leave the failure copy saying only
    // "a call needs both phones on the same Wi-Fi" — the camper reads the
    // limit and never learns the app can lift it.
    const { callEndedCopy } = require('../src/crews/videoCall');
    expect(callEndedCopy('no-path', 'Dusty')).toMatch(/Camp hotspot/);
    // ...and the pre-existing pin still holds: the limit is still stated.
    expect(callEndedCopy('no-path', 'Dusty')).toMatch(/same Wi-Fi/);
    const help = readSource('src/help/helpContent.ts');
    expect(help).toMatch(/Camp hotspot/);
  });
});
