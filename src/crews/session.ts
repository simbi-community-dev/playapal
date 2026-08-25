/**
 * Crew sharing session — the state machine between the UI's consent toggle
 * and the radio (Crew Phase B, docs/CREW-DESIGN.md §2/§4). This file is
 * PURE TypeScript: the BLE hardware arrives as an injected CrewRadio, so
 * the whole consent/lifecycle story is testable with a fake radio and the
 * native half (built in parallel) only has to satisfy one small interface.
 *
 * CONSENT MODEL (N2Y's proven shape, design §2): sharing is tied to a
 * SESSION you start, not to crew membership — being in a crew never makes
 * you visible by itself. The UI copy this enforces (design §5): "Share my
 * position with [crew name] — this is the only way anyone sees where you
 * are; off means no one, on any device, can see it." masterOff() is the
 * distinct Settings-level kill ("Stop sharing with everyone"): one call,
 * every active share ends, no per-crew hunting.
 *
 * RADIO HONESTY + BOUNCE RECOVERY (measured on two phones, 2026-08-24).
 * Turning Bluetooth off under a live session left the switch reading ON, the
 * copy still promising "your pod sees which way and how far", and the
 * foreground service still ticking: a camper whose radio died believed they
 * were findable. And when the adapter came back, nothing restarted — the
 * service kept calling setPayload into a module that was no longer
 * advertising (PlayaMesh: repeating `advertise//payload advertising=false`
 * with no `advertise//started`), so the phone stayed invisible until the
 * toggle was cycled by hand. Both halves live here:
 *
 *  - HONESTY: noteRadioState() consumes the native CrewBeaconState stream
 *    (wired by share.ts, which owns the native imports) and parks a reason
 *    in radioInterrupted(). Sharing is then never silently off and never
 *    pretending on — it is INTERRUPTED, with a why. The session revision
 *    bumps, so every existing subscribeSessionChanged consumer re-renders.
 *  - RECOVERY: when the adapter comes back while the session is still
 *    active, resumeRadio() re-arms the radio legs itself. The user said
 *    "share until I turn it off"; an outage is not them turning it off.
 *
 * This file stays PURE — no NativeModules import, no event emitter. The
 * native subscription is share.ts's job (it already composes radio.ts), so
 * the whole interrupted/recovery state machine stays unit-testable with a
 * fake radio and a hand-fed state event.
 *
 * NO TIMERS IN HERE — deliberately. The session exposes refresh() and the
 * CALLER owns the cadence, because cadence is a battery/lifecycle concern,
 * not a protocol one: in Phase B a foregrounded screen ticks it (and stops
 * ticking the moment the app backgrounds, for free, because the JS timer
 * pauses with it); in Phase C a foreground service owns the tick under its
 * own battery budget and Play-review story. A setInterval baked in here
 * would hard-wire Phase B's lifecycle into the protocol layer and have to
 * be torn back out.
 */

import {
  buildPayload,
  decodeBeacon,
  encodeBeacon,
  hash32,
  obfuscate,
  timeBucketOf,
} from './beacon';
import { reportSighting } from './presence';

/**
 * THE seam the native half implements. Semantics the native side must
 * honor (agreed with the parallel BLE build):
 *
 * - advertise(payload): put these exact bytes on the air, REPLACING any
 *   prior advertisement (set-state, not enqueue). Android: inline in the
 *   advertisement (manufacturer/service data) so receivers read passively.
 *   iOS: advertise the crew service UUID and serve the same bytes from a
 *   readable GATT characteristic — CoreBluetooth cannot inline data, so
 *   receivers connect-and-read; the payload is identical either way.
 * - stopAdvertising(): go silent. Idempotent — may be called when nothing
 *   is advertising.
 * - startScan(onSighting): begin scanning and call onSighting(bytes) with
 *   each candidate payload (Android: the raw advertisement's data; iOS
 *   peers: the characteristic bytes after connect-and-read). Deliver
 *   EVERYTHING plausibly ours — decoding, dedup and crew-matching happen
 *   here in TS; a wrong or foreign payload is cheap to reject.
 * - stopScan(): stop and release the callback. Idempotent.
 *
 * All four settle their returned promise when the radio state actually
 * changed (or reject with a human-actionable error — e.g. Bluetooth off —
 * which the UI surfaces via the design's degrade copy, §5).
 */
export interface CrewRadio {
  advertise(payload: Uint8Array): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScan(onSighting: (bytes: Uint8Array) => void): Promise<void>;
  stopScan(): Promise<void>;
}

