/**
 * THE CAMP HOTSPOT — a shared Wi-Fi the pod makes for itself.
 *
 * THE WHOLE IDEA IN ONE SENTENCE: the walkie carries voice with no network
 * at all, but a video call needs an IP network under it, so one phone makes
 * one — with no internet behind it and nothing to sign into — and everyone
 * else joins by pointing a camera at a QR code.
 *
 * WHY A QR AND NOT A BUTTON. The joiner may be an iPhone, and an iPhone
 * cannot be made to join a Wi-Fi network by another app. What it CAN do,
 * with zero code on our side, is read a `WIFI:` QR with the stock Camera
 * app and offer "Join <network>" — a behaviour Apple has shipped since
 * iOS 11. So the host renders the credentials as the code every phone in
 * the world already knows how to read, and the flow is the same one people
 * already use in cafes. Android joiners scan the identical code from
 * Settings > Wi-Fi (or their own camera), and the name and password are
 * also printed in plain text for the phone that will not scan anything.
 *
 * WHAT THIS FILE IS NOT. It does not join a network programmatically on
 * Android either, and that is a decision rather than an omission: a network
 * joined through WifiNetworkSpecifier is a peer-to-peer network that the
 * WebRTC stack's network monitor does not report, which would put the video
 * call straight back into the "no route" failure the hotspot exists to end.
 * An ordinary association to an ordinary access point — even one with no
 * internet — is reported normally. Honest and working beats one-tap and
 * broken.
 *
 * THE STATE MACHINE IS PURE. Everything the card can be — off, starting,
 * on with credentials, failed with a reason — is a (state, event) row in
 * `reduceHotspot`, with the native calls expressed as effects. The card
 * runs the effects; the tests own the table.
 */
import { NativeModules, Platform } from 'react-native';

const native = NativeModules.CampHotspot;

/** The event the native side emits when the SYSTEM takes the hotspot away
 * (the user started real tethering, the Wi-Fi stack reset). A QR still on
 * screen for a network that no longer exists is the worst version of this
 * feature, so the teardown is loud. */
export const HOTSPOT_STOPPED_EVENT = 'campHotspotStopped';

/**
 * Why a phone will not host. Kept apart because the sentence a camper needs
 * is different for each — and because two of them ("allow the permission"
 * and "turn location on") look identical from the outside while having
 * completely different fixes.
 */
export type HotspotReason =
  | 'ok'
  /** No native module in this build (an iPhone, jest, an older app). */
  | 'absent'
  /** iPhones join, they do not host. Permanent, and not a fault. */
  | 'ios'
  /** Below Android 8 — the API does not exist. Permanent. */
  | 'os-too-old'
  /** No Wi-Fi radio at all. Permanent. */
  | 'no-hardware'
  /** The nearby-Wi-Fi (Android 13+) or location (below it) grant is not
   * held. Recoverable, and the card can ask. */
  | 'no-permission'
  /** The grant IS held; location SERVICES are switched off. A different
   * switch, a different sentence. */
  | 'location-off'
  /** The radio found no channel — usually this phone is already on a
   * Wi-Fi network. The one failure a camper can fix in ten seconds. */
  | 'no-channel'
  /** The Wi-Fi stack is in a mode that excludes an access point. */
  | 'incompatible-mode'
  /** Hotspot use is disallowed by policy (carrier, work profile). */
  | 'tethering-off'
  /** A request from this app is already in flight. */
  | 'busy'
  /** It started and the configuration read back empty. The native half
   * closes the radio before reporting this: a refusal on screen never sits
   * over a live access point. */
  | 'no-credentials'
  /** The switch went off while the radio was still coming up, so the
   * hotspot that landed afterwards was closed where it landed. Its own
   * token because "you turned it off" and "something else took it away"
   * are different events with different next steps. */
  | 'cancelled'
  /** The system took the hotspot away. */
  | 'stopped'
  /** The framework refused without saying which of the above. */
  | 'generic'
  /** The call threw. Reported, never swallowed. */
  | 'error';

