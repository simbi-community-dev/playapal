/**
 * The bundled city-geometry asset, typed and null-safe.
 *
 * geometry.json is the REAL 2026 build (no `fixture` marker; sources in
 * assets/city-geo/PROVENANCE.md), produced by tools/build_city_geo.py.
 * A future re-drop swaps in by re-running that tool — no code changes.
 *
 * Null-safe ON PURPOSE: the waypoint compass's GPS-only safety floor
 * (src/geo/brcGeo.ts header) must survive this asset failing to load —
 * callers treat null as "no city language, arrow still works".
 */

import type { BrcGeometry } from './brcGeo';

/** The event year this build serves. City-derived guidance (addresses,
 * toilets, walk anchoring) is only safe when the geometry matches it —
 * the city recenters and restreets every year. */
export const EVENT_YEAR = 2026;

let cached: BrcGeometry | null | undefined;

export function getCityGeometry(): BrcGeometry | null {
  if (cached === undefined) {
    try {
      // Bundled by metro like the built-in packs (src/packs/builtins.ts).
      const geo = require('../../assets/city-geo/geometry.json') as BrcGeometry &
        { year?: number; fixture?: string };
      // FAIL CLOSED on stale or fixture geometry (release QA round 2,
      // finding 10): a 2025 layout would hand out WRONG toilet directions
      // and addresses in a 2026 city. Wrong-year geometry never loads; a
      // fixture loads in dev builds only, so the lane stays testable while
      // production waits for the real drop. Callers already survive null —
      // the pin/home compass is geometry-free by design.
      // A structurally-empty placeholder (the public tree bundles one so
      // Metro can resolve the static require) is NO geometry anywhere —
      // even the dev lane must not hand it to the math.
      const structurallyComplete =
        Array.isArray((geo as any).rings ?? (geo as any).streets ?? null) ||
        typeof geo.bearingDeg === 'number';
      if (!structurallyComplete) {
        console.warn('[geo] bundled geometry is a placeholder — compass runs on its geometry-free floor');
        cached = null;
      } else if (geo.year !== EVENT_YEAR || geo.fixture) {
        // Dev builds keep the stale/fixture geometry (loudly) so the lane
        // stays testable; production builds get null and the compass's
        // geometry-free floor.
        if (__DEV__) {
          console.warn(
            `[geo] geometry is ${geo.year}${geo.fixture ? ' (fixture)' : ''} for event year ${EVENT_YEAR} — allowed in dev, refused in production`,
          );
          cached = geo;
        } else {
          cached = null;
        }
      } else {
        cached = geo;
      }
    } catch (e) {
      console.warn('[geo] city geometry asset failed to load:', e);
      cached = null;
    }
  }
  return cached;
}
