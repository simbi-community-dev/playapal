/**
 * UPDATE TO LATEST — the sideloader's missing update channel.
 *
 * THE HOLE THIS FILLS. Playa Pal arrives on most Android phones as an APK:
 * beamed over from the phone next to you (ShareAppRow), or downloaded once
 * from the release page. Neither install leaves anything behind that will
 * ever mention a newer build. Obtainium is the right answer to that and is
 * also a second app somebody has to set up, which nobody does standing in
 * dust at 2am. So the app carries the modest version of the job: when the
 * camper ASKS, look up the latest release, and if there is a newer one,
 * fetch it and hand it to Android's installer.
 *
 * OFFLINE-FIRST IS THE CONSTRAINT, NOT A FEATURE OF THIS ROW. Everything
 * else in this app works with the radio off, and this one thing cannot.
 * Three rules fall out of that, and all three are load-bearing:
 *
 *   NOTHING HAPPENS UNTIL A TAP. No check on launch, no check when the
 *   Settings tab opens. A phone with no signal must not spend its battery
 *   on a lookup nobody asked for, and an app that quietly phones home on
 *   open is not the app this one claims to be.
 *
 *   NO SPINNER OUTLIVES TEN SECONDS. One bar of borrowed signal fails by
 *   HANGING, not by refusing, so the timeout is the only thing between the
 *   camper and a row that spins until the screen goes off.
 *
 *   THE ROW READS HONESTLY WITH NOTHING BEHIND IT. "Check for update" on a
 *   dead radio says so in one sentence and stays tappable, because the
 *   signal may come back while they are standing there.
 *
 * THE STATE MACHINE IS PURE (the shape campHotspot.ts set). Everything the
 * row can be — idle, checking, current, available, downloading, handed to
 * the installer, failed with a named reason — is a (state, event) row in
 * `reduceUpdate`, with the network and the native calls expressed as
 * effects. The row runs the effects; the tests own the table.
 *
 * THE SIGNATURE WALL DESERVES ITS OWN SENTENCE. Android refuses to install
 * a release-signed APK over a debug-signed one — same package, different
 * key, "App not installed" and no reason given. Bench and field-build
 * phones in this house run the checked-in debug key, so for them this
 * feature can only ever end in that refusal. The native half reports the
 * signing key up front (AppUpdateModule.isDebugSigned), and the row says
 * so INSTEAD of offering a 130 MB download that Android was always going
 * to bounce. Spending a camper's only bandwidth to reach a wall we could
 * see from here is the version of this feature that deserves a bug report.
 */
import { NativeModules, Platform } from 'react-native';

const native = NativeModules.AppUpdate;

/** Where the newest version is announced. Unauthenticated: this is a
 * public repo and a camper has no token to give it. */
export const LATEST_RELEASE_API =
  'https://api.github.com/repos/simbi-community-dev/playapal/releases/latest';

/** The STABLE asset URL — GitHub redirects `/releases/latest/download/<name>`
 * to whatever the newest release attached under that name, so the app never
 * has to parse an asset list to find the file it wants. */
export const LATEST_APK_URL =
  'https://github.com/simbi-community-dev/playapal/releases/latest/download/playapal.apk';

/** Ten seconds, and the reason it is not thirty: a camper holding a phone
 * up for signal gives up long before a network stack does. */
export const CHECK_TIMEOUT_MS = 10000;

/** Download progress from the native half, percent per tick. */
export const UPDATE_PROGRESS_EVENT = 'PlayaPalAppUpdateProgress';

/**
 * Why an update did not happen. Kept apart wherever the camper's NEXT STEP
 * differs — "wait for signal", "clear some space" and "this phone can only
 * be updated by cable" are three different actions, and collapsing them
 * into one apology is how someone decides the app is broken.
 */
export type UpdateReason =
  | 'ok'
  /** No native module in this build (jest, an older app). */
  | 'absent'
  /** iPhones update through TestFlight. Permanent, and not a fault. */
  | 'ios'
  /** The request never reached a server: radio off, no bars, no route. */
  | 'offline'
  /** Something was listening and never finished inside the ten seconds. */
  | 'timeout'
  /** GitHub's unauthenticated ceiling (60/hour/IP). Recoverable by waiting,
   * and worth its own sentence because "try again later" is TRUE here and
   * a lie in most of the other arms. */
  | 'rate-limited'
  /** An answer arrived and it was not a release — a 5xx, or the captive
   * portal at the gate answering on GitHub's behalf. */
  | 'unreachable'
  /** A release arrived carrying a version string this app cannot compare. */
  | 'unreadable'
  /** This install is debug-signed, so a release APK can never land on it. */
  | 'developer-build'
  /** DownloadManager is absent or disabled on this phone. */
  | 'no-manager'
  /** Not enough room for the copy. */
  | 'no-space'
  /** The external files dir is gone or unwritable. */
  | 'no-storage'
  /** The transfer stopped partway. The playa default. */
  | 'download-failed'
  /** The file landed and nothing on this phone will open an APK. */
  | 'no-installer'
  /** Something threw. Reported, never swallowed. */
  | 'error';

