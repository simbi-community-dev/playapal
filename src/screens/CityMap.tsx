/**
 * CityMap — the offline map of Black Rock City (2026-08-19).
 *
 * Pure SVG drawn from the same measured geometry the compass and walk
 * times use (assets/city-geo, GIS-confirmed radii): street rings as arcs
 * between 2:00 and 10:00, the 34 radials, Center Camp, the Man, the
 * Temple, the trash fence, every mapped toilet bank — plus the living
 * layer: you, your pins, the active waypoint, and your friends' camps.
 * No tiles, no network, a few kilobytes of math.
 *
 * Coordinates: city feet, the Man at the origin, 12:00 straight up.
 * P(clockDeg, r) = (r·sin θ, −r·cos θ) — SVG's y axis points down.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import type { FriendCard } from '../friends/friendCard';
import {
  addressToLatLon,
  clockDegFromString,
  latLonToBrc,
  polarToLatLon,
  type BrcGeometry,
  type WaypointTarget,
} from '../geo/brcGeo';
import type { GeoFix } from '../geo/useLocation';
import type { SavedPin } from '../geo/waypoints';
import { useTextScale } from '../components/Text';
import { colors } from '../theme';

/**
 * HOW FAR THE SIZE DIAL REACHES INTO THE MAP — and where it deliberately
 * stops (a11y review 2026-08-26).
 *
 * "Every screen" is the promise src/components/Text.tsx makes, and these
 * labels were the one place it was not kept: the clock ring, the Man, the
 * Temple, your pins and your friends' camps are SVG text, so no wrapper
 * ever touched them and they stayed at their authored size while the whole
 * app around them grew.
 *
 * They cannot simply take the full 1.4×, though, and pretending otherwise
 * would be the worse bug. Every other label in the app lives in a layout
 * that reflows: give it more room and the row grows, the column wraps, the
 * screen scrolls. These are placed by GEOMETRY — a clock label sits at a
 * fixed radius outside K street, a friend chip hangs a fixed distance under
 * its dot — so growth has nowhere to go but into the neighbour. The twelve
 * clock labels are the tightest ring on the drawing, and past ~1.2× they
 * start touching each other and the ring they annotate; a map whose labels
 * overlap is less readable at Biggest than it was at Default, which is the
 * opposite of what the camper asked for by turning the dial up.
 *
 * So the dial reaches the map, bounded, and the ceiling is stated out loud
 * here rather than discovered in the dust. 1.2× is the "Bigger" rung: a
 * camper on Bigger gets exactly what they asked for, and Biggest gets the
 * most the geometry can carry. If the map ever gets collision-aware label
 * placement, this is the constant that gets to move.
 */
export const MAP_LABEL_SCALE_CEILING = 1.2;

/** The camper's rung as the map can honour it — see the ceiling above. */
export function mapLabelScale(scale: number): number {
  return Math.min(scale, MAP_LABEL_SCALE_CEILING);
}

const pt = (clockDeg: number, radiusFt: number): { x: number; y: number } => {
  const rad = (clockDeg * Math.PI) / 180;
  return { x: radiusFt * Math.sin(rad), y: -radiusFt * Math.cos(rad) };
};

/** One arc along a ring between two clock strings, sweeping clockwise. */
const segArc = (r: number, fromClock: string, toClock: string): string | null => {
  const a0 = clockDegFromString(fromClock);
  const a1 = clockDegFromString(toClock);
  if (a0 === null || a1 === null) {
    return null;
  }
  const a = pt(a0, r);
  const b = pt(a1, r);
  const sweep = (a1 - a0 + 360) % 360;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
};

/** Half-side of the map's square viewBox, in city feet: ±(outer street +
 * 900ft) centered on the Man. ONE definition — the render, the tap
 * inversion, and the feature hit test all read it, so a tap can never land
 * on a different projection than the one that drew the pin. */
export function mapHalfExtentFt(geo: BrcGeometry): number {
  return (geo.rings[geo.rings.length - 1]?.distanceFt ?? 5755) + 900;
}

