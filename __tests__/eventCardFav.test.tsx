/**
 * The heart on the event card (0.7.2): self-wired to the favorites store,
 * so EVERY surface that renders an EventCard — Right Now, browse, the
 * Angel's chat answers — gets favoriting with zero parent wiring. This
 * file pins the toggle round-trip and the accessibility labels.
 */
import React from 'react';

const mockState = {
  favs: new Set<string>(),
  rev: 0,
  subs: new Set<() => void>(),
};
const mockKey = (e: any) => `${e.title}\u0000${e.date}\u0000${e.time_start}`;
const mockToggle = jest.fn((e: any) => {
  const k = mockKey(e);
  if (mockState.favs.has(k)) {
    mockState.favs.delete(k);
  } else {
    mockState.favs.add(k);
  }
  mockState.rev += 1;
  mockState.subs.forEach(s => s());
});

jest.mock('../src/events/favorites', () => ({
  favKey: (e: any) => mockKey(e),
  favoriteKeySet: () => mockState.favs,
  favoritesRevision: () => mockState.rev,
  subscribeFavoritesChanged: (cb: () => void) => {
    mockState.subs.add(cb);
    return () => mockState.subs.delete(cb);
  },
  toggleFavorite: (e: any) => mockToggle(e),
}));

import { EventCard } from '../src/components/EventCard';

const TestRenderer = require('react-test-renderer');

const event = {
  id: 7,
  pack_id: 'brc-events-2026',
  title: 'Sunrise Yoga',
  desc: 'Stretch with the dawn.',
  day: 'Monday',
  date: '2026-08-31',
  time_start: '06:30',
  time_end: '07:30',
  camp: 'Camp Bend',
  location: '3:00 & C',
  source_kind: '',
  note_key: '',
} as any;

function render() {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(<EventCard event={event} />);
  });
  return root;
}

function heartNode(root: any) {
  return root.root
    .findAll((n: any) => n.props && n.props.accessibilityLabel &&
      /Faves/.test(n.props.accessibilityLabel))[0];
}

beforeEach(() => {
  mockState.favs = new Set();
  mockState.rev = 0;
  mockState.subs.clear();
  mockToggle.mockClear();
});

test('the heart starts hollow, toggles the store, and fills on re-render', () => {
  const root = render();
  const heart = heartNode(root);
  expect(heart.props.accessibilityLabel).toBe('Save to Faves');
  TestRenderer.act(() => heart.props.onPress());
  expect(mockToggle).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sunrise Yoga' }));
  const after = heartNode(root);
  expect(after.props.accessibilityLabel).toBe('Remove from Faves');
  const texts = root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => String(t.props.children));
  expect(texts).toContain('♥');
  expect(texts).not.toContain('♡');
});

test('a toggle from ANOTHER surface re-renders this card (shared store)', () => {
  const root = render();
  TestRenderer.act(() => {
    mockToggle(event); // e.g. the same event hearted from a chat answer
  });
  expect(heartNode(root).props.accessibilityLabel).toBe('Remove from Faves');
});
