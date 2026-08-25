/**
 * The sharing driver — the one place that COMPOSES the crew stack: crews
 * (crew.ts) + protocol (beacon.ts, via session.ts) + radio (radio.ts) +
 * a GPS watch + the Phase C pocket service. The UI talks only to this file:
 * a toggle calls startCrewSharing/stopCrewSharing, Settings' master
 * off-switch calls stopCrewSharing, and everything re-renders off
 * session.ts's revision.
 *
 * ONE ACTIVE CREW AT A TIME (cross-family review, Aug 24): one radio, one
 * advertising slot, one payload — so the sharing toggle is exclusive.
 * Starting crew B while sharing with crew A stops A first. Scanning still
 * decodes EVERY crew this phone belongs to (knownCrewCodes), so you always
 * hear your people; exclusivity is only about what you broadcast.
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
import { getDb, getSetting, setSetting } from '../events/db';
import { getMyCard } from '../friends/friendCard';
import { listCrews, type Crew } from './crew';
import { pruneSightings } from './presence';
import {
  masterOff,
  noteRadioState,
  sessionActive,
  startSharing,
  type CrewSession,
} from './session';
import {
  crewRadio,
  ensureCrewPermissions,
  ensureNotificationPermission,
  onPocketTick,
  onRadioState,
  startPocketSession,
  stopPocketSession,
} from './radio';
import { startMeshSync, stopMeshSync } from './meshSync';

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
  crewId: string;
  session: CrewSession;
  tick: ReturnType<typeof setInterval>;
  watchId: number;
  untick: () => void;
  unstate: () => void;
} | null = null;
let lastFix: { lat: number; lon: number } | null = null;

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
  await stopCrewSharingInner(); // exclusive: one broadcast at a time

  // SEED THE FIX, DO NOT WAIT TO BE WALKED INTO EXISTENCE.
  //
  // MEASURED ON TWO PHONES, 2026-08-25: sharing ON produced ZERO
  // advertisements for 12m13s on one handset and 4m46s on the other, and only
  // an app restart put either on the air. The radio was alive throughout (565
  // scan results in the same slice) and the app HAD a position — the compass
  // was reading it — but `lastFix` stayed null, so every refresh returned
  // without advertising.
  //
  // The cause was `distanceFilter: 5`, which means "call me when the device
  // moves five metres". A phone on a table, or a camper standing at their own
  // camp, NEVER MOVES FIVE METRES — and standing still is the DEFAULT at a
  // camp, not an edge case. The one filter that reads as a battery kindness
  // made the feature not work for the commonest posture there is.
  //
  // So: ask once, immediately, and let the watch report every fix it gets
  // rather than only post-hike ones. A session must never depend on the user
  // walking to become visible.
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

  const watchId = geolocation().watchPosition(
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

  const session = startSharing({
    radio: crewRadio(),
    crewCode: crew.code,
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

  active = { crewId: crew.id, session, tick, watchId, untick, unstate };

  try {
    await session.started;
  } catch (e) {
    await stopCrewSharingInner();
    throw e instanceof Error
      ? e
      : new Error('Bluetooth is off — turn it on to share with your pod.');
  }

  // Intent is stamped AFTER the session proved it could start, not before:
  // a start that failed leaves the user reading the thrown Alert, and a
  // "sharing ended when the app closed" row under an Alert that just said
  // Bluetooth is off would be two surfaces disagreeing about one moment.
  setSetting(SHARING_INTENT_KEY, crew.id);

  // Pocket survival (Phase C): the notification permission gates the
  // service's consent surface; a denial degrades to foreground-only
  // sharing rather than failing the whole toggle.
  if (await ensureNotificationPermission()) {
    try {
      await startPocketSession();
    } catch {
      // Foreground-only degrade — the toggle stays honest either way.
    }
  }

  // The answering machine rides the same radio window: sightings trigger
  // mailbox syncs, and the GATT server serves our mailbox to anyone in the
  // pod who asks (docs/CREW-DESIGN.md §6b — a plugged-in phone with this
  // left on IS the base station; no special mode).
  startMeshSync(() => listCrews().map(c => c.code));
}

export function stopCrewSharing(): Promise<void> {
  return serialized(stopCrewSharingInner);
}

async function stopCrewSharingInner(): Promise<void> {
  // Every DELIBERATE stop runs through here — the user's own flip, the
  // Settings master-off, the exclusive-stop when another pod starts, and
  // the teardown of a start that failed. All of them mean "off is the
  // truth now", so the persisted intent goes with them. The one path that
  // does NOT run this function is the process dying — which is exactly the
  // case the intent exists to outlive.
  setSetting(SHARING_INTENT_KEY, '');
  stopMeshSync();
  const a = active;
  active = null;
  if (a) {
    clearInterval(a.tick);
    a.untick();
    a.unstate();
    geolocation().clearWatch(a.watchId);
  }
  await stopPocketSession();
  await masterOff(); // idempotent; bumps the session revision for the UI
}
