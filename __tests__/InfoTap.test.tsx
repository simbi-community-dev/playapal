/**
 * INFO TAP — the owner's "one curious tap gives the full info", pinned.
 *
 * Every test below names the mutation it dies on, because the failures
 * that matter here are all silent: an explanation that renders inline
 * anyway (the Tufte complaint, uncured), a card nobody can shut, a glyph a
 * screen reader announces as "button" and nothing else, or a target only a
 * clean fingertip can hit.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, type ViewStyle } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { InfoTap } from '../src/components/InfoTap';
import { colors } from '../src/theme';

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join('');
  }
  if (value && typeof value === 'object' && 'children' in value) {
    return textContent((value as { children?: unknown }).children);
  }
  return '';
}

const FIELD_LOG =
  'Kept on this device until you share it. Exports full chats, retrieved ' +
  'passages and tool details, model name, and timings.';

function mount(node: React.ReactElement) {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(node);
  });
  const r = renderer!;
  /** Every pressable that is also an announced button, in render order:
   * [0] is the glyph, and once open [1] is "Got it". The full-screen veil
   * is deliberately NOT one — it carries accessible={false}. */
  const buttons = () =>
    r.root.findAll(
      n =>
        typeof n.props?.onPress === 'function' &&
        n.props?.accessibilityRole === 'button',
    );
  /** Every surface that closes the card without being an announced button.
   * There are TWO on purpose: the full-screen scrim, and the one wrapping
   * the paragraph inside the scroll — a ScrollView takes the touch
   * responder, so without the inner one "a tap anywhere" would quietly stop
   * being true over the largest target on the card. */
  const dismissSurfaces = () =>
    r.root.findAll(
      n => typeof n.props?.onPress === 'function' && n.props?.accessible === false,
    );
  /** The scrim itself, told from its sibling by the ground it paints. */
  const veil = () =>
    dismissSurfaces().filter(
      n =>
        (StyleSheet.flatten(n.props.style) as ViewStyle | undefined)
          ?.backgroundColor === colors.backdrop,
    );
  /** The card's scrolling region — the explanation, and nothing else. */
  const scroll = () => r.root.findAllByType(ScrollView);
  const press = (target: ReactTestInstance) =>
    act(() => {
      target.props.onPress();
    });
  /** Flattened style, never undefined: an assertion about a target's size
   * must fail LOUDLY when the style went missing, not pass vacuously
   * against `undefined?.minWidth`. */
  const style = (target: ReactTestInstance): ViewStyle =>
    (StyleSheet.flatten(target.props.style) as ViewStyle | undefined) ?? {};
  return {
    text: () => textContent(r.toJSON()),
    buttons,
    veil,
    dismissSurfaces,
    scroll,
    press,
    glyph: () => buttons()[0],
    open: () => press(buttons()[0]),
    style,
  };
}

