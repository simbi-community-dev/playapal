/**
 * Map tap inversion (v0.6.1 map slice, owner ask 2026-08-20): a tap on the
 * rendered city must resolve to the ground it points at — proven by a
 * round trip against the REAL bundled 2026 geometry: forward-project a
 * known address into map pixels, invert with mapTapToTarget, and land on
 * the same address. Beyond the fence resolves to nothing.
 */

import {
  FINE_PLACE_LIFT_PX,
  FINE_PLACE_MS,
  HIT_SLOP_PX,
  TAP_MAX_MS,
  dragEventToTarget,
  mapTapToTarget,
  resolveMapTap,
  type MapFeature,
  type MapFeaturePoint,
} from '../src/screens/CityMap';
import {
  addressToLatLon,
  latLonToBrc,
  type BrcGeometry,
} from '../src/geo/brcGeo';

const geo = require('../assets/city-geo/geometry.json') as BrcGeometry;

/** The map's forward projection, first half: lat/lon -> city feet. */
const cityFt = (lat: number, lon: number): { x: number; y: number } => {
  const addr = latLonToBrc(lat, lon, geo);
  const rad = (addr.clockDeg * Math.PI) / 180;
  return {
    x: addr.distanceFt * Math.sin(rad),
    y: -addr.distanceFt * Math.cos(rad),
  };
};

/** The map's forward projection: lat/lon -> px on a square of side px. */
const project = (lat: number, lon: number, sidePx: number): { x: number; y: number } => {
  const outerFt = geo.rings[geo.rings.length - 1]?.distanceFt ?? 5755;
  const half = outerFt + 900;
  const ft = cityFt(lat, lon);
  return {
    x: ((ft.x + half) / (2 * half)) * sidePx,
    y: ((ft.y + half) / (2 * half)) * sidePx,
  };
};

/** A drawn feature, placed at a real address of this year's city. */
const featureAt = (address: string, feature: MapFeature): MapFeaturePoint => {
  const at = addressToLatLon(address, geo);
  if (!at) {
    throw new Error(`no such address: ${address}`);
  }
  return { ...cityFt(at.lat, at.lon), feature };
};

const pinAt = (address: string, id: string, label: string): MapFeaturePoint =>
  featureAt(address, { kind: 'pin', id, label });

const pxAt = (address: string, sidePx: number): { x: number; y: number } => {
  const at = addressToLatLon(address, geo);
  if (!at) {
    throw new Error(`no such address: ${address}`);
  }
  return project(at.lat, at.lon, sidePx);
};

describe('mapTapToTarget round trip on the real 2026 city', () => {
  const SIDE = 360;

  test.each([['6:00 & esplanade'], ['3:00 & C'], ['9:00 & F'], ['7:30 & A']])(
    'tapping the projection of %s resolves back to it',
    address => {
      const at = addressToLatLon(address, geo);
      expect(at).toBeTruthy();
      const px = project(at!.lat, at!.lon, SIDE);
      const hit = mapTapToTarget(px.x, px.y, SIDE, geo);
      expect(hit).toBeTruthy();
      const back = latLonToBrc(hit!.lat, hit!.lon, geo);
      const orig = latLonToBrc(at!.lat, at!.lon, geo);
      // within one clock-minute and the same ring: a 360px map quantizes
      expect(back.ring).toBe(orig.ring);
      const minutes = (c: string): number => {
        const [h, m] = c.split(':').map(Number);
        return ((h % 12) * 60 + m) % 720;
      };
      const diff = Math.abs(minutes(back.clock) - minutes(orig.clock));
      expect(Math.min(diff, 720 - diff)).toBeLessThanOrEqual(2);
    },
  );

  test('a tap beyond the trash fence resolves to nothing', () => {
    expect(mapTapToTarget(1, 1, 360, geo)).toBeNull(); // far corner
  });

  test('the label speaks the address', () => {
    const at = addressToLatLon('3:00 & C', geo)!;
    const px = project(at.lat, at.lon, 360);
    const hit = mapTapToTarget(px.x, px.y, 360, geo)!;
    expect(hit.label).toMatch(/^Map spot — \d{1,2}:\d{2} & /);
  });
});

