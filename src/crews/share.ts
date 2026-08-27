/**
 * The sharing driver — the one place that COMPOSES the crew stack: crews
 * (crew.ts) + protocol (beacon.ts, via session.ts) + radio (radio.ts) +
 * a GPS watch + the Phase C pocket service. The UI talks only to this file:
 * a toggle calls startCrewSharing/stopCrewSharing, Settings' master
 * off-switch calls stopCrewSharing, and everything re-renders off
 * session.ts's revision.
 *
 * TWO LAYERS ON ONE RADIO (the mailbox decoupling, 2026-08-25). This file
 * used to be the ONLY caller that ever started the crew radio, and it did
 * so only from the position-sharing toggle. So a pod where nobody had
 * flipped that switch had no radio at all: no scan, no advertisement, no
 * GATT server — and pod messages and voice notes, which move on sightings
 * (meshSync.ts), never moved. MEASURED on two adjacent Pixels with both
 * apps open, 2026-08-25: sharing off on both = zero PlayaMesh log lines in
 * 47 s and nothing delivered; sharing on both sides = 225/248 lines and the
 * same message in 27.4 s. The owner lost an hour of playa to it.
 *
 *  - MAILBOX PRESENCE arms whenever the app is FOREGROUND and this phone
 *    has a pod (installMailboxPresence below). It advertises the 17-byte
 *    position-free frame, scans, serves the GATT mailbox and runs mesh
 *    sync. No GPS watch is started, because there is no position in it.
 *  - POSITION SHARING is the same session with the place layered on: the
 *    toggle starts the GPS watch and calls session.setShareCrew(code), and
 *    turning it off calls setShareCrew(null) — back to mailbox-only, NOT
 *    to a dead radio.
 *
 * The consent story is unchanged, and this is the line to hold: a
 * coordinate reaches the air only while the user's own toggle says so. A
 * podmate who hears a mailbox frame learns that someone in the pod is in
 * range and has mail — which any BLE mailbox necessarily discloses, since
 * being reachable is what makes delivery possible — and learns nothing
 * about where.
 *
 * BATTERY HONESTY: mailbox presence stops when the app backgrounds unless a
 * share session is holding the radio (that session has its own consent, its
 * own foreground service and its own notification). Background mail is the
 * pocket-notifications lane's to build; the seam is stopMailboxPresence(),
 * which is the one place that would learn to stay armed.
 *
 * ONE ACTIVE CREW AT A TIME (cross-family review, Aug 24): one radio, one
 * advertising slot, one payload — so the sharing toggle is exclusive.
 * Starting crew B while sharing with crew A stops A first. Scanning still
 * decodes EVERY crew this phone belongs to (knownCrewCodes), so you always
 * hear your people; exclusivity is only about what POSITION you broadcast —
 * mailbox posture takes every pod in turn, so a second pod still recognizes
 * this phone as one of its own (its mail moves either way; see the rotation
 * note in session.ts for why those are different questions).
 *
 * RADIO OUTAGES, end to end (measured 2026-08-24, both phones):
 *  - Bluetooth off mid-session: the native module emits CrewBeaconState,
 *    session.ts parks 'bluetooth-off', the switch's own revision bumps and
 *    the UI stops promising visibility. The GPS watch, the tick and the
 *    foreground service all keep running — the session did not end, its
 *    radio did, and the Android notification says so.
 *  - Bluetooth back: the adapter-state event drives session.resumeRadio(),
 *    which restarts scan + advertise (and with it the GATT server). No user
 *    tap. Cycling the switch by hand was the field workaround, never the
 *    design.
 *  - Bluetooth off mid-SYNC: the in-flight GATT connection dies with the
 *    adapter; meshSync already fails per-peer and the next sighting after
 *    recovery re-drives it. Nothing to restart here.
 *  - A walkie hold is untouched by any of this: the walkie rides Wi-Fi/LAN,
 *    not BLE, so a dead Bluetooth adapter neither stops it nor is stopped
 *    by it (docs/PUNCHLIST.md, transport policy).
 *  - Permission revoked (as opposed to adapter off) is NOT auto-recovered:
 *    it needs the user, and startCrewSharing's in-context ask is the route
 *    back. Only the adapter recovers by itself.
 *
 * CREW_CENTER is a PROTOCOL CONSTANT, not a per-phone asset read: both
 * ends must quantize against the same origin, and a phone whose geometry
 * asset failed to load must still agree with one whose didn't. The value
 * mirrors assets/city-geo/geometry.json's center for 2026; a future year's
 * re-drop moves the city and must bump BEACON_VERSION with it.
 */