/** Local view px -> city feet (the Man at the origin, +y south as in SVG). */
export function viewPxToCityFt(
  locationX: number,
  locationY: number,
  sidePx: number,
  geo: BrcGeometry,
): { x: number; y: number } {
  const half = mapHalfExtentFt(geo);
  return {
    x: (locationX / sidePx) * 2 * half - half,
    y: (locationY / sidePx) * 2 * half - half,
  };
}

/** City feet -> lat/lon, the inverse of the pt() the map draws with. */
function cityFtToLatLon(x: number, y: number, geo: BrcGeometry): { lat: number; lon: number } {
  const radiusFt = Math.hypot(x, y);
  const angleDeg = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  const [lat, lon] = polarToLatLon({ radiusFt, angleDeg }, geo);
  return { lat, lon };
}

/** Invert a tap on the rendered map to city ground. The map draws in a
 * square viewBox of ±(outer street + 900ft) centered on the Man, 12:00 up
 * — this undoes exactly that projection. Returns null beyond the fence. */
export function mapTapToTarget(
  locationX: number,
  locationY: number,
  sidePx: number,
  geo: BrcGeometry,
): WaypointTarget | null {
  const { x, y } = viewPxToCityFt(locationX, locationY, sidePx, geo);
  if (Math.hypot(x, y) > geo.fenceDistanceFt * 1.02) {
    return null; // beyond the trash fence — nothing to navigate to
  }
  const { lat, lon } = cityFtToLatLon(x, y, geo);
  const addr = latLonToBrc(lat, lon, geo);
  const ringWord = addr.ring.length === 1 ? addr.ring.toUpperCase() : addr.ring;
  return { label: `Map spot — ${addr.clock} & ${ringWord}`, lat, lon };
}

/** Something already DRAWN on the map that a tap can pick up. */
export type MapFeature =
  | { kind: 'pin'; id: string; label: string }
  | { kind: 'friend'; key: string; label: string }
  | { kind: 'landmark'; id: 'man' | 'temple' | 'centerCamp'; label: string };

/** A feature at its drawn position, in CITY FEET (same space as pt()). */
export interface MapFeaturePoint {
  x: number;
  y: number;
  feature: MapFeature;
}

/** What a quick tap on the map meant: an existing thing, or bare ground. */
export type MapTapResult =
  | { kind: 'feature'; feature: MapFeature; target: WaypointTarget }
  | { kind: 'spot'; target: WaypointTarget };

/**
 * Finger slop for picking an already-drawn feature, in SCREEN px.
 *
 * The constant lives in SCREEN space — not city feet — because what it
 * models is a FINGERTIP, and a fingertip does not change size when you
 * zoom. ~44px is the platform touch-target floor. A city-feet constant
 * would be wrong in both directions: zoomed out, the whole 3-mile city is
 * ~360px wide, so a "200ft" radius is 5 screen px — unhittable with dusty
 * gloves; zoomed to 4x, that same 200ft covers 22 screen px and swallows
 * the neighbouring pin you zoomed IN specifically to separate.
 *
 * Gesture coords arrive in the view's LOCAL, pre-transform space (the
 * transform rides the wrapping View), so one local px draws as `scale`
 * screen px — hence the /scale below, exactly as FINE_PLACE_LIFT_PX does.
 *
 * The honest cost: zoomed all the way out, a fingertip covers ~1500 city
 * feet, so the open playa between the Man and the Temple mostly resolves
 * to one of them. That is what a 3-mile city drawn 360px wide IS — you
 * cannot aim inside it with a finger anyway. Both escapes stay open:
 * pinch in (the slop shrinks with you) or long-press and drag, which
 * always places free-form ground even on top of a pin.
 */
export const HIT_SLOP_PX = 44;

