/**
 * The Walkie JS adapter (docs/CREW-DESIGN.md §6d): a thin, typed seam over
 * NativeModules.Walkie so the UI and tests never touch the native surface
 * directly. Live voice runs on shared Wi-Fi (the camp mailbox phone's
 * hotspot, a camp router) — a DIFFERENT radio than the pod's BLE presence,
 * so this adapter is deliberately independent of share.ts's session.
 */
import { NativeEventEmitter, NativeModules } from 'react-native';
import { hash32, normalizeCrewCode } from './beacon';
import { listCrews } from './crew';
import { announcedMembers } from './podMembers';
import { presenceFor } from './presence';

const native = NativeModules.Walkie;

export function walkiePresent(): boolean {
  return native != null;
}

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter {
  if (!emitter) {
    emitter = new NativeEventEmitter(native);
  }
  return emitter;
}

let on = false;

export function walkieOn(): boolean {
  return on;
}

// The channel's open/closed state is a subscribable STORE (the favorites
// revision-emitter pattern), not just a flag: the pod card's link list must
// drop every live-voice claim the MOMENT the walkie closes — a closed
// channel's last peer list rendering as "voice now" is §5's proven-link
// rule violated by staleness — and a render-time walkieOn() poll cannot see
// the flip happen. Writers bump; mounted readers subscribe.
let channelRevision = 0;
const channelWatchers = new Set<() => void>();

export function walkieChannelRevision(): number {
  return channelRevision;
}

export function subscribeWalkieChannel(cb: () => void): () => void {
  channelWatchers.add(cb);
  return () => {
    channelWatchers.delete(cb);
  };
}

function notifyWalkieChannel(): void {
  channelRevision += 1;
  for (const w of channelWatchers) {
    w();
  }
}

/** Join the pod's live channel on the current Wi-Fi. */
export async function startWalkie(
  crewCode: string,
  myCardId: string,
  displayName: string,
): Promise<void> {
  if (!native) {
    throw new Error('Live talk needs a newer build.');
  }
  await native.start(
    hash32(normalizeCrewCode(crewCode)),
    hash32(myCardId),
    displayName || 'someone',
  );
  on = true;
  notifyWalkieChannel();
}

/**
 * Close the channel.
 *
 * THE RETURN VALUE IS THE ADVERTISER'S PROOF, and it is the reason this
 * function has one at all: `false` means the native side could not prove
 * its own BLE advertiser off the air. The one caller that must care is the
 * crew-beacon release (walkieSession), because two advertisers on one
 * iPhone is the overflow-area defect share.ts exists against.
 *
 * A STRUCTURED OUTCOME, NOT A REJECTION CODE (S7). The old shape rejected
 * with code 'advertiser' and this function turned that ONE code into
 * `false`. It worked, and it made every other rejection a generic error
 * that a later reader could mistake for a close. The native barrier now
 * resolves one field with three values and this boundary adds the fourth:
 *
 *   clear     the exact owner's advertiser is proven off the air and the
 *             process owes nothing. The arbiter has ALREADY handed the
 *             slot back, natively, at the effect.
 *   debt      the proof could not arrive; the advertiser is on the native
 *             book and the lease is demoted. The hold stands.
 *   notOwner  this world never held that lease. Nothing was released.
 *   unknown   this boundary could not understand the answer — an older
 *             native, a bridge that threw, a body from a wire version
 *             this decoder does not know.
 *
 * AND UNKNOWN IS NEVER CLEAR. That is the whole of the fourth value: a
 * generic failure has told us nothing about the air, and nothing has
 * never proved a radio quiet.
 */
export type WalkieStopWord = 'clear' | 'debt' | 'notOwner' | 'unknown';

export interface WalkieStopOutcome {
  outcome: WalkieStopWord;
  why: string;
  /** The state the answer was true of, when the native side could say. */
  state: WalkieAirtime | null;
}

export async function stopWalkie(): Promise<WalkieStopOutcome> {
  on = false;
  // Notify BEFORE awaiting the native stop: the readers' whole job is to
  // stop claiming the channel, and the native teardown's latency must not
  // extend the life of a claim that is already false.
  notifyWalkieChannel();
  if (!native) {
    // No native at all — a build with no radio has nothing on the air and
    // nothing to hand back. This is the one honest `clear` that is not a
    // proof, and it is honest because there is provably nothing to prove.
    return { outcome: 'clear', why: 'no-native', state: null };
  }
  try {
    return decodeWalkieStop(await native.stop());
  } catch {
    // A rejection tells this boundary nothing about the air. It is not a
    // close and it is not a debt; it is the absence of an answer.
    return { outcome: 'unknown', why: 'stop-threw', state: null };
  }
}

/**
 * STRICT, AND UNKNOWN ON EVERY DOUBT (S10). A body whose version this
 * decoder does not know, or whose outcome is not one of the three the
 * arbiter can produce, is `unknown` — never a default, and never the
 * closest-looking word.
 */