describe('InfoTap', () => {
  test('QUIET BY DEFAULT: the paragraph is behind the glyph, not under the row', () => {
    // Mutation: render the explanation inline "as well, just small" — the
    // owner's complaint survives the component that exists to cure it.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    expect(ui.text()).not.toContain('Kept on this device');
    // What IS on screen is one character of ink.
    expect(ui.text()).toBe('?');
  });

  test('one curious tap gives the full info', () => {
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    ui.open();
    expect(ui.text()).toContain('Kept on this device until you share it.');
    // …titled by the thing it is about, so an opened card is never orphaned.
    expect(ui.text()).toContain('the field log');
  });

  test('a tap ANYWHERE puts it away — no ✕ to find at night', () => {
    // Mutation: drop onPress from the veil and the only way out is a small
    // corner target, with dusty gloves, in the dark.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    ui.open();
    expect(ui.veil()).toHaveLength(1);
    ui.press(ui.veil()[0]);
    expect(ui.text()).not.toContain('Kept on this device');
  });

  test('"Got it" closes it too — the exit a screen reader can actually take', () => {
    // The veil is accessible={false} ON PURPOSE (it would otherwise swallow
    // the card into one unlabelled blob), which means a screen reader user
    // has no veil to tap. Mutation: delete this button and that camper is
    // stuck with the hardware back gesture or nothing.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    ui.open();
    const gotIt = ui.buttons().find(b => b.props.accessibilityLabel === 'Got it');
    expect(gotIt).toBeDefined();
    ui.press(gotIt!);
    expect(ui.text()).not.toContain('Kept on this device');
  });

  test('THE WAY OUT IS NEVER SCROLLED OFF: "Got it" sits outside the scroll', () => {
    // Mutation: put the whole card body — title, paragraph, button — inside
    // the ScrollView, or leave it as the plain View it was. The card stops
    // at 85% of the screen; a long explanation at Biggest with the OS's own
    // font scale on top then pushes "Got it" past that ceiling, and the
    // camper who needs the size dial most is the one holding a card whose
    // only remaining exit is a veil a screen reader cannot tap.
    //
    // A long explanation, because that is the case that breaks — but the
    // assertion is structural, not pixel-measured: react-test-renderer has
    // no layout engine, so what can be proven here is the SHAPE that makes
    // the overflow harmless. The button is not in the scrolling region.
    const ui = mount(
      <InfoTap topic="the field log" text={FIELD_LOG.repeat(12)} />,
    );
    ui.open();

    expect(ui.scroll()).toHaveLength(1);
    const scrolled = ui.scroll()[0];
    const gotItInside = scrolled.findAll(
      n => n.props?.accessibilityLabel === 'Got it',
    );
    expect(gotItInside).toHaveLength(0);
    // …and it is still on the card, reachable, not merely absent.
    expect(
      ui.buttons().some(b => b.props.accessibilityLabel === 'Got it'),
    ).toBe(true);
    // The explanation IS what scrolls — a scroll around nothing would pass
    // the assertion above while curing nothing.
    const insideTheScroll = scrolled
      .findAll(n => typeof n.props?.children === 'string')
      .map(n => n.props.children as string)
      .join(' ');
    expect(insideTheScroll).toContain('Kept on this device');
  });

  test('the card still stops at 85% — the scroll is the cure, not a taller card', () => {
    // Mutation: "fix" the overflow by dropping maxHeight instead. The card
    // then grows to the full screen height, the veil goes away with it, and
    // a tap-anywhere dismissal has nowhere left to land.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);
    ui.open();

    const card = ui
      .veil()[0]
      .findAll(n => ui.style(n).backgroundColor === colors.sand)[0];
    expect(ui.style(card).maxHeight).toBe('85%');
  });

  test('a tap on the paragraph itself still puts the card away', () => {
    // Mutation: drop the Pressable inside the scroll. Nothing looks wrong —
    // the veil around the card still closes — but the biggest target on the
    // card, the paragraph the camper is already looking at, goes dead,
    // because the ScrollView holds the responder that used to reach the
    // veil beneath it.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);
    ui.open();

    expect(ui.dismissSurfaces()).toHaveLength(2);
    const inCard = ui.dismissSurfaces().filter(n => n !== ui.veil()[0]);
    expect(inCard).toHaveLength(1);
    ui.press(inCard[0]);
    expect(ui.text()).not.toContain('Kept on this device');
  });

  test('the glyph announces WHICH explanation, by name', () => {
    // Mutation: label it "Help" or "More info" — a screen full of these
    // reads as a row of identical buttons, which is no navigation at all.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    expect(ui.glyph().props.accessibilityRole).toBe('button');
    expect(ui.glyph().props.accessibilityLabel).toBe('More about the field log');
    expect(ui.glyph().props.accessibilityState).toEqual({ expanded: false });

    ui.open();
    expect(ui.glyph().props.accessibilityState).toEqual({ expanded: true });
  });

  test('one dusty thumb: a small mark, a 44pt target', () => {
    // Mutation: shrink the target to the ring — 22pt is the size of the
    // drawn circle, and the owner's campers are wearing gloves.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);

    const box = ui.style(ui.glyph());
    expect(box.minWidth).toBeGreaterThanOrEqual(44);
    expect(box.minHeight).toBeGreaterThanOrEqual(44);
  });

  test('the card paints a real ground, so dark mode is not a see-through sheet', () => {
    // Mutation: leave the card transparent (or hardcode a cream) and the
    // opened text lands on whatever is behind it in one of the two modes —
    // the iBurn bug class the theme guard exists for.
    const ui = mount(<InfoTap topic="the field log" text={FIELD_LOG} />);
    ui.open();

    // The card is found by its painted ground rather than by walking the
    // tree: inside the veil, the node carrying the sand token IS the card.
    const grounds = ui
      .veil()[0]
      .findAll(n => ui.style(n).backgroundColor === colors.sand);
    expect(grounds.length).toBeGreaterThanOrEqual(1);
    // …and the veil itself is the themed scrim, never a bare transparent
    // layer that leaves the card floating on the screen behind it.
    expect(ui.style(ui.veil()[0]).backgroundColor).toBe(colors.backdrop);
  });

  test('children carry an explanation that needs more than one paragraph', () => {
    const ui = mount(
      <InfoTap topic="sharing cards">
        <Text>Cards travel phone-to-phone only.</Text>
        <Text>No server ever sees who camps where.</Text>
      </InfoTap>,
    );

    ui.open();
    expect(ui.text()).toContain('Cards travel phone-to-phone only.');
    expect(ui.text()).toContain('No server ever sees who camps where.');
  });

  test('TEXT WINS over children — one explanation per glyph, never two', () => {
    // Mutation: render both and a caller who passes each by accident ships
    // a card that says the same thing twice in different words.
    const ui = mount(
      <InfoTap topic="the field log" text={FIELD_LOG}>
        <Text>A second, competing explanation.</Text>
      </InfoTap>,
    );

    ui.open();
    expect(ui.text()).toContain('Kept on this device');
    expect(ui.text()).not.toContain('A second, competing explanation.');
  });
});