export interface StartSharingOpts {
  radio: CrewRadio;
  /** The crew this session ADVERTISES to (one session = one crew's share
   * toggle; scanning still hears every crew via knownCrewCodes). */
  crewCode: string;
  /** My FriendCard.id — the identity crew mates resolve me by. */
  myCardId: string;
  /** Golden-spike origin both sides quantize against
   * (getCityGeometry().center) — injected so this stays geometry-free. */
  center: { lat: number; lon: number };
  /** Latest GPS fix, or null when there isn't one worth broadcasting. */
  getPosition: () => { lat: number; lon: number } | null;
  /** Every crew code this phone belongs to — read FRESH per sighting, so
   * joining/leaving a crew mid-session changes what we hear immediately. */
  knownCrewCodes: () => string[];
  /** Injectable clock (tests; protocol functions never read time). */
  now?: () => number;
}

export interface CrewSession {
  /** Settles when the radio is actually up (scan started + first beacon
   * out if a fix existed). startSharing returns synchronously so the UI
   * toggle flips instantly; await/catch THIS to surface radio errors
   * ("Bluetooth is off — ...", design §5 degrade copy). */
  started: Promise<void>;
  /** One cadence tick: re-advertise the current fix (fresh time bucket,
   * fresh position) and, with no fix, go silent rather than keep a stale
   * position on the air — a wrong "live" arrow is worse than none. */
  refresh(): Promise<void>;
  /** Re-arm the radio legs after an outage the SESSION survived but the
   * RADIO did not (Bluetooth toggled off and back on). Restarts the scan —
   * which the cadence tick never retries, it only re-advertises — and puts
   * a fresh beacon on the air. Idempotent and serialized: two adapter-on
   * events cannot double-start the scan. A stopped session ignores it. */
  resumeRadio(): Promise<void>;
  /** End the session: stop advertising AND scanning. Idempotent — every
   * call returns the same settled promise. */
  stop(): Promise<void>;
}

// ------------------------------------------------------------- revisions
// The favorites revision-emitter pattern (src/events/favorites.ts): the
// share toggle and the master switch both render from this one signal.

let revision = 0;
const watchers = new Set<() => void>();

export function sessionRevision(): number {
  return revision;
}

export function subscribeSessionChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifySessionChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

// ---------------------------------------------------------------- session

/** The single active session — module-level so masterOff() can always
 * reach it. ONE session at a time is the Phase B model: one advertisement
 * slot, one scan, one consent state to reason about. */
let active: CrewSession | null = null;

export function sessionActive(): boolean {
  return active !== null;
}

// ------------------------------------------------------- radio honesty
// The consumer of these is src/crews/CrewSection.tsx (the share switch and
// its copy) — it already subscribes with
// useSyncExternalStore(subscribeSessionChanged, sessionRevision), so
// reading radioInterrupted() in that render is the whole wiring. Settings'
// master switch reads the same signal. This module deliberately exports the
// ACCESSOR rather than any copy: the words are the UI's business.

/** Why the radio cannot carry the session right now.
 *  - 'bluetooth-off'    the adapter is off. Recovers BY ITSELF when it
 *                       comes back — the user need do nothing.
 *  - 'advertise-failed' the adapter is on but the radio refused (advertise
 *                       or scan start failed: too many advertisers, chipset
 *                       hiccup). Self-heals on a later tick or adapter-on.
 *  - 'permission'       the Bluetooth grant is gone. Needs the USER; no
 *                       amount of retrying fixes it, so we never auto-retry
 *                       and the UI must offer the ask instead. */
export type RadioDownReason =
  | 'bluetooth-off'
  | 'advertise-failed'
  | 'permission'
  /**
   * NO POSITION YET. Not a radio fault at all — the radio is fine and the
   * session is running; there is simply nothing to advertise, because a
   * beacon IS a position.
   *
   * It lives in this union rather than in a second state of its own because
   * the question a camper is asking has ONE answer: "sharing is on — can my
   * pod see me, and if not, why not?" Two parallel states would mean two
   * surfaces that can disagree, and one of them would eventually be the only
   * one wired. Composing beats paralleling.
   *
   * NAMING DEBT, stated rather than hidden: the accessor is still called
   * radioInterrupted() and this reason is not about a radio. Renaming the
   * seam mid-train would churn every caller and both screens for no
   * behavioural gain, so it is deliberately deferred — the union is "why the
   * session cannot be carried", and that is what the docstring now says.
   */
  | 'no-fix';

/** The native CrewBeaconState event, structurally. Both native modules emit
 * { advertising, scanning, adapterEnabled?, error? }; adapterEnabled is
 * optional so an older/partial emitter (or a test) reads as "unchanged"
 * rather than as "the adapter is off". */
export interface RadioStateEvent {
  advertising: boolean;
  scanning: boolean;
  adapterEnabled?: boolean;
  error?: string;
}

