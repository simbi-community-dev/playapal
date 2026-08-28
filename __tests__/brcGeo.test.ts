/**
 * brcGeo golden tests against the REAL 2026 geometry build.
 *
 * Every input coordinate below was derived BY HAND, outside the code under
 * test: spherical earth R = 6,371,000 m, city center (40.783242,
 * -119.207871 — the published 2026 golden spike), 12:00 axis at true
 * bearing 45°. A point D feet from the Man at clock angle θ (degrees
 * clockwise from 12:00) sits at true bearing (45 + θ) and offsets
 *
 *   dLat = D·0.3048·cos(45+θ) / (π·R/180)
 *   dLon = D·0.3048·sin(45+θ) / (π·R·cos(lat₀)/180)
 *
 * The code uses slightly better per-latitude series constants (~0.1% apart
 * from the spherical derivation), so distance assertions carry a ±15 ft
 * tolerance; clock/ring/address assertions are exact.
 */

import {
  addressToLatLon,
  arrowRotation,
  bearingBetween,
  brcToLatLon,
  cardinal8,
  clockStringFromDeg,
  directionPhrase,
  formatBrc,
  formatDistanceFt,
  getMeHome,
  gpsVector,
  latLonToBrc,
  nearestToilets,
  toWaypoint,
  type BrcGeometry,
} from '../src/geo/brcGeo';

const geo = require('../assets/city-geo/geometry.json') as BrcGeometry;

// Hand-derived inputs (formula above): [lat, lon] = D feet at clock angle θ.
const MAN: [number, number] = [40.783242, -119.207871];
const P_3_00_A: [number, number] = [40.7775532, -119.2003579]; // 2935 ft @ 90°
const P_CENTER_CAMP: [number, number] = [40.7774291, -119.215548]; // 2999 ft @ 180°
const P_OUTSIDE: [number, number] = [40.8006865, -119.2309095]; // 9000 ft @ 270°
const P_INNER_PLAYA: [number, number] = [40.7855679, -119.2047992]; // 1200 ft @ 0°
const P_4_30_C: [number, number] = [40.7739222, -119.207871]; // 3400 ft @ 135°
const P_4_30_B: [number, number] = [40.7741963, -119.207871]; // 3300 ft @ 135°
const P_ESPL_GAP: [number, number] = [40.7783963, -119.2142706]; // 2500 ft @ 180°
const P_7_32_B: [number, number] = [40.7833927, -119.2192728]; // 3150 ft @ 226°
const P_9_00_C: [number, number] = [40.790026, -119.2168304]; // 3500 ft @ 270°
const HOME_6_00_E: [number, number] = [40.7753726, -119.2182639]; // 4060 ft @ 180°

describe('geometry build', () => {
  test('is the real 2026 city (no fixture marker), full city shape', () => {
    expect(geo.year).toBe(2026);
    expect(geo.fixture).toBeUndefined();
    expect(geo.bearingDeg).toBe(45);
    expect(geo.rings[0].ref).toBe('esplanade');
    expect(geo.rings).toHaveLength(12); // Esplanade + A..K
    expect(geo.toilets).toHaveLength(45);
    expect(geo.radials).toContain('12:00');
  });
});

