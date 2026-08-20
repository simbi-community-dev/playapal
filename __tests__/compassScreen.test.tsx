/**
 * CompassScreen view-mode regressions (owner report 2026-08-20: the city
 * map was invisible behind an unlabeled emoji, defaulting to the arrow):
 *   with geometry, the MAP is the landing view and the pill offers Arrow;
 *   the pill toggles to the arrow view and back;
 *   without geometry there is no pill, and the arrow floor visibly
 *   renders its honest GPS state instead of a blank stage.
 */

import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

const geoState: { geo: object | null } = { geo: {} };

jest.mock('../src/geo/cityGeometry', () => ({
  getCityGeometry: () => geoState.geo,
}));
jest.mock('../src/geo/useLocation', () => ({
  useLocation: () => ({ position: null, status: 'searching' }),
}));
jest.mock('../src/geo/useHeading', () => ({
  useHeading: () => ({ headingDeg: null }),
}));
jest.mock('../src/events/db', () => ({
  getDb: () => ({
    execute: () => ({ rows: { _array: [], length: 0, item: () => null } }),
  }),
}));
const cardState: { address: string } = { address: '' };
jest.mock('../src/friends/friendCard', () => ({
  listFriends: () => [],
  subscribeFriendsChanged: () => () => {},
  getMyCard: () => ({ name: 'Dusty', camp: 'Camp', address: cardState.address }),
}));
jest.mock('../src/geo/brcGeo', () => ({
  ...jest.requireActual('../src/geo/brcGeo'),
  addressToLatLon: (address: string) =>
    address ? { lat: 40.78, lon: -119.2, label: address } : null,
}));
const pinState: {
  pins: Array<{ id: string; label: string; lat: number; lon: number; savedAt: number }>;
} = { pins: [] };
jest.mock('../src/geo/waypoints', () => ({
  HOME_LABEL: 'Home',
  homePin: () => null,
  listPins: () => pinState.pins,
  removePin: () => {},
  savePin: () => {},
}));
// What the map reports the finger landed ON, when the feature button below
// is pressed. Null in the tests that only exercise a bare-ground tap.
const featureState: { hit: object | null } = { hit: null };
jest.mock('../src/screens/CityMap', () => {
  const ReactActual = require('react');
  const { Pressable, View } = require('react-native');
  return {
    CityMap: (props: { onMapTap?: (t: object) => void; onFeatureTap?: (h: object) => void }) =>
      ReactActual.createElement(
        View,
        null,
        ReactActual.createElement(Pressable, {
          key: 'ground',
          testID: 'city-map',
          onPress: () =>
            props.onMapTap?.({ label: 'Map spot — 4:30 & E', lat: 40.79, lon: -119.21 }),
        }),
        ReactActual.createElement(Pressable, {
          key: 'feature',
          testID: 'city-map-feature',
          onPress: () => featureState.hit && props.onFeatureTap?.(featureState.hit),
        }),
      ),
  };
});

const TestRenderer = require('react-test-renderer');
const { CompassScreen } = require('../src/screens/CompassScreen');

const renderScreen = (): ReactTestRenderer => {
  const holder: { root?: ReactTestRenderer } = {};
  TestRenderer.act(() => {
    holder.root = TestRenderer.create(
      React.createElement(CompassScreen, { initialTarget: null, onClose: () => {} }),
    );
  });
  return holder.root!;
};

const texts = (root: ReactTestRenderer): string[] =>
  root.root
    .findAllByType(require('react-native').Text)
    .map((t: ReactTestInstance) =>
      Array.isArray(t.props.children)
        ? t.props.children.join('')
        : String(t.props.children),
    );

const byLabel = (
  root: ReactTestRenderer,
  frag: string,
): ReactTestInstance | undefined =>
  root.root.findAll(
    (n: ReactTestInstance) =>
      typeof n.props?.onPress === 'function' &&
      String(n.props?.accessibilityLabel ?? '').includes(frag),
  )[0];

const mapNodes = (root: ReactTestRenderer): ReactTestInstance[] =>
  root.root.findAllByProps({ testID: 'city-map' });

describe('CompassScreen view mode', () => {
  beforeEach(() => {
    cardState.address = '';
  });

  test('with geometry: the map is the LANDING view and the pill offers Arrow', () => {
    geoState.geo = {};
    const root = renderScreen();
    expect(mapNodes(root).length).toBeGreaterThan(0);
    expect(texts(root).some(t => t.includes('Arrow'))).toBe(true);
  });

  test('the pill toggles to the arrow view and back to the map', () => {
    geoState.geo = {};
    const root = renderScreen();
    const pill = byLabel(root, 'arrow');
    expect(pill).toBeTruthy();
    TestRenderer.act(() => pill!.props.onPress());
    expect(mapNodes(root)).toHaveLength(0);
    // positive arrow-stage observable: with these mocks the arrow floor
    // shows its GPS wait state — a blanked map-off branch fails here
    expect(texts(root).some(t => t.includes('Waiting for GPS'))).toBe(true);
    expect(texts(root).some(t => t.includes('Map'))).toBe(true);
    const pill2 = byLabel(root, 'city map');
    expect(pill2).toBeTruthy();
    TestRenderer.act(() => pill2!.props.onPress());
    expect(mapNodes(root).length).toBeGreaterThan(0);
  });

  test('without geometry: no pill, and the arrow floor SHOWS its GPS state', () => {
    geoState.geo = null;
    const root = renderScreen();
    expect(mapNodes(root)).toHaveLength(0);
    expect(byLabel(root, 'arrow')).toBeUndefined();
    expect(byLabel(root, 'city map')).toBeUndefined();
    // a positive observable: the floor renders the honest waiting state,
    // so blanking the fallback stage entirely would fail here
    expect(texts(root).some(t => t.includes('Waiting for GPS'))).toBe(true);
  });
});

