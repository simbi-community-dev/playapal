/**
 * HomeArrow (0.7.3, N2Y compass-as-home): the header's map door becomes a
 * live arrow pointing home when Home + fix + heading all exist, and stays
 * the plain map door otherwise. This file pins the two modes, the
 * fallback ladder, and that tap always opens the compass.
 */
import React from 'react';

let mockHome: any = null;
let mockPosition: any = null;
let mockHeading: number | null = null;

jest.mock('../src/geo/waypoints', () => ({
  homePin: () => mockHome,
  HOME_LABEL: 'Home',
}));
jest.mock('../src/geo/useLocation', () => ({
  useLocation: () => ({ position: mockPosition, status: 'watching' }),
}));
jest.mock('../src/geo/useHeading', () => ({
  useHeading: () => mockHeading,
}));
jest.mock('../src/geo/cityGeometry', () => ({
  getCityGeometry: () => ({ declinationDeg: 13 }),
}));
jest.mock('../src/geo/brcGeo', () => ({
  toWaypoint: () => ({ bearingDeg: 90 }),
  arrowRotation: (bearing: number, heading: number) => bearing - heading,
}));

import { HomeArrow } from '../src/components/HomeArrow';

const TestRenderer = require('react-test-renderer');

function render(onPress = () => {}) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(<HomeArrow onPress={onPress} />);
  });
  return root;
}

function textOf(root: any): string {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children),
    )
    .join(' ');
}

beforeEach(() => {
  mockHome = null;
  mockPosition = null;
  mockHeading = null;
});

test('without a Home pin it is the plain map door', () => {
  mockPosition = { lat: 40.78, lon: -119.2 };
  mockHeading = 10;
  expect(textOf(render())).toContain('Map');
});

test('without a fix or heading it is the plain map door even with Home set', () => {
  mockHome = { id: 'p', label: 'Home', lat: 40.79, lon: -119.21, savedAt: 1 };
  expect(textOf(render())).toContain('Map');
  mockPosition = { lat: 40.78, lon: -119.2 };
  expect(textOf(render())).toContain('Map'); // heading still null
});

test('with Home + fix + heading the door becomes the home arrow', () => {
  mockHome = { id: 'p', label: 'Home', lat: 40.79, lon: -119.21, savedAt: 1 };
  mockPosition = { lat: 40.78, lon: -119.2 };
  mockHeading = 30;
  const root = render();
  const t = textOf(root);
  expect(t).toContain('Home');
  expect(t).not.toContain('Map');
  // the arrow glyph carries the rotation transform (bearing 90 - heading 30)
  const arrow = root.root
    .findAllByType(require('react-native').Text)
    .find((n: any) => String(n.props.children) === '➤');
  const flat = [].concat(...[arrow.props.style].flat().filter(Boolean));
  const rotate = flat.map((st: any) => st && st.transform).filter(Boolean).flat();
  expect(rotate).toEqual([{ rotate: '60deg' }]);
});

test('tap opens the compass in both modes', () => {
  const pressed = jest.fn();
  const root = render(pressed);
  root.root.findAllByProps({ accessibilityLabel: 'Open the map' })[0].props.onPress();
  expect(pressed).toHaveBeenCalled();
});