/** The source of a screen, for the read-the-file pins below. */
const readScreen = (p: string): string =>
  (require('fs') as { readFileSync(p: string, e: 'utf8'): string }).readFileSync(
    p,
    'utf8',
  );

/**
 * WIRING — the exemplar screen, read as source.
 *
 * A component with no caller is a prop (__tests__/exportsHaveCallers.test.ts
 * is this repo's monument to that lesson), and a Tufte pass that ADDS a
 * glyph while leaving the paragraph in place is worse than no pass at all.
 * Nothing renders SettingsScreen in this suite — it is a 1300-line screen
 * over the whole db, speech and model stack — so these pins read the file,
 * which is exactly how micProbe, radioTruthRendered and helpContent hold
 * their own Settings promises.
 */
describe('the Settings conversion', () => {
  const settings = readScreen('src/screens/SettingsScreen.tsx');

  /** Every <InfoTap … /> element, whole. A phrase found in one of these is
   * behind the tap; a phrase found outside them still renders inline. */
  const behindATap = [...settings.matchAll(/<InfoTap\b[\s\S]*?\/>/g)].map(m => m[0]);
  const occurrences = (phrase: string) => settings.split(phrase).length - 1;

  test('Settings USES InfoTap, it does not merely import it', () => {
    // Mutation: keep the import, drop the elements — the exact shape five
    // dead exports wore the night exportsHaveCallers was written.
    expect(settings).toMatch(/import \{ InfoTap \} from '\.\.\/components\/InfoTap'/);
    expect(behindATap.length).toBeGreaterThanOrEqual(4);
  });

  test.each([
    ['Voices marked offline work with no signal'],
    ['Included with Playa Pal and updated when the app is updated.'],
    ['Press and hold anything the Angel shows you'],
    ['Also on the Camp tab, under "Share & receive"'],
  ])('moved behind the ?, and moved — not copied: %s', phrase => {
    // Mutation: add the glyph and leave the paragraph where it was. The
    // screen grows a control and loses no ink, which is the failure this
    // whole pass exists to avoid. Exactly one occurrence, inside a tap.
    expect(occurrences(phrase)).toBe(1);
    expect(behindATap.some(el => el.includes(phrase))).toBe(true);
  });

  test.each([['Tap a voice to hear it.'], ['Nothing hidden.']])(
    'the clause that had to stay is still inline: %s',
    phrase => {
      // Mutation: sweep the whole sentence behind the tap and the row loses
      // its instruction / its state, leaving a bare ? explaining nothing.
      expect(occurrences(phrase)).toBe(1);
      expect(behindATap.some(el => el.includes(phrase))).toBe(false);
    },
  );

  test.each([
    ['Sharing is ON right now'],
    ['the radio is down — nobody can see your position right now'],
    ['pocket alerts arrive with a newer install'],
  ])('DIAGNOSIS IS NEVER HIDDEN: %s', phrase => {
    // The standing law for the rest of the fan-out. These lines appear ON a
    // condition and are the only warning a camper gets; a ? in front of one
    // is a phone lying politely. Mutation: convert a status line "for
    // consistency" and this fails before it ships.
    //
    // Presence, not a count: the first of these is also quoted in a comment
    // a few hundred lines up, and a guard that breaks when someone explains
    // the code is a guard people learn to edit around.
    expect(occurrences(phrase)).toBeGreaterThanOrEqual(1);
    expect(behindATap.some(el => el.includes(phrase))).toBe(false);
  });
});

