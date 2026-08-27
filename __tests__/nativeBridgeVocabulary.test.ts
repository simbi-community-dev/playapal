/**
 * THE BRIDGE IS A HARDCODE ON BOTH SIDES, AND NOTHING JOINED THEM.
 *
 * A React Native event name is a string typed twice — once in Kotlin or Swift
 * where it is emitted, once in TypeScript where it is listened for — and the
 * two files cannot import each other. Rename one side and nothing throws,
 * nothing fails to compile, and no test goes red. The listener simply never
 * fires: beacons stop being seen, a beam never ingests, the hotspot card never
 * learns it stopped. The feature is gone and the suite is green.
 *
 * The same is true of the VOCABULARIES that cross the bridge. HotspotModule.kt
 * decides which reason string to emit; campHotspot.ts decides which reason
 * strings it will accept. If Kotlin gains a reason TypeScript does not know,
 * `isHotspotReason` rejects it and the camper is told nothing useful about why
 * their hotspot failed — at exactly the moment they are standing in dust
 * trying to make it work.
 *
 * WHAT THIS SUITE DOES NOT COVER, said plainly rather than implied: the walkie
 * bridge (WalkiePeers / WalkieSignal / WalkieSpeaking) is deliberately absent.
 * That lane is under active native work on both platforms, and a guard that
 * goes red on someone else's in-flight edit is a guard they will delete. Its
 * parity is held by iosMeshParity and by that lane's own suites.
 *
 * Names are read from SOURCE TEXT, which is the only place a bridge string
 * exists on both sides. That makes this suite blind to a name built by
 * concatenation — it would not see `"Crew" + "BeaconTick"`. Every current
 * emitter writes the literal, and this comment is here so the next person who
 * reaches for concatenation knows what it costs.
 */
const fsn = require('fs');
const pathn = require('path');

function walk(dir: string, ext: RegExp): string[] {
  if (!fsn.existsSync(dir)) {
    return [];
  }
  return fsn.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const full = pathn.join(dir, e.name);
    if (e.isDirectory()) {
      return ['build', 'Pods', 'node_modules'].includes(e.name) ? [] : walk(full, ext);
    }
    return ext.test(e.name) ? [full] : [];
  });
}

const ANDROID = walk('android/app/src/main/java', /\.kt$/);
const IOS = walk('ios/PlayaPal', /\.swift$/);
const NATIVE = [...ANDROID, ...IOS];
const TS_FILES = [...walk('src', /\.(ts|tsx)$/), 'App.tsx'];

const read = (f: string): string => fsn.readFileSync(f, 'utf8');

/**
 * Whole quoted literal, never a substring — and this cost a control to learn.
 * The first version asked `text.includes(name)`, so renaming
 * "PlayaPalBeamIngress" to "PlayaPalBeamIngressV2" left the guard GREEN: the
 * old name is still present, inside the new one. A rename that EXTENDS a name
 * is the most likely rename there is (V2, Ex, 2), and it was the exact case
 * the check could not see.
 */
const hasLiteral = (text: string, name: string): boolean =>
  new RegExp(`["'\`]${name}["'\`]`).test(text);
const androidText = ANDROID.map(read).join('\n');
const iosText = IOS.map(read).join('\n');
const nativeText = [androidText, iosText].join('\n');
const tsText = TS_FILES.map(read).join('\n');

/**
 * Bridge events this app depends on, excluding the walkie lane (see header),
 * each with the platforms that MUST emit it.
 *
 * PER-PLATFORM, and that is not pedantry. A first version asked only "does any
 * native file still contain this name", so renaming it in Android while iOS
 * kept the old spelling left the guard GREEN with Android's listener dead. The
 * platforms drift one at a time — that is the whole failure mode — so they are
 * checked one at a time. `ios: false` is a claim too: it says this event is
 * deliberately Android-only, and it is how an iOS implementation landing under
 * a DIFFERENT name gets noticed instead of silently coexisting.
 */
const BRIDGE_EVENTS: { name: string; android: boolean; ios: boolean }[] = [
  { name: 'CrewBeaconSighting', android: true, ios: true },
  { name: 'CrewBeaconState', android: true, ios: true },
  { name: 'CrewBeaconTick', android: true, ios: false },
  { name: 'CrewSyncWant', android: true, ios: true },
  { name: 'CrewSyncServed', android: true, ios: true },
  { name: 'campHotspotStopped', android: true, ios: false },
  { name: 'PlayaPalBeamIngress', android: true, ios: true },
  { name: 'PlayaPalShareAppProgress', android: true, ios: false },
];

/**
 * The strings Kotlin can put in the hotspot `reason` field.
 *
 * THREE EMISSION SHAPES, and reading only one is how this check nearly shipped
 * inspecting a third of the vocabulary while reporting itself green. The first
 * version matched `putString("reason", "x")` and found 5 of 13 — the rest go
 * through a `fail(reason)` helper, or through `failureToken(code)`, which maps
 * an Android error int onto a token. The subset arm below PASSED on those 5,
 * which is the shape of a guard that looks careful and is not.
 */
