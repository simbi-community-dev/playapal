/**
 * THE READING-GLASSES DIAL (owner ask 2026-08-26: "settings needs a font
 * size +/- option"). Five things have to hold, and each test below names
 * the mutation that breaks it:
 *
 *  1. the rung SURVIVES a launch (drop the setSetting write, or read a
 *     different key at boot, and the camper re-picks it every morning);
 *  2. the multiplier REACHES rendered text, live (return the style
 *     untouched, or drop the subscription so it only lands on remount, and
 *     the stepper looks broken under the thumb that pressed it);
 *  3. the range is BOUNDED at both ends (step by multiplication instead of
 *     by rung and 1.4 runs away to 2.1 on the next tap);
 *  4. nothing bypasses src/components/Text.tsx (import Text straight from
 *     react-native and that screen's labels ignore the dial — the same bug
 *     class as a hardcoded color ignoring dark mode, guarded the same way
 *     __tests__/themeGuard.test.ts guards those). Two doors, not one: the
 *     direct import, and a STYLE that states no fontSize for the wrapper to
 *     multiply;
 *  5. the surfaces that carry words WITHOUT being a Text move too (a11y
 *     review 2026-08-26, five findings). A bordered ring drawn in points
 *     around a glyph, a label whose animation replaced the Text under it,
 *     and SVG labels placed by geometry are each their own escape hatch,
 *     and each one had quietly taken it.
 */
import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// The settings table as a Map — the themeGuard/tour pattern. theme.ts
// reaches it lazily through require(), which resolves to this mock.
const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import { Text, TextInput, growTextStyle } from '../src/components/Text';
import { InfoTap } from '../src/components/InfoTap';
import { PulsingLabel } from '../src/components/PulsingLabel';
import {
  CityMap,
  MAP_LABEL_SCALE_CEILING,
  mapLabelScale,
} from '../src/screens/CityMap';
import {
  TEXT_SCALES,
  clampTextScale,
  loadTextScale,
  nextTextScale,
  radius,
  setTextScale,
  textScale,
  textScaleLabel,
  type,
} from '../src/theme';

const TestRenderer = require('react-test-renderer');
const RN = require('react-native');
const RnSvg = require('react-native-svg');

declare const __dirname: string;
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  readdirSync(dir: string, opts: { withFileTypes: true }): DirEntry[];
  readFileSync(file: string, encoding: 'utf8'): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};

// Trees are torn down between tests. Not tidiness: a tree left mounted
// hears the NEXT test's setTextScale and React rightly complains about an
// update outside act(). A warning on every green run is how real warnings
// die of neglect (the same rule jest.config.js keeps for the haste map).
const mounted: any[] = [];
function render(element: React.ReactElement): any {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(element);
  });
  mounted.push(root);
  return root;
}

/** Turn the dial the way a thumb does — inside act, so React settles. */
function tapTo(scale: number): void {
  TestRenderer.act(() => {
    setTextScale(scale);
  });
}

beforeEach(() => {
  mockSettings.clear();
  loadTextScale(); // every test starts from a fresh launch at Default
});

afterEach(() => {
  TestRenderer.act(() => {
    for (const root of mounted.splice(0)) {
      root.unmount();
    }
  });
});

// ── 1. the rung survives a launch ─────────────────────────────────────

test('the chosen rung comes back on the next launch', () => {
  // MUTATION THIS CATCHES: setTextScale that only moves the in-memory
  // value, or a loadTextScale that reads a different settings key. Both
  // leave the app at Default every morning while the stepper still LOOKS
  // like it worked during the session that set it.
  expect(textScale()).toBe(1);
  setTextScale(1.4);
  expect(textScale()).toBe(1.4);

  loadTextScale(); // ← the next launch, reading the same table back
  expect(textScale()).toBe(1.4);
});

test('an unreadable settings table launches at Default rather than failing', () => {
  // MUTATION THIS CATCHES: dropping the try/catch around the read. A db
  // that cannot open would then take the whole app down before its first
  // frame — a worse outcome than one wrong-sized launch.
  const db = require('../src/events/db');
  const realGet = db.getSetting;
  db.getSetting = () => {
    throw new Error('database is locked');
  };
  try {
    loadTextScale();
    expect(textScale()).toBe(1);
  } finally {
    db.getSetting = realGet;
  }
});