const REASONS: readonly string[] = [
  'ok',
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

export function isUpdateReason(v: unknown): v is UpdateReason {
  return typeof v === 'string' && REASONS.includes(v);
}

// ------------------------------------------------------- comparing versions

/**
 * The numeric segments of a version, or null when there are none to read.
 *
 * Deliberately strict. A tag this app cannot parse is NOT "probably the
 * same version" and NOT "probably newer" — both of those guesses end with
 * a camper either missing an update or downloading one they already have.
 * Unparseable is its own answer and gets its own sentence.
 *
 * `v0.8.5` and `0.8.5` are the same version: the tag carries the v, the
 * installed versionName does not, and that difference is a naming habit
 * rather than a fact about the build.
 */
function segments(version: string): number[] | null {
  const bare = version.trim().replace(/^v/i, '');
  return /^\d+(\.\d+)*$/.test(bare) ? bare.split('.').map(Number) : null;
}

/**
 * -1 / 0 / 1 comparing two versions, or null when either cannot be read.
 *
 * Arbitrary depth, missing segments read as zero: `0.8.5` and `0.8.5.1`
 * both occur here (CLAUDE.md's release cadence puts internal checkpoints
 * at x.y.z.N), and `0.9` must sort above `0.8.5` rather than below it.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = segments(a);
  const right = segments(b);
  if (left === null || right === null) {
    return null;
  }
  const depth = Math.max(left.length, right.length);
  for (let i = 0; i < depth; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

// -------------------------------------------------------- the state machine

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  /** The installer is on screen. Whether the camper goes through with it
   * is theirs to know — no app can watch its own replacement land. */
  | 'handed-off'
  | 'failed';

export interface UpdateModel {
  phase: UpdatePhase;
  /** The tag GitHub reported. Set once a check succeeds, and kept through
   * the download so the row can keep naming what is arriving. */
  latest: string | null;
  /** Only in 'downloading'. */
  percent: number | null;
  /** Only in 'failed'; cleared by every path out of it. */
  reason: UpdateReason | null;
  detail: string | null;
}

export const updateIdle: UpdateModel = {
  phase: 'idle',
  latest: null,
  percent: null,
  reason: null,
  detail: null,
};

export type UpdateEvent =
  /** The camper tapped "Check for update". The ONLY door into the network. */
  | { type: 'check' }
  | { type: 'checked'; latest: string; installed: string }
  | { type: 'download' }
  | { type: 'progress'; percent: number }
  /** The installer opened. */
  | { type: 'handed-off' }
  | { type: 'failed'; reason: UpdateReason; detail?: string };

export type UpdateEffect = 'check-github' | 'download-apk';

interface Step {
  model: UpdateModel;
  effects: UpdateEffect[];
}

/**
 * The table. Three rules carry most of it:
 *
 *   NEVER TWO REQUESTS. A second tap while a check or a download is in
 *   flight is a no-op, not a second lookup — on playa signal the first one
 *   has not failed yet, it is just slow, and the row that starts a second
 *   transfer is the row that finishes neither.
 *
 *   A LATE ANSWER NEVER RESURRECTS A DISMISSED ROW. Ten seconds is long
 *   enough to walk away, and an answer that lands after the camper moved
 *   on must not repaint a screen they are no longer looking at.
 *
 *   THE DOWNLOAD IS A SEPARATE TAP. Finding out a version exists and
 *   spending 130 MB on it are different decisions, and out there the
 *   second one is expensive.
 *
 * There is deliberately NO dismiss event. The row's only control is the
 * tap, and from a finished state — up to date, failed, handed over — that
 * tap means "ask again", which `check` already does from a clean model. An
 * event nothing can send is a branch nothing can test.
 */
export function reduceUpdate(m: UpdateModel, e: UpdateEvent): Step {
  switch (e.type) {
    case 'check':
      if (m.phase === 'checking' || m.phase === 'downloading') {
        return { model: m, effects: [] };
      }
      return {
        model: { ...updateIdle, phase: 'checking' },
        effects: ['check-github'],
      };
    case 'checked': {
      if (m.phase !== 'checking') {
        return { model: m, effects: [] };
      }
      const order = compareVersions(e.latest, e.installed);
      if (order === null) {
        return {
          model: {
            ...updateIdle,
            phase: 'failed',
            reason: 'unreadable',
            detail: e.latest,
          },
          effects: [],
        };
      }
      // A phone AHEAD of the published release is a field build, not an
      // error, and "up to date" is the honest thing to tell it.
      return {
        model: {
          ...updateIdle,
          phase: order > 0 ? 'available' : 'current',
          latest: e.latest,
        },
        effects: [],
      };
    }
    case 'download':
      if (m.phase !== 'available') {
        return { model: m, effects: [] };
      }
      return {
        model: { ...m, phase: 'downloading', percent: 0 },
        effects: ['download-apk'],
      };
    case 'progress':
      if (m.phase !== 'downloading') {
        return { model: m, effects: [] };
      }
      return { model: { ...m, percent: e.percent }, effects: [] };
    case 'handed-off':
      if (m.phase !== 'downloading') {
        return { model: m, effects: [] };
      }
      return { model: { ...m, phase: 'handed-off', percent: null }, effects: [] };
    case 'failed':
      // Nothing was in flight, so nothing can have failed — a stale
      // rejection from a run the camper already dismissed.
      if (m.phase === 'idle') {
        return { model: m, effects: [] };
      }
      return {
        model: {
          ...updateIdle,
          phase: 'failed',
          latest: m.latest,
          reason: e.reason,
          detail: e.detail ?? null,
        },
        effects: [],
      };
  }
}

// ------------------------------------------------------------- what it says

/**
 * The sentence for each refusal. Every one names the thing the camper can
 * do next, or says plainly that there is nothing — which is still better
 * than a spinner that never resolves.
 */
export function updateReasonCopy(reason: UpdateReason): string {
  switch (reason) {
    case 'ok':
      return '';
    case 'absent':
      return "This copy of Playa Pal can't fetch its own updates. Grab the newest APK from playapal.lol on a phone that has signal, and beam it over.";
    case 'ios':
      return 'iPhones update through TestFlight, not from in here — Apple only installs what it delivered.';
    case 'offline':
      // The one sentence most campers will ever see. It has to say that
      // nothing is broken: this is the ONLY thing in the app that needs a
      // network, and the camper has been told the opposite all week.
      return "Checking needs a signal — try when you have bars. Everything else in Playa Pal works out here; this one row is the exception.";
    case 'timeout':
      return "Nothing came back in ten seconds. That is usually one bar pretending to be five — try again where the signal is real, or up on a rise.";
    case 'rate-limited':
      return 'GitHub is counting requests from this network and has hit its hourly limit. Nothing is wrong; wait an hour, or check playapal.lol.';
    case 'unreachable':
      return "Something answered, but not with a release. GitHub may be down, or this network wants you to sign in to a portal page first.";
    case 'unreadable':
      return "The newest release is named in a way this app can't compare against what you're running. Check playapal.lol by hand.";
    case 'developer-build':
      // The important one. Android will REFUSE the release APK on a
      // debug-keyed phone, so the honest move is to say so before the
      // download, not to let 130 MB end at "App not installed".
      return "This phone runs a developer build — updates arrive by cable. Android won't install a released copy over one signed with a developer key, so whoever built this one has to flash the new build over USB.";
    case 'no-manager':
      return "This phone's download service is switched off, so the app can't fetch anything. Download the APK in a browser from playapal.lol instead.";
    case 'no-space':
      return 'Not enough free space for the new copy. Clear a few hundred megabytes — photos are usually the fastest win — and try again.';
    case 'no-storage':
      return "The phone's storage went away mid-download. If there's an SD card, reseat it; otherwise restart the phone and try again.";
    case 'download-failed':
      return 'The download stopped partway. Out here that is almost always the signal — try again with more bars, and it picks up from nothing rather than resuming.';
    case 'no-installer':
      return "The file downloaded, but nothing on this phone will open an APK. Open Files, find Android/data/com.playapal/files/updates, and tap playapal.apk.";
    case 'error':
      return 'Updating failed on this phone, and it did not say why. Grab the newest APK from playapal.lol instead.';
  }
}

/**
 * The row's second line. Lives here rather than in the component for the
 * same reason the reasons do: the words ARE the feature, and words in a
 * component are words no test reads.
 *
 * `blocked` is the debug-key wall, and it is a fact about the PHONE rather
 * than a state of the machine — the check ran, the version really is out,
 * and it still cannot land here. So the news and the wall are told in one
 * breath instead of hiding either.
 */
export function updateStatusLine(
  m: UpdateModel,
  installed: string,
  blocked: boolean,
): string {
  switch (m.phase) {
    case 'idle':
      return `You're running ${installed}. Checking takes a moment of signal.`;
    case 'checking':
      return 'Asking GitHub what the newest release is…';
    case 'current':
      return `${installed} is the newest there is. Nothing to do.`;
    case 'available':
      return blocked
        ? `${m.latest} is out, and it cannot land on this phone. ${updateReasonCopy('developer-build')}`
        : `${m.latest} is out — you have ${installed}. Tap to download and install it.`;
    case 'downloading':
      return `Downloading ${m.latest ?? 'the update'}… ${m.percent ?? 0}%. It keeps going if you leave this screen.`;
    case 'handed-off':
      // Every sentence here was bought by a real install going wrong on a
      // real phone; ShareAppRow's copy carries the same three warnings for
      // the same reason.
      return 'Android is taking over. Allow installs from Playa Pal when it asks, and if Play Protect says the developer is unknown, tap "More details" then the small "Install anyway" — the big button cancels.';
    case 'failed':
      return m.reason === null ? '' : updateReasonCopy(m.reason);
  }
}

/**
 * What the row's first line — the tappable one — says it will do. Short,
 * because it is a verb and not an explanation; the sentence under it does
 * the explaining.
 */
export function updateActionLabel(m: UpdateModel, blocked: boolean): string {
  switch (m.phase) {
    case 'checking':
      return 'Checking…';
    case 'available':
      // A blocked row still NAMES the version, because knowing a newer one
      // exists is what sends the camper to whoever owns the cable.
      return blocked ? `Update available — ${m.latest}` : `Install ${m.latest}`;
    case 'downloading':
      return `Downloading… ${m.percent ?? 0}%`;
    case 'handed-off':
      return 'Handed to the installer';
    case 'idle':
    case 'current':
    case 'failed':
      return 'Check for update';
  }
}

// ---------------------------------------------------------- the native seam

export interface InstalledApp {
  /** Empty when the native half could not be asked; the row falls back to
   * the version baked into the JS bundle. */
  versionName: string;
  /** Debug-signed, so a released APK can never install over it. */
  developerBuild: boolean;
  /** Whether "install unknown apps" is already allowed for Playa Pal. */
  canInstall: boolean;
}

/**
 * What this install is. NEVER REJECTS and NEVER TOUCHES THE NETWORK — the
 * row reads it on mount, and a probe that either threw or phoned home
 * would break one of the two promises this feature is built on.
 */
export async function describeInstalledApp(): Promise<InstalledApp> {
  const blank: InstalledApp = {
    versionName: '',
    developerBuild: false,
    canInstall: false,
  };
  if (!native) {
    return blank;
  }
  try {
    const r = (await native.describe()) as Record<string, unknown> | null;
    return {
      versionName: typeof r?.versionName === 'string' ? r.versionName : '',
      developerBuild: r?.developerBuild === true,
      canInstall: r?.canInstall === true,
    };
  } catch {
    return blank;
  }
}

export type CheckResult =
  | { ok: true; latest: string }
  | { ok: false; reason: UpdateReason; detail?: string };

/**
 * Ask GitHub for the latest release tag. Never rejects, for the reason the
 * hotspot seam does not: a refusal is an answer, and it has to survive the
 * trip to the screen intact.
 *
 * THE TIMEOUT IS THE WHOLE POINT OF THE ABORT CONTROLLER. A dead radio
 * fails fast; ONE BAR DOES NOT FAIL AT ALL, it hangs, and fetch has no
 * deadline of its own. Ten seconds later the abort lands in the same catch
 * as a network error, which is why `signal.aborted` is read there rather
 * than the error's own message: a timeout and a dead radio need different
 * sentences and the exception cannot tell them apart.
 */
export async function checkLatestRelease(): Promise<CheckResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub's API refuses a request with no User-Agent outright, and
        // that refusal would read here as 'unreachable' forever.
        'User-Agent': 'PlayaPal',
      },
      signal: controller.signal,
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'rate-limited', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { tag_name?: unknown } | null;
    const tag = body?.tag_name;
    if (typeof tag !== 'string' || tag.length === 0) {
      return { ok: false, reason: 'unreachable', detail: 'no tag_name in the answer' };
    }
    return { ok: true, latest: tag };
  } catch (e: unknown) {
    return controller.signal.aborted
      ? { ok: false, reason: 'timeout' }
      : {
          ok: false,
          reason: 'offline',
          detail: e instanceof Error ? e.message : String(e),
        };
  } finally {
    clearTimeout(deadline);
  }
}

export type DownloadResult =
  | { ok: true }
  | { ok: false; reason: UpdateReason; detail?: string };

/**
 * Fetch the release APK and hand it to Android's installer. Resolves once
 * the installer is on screen; never rejects, same stance as everything
 * else across this seam.
 */
export async function downloadAndInstall(): Promise<DownloadResult> {
  if (!native) {
    return { ok: false, reason: Platform.OS === 'ios' ? 'ios' : 'absent' };
  }
  try {
    const r = (await native.download(LATEST_APK_URL)) as Record<
      string,
      unknown
    > | null;
    if (r?.ok === true) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: isUpdateReason(r?.reason) ? r.reason : 'error',
      ...(typeof r?.detail === 'string' ? { detail: r.detail } : {}),
    };
  } catch (e: unknown) {
    return {
      ok: false,
      reason: 'error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