/** The nearest drawn feature within a fingertip of the tap, else null. */
export function hitTestMapFeature(
  locationX: number,
  locationY: number,
  scale: number,
  sidePx: number,
  geo: BrcGeometry,
  features: readonly MapFeaturePoint[],
): MapFeaturePoint | null {
  if (sidePx <= 0 || features.length === 0) {
    return null;
  }
  const p = viewPxToCityFt(locationX, locationY, sidePx, geo);
  // screen px -> local px (/scale) -> city feet (x feet-per-local-px).
  const slopFt =
    (HIT_SLOP_PX / Math.max(scale, 0.01)) * ((2 * mapHalfExtentFt(geo)) / sidePx);
  let best: MapFeaturePoint | null = null;
  let bestFt = Infinity;
  for (const f of features) {
    const d = Math.hypot(f.x - p.x, f.y - p.y);
    // Strictly nearer, so an exact tie keeps the earlier feature — the
    // caller orders its own priority (your own pins before landmarks).
    if (d <= slopFt && d < bestFt) {
      best = f;
      bestFt = d;
    }
  }
  return best;
}

/**
 * What a quick tap resolves to: an EXISTING feature if the finger landed on
 * one, otherwise the bare ground under it. Existing features win — tapping
 * your own pin used to mint a competing "Map spot" right beside it, which
 * is the double-pin confusion the owner hit in the field (2026-08-20).
 */
export function resolveMapTap(
  locationX: number,
  locationY: number,
  scale: number,
  sidePx: number,
  geo: BrcGeometry,
  features: readonly MapFeaturePoint[] = [],
): MapTapResult | null {
  const hit = hitTestMapFeature(locationX, locationY, scale, sidePx, geo, features);
  if (hit) {
    const { lat, lon } = cityFtToLatLon(hit.x, hit.y, geo);
    return {
      kind: 'feature',
      feature: hit.feature,
      target: { label: hit.feature.label, lat, lon },
    };
  }
  const t = mapTapToTarget(locationX, locationY, sidePx, geo);
  return t ? { kind: 'spot', target: t } : null;
}

/** Screen-px the fine-place point rides above the fingertip, so the spot
 * being placed is never under the finger (owner field test 2026-08-20:
 * exact placement "took a lot of effort"). Divided by zoom because gesture
 * coords arrive in the map view's local, pre-transform space. */
export const FINE_PLACE_LIFT_PX = 72;

/** Gesture timing, as ONE pair so the relationship stays visible.
 * A tap must stay live right up to the long-press threshold: if TAP_MAX_MS
 * sits below FINE_PLACE_MS, a press released in the gap fires NEITHER
 * gesture and the map silently ignores the touch. Dusty gloves and cold
 * hands make slow taps the common case on playa, so the gap must be ~0.
 * Enforced by a test; do not edit one of these without the other. */
export const FINE_PLACE_MS = 350;
export const TAP_MAX_MS = FINE_PLACE_MS - 10;

/** A long-press drag resolved to city ground: the tap inversion, lifted. */
export function dragEventToTarget(
  x: number,
  y: number,
  scale: number,
  sidePx: number,
  geo: BrcGeometry,
): WaypointTarget | null {
  return mapTapToTarget(x, y - FINE_PLACE_LIFT_PX / scale, sidePx, geo);
}

export interface MapFriendPin {
  key: string;
  names: string[];
  x: number;
  y: number;
}

