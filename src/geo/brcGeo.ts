/**
 * brcGeo — pure Black Rock City coordinate math. No React, no native
 * modules, no I/O: every function here is a plain (lat, lon, data) -> value
 * transform, unit-tested against hand-derived geometry.
 *
 * THE CITY IS A POLAR GRID. The yearly published layout (assets/city-geo/
 * geometry.json, built by tools/build_city_geo.py) gives the golden-spike
 * center, the true bearing of the 12:00 axis, ring radii in feet, and the
 * toilet banks. Everything else is trigonometry.
 *
 * SAFETY FLOOR (owner requirement, addendum 4): the waypoint functions
 * (gpsVector, arrowRotation, toWaypoint without `geo`) are PURE GPS — they
 * take no geometry and keep working if the city asset is missing, wrong-year,
 * or fails to load. Clock phrases and "7:32 & C" addresses are enhancements
 * LAYERED on top; losing them must never take the compass down with it.
 *
 * PROJECTION + ERROR BOUND. We use a local equirectangular projection:
 * feet-per-degree of latitude/longitude evaluated from a standard series at
 * the reference latitude, then flat 2-D math. Within the trash fence
 * (<= 8,337 ft from the Man) the curvature error is O(d^2/R) ~ 3 ft worst
 * case, and the series constants are good to <0.1% — both far below street
 * width (30-40 ft) and phone GPS accuracy (~15-50 ft). Do not use this for
 * anything bigger than a city.
 */

import {
  DETOUR_FACTOR,
  FT_PER_MIN,
  parsePlayaAddressParts,
  type PolarFt,
} from '../rightnow/playaWalk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrcRing {
  /** Lowercase layout ref: 'esplanade', 'a'..'k'. */
  ref: string;
  /** Yearly street name ('Atwood', ...). Display flavor only. */
  name: string;
  /** Feet from the Man to the street centerline. */
  distanceFt: number;
  /** Clock spans the street exists on, e.g. [["2:00","5:45"],["6:14","10:00"]]. */
  segments: [string, string][];
}

/** Shape of assets/city-geo/geometry.json (tools/build_city_geo.py). */
export interface BrcGeometry {
  year: number;
  /** Present on dev-fixture builds ("2025 DEV FIXTURE — ..."). */
  fixture?: string;
  center: { lat: number; lon: number };
  /** True bearing of the city's 12:00 axis, degrees. */
  bearingDeg: number;
  /** Magnetic -> true correction at BRC, degrees east positive. */
  declinationDeg: number;
  fenceDistanceFt: number;
  centerCamp: { clock: string; distanceFt: number; plazaRadiusFt: number; cafeRadiusFt: number };
  rings: BrcRing[];
  radials: string[];
  /** [lon, lat] per toilet bank (GeoJSON axis order). */
  toilets: [number, number][];
}

/** Anywhere the compass can point. Pure GPS — no geometry required. */
export interface WaypointTarget {
  label: string;
  lat: number;
  lon: number;
}

export interface GpsVector {
  distanceFt: number;
  /** True bearing from -> to, degrees [0, 360). */
  bearingDeg: number;
}

export interface BrcAddress {
  /** "7:32" — minutes-granular clock position. Noisy within the Man plaza. */
  clock: string;
  /** Degrees clockwise from the 12:00 axis, [0, 360). */
  clockDeg: number;
  /**
   * 'A'..'K' | 'esplanade' | 'center camp' | 'the man' | 'open playa' |
   * 'outside fence'. Nearest ring by radial distance (between B and C ->
   * the nearer one); 'open playa' covers inside-the-Esplanade, behind the
   * last ring, and clock sectors where the nearest ring's street does not
   * exist (the 10:00-2:00 arc, and the Esplanade's 5:45-6:14 Center Camp
   * keyhole gap).
   */
  ring: string;
  /** Human form matching playaWalk's conventions: "7:32 & C", "Center Camp". */
  address: string;
  /** Feet from the Man. */
  distanceFt: number;
  /** True bearing from the Man to the point, degrees. */
  bearingDeg: number;
}