describe('latLonToBrc golden cases', () => {
  test("the Man's own coordinates read as the center", () => {
    const b = latLonToBrc(MAN[0], MAN[1], geo);
    expect(b.ring).toBe('the man');
    expect(b.address).toBe('The Man');
    expect(b.distanceFt).toBeLessThan(1);
  });

  test('2,935 ft on the 3:00 axis is 3:00 & A', () => {
    const b = latLonToBrc(P_3_00_A[0], P_3_00_A[1], geo);
    expect(b.address).toBe('3:00 & A');
    expect(b.ring).toBe('A');
    expect(b.clock).toBe('3:00');
    expect(Math.abs(b.distanceFt - 2935)).toBeLessThan(15);
  });

  test('Center Camp coordinates sit in the 6:00 direction and read Center Camp', () => {
    const b = latLonToBrc(P_CENTER_CAMP[0], P_CENTER_CAMP[1], geo);
    expect(b.clock).toBe('6:00');
    expect(b.ring).toBe('center camp');
    expect(b.address).toBe('Center Camp');
  });

  test('9,000 ft out is outside the fence', () => {
    const b = latLonToBrc(P_OUTSIDE[0], P_OUTSIDE[1], geo);
    expect(b.ring).toBe('outside fence');
    expect(b.clock).toBe('9:00');
  });

  test('inside the Esplanade is open playa (art playa)', () => {
    const b = latLonToBrc(P_INNER_PLAYA[0], P_INNER_PLAYA[1], geo);
    expect(b.ring).toBe('open playa');
    expect(b.clock).toBe('12:00');
  });

  test('between B and C resolves to the NEARER ring, both sides', () => {
    expect(latLonToBrc(P_4_30_C[0], P_4_30_C[1], geo).address).toBe('4:30 & C');
    expect(latLonToBrc(P_4_30_B[0], P_4_30_B[1], geo).address).toBe('4:30 & B');
  });

  test("the Esplanade's 5:35–6:25 Center Camp keyhole gap is open playa", () => {
    // 2,500 ft at 6:00: Esplanade radius, but the street does not exist
    // there (segments end 5:35 / resume 6:25) and the point is 499 ft from
    // Center Camp's center — outside its 260 ft plaza.
    const b = latLonToBrc(P_ESPL_GAP[0], P_ESPL_GAP[1], geo);
    expect(b.ring).toBe('open playa');
    expect(b.clock).toBe('6:00');
  });

  test('clock is minutes-granular: 3,150 ft at 226° reads 7:32 & B', () => {
    const b = latLonToBrc(P_7_32_B[0], P_7_32_B[1], geo);
    expect(b.address).toBe('7:32 & B');
  });
});

describe('clock helpers', () => {
  test('clockStringFromDeg', () => {
    expect(clockStringFromDeg(0)).toBe('12:00');
    expect(clockStringFromDeg(90)).toBe('3:00');
    expect(clockStringFromDeg(226)).toBe('7:32');
    expect(clockStringFromDeg(359.8)).toBe('12:00'); // wraps, never 12:60
  });

  test('directionPhrase rounds to the quarter hour', () => {
    expect(directionPhrase(139.25)).toBe('toward 4:45');
    expect(directionPhrase(0)).toBe('toward 12:00');
    expect(directionPhrase(355)).toBe('toward 11:45');
    expect(directionPhrase(358)).toBe('toward 12:00'); // wraps
  });

  test('cardinal8 fallback', () => {
    expect(cardinal8(0)).toBe('N');
    expect(cardinal8(44)).toBe('NE');
    expect(cardinal8(350)).toBe('N');
  });
});

describe('inverse transforms', () => {
  test('brcToLatLon round-trips through latLonToBrc', () => {
    const p = brcToLatLon('7:45', 'g', geo)!;
    const back = latLonToBrc(p[0], p[1], geo);
    expect(back.address).toBe('7:45 & G');
    const gRing = geo.rings.find(r => r.ref === 'g')!;
    expect(Math.abs(back.distanceFt - gRing.distanceFt)).toBeLessThan(2);
  });

  test('brcToLatLon accepts a raw radius', () => {
    const p = brcToLatLon('4:15', 3000, geo)!;
    const back = latLonToBrc(p[0], p[1], geo);
    expect(back.clock).toBe('4:15');
    expect(Math.abs(back.distanceFt - 3000)).toBeLessThan(2);
  });

  test('brcToLatLon rejects bad clock or unknown ring', () => {
    expect(brcToLatLon('13:00', 'a', geo)).toBeNull();
    expect(brcToLatLon('7:45', 'z', geo)).toBeNull();
  });

  test('addressToLatLon resolves pack address strings via THE parser', () => {
    const g = addressToLatLon('7:30 & G', geo)!;
    expect(latLonToBrc(g.lat, g.lon, geo).address).toBe('7:30 & G');
    const cc = addressToLatLon('Center Camp', geo)!;
    expect(latLonToBrc(cc.lat, cc.lon, geo).address).toBe('Center Camp');
    expect(addressToLatLon('somewhere dusty', geo)).toBeNull();
  });
});