/**
 * THE FAN-OUT — every other screen the pass reached, held to the same three
 * promises the exemplar is held to, in the same read-the-file idiom.
 *
 *   MOVED, NOT COPIED. A conversion that adds the glyph and leaves the
 *   paragraph grows a control and loses no ink, which is the exact failure
 *   the owner's ask is about. Exactly one occurrence, inside an <InfoTap>.
 *
 *   THE CLAUSE THAT HAD TO STAY. Every SHORTEN split a line that was doing
 *   two jobs. Sweep the whole sentence behind the tap and the row loses its
 *   instruction, its empty state or its count, leaving a bare ? explaining
 *   nothing.
 *
 *   DIAGNOSIS IS NEVER HIDDEN. The standing law, now carrying every screen's
 *   own status lines. These appear ON a condition and are the only warning a
 *   camper gets; a ? in front of one is a phone lying politely. Presence and
 *   not a count, because several are also quoted in the comments that explain
 *   them, and a guard that breaks when someone documents the code is a guard
 *   people learn to edit around.
 */
interface ScreenPins {
  file: string;
  moved: string[];
  kept: string[];
  diagnosis: string[];
}

const FAN_OUT: ScreenPins[] = [
  {
    file: 'src/screens/CampScreen.tsx',
    moved: [
      'Quick Share, LocalSend, no internet.',
      'Agree on the passphrase in person',
      'For anyone — a campmate, a friend, someone you just met.',
      'Two more ways to hand something over',
      'These travel camper-to-camper',
      'A memory, an event the guide missed',
      'Choose all the files belonging to one pack together.',
      'It works with no signal: what you post travels to campmates',
    ],
    kept: [
      'Nothing on the board yet — post a gift or a need above.',
      'Takes in anything a camper hands you',
      // The sharing audit's own invariant, which outranks this pass: signal
      // is named on every row in Share & receive, because it is the one
      // thing a camper cannot find out by trying. sharingSurfaces.test.ts
      // holds the same line from the other side.
      'that part needs signal',
    ],
    diagnosis: [
      // A security caveat about the data you are about to send, a row's
      // state, and the count of whose boards this phone is rendering.
      'Pilot — boards are not encrypted',
      'Set your name + camp passphrase',
      'Showing boards from',
    ],
  },
  {
    file: 'src/screens/CompassScreen.tsx',
    moved: [
      'Tap a pin to aim at it',
      'Tap a pin, friend, or landmark to select it',
    ],
    // "Home first, then newest" explains the ORDER of the rows on screen.
    kept: ['Home first, then newest.'],
    diagnosis: [
      'No signal yet — GPS needs open sky',
      'No pins yet',
      'Playa Pal uses your location for one thing',
    ],
  },
  {
    file: 'src/screens/FriendsSection.tsx',
    moved: [
      'Cards travel phone-to-phone only',
      '"Just for them" cards never ride "Beam friends"',
    ],
    kept: [],
    diagnosis: [
      'Not a playa address yet',
      'No friends collected yet',
      'Too many cards for one code',
    ],
  },
  {
    file: 'src/screens/LineageScreen.tsx',
    moved: ['People who brought others in'],
    kept: [],
    diagnosis: ['in an enabled pack any more'],
  },
  {
    file: 'src/screens/AddNoteSheet.tsx',
    moved: ['Notes travel with your camp beam'],
    kept: [],
    diagnosis: [],
  },
  {
    file: 'src/crews/WalkiePanel.tsx',
    moved: ['Some pairs of phones link at full quality'],
    kept: [],
    diagnosis: [
      // THE gold one. A quiet link is the difference between "nobody
      // answered" and "nobody heard you", and it names actual people.
      'A quiet link stopped answering a moment ago',
      'Video calls need a full-quality link',
    ],
  },
  {
    file: 'src/crews/PodLinks.tsx',
    moved: ['Each phone lists who it can reach'],
    kept: [],
    diagnosis: [],
  },
  {
    file: 'src/crews/PodMessages.tsx',
    moved: ['Messages move whenever Playa Pal is open on both phones'],
    kept: [],
    diagnosis: ['No messages waiting', "hasn't reached this phone yet"],
  },
  {
    file: 'src/crews/CrewSection.tsx',
    moved: [
      'Bluetooth, never the internet.',
      'One glance: which way, how far.',
      'They point a camera at this',
      'Not together?',
    ],
    kept: [
      // The consent question itself, and the no-pod lede.
      'Only while this is on — your pod sees which way',
      'Your pod is the people whose phones stay in touch',
    ],
    diagnosis: [
      'Sharing was on when the app last closed',
      'No friend cards on this phone yet',
    ],
  },
];