export interface ToiletHit {
  lat: number;
  lon: number;
  distanceFt: number;
  walkMin: number;
  /** Clock-relative phrase, e.g. "toward 9:15". */
  direction: string;
}

export interface WaypointReading {
  label: string;
  distanceFt: number;
  walkMin: number;
  /** True bearing from the fix to the target — feed to arrowRotation(). */
  bearingDeg: number;
  /** Only when geometry is available: "toward 4:45". */
  clockDirection?: string;
  /** Only when geometry is available: the target's BRC address string. */
  targetAddress?: string;
}

// ---------------------------------------------------------------------------
// Projection core (GPS-only — the safety floor)
// ---------------------------------------------------------------------------

const M_PER_FT = 0.3048;
const rad = (d: number): number => (d * Math.PI) / 180;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** Feet per degree of latitude at a latitude (meridian arc series). */
function ftPerDegLat(latDeg: number): number {
  const p = rad(latDeg);
  const m =
    111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
  return m / M_PER_FT;
}

/** Feet per degree of longitude at a latitude. */
function ftPerDegLon(latDeg: number): number {
  const p = rad(latDeg);
  const m = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  return m / M_PER_FT;
}

/**
 * Straight-line vector between two fixes: distance in feet + true bearing.
 * ZERO city geometry — this is the whiteout safety floor (see header).
 */
export function gpsVector(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): GpsVector {
  const dNorthFt = (toLat - fromLat) * ftPerDegLat(fromLat);
  const dEastFt = (toLon - fromLon) * ftPerDegLon(fromLat);
  return {
    distanceFt: Math.hypot(dNorthFt, dEastFt),
    bearingDeg: norm360((Math.atan2(dEastFt, dNorthFt) * 180) / Math.PI),
  };
}

/**
 * Screen rotation for a compass arrow: how far clockwise from the top of the
 * phone the target sits, given the device's own true heading. [0, 360).
 */
export function arrowRotation(bearingToTargetTrue: number, deviceHeadingTrue: number): number {
  return norm360(bearingToTargetTrue - deviceHeadingTrue);
}

/** "NE" / "SSW"-free 8-wind cardinal, the no-geometry direction fallback. */
export function cardinal8(bearingDeg: number): string {
  const winds = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return winds[Math.round(norm360(bearingDeg) / 45) % 8];
}

// ---------------------------------------------------------------------------
// Clock math (geometry-relative)
// ---------------------------------------------------------------------------

/** 1 clock minute = 0.5 degrees (12h dial = 360 deg). */
const DEG_PER_CLOCK_MIN = 0.5;

/** True bearing -> degrees clockwise from the city's 12:00 axis. */
export function clockDegOf(trueBearingDeg: number, geo: BrcGeometry): number {
  return norm360(trueBearingDeg - geo.bearingDeg);
}

