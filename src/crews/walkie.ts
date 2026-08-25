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
}

export async function stopWalkie(): Promise<void> {
  on = false;
  if (native) {
    try {
      await native.stop();
    } catch {
      // a walkie that never started is already the goal state
    }
  }
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

export function onWalkiePeers(
  cb: (p: { count: number; names: string[]; talkingTo: number }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'WalkiePeers',
    (e: { count?: number; names?: string[]; talkingTo?: number }) => {
      const names = e?.names ?? [];
      const count = e?.count ?? names.length;
      // talkingTo comes from the native cap. An OLDER native that does not
      // send it must not read as "talking to nobody", so it falls back to the
      // JS cap over the count — the same answer the native would have given.
      cb({
        count,
        names,
        talkingTo:
          typeof e?.talkingTo === 'number'
            ? e.talkingTo
            : walkieTransmitCount(count),
      });
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
 * Live voice needs a shared LAN today and BLE live voice is post-burn, so a
 * camper with no shared Wi-Fi has no walkie AT ALL — and the diagnosis alone
 * leaves them holding a dead button and a true sentence. The voice note is
 * not a consolation prize here: it rides the SAME BLE mesh their podmate is
 * already visible on, so it works in exactly the conditions the walkie does
 * not. Saying so at the moment of failure is the difference between "the app
 * is broken" and "use the other thing, it is right there".
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
        "This phone isn't on Wi-Fi. The walkie needs a shared network — " +
        'join the same Wi-Fi as your pod, then come back here. ' +
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
