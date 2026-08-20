/**
 * playaWalkMinutes — walk-time annotation between playa addresses, ported in
 * concept from iBurn's `playaWalkMinutes` (iBurn-iOS, MPL-2.0; reimplemented
 * from the clock-grid geometry rather than GPS since packs carry address
 * strings, not coordinates).
 *
 * Black Rock City is a clock face centered on the Man: radial streets are
 * clock times (2:00-10:00), ring streets are letters (Esplanade, then A
 * outward). We approximate: address -> polar -> cartesian feet, straight-line
 * distance x 1.25 street-detour factor, at 264 ft/min (~3 mph).
 *
 * All APPROXIMATE (ring radii shift slightly year to year) — good enough for
 * "about 20 min by foot", never for navigation. Pure + unit-tested.
 *
 * This module owns THE playa-address parser (parsePlayaAddressParts is the
 * structured form; src/geo/brcGeo.ts composes it against the real yearly
 * geometry). The GPS lane reuses the pace constants exported here so a
 * "~12 min walk" means the same thing whether it came from an address pair
 * or a live fix.
 */

/** Approximate ring radii in feet from the Man. */
const ESPLANADE_FT = 2500;
const RING_A_FT = 2900;
const RING_STEP_FT = 250;
const DEEP_PLAYA_FT = 4200;
const TEMPLE_FT = 2500; // Temple sits at 12:00 on the Esplanade ring

export const DETOUR_FACTOR = 1.25;
export const FT_PER_MIN = 264; // ~3 mph in playa dust

export interface PolarFt {
  radiusFt: number;
  /** Degrees clockwise from 12:00. */
  angleDeg: number;
}

function clockToDegrees(clock: string): number | null {
  const m = clock.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return null;
  }
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min > 59) {
    return null;
  }
  return (((h % 12) + min / 60) / 12) * 360;
}

function ringRadius(letter: string): number {
  const idx = letter.toUpperCase().charCodeAt(0) - 65; // A=0
  return RING_A_FT + idx * RING_STEP_FT;
}

export type PlayaAddressKind =
  | 'man'
  | 'center-camp'
  | 'temple'
  | 'deep-playa'
  | 'esplanade'
  | 'ring';

/**
 * Structured parse of a playa address. `polar` uses the module's APPROXIMATE
 * ring model (fine for walk times); callers with the real yearly geometry
 * (src/geo/brcGeo.ts) resolve `ring`/`kind` against exact radii instead.
 */
export interface PlayaAddressParts {
  kind: PlayaAddressKind;
  /** Degrees clockwise from 12:00; landmark kinds carry their canonical angle. */
  clockDeg: number;
  /** Uppercase ring letter, only for kind 'ring'. */
  ring: string | null;
  /** Approximate polar position (the legacy walk-time model). */
  polar: PolarFt;
}

/**
 * Parse a playa address string. Handles:
 *   "7:30 & G", "G & 7:30", "6:00 & Esplanade", "Esplanade at 6:00",
 *   "Center Camp", "Temple", "The Man", "12:00 deep playa".
 * Returns null for anything unrecognized.
 */
export function parsePlayaAddressParts(address: string): PlayaAddressParts | null {
  const a = address.trim().toLowerCase();
  if (a.length === 0) {
    return null;
  }
  if (a.includes('center camp')) {
    return {
      kind: 'center-camp',
      clockDeg: 180,
      ring: null,
      polar: { radiusFt: RING_A_FT, angleDeg: 180 }, // 6:00 & A-ish
    };
  }
  if (a.includes('temple')) {
    return {
      kind: 'temple',
      clockDeg: 0,
      ring: null,
      polar: { radiusFt: TEMPLE_FT, angleDeg: 0 },
    };
  }
  if (a === 'the man' || a === 'man') {
    return { kind: 'man', clockDeg: 0, ring: null, polar: { radiusFt: 0, angleDeg: 0 } };
  }
  const clockMatch = a.match(/(\d{1,2}:\d{2})/);
  const angle = clockMatch ? clockToDegrees(clockMatch[1]) : null;
  if (angle === null) {
    return null;
  }
  if (a.includes('deep playa')) {
    return {
      kind: 'deep-playa',
      clockDeg: angle,
      ring: null,
      polar: { radiusFt: DEEP_PLAYA_FT, angleDeg: angle },
    };
  }
  if (a.includes('esplanade')) {
    return {
      kind: 'esplanade',
      clockDeg: angle,
      ring: null,
      polar: { radiusFt: ESPLANADE_FT, angleDeg: angle },
    };
  }
  const ringMatch = a.match(/(?:^|[\s&])([a-l])(?:$|[\s&])/);
  if (ringMatch) {
    return {
      kind: 'ring',
      clockDeg: angle,
      ring: ringMatch[1].toUpperCase(),
      polar: { radiusFt: ringRadius(ringMatch[1]), angleDeg: angle },
    };
  }
  return null;
}

/**
 * Parse a playa address string into polar coordinates (legacy shape).
 * Returns null for anything unrecognized (walk time is then omitted).
 */
export function parsePlayaAddress(address: string): PolarFt | null {
  return parsePlayaAddressParts(address)?.polar ?? null;
}

function toXY(p: PolarFt): { x: number; y: number } {
  const rad = (p.angleDeg * Math.PI) / 180;
  return { x: p.radiusFt * Math.sin(rad), y: p.radiusFt * Math.cos(rad) };
}

function walkMinutesBetween(a: PolarFt, b: PolarFt): number {
  const pa = toXY(a);
  const pb = toXY(b);
  const straight = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  return Math.round((straight * DETOUR_FACTOR) / FT_PER_MIN);
}

/**
 * Approximate walk time in whole minutes between two playa addresses, or
 * null when either address cannot be parsed.
 */
export function playaWalkMinutes(from: string, to: string): number | null {
  const a = parsePlayaAddress(from);
  const b = parsePlayaAddress(to);
  if (!a || !b) {
    return null;
  }
  return walkMinutesBetween(a, b);
}

/**
 * Walk time from an EXACT polar position (a live GPS fix mapped by
 * src/geo/brcGeo.ts) to a pack address string, or null when the address
 * cannot be parsed. Same pace model as playaWalkMinutes.
 */
export function playaWalkMinutesFromPolar(from: PolarFt, to: string): number | null {
  const b = parsePlayaAddress(to);
  if (!b) {
    return null;
  }
  return walkMinutesBetween(from, b);
}