import { AppState, Platform } from 'react-native';
import { getDb, getSetting, setSetting } from '../events/db';
import { getMyCard } from '../friends/friendCard';
import { listCrews, subscribeCrewsChanged, type Crew } from './crew';
import { pruneSightings } from './presence';
import {
  masterOff,
  noteRadioState,
  sessionActive,
  startCrewSession,
  type CrewSession,
} from './session';
import {
  crewRadio,
  crewRadioPresent,
  ensureCrewPermissions,
  haveCrewPermissions,
  onPocketTick,
  onRadioState,
  setCrewAdvertisingHold,
  startPocketSession,
  stopPocketSession,
} from './radio';
import { startMeshSync, stopMeshSync } from './meshSync';
import {
  armPocketAlerts,
  pocketAlertsChoice,
  startPocketAlerts,
  stopPocketAlerts,
} from './pocketAlerts';

export const CREW_CENTER = { lat: 40.783242, lon: -119.207871 };

// Geolocation is required LAZILY: its module-scope NativeEventEmitter
// construction throws in any native-free environment (jest), and merely
// IMPORTING a screen that imports this file must never drag a native
// module in — the same discipline the native CrewBeacon methods follow.
function geolocation() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@react-native-community/geolocation').default;
}

/** Foreground refresh cadence (screen on): position re-advertised and stale
 * sightings pruned. The pocket service ticks its own 30 s instead. */
const TICK_MS = 15_000;

let active: {
  /** The pod whose POSITION is on the air, or null in mailbox posture. */
  crewId: string | null;
  session: CrewSession;
  tick: ReturnType<typeof setInterval>;
  /** The GPS watch, which exists ONLY while a position is being shared —
   * mailbox posture never asks the phone for a fix. */
  watchId: number | null;
  untick: () => void;
  unstate: () => void;
} | null = null;
let lastFix: { lat: number; lon: number } | null = null;
/** App posture, as this file's lifecycle sees it (installMailboxPresence).
 * Mailbox presence is a foreground affordance; sharing is not. */
let foreground = false;

/**
 * ONE flip at a time. Both exported verbs run through this queue because
 * both mutate `active` across several awaits — a double-tapped switch used
 * to run two bring-ups concurrently, and the loser's GPS watch, interval
 * and native listeners leaked for the life of the process while `active`
 * pointed at the winner (composed review finding #6, Aug 24). Serializing
 * is the whole fix: the second tap now waits for the first to settle and
 * then does the right thing from a settled state.
 *
 * The queue never rejects — a caller's error is delivered to that caller
 * only, so one failed toggle cannot wedge every later one.
 */
let flips: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = flips.then(op);
  flips = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Which crew's toggle is on — UI reads this under session.ts's revision
 * subscription (sessionRevision bumps on every start/stop). */
export function sharingCrewId(): string | null {
  return sessionActive() && active ? active.crewId : null;
}

/**
 * Is this phone carrying pod mail right now — advertising position-free,
 * scanning, serving its mailbox? True in BOTH postures (a shared position
 * rides the same session), because the question the pod card asks with it
 * is "will a message move", and the answer does not depend on whether a
 * place is riding along.
 */
