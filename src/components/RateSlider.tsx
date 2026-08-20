/**
 * Pure-JS horizontal slider (no native dependency — RN core removed Slider,
 * and one less native lib keeps the build lean). Drag or tap anywhere on the
 * track; values snap to the given step.
 */

import React, { useCallback, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

interface Props {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Fired on every snap change while dragging. */
  onChange: (value: number) => void;
  /** Fired once when the finger lifts (persist + sample playback here). */
  onRelease?: (value: number) => void;
}

const THUMB = 24;
const TRACK_HEIGHT = 6;

export function RateSlider({ value, min, max, step, onChange, onRelease }: Props) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const latestValue = useRef(value);
  latestValue.current = value;

  const valueFromX = useCallback(
    (x: number): number => {
      const usable = widthRef.current - THUMB;
      if (usable <= 0) {
        return latestValue.current;
      }
      const fraction = Math.min(1, Math.max(0, (x - THUMB / 2) / usable));
      const raw = min + fraction * (max - min);
      const snapped = Math.round(raw / step) * step;
      return Math.round(snapped * 100) / 100;
    },
    [min, max, step],
  );

  // Gesture discipline (device-caught bug, r5 smoke): the slider lives inside
  // a ScrollView, so it must NOT claim vertical swipes — the first build set
  // the value on touch-down and captured every move, which both ate page
  // scrolling and yanked the rate when a scroll started on the track. Now:
  // value changes only on horizontal-intent drags or clean taps, and vertical
  // gestures hand off to the ScrollView untouched.
  const draggingRef = useRef(false);
  const lastSetRef = useRef<number | null>(null);
  const apply = useCallback(
    (x: number) => {
      const v = valueFromX(x);
      lastSetRef.current = v;
      onChange(v);
    },
    [valueFromX, onChange],
  );
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Let the ScrollView steal vertical gestures unless a drag is engaged.
      onPanResponderTerminationRequest: (_evt, gs) =>
        !draggingRef.current && Math.abs(gs.dy) > Math.abs(gs.dx),
      onPanResponderGrant: () => {
        draggingRef.current = false;
        lastSetRef.current = null;
      },
      onPanResponderMove: (evt, gs) => {
        if (
          draggingRef.current ||
          (Math.abs(gs.dx) > 6 && Math.abs(gs.dx) > Math.abs(gs.dy))
        ) {
          draggingRef.current = true;
          applyRef.current(evt.nativeEvent.locationX);
        }
      },
      onPanResponderRelease: (evt, gs) => {
        // A clean tap (no real movement) sets the value where it landed.
        if (!draggingRef.current && Math.abs(gs.dx) < 8 && Math.abs(gs.dy) < 8) {
          applyRef.current(evt.nativeEvent.locationX);
        }
        draggingRef.current = false;
        if (lastSetRef.current !== null) {
          onRelease?.(lastSetRef.current);
        }
      },
      onPanResponderTerminate: () => {
        // ScrollView took over: nothing was changed, nothing to commit.
        draggingRef.current = false;
      },
    }),
  ).current;

  const fraction = max > min ? (value - min) / (max - min) : 0;
  const thumbLeft = Math.max(0, fraction * (width - THUMB));

  return (
    <View
      style={styles.touchArea}
      onLayout={e => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      accessibilityRole="adjustable"
      accessibilityValue={{ min, max, now: value }}
      {...responder.panHandlers}>
      <View style={styles.track} />
      <View style={[styles.fill, { width: thumbLeft + THUMB / 2 }]} />
      <View style={[styles.thumb, { left: thumbLeft }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    height: 40,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: colors.haze,
  },
  fill: {
    position: 'absolute',
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: colors.clay,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.clay,
    borderWidth: 2,
    borderColor: colors.cream,
    elevation: 2,
  },
});
