/**
 * useLocation — a small hook over @react-native-community/geolocation.
 *
 * Permission flow: the library requests the system permission itself on the
 * first watch (skipPermissionRequests: false; Android needs
 * ACCESS_FINE_LOCATION in the manifest, iOS the NSLocationWhenInUse string —
 * both shipped). Denial degrades gracefully: position stays null, status
 * reads 'denied', and we never re-prompt in a loop — the effect runs once
 * per mount. GPS works with zero connectivity, which is the whole point.
 */

import { useEffect, useState } from 'react';
import Geolocation from '@react-native-community/geolocation';

export interface GeoFix {
  lat: number;
  lon: number;
  /** Reported horizontal accuracy in meters, when the platform gives one. */
  accuracyM: number | null;
  /** Fix time, ms epoch. */
  timestamp: number;
}

export type LocationStatus = 'starting' | 'watching' | 'denied' | 'unavailable';

const PERMISSION_DENIED = 1; // W3C Geolocation error code

export function useLocation(enabled: boolean = true): {
  position: GeoFix | null;
  status: LocationStatus;
} {
  const [position, setPosition] = useState<GeoFix | null>(null);
  const [status, setStatus] = useState<LocationStatus>('starting');

  useEffect(() => {
    if (!enabled) {
      return;
    }
    Geolocation.setRNConfiguration({
      skipPermissionRequests: false,
      authorizationLevel: 'whenInUse',
      enableBackgroundLocationUpdates: false,
      locationProvider: 'auto',
    });
    // SEED FIX (field report 2026-08-19): a high-accuracy-only watch gets NO
    // callback indoors — the compass sat on "Waiting for GPS…" forever in a
    // house. One coarse getCurrentPosition (fused/network/cache) answers in
    // moments anywhere; the GPS watch below overrides it the moment a real
    // fix arrives. The guard keeps a late coarse answer from clobbering a
    // newer satellite fix. On playa there is no wifi/cell, the seed simply
    // never answers, and behavior is exactly as before.
    let gotWatchFix = false;
    Geolocation.getCurrentPosition(
      pos => {
        if (gotWatchFix) {
          return;
        }
        setStatus('watching');
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          timestamp: pos.timestamp,
        });
      },
      () => {}, // seed is best-effort; the watch reports real errors
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
    const watchId = Geolocation.watchPosition(
      pos => {
        gotWatchFix = true;
        setStatus('watching');
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          timestamp: pos.timestamp,
        });
      },
      err => {
        // Keep any last-known fix; just report why updates stopped.
        setStatus(err.code === PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      {
        enableHighAccuracy: true, // GPS, not cell/wifi — there is neither out there
        distanceFilter: 5, // meters between updates
        interval: 5000, // Android polling hint, ms
        fastestInterval: 2000,
      },
    );
    return () => Geolocation.clearWatch(watchId);
  }, [enabled]);

  return { position, status };
}