export function decodeWalkieStop(e: unknown): WalkieStopOutcome {
  const o = e as Record<string, unknown> | null | undefined;
  const state = decodeWalkieAirtime(o?.state);
  if (o?.v !== WALKIE_AIRTIME_WIRE) {
    return { outcome: 'unknown', why: 'wire-version', state };
  }
  const word = o.outcome;
  if (word !== 'clear' && word !== 'debt' && word !== 'notOwner') {
    return { outcome: 'unknown', why: 'unrecognised-outcome', state };
  }
  return {
    outcome: word,
    why: typeof o.why === 'string' ? o.why : '',
    state,
  };
}

/** Hold-to-talk: the mic runs ONLY between these two calls — the held
 * button is the consent surface. A 'permission' rejection means the OS mic
 * ask was declined; the UI shows recoverable copy. */
export async function startTalking(): Promise<void> {
  await native.startTalking();
}

export async function stopTalking(): Promise<void> {
  try {
    await native.stopTalking();
  } catch {
    // releasing an idle mic is the goal state
  }
}

// ------------------------------------------------------------ look again
//
// OWNER ASK (2026-08-26): the channel sometimes flaps and autodiscovery is
// opaque — so the stage gets one control that asks every radio to look for
// podmates right now.
//
// IT IS NOT A RESTART, and the whole design rests on that. Nothing here
// closes a socket, drops a peer, or touches the audio engine: both natives
// fill only the holes in their own discovery (a starved BLE scan, a dead
// mDNS listener, an Aware peer that never got a datapath) and leave every
// proven link exactly as it was. It is safe to tap mid-sentence, and safe
// to tap when nothing is wrong — which matters, because a camper cannot
// tell those two apart and should not have to.

/** Does this native build carry the control? An older native has no
 * refreshDiscovery, and the honest answer is then no button — never a
 * button that does nothing. */
export function walkieRefreshPresent(): boolean {
  return native != null && typeof native.refreshDiscovery === 'function';
}

/**
 * Ask every radio to look again. Never rejects: the camper tapped a
 * control that means "try", and an error dialog about a radio they cannot
 * reach is noise piled on the confusion that made them tap it.
 */
export async function refreshWalkieDiscovery(): Promise<void> {
  if (!walkieRefreshPresent()) {
    return;
  }
  try {
    await native.refreshDiscovery();
  } catch {
    // The rungs that could look, looked. There is nothing here for a
    // camper to act on.
  }
}

/** What the control promises, in the house voice — and it promises exactly
 * what the natives do, which is why it also says what it does NOT do. Kept
 * beside the verb so the copy and the behaviour move together. */
export const WALKIE_REFRESH_COPY =
  'Asks every radio to look again right now — links that are healthy are ' +
  'untouched, so it is safe to tap while someone is talking. It cannot ' +
  'reach further than the radios already do; it just stops them waiting.';

/** One channel row. `rung` is which transport carries this peer — the two
 * datagram lanes are hi-fi, 'ble' is rung 3's lo-fi GATT lane, and 'stale'
 * is a datagram row the native side DEMOTED because it stopped proving it
 * was alive (docs/WALKIE-LADDER.md §5: availability is proven, never
 * announced). A demoted row is at the floor, so it wears the same one
 * badge — what it must never wear is the plain name a hi-fi rung earns. */
export interface WalkiePeerEntry {
  name: string;
  rung: 'lan' | 'aware' | 'ble' | 'stale';
}

/** One discovered peer, with the identity a targeted verb (a 1:1 call)
 * needs. The hash is the wire senderHash; 0 marks a row the native side
 * could not attribute, and no targeted verb may use it. */
export interface WalkiePeerRow {
  name: string;
  hash: number;
}

/** One person can be discovered on TWO transports at once (LAN and the
 * Aware link) and holds two peer-table entries; a targeted verb wants the
 * person once. Rows without an identity are dropped, not deduped —
 * "someone" is not a callable address. */
export function dedupeWalkiePeers(rows: WalkiePeerRow[]): WalkiePeerRow[] {
  const seen = new Set<number>();
  const out: WalkiePeerRow[] = [];
  for (const r of rows) {
    if (r.hash === 0 || seen.has(r.hash)) {
      continue;
    }
    seen.add(r.hash);
    out.push(r);
  }
  return out;
}

/** Decode the native peers event — pure, exported for tests. Two lanes of
 * per-peer truth ride the one event, each fail-soft on its own: `rungs`
 * is index-aligned with `names` — an OLDER native without it must read as
 * all hi-fi, because every peer such a native can list IS a Wi-Fi-class
 * peer, and an unknown rung word from a NEWER native folds to hi-fi for
 * the same reason (the lo-fi badge may only appear where lo-fi is a
 * fact); `peers` carries the identity rows targeted verbs (the 1:1 call
 * button) need — missing yields [], "no callable peers", never a crash. */
