/**
 * Crew session — the state machine between the UI's consent toggle and the
 * radio (Crew Phase B, docs/CREW-DESIGN.md §2/§4/§6i). This file is
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
 * TWO POSTURES, ONE ADVERTISING SET (the mailbox decoupling, 2026-08-25).
 * A session is on the air in exactly one of two shapes, and the SAME set
 * carries both — swapping the payload never restarts the advertiser, so the
 * BLE address does not rotate on a posture change (CrewBeaconModule, the
 * AdvertisingSet path):
 *
 *  - MAILBOX (shareCrewCode === null): the 17-byte position-free frame
 *    (beacon.ts). Scanning, the GATT server and mesh sync all run; podmates
 *    learn "a member of this pod is in range and has mail" and NO place.
 *    This is what the app runs while it is open and you have a pod, because
 *    MESSAGES ARE NOT A SIDE-EFFECT OF CONSENTING TO BE LOCATED — measured
 *    2026-08-25 on two adjacent Pixels, sharing off meant zero PlayaMesh
 *    lines in 47 s and zero delivery, and the owner lost an hour to it in
 *    the field.
 *  - POSITION (shareCrewCode set): the 21-byte frame, exactly as before —
 *    same cadence, same replay guards, same copy. Sharing LAYERS the place
 *    onto an advert that was already on the air; turning it off returns to
 *    the mailbox frame instead of killing the radio.
 *
 * Consent is unchanged by all of it: a coordinate reaches the air only
 * while the user's own toggle says so, and no code path can hand a position
 * to the mailbox frame (buildMailboxPayload takes no position argument).
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
 *    active, the session re-arms itself. The user said "share until I turn
 *    it off"; an outage is not them turning it off.
 *
 *    AND RECOVERY IS A TRANSACTION, NOT TWO EFFECTS (2026-08-27). Bringing
 *    the scan back and putting a fresh beacon on the air are both true
 *    before the mesh has re-published anything a peer can read, so clearing
 *    the interruption on them said "recovered" over a phone whose digest
 *    characteristic still answered the not-ready frame. recoverRadio()
 *    spans THREE legs under one generation — the scan, the advertise
 *    payload, and the CURRENT mesh digest publish ack (injected as
 *    opts.awaitMeshDigest, never imported) — and only all three settling
 *    for the same live session and the same generation clears it.
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
  buildMailboxPayload,
  buildPayload,
  decodeBeacon,
  encodeBeacon,
  encodeMailbox,
  hash32,
  obfuscate,
  obfuscateMailbox,
  timeBucketOf,
} from './beacon';
import { reportHeard, reportSighting } from './presence';

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

export interface StartSessionOpts {
  radio: CrewRadio;
  /**
   * The crew whose POSITION this session advertises (one session = one
   * crew's share toggle; scanning still hears every crew via
   * knownCrewCodes), or null to start position-free — mailbox posture, the
   * shape the app runs whenever it is open with a pod.
   */
  shareCrewCode: string | null;
  /** My FriendCard.id — the identity crew mates resolve me by. */
  myCardId: string;
  /** Golden-spike origin both sides quantize against
   * (getCityGeometry().center) — injected so this stays geometry-free. */
  center: { lat: number; lon: number };
  /** Latest GPS fix, or null when there isn't one worth broadcasting. */
  getPosition: () => { lat: number; lon: number } | null;
  /** Every crew code this phone belongs to — read FRESH per sighting, so
   * joining/leaving a crew mid-session changes what we hear immediately.
   * In mailbox posture this is also WHO WE ADVERTISE FOR, one pod per
   * refresh in turn (see the rotation in refresh()). */
  knownCrewCodes: () => string[];
  /** Injectable clock (tests; protocol functions never read time). */
  now?: () => number;
  /**
   * THE MESH READINESS BARRIER — the third leg of a radio recovery,
   * INJECTED rather than imported (share.ts wires it; see resumeRadio and
   * the transaction below).
   *
   * Calling it MINTS the leg: it captures the mesh's identity at that
   * instant and resolves true when the offer THAT identity published has
   * been acked by the native side, false when the identity was superseded
   * (the mesh stopped, or another session replaced it). It never rejects.
   *
   * Omitted = there is no mesh for this session — a phone with no pod, a
   * screen that never started mailbox presence, a harness driving the
   * session alone. The leg then has NO WORK and settles trivially: a
   * recovery must never hang on a leg with nothing to do.
   *
   * WHY INJECTED. session.ts is the consent/radio state machine and the
   * mesh is a consumer of the radio window it opens; importing meshSync
   * here would point the dependency back at the thing whose readiness this
   * file reports, and would drag the whole mesh into every suite that
   * drives a session. The owner side (share.ts, which starts the mesh AND
   * wires the native state stream to this file) threads it in.
   */
  awaitMeshDigest?: () => Promise<boolean>;
}

