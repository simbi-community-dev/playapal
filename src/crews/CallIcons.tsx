/**
 * THE CALL GLYPHS — the five icons the in-call controls are made of, drawn
 * as vectors instead of typed as emoji.
 *
 * WHY NOT EMOJI, which is what the rest of this app uses. Everywhere else
 * an emoji sits INSIDE a sentence ("📹 Dusty is calling") where the words
 * carry the meaning and the glyph is decoration. Here the glyph IS the
 * control — owner report 2026-08-26: "a visual indicator for mic on and
 * off should be better, it's confusing as is with the simple buttons" —
 * and the two states that matter most, mic live and mic muted, have no
 * emoji pair that reads as one thing crossed out (🎤 vs 🔇 changes the
 * SUBJECT from microphone to speaker, which is the confusion, not a fix).
 * A drawn mic with a drawn slash through it is unambiguous at arm's
 * length, in the sun, through dust, at whatever size the button is.
 *
 * Every icon takes its colour from the caller, so the same glyph paints
 * correctly on a cream circle and on a filled gold or clay one — no colour
 * literal lives here (src/theme.ts is the only place any may live).
 */
import React from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

interface IconProps {
  /** Edge length in points — the glyph is square and scales as a unit. */
  size: number;
  color: string;
}

/** The diagonal bar that turns any glyph into its "off" twin. Drawn twice
 * — once in the button's own fill, once in the ink — so the slash reads as
 * cut THROUGH the glyph rather than as a line lying on top of it. */
function Slash({ color, cut }: { color: string; cut: string }) {
  return (
    <>
      <Line
        stroke={cut}
        strokeLinecap="round"
        strokeWidth={5}
        x1={4}
        x2={20}
        y1={3.5}
        y2={20.5}
      />
      <Line
        stroke={color}
        strokeLinecap="round"
        strokeWidth={2.4}
        x1={4}
        x2={20}
        y1={3.5}
        y2={20.5}
      />
    </>
  );
}

/** A microphone — capsule, cradle, stand. `off` adds the slash. */
export function MicIcon({
  size,
  color,
  cut,
  off,
}: IconProps & { cut: string; off?: boolean }) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Rect fill={color} height={11} rx={3.2} width={6.4} x={8.8} y={2.4} />
      <Path
        d="M5.8 11.4v0.8a6.2 6.2 0 0 0 12.4 0v-0.8"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={2.2}
      />
      <Line
        stroke={color}
        strokeLinecap="round"
        strokeWidth={2.2}
        x1={12}
        x2={12}
        y1={18.4}
        y2={21.4}
      />
      {off ? <Slash color={color} cut={cut} /> : null}
    </Svg>
  );
}

/** A video camera — body plus lens wedge. `off` adds the slash. */
export function VideoIcon({
  size,
  color,
  cut,
  off,
}: IconProps & { cut: string; off?: boolean }) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Rect fill={color} height={12} rx={3} width={13.5} x={2} y={6} />
      <Path d="M22 7.6v8.8l-5.4-4.4z" fill={color} />
      {off ? <Slash color={color} cut={cut} /> : null}
    </Svg>
  );
}

/** Switch lens — a lens ringed by the two arcs of a rotation. */
export function FlipCameraIcon({ size, color }: IconProps) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Circle cx={12} cy={12} fill={color} r={3.4} />
      <Path
        d="M4.6 9.6A8.4 8.4 0 0 1 18.4 6.6"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={2.2}
      />
      <Path d="M19.6 3.4l0.6 4.6-4.6-0.9z" fill={color} />
      <Path
        d="M19.4 14.4A8.4 8.4 0 0 1 5.6 17.4"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={2.2}
      />
      <Path d="M4.4 20.6l-0.6-4.6 4.6 0.9z" fill={color} />
    </Svg>
  );
}

/** End the call — the handset, put down. The rotation IS the meaning: the
 * same glyph upright is "answer", so it is drawn once and turned. */
export function EndCallIcon({ size, color }: IconProps) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <G origin="12, 12" rotation={135}>
        <Path
          d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-0.24 11.4 11.4 0 0 0 3.6 0.58 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 0.58 3.6 1 1 0 0 1-0.24 1z"
          fill={color}
        />
      </G>
    </Svg>
  );
}