// ── 2. the multiplier reaches rendered text, live ──────────────────────

const styles = StyleSheet.create({
  // A screen's frozen style, exactly as every screen writes one: the
  // numbers are read from `type` ONCE, at module evaluation.
  body: { fontSize: type.body, lineHeight: 24 },
  arrow: { fontSize: 170, lineHeight: 190 },
  bold: { fontWeight: '700' as const },
});

function Sample() {
  return (
    <Text style={styles.body}>
      Sunrise yoga
      <Text style={styles.bold}>, 6 AM</Text>
    </Text>
  );
}

/** Every react-native Text under the tree, outermost first. */
function nativeTexts(root: any): any[] {
  return root.root.findAllByType(RN.Text);
}

function sizeOf(node: any): number | undefined {
  return (StyleSheet.flatten(node.props.style) as { fontSize?: number })
    ?.fontSize;
}

test('a rung change grows already-rendered text with no remount', () => {
  // MUTATION THIS CATCHES: growTextStyle returning `style` untouched (the
  // size never moves), or Text reading textScale() once instead of
  // subscribing (the size moves only when the screen happens to remount —
  // which on the Settings tab means the stepper appears to do nothing).
  const root = render(<Sample />);
  expect(sizeOf(nativeTexts(root)[0])).toBe(16);

  tapTo(1.4); // the camper taps A+ to the ceiling
  // Same tree, no re-create: this is the "before your thumb leaves the
  // glass" promise, asserted.
  expect(sizeOf(nativeTexts(root)[0])).toBeCloseTo(16 * 1.4, 5);
});

test('a nested span keeps inheriting instead of being pinned at one size', () => {
  // MUTATION THIS CATCHES: injecting a fontSize into every Text (say, a
  // default of type.body) rather than only into styles that state one.
  // The bold span inside a sentence would then freeze at body size while
  // the sentence around it grew.
  tapTo(1.4);
  const [outer, inner] = nativeTexts(render(<Sample />));
  expect(sizeOf(outer)).toBeCloseTo(16 * 1.4, 5);
  expect(sizeOf(inner)).toBeUndefined();
});

test('lineHeight grows with its glyph', () => {
  // MUTATION THIS CATCHES: scaling fontSize alone. CompassScreen's home
  // arrow is fontSize 170 against lineHeight 190; grow only the glyph and
  // it clips against a box that never grew.
  const grown = StyleSheet.flatten(growTextStyle(styles.arrow, 1.4)) as {
    fontSize: number;
    lineHeight: number;
  };
  expect(grown.fontSize).toBeCloseTo(238, 5);
  expect(grown.lineHeight).toBeCloseTo(266, 5);
});

test('what you type back grows too', () => {
  // MUTATION THIS CATCHES: wrapping Text but leaving TextInput on
  // react-native's own — the composer stays 16pt while every label around
  // it grows, which is the half-fix that reads as a bug.
  tapTo(1.2);
  const root = render(<TextInput style={styles.body} value="dusty" />);
  const input = root.root.findByType(RN.TextInput);
  expect(sizeOf(input)).toBeCloseTo(16 * 1.2, 5);
});

test('at Default the style object is handed on untouched', () => {
  // MUTATION THIS CATCHES: allocating a new style array on every render at
  // the default rung — the size every camper who never opens this row is
  // rendering at, on every Text in the app.
  expect(growTextStyle(styles.body, 1)).toBe(styles.body);
});

// ── 3. the range is bounded at both ends ──────────────────────────────

test('anything out of range snaps onto a real rung', () => {
  // MUTATION THIS CATCHES: trusting the stored/passed value. A settings
  // row corrupted to "9" would render a 144pt body; "0" would render 0pt
  // text, which is an app with no words in it.
  expect(clampTextScale(9)).toBe(1.4);
  expect(clampTextScale(0)).toBe(0.85);
  expect(clampTextScale(1.18)).toBe(1.2); // nearest rung, not floor
  expect(clampTextScale('1.4')).toBe(1.4); // the settings table stores text
  expect(clampTextScale('huge')).toBe(1);
  expect(clampTextScale(NaN)).toBe(1);
  expect(clampTextScale(Infinity)).toBe(1);
  expect(clampTextScale(null)).toBe(1);
  expect(clampTextScale(undefined)).toBe(1);
});

