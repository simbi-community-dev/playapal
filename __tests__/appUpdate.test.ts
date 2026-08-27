/**
 * UPDATE TO LATEST — the sideloader's missing update channel.
 *
 * Playa Pal reaches most Android phones as an APK handed over by another
 * phone. Nothing about that install will ever mention a newer build, so
 * the app carries the job itself: ask GitHub, fetch one file, hand it to
 * Android's installer. What is pinned here, and why each pin exists:
 *
 *  - NOTHING TOUCHES THE NETWORK UNTIL A TAP. Every other thing in this
 *    app works with the radio off. A check that fires on mount would spend
 *    a dead phone's battery on a lookup nobody asked for and would make
 *    "offline-first" a claim the Settings tab quietly breaks.
 *  - NO SPINNER OUTLIVES TEN SECONDS. One bar of borrowed signal does not
 *    REFUSE, it HANGS, and fetch has no deadline of its own. The abort is
 *    the only thing between the camper and a row that spins until the
 *    screen goes off — and a timeout must read as a timeout, not as the
 *    "no signal" sentence, because they send someone to different places.
 *  - NEVER TWO REQUESTS, AND NEVER A RESURRECTED ROW. A second tap during
 *    a slow check is a no-op; an answer that lands after the camper walked
 *    away meets a table that drops it.
 *  - THE DOWNLOAD IS A SECOND, SEPARATE TAP. Learning a version exists and
 *    spending 130 MB on it are different decisions, and out there the
 *    second one is expensive.
 *  - THE SIGNATURE WALL IS TOLD BEFORE THE DOWNLOAD, NOT AFTER IT. Android
 *    refuses a release-signed APK over a debug-signed one. Bench and field
 *    phones here run the checked-in debug key, so for them this feature can
 *    only end in that refusal — and finding that out after 130 MB of
 *    borrowed signal is the version of this feature that deserves a bug
 *    report.
 *  - EVERY REFUSAL HAS ITS OWN SENTENCE. "Wait for bars", "clear some
 *    space" and "this phone updates by cable" are three different actions.
 *  - THE SEAM NEVER REJECTS. A rejecting call collapses every distinct,
 *    actionable reason into one 'error'.
 *  - THE NATIVE HALF IS REGISTERED AND WIRED. Source pins, because nothing
 *    type-checks Kotlin against TypeScript and the failure mode is a row
 *    that does nothing on a real phone and everything in a test.
 */
// Paths are repo-relative, as in campHotspot.test.tsx: jest runs from rootDir.
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

// This RN-only repo ships no node type definitions, so the one global the
// fetch pins reach for is declared minimally here rather than by adding
// @types/node — the habit themeGuard.test.ts already keeps for fs and path.
declare const global: { fetch: typeof fetch };

const KT = 'android/app/src/main/java/com/playapal/AppUpdateModule.kt';
const KT_PACKAGE = 'android/app/src/main/java/com/playapal/AppUpdatePackage.kt';
const KT_APP = 'android/app/src/main/java/com/playapal/MainApplication.kt';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const FILE_PATHS = 'android/app/src/main/res/xml/file_paths.xml';
const TS_SEAM = 'src/update/appUpdate.ts';
const TSX_ROW = 'src/screens/UpdateRow.tsx';
const TSX_SETTINGS = 'src/screens/SettingsScreen.tsx';

/**
 * The slice of a source file between two markers, so a pin about ONE
 * block cannot be satisfied by the right line sitting in a different one
 * — the failure mode of a whole-file regex, and the difference between
 * "nothing checks GitHub on mount" and "the words appear nowhere at all".
 */
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

import {
  CHECK_TIMEOUT_MS,
  LATEST_APK_URL,
  LATEST_RELEASE_API,
  UPDATE_PROGRESS_EVENT,
  checkLatestRelease,
  compareVersions,
  downloadAndInstall,
  isUpdateReason,
  reduceUpdate,
  updateActionLabel,
  updateIdle,
  updateReasonCopy,
  updateStatusLine,
  type UpdateEvent,
  type UpdateModel,
  type UpdateReason,
} from '../src/update/appUpdate';
import { NativeModules } from 'react-native';