export function decodeWalkiePeers(e: {
  count?: number;
  names?: string[];
  talkingTo?: number;
  rungs?: string[];
  peers?: { name?: string; hash?: string }[];
}): {
  count: number;
  talkingTo: number;
  entries: WalkiePeerEntry[];
  peers: WalkiePeerRow[];
} {
  const names = e?.names ?? [];
  const count = e?.count ?? names.length;
  const entries = names.map((name, i): WalkiePeerEntry => {
    const r = e?.rungs?.[i];
    return {
      name,
      rung:
        r === 'ble'
          ? 'ble'
          : r === 'aware'
          ? 'aware'
          : r === 'stale'
          ? 'stale'
          : 'lan',
    };
  });
  const peers: WalkiePeerRow[] = (e?.peers ?? []).map(p => {
    const hash = parseInt(p?.hash ?? '', 16);
    return {
      name: p?.name ?? 'someone',
      hash: Number.isFinite(hash) ? hash >>> 0 : 0,
    };
  });
  // talkingTo comes from the native cap. An OLDER native that does not
  // send it must not read as "talking to nobody", so it falls back to the
  // JS cap over the count — the same answer the native would have given.
  return {
    count,
    entries,
    peers,
    talkingTo:
      typeof e?.talkingTo === 'number' ? e.talkingTo : walkieTransmitCount(count),
  };
}

/**
 * The channel row text. A lo-fi peer wears the one badge the owner ruled
 * in (docs/WALKIE-LADDER.md §5a): it explains a real audible difference —
 * and nothing louder, no rung list, no radio names.
 *
 * A DEMOTED datagram row ('stale') wears its OWN quieter badge. The
 * per-person dedupe keeps the best-ranked row and every lo-fi pipe counts
 * as proven, so 'stale' reaches this function only when that person has NO
 * pipe at all — and (lo-fi), whose shared phrase is "rougher, but live",
 * promised live audio over nothing (§5a as amended 2026-08-25). "(quiet)"
 * is the native side's own word for the state ("that podmate's link went
 * quiet"), and it is a smaller claim than the plain name, which is the
 * direction §5 demotions must move. Still no mechanism words, still no
 * "connecting…" hope-states.
 */
export function formatChannelNames(entries: WalkiePeerEntry[]): string {
  return entries
    .map(p =>
      p.rung === 'stale'
        ? `${p.name} (quiet)`
        : p.rung === 'ble'
        ? `${p.name} (lo-fi)`
        : p.name,
    )
    .join(', ');
}

export function onWalkiePeers(
  cb: (p: {
    count: number;
    entries: WalkiePeerEntry[];
    peers: WalkiePeerRow[];
    talkingTo: number;
  }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'WalkiePeers',
    (e: {
      count?: number;
      names?: string[];
      talkingTo?: number;
      rungs?: string[];
      peers?: { name?: string; hash?: string }[];
    }) => {
      cb(decodeWalkiePeers(e));
    },
  );
  return () => sub.remove();
}

export function onWalkieSpeaking(cb: (s: { name: string }) => void): () => void {
  const sub = getEmitter().addListener(
    'WalkieSpeaking',
    (e: { name?: string }) => {
      cb({ name: e?.name ?? 'someone' });
    },
  );
  return () => sub.remove();
}

/**
 * THE ARBITER'S STATE, AS JS SEES IT (ARCHITECTURE ruling, 2026-08-27).
 *
 * WHAT THIS IS FOR, AND IT IS NOT WHAT IT USED TO BE. Every previous
 * round of this lane made JS the decider and then wrote a fence to keep
 * it honest: an event, then a level, then a count, then four fields and a
 * token. Each fence was right about the fact it guarded and none of them
 * changed WHO DECIDES, so all of them could be beaten by a snapshot that
 * was true when it was built and false when it was read.
 *
 * The decision moved native. A process-lifetime arbiter owns the
 * advertising slot, hands it out as an exact lease, drives both radios'
 * suppression and resumption at the EFFECT, and is the only thing that
 * may end a hold. What arrives here is OBSERVABILITY: JS reads it to
 * order its own UX and to keep radio.ts's caches honest, and a JS world
 * can be arbitrarily stale without any radio moving.
 *
 * THE FIELDS:
 *
 *   processIncarnation  which PROCESS is speaking. A JS reload keeps
 *                       talking to the same one; a relaunch is a
 *                       different string rather than a suspiciously small
 *                       revision.
 *   leaseId             which HOLD. Opaque; equality is the only
 *                       operation anyone performs on it.
 *   opId                which OPERATION on that hold.
 *   revision            WHEN, and it is not an identity: one lease
 *                       reserved, suppressed, started and stopped is ONE
 *                       owner across FIVE revisions. Split from the
 *                       identity for exactly that reason (S5).
 *   phase               idle | reserving | suppressingCrew | starting |
 *                       active | stopping | debt.
 *   rung                none | advertising | degraded — and `none` until
 *                       the advertiser's own effect lands, so nothing
 *                       here calls a rung active before it is.
 *   holdRequired        derived: a lease occupies some phase.
 *   crewMayAdvertise    derived, and the ruling's own sentence: the crew
 *                       beacon may advertise iff no lease occupies any
 *                       phase.
 */
export const WALKIE_AIRTIME_WIRE = 2;

export type WalkieAirtimePhase =
  | 'idle'
  | 'reserving'
  | 'suppressingCrew'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'debt';

export interface WalkieAirtime {
  processIncarnation: string;
  /** The exact decimal revision, as a string, because it is exact. */
  revision: string;
  /** …and the same number as an ORDERED pair that survives JS Number.
   *  A UInt64 through JSON loses every order relation above 2^53, which
   *  is not a rounding error: it is a stale snapshot silently winning a
   *  compare against a fresh one (S5). */
  revisionHi: number;
  revisionLo: number;
  phase: WalkieAirtimePhase;
  leaseId: string | null;
  opId: string | null;
  rung: 'none' | 'advertising' | 'degraded';
  debtCount: number;
  crewMayAdvertise: boolean;
  holdRequired: boolean;
  why: string;
}

