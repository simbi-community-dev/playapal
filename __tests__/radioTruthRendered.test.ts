/**
 * THE RADIO STATE HAS TO REACH A HUMAN, not just exist.
 *
 * `src/crews/session.ts` carries a correct interruption state machine, three
 * named reasons, and its own tests — and shipped with ZERO production
 * readers. So with Bluetooth off, the pod card still said "your pod sees
 * which way and how far" and Settings still said "Sharing is ON right now —
 * your pod can see your position." Both false. The only honest surface in the
 * app was the foreground-service notification, which is the one place a
 * camper is not looking.
 *
 * The commit that introduced the state machine was titled "sharing tells the
 * truth when the radio drops". It shipped a UI that lies — because a seam
 * with no caller is a feature that does not exist, and a suite that only
 * tests the seam cannot tell the difference.
 *
 * THE INVARIANT: a worker that died silently must never render as
 * in-progress. These surfaces inferred "carrying" from the ABSENCE of a stop
 * signal, and absence has two causes — still carrying, and died without
 * saying so.
 *
 * These are source assertions rather than renders because the failure was
 * STRUCTURAL (nobody called the accessor), and because a render assertion
 * scoped to a whole screen is satisfied by any matching string anywhere on
 * it. Each assertion below names the mutation it dies on.
 */
// Renamed, not `read`: these suites are SCRIPTS, not modules, so a
// top-level const is GLOBAL — releaseIdentity.test.ts already owns `read`
// and tsc rejects the redeclaration (TS2451) while jest happily runs both.
// Same trap the shareApp suite documents; it bit again here.
const readRadioSrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

/**
 * Source with comments stripped.
 *
 * THIS EXISTS BECAUSE I MADE THE SAME MISTAKE THREE TIMES IN ONE NIGHT. An
 * assertion about the ABSENCE of a construct trips on any COMMENT that quotes
 * the construct — and the better the comment, the likelier it quotes it
 * exactly. First it was a permission guard failing on a comment naming the
 * API. Then this file's `not.toMatch(/distanceFilter/)` failing on my own
 * explanation. Then the "cleverer" `/distanceFilter\s*:/`, which failed on
 * the same explanation because good prose quotes the code WITH its colon.
 *
 * Sharpening the pattern a fourth time would lose again. The class fix is to
 * assert against CODE, so documentation can quote whatever it needs to.
 */