/** Fold a list of events through the table, collecting every effect. */
const run = (
  events: UpdateEvent[],
  from: UpdateModel = updateIdle,
): { model: UpdateModel; effects: string[] } => {
  const effects: string[] = [];
  const model = events.reduce((m, e) => {
    const step = reduceUpdate(m, e);
    effects.push(...step.effects);
    return step.model;
  }, from);
  return { model, effects };
};

describe('comparing what is installed against what is published', () => {
  test('the comparator itself works — POSITIVE AND NEGATIVE CONTROLS', () => {
    // Reading a comparator cannot tell you it is sound, and a broken one
    // looks careful. These catch opposite failures.
    expect(compareVersions('0.8.6', '0.8.5')).toBe(1);
    expect(compareVersions('0.8.5', '0.8.6')).toBe(-1);
    expect(compareVersions('0.8.5', '0.8.5')).toBe(0);
  });

  test("the tag's leading v is a naming habit, not a version difference", () => {
    // Mutation: compare the strings and every check reports an update,
    // forever, because "v0.8.5" is never "0.8.5".
    expect(compareVersions('v0.8.5', '0.8.5')).toBe(0);
    expect(compareVersions('V0.8.6', '0.8.5')).toBe(1);
  });

  test('segments are numbers, not text — 0.9 is above 0.8.5, and 10 above 9', () => {
    // Mutation: compare lexically and 0.10.0 sorts BELOW 0.9.0, so the
    // release that matters most is the one nobody is offered.
    expect(compareVersions('0.9', '0.8.5')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0', '0.99.99')).toBe(1);
  });

  test('a missing segment reads as zero, so x.y.z.N compares against x.y.z', () => {
    // CLAUDE.md puts internal checkpoints at x.y.z.N; a phone carrying one
    // is AHEAD of the published x.y.z, not behind it.
    expect(compareVersions('0.8.5', '0.8.5.1')).toBe(-1);
    expect(compareVersions('0.8.5.0', '0.8.5')).toBe(0);
  });

  test('an unreadable version is its own answer, never a guess', () => {
    // Mutation: fall back to 0 for an unparseable tag and a nightly named
    // "latest" reads as ancient — every camper is offered an update that
    // does not exist.
    expect(compareVersions('latest', '0.8.5')).toBeNull();
    expect(compareVersions('0.8.5', '0.8.5-rc1')).toBeNull();
    expect(compareVersions('', '0.8.5')).toBeNull();
  });
});

describe('nothing reaches the network until the camper asks', () => {
  test('the idle model asks for nothing', () => {
    // THE OFFLINE-FIRST PIN. Mutation: emit 'check-github' from any state
    // the row can be in at mount and an app that promises to work with the
    // radio off phones home when a screen opens.
    expect(updateIdle.phase).toBe('idle');
    expect(run([]).effects).toEqual([]);
    expect(run([{ type: 'progress', percent: 40 }]).effects).toEqual([]);
    expect(run([{ type: 'failed', reason: 'offline' }]).effects).toEqual([]);
  });

  test('the row itself does no lookup on mount', () => {
    // The behavioural pin above cannot see a component that calls the seam
    // directly, so this reads the one effect that runs at mount. describe()
    // is allowed there — it is a package-manager read, not a byte of signal.
    const mount = between(
      readSource(TSX_ROW),
      'useEffect(() => {',
      '}, [android]);',
    );
    expect(mount).toContain('describeInstalledApp()');
    expect(mount).not.toContain('checkLatestRelease');
    expect(mount).not.toContain('downloadAndInstall');
    // Guard the guard: the slice must be a real one, or every `not` above
    // passes over an empty string.
    expect(mount.length).toBeGreaterThan(200);
  });

  test('a tap is the only door in, and one tap opens it once', () => {
    expect(run([{ type: 'check' }]).effects).toEqual(['check-github']);
    // Mutation: drop the in-flight guard and every impatient second tap on
    // playa signal starts a request that finishes after the first one.
    expect(run([{ type: 'check' }, { type: 'check' }]).effects).toEqual([
      'check-github',
    ]);
  });
});

describe('the table: separate decisions, and no late answer repaints a dismissed row', () => {
  const checking = run([{ type: 'check' }]).model;

  test('a newer release offers itself; an equal or older one does not', () => {
    const newer = run([{ type: 'checked', latest: 'v0.9.0', installed: '0.8.5' }], checking);
    expect(newer.model.phase).toBe('available');
    expect(newer.model.latest).toBe('v0.9.0');
    // A phone AHEAD of the published release is a field build, and "up to
    // date" is the honest thing to tell it.
    expect(
      run([{ type: 'checked', latest: 'v0.8.5', installed: '0.8.5' }], checking).model.phase,
    ).toBe('current');
    expect(
      run([{ type: 'checked', latest: 'v0.8.4', installed: '0.8.5' }], checking).model.phase,
    ).toBe('current');
  });

  test('a version that cannot be compared fails honestly rather than guessing', () => {
    const step = run([{ type: 'checked', latest: 'nightly', installed: '0.8.5' }], checking);
    expect(step.model.phase).toBe('failed');
    expect(step.model.reason).toBe('unreadable');
  });

  test('the download is a SECOND tap, and only from available', () => {
    // Mutation: download straight off a successful check and a camper who
    // wanted to know the version has spent 130 MB of borrowed signal.
    expect(run([{ type: 'download' }]).effects).toEqual([]);
    expect(run([{ type: 'download' }], checking).effects).toEqual([]);
    const available = run(
      [{ type: 'checked', latest: 'v0.9.0', installed: '0.8.5' }],
      checking,
    ).model;
    const started = run([{ type: 'download' }], available);
    expect(started.effects).toEqual(['download-apk']);
    expect(started.model.phase).toBe('downloading');
    expect(started.model.percent).toBe(0);
    // ...and a second tap while it runs does not start a second transfer.
    expect(run([{ type: 'download' }], started.model).effects).toEqual([]);
  });

  test('an answer that arrives with nothing in flight is dropped', () => {
    // Mutation: accept 'checked' or 'failed' in any state and an answer
    // from a run that already ended repaints an idle row minutes later,
    // out of nowhere.
    expect(
      run([{ type: 'checked', latest: 'v0.9.0', installed: '0.8.5' }]).model.phase,
    ).toBe('idle');
    expect(run([{ type: 'failed', reason: 'offline' }]).model.phase).toBe('idle');
  });

  test('a finished row is retried by the same tap that started it', () => {
    // There is no dismiss: from up-to-date, failed or handed-over, the
    // row's one control means "ask again" — and the retry starts from a
    // clean model rather than carrying the last failure's reason forward.
    for (const done of ['current', 'failed', 'handed-off'] as const) {
      const step = run([{ type: 'check' }], {
        ...updateIdle,
        phase: done,
        reason: 'offline',
        latest: 'v0.9.0',
      });
      expect(step.effects).toEqual(['check-github']);
      expect(step.model.phase).toBe('checking');
      expect(step.model.reason).toBeNull();
      expect(step.model.latest).toBeNull();
    }
  });

  test('progress only moves a bar that exists, and the hand-off ends it', () => {
    const downloading = run(
      [
        { type: 'checked', latest: 'v0.9.0', installed: '0.8.5' },
        { type: 'download' },
      ],
      checking,
    ).model;
    expect(run([{ type: 'progress', percent: 61 }], downloading).model.percent).toBe(61);
    expect(run([{ type: 'progress', percent: 61 }], checking).model.percent).toBeNull();
    const handed = run([{ type: 'handed-off' }], downloading).model;
    expect(handed.phase).toBe('handed-off');
    expect(handed.percent).toBeNull();
    // The version stays named through the whole arc, so the row never
    // stops saying WHAT is arriving.
    expect(handed.latest).toBe('v0.9.0');
  });
});

describe('every refusal has its own sentence, and the two that matter most are exact', () => {
  const REASONS: UpdateReason[] = [
    'absent',
    'ios',
    'offline',
    'timeout',
    'rate-limited',
    'unreachable',
    'unreadable',
    'developer-build',
    'no-manager',
    'no-space',
    'no-storage',
    'download-failed',
    'no-installer',
    'error',
  ];

  test('no reason is left with a shrug', () => {
    // Guard the guard: an empty list satisfies every loop vacuously.
    expect(REASONS.length).toBeGreaterThanOrEqual(14);
    for (const reason of REASONS) {
      expect(isUpdateReason(reason)).toBe(true);
      const copy = updateReasonCopy(reason);
      // Long enough to say what to do next — a four-word apology is the
      // shrug this exists to prevent.
      expect(copy.length).toBeGreaterThan(40);
    }
    // 'ok' is not a refusal and deliberately carries nothing.
    expect(updateReasonCopy('ok')).toBe('');
  });

  test('OFFLINE says checking needs a signal, and that nothing is broken', () => {
    // The sentence most campers will ever see. It has to name the fix AND
    // say the app is fine — they have been told all week that Playa Pal
    // needs no network, and this row is the one exception.
    const copy = updateReasonCopy('offline');
    expect(copy).toContain('Checking needs a signal — try when you have bars');
    expect(copy).toMatch(/Everything else in Playa Pal works/);
  });

  test('a TIMEOUT is not the same sentence as no signal', () => {
    // Mutation: fold the timeout into 'offline' and a camper standing in
    // one bar is told to find bars they are already holding.
    expect(updateReasonCopy('timeout')).not.toBe(updateReasonCopy('offline'));
    expect(updateReasonCopy('timeout')).toContain('ten seconds');
  });

  test('the SIGNATURE WALL is named, and the way out is the cable', () => {
    // THE SHARP ONE. Android refuses a release-signed APK over a
    // debug-signed one, and the refusal it shows says "App not installed"
    // and nothing else. This sentence is the only place a camper can learn
    // what actually happened.
    const copy = updateReasonCopy('developer-build');
    expect(copy).toContain('developer build');
    expect(copy).toContain('cable');
    expect(copy).toMatch(/developer key/);
  });

  test('the blocked row still NAMES the version it cannot install', () => {
    // Mutation: hide the news behind the wall and the camper never learns
    // there is a newer build to go ask for.
    const available: UpdateModel = {
      ...updateIdle,
      phase: 'available',
      latest: 'v0.9.0',
    };
    expect(updateActionLabel(available, true)).toContain('v0.9.0');
    const line = updateStatusLine(available, '0.8.5', true);
    expect(line).toContain('v0.9.0');
    expect(line).toContain(updateReasonCopy('developer-build'));
    // ...and an unblocked phone is offered the install instead.
    expect(updateStatusLine(available, '0.8.5', false)).toContain('0.8.5');
    expect(updateActionLabel(available, false)).toContain('v0.9.0');
  });

  test('the hand-off warns about the two screens that eat installs', () => {
    // Bought by real installs failing on real phones — ShareAppRow carries
    // the same two warnings for the same reason.
    const line = updateStatusLine({ ...updateIdle, phase: 'handed-off' }, '0.8.5', false);
    expect(line).toMatch(/Allow installs/i);
    expect(line).toContain('Install anyway');
  });

  test('every phase has a line, so no state can render blank', () => {
    const phases: UpdateModel['phase'][] = [
      'idle',
      'checking',
      'current',
      'available',
      'downloading',
      'handed-off',
    ];
    expect(phases.length).toBe(6);
    for (const phase of phases) {
      expect(
        updateStatusLine({ ...updateIdle, phase, latest: 'v0.9.0' }, '0.8.5', false).length,
      ).toBeGreaterThan(10);
      expect(updateActionLabel({ ...updateIdle, phase }, false).length).toBeGreaterThan(0);
    }
  });
});

describe('the seam never rejects, and a hang is not a refusal', () => {
  const realFetch = global.fetch;

  /** A fresh copy of the seam bound to a stub native module — the module
   * reads NativeModules once at import, exactly as it does on a phone. */
  const seamWith = (stub: unknown) => {
    (NativeModules as unknown as Record<string, unknown>).AppUpdate = stub;
    let seam: typeof import('../src/update/appUpdate');
    jest.isolateModules(() => {
      seam = require('../src/update/appUpdate');
    });
    return seam!;
  };

  afterEach(() => {
    delete (NativeModules as unknown as Record<string, unknown>).AppUpdate;
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  test('it asks GitHub for the latest release, unauthenticated', () => {
    expect(LATEST_RELEASE_API).toBe(
      'https://api.github.com/repos/simbi-community-dev/playapal/releases/latest',
    );
    // The STABLE asset URL: GitHub redirects it to whatever the newest
    // release attached under that name, so the app never parses an asset
    // list to find the file it wants.
    expect(LATEST_APK_URL).toBe(
      'https://github.com/simbi-community-dev/playapal/releases/latest/download/playapal.apk',
    );
  });

  test('a tag comes back as a tag', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v0.9.0' }),
    }) as unknown as typeof fetch;
    await expect(checkLatestRelease()).resolves.toEqual({ ok: true, latest: 'v0.9.0' });
    // GitHub refuses a request with no User-Agent outright, and that
    // refusal would read here as 'unreachable' forever.
    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.headers['User-Agent']).toBeTruthy();
  });

  test('a dead radio is offline, not an exception', async () => {
    // Mutation: let the throw escape and the row shows a red box in dev
    // and nothing at all in release.
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    await expect(checkLatestRelease()).resolves.toEqual({
      ok: false,
      reason: 'offline',
      detail: 'Network request failed',
    });
  });

  test('ONE BAR HANGS, and ten seconds later that is a timeout', async () => {
    // THE PIN THIS FEATURE EXISTS UNDER. fetch has no deadline of its own,
    // so without the abort this promise never settles and the row spins
    // until the screen goes off. It must also land as 'timeout' rather
    // than 'offline': the same catch receives both, and only
    // signal.aborted can tell them apart.
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    ) as unknown as typeof fetch;
    const pending = checkLatestRelease();
    jest.advanceTimersByTime(CHECK_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(CHECK_TIMEOUT_MS).toBe(10000);
  });

  test("GitHub's hourly ceiling gets its own sentence, not a generic one", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    await expect(checkLatestRelease()).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      detail: 'HTTP 403',
    });
  });

  test('an answer that is not a release is unreachable, never a version', async () => {
    // A captive portal at the gate answers 200 with a login page. Reading
    // a tag out of that is how a camper is offered "update to Sign In".
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'please sign in' }),
    }) as unknown as typeof fetch;
    await expect(checkLatestRelease()).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'no tag_name in the answer',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch;
    await expect(checkLatestRelease()).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'HTTP 502',
    });
  });

  test('with no native half the download refuses politely', async () => {
    // Platform.OS is 'ios' under the react-native jest preset, which is
    // exactly the arm an iPhone takes in the field; an Android build with
    // no module registered takes the 'absent' arm beside it.
    expect(NativeModules.AppUpdate).toBeUndefined();
    await expect(downloadAndInstall()).resolves.toEqual({ ok: false, reason: 'ios' });
    expect(readSource(TS_SEAM)).toContain(
      "reason: Platform.OS === 'ios' ? 'ios' : 'absent'",
    );
  });

  test('a native refusal keeps its own token; a native throw becomes error', async () => {
    // Mutation: let the native promise's rejection escape, or map every
    // outcome to 'error', and "clear some space" becomes "it broke".
    await expect(
      seamWith({
        download: async () => ({ ok: false, reason: 'no-space', detail: '2 GB short' }),
      }).downloadAndInstall(),
    ).resolves.toEqual({ ok: false, reason: 'no-space', detail: '2 GB short' });

    await expect(
      seamWith({
        download: async () => {
          throw new Error('binder died');
        },
      }).downloadAndInstall(),
    ).resolves.toEqual({ ok: false, reason: 'error', detail: 'binder died' });

    // A token the TypeScript has never heard of becomes 'error', rather
    // than reaching updateReasonCopy's exhaustive switch — which returns
    // undefined for it, a blank line where a sentence goes.
    await expect(
      seamWith({ download: async () => ({ ok: false, reason: 'gremlins' }) })
        .downloadAndInstall(),
    ).resolves.toEqual({ ok: false, reason: 'error' });
  });

  test('the URL the native half is handed is the stable one', async () => {
    const seen: string[] = [];
    await seamWith({
      download: async (url: string) => {
        seen.push(url);
        return { ok: true };
      },
    }).downloadAndInstall();
    expect(seen).toEqual([LATEST_APK_URL]);
  });
});

