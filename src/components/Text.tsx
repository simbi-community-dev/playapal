/**
 * THE APP'S TEXT — react-native's Text and TextInput with the camper's
 * chosen size multiplied in at render (owner ask 2026-08-26: "settings
 * needs a font size +/- option"). Out there, eyes are sun-blind by noon
 * and the reading glasses are back in the tent; a size dial is not a
 * preference, it is whether the app can be used at all.
 *
 * WHY A WRAPPER AND NOT A SCALED `type` IN src/theme.ts. Sizes freeze the
 * same way colors do: module-level StyleSheet.create reads type.body ONCE,
 * so a multiplier applied to those four numbers could only land after a JS
 * reload — the same restart the Appearance rows have to warn a sharing
 * camper about (see the boot-order note in src/theme.ts). Multiplying at
 * render costs one subscription per Text and buys the thing that matters:
 * tap A+, the whole app grows before your thumb leaves the glass.
 *
 * THE RULE THIS BUYS, AND THE GUARD THAT KEEPS IT: nothing under src/ (or
 * App.tsx) imports Text or TextInput from 'react-native' any more — they
 * come from here. A screen that reaches past this module is a screen whose
 * labels ignore the dial, which is the same bug class as a hardcoded color
 * ignoring dark mode. __tests__/textSize.test.tsx walks the tree and fails
 * on any such import, exactly as themeGuard does for color literals.
 *
 * Everything else about Text is untouched: props pass straight through
 * (including `ref`, a plain prop in React 19), the OS's own accessibility
 * font scale still applies on top via allowFontScaling, and at the default
 * rung the style object is handed on by identity with nothing allocated.
 */

import React, { useSyncExternalStore } from 'react';
import {
  StyleSheet,
  Text as RnText,
  TextInput as RnTextInput,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from 'react-native';
import { subscribeTextScale, textScale } from '../theme';

/**
 * The live rung, re-read on every change (getServerSnapshot unused in RN,
 * but React's types want the third argument in some configurations).
 *
 * EXPORTED, because a few things that carry words are not a Text and can
 * never be one: the circled ? in InfoTap is a bordered View sized in points
 * around its glyph, and CityMap's labels are SVG text placed by geometry.
 * Both have to hear the same dial the paragraphs hear, so both subscribe
 * here rather than sampling textScale() once at mount — the difference
 * between "grows before your thumb leaves the glass" and "grows the next
 * time this screen happens to remount".
 */
export function useTextScale(): number {
  return useSyncExternalStore(subscribeTextScale, textScale, textScale);
}

/**
 * Grow a text style by the current rung.
 *
 * Only a style that actually STATES a fontSize is touched. A nested Text
 * (the bold span inside a sentence) states none and inherits its parent's
 * already-grown size — injecting one there would break that inheritance
 * and freeze the span at one size while its sentence moved.
 *
 * lineHeight rides along whenever it is stated, and that is load-bearing,
 * not tidiness: CompassScreen's 170pt home arrow pairs with lineHeight
 * 190, and growing the glyph alone would clip it against a box that never
 * grew.
 */
export function growTextStyle(
  style: StyleProp<TextStyle>,
  scale: number,
): StyleProp<TextStyle> {
  if (scale === 1) {
    return style;
  }
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  const size = flat?.fontSize;
  if (typeof size !== 'number') {
    return style;
  }
  const line = flat?.lineHeight;
  // The original style keeps its identity in the array; only the one or
  // two numbers are overridden on top of it.
  return [
    style,
    typeof line === 'number'
      ? { fontSize: size * scale, lineHeight: line * scale }
      : { fontSize: size * scale },
  ];
}

/** react-native's Text, at the camper's size. */
export function Text({ style, ...rest }: TextProps) {
  const scale = useTextScale();
  return <RnText {...rest} style={growTextStyle(style, scale)} />;
}

/**
 * react-native's TextInput, at the camper's size — what you type back has
 * to be as readable as what you read. forwardRef, not a plain prop pass:
 * ChatScreen holds the composer's ref to blur it, and this project's
 * react-native types still declare `ref` outside TextInputProps.
 */
export const TextInput = React.forwardRef<TextInputInstance, TextInputProps>(
  function TextInput({ style, ...rest }, ref) {
    const scale = useTextScale();
    return (
      <RnTextInput {...rest} ref={ref} style={growTextStyle(style, scale)} />
    );
  },
);
