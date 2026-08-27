/**
 * useLocation / useHeading — the native deps are mocked (modelCatalog.test
 * pattern); we test the hook contracts: permission-degradation, fix
 * plumbing, heading math (declination + smoothing seed), and cleanup.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@react-native-community/geolocation', () => ({
  __esModule: true,
  default: {
    setRNConfiguration: jest.fn(),
    watchPosition: jest.fn(() => 7),
    clearWatch: jest.fn(),
    getCurrentPosition: jest.fn(),
    requestAuthorization: jest.fn(),
  },
}));

jest.mock('react-native-sensors', () => {
  const subscribe = jest.fn();
  const unsubscribe = jest.fn();
  return {
    __esModule: true,
    magnetometer: {
      subscribe: (obs: unknown) => {
        subscribe(obs);
        return { unsubscribe };
      },
    },
    setUpdateIntervalForType: jest.fn(),
    SensorTypes: { magnetometer: 'magnetometer' },
    __mocks: { subscribe, unsubscribe },
  };
});

import Geolocation from '@react-native-community/geolocation';
import * as Sensors from 'react-native-sensors';
import { useLocation, type GeoFix, type LocationStatus } from '../src/geo/useLocation';
import { useHeading } from '../src/geo/useHeading';

const geoMock = Geolocation as jest.Mocked<typeof Geolocation>;

/** The (success, error) pair the hook handed to watchPosition, loosely
 * typed: the real GeolocationResponse/Error carry fields the tests don't
 * exercise. */
const watchArgs = () =>
  geoMock.watchPosition.mock.calls[0] as unknown as [
    (pos: {
      coords: { latitude: number; longitude: number; accuracy: number | null };
      timestamp: number;
    }) => void,
    (err: { code: number; message: string }) => void,
  ];
const sensorMock = (Sensors as unknown as {
  __mocks: { subscribe: jest.Mock; unsubscribe: jest.Mock };
}).__mocks;

type LocResult = { position: GeoFix | null; status: LocationStatus };

function LocationProbe({ sink }: { sink: (r: LocResult) => void }) {
  sink(useLocation());
  return null;
}

function HeadingProbe({ decl, sink }: { decl: number; sink: (h: number | null) => void }) {
  sink(useHeading(decl));
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useLocation', () => {
  test('a fix flows through; unmount clears the watch', () => {
    let latest: LocResult | null = null;
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(LocationProbe, { sink: r => (latest = r) }));
    });
    expect(latest!.position).toBeNull();
    expect(latest!.status).toBe('starting');
    expect(geoMock.setRNConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissionRequests: false }),
    );
    const [onFix] = watchArgs();
    act(() => {
      onFix({
        coords: { latitude: 40.78, longitude: -119.2, accuracy: 8 },
        timestamp: 1234,
      });
    });
    expect(latest!.status).toBe('watching');
    expect(latest!.position).toEqual({
      lat: 40.78,
      lon: -119.2,
      accuracyM: 8,
      timestamp: 1234,
    });
    act(() => renderer!.unmount());
    expect(geoMock.clearWatch).toHaveBeenCalledWith(7);
  });

  test('denial degrades to null position + denied status, no re-prompt', () => {
    let latest: LocResult | null = null;
    act(() => {
      create(React.createElement(LocationProbe, { sink: r => (latest = r) }));
    });
    const [, onError] = watchArgs();
    act(() => onError({ code: 1, message: 'denied' }));
    expect(latest!.status).toBe('denied');
    expect(latest!.position).toBeNull();
    expect(geoMock.watchPosition).toHaveBeenCalledTimes(1); // once per mount
  });

  test('non-permission errors read unavailable', () => {
    let latest: LocResult | null = null;
    act(() => {
      create(React.createElement(LocationProbe, { sink: r => (latest = r) }));
    });
    const [, onError] = watchArgs();
    act(() => onError({ code: 2, message: 'no provider' }));
    expect(latest!.status).toBe('unavailable');
  });
});

describe('useHeading', () => {
  test('flat-phone north plus declination', () => {
    let heading: number | null = -1;
    act(() => {
      create(React.createElement(HeadingProbe, { decl: 12.9, sink: h => (heading = h) }));
    });
    expect(heading).toBeNull(); // no sample yet
    const observer = sensorMock.subscribe.mock.calls[0][0];
    // Top of the phone at magnetic north: field along +y.
    act(() => observer.next({ x: 0, y: 20, z: -40, timestamp: 1 }));
    expect(heading).toBeCloseTo(12.9, 5);
  });

  test('west-pointing sample wraps into [0, 360)', () => {
    let heading: number | null = null;
    act(() => {
      create(React.createElement(HeadingProbe, { decl: 12.9, sink: h => (heading = h) }));
    });
    const observer = sensorMock.subscribe.mock.calls[0][0];
    // Field along +x: magnetic heading atan2(-x, y) = -90 → 270 true-ish.
    act(() => observer.next({ x: 20, y: 0, z: -40, timestamp: 1 }));
    expect(heading).toBeCloseTo(282.9, 5);
  });

  test('sensor error means null forever (clock-phrase floor takes over)', () => {
    let heading: number | null = 5;
    act(() => {
      create(React.createElement(HeadingProbe, { decl: 0, sink: h => (heading = h) }));
    });
    const observer = sensorMock.subscribe.mock.calls[0][0];
    act(() => observer.error(new Error('no magnetometer')));
    expect(heading).toBeNull();
  });

  test('unsubscribes on unmount', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(HeadingProbe, { decl: 0, sink: () => {} }));
    });
    act(() => renderer!.unmount());
    expect(sensorMock.unsubscribe).toHaveBeenCalled();
  });
});