export function mailboxPresenceOn(): boolean {
  return sessionActive() && active !== null;
}

/**
 * The INTENT, persisted — which pod the user last turned sharing ON for,
 * cleared only when code deliberately turns it off.
 *
 * Everything else about a session lives in module variables and native
 * state, and a process death takes all of it: the appearance toggle
 * restarts the app, Android reclaims memory, a camper force-stops to save
 * battery. Measured three times in one evening — the switch simply read
 * off afterwards, with nothing anywhere saying sharing had been on, and a
 * camper who never looks is invisible to their pod for the rest of the day.
 *
 * The row this key feeds does not auto-start anything. Radio and GPS wake
 * on a user's gesture, not a process launch — the persisted intent's whole
 * job is to make the death SAYABLE, and the existing switch is the one-tap
 * resume.
 */
export const SHARING_INTENT_KEY = 'crew_sharing_intent';

/** The pod the user meant to be sharing with, dead session or not. Null
 * once sharing is deliberately off. */
export function sharingIntentCrewId(): string | null {
  const v = getSetting(SHARING_INTENT_KEY);
  return v ? v : null;
}

/** True exactly when the session died OUT FROM UNDER the intent — the
 * process was killed while sharing was on. The pod card renders this;
 * flipping the switch (either way) resolves it through the verbs below. */
export function sharingDiedWithProcess(crewId: string): boolean {
  return sharingIntentCrewId() === crewId && sharingCrewId() === null;
}

/**
 * SEED THE FIX, DO NOT WAIT TO BE WALKED INTO EXISTENCE.
 *
 * MEASURED ON TWO PHONES, 2026-08-25: sharing ON produced ZERO
 * advertisements for 12m13s on one handset and 4m46s on the other, and only
 * an app restart put either on the air. The radio was alive throughout (565
 * scan results in the same slice) and the app HAD a position — the compass
 * was reading it — but `lastFix` stayed null, so every refresh returned
 * without advertising.
 *
 * The cause was `distanceFilter: 5`, which means "call me when the device
 * moves five metres". A phone on a table, or a camper standing at their own
 * camp, NEVER MOVES FIVE METRES — and standing still is the DEFAULT at a
 * camp, not an edge case. The one filter that reads as a battery kindness
 * made the feature not work for the commonest posture there is.
 *
 * So: ask once, immediately, and let the watch report every fix it gets
 * rather than only post-hike ones. A session must never depend on the user
 * walking to become visible.
 *
 * THE WATCH IS PART OF SHARING, NOT OF THE RADIO: mailbox posture never
 * calls this, so a phone that is only carrying mail never wakes the GPS.
 */
