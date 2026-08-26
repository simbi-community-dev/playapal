/**
 * THE PAIRING SEAM — the JS half of rung 4's door
 * (docs/WALKIE-LADDER.md §9a, `ios/PlayaPal/WifiAwarePairing.swift`).
 *
 * WHAT PAIRING BUYS, IN ONE SENTENCE: two iPhones that have done Apple's
 * pairing ceremony once can carry full-quality walkie voice to each other
 * with no Wi-Fi anywhere — and two that have not cannot, no matter how
 * close they stand. The walkie's Aware rung publishes and browses scoped to
 * OS-paired devices, so before this door existed the set was empty on every
 * phone and the rung was a guaranteed zero.
 *
 * iOS ONLY, AND SAID SO HONESTLY. Android's Aware rung admits peers with a
 * pod-derived key and needs no ceremony; Apple exposes no app-supplied
 * credential at all, so the ceremony is the ONLY admission Apple offers.
 * That asymmetry is why this file has no Android half and why nothing here
 * may ever be phrased as iPhone↔Android: an iPhone and an Android phone do
 * not complete a Wi-Fi Aware datapath today, pairing or not (§9a — two open
 * Apple radars, roughly a year old). Cross-platform voice rides BLE.
 *
 * THE SEAM STANCE, matching walkie.ts and wifiAware.ts: the UI never touches
 * NativeModules directly, and this file NEVER THROWS. "This phone cannot
 * pair" is an ANSWER — a rejecting call reads to a caller as "the door is
 * broken", which sends someone hunting a bug instead of reading a sentence.
 */
import { NativeModules, Platform } from 'react-native';

const native = NativeModules.WifiAwarePairing;

/** Why the sheet did not open. One per cause, kept apart for the same
 * reason wifiAware.ts keeps its three falses apart: a build fact, an OS
 * fact and a silicon fact each deserve a different sentence. */
export type AwarePairingReason =
  /** The sheet is up. */
  | 'ok'
  /** iOS 26 and the framework are both here; the device still says no. */
  | 'unsupported'
  /** Below iOS 26. Permanent for that phone — Apple opened Wi-Fi Aware to
   * third-party apps in 26 and no earlier iPhone will ever have it. */
  | 'os-too-old'
  /** Built against an SDK with no WiFiAware/DeviceDiscoveryUI. A BUILD
   * fact, fixable from a laptop, never a device fact. */
  | 'no-framework'
  /** The WiFiAwareServices Info.plist entry is missing or misspelled — the
   * one failure that would leave a camper tapping a button that does
   * nothing, so it gets its own word. */
  | 'no-service'
  /** No window to present on (backgrounded at the wrong moment). */
  | 'no-window'
  /** No native module in this build (Android, an older app, jest). */
  | 'absent'
  /** The native side raised or the bridge threw. Reported, not swallowed. */
  | 'error';

export interface AwarePairingResult {
  /** True only when the system sheet is actually on screen. */
  presented: boolean;
  reason: AwarePairingReason;
}

/** Is there a pairing door in this build at all? False on Android and on
 * any build predating the module — the row hides rather than offering a
 * tap that cannot land. */
export function awarePairingPresent(): boolean {
  return Platform.OS === 'ios' && native != null;
}

/**
 * Open Apple's pairing sheet. Never throws.
 */
export async function presentAwarePairing(): Promise<AwarePairingResult> {
  if (!awarePairingPresent()) {
    return { presented: false, reason: 'absent' };
  }
  try {
    const r = (await native.present()) as Partial<AwarePairingResult> | null;
    return {
      presented: r?.presented === true,
      reason: isReason(r?.reason) ? r.reason : 'error',
    };
  } catch {
    return { presented: false, reason: 'error' };
  }
}

const REASONS: readonly string[] = [
  'ok',
  'unsupported',
  'os-too-old',
  'no-framework',
  'no-service',
  'no-window',
  'absent',
  'error',
];

function isReason(v: unknown): v is AwarePairingReason {
  return typeof v === 'string' && REASONS.includes(v);
}

// ------------------------------------------------------------------ copy

/**
 * CAPABILITY WORDS, NOT PROTOCOL WORDS. A camper does not have "Wi-Fi
 * Aware"; a camper has two iPhones and a question about whether they can
 * hear each other out past the trash fence. "Link iPhones directly" is what
 * the row DOES.
 */
export const AWARE_PAIR_TITLE = 'Link iPhones directly';

/**
 * The one line under it. THE SECOND SENTENCE IS NOT DECORATION — this has
 * never run between two iPhones in the field, and a row that promised
 * without saying so would be the app's first overclaim. Field-testing is
 * the honest word and it is the owner's own.
 */
export const AWARE_PAIR_LINE =
  'Two iPhones can pair once and then talk at full quality with no Wi-Fi at ' +
  'all. New — being field-tested.';

/** The paragraph behind the circled ? (InfoTap), for the camper who taps. */
export const AWARE_PAIR_INFO =
  'Do this once, together, with both iPhones in hand: one of you shows this ' +
  'iPhone, the other finds it, and you confirm the same six-digit code. ' +
  'After that the phones remember each other, and the walkie can carry ' +
  'full-quality voice between them with no Wi-Fi and no cell service — ' +
  'roughly three to five times as far as the lo-fi link, not ten. ' +
  '\n\n' +
  'Linked is not connected. It only means the walkie is allowed to reach ' +
  'them; turn the walkie on and they appear on the channel. To unlink, use ' +
  'the iPhone Settings app: Privacy & Security, then Paired Devices. ' +
  '\n\n' +
  'This is iPhone-to-iPhone only, and it is new. An iPhone and an Android ' +
  'phone cannot use it at all — they still reach each other the way they ' +
  'always have, and everything else about the walkie is unchanged whether ' +
  'or not this works.';

/**
 * What to say when the sheet did not open. Never "an error occurred": every
 * one of these is a fact about the phone or the build, and a camper can act
 * on some of them.
 */
export function awarePairFailureCopy(reason: AwarePairingReason): string {
  switch (reason) {
    case 'os-too-old':
      return 'Linking iPhones directly needs iOS 26 or later. Everything else about the walkie works as it did.';
    case 'unsupported':
      return 'This iPhone cannot link directly to another one. Everything else about the walkie works as it did.';
    case 'no-framework':
    case 'absent':
      return 'This version of Playa Pal has no direct-link screen. Everything else about the walkie works as it did.';
    case 'no-service':
      return 'Direct linking is not set up right in this build — worth reporting. Everything else about the walkie works as it did.';
    case 'no-window':
      return 'The link screen could not open just now. Try again.';
    default:
      return 'The link screen could not open. Everything else about the walkie works as it did.';
  }
}