describe('the native half is registered, wired and speaks the same tokens', () => {
  test('the module is in the package list, or nothing on a real phone works', () => {
    // THE MOUNT PIN. Mutation: drop the registration and every call falls
    // to the 'absent' arm — a row that politely says it cannot update on a
    // phone that could have updated perfectly well.
    expect(readSource(KT_APP)).toMatch(/add\(AppUpdatePackage\(\)\)/);
    expect(readSource(KT_PACKAGE)).toMatch(/listOf\(AppUpdateModule\(reactContext\)\)/);
  });

  test('the JS name and the Kotlin name are the same string', () => {
    // Mutation: rename either side and the seam reports 'absent' forever,
    // with no error anywhere.
    const name = /const val NAME = "([A-Za-z]+)"/.exec(readSource(KT))?.[1];
    expect(name).toBe('AppUpdate');
    expect(readSource(TS_SEAM)).toContain(`NativeModules.${name}`);
  });

  test('the progress event is one string in two languages', () => {
    const kt = /const val PROGRESS_EVENT = "([A-Za-z]+)"/.exec(readSource(KT))?.[1];
    expect(kt).toBe(UPDATE_PROGRESS_EVENT);
  });

  test('DownloadManager does the fetching, into a FileProvider root', () => {
    // Mutation: roll our own socket and the transfer dies with the screen,
    // has no notification, and cannot survive a network that comes and
    // goes — which on playa is the only kind there is. Mutation two: write
    // outside the external files dir and FileProvider cannot mint a URI for
    // the finished file, so the installer never opens.
    const kt = readSource(KT);
    expect(kt).toContain('DownloadManager.Request(Uri.parse(url))');
    expect(kt).toContain('setDestinationInExternalFilesDir(ctx, null, "$UPDATE_DIR/$APK_NAME")');
    expect(kt).toMatch(/dm\.enqueue\(/);
    // `path="."` on the external-files root already covers updates/; the
    // pin is that the root exists at all.
    expect(readSource(FILE_PATHS)).toContain('<external-files-path name="beams" path="." />');
  });

  test('completion is watched twice, and the stale file is deleted first', () => {
    // The broadcast is the authority and the poll is the net: a ROM that
    // drops ACTION_DOWNLOAD_COMPLETE would otherwise strand the camper on
    // a progress bar forever. And DownloadManager does not overwrite — it
    // writes alongside as "playapal-1.apk" — so a leftover from a killed
    // run would be handed to the installer as if it were the new build.
    const kt = readSource(KT);
    expect(kt).toContain('DownloadManager.ACTION_DOWNLOAD_COMPLETE');
    expect(kt).toContain('ContextCompat.registerReceiver');
    expect(kt).toMatch(/handler\.postDelayed\(this, POLL_MS\)/);
    expect(kt).toMatch(/dest\.delete\(\)/);
    expect(kt).toContain('DownloadManager.STATUS_SUCCESSFUL');
    expect(kt).toContain('DownloadManager.STATUS_FAILED');
  });

  test('the installer is fired the one way Android accepts', () => {
    // Mutation: hand over a file:// path and Android 7 and up throw
    // FileUriExposedException; forget the read grant and the installer
    // opens on a URI it may not read, which shows as a parse error.
    const install = between(readSource(KT), 'private fun install()', 'private fun settle(');
    expect(install).toContain('FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", dest)');
    expect(install).toContain('Intent(Intent.ACTION_VIEW)');
    expect(install).toContain('setDataAndType(uri, APK_MIME)');
    expect(install).toContain('Intent.FLAG_GRANT_READ_URI_PERMISSION');
    expect(install).toContain('Intent.FLAG_ACTIVITY_NEW_TASK');
    // The one MIME that makes Android offer its package installer.
    expect(readSource(KT)).toContain(
      'const val APK_MIME = "application/vnd.android.package-archive"',
    );
  });

  test('the manifest asks for the grant the installer needs', () => {
    // Mutation: leave it out and the ACTION_VIEW lands on a refusal with
    // no explanation, after the whole download.
    const manifest = readSource(MANIFEST);
    expect(manifest).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    // ...and the FileProvider it hands the file through already exists.
    expect(manifest).toContain('${applicationId}.fileprovider');
  });

  test('the debug key is read from the CERTIFICATE, not from a debuggable flag', () => {
    // THE ONE THAT WOULD SILENTLY BE WRONG. A release build signed with
    // the debug key for a field phone is NOT debuggable, so FLAG_DEBUGGABLE
    // sails straight past it and the camper spends 130 MB to reach "App
    // not installed". The certificate subject is the ground truth, and it
    // is the subject our own checked-in keystore mints.
    const kt = readSource(KT);
    expect(kt).toContain('const val DEBUG_CERT_SUBJECT = "CN=Android Debug"');
    expect(kt).toContain('subjectX500Principal');
    // The comparison itself must not fall back to the flag — the prose
    // above isDebugSigned explains why, so the pin reads the CODE.
    const probe = between(kt, 'private fun isDebugSigned()', 'private fun canRequestInstalls');
    expect(probe).not.toContain('FLAG_DEBUGGABLE');
    expect(probe).toContain('DEBUG_CERT_SUBJECT');
    // ...and it is checked BEFORE the enqueue, not after the download.
    const download = between(kt, 'fun download(url: String', 'val dm =');
    expect(download).toContain('isDebugSigned()');
    expect(download).toContain('fail("developer-build"');
  });

  test('the native half NEVER rejects a promise', () => {
    // Mutation: reject on failure and the JS catch collapses eight
    // distinct, actionable reasons into 'error' — the seam cannot tell a
    // refusal from a bug, and neither can the camper.
    const kt = readSource(KT);
    expect(kt).toMatch(/promise\.resolve\(/);
    expect(kt).not.toMatch(/promise\.reject\(/);
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
    for (const m of kt.matchAll(/putString\("reason", "([a-z0-9-]+)"\)/g)) {
      tokens.add(m[1]);
    }
    for (const m of kt.matchAll(/->\s*"([a-z0-9-]+)"\n/g)) {
      tokens.add(m[1]);
    }
    // Guard the guard: an empty set satisfies every loop vacuously, and a
    // regex that stopped matching would look exactly like a clean pass.
    expect(tokens.size).toBeGreaterThanOrEqual(7);
    expect(tokens.has('developer-build')).toBe(true);
    expect(tokens.has('no-space')).toBe(true);
    for (const token of tokens) {
      expect(isUpdateReason(token)).toBe(true);
    }
    // And the negative control: a token that is NOT in the union must be
    // rejected, or the loop above proves nothing.
    expect(isUpdateReason('gremlins')).toBe(false);
  });
});

describe('the row is Android-only, mounted, and goes through the wrapper', () => {
  test('iOS gets a sentence, not a button that cannot work', () => {
    // Mutation: render the check on iOS and it fails every time, because
    // Apple installs only what Apple delivered.
    const row = readSource(TSX_ROW);
    expect(row).toContain("const android = Platform.OS === 'android'");
    expect(row).toContain('if (!android) {');
    // The explanation rides the circled ? — the Tufte pass's shape, and
    // honest: there is no action to offer, only a fact to have available.
    expect(row).toContain('<InfoTap');
    expect(row).toContain("updateReasonCopy('ios')");
    expect(updateReasonCopy('ios')).toContain('TestFlight');
  });

  test('the row is actually mounted, next to the version it is about', () => {
    // A capability with no caller is a feature that does not exist
    // (__tests__/exportsHaveCallers.test.ts owns that lesson).
    const settings = readSource(TSX_SETTINGS);
    expect(settings).toContain("import { UpdateRow } from './UpdateRow'");
    expect(settings).toMatch(/<UpdateRow version=\{APP_VERSION\} \/>/);
    // Under About, where the version already is — the same question two
    // seconds apart.
    const about = between(settings, 'Playa Pal {APP_VERSION}', 'playapal.lol');
    expect(about).toContain('<UpdateRow');
  });

  test('neither new file reaches past the Text wrapper', () => {
    // The house rule textSize.test.tsx enforces across the tree, pinned
    // here too so this lane fails on its own terms: a raw react-native
    // Text ignores the camper's size dial, which out here is whether the
    // row can be read at all.
    for (const file of [TSX_ROW, TS_SEAM]) {
      const src = readSource(file);
      for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'react-native';/g)) {
        const named = m[1].split(',').map(s => s.trim());
        expect(named).not.toContain('Text');
        expect(named).not.toContain('TextInput');
      }
    }
    expect(readSource(TSX_ROW)).toContain("import { Text } from '../components/Text'");
  });
});