function startPositionWatch(): number {
  geolocation().getCurrentPosition(
    (pos: { coords: { latitude: number; longitude: number } }) => {
      if (lastFix === null) {
        lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      }
    },
    () => {
      // No immediate fix: the watch below is still running and the session
      // now SAYS it is waiting (session.ts 'no-fix'), instead of looking on.
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
  );
  return geolocation().watchPosition(
    (pos: { coords: { latitude: number; longitude: number } }) => {
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    },
    () => {
      // A failed watch just means no fix yet. It is no longer SILENT: the
      // session raises 'no-fix' and the pod card says it is waiting.
    },
    // distanceFilter dropped deliberately — see above. The beacon is already
    // rate-limited by the session's own refresh cadence, so filtering here
    // bought nothing and cost the stationary case entirely.
    { enableHighAccuracy: true },
  );
}

/**
 * Bring the radio up in one posture or the other and wire everything that
 * is common to both: the foreground cadence, the pocket service's tick, and
 * the native radio-state stream. Consent and permissions are the CALLERS'
 * business — this function only builds what they decided.
 */
function armSession(
  shareCrewCode: string | null,
  crewId: string | null,
): CrewSession {
  const session = startCrewSession({
    radio: crewRadio(),
    shareCrewCode,
    myCardId: getMyCard(getDb()).id,
    center: CREW_CENTER,
    getPosition: () => lastFix,
    knownCrewCodes: () => listCrews().map(c => c.code),
  });

  const tick = setInterval(() => {
    session.refresh().catch(() => {
      // A single failed refresh (radio hiccup) self-heals on the next tick.
    });
    pruneSightings(Date.now());
  }, TICK_MS);
  const untick = onPocketTick(() => {
    session.refresh().catch(() => {});
    pruneSightings(Date.now());
  });
  // THE RADIO'S OWN ACCOUNT OF ITSELF. This is the seam that finding #4
  // named: both native modules emit CrewBeaconState and, until now, nothing
  // in src/ listened — so a phone whose Bluetooth died went on rendering a
  // checked switch and the copy that promises your pod can see you. The
  // session owns what the events MEAN (honesty + bounce recovery); this
  // file owns the wire, because it is the one that imports native.
  const unstate = onRadioState(noteRadioState);

  active = {
    crewId,
    session,
    tick,
    watchId: shareCrewCode === null ? null : startPositionWatch(),
    untick,
    unstate,
  };
  return session;
}

/** Everything down: no advert, no scan, no mesh, no GPS, no service. The
 * end of BOTH postures, and the only path that clears the radio. */
async function teardownSession(): Promise<void> {
  stopMeshSync();
  // The pocket buzz rides the mesh window (pocketAlerts.ts): records can
  // only arrive while the mesh runs, so the subscription ends where the
  // mesh ends — for BOTH postures, since this is the end of both.
  stopPocketAlerts();
  const a = active;
  active = null;
  if (a) {
    clearInterval(a.tick);
    a.untick();
    a.unstate();
    if (a.watchId !== null) {
      geolocation().clearWatch(a.watchId);
    }
  }
  lastFix = null;
  await stopPocketSession();
  await masterOff(); // idempotent; bumps the session revision for the UI
}

/** Should this phone be carrying pod mail right now? Foreground, a radio in
 * this build, and at least one pod to be a mailbox for. */
function mailboxWanted(): boolean {
  return foreground && crewRadioPresent() && listCrews().length > 0;
}

function shareError(e: unknown): Error {
  return e instanceof Error
    ? e
    : new Error('Bluetooth is off — turn it on to share with your pod.');
}

/**
 * Flip sharing ON for one crew. Throws with human-actionable copy when the
 * phone says no (permission, Bluetooth off) — the caller Alerts it verbatim
 * (design §5's recoverable-denial rule).
 */
export function startCrewSharing(crew: Crew): Promise<void> {
  return serialized(() => startCrewSharingInner(crew));
}

async function startCrewSharingInner(crew: Crew): Promise<void> {
  const ok = await ensureCrewPermissions();
  if (!ok) {
    throw new Error(
      'Playa Pal needs the Bluetooth permission to share with your pod — allow it and flip the switch again.',
    );
  }

  const held = active;
  if (held) {
    // The radio is ALREADY UP — as this pod's mailbox, another pod's
    // mailbox, or another pod's position share (which this replaces: one
    // broadcast at a time). All three are a payload change, not a restart:
    // restarting would mint a fresh BLE address, drop the scan for a
    // window, and reset every peer's freshness bookkeeping to prove
    // nothing.
    if (held.watchId === null) {
      held.watchId = startPositionWatch();
    }
    held.crewId = crew.id;
    try {
      await held.session.setShareCrew(crew.code);
    } catch (e) {
      await stopCrewSharingInner();
      throw shareError(e);
    }
  } else {
    const session = armSession(crew.code, crew.id);
    try {
      await session.started;
    } catch (e) {
      await stopCrewSharingInner();
      throw shareError(e);
    }
  }

  // Intent is stamped AFTER the session proved it could start, not before:
  // a start that failed leaves the user reading the thrown Alert, and a
  // "sharing ended when the app closed" row under an Alert that just said
  // Bluetooth is off would be two surfaces disagreeing about one moment.
  setSetting(SHARING_INTENT_KEY, crew.id);

  // Pocket survival (Phase C): the notification permission gates the
  // service's consent surface; a denial degrades to foreground-only
  // sharing rather than failing the whole toggle. armPocketAlerts wraps
  // the SAME POST_NOTIFICATIONS ask (radio.ts) and remembers the answer,
  // so this is also the pocket-alerts lane's one in-context ask — first
  // share arms both, a stored decline silences both permanently, and the
  // way back is the Settings row (pocketAlerts.ts).
  if (await armPocketAlerts()) {
    try {
      await startPocketSession();
    } catch {
      // Foreground-only degrade — the toggle stays honest either way.
    }
  }

  // The answering machine rides the same radio window: sightings trigger
  // mailbox syncs, and the GATT server serves our mailbox to anyone in the
  // pod who asks (docs/CREW-DESIGN.md §6b — a plugged-in phone with this
  // left on IS the base station; no special mode). Idempotent: mailbox
  // presence usually started it before the toggle was ever touched.
  startMeshSync(() => listCrews().map(c => c.code));
  // …and the pocket buzz rides the mesh window: records can only ARRIVE
  // while the mesh runs, so the alert subscription shares its lifetime.
  startPocketAlerts(() => getMyCard(getDb()).id);
}

export function stopCrewSharing(): Promise<void> {
  return serialized(stopCrewSharingInner);
}

async function stopCrewSharingInner(): Promise<void> {
  // Every DELIBERATE stop runs through here — the user's own flip, the
  // Settings master-off, and the teardown of a start that failed. All of
  // them mean "off is the truth now", so the persisted intent goes with
  // them. The one path that does NOT run this function is the process
  // dying — which is exactly the case the intent exists to outlive.
  setSetting(SHARING_INTENT_KEY, '');
  const a = active;
  if (a) {
    if (a.watchId !== null) {
      geolocation().clearWatch(a.watchId);
      a.watchId = null;
    }
    // The last fix goes with the watch that fed it. Nothing refreshes it
    // now, and a position kept across an off/on cycle would go out stamped
    // with the CURRENT minute — an old place presented as a live one, the
    // exact steering lie the protocol's replay guard exists to prevent.
    lastFix = null;
    a.crewId = null;
  }
  // The pocket service is the SHARE session's consent surface (its
  // notification says the pod can see you), so it ends with the sharing —
  // mailbox presence is foreground-only and never had one.
  await stopPocketSession();
  if (a && mailboxWanted()) {
    // THE WHOLE POINT: turning off "share my position" is not turning off
    // your pod's mail. Same session, same address, same GATT server — the
    // advert simply drops back to the position-free frame.
    // eslint-disable-next-line no-console
    console.log('PlayaMesh mailbox//keep reason=sharing-off');
    try {
      await a.session.setShareCrew(null);
      return;
    } catch {
      // The radio refused to re-key. Then nothing may stay on the air:
      // falling through to a full teardown is the only state we can
      // honestly claim.
    }
  }
  await teardownSession();
}

// ------------------------------------------------- the walkie's airtime
//
// MEASURED 2026-08-26, three phones on a bench: an iPhone carried live BLE
// voice to an Android for the first time — and neither Android ever saw
// that iPhone in their channel. P7's logcat proved the other Pixel's PV
// hash over and over and never once attempted the iPhone's, because the
// UUID-filtered Android scan never matched the iPhone's advertisement at
// all.
//
// The reason is a 31-byte budget, and it is Apple's documented behaviour
// rather than anyone's bug. With the walkie open, an iPhone runs TWO
// advertisers: WalkieBleVoice's (rung 3's 128-bit service UUID plus the
// "PV…" local name that carries the identity) and CrewBeacon's (the crew
// service UUID). Two 128-bit UUIDs do not fit one primary advertising
// packet, so CoreBluetooth moves the service UUIDs into the proprietary
// OVERFLOW AREA — which Apple's own documentation says is discoverable
// only by an iOS device explicitly scanning for that exact UUID. Android's
// ScanFilter.setServiceUuid cannot match it. Two advertisers therefore do
// not halve the iPhone's reach; they remove it from Android entirely.
//
// SO THE WALKIE GETS THE AIRTIME WHILE IT IS OPEN. The seam is here in JS
// and deliberately NOT native-to-native: rung 3's voice link and the crew
// beacon are separate concerns that happen to share one radio, and the
// only layer that knows both were asked for at once is the app.
//
// THE TRADE, SAID PLAINLY, because it is a real cost and not a free win:
//
//  - What stops is being FOUND by a fresh scan. Nothing else stops. The
//    crew SCAN keeps running, so this phone keeps hearing its pod and
//    keeps dialling podmates as a central — which is the direction mail
//    already flowed from an iPhone (CrewBeacon.swift: iOS peers have no
//    inline payload, so every exchange is a connect-and-read anyway).
//  - The GATT server stays published. stopAdvertising() does not remove
//    the service, so a peer that already holds this phone's address can
//    still connect and read the mailbox; it is DISCOVERY that pauses.
//  - What an Android genuinely loses is dialling this iPhone cold — and
//    it could not do that during a walkie anyway. That is the whole bug.
//  - It is bounded by a gesture. The walkie is an explicitly open surface
//    with a mini-bar saying it is on; none of this can be true while the
//    camper believes their radio is off.
//
// ANDROID IS UNTOUCHED, and the gate sits here rather than in radio.ts so
// the mechanism stays a mechanism: an Android advertiser puts its data in
// the packet directly, both advertising sets coexist, and holding the crew
// beacon there would cost pod mail to cure a problem that platform does
// not have.

/** Does the walkie need the advertising slot to itself on this platform? */
function walkieNeedsAirtime(): boolean {
  return Platform.OS === 'ios';
}

/**
 * Take the crew beacon off the air for the walkie's session. Serialized
 * with every other flip, because it changes the same radio they do, and
 * idempotent: holding an already-held — or never-started — beacon is a
 * no-op that resolves.
 */
export function holdCrewAdvertising(): Promise<void> {
  return serialized(async () => {
    if (!walkieNeedsAirtime()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log('PlayaMesh advertise//hold reason=walkie-airtime');
    await setCrewAdvertisingHold(true);
  });
}

/**
 * Give the slot back. Clearing the flag alone would leave the phone silent
 * until the next 15 s tick, so the live session is refreshed straight
 * away — and if the session was torn down and rebuilt while the walkie was
 * open (backgrounded, then foregrounded: mailbox presence stops and
 * re-arms), the refresh lands on whichever session is standing NOW. A
 * phone with no session at all needs nothing: its next armSession
 * advertises normally, because the flag it reads is already clear.
 */
export function releaseCrewAdvertising(): Promise<void> {
  return serialized(async () => {
    if (!walkieNeedsAirtime()) {
      return;
    }
    await setCrewAdvertisingHold(false);
    const a = active;
    if (!a) {
      return;
    }
    try {
      await a.session.refresh();
    } catch {
      // The radio refused to come back right now. The cadence tick and the
      // adapter-state recovery both re-drive refresh(), so this heals by
      // itself; failing the walkie's stop over it would help nobody.
    }
  });
}

/**
 * Arm mailbox presence: this phone advertises position-free, scans, serves
 * its mailbox and syncs. Silent about every reason it declines, because
 * nobody asked for it — it rides the app's lifecycle, not a gesture. In
 * particular it NEVER prompts for permission: a system dialog that appears
 * because an app was opened is not consent, so an ungranted phone simply
 * stays quiet until the share toggle's in-context ask.
 */
export function startMailboxPresence(): Promise<void> {
  return serialized(startMailboxPresenceInner);
}

async function startMailboxPresenceInner(): Promise<void> {
  if (active) {
    return; // a session (either posture) already holds the radio
  }
  if (!crewRadioPresent() || listCrews().length === 0) {
    return; // no radio in this build, or no pod to be a mailbox for
  }
  if (!(await haveCrewPermissions())) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`PlayaMesh mailbox//start pods=${listCrews().length}`);
  const session = armSession(null, null);
  try {
    await session.started;
  } catch {
    // Bluetooth off, or the radio refused. No user is waiting on an Alert
    // here; the next foreground (or the share toggle) tries again.
    // eslint-disable-next-line no-console
    console.log('PlayaMesh mailbox//start-failed');
    await teardownSession();
    return;
  }
  startMeshSync(() => listCrews().map(c => c.code));
  // The buzz rides this posture's mesh window too — but the mailbox path
  // never prompts (a dialog raised because an app was opened is not
  // consent): only a stored grant arms the subscription, silently. The
  // ask itself stays with the deliberate gestures (sharing, walkie-open).
  if (pocketAlertsChoice() === 'granted') {
    startPocketAlerts(() => getMyCard(getDb()).id);
  }
}

/**
 * Disarm mailbox presence — the battery half of the bargain. A SHARE
 * session is never touched: it has its own consent, its own foreground
 * service and its own notification saying so.
 *
 * THE SEAM the pocket-notifications lane wants: keeping mail moving in the
 * background is this one function learning to stay armed (with the
 * foreground service and the notification that honesty requires). Nothing
 * else in the chain assumes foreground.
 */
export function stopMailboxPresence(): Promise<void> {
  return serialized(stopMailboxPresenceInner);
}

async function stopMailboxPresenceInner(): Promise<void> {
  if (!active || active.crewId !== null) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log('PlayaMesh mailbox//stop reason=background');
  await teardownSession();
}

/**
 * Wire mailbox presence to the app's own lifecycle. Called ONCE from
 * App.tsx; returns the unsubscribe for symmetry with every other
 * subscription there.
 *
 * Two triggers, because two things make the answer change: app posture
 * (foreground/background) and whether this phone has a pod at all — joining
 * one must put the radio up right then, not at the next time the app is
 * backgrounded and reopened. 'inactive' (iOS's transient state, raised by a
 * notification shade or an incoming call) is deliberately NOT a stop: the
 * app is a second from being back, and a radio that flapped with it would
 * cost more battery than it saved.
 */
export function installMailboxPresence(): () => void {
  // Nothing here has a caller to tell. A lifecycle event that cannot bring
  // the radio up (no card yet, a store mid-migration, Bluetooth off) must
  // leave a quiet phone and an unbroken app, never an unhandled rejection
  // from a subscription callback — the verbs still reject for the toggle,
  // which is the caller that HAS somewhere to put the news.
  const quietly = (p: Promise<void>): void => {
    p.catch(() => undefined);
  };
  foreground = AppState.currentState === 'active';
  if (foreground) {
    quietly(startMailboxPresence());
  }
  const sub = AppState.addEventListener('change', st => {
    if (st === 'active') {
      foreground = true;
      quietly(startMailboxPresence());
    } else if (st === 'background') {
      foreground = false;
      quietly(stopMailboxPresence());
    }
  });
  const offCrews = subscribeCrewsChanged(() => {
    if (foreground && listCrews().length > 0) {
      quietly(startMailboxPresence());
    } else if (listCrews().length === 0) {
      // The last pod was disbanded: there is nobody to carry mail for, and
      // an advert for a pod that no longer exists is a claim about nothing.
      quietly(stopMailboxPresence());
    }
  });
  return () => {
    sub.remove();
    offCrews();
  };
}