test('the stepper stops at both ends instead of running past them', () => {
  // MUTATION THIS CATCHES: stepping by multiplication (scale * 1.2) or by
  // unclamped index arithmetic. Either one walks off the top rung, and the
  // pod card at 2× is a column of single words.
  const floor = TEXT_SCALES[0];
  const ceiling = TEXT_SCALES[TEXT_SCALES.length - 1];
  expect(nextTextScale(ceiling, +1)).toBe(ceiling);
  expect(nextTextScale(floor, -1)).toBe(floor);
  expect(nextTextScale(1, +1)).toBe(1.2);
  expect(nextTextScale(1, -1)).toBe(0.85);
  // and a garbage current value still steps from somewhere sane
  expect(nextTextScale(NaN, +1)).toBe(1.2);
});

test('a saved rung out of range cannot survive a launch', () => {
  // MUTATION THIS CATCHES: loadTextScale assigning the raw stored value.
  mockSettings.set('textScale', '4');
  loadTextScale();
  expect(textScale()).toBe(1.4);
});

test('every rung is named', () => {
  // MUTATION THIS CATCHES: adding a rung to TEXT_SCALES without a label —
  // the row would then say "undefined" where the size should be.
  for (const rung of TEXT_SCALES) {
    expect(typeof textScaleLabel(rung)).toBe('string');
    expect(textScaleLabel(rung).length).toBeGreaterThan(0);
  }
  expect(textScaleLabel(1)).toBe('Default');
});

// ── 4. nothing bypasses the wrapper ───────────────────────────────────

/** The one module allowed to say `Text` to react-native out loud. */
const WRAPPER = 'src/components/Text.tsx';
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Source with its comments removed — the guard reads CODE.
 *
 * Load-bearing, not tidiness: PulsingLabel's own note has to name
 * `Animated.Text` out loud to explain why it does not use one, and a guard
 * that fires when somebody explains the code is a guard people learn to
 * edit around (the lesson __tests__/InfoTap.test.tsx wrote down the same
 * week). A `//` is only cut when it is not part of a `://`, so a URL inside
 * a string survives the pass.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1');
}

/**
 * Does this source reach react-native's own Text or TextInput — by either
 * door? Takes the SOURCE, not a path, so the guard can be pointed at a
 * planted violation as well as at the real tree: a guard that has never
 * failed is a guard nobody has proven.
 *
 * DOOR ONE is the direct import.
 *
 * DOOR TWO is `Animated.Text`, which is react-native's Text with a driver
 * bolted on. It never passes through src/components/Text.tsx, so it ignores
 * the dial exactly as a direct import would — and it hides better, because
 * the import line above it says `Animated` and looks innocent. PulsingLabel
 * wore this bug: the Angel's "thinking…", every tool-progress line and the
 * streaming ellipsis were the only words in the app frozen at their
 * authored size, and they are the words on screen during the silent wait,
 * when somebody is squinting hardest. The cure is to animate a CONTAINER —
 * Animated.View around the app's own Text — which is why this guard names
 * the CLASS and not any particular instance of it.
 */
function bypassesWrapper(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const blocks = code.matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*'react-native';/g,
  );
  for (const block of blocks) {
    for (const raw of block[1].split(',')) {
      const name = raw.trim();
      if (name === 'Text' || name === 'TextInput') {
        found.push(name);
      }
    }
  }
  for (const hit of code.matchAll(/\bAnimated\.(Text|TextInput)\b/g)) {
    found.push(`Animated.${hit[1]}`);
  }
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('the guard fires on a planted violation and spares legitimate imports', () => {
  // A guard is unproven until it has failed. Plant one that must be
  // caught, and point it at the two shapes that must NOT be: a module
  // taking other components from react-native, and one taking the Text
  // TYPES (TextStyle/TextProps still legitimately come from there).
  expect(
    bypassesWrapper("import { Pressable, Text, View } from 'react-native';"),
  ).toEqual(['Text']);
  expect(
    bypassesWrapper("import {\n  Text,\n  TextInput,\n} from 'react-native';"),
  ).toEqual(['Text', 'TextInput']);
  expect(
    bypassesWrapper("import { Pressable, View } from 'react-native';"),
  ).toEqual([]);
  expect(
    bypassesWrapper(
      "import { StyleSheet, type TextStyle, type TextProps } from 'react-native';",
    ),
  ).toEqual([]);
});