for (const { file, moved, kept, diagnosis } of FAN_OUT) {
  describe(`the ${file} conversion`, () => {
    const src = readScreen(file);
    const behindATap = [...src.matchAll(/<InfoTap\b[\s\S]*?\/>/g)].map(m => m[0]);
    const occurrences = (phrase: string) => src.split(phrase).length - 1;

    test('uses InfoTap, it does not merely import it', () => {
      // Mutation: keep the import, drop the elements — the exact shape five
      // dead exports wore the night exportsHaveCallers was written.
      expect(src).toMatch(/import \{ InfoTap \} from '[^']*InfoTap'/);
      expect(behindATap.length).toBeGreaterThanOrEqual(moved.length);
    });

    for (const phrase of moved) {
      test(`moved behind the ?, and moved — not copied: ${phrase}`, () => {
        expect(occurrences(phrase)).toBe(1);
        expect(behindATap.some(el => el.includes(phrase))).toBe(true);
      });
    }

    for (const phrase of kept) {
      test(`the clause that had to stay is still inline: ${phrase}`, () => {
        expect(occurrences(phrase)).toBeGreaterThanOrEqual(1);
        expect(behindATap.some(el => el.includes(phrase))).toBe(false);
      });
    }

    for (const phrase of diagnosis) {
      test(`DIAGNOSIS IS NEVER HIDDEN: ${phrase}`, () => {
        expect(occurrences(phrase)).toBeGreaterThanOrEqual(1);
        expect(behindATap.some(el => el.includes(phrase))).toBe(false);
      });
    }
  });
}

/**
 * THE ANGEL'S REST CARD — the one conversion whose copy is a BINDING, so no
 * amount of reading the file can settle it. `text={more}` comes out of
 * copyFor(), which means the source-reading pins above would pass on a card
 * that renders the whole paragraph inline anyway. This one is mounted.
 *
 * Four states, and the split is the same in every one: WHERE THE ANGEL IS
 * is the reason the card exists and stays on it; the reassurance about that
 * is what a curious tap holds.
 */
describe('the AngelRestCard conversion', () => {
  const { AngelRestCard } = require('../src/components/AngelRestCard');

  const CASES: {
    name: string;
    posture: { awake: boolean; constrained: boolean; chosen: boolean };
    state: string;
    reassurance: string;
  }[] = [
    {
      name: 'a small phone, resting',
      posture: { awake: false, constrained: true, chosen: false },
      state: 'This phone is on the small side, so she is resting',
      reassurance: 'Right Now, the map, your pods and the camp board',
    },
    {
      name: 'a small phone, woken on purpose',
      posture: { awake: true, constrained: true, chosen: true },
      state: 'You asked for her on this phone, and here she is.',
      reassurance: 'she is just slower here',
    },
    {
      name: 'a roomy phone, awake',
      posture: { awake: true, constrained: false, chosen: false },
      state: 'She comes up with the app and stays ready.',
      reassurance: 'Let her rest if you would rather',
    },
    {
      name: 'a roomy phone, resting',
      posture: { awake: false, constrained: false, chosen: true },
      state: 'She stays out of the way until you ask for her.',
      reassurance: 'Everything else works the same either way.',
    },
  ];

  for (const c of CASES) {
    test(`${c.name}: the state is on the card, the reassurance is behind the ?`, () => {
      // Mutation: hand `body` the whole paragraph again. The card grows a
      // glyph and loses no ink — the failure this pass exists to avoid —
      // and every static read in this file stays green.
      const ui = mount(
        <AngelRestCard posture={c.posture} onChange={() => {}} />,
      );

      expect(ui.text()).toContain(c.state);
      expect(ui.text()).not.toContain(c.reassurance);

      ui.open();
      expect(ui.text()).toContain(c.reassurance);
      // …and the state is still readable behind the opened card's title.
      expect(ui.text()).toContain('the Angel resting');
    });
  }

  test('a busy card says what is happening, and still carries its ?', () => {
    // Mutation: drop the glyph while busy and the explanation vanishes for
    // exactly as long as the camper is waiting and most likely to want it.
    const ui = mount(
      <AngelRestCard
        posture={{ awake: false, constrained: true, chosen: false }}
        busy
        onChange={() => {}}
      />,
    );

    expect(ui.text()).toContain('Letting her rest…');
    ui.open();
    expect(ui.text()).toContain('Right Now, the map, your pods and the camp board');
  });
});
