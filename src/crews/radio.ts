/**
 * The CrewRadio implementation over the native CrewBeacon modules — the seam
 * where session.ts's injected-radio contract meets NativeModules. Everything
 * protocol-shaped stays in beacon.ts; everything platform-shaped stays in
 * the Kotlin/Swift modules; this file only adapts calling conventions:
 *
 *  - advertise() is SET-STATE (each call replaces the payload). Natively
 *    that is setPayload() + a startAdvertising() only when not already up —
 *    tracked here, because the iOS module's start path only settles its
 *    promise on a real state change.
 *  - startScan() wires the sighting EVENT stream back into the callback the
 *    session injected, decoding base64 to bytes. Hermes ships atob/btoa;
 *    payloads are ~21 bytes, so the char-loop is nothing.
 *
 * Permission asks live here too (ensureCrewPermissions), in-context per the
 * design's §5 copy — the native modules deliberately REJECT with code
 * 'permission' rather than asking, the same discipline as camera/location.
 */
import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import type { CrewRadio } from './session';

const native = NativeModules.CrewBeacon;

// Hand-rolled base64 (payloads are ~21 bytes): btoa/atob exist on Hermes
// but not in the TS lib targets this repo compiles against, and a protocol
// seam is the wrong place to depend on a global's presence.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const c2 = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0;
    const c3 = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0;
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      (c2 << 6) |
      c3;
    // out.length already encodes the true byte count; emit up to three
    // bytes per quad, each guarded by it.
    out[o++] = (n >> 16) & 255;
    if (o < out.length) {
      out[o++] = (n >> 8) & 255;
    }
    if (o < out.length) {
      out[o++] = n & 255;
    }
  }
  return out;
}

/** SYNCHRONOUS presence check for render gating: the native module either
 * linked into this build or it didn't, and UI must not take an async state
 * update just to decide whether to show a switch (that update lands after
 * unmount in tests and after first paint on phones). The rare BLE-less
 * device still gets an honest failure from the session's error path. */
export function crewRadioPresent(): boolean {
  return native != null;
}

/** The deeper async probe (BLE feature + adapter) for anyone who needs it. */
export async function crewRadioSupported(): Promise<boolean> {
  if (!native) {
    return false;
  }
  try {
    return await native.isSupported();
  } catch {
    return false;
  }
}

/**
 * Ask for what sharing needs, in context, with the payoff already named by
 * the caller's UI. Android 12+: the runtime Bluetooth trio. Android 11-:
 * Bluetooth is install-time but scanning rides the location grant the
 * compass asks for — re-asked here if it was never given. iOS: the OS asks
 * by itself on first radio use (NSBluetoothAlwaysUsageDescription); denial
 * surfaces through the session's error path with recoverable copy.
 */
export async function ensureCrewPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  if (Platform.Version >= 31) {
    const got = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(got).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const fine = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return fine === PermissionsAndroid.RESULTS.GRANTED;
}

/** Android 13+ wants POST_NOTIFICATIONS before the Phase C foreground
 * service can show its consent notification. A denial degrades to
 * foreground-only sharing — never a hard failure. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) {
    return true;
  }
  const got = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return got === PermissionsAndroid.RESULTS.GRANTED;
}

let emitter: NativeEventEmitter | null = null;
let sightingSub: { remove(): void } | null = null;
let stateSub: { remove(): void } | null = null;
let advertising = false;

function getEmitter(): NativeEventEmitter {
  if (!emitter) {
    emitter = new NativeEventEmitter(native);
  }
  return emitter;
}

/** The native radio's own account of itself (CrewBeaconState, emitted by
 * both modules). `adapterEnabled` is the Bluetooth adapter's power state —
 * Android reads it from ACTION_STATE_CHANGED, iOS from the CBManager state
 * callbacks; it is optional because a module that cannot answer must read
 * as "unchanged", never as "off". */
export interface CrewRadioState {
  advertising: boolean;
  scanning: boolean;
  adapterEnabled?: boolean;
  error?: string;
}

/**
 * TRUTH SYNC — the fix for the measured bounce failure. `advertising` above
 * is a cache that spares a native round trip per 30 s tick; it used to be
 * written only by our own calls, so when the ADAPTER stopped the
 * advertisement out from under us the cache still said "up" and advertise()
 * never called startAdvertising again. The phone then ticked setPayload
 * forever into a module that was not on the air (PlayaMesh:
 * `advertise//payload bytes=21 advertising=false`, no `advertise//started`).
 * The native module is the only authority on this bit, so listen to it.
 *
 * One process-lifetime listener, never removed: it is the cache's
 * invalidation source, and dropping it re-opens the bug the moment nobody
 * happens to be subscribed.
 */
