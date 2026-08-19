/**
 * The pack-aware Right Now empty state (P2-7): when no event pack is
 * enabled (or every enabled pack has zero events), the screen must say
 * "No event pack is enabled — turn one on in Settings › Public packs." instead of the
 * false-empty "Nothing matching right now…" — which reads as if the city
 * has nothing on tonight when really the source is off. The two genuine
 * no-match variants must be preserved when a pack IS enabled.
 */
import React from 'react';
import { RightNowScreen } from '../src/screens/RightNowScreen';

// Drive the pack-enabled answer through listPacks; everything else stays
// real but inert for this test.
const mockListPacks = jest.fn();

jest.mock('../src/events/db', () => ({
  eventDates: () => [],
  listPacks: () => mockListPacks(),
}));

jest.mock('../src/rightnow/rightNow', () => {
  const actual = jest.requireActual('../src/rightnow/rightNow');
  return {
    ...actual,
    rightNow: () => ({ now: [], next: [] }),
    browseEvents: () => [],
  };
});

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
  beforeEach(() => mockListPacks.mockReset());

  it('no enabled event pack -> the no-pack state, NOT a false empty', () => {
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: false, eventCount: 5000 },
      { id: 'survival-guide', enabled: true, eventCount: 0 },
    ]);
    const t = textOf(render());
    expect(t).toContain('No event pack is enabled — turn one on in Settings › Public packs.');
    expect(t).not.toContain('Nothing matching right now');
  });

  it('an enabled pack with zero events is ALSO the no-pack state (source empty, not sparse)', () => {
    mockListPacks.mockReturnValue([
      { id: 'brc-events-2026', enabled: true, eventCount: 0 },
    ]);
    const t = textOf(render());
    expect(t).toContain('No event pack is enabled — turn one on in Settings › Public packs.');
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