export interface HotspotCreds {
  ssid: string;
  passphrase: string;
  /** What the access point actually negotiated, so the QR can say the
   * truth rather than assuming WPA2. */
  security: 'open' | 'wpa2' | 'wpa3' | 'wpa3-transition';
}

export type HotspotPhase = 'off' | 'starting' | 'on' | 'failed';

export interface HotspotModel {
  phase: HotspotPhase;
  creds: HotspotCreds | null;
  /** Set only in `failed`; cleared by every path out of it. */
  reason: HotspotReason | null;
  detail: string | null;
}

export const hotspotOff: HotspotModel = {
  phase: 'off',
  creds: null,
  reason: null,
  detail: null,
};

export type HotspotEvent =
  /** The camper flipped the switch on. */
  | { type: 'arm' }
  /** The camper flipped it off, or the call ended. */
  | { type: 'disarm' }
  | { type: 'started'; creds: HotspotCreds }
  | { type: 'failed'; reason: HotspotReason; detail?: string }
  /** The system tore it down under us. */
  | { type: 'stopped-outside' }
  /** The camper read the failure and dismissed it. */
  | { type: 'dismiss' };

export type HotspotEffect = 'start-hotspot' | 'stop-hotspot';

interface Step {
  model: HotspotModel;
  effects: HotspotEffect[];
}

/**
 * The table. Two rules carry most of it:
 *
 *   NEVER TWO STARTS. Android allows one local-only hotspot request per
 *   app, so `arm` while starting or on is a no-op rather than a second
 *   request whose callback nobody is waiting on.
 *
 *   NEVER A SILENT STOP. A hotspot that goes away by itself lands in
 *   `failed`, not `off`, because the QR was on screen and somebody was
 *   about to scan it.
 */
export function reduceHotspot(m: HotspotModel, e: HotspotEvent): Step {
  switch (e.type) {
    case 'arm':
      if (m.phase === 'starting' || m.phase === 'on') {
        return { model: m, effects: [] };
      }
      return {
        model: { phase: 'starting', creds: null, reason: null, detail: null },
        effects: ['start-hotspot'],
      };
    case 'started':
      // A late 'started' after the camper already switched off must not
      // resurrect the card: the effect that turns it off has already run.
      if (m.phase !== 'starting') {
        return { model: m, effects: [] };
      }
      if (e.creds.ssid.length === 0) {
        return {
          model: {
            phase: 'failed',
            creds: null,
            reason: 'no-credentials',
            detail: null,
          },
          effects: ['stop-hotspot'],
        };
      }
      return {
        model: { phase: 'on', creds: e.creds, reason: null, detail: null },
        effects: [],
      };
    case 'failed':
      if (m.phase === 'off') {
        return { model: m, effects: [] };
      }
      return {
        model: {
          phase: 'failed',
          creds: null,
          reason: e.reason,
          detail: e.detail ?? null,
        },
        effects: [],
      };
    case 'stopped-outside':
      if (m.phase !== 'on' && m.phase !== 'starting') {
        return { model: m, effects: [] };
      }
      return {
        model: { phase: 'failed', creds: null, reason: 'stopped', detail: null },
        effects: [],
      };
    case 'disarm':
      if (m.phase === 'off') {
        return { model: m, effects: [] };
      }
      // 'starting' stops too: the reservation may land a beat after the
      // switch went off, and an access point nobody can see is exactly the
      // battery lie the mini-bar exists to prevent.
      return {
        model: hotspotOff,
        effects: m.phase === 'failed' ? [] : ['stop-hotspot'],
      };
    case 'dismiss':
      return m.phase === 'failed'
        ? { model: hotspotOff, effects: [] }
        : { model: m, effects: [] };
  }
}

/**
 * The sentence for each refusal. Every one of them names the thing the
 * camper can do next, or says plainly that there is nothing — which is
 * still better than a spinner that never resolves.
 */
