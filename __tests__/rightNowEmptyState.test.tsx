/**
 * The pack-aware Right Now empty state (P2-7): when no event pack is
 * enabled (or every enabled pack has zero events), the screen must say
 * "No event pack is enabled — turn one on in Settings › Offline content ›
 * Public packs." instead of the
 * false-empty "Nothing matching right now…" — which reads as if the city
 * has nothing on tonight when really the source is off. The two genuine
 * no-match variants must be preserved when a pack IS enabled.
 */
import React from 'react';
import { RightNowScreen } from '../src/screens/RightNowScreen';

// Drive the pack-enabled answer through listPacks; everything else stays
// real but inert for this test.
const mockListPacks = jest.fn();
const mockEventDates = jest.fn(() => [] as string[]);

jest.mock('../src/events/db', () => ({
  eventDates: () => mockEventDates(),
  listPacks: () => mockListPacks(),
}));

jest.mock('../src/rightnow/rightNow', () => {
  const actual = jest.requireActual('../src/rightnow/rightNow');
  return {
    ...actual,
    rightNow: () => ({ now: [], next: [] }),
    browseEvents: () => [],
    favoriteEvents: () => [],
  };
});

// Favorites are db-backed; this file's db mock has no store behind it.
jest.mock('../src/events/favorites', () => ({
  favKey: (e: any) => `${e.title}\n${e.date}\n${e.time_start}`,
  favoriteKeySet: () => new Set<string>(),
  favoritesRevision: () => 0,
  subscribeFavoritesChanged: () => () => {},
  toggleFavorite: jest.fn(),
  isFavorite: () => false,
}));

jest.mock('../src/geo/cityGeometry', () => ({ getCityGeometry: () => null }));
jest.mock('../src/geo/useLocation', () => ({ useLocation: () => ({ position: null }) }));
jest.mock('../src/geo/brcGeo', () => ({
  addressToLatLon: () => null,
  latLonToBrc: () => null,
}));

// The screen keeps "now" fresh on a 60s interval; fake timers so the test
// environment isn't torn down with a live interval re-rendering mid-exit.
jest.useFakeTimers();

// Render with the RN test renderer. The preset supplies react-test-renderer.
const TestRenderer = require('react-test-renderer');

function render() {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(
      <RightNowScreen onAskAngel={() => {}} onOpenCompass={() => {}} />,
    );
  });
  return root;
}

function textOf(root: any): string {
  return root.root.findAllByType(require('react-native').Text)
    .map((t: any) => String(t.props.children))
    .join('\n');
}

describe('Right Now empty state is pack-aware (P2-7)', () => {
  beforeEach(() => {
    mockListPacks.mockReset();
    mockEventDates.mockReturnValue([]);
  });

  it('no enabled event pack -> the no-pack state, NOT a false empty', () => {
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: false, eventCount: 5000 },
      { id: 'survival-guide', enabled: true, eventCount: 0 },
    ]);
    const t = textOf(render());
    expect(t).toContain('No event pack is enabled — turn one on in Settings › Offline content › Public packs.');
    expect(t).not.toContain('Nothing matching right now');
  });

  it('an enabled pack with zero events is ALSO the no-pack state (source empty, not sparse)', () => {
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: true, eventCount: 0 },
    ]);
    const t = textOf(render());
    expect(t).toContain('No event pack is enabled — turn one on in Settings › Offline content › Public packs.');
  });

  it('an enabled pack WITH events keeps the genuine no-match variant', () => {
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: true, eventCount: 5276 },
    ]);
    const t = textOf(render());
    expect(t).toContain('Nothing matching right now');
    expect(t).not.toContain('No event pack is enabled');
  });
});

describe('the Faves itinerary (0.7.2)', () => {
  beforeEach(() => {
    mockListPacks.mockReset();
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: true, eventCount: 5283 },
    ]);
    mockEventDates.mockReturnValue([]);
  });

  it('empty Faves teaches the heart, neutral about day vs night', () => {
    const root = render();
    const chip = root.root
      .findAllByType(require('react-native').Text)
      .find((t: any) => String(t.props.children) === '♥ Faves');
    expect(chip).toBeTruthy();
    let node: any = chip;
    while (node && !node.props.onPress) {
      node = node.parent;
    }
    TestRenderer.act(() => node.props.onPress());
    const t = textOf(root);
    expect(t).toContain('No faves yet — tap the ♡ on any event to line up your day or night');
    // the faves view is the whole-week itinerary: no time-of-day row
    expect(t).not.toContain('Afternoon');
  });
});

describe('before the gates open, the empty state tells the truth', () => {
  // Found by USING the app on a real Pixel 7 on 2026-08-20, ten days before
  // Black Rock City opens: "Now" correctly finds nothing, and the generic
  // copy then blamed the user's vibe and packs -- "try a different vibe,
  // ask the Angel, or check your packs in Settings" -- sending them hunting
  // for a problem that does not exist. Every tester, and every burner who
  // installs the app while packing, met that screen.
  beforeEach(() => {
    mockListPacks.mockReset();
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: true, eventCount: 5283 },
    ]);
  });

  it('names the opening day and points at All week, instead of blaming the vibe', () => {
    // every event is in the future relative to the fake clock below
    mockEventDates.mockReturnValue(['2026-08-30', '2026-08-31']);
    jest.setSystemTime(new Date(2026, 7, 20, 18, 0, 0)); // Aug 20, ten days out
    const t = textOf(render());
    expect(t).toContain('Black Rock City opens');
    expect(t).toContain('All week');
    expect(t).not.toContain('try a different vibe');
  });

  it('once the burn is running, the ordinary no-match copy comes back', () => {
    mockEventDates.mockReturnValue(['2026-08-30', '2026-08-31']);
    jest.setSystemTime(new Date(2026, 7, 31, 12, 0, 0)); // Aug 31, mid-burn
    const t = textOf(render());
    expect(t).toContain('try a different vibe');
    expect(t).not.toContain('Black Rock City opens');
  });

  it('on the opening day itself it is no longer "before"', () => {
    mockEventDates.mockReturnValue(['2026-08-30']);
    jest.setSystemTime(new Date(2026, 7, 30, 9, 0, 0)); // Aug 30, gates day
    const t = textOf(render());
    expect(t).not.toContain('Black Rock City opens');
  });
});
