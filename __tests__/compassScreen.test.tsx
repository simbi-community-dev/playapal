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
jest.mock('../src/friends/friendCard', () => ({
  listFriends: () => [],
  subscribeFriendsChanged: () => () => {},
}));
jest.mock('../src/geo/waypoints', () => ({
  HOME_LABEL: 'Home',
  homePin: () => null,
  listPins: () => [],
  removePin: () => {},
  savePin: () => {},
}));
jest.mock('../src/screens/CityMap', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return { CityMap: () => ReactActual.createElement(View, { testID: 'city-map' }) };
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
