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
import { Text } from './Text';

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
    // THE CONTAINER ANIMATES; THE APP'S OWN TEXT CARRIES THE WORDS (a11y
    // review 2026-08-26). Animated.Text is react-native's Text with a driver
    // bolted on — it never passes through src/components/Text.tsx, so every
    // word this component has ever drawn (the Angel's "thinking…", each
    // tool-progress line, the streaming ellipsis) was frozen at its authored
    // size while the whole app around it grew. Those lines land during the
    // silent wait, which is exactly when someone is squinting at the screen.
    // Opacity and translateX are native-driver props on a View precisely as
    // they were on the text, so the pulse itself is unchanged; the size now
    // rides the dial live, because the inner Text subscribes.
    <Animated.View style={{ opacity, transform: [{ translateX: sway }] }}>
      <Text style={style}>{label}</Text>
    </Animated.View>
  );
}