export function hotspotReasonCopy(reason: HotspotReason): string {
  switch (reason) {
    case 'ok':
      return '';
    case 'absent':
    case 'ios':
      return "This phone can't host the Wi-Fi — an iPhone joins one, it can't make one. Ask an Android in the pod to host, and scan their code with your camera.";
    case 'os-too-old':
      return "This phone's Android is too old to make a hotspot from inside an app. You can still turn a hotspot on in Settings and share the name and password.";
    case 'no-hardware':
      return "This phone has no Wi-Fi radio to make a hotspot with.";
    case 'no-permission':
      // Two eras, one sentence: Android 13+ calls this grant nearby
      // Wi-Fi, and below it the same capability rides on PRECISE
      // location — where "Approximate" is a refusal the phone will not
      // explain, so this sentence has to.
      return 'Playa Pal needs permission to find nearby Wi-Fi. On Android 12 and older that grant is Location, and it has to be the precise one — nothing about your position leaves the phone. Allow it and try again.';
    case 'location-off':
      return 'Turn Location on in Settings — on this version of Android a hotspot cannot start without it. Nothing about your position leaves the phone.';
    case 'no-channel':
      return "The Wi-Fi radio couldn't find a free channel. If this phone is connected to a Wi-Fi network, disconnect it and try again.";
    case 'incompatible-mode':
      return "This phone's Wi-Fi is busy with something else it can't share — turn Wi-Fi off and on, then try again.";
    case 'tethering-off':
      return 'Hotspots are switched off on this phone by its carrier or its work profile. Another phone in the pod will have to host.';
    case 'busy':
      return "Still starting the last one — give it a moment.";
    case 'no-credentials':
      return "The hotspot started but wouldn't say its name and password, so it was switched back off. Turn a hotspot on in Settings instead and read them from there.";
    case 'cancelled':
      return 'That hotspot was switched off while it was still starting, so it never came up. Flip the switch on again when you want one.';
    case 'stopped':
      return 'The hotspot switched itself off. Something else on this phone took the Wi-Fi — turn it back on to keep the call going.';
    case 'generic':
      return "The Wi-Fi radio refused, without saying why. Turn Wi-Fi off and on, then try again — or host from another phone.";
    case 'error':
      return "Making the hotspot failed on this phone. You can still turn one on in Settings and read out the name and password.";
  }
}

// -------------------------------------------------------------- the QR

/**
 * The `WIFI:` payload every phone camera already knows how to read.
 *
 * ESCAPING IS THE WHOLE JOB HERE. The format is delimited by `;` and `:`,
 * so a passphrase containing either would end the field early and the
 * scanner would offer to join a network with half a password — silently,
 * and looking exactly like a wrong password typed by hand. Backslash,
 * semicolon, comma, colon and double-quote are therefore escaped with a
 * backslash, and BACKSLASH GOES FIRST or every escape we just added gets
 * escaped again.
 *
 * Android generates its own passphrase and picks from a safe alphabet
 * today, which is exactly why this must be written now rather than after a
 * vendor picks a different one.
 */