describe('card address as default Home (owner ask 2026-08-20)', () => {
  test('no pins + a camp address on my card: the Home (camp) chip renders and is the landing selection', () => {
    geoState.geo = {};
    cardState.address = '7:32 & C';
    const root = renderScreen();
    const chips = texts(root);
    expect(chips.some(t => t.includes('Home (camp)'))).toBe(true);
    // the derived target is live: its label carries the address
    expect(chips.some(t => t.includes('7:32 & C'))).toBe(true);
  });

  test('no address and no pins: no Home (camp) chip appears', () => {
    geoState.geo = {};
    cardState.address = '';
    const root = renderScreen();
    expect(texts(root).some(t => t.includes('Home (camp)'))).toBe(false);
  });
});

describe('tap-to-navigate (owner ask 2026-08-20)', () => {
  test('a map tap surfaces a selected Map-spot chip carrying the address', () => {
    geoState.geo = {};
    const root = renderScreen();
    const map = root.root.findAllByProps({ testID: 'city-map' })
      .find((n: ReactTestInstance) => typeof n.props?.onPress === 'function');
    expect(map).toBeTruthy();
    TestRenderer.act(() => map!.props.onPress());
    expect(texts(root).some(t => t.includes('Map spot — 4:30 & E'))).toBe(true);
  });
});

describe('tapping an existing feature on the map (owner field test 2026-08-20)', () => {
  // "pins you've created can't be selected on the map itself, only by the
  // button below. this leads to confusing double-pin creation potential."
  // A pin tap must SELECT the pin — the same state its chip sets — and must
  // NOT mint the 📌 map-spot chip on top of it.
  const tapFeature = (root: ReactTestRenderer): void => {
    const btn = root.root
      .findAllByProps({ testID: 'city-map-feature' })
      .find((n: ReactTestInstance) => typeof n.props?.onPress === 'function');
    expect(btn).toBeTruthy();
    TestRenderer.act(() => btn!.props.onPress());
  };

  /** Chip labels carry their own selected style; count the live entries. */
  const chipSelected = (root: ReactTestRenderer, label: string): boolean => {
    const node = root.root
      .findAllByType(require('react-native').Text)
      .find((t: ReactTestInstance) => String(t.props.children) === label);
    expect(node).toBeTruthy();
    return ([] as unknown[]).concat(node!.props.style).filter(Boolean).length > 1;
  };

  beforeEach(() => {
    geoState.geo = {};
    cardState.address = '';
    pinState.pins = [];
    featureState.hit = null;
  });

  test('a pin tap selects that pin and drops NO competing map spot', () => {
    pinState.pins = [{ id: 'p1', label: 'My bike', lat: 40.78, lon: -119.2, savedAt: 1 }];
    featureState.hit = {
      feature: { kind: 'pin', id: 'p1', label: 'My bike' },
      target: { label: 'My bike', lat: 40.78, lon: -119.2 },
    };
    const root = renderScreen();
    tapFeature(root);
    expect(chipSelected(root, '📍 My bike')).toBe(true);
    // the double-pin tell: a 📌 map-spot chip beside the pin you tapped
    expect(texts(root).some(t => t.startsWith('📌'))).toBe(false);
  });

  test('with two pins, the tapped one is the selected one', () => {
    pinState.pins = [
      { id: 'p1', label: 'My bike', lat: 40.78, lon: -119.2, savedAt: 1 },
      { id: 'p2', label: 'Art car', lat: 40.781, lon: -119.201, savedAt: 2 },
    ];
    featureState.hit = {
      feature: { kind: 'pin', id: 'p2', label: 'Art car' },
      target: { label: 'Art car', lat: 40.781, lon: -119.201 },
    };
    const root = renderScreen();
    tapFeature(root);
    expect(chipSelected(root, '📍 Art car')).toBe(true);
    expect(chipSelected(root, '📍 My bike')).toBe(false);
  });

  test('a friend tap has no chip of its own, so it rides the map-spot slot', () => {
    featureState.hit = {
      feature: { kind: 'friend', key: 'g1', label: 'Ada, Bo' },
      target: { label: 'Ada, Bo', lat: 40.79, lon: -119.21 },
    };
    const root = renderScreen();
    tapFeature(root);
    expect(texts(root).some(t => t === '📌 Ada, Bo')).toBe(true);
  });
});