test('the guard fires on a planted Animated.Text, and on nothing that merely looks like one', () => {
  // The second door, proven the same way. MUTATION THIS CATCHES: a new
  // animated label written the obvious way. Nothing crashes and the pulse
  // looks perfect — the words underneath it are simply the only ones in the
  // app that refuse the dial.
  expect(
    bypassesWrapper(
      "import { Animated } from 'react-native';\n" +
        '<Animated.Text style={s}>{label}</Animated.Text>',
    ),
  ).toEqual(['Animated.Text', 'Animated.Text']);
  // The cure must pass: a container animation around the app's own Text…
  expect(
    bypassesWrapper(
      "import { Animated } from 'react-native';\n" +
        "import { Text } from './Text';\n" +
        '<Animated.View style={s}><Text>{label}</Text></Animated.View>',
    ),
  ).toEqual([]);
  // …and so must an animated component MADE from the wrapper, which is the
  // other legitimate shape (the wrapper is what it wraps).
  expect(
    bypassesWrapper('const Pulse = Animated.createAnimatedComponent(Text);'),
  ).toEqual([]);
  // …and a comment that explains the rule is not a violation of it. This is
  // what lets the fixed PulsingLabel say WHY it looks the way it does.
  expect(
    bypassesWrapper(
      "// Animated.Text would freeze the label at its authored size.\n" +
        "/* import { Text } from 'react-native'; -- never again */\n" +
        "import { Animated } from 'react-native';",
    ),
  ).toEqual([]);
  // …and a URL inside a string is not a comment.
  expect(
    bypassesWrapper(
      "const doc = 'https://reactnative.dev/docs/animated';\n" +
        '<Animated.Text />',
    ),
  ).toEqual(['Animated.Text']);
});

/**
 * THE OTHER WAY TO IGNORE THE DIAL: state no size at all.
 *
 * growTextStyle multiplies the numbers a style actually CARRIES, and that
 * is deliberate — a nested span states none so it can inherit its
 * sentence's already-grown size. The cost of that design is this bug: a
 * TOP-LEVEL label whose style states no fontSize inherits react-native's
 * own 14pt default instead, which nothing multiplies. It reads fine in a
 * screenshot at Default and never moves again.
 *
 * A tree-wide sweep is the wrong instrument (every nested span in the app
 * is a legitimate no-fontSize style, and telling the two apart needs real
 * JSX nesting analysis). This is a targeted pin on the two labels the a11y
 * review caught, walked from the LABEL to the style it names to that
 * style's declaration — so it also fails if somebody re-points them at
 * another sizeless style.
 */
const AddNoteSheetSource = () =>
  fs.readFileSync(path.join(REPO_ROOT, 'src/screens/AddNoteSheet.tsx'), 'utf8');

test.each([['📷 Snap the piece'], ['Choose photo']])(
  'a top-level label states a size the dial can multiply: %s',
  label => {
    const src = AddNoteSheetSource();
    const el = new RegExp(
      `<Text style=\\{styles\\.(\\w+)\\}>${label.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )}<`,
    ).exec(src);
    expect(el).not.toBeNull();
    const declared = new RegExp(`\\b${el![1]}:\\s*\\{[^}]*\\}`).exec(src);
    expect(declared).not.toBeNull();
    expect(declared![0]).toMatch(/fontSize:\s*type\./);
  },
);

