/**
 * The in-app Help surface, held to the three things that make it worth
 * shipping (owner ask 2026-08-25: "any final actual limitations are fine,
 * as long as they are clearly communicated in readme and in-app help").
 *
 *  1. THE VOCABULARY LAW. Help speaks capability and ordinary radio names,
 *     never engineering ones (docs/WALKIE-LADDER.md §5a; podStatus.ts's
 *     header owns the rule). Bluetooth and Wi-Fi are deliberately NOT in
 *     this ban list, unlike podStatus's: a status row must not invite radio
 *     superstition, but Help is precisely where a camper is owed the plain
 *     physical reason a call button is missing — and the app's existing
 *     copy already says "Bluetooth" and "shared camp Wi-Fi" out loud.
 *
 *  2. THE LIMITATION SET IS COVERED. This suite carries its OWN list of
 *     what a camper must be told, independent of the content module's own
 *     ordering array — otherwise the assertion would be the content
 *     checking itself. Delete a limitation and this dies.
 *
 *  3. README AND HELP CANNOT DRIFT APART SILENTLY. The cheapest honest
 *     coupling: shared key phrases, asserted present in BOTH. It does not
 *     prove two prose passages agree; it fires the moment one side is
 *     rewritten and the other forgotten, which is how they actually
 *     disagree.
 *
 * Plus the wiring pin, in the podStatus.test.ts source-reading idiom: a
 * Help screen nobody can open is not shipped.
 */
import React from 'react';
import {
  HELP_LIMITATIONS,
  HELP_LIMITS_INTRO,
  HELP_LIMITS_TITLE,
  HELP_SECTIONS,
  README_ANCHORS,
  type LimitationTopic,
} from '../src/help/helpContent';
import { HelpScreen } from '../src/screens/HelpScreen';

/** Every camper-visible string in the module, one flat list. */
const everyPhrase = (): string[] => [
  ...HELP_SECTIONS.flatMap(s => [s.title, ...s.body]),
  ...HELP_LIMITATIONS.flatMap(l => [l.title, l.body]),
  HELP_LIMITS_TITLE,
  HELP_LIMITS_INTRO,
];

// The walkieLadder.test.ts source-reading idiom (typed require, no
// @types/node in this tree).
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

