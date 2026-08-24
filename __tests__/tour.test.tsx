/**
 * The replayable feature tour (0.7.3, docs/NTY-PATTERNS.md §4): five
 * cards paged with Next/Back, ✕ to leave early, progress dots, and a
 * tour_seen settings flag the tour writes ITSELF — on finishing and on an
 * early ✕ alike (a dismissal is a choice; the Settings replay row is the
 * road back, not a nag on next launch).
 */
import React from 'react';
import { Tour, TOUR_CARDS } from '../src/tour/Tour';
import { markTourSeen, tourSeen, TOUR_SEEN_KEY } from '../src/tour/tourState';

// The settings table, reduced to a Map — tourState is the only db consumer.
const mockStore = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => mockStore.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    mockStore.set(key, value);
  },
}));

const TestRenderer = require('react-test-renderer');

function render(onDone: () => void) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(<Tour onDone={onDone} />);
  });
  return root;
}

function textOf(root: any): string {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => String(t.props.children))
    .join('\n');
}

/** Find the Text with this exact content and press its enclosing Pressable. */
function pressText(root: any, label: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => String(t.props.children) === label);
  expect(text).toBeTruthy();
  let node: any = text;
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  TestRenderer.act(() => node.props.onPress());
}

const HEADLINES = [
  'Right now, near you',
  'Tap the city, follow the arrow',
  'An Angel in your pocket',
  'Your camp, on one board',
  'Airplane mode is home',
];

beforeEach(() => mockStore.clear());

describe('the feature tour', () => {
  it('ships exactly the five surfaces, in order', () => {
    expect(TOUR_CARDS.map(c => c.headline)).toEqual(HEADLINES);
  });

  it('opens on card 1, one card at a time', () => {
    const t = textOf(render(jest.fn()));
    expect(t).toContain(HEADLINES[0]);
    for (const headline of HEADLINES.slice(1)) {
      expect(t).not.toContain(headline);
    }
  });

  it('Next pages through all five cards; Back returns', () => {
    const root = render(jest.fn());
    for (let i = 1; i < HEADLINES.length; i++) {
      pressText(root, 'Next');
      expect(textOf(root)).toContain(HEADLINES[i]);
    }
    // the last card offers the finish verb, not another Next
    expect(textOf(root)).toContain('Let’s go');
    expect(textOf(root)).not.toContain('Next');
    pressText(root, 'Back');
    expect(textOf(root)).toContain(HEADLINES[3]);
  });

  it('✕ closes early: onDone fires and the tour still counts as seen', () => {
    const onDone = jest.fn();
    const root = render(onDone);
    pressText(root, '✕');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(tourSeen()).toBe(true);
  });

  it('finishing the last card calls onDone and marks tour_seen', () => {
    const onDone = jest.fn();
    const root = render(onDone);
    expect(tourSeen()).toBe(false);
    for (let i = 1; i < HEADLINES.length; i++) {
      pressText(root, 'Next');
    }
    pressText(root, 'Let’s go');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockStore.get(TOUR_SEEN_KEY)).toBe('1');
    expect(tourSeen()).toBe(true);
  });
});

describe('tourState', () => {
  it('unseen until marked, then seen', () => {
    expect(tourSeen()).toBe(false);
    markTourSeen();
    expect(tourSeen()).toBe(true);
  });
});