test('no screen reaches past src/components/Text.tsx for its text', () => {
  // MUTATION THIS CATCHES: a new screen (or a merge) importing Text from
  // react-native. Its labels would quietly ignore the size dial — nothing
  // crashes, nothing looks wrong in a screenshot, and the one camper who
  // needs the dial finds one screen that refuses it.
  const offenders: string[] = [];
  const files = sourceFiles(path.join(REPO_ROOT, 'src'));
  files.push(path.join(REPO_ROOT, 'App.tsx'));
  // A walk that quietly found nothing would pass this test forever. Pin
  // the floor and the one file that must be in it.
  expect(files.length).toBeGreaterThan(50);
  expect(files.some(f => f.endsWith('App.tsx'))).toBe(true);
  expect(files.some(f => f.endsWith(path.join('screens', 'CampScreen.tsx')))).toBe(
    true,
  );
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split('\\').join('/');
    if (rel === WRAPPER) {
      continue;
    }
    const names = bypassesWrapper(fs.readFileSync(file, 'utf8'));
    if (names.length > 0) {
      offenders.push(`${rel}: ${names.join(', ')}`);
    }
  }
  expect(offenders).toEqual([]);
});

// ── 5. the surfaces that carry words without being a Text ─────────────

/** The flattened style of a rendered node, never undefined: an assertion
 * about a size must fail LOUDLY when the style went missing rather than
 * pass vacuously against `undefined?.width`. */
function box(node: any): ViewStyle {
  return (StyleSheet.flatten(node.props.style) as ViewStyle | undefined) ?? {};
}

/** InfoTap's drawn circle, found by the shape it is: the round-bordered
 * box with a stated width. */
function ring(root: any): ViewStyle {
  const found = root.root.findAll(
    (n: any) =>
      box(n).borderRadius === radius.chip && typeof box(n).width === 'number',
  );
  expect(found.length).toBeGreaterThanOrEqual(1);
  return box(found[0]);
}

/** The ? itself. */
function glyph(root: any): number | undefined {
  const found = root.root.findAll(
    (n: any) => n.type === RN.Text && n.props?.children === '?',
  );
  expect(found).toHaveLength(1);
  return sizeOf(found[0]);
}

test('the circled ? grows with the glyph inside it', () => {
  // MUTATION THIS CATCHES: the 22pt ring frozen while the glyph it circles
  // rides the dial — which is what shipped. At Biggest, with the OS's own
  // font scale on top and Android's line padding, the ? is clipped by the
  // circle that exists to make it findable. The affordance defeats itself
  // for exactly the camper who turned the dial up to find it.
  //
  // Exempting the ring as decorative was the other option on the table. A
  // question mark nobody can read is not decoration, so the ratio below is
  // the assertion that matters: whatever the rung, the glyph sits in the
  // same proportion of its circle as it does at Default.
  const root = render(<InfoTap topic="the field log" text="Kept on this device." />);
  expect(ring(root).width).toBe(22);
  expect(ring(root).height).toBe(22);
  const ratioAtDefault = glyph(root)! / 22;

  tapTo(1.4);
  const grown = ring(root);
  expect(grown.width).toBeCloseTo(22 * 1.4, 5);
  // still a circle, not an ellipse the ? sits in the middle of
  expect(grown.height).toBe(grown.width);
  expect(glyph(root)! / (grown.width as number)).toBeCloseTo(ratioAtDefault, 5);
});

test("the Angel's staged status lines pulse AND grow", () => {
  // MUTATION THIS CATCHES: rendering the label as Animated.Text again. The
  // pulse is identical, the tests that assert the pulse stay green, and
  // "thinking…" / "checking the camp's memory" / the streaming ellipsis are
  // the only words in the app that ignore the dial — during the silent wait,
  // which is when someone is squinting hardest.
  const root = render(<PulsingLabel label="thinking…" style={styles.body} />);
  expect(sizeOf(nativeTexts(root)[0])).toBe(16);

  tapTo(1.4);
  expect(sizeOf(nativeTexts(root)[0])).toBeCloseTo(16 * 1.4, 5);

  // …and it still pulses, on a CONTAINER. Both halves matter: a fix that
  // scaled the text by dropping the animation would pass the line above.
  const pulsing = root.root.findAll((n: any) => {
    const s = box(n) as { opacity?: number; transform?: unknown[] };
    return s.opacity !== undefined && Array.isArray(s.transform);
  });
  expect(pulsing.length).toBeGreaterThanOrEqual(1);
  for (const t of nativeTexts(root)) {
    expect(box(t).opacity).toBeUndefined();
  }
});