describe('capability words, never mechanism (§5a, extended to Help)', () => {
  // podStatus.test.ts's ban list MINUS wi-fi and bluetooth — see the header
  // for why those two are allowed exactly here and nowhere else.
  const BANNED =
    /\b(ble|gatt|aware|nan|datapath|rung|ladder|udp|mdns|subnet|protocol)\b/i;

  test('no sentence a camper reads speaks a protocol word', () => {
    // Mutation: explain the call button's absence as "BLE has no datapath"
    // — true, useless, and the exact door to rung superstition §5a closes.
    for (const p of everyPhrase()) {
      expect(p).not.toMatch(BANNED);
    }
  });

  test('the radios ARE named in the words the rest of the app uses', () => {
    // Mutation: scrub Bluetooth and Wi-Fi out of Help too — the camper is
    // left with "sometimes there is no call button" and no way to act on
    // it. WalkiePanel's own hint already says both words on screen.
    const all = everyPhrase().join('\n');
    expect(all).toMatch(/Bluetooth/);
    expect(all).toMatch(/shared camp Wi-Fi/);
  });

  test('an edge is stated calmly — no alarm vocabulary, no apology', () => {
    // Mutation: word a limitation as failure ("broken", "unfortunately",
    // "we could not") — the hippo register forbids self-pity, and a camper
    // making a plan needs a fact, not a mood.
    for (const l of HELP_LIMITATIONS) {
      expect(`${l.title} ${l.body}`).not.toMatch(
        /\b(unfortunately|sorry|sadly|broken|failure|we could not|we couldn't)\b/i,
      );
    }
  });

  test('at most one emoji in the whole surface (the hippo register)', () => {
    // Mutation: decorate every section heading — the Angel's own rule is
    // one tasteful emoji at most, and Help is her register too.
    const emoji = everyPhrase()
      .join('')
      .match(/\p{Extended_Pictographic}/gu);
    expect((emoji ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe('the limitation set covers what a camper must be told', () => {
  /**
   * This suite's OWN list — deliberately not imported from the module it
   * checks. Each entry is the owner's named topic plus a phrase that
   * proves the copy still says the thing, not merely that a key survived.
   */
  const REQUIRED: { topic: LimitationTopic; says: RegExp }[] = [
    // iPhones need the app open to receive; pocketed delivery is coming.
    { topic: 'iphone-background', says: /iPhone[\s\S]*open/i },
    // A call needs the newer direct link or a shared Wi-Fi; a Bluetooth-only
    // podmate shows no call button, on purpose.
    { topic: 'video-call-link', says: /no call button/i },
    // A very large pod outgrows Bluetooth; mail moves a pair at a time.
    { topic: 'big-pod-reach', says: /one pair at a time/i },
    // A small-memory phone starts with the Angel resting — and Help says
    // where the switch lives, or the limitation is a dead end.
    { topic: 'small-phone-angel', says: /Settings[\s\S]*Angel & voice/i },
    // Short pod code, unencrypted boards: playa trust, not bank trust.
    { topic: 'playa-trust', says: /playa trust, not bank trust/i },
  ];

  test.each(REQUIRED)('$topic is present and still says it', ({ topic, says }) => {
    // Mutation: drop any one of these limitations, or hollow its copy out
    // to a heading — the owner's honesty bar quietly stops being met while
    // every other test in this file stays green.
    const found = HELP_LIMITATIONS.find(l => l.topic === topic);
    expect(found).toBeDefined();
    expect(`${found!.title} ${found!.body}`).toMatch(says);
  });

  test('every limitation carries real copy, not a stub', () => {
    for (const l of HELP_LIMITATIONS) {
      expect(l.title.length).toBeGreaterThan(8);
      expect(l.body.length).toBeGreaterThan(80);
    }
  });

  test('the topics are unique — one edge, one card', () => {
    expect(new Set(HELP_LIMITATIONS.map(l => l.topic)).size).toBe(
      HELP_LIMITATIONS.length,
    );
  });
});

describe('the three questions the surface exists to answer', () => {
  const sectionIds = HELP_SECTIONS.map(s => s.id);

  test('offline, the connection story, and the edges each get their place', () => {
    // Mutation: fold the connection story into a sentence of the offline
    // section — the camper asking "why can I message Dusty but not call
    // him" has nowhere to land.
    expect(sectionIds).toContain('offline');
    expect(sectionIds).toContain('pod');
    expect(HELP_LIMITATIONS.length).toBeGreaterThan(0);
  });

  test('the offline section names what needs the internet ONCE', () => {
    // Mutation: claim everything is offline full stop — the camper drives
    // past the gate with no model and no offline voice, which is exactly
    // the failure the README's wifi-before-you-leave note exists to stop.
    const offline = HELP_SECTIONS.find(s => s.id === 'offline');
    expect(offline).toBeDefined();
    expect(offline!.body.join(' ')).toMatch(/internet|download/i);
  });

  test('the pod section says a lost link never costs membership (§1)', () => {
    // Mutation: describe an out-of-reach podmate as dropped or lost — the
    // ladder's own invariant, inverted, in the one place a camper reads it.
    const pod = HELP_SECTIONS.find(s => s.id === 'pod');
    expect(pod!.body.join(' ')).toMatch(/still a podmate/i);
  });

  test('every section has a title and at least one paragraph', () => {
    for (const s of HELP_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.body.length).toBeGreaterThan(0);
      for (const p of s.body) {
        expect(p.length).toBeGreaterThan(40);
      }
    }
  });

  test('section ids are unique — they are render keys', () => {
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
  });
});

describe('README and Help cannot drift apart silently', () => {
  const readme = readSource('README.md');
  const helpText = everyPhrase().join('\n');

  test('there are anchors to hold at all', () => {
    // Mutation: empty README_ANCHORS — [].every() is true, so the coupling
    // below would pass vacuously forever.
    expect(README_ANCHORS.length).toBeGreaterThanOrEqual(5);
  });

  test.each(README_ANCHORS)('README carries the shared phrase: %s', anchor => {
    // Mutation: rewrite the README's limitations without the in-app words
    // — two honest lists that no longer say the same thing, which is the
    // drift the owner's ask is actually about.
    expect(readme).toContain(anchor);
  });

  test.each(README_ANCHORS)('Help carries the shared phrase: %s', anchor => {
    expect(helpText).toContain(anchor);
  });

  test('the README points at the in-app surface by its real name', () => {
    // Mutation: rename the Settings row and leave the README pointing at
    // a row that no longer exists — the on-playa reader is sent nowhere.
    expect(readme).toContain('How Playa Pal works');
    expect(readSource('src/screens/SettingsScreen.tsx')).toContain(
      'How Playa Pal works',
    );
  });
});

describe('wiring: a Help screen someone can actually open', () => {
  const settings = readSource('src/screens/SettingsScreen.tsx');
  const screen = readSource('src/screens/HelpScreen.tsx');

  test('Settings mounts HelpScreen — a surface nobody can reach is not shipped', () => {
    // Mutation: delete the <HelpScreen mount (or the row that sets its
    // state) — every content assertion above stays green while the owner's
    // ask silently vanishes from the app.
    expect(settings).toMatch(/<HelpScreen\b/);
    expect(settings).toMatch(/setHelpScreen\(true\)/);
  });

  test('the row lives in the Help & about group, not adrift', () => {
    const groupAt = settings.indexOf("<Text style={styles.sectionTitle}>Help & about");
    const rowAt = settings.indexOf('setHelpScreen(true)');
    expect(groupAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(groupAt);
  });

  test('HelpScreen owns no copy of its own — one source of truth', () => {
    // Mutation: paste a sentence straight into the JSX. Two copies of one
    // honest claim is how a limitation goes stale in exactly one of them.
    expect(screen).toMatch(/from '\.\.\/help\/helpContent'/);
    // Every JSX text node is either a binding, the back affordance, or the
    // screen's own title.
    const literals = (screen.match(/>\s*[A-Za-z][^<>{}]{12,}</g) ?? []).map(s =>
      s.slice(1, -1).trim(),
    );
    expect(literals).toEqual(['How Playa Pal works']);
  });

  test('hardware back closes Help instead of backgrounding the app', () => {
    // Mutation: drop the BackHandler — the PackReader field lesson (P7,
    // 08-20) relearned by the next camper who taps back inside Help.
    expect(screen).toMatch(/hardwareBackPress/);
  });
});

describe('the screen actually renders the content (compiles is not shipped)', () => {
  // The RN preset supplies react-test-renderer (rightNowEmptyState's idiom).
  const TestRenderer = require('react-test-renderer');
  const RN = require('react-native');

  function textOf(): string {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(<HelpScreen onClose={() => {}} />);
    });
    return root.root
      .findAllByType(RN.Text)
      .map((t: any) =>
        Array.isArray(t.props.children)
          ? t.props.children.join('')
          : String(t.props.children),
      )
      .join('\n');
  }

  test('every section heading and every limitation reaches the screen', () => {
    // Mutation: render only HELP_SECTIONS and forget the limitations map —
    // the module stays perfect and the camper never reads the honest half.
    const rendered = textOf();
    for (const s of HELP_SECTIONS) {
      expect(rendered).toContain(s.title);
    }
    for (const l of HELP_LIMITATIONS) {
      expect(rendered).toContain(l.title);
      expect(rendered).toContain(l.body);
    }
    expect(rendered).toContain(HELP_LIMITS_TITLE);
  });

  test('the way out is labelled, and pressing it actually closes', () => {
    // Mutation: wire the back affordance to nothing (or to a second piece
    // of state) — a full-screen surface with no exit is the worst thing
    // this pattern can ship, and no static read would catch it.
    const closed: string[] = [];
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(<HelpScreen onClose={() => closed.push('x')} />);
    });
    const back = root.root
      .findAll((n: any) => n.props?.accessibilityLabel === 'Close help')
      .filter((n: any) => typeof n.props.onPress === 'function');
    expect(back.length).toBeGreaterThan(0);
    TestRenderer.act(() => back[0].props.onPress());
    expect(closed).toEqual(['x']);
  });
});
