/**
 * THE HANG-DIAGNOSIS PULSE (docs/VIDEO-CALLS.md §8).
 *
 * Two hard freezes on 2026-08-26 ended in a force-quit and left NOTHING
 * behind: a wedged phone writes no .ips, and a tethered syslog shows the
 * same picture — silence — whether the JS thread stopped, the main thread
 * stopped, or the app was simply idle. Three very different bugs, one
 * indistinguishable trace.
 *
 * So while the phone is inside one of the two windows a freeze has
 * actually been seen in — a call up, or Apple's pairing sheet open — JS
 * calls the native pulse every HANG_PULSE_MS, and each call prints two
 * lines from two threads. On the tether:
 *
 *   `hb js` and `hb main` alternating  → neither thread is wedged
 *   `hb js` repeating, no `hb main`    → the MAIN thread is blocked
 *   neither line, app still on screen  → the JS thread is blocked
 *
 * COST WHEN IDLE: zero. No window open, no interval, no native call, and
 * on Android (where no freeze has been seen and no native method exists)
 * nothing at all.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { walkiePulse, walkiePulsePresent } from './walkie';

/** Two seconds — fast enough that a freeze is bracketed to a couple of
 * seconds of the log, slow enough to be free. */
export const HANG_PULSE_MS = 2000;

/**
 * Beat the pulse for as long as `active` holds. The first beat is
 * immediate, so a window that opens and freezes instantly still leaves one
 * line proving the window opened at all.
 */
export function useHangPulse(active: boolean): void {
  useEffect(() => {
    if (!active || Platform.OS !== 'ios' || !walkiePulsePresent()) {
      return;
    }
    walkiePulse('js');
    const id = setInterval(() => walkiePulse('js'), HANG_PULSE_MS);
    return () => clearInterval(id);
  }, [active]);
}