/**
 * THE MAP'S OWN LABELS — the clock ring, the Man, the Temple, your pins and
 * your friends' camps. SVG text, so no wrapper ever reached them.
 *
 * They ride the dial to a stated CEILING and no further, and that bound is
 * the design rather than a shortcut: every other label in the app lives in
 * a layout that reflows, while these are placed by geometry and grow only
 * into their neighbours. src/screens/CityMap.tsx carries the reasoning; the
 * tests carry the promise that the bound is real in both directions —
 * the dial reaches the map, AND it stops where the map says it stops.
 */
describe('the map labels', () => {
  const geo = require('../assets/city-geo/geometry.json');
  const PIN = { id: 'p1', label: 'Bike', lat: 40.79, lon: -119.21, savedAt: 1 };
  const FRIEND = {
    id: 'f1',
    seq: 1,
    name: 'Dusty',
    camp: 'Hippo',
    address: '7:30 & C',
    note: '',
    updated_at: '2026-08-26T00:00:00Z',
    scope: 'camp' as const,
  };

  const mountMap = (pins: any[], friends: any[]) =>
    render(
      // The map is a gesture surface; react-native-gesture-handler v3 asks
      // for its root view before it will mount a detector.
      <GestureHandlerRootView>
        <CityMap
          geo={geo}
          position={null}
          target={null}
          pins={pins}
          friends={friends}
        />
      </GestureHandlerRootView>,
    );
  const labelSizes = (root: any): number[] =>
    root.root.findAllByType(RnSvg.Text).map((n: any) => n.props.fontSize);

  test('all four kinds of label are in the sweep, not just the ones always drawn', () => {
    // MUTATION THIS CATCHES: scaling the clock ring and the landmarks and
    // forgetting the two label kinds that only appear once a camper has
    // saved a pin or collected a friend — the labels most likely to be
    // squinted at, and the ones absent from an empty-state screenshot.
    const bare = labelSizes(mountMap([], []));
    const living = labelSizes(mountMap([PIN], [FRIEND]));
    expect(bare.length).toBeGreaterThanOrEqual(12); // clock ring + landmarks
    expect(living).toHaveLength(bare.length + 2); // + the pin, + the friend
  });

  test('a rung change moves them live, with no remount', () => {
    // MUTATION THIS CATCHES: reading the scale without subscribing, or
    // leaving it out of the SVG layer's memo dep array — which is the
    // likelier miss, because that memo is what makes the map cheap to pan.
    // The map would then grow its labels only when some UNRELATED dep moved
    // (your position, a new pin), so the dial appears to do nothing on the
    // map and then to work later for no reason.
    const root = mountMap([PIN], [FRIEND]);
    const base = labelSizes(root);

    tapTo(1.2);
    expect(labelSizes(root)).toEqual(base.map(s => s * 1.2));
  });

  test('and they STOP at the ceiling the geometry can carry', () => {
    // MUTATION THIS CATCHES: dropping the clamp and passing the raw rung
    // through "for consistency". At 1.4x the twelve clock labels touch each
    // other and the ring they annotate, so Biggest would render a map less
    // readable than Default — the opposite of what the camper asked for.
    const root = mountMap([PIN], [FRIEND]);
    const base = labelSizes(root); // mounted at Default

    tapTo(1.4); // the camper asks for Biggest…
    // …and gets Bigger on the map, which is all the geometry has room for.
    expect(labelSizes(root)).toEqual(base.map(s => s * MAP_LABEL_SCALE_CEILING));
    expect(labelSizes(root)).not.toEqual(base.map(s => s * 1.4));
  });

  test('the ceiling is a CLAMP, not a fixed map size', () => {
    // MUTATION THIS CATCHES: pinning the map to the ceiling outright. The
    // rungs below it are the whole reason a bounded scale is honest — a
    // camper on Smaller or Default must still get their own size.
    expect(mapLabelScale(0.85)).toBe(0.85);
    expect(mapLabelScale(1)).toBe(1);
    expect(mapLabelScale(1.2)).toBe(1.2);
    expect(mapLabelScale(1.4)).toBe(MAP_LABEL_SCALE_CEILING);
    // and the ceiling is a rung the dial actually has, not an invented one
    expect(TEXT_SCALES).toContain(MAP_LABEL_SCALE_CEILING);
  });
});