function trackRadioState(): void {
  if (stateSub || !native) {
    return;
  }
  // Partial<> deliberately: the emitter hands us an untyped Object, so the
  // listener's parameter must accept one and the shape is CHECKED, not
  // asserted — a truncated event must never write a wrong `advertising`.
  stateSub = getEmitter().addListener(
    'CrewBeaconState',
    (e: Partial<CrewRadioState>) => {
      if (e && typeof e.advertising === 'boolean') {
        advertising = e.advertising;
      }
    },
  );
}

/**
 * Subscribe to the radio's state stream. The consumer is share.ts, which
 * feeds it to session.ts's noteRadioState() — the honesty + recovery state
 * machine. Kept here because this file owns every NativeModules import.
 */
export function onRadioState(cb: (s: CrewRadioState) => void): () => void {
  trackRadioState();
  const sub = getEmitter().addListener(
    'CrewBeaconState',
    (e: Partial<CrewRadioState>) => {
      if (e && typeof e.advertising === 'boolean' && typeof e.scanning === 'boolean') {
        cb({
          advertising: e.advertising,
          scanning: e.scanning,
          adapterEnabled:
            typeof e.adapterEnabled === 'boolean' ? e.adapterEnabled : undefined,
          error: typeof e.error === 'string' ? e.error : undefined,
        });
      }
    },
  );
  return () => sub.remove();
}

export function crewRadio(): CrewRadio {
  trackRadioState();
  return {
    async advertise(payload: Uint8Array): Promise<void> {
      await native.setPayload(bytesToB64(payload));
      if (!advertising) {
        await native.startAdvertising();
        advertising = true;
      }
    },
    async stopAdvertising(): Promise<void> {
      advertising = false;
      await native.stopAdvertising();
    },
    async startScan(onSighting: (bytes: Uint8Array) => void): Promise<void> {
      sightingSub?.remove();
      sightingSub = getEmitter().addListener(
        'CrewBeaconSighting',
        (e: { payload?: string }) => {
          if (e && typeof e.payload === 'string') {
            try {
              onSighting(b64ToBytes(e.payload));
            } catch {
              // one malformed frame must never kill the listener
            }
          }
        },
      );
      await native.startScan();
    },
    async stopScan(): Promise<void> {
      sightingSub?.remove();
      sightingSub = null;
      await native.stopScan();
    },
  };
}

/** Phase C: the Android foreground service holding the session through a
 * pocketed screen (iOS rides its declared background modes instead). */
export async function startPocketSession(): Promise<void> {
  if (Platform.OS === 'android') {
    await native.startForegroundSession();
  }
}

export async function stopPocketSession(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await native.stopForegroundSession();
    } catch {
      // a service that never started is already the goal state
    }
  }
}

/** The Phase C heartbeat stream (CrewShareService, 30 s). */
export function onPocketTick(cb: () => void): () => void {
  const sub = getEmitter().addListener('CrewBeaconTick', cb);
  return () => sub.remove();
}

/** Every sighting, with the peer id the sync layer aims at. The session's
 * own scan callback also hears these (via startScan); this second tap
 * exists so meshSync can react to WHO is nearby without owning the scan. */
export function onSighting(
  cb: (s: { peerId: string; via: string; rssi: number; bytes: Uint8Array }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'CrewBeaconSighting',
    (e: { payload?: string; peerId?: string; via?: string; rssi?: number }) => {
      if (e && typeof e.payload === 'string' && typeof e.peerId === 'string') {
        try {
          cb({
            peerId: e.peerId,
            via: e.via ?? '',
            rssi: e.rssi ?? 0,
            bytes: b64ToBytes(e.payload),
          });
        } catch {
          // one malformed frame must never kill the listener
        }
      }
    },
  );
  return () => sub.remove();
}

/** The GATT server's "peer X wants these ids" callback (payload stays
 * base64 — meshSync owns the want codec). */
export function onSyncWant(
  cb: (w: { peerId: string; payload: string }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'CrewSyncWant',
    (e: { peerId?: string; payload?: string }) => {
      if (e && typeof e.peerId === 'string' && typeof e.payload === 'string') {
        cb({ peerId: e.peerId, payload: e.payload });
      }
    },
  );
  return () => sub.remove();
}