function kotlinHotspotReasons(): string[] {
  const src = read('android/app/src/main/java/com/playapal/HotspotModule.kt');
  const found = new Set<string>();
  for (const re of [
    /putString\(\s*"reason"\s*,\s*"([a-z0-9-]+)"/g, // written straight into the map
    /\bfail\(\s*"([a-z0-9-]+)"/g, // through the fail() helper
    /"([a-z0-9-]+)"\s*$/gm, // the failureToken when-arms, filtered below
  ]) {
    for (const m of src.matchAll(re)) {
      found.add(m[1]);
    }
  }
  // The third pattern is deliberately broad, so keep only what the TS side
  // recognises as a reason plus anything the other two shapes already proved.
  const declared = new Set(tsUnion('REASONS'));
  const direct = new Set(
    [
      ...src.matchAll(/putString\(\s*"reason"\s*,\s*"([a-z0-9-]+)"/g),
      ...src.matchAll(/\bfail\(\s*"([a-z0-9-]+)"/g),
    ].map(m => m[1]),
  );
  return [...found].filter(r => direct.has(r) || declared.has(r));
}

/** A declared `readonly string[]` union in campHotspot.ts. */
function tsUnion(name: string): string[] {
  const m = new RegExp(`const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`).exec(
    read('src/crews/campHotspot.ts'),
  );
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
}

describe('a name that crosses the bridge is spelled the same on both sides', () => {
  test('the readers work — POSITIVE AND NEGATIVE CONTROLS', () => {
    // Corpora must be real, or every arm below passes over nothing.
    expect(NATIVE.length).toBeGreaterThan(10);
    expect(TS_FILES.length).toBeGreaterThan(50);
    expect(nativeText.length).toBeGreaterThan(10_000);
    // A name that exists must be found on both sides...
    expect(hasLiteral(nativeText, 'CrewBeaconSighting')).toBe(true);
    expect(hasLiteral(tsText, 'CrewBeaconSighting')).toBe(true);
    // ...and one that cannot exist must be found on neither.
    expect(hasLiteral(nativeText, 'ZzzNoSuchBridgeEvent')).toBe(false);
    expect(hasLiteral(tsText, 'ZzzNoSuchBridgeEvent')).toBe(false);
    // ...and a name EXTENDED by a rename must NOT satisfy the original, which
    // a substring check would happily do.
    expect(hasLiteral('emit("CrewBeaconSightingV2")', 'CrewBeaconSighting')).toBe(false);
    // The union reader must return a real union, not an empty list that
    // makes the subset arms vacuously true.
    expect(tsUnion('REASONS').length).toBeGreaterThan(5);
    expect(tsUnion('SECURITIES').length).toBeGreaterThan(2);
    expect(tsUnion('NO_SUCH_UNION')).toEqual([]);
    // And the Kotlin reason reader must actually find reasons.
    // PINNED, not merely non-empty: 14 reasons across three emission shapes
    // ('cancelled' joined at the 0.8.4 hotspot cure — the fold that caught
    // this pin being authored against a lane missing that landing).
    // If this number moves, either a reason was added (check the TS union and
    // the copy that renders it) or a FOURTH emission shape appeared that this
    // reader cannot see — and the second is the failure that hides the first.
    expect(kotlinHotspotReasons().sort()).toEqual(
      [
        'busy', 'cancelled', 'error', 'generic', 'incompatible-mode',
        'location-off', 'no-channel', 'no-credentials', 'no-hardware',
        'no-permission', 'ok', 'os-too-old', 'stopped', 'tethering-off',
      ].sort(),
    );
  });

  test('every bridge event name exists on BOTH sides', () => {
    // Mutation: rename one side and this fails naming it. Nothing else in the
    // repo would — the listener just stops firing.
    const oneSided: string[] = [];
    for (const e of BRIDGE_EVENTS) {
      if (!hasLiteral(tsText, e.name)) {
        oneSided.push(`${e.name}: no TypeScript listener — nothing consumes it`);
      }
      if (e.android && !hasLiteral(androidText, e.name)) {
        oneSided.push(`${e.name}: absent from Android — its listener is dead there`);
      }
      if (e.ios && !hasLiteral(iosText, e.name)) {
        oneSided.push(`${e.name}: absent from iOS — its listener is dead there`);
      }
      if (!e.ios && hasLiteral(iosText, e.name)) {
        oneSided.push(`${e.name}: now present on iOS — recorded as Android-only; update the table`);
      }
    }
    expect(
      oneSided.length === 0
        ? []
        : [
            'A bridge event name is a string typed twice and joined by nothing.',
            'Renamed on one side, the listener silently never fires.',
            ...oneSided,
          ],
    ).toEqual([]);
  });

  test('every hotspot reason Kotlin can emit is one TypeScript accepts', () => {
    // The direction that matters: an unknown reason from native is rejected by
    // isHotspotReason, and the camper is told nothing useful about the failure.
    // The reverse (TS knowing reasons Kotlin never sends) is correct — 'ios'
    // and 'absent' are decided on the JS side.
    const known = new Set(tsUnion('REASONS'));
    const unknown = kotlinHotspotReasons().filter(r => !known.has(r));
    expect(
      unknown.length === 0
        ? []
        : [
            'HotspotModule.kt emits these reasons; campHotspot.ts rejects them,',
            'so the card falls back to a message that explains nothing. Add them',
            'to REASONS (and to the copy that renders them).',
            ...unknown,
          ],
    ).toEqual([]);
  });

  test('every hotspot security type Kotlin can emit is one TypeScript accepts', () => {
    const src = read('android/app/src/main/java/com/playapal/HotspotModule.kt');
    const emitted = [
      ...new Set(
        [...src.matchAll(/SECURITY_TYPE_[A-Z_0-9]+\s*->\s*"([a-z0-9-]+)"/g)].map(m => m[1]),
      ),
    ];
    expect(emitted.length).toBeGreaterThan(1); // the mapping must be found at all
    const known = new Set(tsUnion('SECURITIES'));
    expect(emitted.filter(s => !known.has(s))).toEqual([]);
  });
});

export {};