let interrupted: { down: boolean; why: RadioDownReason } | null = null;
/** One re-arm in flight at a time: an adapter-on burst (Android emits
 * ACTION_STATE_CHANGED once, but the module's own started/scan events land
 * in the same window) must not start three scans. */
let resuming = false;

/**
 * Null when sharing is genuinely carried (or not on at all); otherwise the
 * reason the radio cannot carry it. `down` is always true when the object
 * exists — it is there so the UI reads
 * `radioInterrupted()?.down` without a truthiness pun.
 */
export function radioInterrupted(): { down: boolean; why: RadioDownReason } | null {
  return active ? interrupted : null;
}

function setInterrupted(next: { down: boolean; why: RadioDownReason } | null): void {
  if ((interrupted?.why ?? null) === (next?.why ?? null)) {
    return; // same truth, no re-render
  }
  interrupted = next;
  notifySessionChanged();
}

/** Classify one native state event. Exported for the tests that pin the
 * mapping; the honesty rule is that ONLY an error or a known-off adapter
 * counts as down. A quiet `advertising:false` is the session deliberately
 * going silent with no GPS fix (refresh() does exactly that) and must never
 * raise an interruption. */
export function radioDownReason(s: RadioStateEvent): RadioDownReason | null {
  const err = s.error ?? '';
  if (/permission|unauthorized|denied/i.test(err)) {
    return 'permission';
  }
  if (s.adapterEnabled === false || /bluetooth[- ]is[- ]off|bluetooth-off/i.test(err)) {
    return 'bluetooth-off';
  }
  return err ? 'advertise-failed' : null;
}

/**
 * Feed one CrewBeaconState event in. Called by share.ts's subscription (the
 * native seam); tests call it directly. Two jobs: keep radioInterrupted()
 * honest, and drive the bounce recovery when the adapter comes back.
 */
export function noteRadioState(s: RadioStateEvent): void {
  if (!active) {
    // No session: a late event from a torn-down radio must never leave a
    // ghost "interrupted" badge next to an off switch.
    interrupted = null;
    return;
  }
  const why = radioDownReason(s);
  if (why) {
    setInterrupted({ down: true, why });
    return;
  }
  // RECOVERY. A clean event that also says the adapter is back is the
  // bounce: re-arm the legs. 'permission' is deliberately NOT recovered
  // here — a grant returns through the UI's ask, and silently resuming on a
  // permission event would be guessing about consent.
  const wasDown = interrupted?.why;
  if (
    s.adapterEnabled === true &&
    (wasDown === 'bluetooth-off' || wasDown === 'advertise-failed')
  ) {
    if (resuming) {
      return; // one resume per bounce; its own success event lands here too
    }
    resuming = true;
    // Stay INTERRUPTED across the re-arm: the adapter being back is not yet
    // the pod being able to see you. Cleared only when the legs are up.
    const session = active;
    session.resumeRadio().then(
      () => {
        resuming = false;
        if (active === session) {
          setInterrupted(null);
        }
      },
      () => {
        // Still down, still honest: the failure arrives again as a state
        // event (or as the next tick's re-advertise) and re-classifies.
        // Never an unhandled rejection in a background tick.
        resuming = false;
      },
    );
    return;
  }
  // A clean event never CLEARS a 'permission' block. Unlike the adapter
  // reasons, a revoked grant does not heal on its own — the recovery branch
  // above deliberately skips it, and it returns only through the UI's ask,
  // which re-arms the session (startSharing resets this state) or the user
  // turning sharing off (stop() clears it). Dropping the badge here on a
  // passing adapter/radio event would say "you're findable" while the phone
  // is still invisible — the exact silent-off dishonesty this file prevents.
  if (wasDown === 'permission') {
    return;
  }
  setInterrupted(null);
}

/**
 * Start sharing with a crew. If a session is already running it is stopped
 * first, and the new radio bring-up WAITS for that teardown — both
 * sessions ultimately drive one physical radio, and a stale stopScan
 * landing after a fresh startScan would kill the new session's ears.
 */