describe('dragEventToTarget — fine placement rides above the finger', () => {
  const SIDE = 360;

  test('at scale 1 a drag equals a tap lifted by the full offset', () => {
    const at = addressToLatLon('3:00 & C', geo)!;
    const px = project(at.lat, at.lon, SIDE);
    const viaDrag = dragEventToTarget(px.x, px.y + FINE_PLACE_LIFT_PX, 1, SIDE, geo);
    const viaTap = mapTapToTarget(px.x, px.y, SIDE, geo);
    expect(viaDrag).toEqual(viaTap);
  });

  test('the lift shrinks with zoom: at scale 4 it is a quarter', () => {
    const at = addressToLatLon('9:00 & F', geo)!;
    const px = project(at.lat, at.lon, SIDE);
    const viaDrag = dragEventToTarget(px.x, px.y + FINE_PLACE_LIFT_PX / 4, 4, SIDE, geo);
    const viaTap = mapTapToTarget(px.x, px.y, SIDE, geo);
    expect(viaDrag).toEqual(viaTap);
  });

  test('a drag whose lifted point leaves the fence resolves to nothing', () => {
    // (1, 41) lifts to the frame's far upper-left, past the trash fence
    expect(dragEventToTarget(1, 41, 1, SIDE, geo)).toBeNull();
  });
});

describe('resolveMapTap — an existing feature outranks bare ground', () => {
  // Owner field test 2026-08-20: "pins you've created can't be selected on
  // the map itself, only by the button below. this leads to confusing
  // double-pin creation potential." Every tap minted a fresh "Map spot"
  // even when the finger landed square on a pin already drawn there.
  const SIDE = 360;

  test('a tap ON a saved pin selects that pin, not a new map spot', () => {
    const px = pxAt('3:00 & C', SIDE);
    const r = resolveMapTap(px.x, px.y, 1, SIDE, geo, [pinAt('3:00 & C', 'p1', 'My bike')]);
    expect(r?.kind).toBe('feature');
    expect(r!.kind === 'feature' ? r!.feature : null).toEqual({
      kind: 'pin',
      id: 'p1',
      label: 'My bike',
    });
    // and it speaks the pin's own name — no competing "Map spot" label
    expect(r!.target.label).toBe('My bike');
    expect(r!.target.label).not.toMatch(/^Map spot/);
  });

  test('a tap on empty ground still yields a map spot', () => {
    const px = pxAt('9:00 & F', SIDE);
    const r = resolveMapTap(px.x, px.y, 1, SIDE, geo, [pinAt('3:00 & C', 'p1', 'My bike')]);
    expect(r?.kind).toBe('spot');
    expect(r!.target.label).toMatch(/^Map spot — \d{1,2}:\d{2} & /);
  });

  test('with no features at all the old behavior is exactly preserved', () => {
    const px = pxAt('7:30 & A', SIDE);
    const r = resolveMapTap(px.x, px.y, 1, SIDE, geo, []);
    expect(r).toEqual({ kind: 'spot', target: mapTapToTarget(px.x, px.y, SIDE, geo) });
  });

  test('a tap beyond the fence with features in the list is still nothing', () => {
    const r = resolveMapTap(1, 1, 1, SIDE, geo, [pinAt('3:00 & C', 'p1', 'My bike')]);
    expect(r).toBeNull();
  });

  test.each([
    ['3:00 & C', 'near'],
    ['3:00 & D', 'far'],
  ])('the NEAREST of two pins inside one fingertip wins: %s', (address, expected) => {
    // C and D are one block apart — both well inside a fingertip at scale
    // 1, so "first in the list" and "nearest" disagree. Run BOTH orders:
    // a first-match hit test passes one and fails the other.
    const pins = [pinAt('3:00 & C', 'near', 'Bike'), pinAt('3:00 & D', 'far', 'Tent')];
    const px = pxAt(address, SIDE);
    for (const order of [pins, [...pins].reverse()]) {
      const r = resolveMapTap(px.x, px.y, 1, SIDE, geo, order);
      expect(r?.kind).toBe('feature');
      expect(r!.kind === 'feature' && r!.feature.kind === 'pin' ? r!.feature.id : null).toBe(
        expected,
      );
    }
  });

  test('the fingertip is SCREEN-sized: the same offset hits at 1x and misses at 4x', () => {
    // HIT_SLOP_PX is screen px, so in this LOCAL, pre-transform space it is
    // HIT_SLOP_PX/scale. 20px off the pin sits inside 44 and outside 11.
    // A city-feet constant (no /scale) would hit in both — the whole point.
    const pins = [pinAt('3:00 & C', 'p1', 'My bike')];
    const px = pxAt('3:00 & C', SIDE);
    const off = { x: px.x + 20, y: px.y };
    expect(20).toBeLessThan(HIT_SLOP_PX);
    expect(20).toBeGreaterThan(HIT_SLOP_PX / 4);
    expect(resolveMapTap(off.x, off.y, 1, SIDE, geo, pins)?.kind).toBe('feature');
    expect(resolveMapTap(off.x, off.y, 4, SIDE, geo, pins)?.kind).toBe('spot');
  });

  test('zoomed to 4x a pin is still hittable from a few px away', () => {
    // The other direction: shrinking must not make pins un-tappable when
    // zoomed in, which is exactly when you are aiming at a crowded block.
    const pins = [pinAt('3:00 & C', 'p1', 'My bike')];
    const px = pxAt('3:00 & C', SIDE);
    expect(resolveMapTap(px.x + 5, px.y, 4, SIDE, geo, pins)?.kind).toBe('feature');
  });

  test('friends and landmarks come back tagged, with their own names', () => {
    const friend = featureAt('4:15 & E', { kind: 'friend', key: 'g1', label: 'Ada, Bo' });
    const px = pxAt('4:15 & E', SIDE);
    const r = resolveMapTap(px.x, px.y, 4, SIDE, geo, [friend]);
    expect(r?.kind).toBe('feature');
    expect(r!.kind === 'feature' ? r!.feature.kind : null).toBe('friend');
    expect(r!.target.label).toBe('Ada, Bo');
    // the target still lands on real ground: a lat/lon the compass can aim at
    const back = latLonToBrc(r!.target.lat, r!.target.lon, geo);
    expect(back.ring.toLowerCase()).toBe('e');
  });
});

