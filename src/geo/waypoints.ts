/**
 * Saved waypoints ("pins") — drop the current GPS fix under a short name
 * ("Home", "My bike", "that art piece") and the compass can point back to it
 * forever after. Owner's framing: radically simple wayfinding is first-class.
 *
 * HOME IS JUST THE PIN NAMED "Home" — no separate mechanism, it only gets
 * UI prominence (one-tap "Take me home").
 *
 * Storage: one JSON settings row (settings key-value table, same channel as
 * every other app setting). Pin counts are tiny; no schema work needed —
 * deliberately NOT an ADDITIVE_COLUMNS migration.
 */

import { getSetting, setSetting } from '../events/db';

export interface SavedPin {
  id: string;
  label: string;
  lat: number;
  lon: number;
  savedAt: number;
}

const KEY = 'saved_waypoints';

/** The label whose pin gets the one-tap "Take me home" treatment. */
export const HOME_LABEL = 'Home';

// ---------------------------------------------------------------------------
// Change subscription (the campNotes/favorites revision-emitter pattern).
// Pins had no change signal before "My plans" (src/rightnow/myPlans.ts)
// needed to re-synthesize its searchable doc when a pin lands or leaves —
// a poll would either lag or burn battery, and every other user-owned store
// (favorites, notes, crew messages) already speaks this exact shape.
// ---------------------------------------------------------------------------

let revision = 0;
const watchers = new Set<() => void>();

export function pinsRevision(): number {
  return revision;
}

export function subscribePinsChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifyPinsChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

export function listPins(): SavedPin[] {
  const raw = getSetting(KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (p: any): p is SavedPin =>
        p &&
        typeof p.id === 'string' &&
        typeof p.label === 'string' &&
        typeof p.lat === 'number' &&
        typeof p.lon === 'number',
    );
  } catch {
    return []; // corrupt row: start clean rather than crash the compass
  }
}

/**
 * Save (or move) a pin. Same label (case-insensitive) replaces the old pin —
 * dropping "Home" again from a new tent site just works.
 */
export function savePin(label: string, lat: number, lon: number): SavedPin {
  const clean = label.trim().replace(/\s+/g, ' ').slice(0, 40) || 'Pin';
  const pin: SavedPin = {
    id: `pin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    label: clean,
    lat,
    lon,
    savedAt: Date.now(),
  };
  const rest = listPins().filter(p => p.label.toLowerCase() !== clean.toLowerCase());
  setSetting(KEY, JSON.stringify([pin, ...rest]));
  notifyPinsChanged();
  return pin;
}

export function removePin(id: string): void {
  setSetting(KEY, JSON.stringify(listPins().filter(p => p.id !== id)));
  // Unconditional (favorites-style): a no-op remove notifying is harmless —
  // every subscriber debounces or re-reads — and a conditional here is one
  // more branch to get subtly wrong.
  notifyPinsChanged();
}

export function homePin(pins: SavedPin[] = listPins()): SavedPin | undefined {
  return pins.find(p => p.label.toLowerCase() === HOME_LABEL.toLowerCase());
}
