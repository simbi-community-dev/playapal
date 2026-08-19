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
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import type { FriendCard } from '../friends/friendCard';
import {
  addressToLatLon,
  clockDegFromString,
  latLonToBrc,
  type BrcGeometry,
  type WaypointTarget,
} from '../geo/brcGeo';
import type { GeoFix } from '../geo/useLocation';
import type { SavedPin } from '../geo/waypoints';
import { colors } from '../theme';

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
}: {
  geo: BrcGeometry;
  position: GeoFix | null;
  target: WaypointTarget | null;
  pins: SavedPin[];
  friends: FriendCard[];
}) {
  const fence = geo.fenceDistanceFt;
  // Frame the CITY (outer street + label margin), not the whole fence disc —
  // at fence scale every stroke and label lands subpixel on a 360dp phone
  // (review 2026-08-19). The fence still draws, cropped at the frame edge.
  const outerFt = geo.rings[geo.rings.length - 1]?.distanceFt ?? 5755;
  const half = outerFt + 900;

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

  const herePt = useMemo(() => {
    if (!position) {
      return null;
    }
    const brc = latLonToBrc(position.lat, position.lon, geo);
    if (brc.distanceFt > fence * 1.5) {
      return null; // far off-playa (home testing): don't fling the dot
    }
    return pt(brc.clockDeg, brc.distanceFt);
  }, [position, geo, fence]);

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

  const toiletPts = useMemo(
    () =>
      (geo.toilets ?? []).map(([tLon, tLat]) => {
        const brc = latLonToBrc(tLat, tLon, geo);
        return pt(brc.clockDeg, brc.distanceFt);
      }),
    [geo],
  );

  // Text sizes are in city-feet because the viewBox is: ~180ft ≈ readable.
  return (
    <View style={styles.square}>
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
                  fontSize={430}
                  fill={colors.faded}
                  textAnchor="middle">
                  {l.clock}
                </SvgText>
              );
            })}
        </G>
        {/* toilets — the most load-bearing dots in the city */}
        <G>
          {toiletPts.map((p, i) => (
            <Circle key={`t${i}`} cx={p.x} cy={p.y} r={70} fill="#5f86a8" />
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
        <SvgText x={0} y={-300} fontSize={400} fill={colors.faded} textAnchor="middle">
          the Man
        </SvgText>
        <SvgText
          x={temple.x}
          y={temple.y - 200}
          fontSize={380}
          fill={colors.faded}
          textAnchor="middle">
          Temple
        </SvgText>
        {/* saved pins */}
        <G>
          {pinPts.map(p => (
            <G key={p.id}>
              <Circle cx={p.x} cy={p.y} r={120} fill={'#c9a24b'} />
              <SvgText
                x={p.x}
                y={p.y - 200}
                fontSize={380}
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
              <Circle cx={p.x} cy={p.y} r={130} fill="#b45a94" />
              <SvgText
                x={p.x}
                y={p.y + 430}
                fontSize={380}
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
            <Circle cx={herePt.x} cy={herePt.y} r={170} fill="#3d7dd8" opacity={0.35} />
            <Circle cx={herePt.x} cy={herePt.y} r={90} fill="#3d7dd8" />
          </G>
        ) : null}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  square: { width: '100%', aspectRatio: 1, maxHeight: 480, alignSelf: 'center' },
});