describe('tap handler binds raw local coords (double-inversion regression)', () => {
  // The gesture orchestrator already inverse-transforms events through the
  // view matrix on delivery, so the Tap/Pan callbacks must consume e.x/e.y
  // untouched. Re-applying the view transform is the bug the owner felt in
  // the field (2026-08-20): identity at scale 1, centimeters off zoomed.
  const src = require('fs').readFileSync('src/screens/CityMap.tsx', 'utf8');
  const { parse } = require('@babel/parser');
  const ast = parse(src, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  const collectCalls = (): Map<string, string> => {
    // gesture-name -> source of every callback chained onto it
    const found = new Map<string, string>();
    const walk = (node: any, cb: (n: any) => void): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (node.type) {
        cb(node);
      }
      for (const k of Object.keys(node)) {
        const v = (node as any)[k];
        if (Array.isArray(v)) {
          v.forEach(c => walk(c, cb));
        } else if (v && typeof v === 'object') {
          walk(v, cb);
        }
      }
    };
    walk(ast, n => {
      if (
        n.type === 'VariableDeclarator' &&
        n.id?.type === 'Identifier' &&
        ['tap', 'finePlace'].includes(n.id.name) &&
        n.init
      ) {
        found.set(n.id.name, src.slice(n.init.start, n.init.end));
      }
    });
    return found;
  };

  const chains = collectCalls();

  test.each([['tap'], ['finePlace']])(
    '%s never re-applies the view transform',
    name => {
      const body = chains.get(name);
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/view\.tx|view\.ty/);
      expect(body).toMatch(name === 'tap' ? /e\.x,\s*e\.y/ : /e\.x,\s*e\.y,/);
    },
  );

  test('finePlace outranks pan in an Exclusive pair', () => {
    expect(src).toMatch(/Gesture\.Exclusive\(finePlace,\s*pan\)/);
  });
});