const codeOnly = (p: string): string =>
  readRadioSrc(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const RADIO_CREW = 'src/crews/CrewSection.tsx';
const RADIO_SETTINGS = 'src/screens/SettingsScreen.tsx';
const RADIO_SESSION = 'src/crews/session.ts';

describe('the interruption accessor has readers, not just a definition', () => {
  test('CrewSection CALLS radioInterrupted, not merely imports it', () => {
    // THE ONE THAT MATTERS. An import with no call is exactly how this
    // shipped broken the first time, and an import-only assertion would have
    // passed against that build. Mutation: delete the call and keep the
    // import — this fails, the import check alone would not.
    const src = readRadioSrc(RADIO_CREW);
    expect(src).toMatch(/radioInterrupted,/); // imported
    expect(src).toMatch(/radioInterrupted\(\)/); // and actually invoked
  });

  test('Settings CALLS it too — the master switch makes the same promise', () => {
    const src = readRadioSrc(RADIO_SETTINGS);
    expect(src).toMatch(/radioInterrupted,/);
    expect(src).toMatch(/radioInterrupted\(\)/);
  });

  test('POSITIVE CONTROL: the reader search would have found a real caller', () => {
    // Guards the guard. If these regexes were wrong, every arm above would
    // pass vacuously against any file. sharingCrewId is a seam we know is
    // consumed by CrewSection, so it must be found by the same shape of
    // search that finds radioInterrupted.
    expect(readRadioSrc(RADIO_CREW)).toMatch(/sharingCrewId\(\)/);
  });
});

describe('each reason gets its own route back, because they are not one problem', () => {
  const src = readRadioSrc(RADIO_CREW);

  test("'permission' says the user must act — it can never self-heal", () => {
    // Mutation: collapse the three reasons into one sentence and a camper
    // whose Bluetooth grant was revoked is told to wait for a recovery that
    // will never come.
    expect(src).toMatch(/lost the Bluetooth permission/);
    expect(src).toMatch(/Settings and sharing resumes/);
  });

  test("'bluetooth-off' says it picks itself back up", () => {
    expect(src).toMatch(/Bluetooth is off/);
    expect(src).toMatch(/picks itself back up/);
  });

  test("'advertise-failed' says it keeps trying and needs nothing", () => {
    // The one where doing nothing IS the right action, so the copy must not
    // send the camper hunting a setting.
    expect(src).toMatch(/keeps trying; nothing to do/);
  });

  test('all three say the pod cannot see them — the fact, before the remedy', () => {
    // Mutation: keep the remedies, drop the consequence, and the copy reads
    // as an FYI rather than as "you are invisible right now".
    expect(src.match(/cannot see you/g)?.length).toBe(3);
  });
});

describe('the honest copy replaces the false copy rather than sitting beside it', () => {
  test('the unconditional promise is gone from the pod card', () => {
    // THE LOAD-BEARING ONE. Adding a paused line while LEAVING the old
    // sentence unconditional is the tempting half-fix: the screen then says
    // both "your pod sees which way and how far" and "your pod cannot see
    // you" at once. This asserts the promise now lives inside the
    // not-interrupted branch.
    const src = readRadioSrc(RADIO_CREW);
    const at = src.indexOf('const down = radioInterrupted();');
    expect(at).toBeGreaterThanOrEqual(0);
    const guarded = src.slice(at);
    expect(guarded).toMatch(/your pod sees which way and\s*\n?\s*\/\/?\s*how far|your pod sees which way and/);
    // and it must be AFTER the `if (!down)` gate, not before it
    const gate = guarded.indexOf('if (!down)');
    const promise = guarded.indexOf('your pod sees which way');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(promise).toBeGreaterThan(gate);
  });

  test('Settings no longer states the ON promise unconditionally', () => {
    const src = readRadioSrc(RADIO_SETTINGS);
    const at = src.indexOf('radioInterrupted()');
    expect(at).toBeGreaterThanOrEqual(0);
    const after = src.slice(at);
    expect(after).toMatch(/Sharing is ON right now/);
    expect(after).toMatch(/nobody can see your position right now/);
  });
});

describe('the state machine itself still says what it is for', () => {
  test('session.ts documents its three reasons', () => {
    // If a reason is added to the union without copy in the UI, a camper gets
    // a paused share with no explanation. This is the tripwire for that.
    const src = readRadioSrc(RADIO_SESSION);
    const union = /RadioDownReason =\s*([^;]+);/.exec(src)?.[1] ?? '';
    const reasons = [...union.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
    expect(reasons.sort()).toEqual([
      'advertise-failed',
      'bluetooth-off',
      'permission',
    ]);
    // EVERY reason must appear as its own KEY in the copy table.
    //
    // This arm already earned its keep: the first implementation used a
    // ternary chain whose last arm was an ELSE, so 'advertise-failed' never
    // appeared as a literal and a FOURTH reason added later would have
    // silently inherited its sentence — a camper told "it keeps trying;
    // nothing to do" about a problem that needs them to act. A keyed record
    // turns that into a missing key instead of a wrong sentence.
    const crew = readRadioSrc(RADIO_CREW);
    for (const r of reasons) {
      const key = /^[a-z]+$/.test(r) ? `${r}:` : `'${r}':`;
      expect(`${r} must be a key in PAUSED_COPY:\n${crew}`).toContain(key);
    }
  });
});

/**
 * THE STATIONARY PHONE — measured on two handsets, 2026-08-25.
 *
 * Sharing ON produced ZERO advertisements for 12m13s on one phone and 4m46s
 * on the other. The radio was alive (565 scan results in the same slice) and
 * the app HAD a position — the compass was displaying it — but the sharing
 * session's own `lastFix` stayed null, so every refresh returned without
 * advertising, emitted no log line, and looked identical to a working share.
 *
 * Cause: the position watch used `distanceFilter: 5`, i.e. "call me when the
 * device moves five metres". A phone on a table never does. STANDING STILL IS
 * THE DEFAULT POSTURE AT A CAMP, so the filter that reads as a battery
 * kindness disabled the feature for the commonest case there is.
 *
 * Two halves, and the second is why it took a two-phone sweep to find: the
 * fix was not seeded, AND the failure was silent.
 */
describe('a phone that never moves still becomes visible', () => {
  test('the position is asked for ONCE at session start, not only watched', () => {
    // Mutation: delete the getCurrentPosition seed and a stationary phone is
    // invisible until it is carried five metres.
    const src = readRadioSrc('src/crews/share.ts');
    expect(src).toMatch(/getCurrentPosition\(/);
    const seed = src.indexOf('getCurrentPosition(');
    const watch = src.indexOf('watchPosition(');
    expect(seed).toBeGreaterThanOrEqual(0);
    // and it must come BEFORE the watch, or it is not a seed
    expect(seed).toBeLessThan(watch);
  });

  test('the watch no longer waits for five metres of walking', () => {
    // THE LOAD-BEARING ONE. Mutation: put any distanceFilter back and the
    // stationary case regresses — silently, because nothing errors.
    //
    // MATCH THE CODE SHAPE, NOT THE BARE NAME. The first version of this
    // assertion was `not.toMatch(/distanceFilter/)` and it failed on MY OWN
    // COMMENT explaining why the option was dropped — the identical
    // false-positive I had fixed in the permission guard an hour earlier,
    // repeated in a test written after learning it. A property needs a colon;
    // prose does not.
    expect(codeOnly('src/crews/share.ts')).not.toMatch(/distanceFilter/);
    // BOTH DIRECTIONS. The prose must still be free to explain itself, or the
    // guard punishes the next person for documenting why the option is gone —
    // which is exactly what the first two versions of this assertion did.
    expect(readRadioSrc('src/crews/share.ts')).toMatch(
      /distanceFilter dropped deliberately/,
    );
    // and the stripper must actually strip, or this passes over a blank.
    expect(codeOnly('src/crews/share.ts')).toMatch(/watchPosition\(/);
  });

  test('a session with no fix SAYS so instead of returning quietly', () => {
    // The half that made this cost a sweep instead of a log read.
    const src = readRadioSrc(RADIO_SESSION);
    expect(src).toMatch(/advertise\/\/skip reason=no-fix/);
    expect(src).toMatch(/setInterrupted\(\{ down: true, why: 'no-fix' \}\)/);
  });

  test('a fix arriving clears no-fix but never clears a REAL radio fault', () => {
    // Mutation: clear unconditionally, and a permission revocation heals
    // itself the moment GPS reports — which is precisely the stickiness the
    // radio lane fixed tonight, undone from a different file.
    const src = readRadioSrc(RADIO_SESSION);
    expect(src).toMatch(/interrupted\?\.why === 'no-fix'/);
  });

  test("'no-fix' is in the union AND has copy — the record made it a compile error", () => {
    // This is the keyed-record decision paying off: adding a reason to the
    // union broke the build until the sentence existed. A ternary chain would
    // have silently inherited the advertise-failed copy and told a camper
    // waiting on GPS that "it keeps trying; nothing to do".
    expect(readRadioSrc(RADIO_SESSION)).toMatch(/\| 'no-fix'/);
    const crew = readRadioSrc(RADIO_CREW);
    expect(crew).toMatch(/'no-fix':/);
    expect(crew).toMatch(/Getting your position/);
  });
});

describe('a session killed with the process is sayable afterwards', () => {
  // MEASURED THREE TIMES IN ONE EVENING: the appearance toggle restarts the
  // app, a force-stop, an install — and every module variable and native
  // handle died with the process. The switch then simply rendered OFF, with
  // nothing anywhere saying sharing HAD been on. A camper who does not
  // think to look is invisible to their pod for the rest of the day.
  //
  // The cure is one persisted key: the INTENT, written on a successful
  // start, cleared on every deliberate stop, and — the whole point —
  // untouched by the one path that never runs cleanup, the process dying.

  test('the intent is persisted on start and cleared on deliberate stop', () => {
    const src = codeOnly('src/crews/share.ts');
    // Mutation: keep the intent in a module variable and this file still
    // compiles, still passes its unit tests, and the row never renders on
    // the phone that needed it — module state IS the thing that died.
    expect(src).toMatch(/setSetting\(SHARING_INTENT_KEY, crew\.id\)/);
    expect(src).toMatch(/setSetting\(SHARING_INTENT_KEY, ''\)/);
  });

  test('the stamp follows proof, the clear opens the teardown', () => {
    const src = codeOnly('src/crews/share.ts');
    // Order is the assertion. Stamping before `session.started` resolves
    // writes an intent for a session that may be about to throw — and the
    // death row then renders under the very Alert explaining the failure,
    // two surfaces disagreeing about one moment.
    const stamp = src.indexOf("setSetting(SHARING_INTENT_KEY, crew.id)");
    const started = src.indexOf('await session.started');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(started);
    // ...and the clear lives in stopCrewSharingInner, which every
    // deliberate path runs through — including the exclusive-stop at the
    // top of start, which is what keeps a failed START from leaving a
    // stale intent behind (stop cleared it; the stamp never ran).
    const clear = src.indexOf("setSetting(SHARING_INTENT_KEY, '')");
    const stopInner = src.indexOf('async function stopCrewSharingInner');
    expect(clear).toBeGreaterThan(stopInner);
  });

  test('the pod card RENDERS the death, not merely exports an accessor', () => {
    // The radioInterrupted lesson, applied before shipping this time: a
    // seam with no caller is a feature that does not exist.
    const crew = codeOnly(RADIO_CREW);
    expect(crew).toMatch(/sharingDiedWithProcess\(crew\.id\)/);
    const copy = readRadioSrc(RADIO_CREW);
    expect(copy).toMatch(/does\s+not\s+survive\s+a\s+restart/);
    // The fact before the remedy, the PAUSED_COPY discipline: the row must
    // say sharing WAS on before telling anyone what to flip.
    expect(copy).toMatch(/Sharing was on when the app last closed/);
  });

  test('nothing auto-starts the radio from a process launch', () => {
    // The intent makes the death SAYABLE; it must not make it self-healing.
    // Radio and GPS wake on a user's gesture. Mutation: call
    // startCrewSharing from a mount/boot path keyed on the intent, and a
    // phone asks for Bluetooth the moment the launcher icon is tapped.
    const crew = codeOnly(RADIO_CREW);
    const calls = [...crew.matchAll(/startCrewSharing\(/g)];
    // POSITIVE CONTROL first: zero matches would pass the loop below over
    // nothing — the vacuity the composed-gate lesson exists to block.
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      const back = crew.slice(Math.max(0, m.index! - 400), m.index!);
      // every caller sits inside the toggle handler, not an effect
      expect(back).toMatch(/toggleShare|onValueChange|const toggleShare/);
    }
  });
});