/**
 * ORDER, ABOVE 2^53 AND BELOW IT, BY THE SAME RULE. Compares the hi/lo
 * pair, never the decimal string's length and never a Number built from
 * it. Returns <0, 0, >0 like every other comparator.
 *
 * Mutation this dies on: `Number(a.revision) - Number(b.revision)`. It
 * agrees with this function for every revision a bench will ever produce
 * and disagrees exactly where it matters — 2^53 and 2^53+1 are the SAME
 * Number, so a stale snapshot compares EQUAL to the state that replaced
 * it and every "is this older?" fence waves it through.
 */
export function compareWalkieRevision(a: WalkieAirtime, b: WalkieAirtime): number {
  if (a.revisionHi !== b.revisionHi) {
    return a.revisionHi < b.revisionHi ? -1 : 1;
  }
  if (a.revisionLo !== b.revisionLo) {
    return a.revisionLo < b.revisionLo ? -1 : 1;
  }
  return 0;
}

const PHASES: readonly string[] = [
  'idle',
  'reserving',
  'suppressingCrew',
  'starting',
  'active',
  'stopping',
  'debt',
];

/**
 * STRICT, VERSIONED, AND `null` ON EVERY DOUBT (S10).
 *
 * `null` IS NOT A CLEAR SLOT, and reading it as one would undo the whole
 * fail-closed road. It means this native cannot answer — an older build,
 * a bridge that threw, a body from a wire version this decoder does not
 * know, or the previous era's bare `{ why }`.
 *
 * EVERY FIELD MUST BE PRESENT AND THE RIGHT SHAPE. A partial body is a
 * native we do not understand, not a state with defaults: defaulting
 * `holdRequired` to false is exactly the failure this type exists to end.
 */
export function decodeWalkieAirtime(e: unknown): WalkieAirtime | null {
  const o = e as Record<string, unknown> | null | undefined;
  if (
    o?.v !== WALKIE_AIRTIME_WIRE ||
    typeof o.processIncarnation !== 'string' ||
    o.processIncarnation === '' ||
    typeof o.revision !== 'string' ||
    typeof o.revisionHi !== 'number' ||
    !Number.isFinite(o.revisionHi) ||
    typeof o.revisionLo !== 'number' ||
    !Number.isFinite(o.revisionLo) ||
    typeof o.phase !== 'string' ||
    !PHASES.includes(o.phase) ||
    typeof o.rung !== 'string' ||
    typeof o.debtCount !== 'number' ||
    typeof o.crewMayAdvertise !== 'boolean' ||
    typeof o.holdRequired !== 'boolean'
  ) {
    return null;
  }
  return {
    processIncarnation: o.processIncarnation,
    revision: o.revision,
    revisionHi: o.revisionHi,
    revisionLo: o.revisionLo,
    phase: o.phase as WalkieAirtimePhase,
    leaseId: typeof o.leaseId === 'string' ? o.leaseId : null,
    opId: typeof o.opId === 'string' ? o.opId : null,
    rung:
      o.rung === 'advertising' || o.rung === 'degraded' || o.rung === 'none'
        ? o.rung
        : 'none',
    debtCount: o.debtCount,
    crewMayAdvertise: o.crewMayAdvertise,
    holdRequired: o.holdRequired,
    why: typeof o.why === 'string' ? o.why : '',
  };
}

/**
 * THE CAPABILITY POLICY, AND IT IS EXPLICIT (S9).
 *
 *   "explicit old-native capability policy; legacy {why}/
 *   advertiserDebtCount is incompatible, not 'event fallback'."
 *
 * Three answers, and the middle one is the whole point:
 *
 *   arbiter       this native speaks the wire version this JS knows.
 *   incompatible  it ANSWERED and this JS cannot read the answer — a
 *                 previous era's bare `{ why }`, an `advertiserDebtCount`
 *                 body, a wire version from the future. It is not an
 *                 event fallback: the event carries the SAME body, so a
 *                 native whose query we cannot read emits events we
 *                 cannot read either, and "keep listening" is a watcher
 *                 waiting forever on a shape that will never arrive.
 *   absent        no native, or no such method.
 *
 * Both degraded answers mean the same thing to a caller and it is not
 * "release": PARK THE HOLD, with a reason, and say so.
 */
export type WalkieAirtimeCapability = 'arbiter' | 'incompatible' | 'absent';

export function walkieAirtimePresent(): boolean {
  return native != null && typeof native.airtimeState === 'function';
}

/** ASK — and the answer carries the capability, because "what did it say?"
 *  and "could it say anything?" are one question asked once. */
