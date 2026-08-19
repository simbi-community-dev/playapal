/**
 * A subtle pulsing text label — the staged status line while the pipeline is
 * silent (thinking / tool check / reading results), and the placeholder dots
 * in an empty streaming bubble. Pure Animated loops, native driver.
 *
 * Each pipeline stage gets a DISTINCT feel via `period` (pulse speed) and
 * `drift` (a faint horizontal sway) so progress is visible even before any
 * text: stage changes read as "something new is happening", not a frozen
 * spinner (owner field report: the silent 30 s before first text).
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleProp, TextStyle } from 'react-native';

interface Props {
  label: string;
  style?: StyleProp<TextStyle>;
  /** Full pulse cycle in ms (default 1200 — the classic slow think-pulse). */
  period?: number;
  /** Faint horizontal sway, for "actively working" stages. */
  drift?: boolean;
}

export function PulsingLabel({ label, style, period = 1200, drift = false }: Props) {
  const opacity = useRef(new Animated.Value(0.35)).current;
  const sway = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const half = Math.max(120, period / 2);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: half,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: half,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    let swayLoop: Animated.CompositeAnimation | null = null;
    if (drift) {
      swayLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(sway, {
            toValue: 3,
            duration: period,
            useNativeDriver: true,
          }),
          Animated.timing(sway, {
            toValue: 0,
            duration: period,
            useNativeDriver: true,
          }),
        ]),
      );
      swayLoop.start();
    } else {
      sway.setValue(0);
    }
    return () => {
      loop.stop();
      swayLoop?.stop();
    };
  }, [opacity, sway, period, drift]);
  return (
    <Animated.Text
      style={[style, { opacity, transform: [{ translateX: sway }] }]}>
      {label}
    </Animated.Text>
  );
}