export function escapeWifiField(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * An SSID made only of hex digits is ambiguous in this format — the reader
 * is entitled to decode it as raw hex bytes instead of as text — and the
 * spec's answer is to wrap it in double quotes. A hotspot named `AB12CD`
 * that joins as three bytes of nonsense is a bug nobody would ever find
 * standing in a dust storm.
 */
function encodeSsid(ssid: string): string {
  const hexOnly = /^[0-9a-fA-F]+$/.test(ssid) && ssid.length % 2 === 0;
  return hexOnly
    ? `"${escapeWifiField(ssid)}"`
    : escapeWifiField(ssid);
}

/**
 * Build the code. Open networks get `T:nopass` and NO password field —
 * writing `P:;` for a network with no password makes some readers offer a
 * password prompt for a network that has none.
 */
export function wifiQrPayload(creds: HotspotCreds): string {
  const ssid = encodeSsid(creds.ssid);
  if (creds.security === 'open' || creds.passphrase.length === 0) {
    return `WIFI:T:nopass;S:${ssid};;`;
  }
  // WPA3-only advertises as SAE; a transition-mode access point is exactly
  // the network a WPA2 reader is meant to join as WPA, so it says WPA.
  const t = creds.security === 'wpa3' ? 'SAE' : 'WPA';
  return `WIFI:T:${t};S:${ssid};P:${escapeWifiField(creds.passphrase)};;`;
}

/** The code for a model, or null when there is nothing to show. */
export function hotspotQrPayload(m: HotspotModel): string | null {
  return m.phase === 'on' && m.creds !== null ? wifiQrPayload(m.creds) : null;
}

// ----------------------------------------------------------- the native seam

export interface HotspotSupport {
  supported: boolean;
  reason: HotspotReason;
  running?: boolean;
  sdkInt?: number;
}

export function campHotspotPresent(): boolean {
  return native != null;
}

const REASONS: readonly string[] = [
  'ok',
  'absent',
  'ios',
  'os-too-old',
  'no-hardware',
  'no-permission',
  'location-off',
  'no-channel',
  'incompatible-mode',
  'tethering-off',
  'busy',
  'no-credentials',
  'cancelled',
  'stopped',
  'generic',
  'error',
];

export function isHotspotReason(v: unknown): v is HotspotReason {
  return typeof v === 'string' && REASONS.includes(v);
}

const SECURITIES: readonly string[] = ['open', 'wpa2', 'wpa3', 'wpa3-transition'];

/**
 * Can this phone host? NEVER REJECTS — "this phone cannot" is an answer,
 * and a rejecting probe reads to its caller as a broken probe, which is the
 * one reading that sends someone hunting a bug instead of writing a
 * sentence.
 */
export async function describeCampHotspot(): Promise<HotspotSupport> {
  if (!native) {
    return {
      supported: false,
      reason: Platform.OS === 'ios' ? 'ios' : 'absent',
    };
  }
  try {
    const r = (await native.describe()) as Record<string, unknown> | null;
    return {
      supported: r?.supported === true,
      reason: isHotspotReason(r?.reason) ? r.reason : 'error',
      ...(typeof r?.running === 'boolean' ? { running: r.running } : {}),
      ...(typeof r?.sdkInt === 'number' ? { sdkInt: r.sdkInt } : {}),
    };
  } catch {
    return { supported: false, reason: 'error' };
  }
}

export type HotspotStartResult =
  | { ok: true; creds: HotspotCreds }
  | { ok: false; reason: HotspotReason; detail?: string };

/**
 * Start it. Never rejects, for the same reason the probe does not: a phone
 * that refuses is telling us something, and the refusal has to survive the
 * trip to the screen intact.
 */
export async function startCampHotspot(): Promise<HotspotStartResult> {
  if (!native) {
    return { ok: false, reason: Platform.OS === 'ios' ? 'ios' : 'absent' };
  }
  try {
    const r = (await native.start()) as Record<string, unknown> | null;
    if (r?.ok === true && typeof r.ssid === 'string' && r.ssid.length > 0) {
      const sec = typeof r.security === 'string' && SECURITIES.includes(r.security)
        ? (r.security as HotspotCreds['security'])
        : 'wpa2';
      return {
        ok: true,
        creds: {
          ssid: r.ssid,
          passphrase: typeof r.passphrase === 'string' ? r.passphrase : '',
          security: sec,
        },
      };
    }
    return {
      ok: false,
      reason: isHotspotReason(r?.reason) ? r.reason : 'error',
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

/** Stop it. Never rejects; stopping what is already stopped is fine. */
export async function stopCampHotspot(): Promise<void> {
  if (!native) {
    return;
  }
  try {
    await native.stop();
  } catch {
    // Nothing a camper can do with this, and nothing left running that a
    // React teardown will not close.
  }
}