export async function walkieAirtimeState(): Promise<{
  capability: WalkieAirtimeCapability;
  state: WalkieAirtime | null;
}> {
  if (!walkieAirtimePresent()) {
    return { capability: 'absent', state: null };
  }
  let raw: unknown;
  try {
    raw = await native.airtimeState();
  } catch {
    // A question nobody answered is not a slot anybody proved free — and
    // it is not a native we can classify either.
    return { capability: 'absent', state: null };
  }
  const state = decodeWalkieAirtime(raw);
  if (state === null) {
    // IT ANSWERED, AND WE CANNOT READ IT. That is a different fact from
    // silence and it gets a different word.
    return { capability: 'incompatible', state: null };
  }
  return { capability: 'arbiter', state };
}

/**
 * LISTEN. The identical body, on every revision the arbiter takes —
 * reservation, suppression, start effect, stop, debt birth, debt settle,
 * clear — and REPLAYED to a sink the instant it registers, which is what
 * makes a missed event safe: an edge has no replay, a level does.
 *
 * The event name is new on purpose. A build that emits the previous era's
 * `WalkieAdvertiserSettled` emits a body this decoder answers `null` for,
 * and the capability policy above turns that into an explicit park rather
 * than into a subscription that waits forever.
 */
export function onWalkieAirtimeState(
  cb: (s: WalkieAirtime | null) => void,
): () => void {
  const sub = getEmitter().addListener('WalkieAirtimeState', (e: unknown) => {
    cb(decodeWalkieAirtime(e));
  });
  return () => sub.remove();
}

// --------------------------------------------------------------- diagnosis
//
// FIELD TEST #8 (docs/PUNCHLIST.md): two phones showed one Wi-Fi name, but
// one sat on 192.168.1.x and the other on 192.168.86.x — two routers
// sharing an SSID. mDNS does not cross a subnet and UDP unicast does not
// route between them, so the walkie genuinely cannot work there — and the
// app's only word was "Nobody else on the channel yet", which is
// unactionable. Same-name-different-router will be common at BRC (camp
// hotspots share names). The app knows its own IP and subnet; when the
// channel stays empty it says the true thing instead.

/** What the native side knows about our own network position. */
export interface WalkieNet {
  /** A Wi-Fi-class interface carries an IPv4 — client Wi-Fi, or this
   * phone hosting the hotspot. */
  wifi: boolean;
  /** Our IPv4 on it, e.g. "192.168.1.216". */
  ip: string | null;
  /** CIDR prefix length, e.g. 24; null when the native side cannot say. */
  prefix: number | null;
}

/** Why the channel is empty — each kind is a distinct, honest state. */
export type WalkieDiagnosis =
  | { kind: 'no-wifi' }
  /** A podmate is close enough for Bluetooth to hear, yet absent from
   * this LAN's discovery — the two-router shape, said with our subnet so
   * two people can compare screens. */
  | { kind: 'split-network'; subnet: string }
  /** Nothing known to be wrong — show the comparable subnet line. */
  | { kind: 'alone'; subnet: string };

/** Re-check an empty channel this often. The first tick doubles as the
 * "reasonable window": NSD/Bonjour resolves in single-digit seconds, so a
 * channel still empty at ten is empty, not slow. */
export const WALKIE_DIAG_MS = 10_000;

/**
 * Our own network position, from the native module. Three-way honest: a
 * WalkieNet with wifi=false means the native side LOOKED and found no
 * Wi-Fi IPv4; null means it could not tell (an older native, an error) —
 * and the caller shows no diagnosis rather than a guessed one.
 */
export async function walkieNetInfo(): Promise<WalkieNet | null> {
  if (!native || typeof native.netInfo !== 'function') {
    return null;
  }
  try {
    const r = await native.netInfo();
    const ip = typeof r?.ip === 'string' && r.ip.length > 0 ? r.ip : null;
    if (!ip) {
      return { wifi: false, ip: null, prefix: null };
    }
    const prefix =
      Number.isInteger(r?.prefix) && r.prefix >= 1 && r.prefix <= 32
        ? (r.prefix as number)
        : null;
    return { wifi: true, ip, prefix };
  } catch {
    return null;
  }
}

/**
 * "192.168.1.216"/24 -> "192.168.1.x": the network half a person can read
 * off two screens and compare. Byte-granular on purpose — a /25 renders as
 * a /24 would, which is comparison-accurate for eyes. An unknown prefix
 * assumes /24, the overwhelming router default. Two DIFFERENT labels are
 * proof of two networks; two matching labels are not proof of one (both
 * routers may default to 192.168.1.x), so copy built on this may only
 * treat a mismatch as conclusive.
 */
export function subnetLabel(ip: string, prefix: number | null): string {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return ip;
  }
  const whole = Math.floor((prefix ?? 24) / 8);
  return parts.map((p, i) => (i < whole ? p : 'x')).join('.');
}

/**
 * Is any podmate close enough for Bluetooth to hear right now? Reads the
 * sighting store (src/crews/presence.ts) across the pod's roster —
 * picked cards ∪ announced members, me excluded. Presence is live only
 * while beacons arrive, which needs their sharing session on — so false
 * means "nobody KNOWN near", never "nobody near", and the diagnosis
 * treats it that way.
 */