describe('waypoints and get-me-home', () => {
  // From 9:00 & C (3,500 ft @ 270°) home to 6:00 & E (4,060 ft @ 180°):
  // chord in city frame = hypot(3500, 4060) = 5,360 ft; direction
  // atan2(3500, -4060) = 139.24° from 12:00 → quarter-rounds to 4:45;
  // walk = 5360·1.25/264 ≈ 25 min.
  test('getMeHome from 9:00 & C to a home at 6:00 & E', () => {
    const home = { label: 'Home', lat: HOME_6_00_E[0], lon: HOME_6_00_E[1] };
    const r = getMeHome({ lat: P_9_00_C[0], lon: P_9_00_C[1] }, geo, home);
    expect(Math.abs(r.distanceFt - 5360)).toBeLessThan(20);
    expect(r.walkMin).toBe(39);
    expect(r.clockDirection).toBe('toward 4:45');
    expect(r.brcAddressOfHome).toBe('6:00 & E');
  });

  test('bearingBetween matches the same vector', () => {
    const r = bearingBetween(P_9_00_C[0], P_9_00_C[1], HOME_6_00_E[0], HOME_6_00_E[1], geo);
    expect(Math.abs(r.distanceFt - 5360)).toBeLessThan(20);
    expect(r.clockDirection).toBe('toward 4:45');
  });

  test('SAFETY FLOOR: toWaypoint works with zero geometry', () => {
    const r = toWaypoint(
      { lat: P_9_00_C[0], lon: P_9_00_C[1] },
      { label: 'Home', lat: HOME_6_00_E[0], lon: HOME_6_00_E[1] },
      null,
    );
    expect(Math.abs(r.distanceFt - 5360)).toBeLessThan(20);
    expect(r.walkMin).toBe(39);
    expect(r.bearingDeg).toBeGreaterThan(180);
    expect(r.bearingDeg).toBeLessThan(190); // ≈184.2° true
    expect(r.clockDirection).toBeUndefined();
    expect(r.targetAddress).toBeUndefined();
  });

  test('gpsVector is pure GPS math', () => {
    const v = gpsVector(P_9_00_C[0], P_9_00_C[1], HOME_6_00_E[0], HOME_6_00_E[1]);
    expect(Math.abs(v.distanceFt - 5360)).toBeLessThan(20);
    expect(Math.abs(v.bearingDeg - 184.2)).toBeLessThan(1);
  });
});

describe('arrowRotation wraparound', () => {
  test('wraps cleanly across north', () => {
    expect(arrowRotation(10, 350)).toBe(20);
    expect(arrowRotation(350, 10)).toBe(340);
    expect(arrowRotation(90, 90)).toBe(0);
    expect(arrowRotation(0, 359.5)).toBeCloseTo(0.5);
  });
});

describe('nearestToilets', () => {
  // Independent derivation from the build's own bank list (spherical
  // constants): nearest three to the Man are ~560, ~1388, ~1396 ft.
  test('from the Man: three banks, sane distances, sorted ascending', () => {
    const hits = nearestToilets(MAN[0], MAN[1], geo);
    expect(hits).toHaveLength(3);
    expect(Math.abs(hits[0].distanceFt - 560)).toBeLessThan(15);
    expect(Math.abs(hits[1].distanceFt - 1388)).toBeLessThan(15);
    expect(Math.abs(hits[2].distanceFt - 1396)).toBeLessThan(15);
    expect(hits[0].distanceFt).toBeLessThanOrEqual(hits[1].distanceFt);
    expect(hits[1].distanceFt).toBeLessThanOrEqual(hits[2].distanceFt);
    // Nearest bank bears ~90° true = clock 45° → 1:30; walk 560·1.25/171 ≈ 4.
    expect(hits[0].direction).toBe('toward 1:30');
    expect(hits[0].walkMin).toBe(4);
  });

  test('n parameter widens the list', () => {
    expect(nearestToilets(MAN[0], MAN[1], geo, 5)).toHaveLength(5);
  });
});

describe('formatting', () => {
  test('formatDistanceFt', () => {
    expect(formatDistanceFt(551)).toBe('550 ft');
    expect(formatDistanceFt(4995)).toBe('5,000 ft');
    expect(formatDistanceFt(5353)).toBe('1.0 mi');
  });

  test('formatBrc', () => {
    // 9:00 & C sits at 3,500 ft: mid-decade, so the 10-ft rounding is
    // stable against the ~0.1% spherical-vs-series derivation gap.
    const b = latLonToBrc(P_9_00_C[0], P_9_00_C[1], geo);
    expect(formatBrc(b)).toBe('9:00 & C — 3,500 ft from the Man');
    expect(formatBrc(latLonToBrc(MAN[0], MAN[1], geo))).toBe('The Man');
  });
});