export interface CrewSession {
  /** Settles when the radio is actually up (scan started + first beacon
   * out if a fix existed). startSharing returns synchronously so the UI
   * toggle flips instantly; await/catch THIS to surface radio errors
   * ("Bluetooth is off — ...", design §5 degrade copy). */
  started: Promise<void>;
  /** One cadence tick: re-advertise under the current posture (fresh time
   * bucket, fresh position). Sharing with no fix drops to the MAILBOX
   * frame rather than keeping a stale position on the air — a wrong "live"
   * arrow is worse than none, and going silent used to take the pod's mail
   * down with it. */
  refresh(): Promise<void>;
  /**
   * Layer position sharing on (a crew code) or off (null) WITHOUT taking
   * the radio down: the advertising set stays up and its payload changes,
   * so mail keeps moving across the flip and the BLE address does not
   * rotate. Settles when the new payload is on the air; rejects the way
   * refresh does, so the toggle can surface a radio error.
   */
  setShareCrew(crewCode: string | null): Promise<void>;
  /** Re-arm the radio legs after an outage the SESSION survived but the
   * RADIO did not (Bluetooth toggled off and back on). Restarts the scan —
   * which the cadence tick never retries, it only re-advertises — and puts
   * a fresh beacon on the air. Idempotent and serialized: two adapter-on
   * events cannot double-start the scan. A stopped session ignores it.
   *
   * These are two of the recovery's three legs; on its own it says nothing
   * about whether the pod can READ this phone. recoverRadio is the whole
   * transaction, and it is what the bounce actually drives. */
  resumeRadio(): Promise<void>;
  /**
   * THE RECOVERY TRANSACTION: the two radio legs above PLUS the mesh
   * digest's publish ack, under ONE identity — the radio generation passed
   * in, which noteRadioState mints when the outage is classified.
   *
   * Resolves true only when all three legs settled for that same live
   * session and that same generation; false when any leg was superseded
   * (a fresh outage under it, a stop, a replacement session). It rejects
   * only the way resumeRadio does — a radio that refused. Either way the
   * caller leaves the interruption standing, which is the honest state.
   */
  recoverRadio(generation: number): Promise<boolean>;
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
   * NO POSITION YET, while position sharing is ON. Not a radio fault at
   * all — the radio is fine, the session is running, and since the mailbox
   * decoupling the phone is still on the air serving mail; there is simply
   * no PLACE to put in the advert yet. Mailbox posture never raises it:
   * with the toggle off there is no fix to wait for.
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
/**
 * THE RADIO GENERATION — which outage a recovery belongs to.
 *
 * Bumped by every DOWN classification (and by a new session), including one
 * that names the reason already showing. A recovery in flight is re-arming
 * a radio that has since gone down again: its scan and its payload describe
 * a world that no longer exists, so it must not be allowed to report
 * success, and the NEXT adapter-on must be able to mint its own attempt
 * instead of being swallowed by the dead one's latch. The bump is what says
 * both of those in one number.
 */
let radioGeneration = 0;
/** The generation whose recovery transaction is in flight, or null when
 * none is. One re-arm per generation: an adapter-on burst (Android emits
 * ACTION_STATE_CHANGED once, but the module's own started/scan events land
 * in the same window) must not start three scans — while a FRESH outage,
 * being a new generation, may always start its own. */
let resumingGen: number | null = null;

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
    // A FRESH OUTAGE IS A NEW GENERATION — even when it names the reason
    // already showing. setInterrupted dedupes the RENDER (same truth, no
    // re-render); it must not dedupe the IDENTITY, because a recovery in
    // flight is re-arming a radio that has just gone down under it. Without
    // this bump that transaction would finish its two radio legs against a
    // dead adapter, wait for an ack, and clear the interruption over a
    // phone that is deaf again — and the adapter-on that follows would be
    // swallowed by its latch, so nothing would re-arm the scan.
    radioGeneration += 1;
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
    const generation = radioGeneration;
    if (resumingGen === generation) {
      return; // one recovery per outage; its own success event lands here too
    }
    resumingGen = generation;
    // Stay INTERRUPTED across the whole transaction: the adapter being back
    // is not the pod being able to see you, and neither is the scan, and
    // neither is a fresh beacon. Cleared only when the scan, the payload
    // AND the mesh's current digest ack have all settled for THIS
    // generation of THIS session — the three legs recoverRadio spans.
    const session = active;
    session.recoverRadio(generation).then(
      recovered => {
        // The latch is released for the generation that held it, and only
        // that one: a superseded transaction settling late must not unlatch
        // the fresh attempt that replaced it.
        if (resumingGen === generation) {
          resumingGen = null;
        }
        // THE ONE CLEAR, and it is guarded by identity rather than by
        // arrival: the session must still be the live one and the outage
        // must still be the one this transaction was minted for. A stale
        // ack — from before the bounce, from a stopped session, or from the
        // transaction a newer outage superseded — arrives here and clears
        // nothing. setInterrupted's own dedupe makes it exactly once.
        if (recovered && active === session && generation === radioGeneration) {
          setInterrupted(null);
        }
      },
      () => {
        // A LEG REFUSED. Still down, still honest: the failure arrives
        // again as a state event (or as the next tick's re-advertise) and
        // re-classifies, and THE NEXT ADAPTER-ON RE-ARMS — the latch is
        // released here, so one failure cannot wedge the recovery path for
        // the rest of the session. Never an unhandled rejection in a
        // background tick.
        if (resumingGen === generation) {
          resumingGen = null;
        }
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
 * Start a session in either posture (opts.shareCrewCode: a code to share a
 * position with, null for mailbox-only). If a session is already running it
 * is stopped first, and the new radio bring-up WAITS for that teardown —
 * both sessions ultimately drive one physical radio, and a stale stopScan
 * landing after a fresh startScan would kill the new session's ears.
 *
 * A POSTURE CHANGE IS NOT A RESTART: to turn sharing on or off, call
 * setShareCrew() on the live session. Restarting to change posture would
 * mint a fresh BLE address and drop every peer's freshness bookkeeping
 * (meshSync.ts) for nothing.
 */
export function startCrewSession(opts: StartSessionOpts): CrewSession {
  const priorStopped = active ? active.stop() : Promise.resolve();
  const now = opts.now ?? (() => Date.now());
  const myHash = hash32(opts.myCardId);

  let stopped = false;
  let stopping: Promise<void> | null = null;
  /** Whether OUR beacon is currently on the air — so a pod-less phone sends
   * one stopAdvertising, not one per tick. */
  let advertising = false;
  /** The pod whose position rides the advert; null = mailbox posture. */
  let shareCrewCode: string | null = opts.shareCrewCode;
  /** Which pod the NEXT mailbox frame speaks for. One advertising slot and
   * N pods, so mailbox posture takes them in turn.
   *
   * WHAT THE ROTATION ACTUALLY BUYS, stated precisely: mail does not need
   * it. A peer's sync layer dials an ADDRESS it saw on the scan (meshSync
   * keys on peerId, never on a decode), and the digest it then pulls covers
   * every crew this phone carries — so a second pod's mail moves whichever
   * frame is on the air. What the rotation buys is RECOGNITION: only a pod
   * that can decode the frame learns that one of ITS members is the phone
   * standing there, which is what fills the roster row and the near/quiet
   * line. Without it, the second pod would see an anonymous Playa Pal phone
   * forever. Position posture does not rotate — the shared pod owns the
   * slot for as long as the toggle says so, which keeps sharing behaviour
   * exactly what it was. */
  let mailboxTurn = 0;

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
    const atMs = heardAt - hit.ageMs;
    if (hit.kind === 'mailbox') {
      // Reach, recorded as reach. A mailbox frame has no coordinates to
      // read (the decoder's union is what enforces that here), so it can
      // never place a pin — it only says this podmate's phone is near
      // enough to trade mail with, which is exactly what the pod card's
      // "messages get through now" claims.
      reportHeard(hit.memberHash, atMs);
      return;
    }
    reportSighting(hit.memberHash, {
      lat: hit.lat,
      lon: hit.lon,
      atMs,
    });
  };

  /**
   * The position-free advert: pod-scoped, connectable, no coordinates. The
   * codes come from the CALLER's live crew list, so a pod joined mid-
   * session joins the rotation without a restart, and a phone with no pods
   * at all goes silent (there is nobody to be a mailbox for).
   */
  const advertiseMailbox = async (codes: string[]): Promise<void> => {
    if (codes.length === 0) {
      if (advertising) {
        advertising = false;
        await opts.radio.stopAdvertising();
      }
      return;
    }
    const code = codes[mailboxTurn % codes.length];
    mailboxTurn += 1;
    const t = now();
    const bytes = obfuscateMailbox(
      encodeMailbox(
        buildMailboxPayload(code, opts.myCardId, t),
        code,
        timeBucketOf(t),
      ),
      code,
      timeBucketOf(t),
    );
    advertising = true;
    await opts.radio.advertise(bytes);
  };

  const refresh = async (): Promise<void> => {
    if (stopped) {
      return; // a straggler tick after stop must not re-key the radio
    }
    if (shareCrewCode === null) {
      // MAILBOX POSTURE: no position is read, so none can be broadcast.
      await advertiseMailbox(opts.knownCrewCodes());
      return;
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
      //
      // AND IT NO LONGER TAKES THE MAIL DOWN WITH IT. Going off the air
      // entirely meant a fixless phone stopped being a mailbox too: no
      // sightings either way, so pod messages stopped moving for a reason
      // that has nothing to do with messages. The honest fallback is the
      // frame that says what is still true — this phone is here and will
      // trade mail — while the session says out loud that it has no place
      // to report yet.
      // eslint-disable-next-line no-console
      console.log('PlayaMesh advertise//skip reason=no-fix fallback=mailbox');
      setInterrupted({ down: true, why: 'no-fix' });
      await advertiseMailbox([shareCrewCode]);
      return;
    }
    // A fix arrived: clear a no-fix interruption, but never clobber a REAL
    // radio fault, which only its own events may clear.
    if (interrupted?.why === 'no-fix') {
      setInterrupted(null);
    }
    const t = now();
    const code = shareCrewCode;
    const bytes = obfuscate(
      encodeBeacon(
        buildPayload(code, opts.myCardId, pos, opts.center, t),
        code,
        timeBucketOf(t),
      ),
      code,
      timeBucketOf(t),
    );
    advertising = true;
    await opts.radio.advertise(bytes);
  };

  /**
   * The toggle's flip, expressed as a PAYLOAD change rather than a session
   * lifecycle: sharing on layers the position frame onto an advert that is
   * already up, sharing off drops back to the mailbox frame. Nothing stops,
   * so nothing has to be brought back — mail keeps moving across the flip,
   * and the field's oldest crew failure (turning sharing off = radio dead =
   * no delivery at all) cannot happen from here.
   */
  const setShareCrew = async (crewCode: string | null): Promise<void> => {
    if (stopped) {
      return;
    }
    if (shareCrewCode !== crewCode) {
      shareCrewCode = crewCode;
      if (crewCode === null && interrupted?.why === 'no-fix') {
        // Mailbox posture has no fix to wait for; a "getting your position"
        // badge over a switch that is now off is a leftover, not a truth.
        setInterrupted(null);
      }
      notifySessionChanged();
    }
    await refresh();
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
  /** Is this generation still the one the live session is recovering? The
   * question every leg asks after its await, and the only thing that
   * entitles a settlement to touch the shared interruption state. */
  const isCurrent = (generation: number): boolean =>
    !stopped && active === session && generation === radioGeneration;

  /** LEGS 1 AND 2: the scan, then the advertise/payload refresh. Sequential
   * because they are: on Android a setPayload into a module that is not
   * advertising is a no-op, so the beacon has to follow the bring-up. */
  const rearmLegs = async (generation: number): Promise<void> => {
    if (stopped) {
      return; // a resume racing a stop must not re-key the radio
    }
    // Whatever the radio was doing before the outage, it is not doing it
    // now: forget the cached "already advertising" so refresh() re-arms.
    advertising = false;
    await opts.radio.startScan(onSighting);
    if (stopped || !isCurrent(generation)) {
      return;
    }
    await refresh();
  };

  const resumeRadio = (): Promise<void> => rearmLegs(radioGeneration);

  /**
   * THE RECOVERY TRANSACTION — one generation, three legs, one clear.
   *
   * The blocker this shape closes: the two radio legs and the mesh's
   * republish were three independent races. Scan back and payload out are
   * both true BEFORE any offer is installed on the native side, so the
   * session cleared its interruption while the digest characteristic still
   * answered the not-ready frame: the UI said recovered, the pod's mailbox
   * read empty, and nothing anywhere was an error. Readiness has to span
   * all three or it is a guess about the two it can see.
   */
  const recoverRadio = async (generation: number): Promise<boolean> => {
    if (!isCurrent(generation)) {
      return false;
    }
    // LEG 3 IS MINTED FIRST, synchronously, before a single await. The
    // barrier captures the mesh identity AS OF THE BOUNCE, so the ack of
    // the offer the adapter WITHDREW — which is still the installed one at
    // this instant — can never be the ack this transaction settles on.
    // Minting it after the scan came back would capture whatever the mesh
    // looked like by then, which is arrival order wearing an identity's
    // clothes.
    //
    // NO MESH, NO WORK: with no barrier injected there is no digest for
    // this session (solo phone, no pod, a harness driving the session
    // alone), so the leg settles trivially. A recovery must never hang on a
    // leg that has nothing to do — an unconditional third-leg wait would
    // leave a pod-less camper interrupted for the rest of the evening with
    // no mesh anywhere that could ever un-interrupt them.
    const digest = opts.awaitMeshDigest
      ? opts.awaitMeshDigest()
      : Promise.resolve(true);
    await rearmLegs(generation); // LEGS 1 + 2 (a refusal rejects the lot)
    if (!isCurrent(generation)) {
      return false;
    }
    const servable = await digest; // LEG 3
    // Re-asked after the last await for the same reason as after the first:
    // the world may have moved while the ack was in the air.
    return servable && isCurrent(generation);
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
        resumingGen = null;
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

  const session: CrewSession = {
    started,
    refresh,
    recoverRadio,
    resumeRadio,
    setShareCrew,
    stop,
  };
  active = session;
  // A fresh session starts believed-healthy; the first radio error or
  // adapter-off event says otherwise within a round trip.
  interrupted = null;
  resumingGen = null;
  // A NEW SESSION IS A NEW RADIO IDENTITY. The replaced session's recovery
  // may still be out there holding a mesh barrier; the generation bump is
  // the second half of the guard that keeps its late settlement from
  // clearing an interruption this session raised (the first half being the
  // `active === session` identity check).
  radioGeneration += 1;
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