export function podmateNearbyByBluetooth(
  crewCode: string,
  myCardId: string,
  nowMs: number = Date.now(),
): boolean {
  try {
    const code = normalizeCrewCode(crewCode);
    const crew = listCrews().find(c => normalizeCrewCode(c.code) === code);
    const ids = new Set(crew?.memberIds ?? []);
    for (const a of announcedMembers(crewCode)) {
      ids.add(a.cardId);
    }
    ids.delete(myCardId);
    for (const id of ids) {
      if (presenceFor(id, nowMs)?.live) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // a store error must not take down the panel's timer
  }
}

/** The decision itself, pure for tests. */
export function diagnoseChannel(
  net: WalkieNet,
  podmateNearby: boolean,
): WalkieDiagnosis {
  if (!net.wifi || !net.ip) {
    return { kind: 'no-wifi' };
  }
  const subnet = subnetLabel(net.ip, net.prefix);
  return podmateNearby
    ? { kind: 'split-network', subnet }
    : { kind: 'alone', subnet };
}

/** The panel's one call: null = cannot tell, so say nothing new. */
export async function diagnoseWalkieSilence(
  crewCode: string,
  myCardId: string,
): Promise<WalkieDiagnosis | null> {
  const net = await walkieNetInfo();
  return net
    ? diagnoseChannel(net, podmateNearbyByBluetooth(crewCode, myCardId))
    : null;
}

/**
 * THE WAY THROUGH, appended to every diagnosis that means "no live talk"
 * (owner ruling 16:20: async keeps EQUAL BILLING with the walkie).
 *
 * Rung 3 (BLE lo-fi, both platforms as of 2026-08-25) means no Wi-Fi no
 * longer means no walkie — but only for podmates inside Bluetooth range.
 * Beyond it a camper still has no live path, and the diagnosis alone leaves
 * them holding a dead button and a true sentence. The voice note is not a
 * consolation prize there: it rides the SAME BLE mesh, store-and-forward,
 * so it reaches people the live rung cannot. Saying so at the moment of
 * failure is the difference between "the app is broken" and "use the other
 * thing, it is right there".
 *
 * Deliberately does NOT apologise and does NOT call live talk the real one.
 */
export const VOICE_NOTE_ROUTE =
  'A voice note reaches them either way — it travels on Bluetooth, no Wi-Fi needed.';

/** The alone-state sibling, and the tense is the whole point.
 *
 * VOICE_NOTE_ROUTE promises DELIVERY, and the two states above have earned
 * it: a podmate is provably in Bluetooth range, the note goes now. 'alone'
 * has no such evidence — nobody is known near, so the note is held and
 * gossiped when someone arrives. "Reaches them" there would be a promise
 * this state cannot see the ground for, and a promise a camper acts on and
 * walks away from is worse than no sentence at all.
 */
export const VOICE_NOTE_ROUTE_KEEPS =
  'A voice note keeps until they are in range — it travels on Bluetooth, no Wi-Fi needed.';

/** The words for each state — beside the decision so tests read both.
 * The split copy treats only a subnet MISMATCH as conclusive (see
 * subnetLabel): a match can still hide two routers, or an access point
 * that isolates its clients, and the copy must not claim otherwise. */
export function walkieDiagnosisCopy(d: WalkieDiagnosis): string {
  switch (d.kind) {
    case 'no-wifi':
      return (
        // Rung 3 changed this sentence: no Wi-Fi no longer means no live
        // talk — a podmate in Bluetooth range arrives lo-fi by itself.
        // TRUE ON BOTH PLATFORMS since the iOS mirror (2026-08-25 — for
        // the hours rung 3 was Android-only, this shared copy overclaimed
        // on iPhones). The copy may describe that MECHANISM but must not
        // promise a peer this state cannot see (the VOICE_NOTE_ROUTE_KEEPS
        // lesson).
        "This phone isn't on Wi-Fi. A podmate in Bluetooth range still " +
        'comes through — rougher, but live. For full quality, join the ' +
        'same Wi-Fi as your pod, then come back here. ' +
        VOICE_NOTE_ROUTE
      );
    case 'split-network':
      return (
        "A podmate is nearby by Bluetooth but can't be heard on this " +
        `Wi-Fi. You're on ${d.subnet} — if their walkie shows a different ` +
        'number, your phones are on two routers sharing one Wi-Fi name. ' +
        'Get on the same one and the walkie works. ' +
        VOICE_NOTE_ROUTE
      );
    case 'alone':
      return (
        `You're on ${d.subnet}. A podmate's walkie can only hear you when ` +
        'it shows the same number. ' +
        VOICE_NOTE_ROUTE_KEEPS
      );
  }
}

// ------------------------------------------------------------------ the cap
//
// OWNER RULING (2026-08-24): "totally fine if you build in a soft guard that
// limits the number of joiners in a walkie channel to 10 or even less."
//
// It is a guard with two jobs, and the second one is why the number is small.
//
// 1. AUDIO. A walkie is one channel with one talker; the receive path mixes
//    every sender into a single stream, so simultaneous speakers do not
//    arrive as two voices, they arrive as neither (PUNCHLIST #12). The more
//    people hold the button, the likelier that is. Ten is about where a
//    single-channel radio stays usable by convention alone.
// 2. THE RADIO. Live voice is unicast to EVERY peer, one datagram per peer
//    per 20 ms frame (PUNCHLIST #11). At 32 KB/s per peer the cost is linear
//    in the channel size: 9 peers is ~290 KB/s and 450 packets/sec, which a
//    phone carries comfortably. Sixty would be 1.9 MB/s and 3,000 pps, which
//    it does not. The cap IS the fan-out cure until the codec lands.
//
// IT IS SOFT, AND THE HONEST WORD IS "SOFT": there is no admission control on
// a UDP/mDNS channel — anyone with the pod code can join, and no phone can
// stop them. What this guard actually does is bound what THIS phone transmits
// to, and say so. Two phones with different discovery orders can therefore
// disagree about who is in; sorting the selection deterministically (native
// side, by senderHash) makes them agree in the overwhelming case without
// pretending we have a quorum protocol.
//
// THE OVERFLOW PATH IS THE ANSWERING MACHINE, NOT AN ERROR. Async keeps equal
// billing with live (owner ruling 16:20) — a pod too big for the walkie is
// exactly a pod that should be leaving voice notes, so the copy says that
// instead of apologising.

/** Everyone on the channel, including me. Ten is the owner's ceiling. */
export const WALKIE_MAX_PARTICIPANTS = 10;

/** Peers, therefore, excluding me. This is the number the native fan-out
 * bounds itself to and the number the panel compares against. */
export const WALKIE_MAX_PEERS = WALKIE_MAX_PARTICIPANTS - 1;

/** Is the channel at or past its live-talk ceiling? */
export function walkieChannelFull(peerCount: number): boolean {
  return peerCount >= WALKIE_MAX_PEERS;
}

/**
 * How many of the discovered peers this phone will actually transmit to.
 * Never negative, never above the cap — the two clamps that keep a bad
 * count from turning into a bad loop bound on the native side.
 */
export function walkieTransmitCount(peerCount: number): number {
  if (!Number.isFinite(peerCount) || peerCount <= 0) {
    return 0;
  }
  return Math.min(Math.floor(peerCount), WALKIE_MAX_PEERS);
}

/**
 * The one sentence to show when the channel is at its ceiling, or null when
 * it is not. Names the limit, names what still works, and does NOT call the
 * answering machine a fallback — it is the peer of live talk, and at this
 * size it is the better tool.
 */
export function walkieCapCopy(peerCount: number): string | null {
  if (!walkieChannelFull(peerCount)) {
    return null;
  }
  return (
    `Live talk is full at ${WALKIE_MAX_PARTICIPANTS} people — this phone is ` +
    `talking to the first ${WALKIE_MAX_PEERS} it found. For a bigger pod, a ` +
    'voice note reaches everyone, and keeps.'
  );
}

// ------------------------------------------------------------- double-talk
//
// PUNCHLIST #12. The receive path writes every accepted frame into ONE
// AudioTrack and lastSeq is keyed per SENDER, so two people holding the
// button at once both pass the freshness gate and their PCM interleaves. The
// result is not two voices — it is neither voice.
//
// A real walkie has the same physics (one channel, one talker) and campers
// know the convention, so this is defensible. What is NOT defensible is the
// app staying silent about it: the speaker hears themselves fine and has no
// way to learn that nobody else did. Proper mixing is a per-sender jitter
// buffer summed before write, which is real work and is NOT this. This is the
// one sentence that makes the failure legible.
//
// BEST-EFFORT, AND THE LIMIT IS STRUCTURAL: the native side throttles
// WalkieSpeaking to about one event per second GLOBALLY, not per sender, so
// concurrent talkers surface as the reported name CHANGING between events
// rather than as two simultaneous events. Detection therefore lags by up to
// a second and can miss a very short overlap. The durable version reports
// concurrent senders from native, where the frames actually arrive; this
// reads the signal we already have rather than shipping nothing.

/** How long two different speakers count as "at the same time". Three
 * seconds because the native throttle is ~1 s and we need at least two
 * samples to see a change at all — shorter windows cannot detect what the
 * throttle cannot report. */
export const WALKIE_DOUBLETALK_MS = 3000;

/** One heard speaker, as the panel accumulates them. */
export interface WalkieSpeakerSample {
  name: string;
  atMs: number;
}

/**
 * Distinct people heard talking inside the window. The 'someone' fallback is
 * EXCLUDED, not counted: it is what the native side emits when it cannot
 * resolve a senderHash to a name, so one peer flickering between 'someone'
 * and their real name would otherwise read as two people — a false alarm
 * about the one thing this is supposed to make trustworthy.
 */
export function distinctSpeakers(
  samples: WalkieSpeakerSample[],
  nowMs: number,
): string[] {
  const seen = new Set<string>();
  for (const s of samples) {
    if (nowMs - s.atMs > WALKIE_DOUBLETALK_MS) {
      continue;
    }
    const name = (s.name ?? '').trim();
    if (name.length === 0 || name === 'someone') {
      continue;
    }
    seen.add(name);
  }
  return [...seen];
}

/**
 * The sentence, or null when nobody is stepping on anyone. Names the people
 * where it can, because "two people are talking" is a fact and "Dusty and
 * Marisol are talking over each other" is actionable.
 */
export function doubleTalkCopy(
  samples: WalkieSpeakerSample[],
  nowMs: number,
): string | null {
  const who = distinctSpeakers(samples, nowMs);
  if (who.length < 2) {
    return null;
  }
  const names = who.length === 2 ? `${who[0]} and ${who[1]}` : `${who.length} people`;
  return `${names} are talking at once — the channel carries one voice, so take turns.`;
}

/** Channel-membership changes inside this window read as churn. §1 says a
 * rung failure must never degrade membership; until the channel line grows
 * stable rows, the honest patch is to NAME the churn while it happens —
 * a claim about the observed past, in the doubleTalkCopy shape, never a
 * sticky per-row "unstable" badge (that would be a claim about the
 * future). */
export const WALKIE_CHURN_MS = 60_000;

export function linkChurnCopy(
  flipsMs: number[],
  nowMs: number,
): string | null {
  const recent = flipsMs.filter(t => nowMs - t <= WALKIE_CHURN_MS);
  if (recent.length < 2) {
    return null;
  }
  return 'Links come and go out here — names drop off the channel and come back. That is the dust, not a fault. Voice notes and messages get through either way.';
}

// ------------------------------------------------------------- call signals
//
// Video-call signaling (docs/VIDEO-CALLS.md) rides the walkie's OWN wire:
// one more codec id in the PW frame, unicast to ONE peer over whatever
// socket already reaches them — LAN or the Aware datapath, the same
// per-peer send paths the voice uses. No server, no internet, and a build
// that does not know the codec drops the frames silently (ladder §3).

/** Codec id 0x6 in the PW frame's head byte: call-control payload, never
 * audio. Must match WalkieModule.kt CODEC_CALL and Walkie.swift codecCall
 * — a test reads all three files. */
export const WALKIE_CODEC_CALL = 0x6;

/** Does this native build carry the signal seam? An older native lacks
 * sendSignal, and the answer must be "no call button", never a red box. */
export function walkieSignalPresent(): boolean {
  return native != null && typeof native.sendSignal === 'function';
}

/** Does this native build carry the hang-diagnosis pulse? An older native
 * lacks logPulse, and the honest answer there is "no evidence", never a
 * two-second interval calling into nothing (see src/crews/hangPulse.ts). */
export function walkiePulsePresent(): boolean {
  return native != null && typeof native.logPulse === 'function';
}

/**
 * One beat of the two-thread pulse (docs/VIDEO-CALLS.md §8). The native
 * side prints `walkie//hb <tag>` on the thread the call ARRIVES on and
 * `walkie//hb main` from the main queue, so a tethered syslog says which
 * of the two threads stopped.
 *
 * Fire-and-forget on purpose: no promise, no await, nothing to reject. A
 * diagnostic that can throw into a call is a second bug wearing the first
 * one's clothes.
 */
export function walkiePulse(tag: string): void {
  try {
    native?.logPulse?.(tag);
  } catch {
    // Never the thing that breaks a call.
  }
}

/** A call-control payload from one peer: who (senderHash) and the raw
 * chunk bytes, base64 — callSignal.ts owns what is inside them. */
export function onWalkieSignal(
  cb: (s: { from: number; payload: string }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'WalkieSignal',
    (e: { from?: string; payload?: string }) => {
      const from = parseInt(e?.from ?? '', 16);
      if (!Number.isFinite(from) || !e?.payload) {
        return; // a torn event is dropped, like a torn frame
      }
      cb({ from: from >>> 0, payload: e.payload });
    },
  );
  return () => sub.remove();
}

/** Unicast one signal payload (base64, ≤ the native frame budget) to the
 * peer with this senderHash. Rejects when the walkie is off or the peer
 * is no longer on the channel — the reliable layer treats both as loss.
 *
 * `fanout` is how many of that podmate's datagram rows this ONE payload
 * may ride, best-proven first (docs/VIDEO-CALLS.md §2a). One is the
 * ordinary case; the signaler asks for two while retransmitting, and the
 * receiver's dedupe-by-message-id makes the second copy harmless. The
 * native side clamps it — a JS-side-only bound is not a bound.
 *
 * The third argument arrives with the natives that accept it: JS, Kotlin
 * and Swift ship from this one tree, and the classic bridge checks arity,
 * so all three move together (a videoWire test reads all three files). */
export async function sendWalkieSignal(
  toHash: number,
  payloadB64: string,
  fanout = 1,
): Promise<void> {
  if (!walkieSignalPresent()) {
    throw new Error('this build cannot signal');
  }
  await native.sendSignal(toHash, payloadB64, fanout);
}

/** Mute/unmute walkie PLAYBACK while a call owns the audio path
 * (docs/VIDEO-CALLS.md §5). PTT suppression closed only the mic half of
 * the echo loop: the call plays its peer on the loudspeaker, and pod
 * voice played beside it rides straight back into the call's open mic —
 * WebRTC's AEC cancels its own far-end, never a separate app-owned
 * track. Fail-soft: a native without setCallActive cannot place calls
 * either (callsPresent gates on the same build), so there is nothing to
 * mute. */
export async function setWalkieCallMuted(muted: boolean): Promise<void> {
  if (!native || typeof native.setCallActive !== 'function') {
    return;
  }
  try {
    await native.setCallActive(muted);
  } catch {
    // a walkie that is off has nothing playing — the goal state
  }
}
