/**
 * useHeading — smoothed TRUE-north compass heading from the magnetometer
 * (react-native-sensors).
 *
 * v1 assumptions, on purpose:
 * - PHONE HELD ROUGHLY FLAT (screen up). Raw magnetometer heading without
 *   accelerometer tilt-fusion is only valid near-flat — which matches the
 *   whiteout posture: phone in palm, looking down. Tilt compensation is a
 *   later enhancement; this hook reports the sensor reading directly.
 * - Magnetic -> true correction comes from the caller (geometry.json's
 *   per-year declinationDeg, ~+12.9E at BRC; pass 0 if geometry is missing —
 *   a 13-degree-off arrow still beats no arrow, and the compass surface
 *   falls back to clock-phrase mode anyway when this hook returns null).
 *
 * Degrades gracefully: no sensor / sensor error -> permanently null for the
 * mount, no retry storm. Smoothing is a vector EMA (never average angles as
 * scalars: 359 and 1 average to 0, not 180).
 */

import { useEffect, useRef, useState } from 'react';
import {
  magnetometer,
  SensorTypes,
  setUpdateIntervalForType,
} from 'react-native-sensors';

/** EMA weight of each new sample (higher = snappier, noisier). */
const SMOOTHING_ALPHA = 0.25;
const UPDATE_MS = 200;

export function useHeading(declinationDeg: number): number | null {
  const [heading, setHeading] = useState<number | null>(null);
  // Smoothed unit-vector accumulator for the magnetic heading.
  const ema = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    ema.current = null;
    let sub: { unsubscribe: () => void } | null = null;
    try {
      setUpdateIntervalForType(SensorTypes.magnetometer, UPDATE_MS);
      sub = magnetometer.subscribe({
        next: ({ x, y }) => {
          // Device axes: x right, y toward the top of the screen. Held flat,
          // the horizontal field component gives magnetic heading of the
          // phone's top edge as atan2(-x, y) (0 = north, clockwise).
          const magDeg = (Math.atan2(-x, y) * 180) / Math.PI;
          const r = (magDeg * Math.PI) / 180;
          const prev = ema.current;
          const nx = Math.sin(r);
          const ny = Math.cos(r);
          ema.current = prev
            ? {
                x: prev.x + SMOOTHING_ALPHA * (nx - prev.x),
                y: prev.y + SMOOTHING_ALPHA * (ny - prev.y),
              }
            : { x: nx, y: ny };
          const smoothMag = (Math.atan2(ema.current.x, ema.current.y) * 180) / Math.PI;
          // East declination positive: true = magnetic + declination.
          setHeading((((smoothMag + declinationDeg) % 360) + 360) % 360);
        },
        error: () => {
          // No magnetometer (or it died): the compass surface's clock-phrase
          // mode is the floor. Null for the rest of the mount.
          setHeading(null);
        },
      });
    } catch {
      setHeading(null);
    }
    return () => sub?.unsubscribe();
  }, [declinationDeg]);

  return heading;
}