/** Clock angle -> "7:32". Rounds to whole minutes; 720 wraps to 12:00. */
export function clockStringFromDeg(clockDeg: number): string {
  const totalMin = Math.round(norm360(clockDeg) / DEG_PER_CLOCK_MIN) % 720;
  const h = Math.floor(totalMin / 60);
  return `${h === 0 ? 12 : h}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** "7:32" -> degrees clockwise from 12:00, or null if malformed. */
export function clockDegFromString(clock: string): number | null {
  const m = clock.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return null;
  }
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min > 59) {
    return null;
  }
  return (((h % 12) * 60 + min) * DEG_PER_CLOCK_MIN) % 360;
}

/** Clock angle -> "toward 4:45" (nearest quarter hour — how burners point). */
export function directionPhrase(clockDeg: number): string {
  const quarter = (Math.round(norm360(clockDeg) / DEG_PER_CLOCK_MIN / 15) * 15) % 720;
  const h = Math.floor(quarter / 60);
  return `toward ${h === 0 ? 12 : h}:${String(quarter % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Position -> address
// ---------------------------------------------------------------------------

/** The Man Plaza radius (layout: diameter 400) — inside it you're "at the Man". */
const CENTER_RADIUS_FT = 200;

/**
 * Off-segment tolerance in clock minutes: a street's own width subtends
 * under 1 clock-min at ring radius, GPS noise ~1-2 more. Beyond 4 the point
 * is genuinely off the street grid.
 */
const SEGMENT_TOL_CLOCK_MIN = 4;

const clockMin = (clock: string): number => {
  const [h, m] = clock.split(':').map(Number);
  return (h % 12) * 60 + m;
};

/** Is a clock position (in minutes, 12:00 = 0 or 720) on one of a ring's spans? */
function onSegments(ring: BrcRing, pointClockMin: number): boolean {
  for (const [start, end] of ring.segments) {
    const s = clockMin(start) - SEGMENT_TOL_CLOCK_MIN;
    const e = clockMin(end) + SEGMENT_TOL_CLOCK_MIN;
    // Spans in the layout never cross 12:00 (the city lives 2:00-10:00),
    // but 12:00 itself arrives as pointClockMin 0 — test both aliases.
    if ((pointClockMin >= s && pointClockMin <= e) || (pointClockMin + 720 >= s && pointClockMin + 720 <= e)) {
      return true;
    }
  }
  return false;
}

/** Chord between two polar city positions, in feet. */
function polarChordFt(a: PolarFt, b: PolarFt): number {
  const ax = a.radiusFt * Math.sin(rad(a.angleDeg));
  const ay = a.radiusFt * Math.cos(rad(a.angleDeg));
  const bx = b.radiusFt * Math.sin(rad(b.angleDeg));
  const by = b.radiusFt * Math.cos(rad(b.angleDeg));
  return Math.hypot(ax - bx, ay - by);
}

const displayRing = (ring: BrcRing): string =>
  ring.ref === 'esplanade' ? 'Esplanade' : ring.ref.toUpperCase();

/** A GPS fix -> Black Rock City address. See BrcAddress for the semantics. */
export function latLonToBrc(lat: number, lon: number, geo: BrcGeometry): BrcAddress {
  const v = gpsVector(geo.center.lat, geo.center.lon, lat, lon);
  const clockDeg = clockDegOf(v.bearingDeg, geo);
  const clock = clockStringFromDeg(clockDeg);
  const base = {
    clock,
    clockDeg,
    distanceFt: v.distanceFt,
    bearingDeg: v.bearingDeg,
  };

  if (v.distanceFt <= CENTER_RADIUS_FT) {
    return { ...base, ring: 'the man', address: 'The Man' };
  }
  if (v.distanceFt > geo.fenceDistanceFt) {
    // The real fence is a pentagon; we use the layout's radius. Corner
    // wedges a few hundred feet past it will read "outside" slightly early
    // — the safe direction to be wrong in.
    return { ...base, ring: 'outside fence', address: `${clock}, outside the fence` };
  }

  // Center Camp keyhole: its plaza is carved out of the ring grid (that IS
  // the Esplanade's 5:45-6:14 gap), so it wins before any ring matching.
  const cc = geo.centerCamp;
  const ccPolar: PolarFt = { radiusFt: cc.distanceFt, angleDeg: clockDegFromString(cc.clock) ?? 180 };
  const here: PolarFt = { radiusFt: v.distanceFt, angleDeg: clockDeg };
  if (polarChordFt(here, ccPolar) <= cc.plazaRadiusFt) {
    return { ...base, ring: 'center camp', address: 'Center Camp' };
  }

  const rings = geo.rings; // sorted by distanceFt (build tool guarantees)
  const innerEdge = rings[0].distanceFt - (rings[1].distanceFt - rings[0].distanceFt) / 2;
  const last = rings[rings.length - 1];
  const outerEdge =
    last.distanceFt + (last.distanceFt - rings[rings.length - 2].distanceFt) / 2;
  if (v.distanceFt < innerEdge || v.distanceFt > outerEdge) {
    // Inside the Esplanade (art playa) or behind the last street: open playa.
    return { ...base, ring: 'open playa', address: `${clock}, open playa` };
  }

  let nearest = rings[0];
  for (const r of rings) {
    if (Math.abs(v.distanceFt - r.distanceFt) < Math.abs(v.distanceFt - nearest.distanceFt)) {
      nearest = r;
    }
  }
  const pointMin = Math.round(clockDeg / DEG_PER_CLOCK_MIN) % 720;
  if (!onSegments(nearest, pointMin)) {
    // Right radius, but no street there (12:00 promenade sector, keyhole gap).
    return { ...base, ring: 'open playa', address: `${clock}, open playa` };
  }
  return {
    ...base,
    ring: nearest.ref === 'esplanade' ? 'esplanade' : nearest.ref.toUpperCase(),
    address: `${clock} & ${displayRing(nearest)}`,
  };
}

// ---------------------------------------------------------------------------
// Address -> position (the inverse)
// ---------------------------------------------------------------------------

/** City polar -> [lat, lon] under the same local projection. */
export function polarToLatLon(polar: PolarFt, geo: BrcGeometry): [number, number] {
  const bearing = rad(geo.bearingDeg + polar.angleDeg);
  const dNorthFt = polar.radiusFt * Math.cos(bearing);
  const dEastFt = polar.radiusFt * Math.sin(bearing);
  return [
    geo.center.lat + dNorthFt / ftPerDegLat(geo.center.lat),
    geo.center.lon + dEastFt / ftPerDegLon(geo.center.lat),
  ];
}

/**
 * Typed inverse of latLonToBrc: clock string + ring (letter, 'esplanade',
 * or a raw radius in feet) -> [lat, lon]. Null when the clock is malformed
 * or the ring letter is not in this year's city.
 */
export function brcToLatLon(
  clock: string,
  ring: string | number,
  geo: BrcGeometry,
): [number, number] | null {
  const clockDeg = clockDegFromString(clock);
  if (clockDeg === null) {
    return null;
  }
  let radiusFt: number;
  if (typeof ring === 'number') {
    radiusFt = ring;
  } else {
    const r = geo.rings.find(x => x.ref === ring.toLowerCase());
    if (!r) {
      return null;
    }
    radiusFt = r.distanceFt;
  }
  return polarToLatLon({ radiusFt, angleDeg: clockDeg }, geo);
}

/**
 * Free-text pack address ("7:30 & G", "Center Camp") -> coordinates, using
 * THE parser (playaWalk) for recognition and this year's real radii where
 * the ring is known (falling back to the parser's approximate model for
 * rings beyond this year's city and for deep playa). Null when the string
 * is not a playa address — the caller renders no affordance then.
 */
export function addressToLatLon(
  address: string,
  geo: BrcGeometry,
): { lat: number; lon: number; label: string } | null {
  const parts = parsePlayaAddressParts(address);
  if (!parts) {
    return null;
  }
  let polar: PolarFt = parts.polar;
  if (parts.kind === 'center-camp') {
    polar = {
      radiusFt: geo.centerCamp.distanceFt,
      angleDeg: clockDegFromString(geo.centerCamp.clock) ?? 180,
    };
  } else if (parts.kind === 'esplanade' || parts.kind === 'temple') {
    const esp = geo.rings.find(r => r.ref === 'esplanade');
    if (esp) {
      polar = { radiusFt: esp.distanceFt, angleDeg: parts.clockDeg };
    }
  } else if (parts.kind === 'ring' && parts.ring) {
    const r = geo.rings.find(x => x.ref === parts.ring!.toLowerCase());
    if (r) {
      polar = { radiusFt: r.distanceFt, angleDeg: parts.clockDeg };
    }
  }
  const [lat, lon] = polarToLatLon(polar, geo);
  return { lat, lon, label: address.trim() };
}

// ---------------------------------------------------------------------------
// Waypoints, toilets, home
// ---------------------------------------------------------------------------

const walkMinFor = (distanceFt: number): number =>
  Math.round((distanceFt * DETOUR_FACTOR) / FT_PER_MIN);

/**
 * Vector to a waypoint. WORKS WITHOUT GEOMETRY (safety floor): pass no
 * `geo` and you still get distance, walk time, and a true bearing for the
 * arrow; `geo` adds the clock phrase + the target's city address.
 */
export function toWaypoint(
  pos: { lat: number; lon: number },
  target: WaypointTarget,
  geo?: BrcGeometry | null,
): WaypointReading {
  const v = gpsVector(pos.lat, pos.lon, target.lat, target.lon);
  const reading: WaypointReading = {
    label: target.label,
    distanceFt: v.distanceFt,
    walkMin: walkMinFor(v.distanceFt),
    bearingDeg: v.bearingDeg,
  };
  if (geo) {
    reading.clockDirection = directionPhrase(clockDegOf(v.bearingDeg, geo));
    reading.targetAddress = latLonToBrc(target.lat, target.lon, geo).address;
  }
  return reading;
}

/** Distance + city-clock direction between two fixes ("toward 4:30"). */
export function bearingBetween(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  geo: BrcGeometry,
): { distanceFt: number; bearingDeg: number; clockDirection: string } {
  const v = gpsVector(fromLat, fromLon, toLat, toLon);
  return {
    distanceFt: v.distanceFt,
    bearingDeg: v.bearingDeg,
    clockDirection: directionPhrase(clockDegOf(v.bearingDeg, geo)),
  };
}

/** The whiteout call: where is home from here. (Home = a saved pin; see
 * src/geo/waypoints.ts. GPS-only floor available via toWaypoint(pos, home).) */
export function getMeHome(
  pos: { lat: number; lon: number },
  geo: BrcGeometry,
  home: WaypointTarget,
): { distanceFt: number; walkMin: number; clockDirection: string; brcAddressOfHome: string } {
  const r = toWaypoint(pos, home, geo);
  return {
    distanceFt: r.distanceFt,
    walkMin: r.walkMin,
    clockDirection: r.clockDirection!,
    brcAddressOfHome: r.targetAddress!,
  };
}

/** The n nearest toilet banks, nearest first. */
export function nearestToilets(
  lat: number,
  lon: number,
  geo: BrcGeometry,
  n: number = 3,
): ToiletHit[] {
  const hits: ToiletHit[] = geo.toilets.map(([tLon, tLat]) => {
    const v = gpsVector(lat, lon, tLat, tLon);
    return {
      lat: tLat,
      lon: tLon,
      distanceFt: v.distanceFt,
      walkMin: walkMinFor(v.distanceFt),
      direction: directionPhrase(clockDegOf(v.bearingDeg, geo)),
    };
  });
  hits.sort((a, b) => a.distanceFt - b.distanceFt);
  return hits.slice(0, n);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** "850 ft" under a mile, "1.2 mi" past it. Rounded for glanceability. */
export function formatDistanceFt(distanceFt: number): string {
  if (distanceFt >= 5280) {
    return `${(distanceFt / 5280).toFixed(1)} mi`;
  }
  const ftRounded = Math.round(distanceFt / 10) * 10;
  // Manual thousands comma: Hermes Intl coverage varies by build.
  return `${String(ftRounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ft`;
}

/** One-line human position: "7:32 & C — 3,150 ft from the Man". */
export function formatBrc(b: BrcAddress): string {
  const suffix =
    b.ring === 'the man' ? '' : ` — ${formatDistanceFt(b.distanceFt)} from the Man`;
  return `${b.address}${suffix}`;
}