export function startSharing(opts: StartSharingOpts): CrewSession {
  const priorStopped = active ? active.stop() : Promise.resolve();
  const now = opts.now ?? (() => Date.now());
  const myHash = hash32(opts.myCardId);

  let stopped = false;
  let stopping: Promise<void> | null = null;
  /** Whether OUR beacon is currently on the air — so a lost fix sends one
   * stopAdvertising, not one per tick. */
  let advertising = false;

  const onSighting = (bytes: Uint8Array): void => {
    const heardAt = now();
    const hit = decodeBeacon(bytes, opts.knownCrewCodes(), heardAt, opts.center);
    if (!hit || hit.memberHash === myHash) {
      // Not ours (the festival-noise hot path), or our own beacon looped
      // back by the radio — "you are near you" must never become a row.
      return;
    }
    // Stamp SENDER time — heard-at minus the beacon's own epochMin age —
    // so a captured-and-replayed beacon lands with its ORIGINAL timestamp
    // and can never re-stamp a stale position as live (beacon.ts, replay).
    reportSighting(hit.memberHash, {
      lat: hit.lat,
      lon: hit.lon,
      atMs: heardAt - hit.ageMs,
    });
  };

  const refresh = async (): Promise<void> => {
    if (stopped) {
      return; // a straggler tick after stop must not re-key the radio
    }
    const pos = opts.getPosition();
    if (!pos) {
      // MEASURED ON TWO PHONES, 2026-08-25: this return ran for 12m13s on one
      // handset and 4m46s on the other, with the switch reading ON and the
      // pod card promising "your pod sees which way and how far", while the
      // phone was invisible. It emitted nothing — no advertisement and no log
      // line — so from outside it was indistinguishable from a working share.
      //
      // The cause was upstream (a position watch that only fired after five
      // metres of movement, so a stationary phone never got a fix), but the
      // reason it took a two-phone sweep to find is HERE: a silent early
      // return. A worker that cannot do its job must say so.
      // eslint-disable-next-line no-console
      console.log('PlayaMesh advertise//skip reason=no-fix');
      setInterrupted({ down: true, why: 'no-fix' });
      if (advertising) {
        advertising = false;
        await opts.radio.stopAdvertising();
      }
      return;
    }
    // A fix arrived: clear a no-fix interruption, but never clobber a REAL
    // radio fault, which only its own events may clear.
    if (interrupted?.why === 'no-fix') {
      setInterrupted(null);
    }
    const t = now();
    const bytes = obfuscate(
      encodeBeacon(
        buildPayload(opts.crewCode, opts.myCardId, pos, opts.center, t),
        opts.crewCode,
        timeBucketOf(t),
      ),
      opts.crewCode,
      timeBucketOf(t),
    );
    advertising = true;
    await opts.radio.advertise(bytes);
  };

  /**
   * The bounce: Bluetooth went off under a live session and came back. The
   * session object survived the outage — the user's intent did too — but
   * the radio legs are down, and the cadence tick alone cannot bring them
   * back: it only re-advertises, and on Android setPayload into a module
   * that is no longer advertising is a no-op (the measured
   * `advertise//payload advertising=false` loop with no `advertise//started`).
   * So restart the SCAN as well and force a fresh beacon out.
   *
   * The GATT server comes back with the advertisement — the native module
   * opens it inside its advertise-start path — so a peer that wants our
   * mailbox can connect again. Mesh sync needs nothing: it is driven by
   * sightings, which resume with the scan.
   */
  const resumeRadio = async (): Promise<void> => {
    if (stopped) {
      return; // a resume racing a stop must not re-key the radio
    }
    // Whatever the radio was doing before the outage, it is not doing it
    // now: forget the cached "already advertising" so refresh() re-arms.
    advertising = false;
    await opts.radio.startScan(onSighting);
    if (stopped) {
      return;
    }
    await refresh();
  };

  const stop = (): Promise<void> => {
    if (stopping) {
      return stopping; // idempotent: every stop() is THE stop
    }
    stopped = true;
    stopping = (async () => {
      if (active === session) {
        active = null;
        // Stopped while interrupted is just STOPPED: no ghost badge
        // survives the switch going off. Guarded by the identity check so
        // a LATE stop of a superseded session cannot clear the state of
        // the one that replaced it.
        interrupted = null;
        resuming = false;
        notifySessionChanged(); // toggle flips off immediately, not post-teardown
      }
      await opts.radio.stopAdvertising();
      await opts.radio.stopScan();
    })();
    return stopping;
  };

  const started = (async () => {
    await priorStopped;
    await opts.radio.startScan(onSighting);
    await refresh(); // first beacon out right away if we already have a fix
  })();
  // A caller that never awaits `started` (fire-and-forget toggle) must not
  // crash the app on a radio error; awaiting callers still see the reject.
  started.catch(() => {});

  const session: CrewSession = { started, refresh, resumeRadio, stop };
  active = session;
  // A fresh session starts believed-healthy; the first radio error or
  // adapter-off event says otherwise within a round trip.
  interrupted = null;
  resuming = false;
  notifySessionChanged();
  return session;
}

/**
 * The master off-switch (design §2: distinct from per-crew toggles;
 * Settings copy: "Stop sharing with everyone"). Module-level so ANY screen
 * can kill sharing without holding the session handle.
 */
export async function masterOff(): Promise<void> {
  if (active) {
    await active.stop();
  }
}