export function CityMap({
  geo,
  position,
  target,
  pins,
  friends,
  onMapTap,
  onFeatureTap,
}: {
  geo: BrcGeometry;
  position: GeoFix | null;
  target: WaypointTarget | null;
  pins: SavedPin[];
  friends: FriendCard[];
  /** A tap on EMPTY ground, resolved to city dirt (owner ask 2026-08-20:
   * "drop a pin anywhere on the map... and navigate there"). Also the
   * fallback for a feature tap when the host declines onFeatureTap. */
  onMapTap?: (t: WaypointTarget) => void;
  /** A tap that landed ON something already drawn — your pin, a friend's
   * camp, the Man/Temple/Center Camp. The host SELECTS that thing instead
   * of minting a competing map spot beside it (owner field test
   * 2026-08-20: "pins you've created can't be selected on the map
   * itself... this leads to confusing double-pin creation"). */
  onFeatureTap?: (hit: { feature: MapFeature; target: WaypointTarget }) => void;
}) {
  // Subscribed, not sampled: the labels have to move under the thumb that
  // moved the dial, and this component memoizes its whole SVG tree (see the
  // dep array below, which carries this).
  const labelScale = mapLabelScale(useTextScale());
  const fence = geo.fenceDistanceFt;
  // Frame the CITY (outer street + label margin), not the whole fence disc —
  // at fence scale every stroke and label lands subpixel on a 360dp phone
  // (review 2026-08-19). The fence still draws, cropped at the frame edge.
  const outerFt = geo.rings[geo.rings.length - 1]?.distanceFt ?? 5755;
  const half = mapHalfExtentFt(geo);

  const radialLines = useMemo(() => {
    const esp = geo.rings.find(r => r.ref === 'esplanade')?.distanceFt ?? 2500;
    const fRing = geo.rings.find(r => r.ref === 'f')?.distanceFt ?? 4545;
    const outer = geo.rings[geo.rings.length - 1]?.distanceFt ?? 5755;
    return geo.radials
      .map(clock => {
        const deg = clockDegFromString(clock);
        if (deg === null) {
          return null;
        }
        // Quarter-hour community paths only exist F..K (city provenance);
        // :00/:30 streets run the full Esplanade..K.
        const quarter = clock.endsWith(':15') || clock.endsWith(':45');
        const a = pt(deg, quarter ? fRing : esp);
        const b = pt(deg, outer);
        const major = clock.endsWith(':00');
        return { clock, a, b, major };
      })
      .filter(Boolean) as {
      clock: string;
      a: { x: number; y: number };
      b: { x: number; y: number };
      major: boolean;
    }[];
  }, [geo]);

  const friendPins = useMemo(() => {
    // Campmates share an address; without grouping their dots and names
    // overpaint into an unreadable stack (review 2026-08-19).
    const groups = new Map<string, MapFriendPin>();
    for (const f of friends) {
      if (f.address.length === 0) {
        continue;
      }
      const t = addressToLatLon(f.address, geo);
      if (!t) {
        continue;
      }
      const brc = latLonToBrc(t.lat, t.lon, geo);
      if (brc.distanceFt > half) {
        continue; // outside the frame: the row + compass still cover them
      }
      const p = pt(brc.clockDeg, brc.distanceFt);
      const key = `${Math.round(p.x / 150)},${Math.round(p.y / 150)}`;
      const g = groups.get(key);
      if (g) {
        g.names.push(f.name);
      } else {
        groups.set(key, { key, names: [f.name], x: p.x, y: p.y });
      }
    }
    return [...groups.values()].map(g => ({
      ...g,
      label:
        g.names.length > 2
          ? `${g.names[0]} +${g.names.length - 1}`
          : g.names.join(', '),
    }));
  }, [friends, geo, half]);

  const pinPts = useMemo(
    () =>
      pins
        .map(p => {
          const brc = latLonToBrc(p.lat, p.lon, geo);
          return { id: p.id, label: p.label, far: brc.distanceFt > half, ...pt(brc.clockDeg, brc.distanceFt) };
        })
        .filter(p => !p.far),
    [pins, geo, half],
  );

  // Depend on the COORDINATES, not the fix object. watchPosition hands us a
  // new GeoFix every 5s even when you have not moved an inch, and an object
  // dep would invalidate herePt -> invalidate the whole memoized SVG layer
  // -> full map rebuild every 5s while standing still. That is the second
  // flicker source the owner saw; the first was the gesture frame.
  // (xrev 2026-08-20, ds4pro — read the diff rather than the summary.)
  const hereLat = position?.lat ?? null;
  const hereLon = position?.lon ?? null;
  const herePt = useMemo(() => {
    if (hereLat === null || hereLon === null) {
      return null;
    }
    const brc = latLonToBrc(hereLat, hereLon, geo);
    if (brc.distanceFt > fence * 1.5) {
      return null; // far off-playa (home testing): don't fling the dot
    }
    return pt(brc.clockDeg, brc.distanceFt);
  }, [hereLat, hereLon, geo, fence]);

  const targetPt = useMemo(() => {
    if (!target) {
      return null;
    }
    const brc = latLonToBrc(target.lat, target.lon, geo);
    return { label: target.label, ...pt(brc.clockDeg, brc.distanceFt) };
  }, [target, geo]);

  const ccDeg = clockDegFromString(geo.centerCamp.clock) ?? 180;
  const cc = pt(ccDeg, geo.centerCamp.distanceFt);
  // Temple: approximated at 12:00/Esplanade radius until the measured yearly
  // position ships with the Aug 22 data drop (punchlist row).
  const temple = pt(0, geo.rings.find(r => r.ref === 'esplanade')?.distanceFt ?? 2500);

  // What a quick tap can PICK UP, in draw order of priority: your own pins
  // first, then friends, then the three named landmarks. Ties inside a
  // fingertip go to the earlier entry, so your pin beats the Man it sits on.
  // Toilets are deliberately absent — there are hundreds of them and one
  // fingertip covers a whole block; they would swallow every other tap.
  // The landmarks are re-derived INSIDE the memo for the same reason the
  // svgLayer deps omit cc/temple: pt() returns a fresh object every render,
  // so listing them as deps would rebuild this on every gesture frame.
  const tapFeatures = useMemo<MapFeaturePoint[]>(() => {
    const ccPt = pt(clockDegFromString(geo.centerCamp.clock) ?? 180, geo.centerCamp.distanceFt);
    const templePt = pt(0, geo.rings.find(r => r.ref === 'esplanade')?.distanceFt ?? 2500);
    return [
      ...pinPts.map(p => ({
        x: p.x,
        y: p.y,
        feature: { kind: 'pin', id: p.id, label: p.label } as MapFeature,
      })),
      ...friendPins.map(p => ({
        x: p.x,
        y: p.y,
        feature: { kind: 'friend', key: p.key, label: p.label } as MapFeature,
      })),
      { x: 0, y: 0, feature: { kind: 'landmark', id: 'man', label: 'the Man' } as MapFeature },
      {
        x: templePt.x,
        y: templePt.y,
        feature: { kind: 'landmark', id: 'temple', label: 'Temple' } as MapFeature,
      },
      {
        x: ccPt.x,
        y: ccPt.y,
        feature: { kind: 'landmark', id: 'centerCamp', label: 'Center Camp' } as MapFeature,
      },
    ];
  }, [pinPts, friendPins, geo]);

  const toiletPts = useMemo(
    () =>
      (geo.toilets ?? []).map(([tLon, tLat]) => {
        const brc = latLonToBrc(tLat, tLon, geo);
        return pt(brc.clockDeg, brc.distanceFt);
      }),
    [geo],
  );

  // Text sizes are in city-feet because the viewBox is: ~180ft ≈ readable.
  const [sidePx, setSidePx] = useState(0);
  // Pinch-zoom + pan (owner: the map "doesn't feel very interactive").
  // Plain-JS gesture callbacks — no reanimated; the map is a static SVG
  // whose transform re-renders fast enough at city complexity.
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const gestureBase = React.useRef({ scale: 1, tx: 0, ty: 0 });
  // Gesture callbacks are rebound every render, but a gesture can START
  // against whichever render's closure is live — so onStart reading `view`
  // from the closure can capture a STALE base and snap the map back
  // (xrev 2026-08-20, kimi). The ref always holds the current view; every
  // write goes through applyView so the two can never diverge.
  const viewRef = React.useRef(view);
  const applyView = (v: { scale: number; tx: number; ty: number }): void => {
    viewRef.current = v;
    setView(v);
  };

  const clampView = (v: { scale: number; tx: number; ty: number }) => {
    const scale = Math.min(4, Math.max(1, v.scale));
    const bound = (sidePx * (scale - 1)) / 2;
    return {
      scale,
      tx: Math.min(bound, Math.max(-bound, v.tx)),
      ty: Math.min(bound, Math.max(-bound, v.ty)),
    };
  };

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      gestureBase.current = viewRef.current;
    })
    .onUpdate(e => {
      applyView(clampView({ ...gestureBase.current, scale: gestureBase.current.scale * e.scale }));
    });
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minPointers(1)
    .maxPointers(2)
    .onStart(() => {
      gestureBase.current = viewRef.current;
    })
    .onUpdate(e => {
      applyView(
        clampView({
          ...gestureBase.current,
          tx: gestureBase.current.tx + e.translationX,
          ty: gestureBase.current.ty + e.translationY,
        }),
      );
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(TAP_MAX_MS)
    .onEnd(e => {
      if ((!onMapTap && !onFeatureTap) || sidePx <= 0) {
        return;
      }
      // e.x/e.y are already in this view's local, pre-transform space:
      // the gesture orchestrator inverse-transforms the event through the
      // view matrix on delivery (GestureHandlerOrchestrator.kt). Undoing
      // the zoom here again is a double inversion — identity at scale 1,
      // centimeters off once zoomed (owner field test 2026-08-20).
      // The SCALE still matters though: it sizes the fingertip, which is
      // constant on screen and therefore shrinks in this local space.
      const r = resolveMapTap(e.x, e.y, viewRef.current.scale, sidePx, geo, tapFeatures);
      if (!r) {
        return;
      }
      if (r.kind === 'feature' && onFeatureTap) {
        onFeatureTap({ feature: r.feature, target: r.target });
        return;
      }
      onMapTap?.(r.target);
    });
  // Fine placement (owner field test 2026-08-20: "longpress on the dot
  // itself and move it granularly"): hold ~a third of a second, then drag —
  // the target rides above the fingertip and the chip label tracks it live.
  // Exclusive with pan: a quick drag pans the map, a held one places.
  const finePlace = Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(FINE_PLACE_MS)
    .maxPointers(1)
    .onStart(e => {
      if (!onMapTap || sidePx <= 0) {
        return;
      }
      const t = dragEventToTarget(e.x, e.y, viewRef.current.scale, sidePx, geo);
      if (t) {
        onMapTap(t);
      }
    })
    .onUpdate(e => {
      if (!onMapTap || sidePx <= 0) {
        return;
      }
      const t = dragEventToTarget(e.x, e.y, viewRef.current.scale, sidePx, geo);
      if (t) {
        onMapTap(t);
      }
    });
  const gestures = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(finePlace, pan),
    tap,
  );

  // THE STATIC LAYER (xrev 2026-08-20, kimi): every pinch/pan frame calls
  // setView, which re-renders this component and would rebuild the entire
  // ~200-element SVG tree per frame. The transform lives on the WRAPPING
  // View, so the native side only needs a new matrix — the per-frame JS
  // reconciliation was the whole cost. Memoizing on everything EXCEPT the
  // view leaves zero SVG work per gesture frame.
  const svgLayer = useMemo(
    () => (
      <Svg viewBox={`${-half} ${-half} ${2 * half} ${2 * half}`}>
        {/* trash fence */}
        <Circle
          r={fence}
          fill="none"
          stroke={colors.haze}
          strokeWidth={26}
          strokeDasharray="180 140"
        />
        {/* rings */}
        <G>
          {geo.rings.flatMap(r =>
            r.segments.map(([from, to], si) => {
              const d = segArc(r.distanceFt, from, to);
              return d ? (
                <Path
                  key={`${r.ref}-${si}`}
                  d={d}
                  fill="none"
                  stroke={r.ref === 'esplanade' ? colors.clay : colors.haze}
                  strokeWidth={r.ref === 'esplanade' ? 44 : 30}
                />
              ) : null;
            }),
          )}
        </G>
        {/* radials */}
        <G>
          {radialLines.map(l => (
            <Line
              key={l.clock}
              x1={l.a.x}
              y1={l.a.y}
              x2={l.b.x}
              y2={l.b.y}
              stroke={colors.haze}
              strokeWidth={l.major ? 34 : 16}
            />
          ))}
        </G>
        {/* clock labels on the majors, just outside K */}
        <G>
          {radialLines
            .filter(l => l.major)
            .map(l => {
              const deg = clockDegFromString(l.clock) as number;
              const p = pt(deg, outerFt + 460);
              return (
                <SvgText
                  key={`lbl-${l.clock}`}
                  x={p.x}
                  y={p.y}
                  fontSize={430 * labelScale}
                  fill={colors.faded}
                  textAnchor="middle">
                  {l.clock}
                </SvgText>
              );
            })}
        </G>
        {/* toilets — the most load-bearing dots in the city. All the map's
            living-layer inks come from colors.mapInk, which carries a
            brightened set for the dark ground (themeGuard enforces that no
            raw literal sneaks back in here). */}
        <G>
          {toiletPts.map((p, i) => (
            <Circle
              key={`t${i}`}
              cx={p.x}
              cy={p.y}
              r={70}
              fill={colors.mapInk.toilet}
            />
          ))}
        </G>
        {/* center camp */}
        <Circle
          cx={cc.x}
          cy={cc.y}
          r={geo.centerCamp.plazaRadiusFt}
          fill="none"
          stroke={colors.clay}
          strokeWidth={22}
        />
        {/* the Man + Temple */}
        <Circle r={90} fill={colors.night} />
        <Circle cx={temple.x} cy={temple.y} r={80} fill={colors.night} />
        <SvgText
          x={0}
          y={-300}
          fontSize={400 * labelScale}
          fill={colors.faded}
          textAnchor="middle">
          the Man
        </SvgText>
        <SvgText
          x={temple.x}
          y={temple.y - 200}
          fontSize={380 * labelScale}
          fill={colors.faded}
          textAnchor="middle">
          Temple
        </SvgText>
        {/* saved pins */}
        <G>
          {pinPts.map(p => (
            <G key={p.id}>
              <Circle cx={p.x} cy={p.y} r={120} fill={colors.mapInk.art} />
              <SvgText
                x={p.x}
                y={p.y - 200}
                fontSize={380 * labelScale}
                fill={colors.night}
                textAnchor="middle">
                {p.label}
              </SvgText>
            </G>
          ))}
        </G>
        {/* friends */}
        <G>
          {friendPins.map(p => (
            <G key={p.key}>
              <Circle cx={p.x} cy={p.y} r={130} fill={colors.mapInk.friend} />
              <SvgText
                x={p.x}
                y={p.y + 430}
                fontSize={380 * labelScale}
                fill={colors.night}
                textAnchor="middle">
                {p.label}
              </SvgText>
            </G>
          ))}
        </G>
        {/* active waypoint */}
        {targetPt ? (
          <G>
            <Circle
              cx={targetPt.x}
              cy={targetPt.y}
              r={220}
              fill="none"
              stroke={colors.clay}
              strokeWidth={40}
            />
            <Circle cx={targetPt.x} cy={targetPt.y} r={55} fill={colors.clay} />
          </G>
        ) : null}
        {/* you */}
        {herePt ? (
          <G>
            <Circle
              cx={herePt.x}
              cy={herePt.y}
              r={170}
              fill={colors.mapInk.youHalo}
              opacity={0.35}
            />
            <Circle cx={herePt.x} cy={herePt.y} r={90} fill={colors.mapInk.you} />
          </G>
        ) : null}
      </Svg>
    ),
    // cc/temple/outerFt deliberately absent; see the note inside the array
    // before "completing" it
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      geo,
      half,
      fence,
      radialLines,
      friendPins,
      pinPts,
      herePt,
      targetPt,
      toiletPts,
      ccDeg,
      // The size dial, and it has to be here: this memo is what makes the
      // map cheap to pan, and it is also what would swallow a rung change
      // until some other dep happened to move (a11y review 2026-08-26).
      labelScale,
      // DELIBERATELY ABSENT: cc, temple, outerFt. All three are derived
      // from geo (already a dep), but cc and temple are built by pt(),
      // which returns a FRESH OBJECT every render -- listing them would
      // invalidate the memo on every frame and silently restore the very
      // flicker this fixes. Verified by dep audit 2026-08-20; do not
      // "complete" this array without re-reading that.
    ],
  );

  return (
    <View
      style={styles.square}
      onLayout={e => setSidePx(e.nativeEvent.layout.width)}>
      <GestureDetector gesture={gestures}>
      <View
        style={{
          flex: 1,
          transform: [
            { translateX: view.tx },
            { translateY: view.ty },
            { scale: view.scale },
          ],
        }}>
      {svgLayer}
      </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  square: { width: '100%', aspectRatio: 1, maxHeight: 480, alignSelf: 'center' },
});
