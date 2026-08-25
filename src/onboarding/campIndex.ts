/**
 * The full official camp roster, bundled statically (0.7.4).
 *
 * The onboarding picker's 0.7.3 source — SELECT DISTINCT camp FROM events —
 * only knew camps that HOST events, so a placed, registered camp with no
 * public events was invisible (an owner field test caught one). The camps
 * pack ships all ~1,200 placed camps as markdown; tools/build_camps_index.py
 * derives this index from that same shipped pack, so the roster the picker
 * offers is exactly the roster the reader documents. Same metro-bundled
 * static-require pattern as brc-art-2026/locations.json and the city
 * geometry.
 *
 * Fail-safe: a build without the asset (or a malformed one) yields [] and
 * the picker falls back to the events-derived directory — degraded, never
 * broken.
 */

export interface IndexedCamp {
  camp: string;
  location: string;
}

let cached: IndexedCamp[] | undefined;

export function campIndex(): IndexedCamp[] {
  if (cached === undefined) {
    try {
      const raw = require('../../assets/packs/camps-2026/camps-index.json');
      cached = Array.isArray(raw)
        ? raw.filter(
            (r: any): r is IndexedCamp =>
              r && typeof r.camp === 'string' && typeof r.location === 'string',
          )
        : [];
    } catch {
      cached = [];
    }
  }
  return cached;
}