describe('no undeclared-permission native API reaches the map (P7 crash regression)', () => {
  // A long-press haptic shipped a Vibration.vibrate() call while the
  // manifest declared no VIBRATE permission: the gesture fired, Android
  // threw SecurityException on the native thread, and the app died to the
  // launcher every single time (owner field test 2026-08-20). Unit tests
  // cannot see this — the JS call is well-formed; only the device knows.
  // So the guard is static: any RN API that requires a manifest permission
  // must have that permission declared, or not be imported at all.
  const fs = require('fs');
  const manifest = fs.readFileSync(
    'android/app/src/main/AndroidManifest.xml',
    'utf8',
  );
  const PERMISSION_APIS: Array<{ api: string; permission: string }> = [
    { api: 'Vibration', permission: 'android.permission.VIBRATE' },
  ];
  // WALK ALL OF src/, not just src/screens. The P7 field crash (Vibration
  // without the manifest permission -> SecurityException -> the app dies to
  // the launcher on long-press) can be re-shipped from ANY module, and a
  // guard that only reads one directory is an invitation to add it in
  // src/components or src/crews and stay green.
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        return walk(full);
      }
      return e.name.endsWith('.tsx') || e.name.endsWith('.ts') ? [full] : [];
    });
  const screens = walk('src');

  test.each(PERMISSION_APIS)(
    '$api is only imported when $permission is declared',
    ({ api, permission }: { api: string; permission: string }) => {
      const declared = manifest.includes(permission);
      // POSITIVE CONTROL: a walker that found nothing would pass every arm
      // below without reading a line of source.
      expect(screens.length).toBeGreaterThan(20);
      // REQUIRE THE IMPORT, NOT JUST THE NAME. Widening the walk to all of
      // src/ made a bare name-match wrong: a COMMENT documenting the P7 crash
      // ("it came from Vibration.vibrate(30) without the permission") tripped
      // the guard, so the test punished the next person for writing down why
      // the test exists. Measured — a planted comment failed this arm before
      // this line existed.
      // You cannot call the API without importing it, so the import is the
      // discriminating signal and prose is not.
      const imports = (src: string): boolean =>
        new RegExp(`import\\s*\\{[^}]*\\b${api}\\b[^}]*\\}\\s*from\\s*'react-native'`, 's').test(src);
      const users = screens.filter((f: string) => {
        const src = fs.readFileSync(f, 'utf8');
        return imports(src) && new RegExp(`\\b${api}\\.[a-zA-Z]`).test(src);
      });
      if (!declared) {
        expect(users).toEqual([]);
      }
    },
  );
});

describe('no gesture dead zone between tap and fine-place', () => {
  // A press released after TAP_MAX_MS but before FINE_PLACE_MS fires NEITHER
  // gesture — the map silently ignores the touch. Shipped as a 130ms hole
  // (tap 220 / long-press 350); dusty gloves and cold hands make slow taps
  // the common case on playa, so a slow tap must still aim the compass.
  test('a tap stays live right up to the long-press threshold', () => {
    expect(FINE_PLACE_MS - TAP_MAX_MS).toBeLessThanOrEqual(10);
    expect(TAP_MAX_MS).toBeLessThan(FINE_PLACE_MS);
  });

  test('the gesture chain binds the constants, not literals', () => {
    const src = require('fs').readFileSync('src/screens/CityMap.tsx', 'utf8');
    expect(src).toMatch(/\.maxDuration\(TAP_MAX_MS\)/);
    expect(src).toMatch(/\.activateAfterLongPress\(FINE_PLACE_MS\)/);
  });
});

describe('the memoized SVG layer survives a stationary GPS tick', () => {
  // watchPosition emits a NEW GeoFix object every 5s even when you have not
  // moved. An object-identity dep on herePt invalidated the whole memoized
  // SVG layer, rebuilding ~200 elements every 5s while standing still — the
  // owner's "flickers when zoomed", second source (xrev 2026-08-20, ds4pro).
  const src = require('fs').readFileSync('src/screens/CityMap.tsx', 'utf8');

  test('herePt is keyed on coordinate primitives, not the fix object', () => {
    expect(src).toMatch(/\}, \[hereLat, hereLon, geo, fence\]\)/);
    expect(src).not.toMatch(/\}, \[position, geo, fence\]\)/);
  });

  test('the svg layer memo does not take the position object as a dep', () => {
    // POSITIVE CONTROLS FIRST. `indexOf` returns -1 on a miss and `slice(-1)`
    // yields ONE character, so a rename of `svgLayer` collapses `deps` to ''
    // and `not.toMatch` passes about nothing — permanently, silently.
    // The mutation that would then ship: rename the memo AND put `position`
    // back in its deps, so ~200 SVG elements rebuild every 5 s off
    // watchPosition while the camper stands still. That is the "flickers when
    // zoomed" report plus battery burn, on the one device nobody can recharge.
    const at = src.indexOf('const svgLayer = useMemo(');
    expect(at).toBeGreaterThanOrEqual(0);
    const memo = src.slice(at);
    const from = memo.indexOf('\n    [\n');
    const to = memo.indexOf('\n  );');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const deps = memo.slice(from, to);
    // And the slice must actually contain the dep list we think it does.
    expect(deps).toMatch(/geo,/);
    expect(deps).not.toMatch(/^\s*position,$/m);
  });
});
