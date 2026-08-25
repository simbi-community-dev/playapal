/**
 * The Wi-Fi Aware JS seam — rung 4 of the connectivity ladder
 * (docs/WALKIE-LADDER.md §9). A thin typed cover over
 * NativeModules.WifiAware, matching walkie.ts's stance so the UI and tests
 * never touch a native surface directly.
 *
 * THIS SEAM CAN ONLY ANSWER "does this phone have the radio". There is no
 * start, no stop, no send: the native halves are availability probes and
 * nothing else. When the data path lands, it lands behind this file.
 *
 * WHY IT SHIPS INERT. Android Wi-Fi Aware is vendor-dependent and iOS is
 * 26-or-later; our own field phones (a Pixel 7 and a Pixel 9 Pro) are
 * UNMEASURED, and every rung-4 number in the ladder doc comes from the
 * standard rather than from our hardware. Shipping the probe with 0.8 is how
 * that answer arrives in time to change the design instead of after it.
 *
 * NOTHING HERE MAY PROMOTE A PEER'S RUNG (ladder §5). Capability is
 * announced and durable; availability is proven per-peer by a round trip.
 * A `true` from this file means "worth probing", never "reachable".
 */
import { NativeModules, Platform } from 'react-native';

const native = NativeModules.WifiAware;

/** Why a phone cannot use Wi-Fi Aware, kept apart because the sentences a
 * user should hear are different — and because one of these is permanent
 * and the others are not. */
export type WifiAwareReason =
  /** Usable right now. */
  | 'ok'
  /** Android: the radio exists, the runtime says no (Wi-Fi or Location off).
   * Recoverable — and we deliberately do not guess WHICH is off, because a
   * wrong instruction in front of a camper is worse than a vague one. */
  | 'off'
  /** No Aware in the silicon or the vendor stack. PERMANENT: this phone's
   * ceiling is BLE forever, which is why the BLE floor is not a legacy path. */
  | 'no-hardware'
  /** Android below 26 / iOS below 26. Also permanent for that device. */
  | 'os-too-old'
  /** Android: feature advertised, service absent — a real vendor state. */
  | 'no-service'
  /** iOS: built against an SDK with no WiFiAware framework. A BUILD fact, not
   * a device fact — the one reason here that we can fix from a laptop. */
  | 'no-framework'
  /** iOS 26 with the framework, device still says no. */
  | 'unsupported'
  /** The probe itself threw. Reported, never swallowed. */
  | 'error'
  /** No native module in this build (old app, jest, storybook). */
  | 'absent';

export interface WifiAwareReport {
  platform: string;
  /** The radio exists at all. Permanent per device. */
  hardware: boolean;
  /** The radio is usable right now. NOT a statement about any peer. */
  available: boolean;
  reason: WifiAwareReason;
  /** Android API level, when the native half reported one. */
  sdkInt?: number;
  /** iOS version string, when the native half reported one. */
  osVersion?: string;
  /** Exception text when reason is 'error'. */
  detail?: string;
}

export function wifiAwarePresent(): boolean {
  return native != null;
}

/**
 * Probe this phone. NEVER REJECTS — "this phone cannot" is an ANSWER, not an
 * error, and a rejecting probe reads to a caller as "the probe is broken",
 * which is the one reading that sends someone hunting a bug instead of
 * writing down a measurement.
 */
export async function describeWifiAware(): Promise<WifiAwareReport> {
  if (!native) {
    return {
      platform: Platform.OS,
      hardware: false,
      available: false,
      reason: 'absent',
    };
  }
  try {
    const r = (await native.describe()) as Partial<WifiAwareReport> | null;
    return {
      platform: typeof r?.platform === 'string' ? r.platform : Platform.OS,
      hardware: r?.hardware === true,
      available: r?.available === true,
      reason: isReason(r?.reason) ? r.reason : 'error',
      ...(typeof r?.sdkInt === 'number' ? { sdkInt: r.sdkInt } : {}),
      ...(typeof r?.osVersion === 'string' ? { osVersion: r.osVersion } : {}),
      ...(typeof r?.detail === 'string' ? { detail: r.detail } : {}),
    };
  } catch (e: unknown) {
    return {
      platform: Platform.OS,
      hardware: false,
      available: false,
      reason: 'error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

const REASONS: readonly string[] = [
  'ok',
  'off',
  'no-hardware',
  'os-too-old',
  'no-service',
  'no-framework',
  'unsupported',
  'error',
  'absent',
];

function isReason(v: unknown): v is WifiAwareReason {
  return typeof v === 'string' && REASONS.includes(v);
}

/**
 * The rung bitmap this phone announces (docs/WALKIE-LADDER.md §4). Bits are
 * CAPABILITY — what this phone HAS — never availability, so a radio switched
 * off at announce time must not change what we claim. `hardware`, not
 * `available`, is therefore the field read here, and that distinction is the
 * whole reason the native halves report both.
 *
 * Bit 1 (live lo-fi over BLE) is NOT set by anything yet: rung 3 is designed
 * and implemented nowhere, and announcing a rung we cannot serve would strand
 * a peer who believed us. It goes in with the codec.
 */
export const RUNG_LIVE_LOFI = 1;
export const RUNG_WIFI_AWARE = 2;
export const RUNG_LAN = 4;

export function rungBitmap(report: WifiAwareReport): number {
  return report.hardware ? RUNG_WIFI_AWARE : 0;
}

// ---------------------------------------------------------------- the cache

/**
 * The probe is a device fact that cannot change while the app is running, so
 * it is asked ONCE and remembered. Two entry points because the callers have
 * different shapes: the announcement path can await, but a render cannot.
 *
 * Until the probe lands this reads 0 — "no rungs above the floor" — which is
 * both the safe answer and the true one for every phone that never answers.
 * Announcing a rung we have not confirmed would strand a peer who believed
 * us, and that is the one failure the ladder's invariant forbids.
 */
let cachedRungs = 0;
let priming: Promise<number> | null = null;

/** For renders: never blocks, never throws, 0 until the probe has landed. */
export function myRungsSync(): number {
  return cachedRungs;
}

/** For the announcement path: probes once, then returns the cached answer. */
export async function primeMyRungs(): Promise<number> {
  if (priming === null) {
    priming = describeWifiAware().then(r => {
      cachedRungs = rungBitmap(r);
      return cachedRungs;
    });
  }
  return priming;
}

/** Tests only — the cache is process-wide by design. */
export function resetRungCacheForTests(): void {
  cachedRungs = 0;
  priming = null;
}
