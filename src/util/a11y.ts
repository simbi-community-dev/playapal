import { AccessibilityInfo } from 'react-native';

/**
 * Speak a message to a screen reader, and never let its absence break the UI.
 *
 * This existed four times, identically, in PodMessages, WalkiePanel,
 * OnboardingFlow and Tour — every one of them wrapping the same call in the
 * same try/catch for the same reason. Four copies of a swallow is four places
 * to forget the swallow, and the failure mode of forgetting is an unhandled
 * throw on a platform with no announcer, in the middle of a gesture handler.
 */
export function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // No announcer on this platform or build — the visible UI still says it.
  }
}
