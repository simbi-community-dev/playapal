/**
 * Tour seen-state (0.7.3) — one settings-table flag behind the replayable
 * feature tour (docs/NTY-PATTERNS.md §4). The flag only gates the FIRST-RUN
 * mount; the Settings "Replay the feature tour" row mounts the tour
 * unconditionally and never reads or resets this.
 */
import { getSetting, setSetting } from '../events/db';

export const TOUR_SEEN_KEY = 'tour_seen';

export function tourSeen(): boolean {
  return getSetting(TOUR_SEEN_KEY) === '1';
}

export function markTourSeen(): void {
  setSetting(TOUR_SEEN_KEY, '1');
}
