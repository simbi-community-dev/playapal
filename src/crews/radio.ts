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
// The alphabet is stated once, in src/util/base64.ts — see there for why
// this tree has two of them and why they must never be merged.
import { decodeB64Standard, encodeB64Standard } from '../util/base64';

// The standard-alphabet codec lives in src/util/base64.ts. It was duplicated
// here and in callSignal.ts as two structurally different implementations;
// they were merged only after 10,000 fuzz cases proved them interchangeable
// on valid AND malformed input. The exported names are unchanged, so no call
// site moved.
export const bytesToB64 = encodeB64Standard;

export const b64ToBytes = decodeB64Standard;

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

/**
 * The same question, ASKED OF THE SYSTEM INSTEAD OF THE USER: do we already
 * hold what the radio needs? Mailbox presence (share.ts) arms itself off the
 * app's lifecycle, and a permission dialog that appears because someone
 * opened an app is not consent — it is a prompt with no payoff on screen to
 * justify it, and the design's §5 rule is that every ask arrives in context.
 * So the lifecycle path checks and stays quiet; only the share toggle asks.
 */
export async function haveCrewPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    if (Platform.Version >= 31) {
      const trio = [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ];
      for (const p of trio) {
        if (!(await PermissionsAndroid.check(p))) {
          return false;
        }
      }
      return true;
    }
    return await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
  } catch {
    // A phone that cannot answer counts as NOT granted: the cost of being
    // wrong here is a radio that stays down until the user taps the toggle,
    // against a native call that throws on every lifecycle event.
    return false;
  }
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

/**
 * THE WALKIE'S AIRTIME HOLD — the mechanism half. The policy half (who
 * holds it, on which platform, and what it costs) lives in share.ts,
 * beside the session it suspends.
 *
 * WHAT IT IS FOR, measured 2026-08-26 on a three-phone bench: an iPhone
 * carried live BLE voice to an Android for the first time, and neither
 * Android could see that iPhone in their channel. P7's logcat proved the
 * other Pixel's PV hash over and over and never once attempted the
 * iPhone's — the UUID-filtered Android scan never matched the iPhone's
 * advertisement at all.
 *
 * The cause is a 31-byte budget, and it is Apple's documented behaviour
 * rather than anyone's bug. While the walkie is open this app runs TWO
 * CBPeripheralManager advertisers at once: WalkieBleVoice's (rung 3's
 * 128-bit service UUID plus the "PV"+16 hex local name that carries the
 * identity) and CrewBeacon's (the crew service UUID). Two 128-bit UUIDs
 * do not fit one primary advertising packet, so CoreBluetooth does what
 * it documents — it moves the service UUIDs into the proprietary
 * OVERFLOW AREA (CBAdvertisementDataOverflowServiceUUIDsKey), which
 * Apple's own documentation says can be discovered ONLY by an iOS device
 * explicitly scanning for that exact UUID. Android's
 * ScanFilter.setServiceUuid can never match it. CrewBeacon.swift's header
 * has carried the BACKGROUNDED half of this rule since Phase C; this is
 * the same rule biting in the foreground, through a second advertiser
 * rather than through the app being pocketed.
 *
 * So the walkie takes the advertising slot while it is open, and gives it
 * back. Held, advertise() puts nothing on the air and says so once per
 * tick; the SCAN is untouched, which is the half that keeps the trade
 * honest — see share.ts for exactly what a held beacon still does.
 */
let advertisingHeld = false;

export function crewAdvertisingHeld(): boolean {
  return advertisingHeld;
}

/**
 * Take the crew advertiser off the air (hold = true) or hand the slot
 * back (hold = false).
 *
 * Taking it off happens HERE and NOW, because a payload already on the
 * air outlives any flag: suppressing only future advertise() calls would
 * leave both advertisers up for the whole walkie session, which is
 * precisely the measured defect. Putting it back is the SESSION's job —
 * only the session can build a fresh, correctly time-bucketed frame — so
 * share.ts calls refresh() straight after clearing the hold.
 *
 * Never throws. A radio that refuses to go quiet is a degraded rung, not
 * a reason the camper cannot open the walkie they just asked for.
 */
export async function setCrewAdvertisingHold(hold: boolean): Promise<void> {
  advertisingHeld = hold;
  if (!hold || !native) {
    return;
  }
  // The cached bit goes false FIRST, whatever the native stop then does:
  // this module must never believe an advertisement is up that we just
  // asked to end. A stale `true` here is exactly how the measured bounce
  // bug kept ticking setPayload into a module that was not advertising.
  advertising = false;
  try {
    await native.stopAdvertising();
  } catch {
    // Nothing on the air to stop, or a radio that said no. Either way the
    // hold stands and the next advertise() is suppressed anyway.
  }
}

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
      if (advertisingHeld) {
        // THE WALKIE HAS THE AIRTIME (above). Said out loud on every tick,
        // in the same shape session.ts's own skips already use: a worker
        // that cannot do its job must say so, and the whole reason this
        // lane exists is that a phone which quietly stopped advertising
        // cost two evenings and three phones to catch.
        // eslint-disable-next-line no-console
        console.log('PlayaMesh advertise//skip reason=walkie-airtime');
        return;
      }
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

/**
 * THE FULL-SHARING BARRIER — the typed, AWAITED call to the native verb that
 * retires the sharing surface, and the road nothing in production took.
 *
 * `stopAdvertising()` is not this. On Android it closes the GATT server on
 * its way out; on iOS it ends DISCOVERY and nothing else — the service stays
 * published, the payload characteristic keeps its last value, and endSession
 * clears only the mesh scope. So a central that learned this iPhone's
 * identifier while sharing could reconnect by that identifier after the
 * camper turned sharing off, or removed their last mailbox, and read the
 * payload back. The UI said off; the radio was not.
 *
 * `stopAll` is the verb both modules already export for exactly this and it
 * had NO production caller — the session's stop calls stopAdvertising and
 * stopScan, and share.ts's teardown then called masterOff. It is called
 * here, once, from the full-sharing teardown, and AWAITED: the native side
 * completes its retirement before it resolves (Android on its main handler,
 * iOS on the CoreBluetooth queue behind a synchronous barrier), so a
 * teardown that has resolved is a teardown whose services are gone.
 *
 * THE WALKIE'S HOLD DELIBERATELY DOES NOT COME HERE. That suppression is
 * temporary and its whole trade is that the mailbox stays reachable while
 * discovery pauses (see share.ts) — it keeps stopAdvertising-only semantics,
 * and swapping it for this would cost pod mail to cure a problem it does not
 * have.
 */
export async function stopAllRadio(): Promise<void> {
  // The cached bit goes false FIRST, whatever the native stop then does:
  // this module must never believe an advertisement is up that we just asked
  // to retire (the same rule setCrewAdvertisingHold states).
  advertising = false;
  if (!native) {
    return;
  }
  await native.stopAll();
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

/**
 * A peer just finished reading OUR digest — proof their radio can reach
 * this phone RIGHT NOW, emitted by the native server when it hands over the
 * last digest frame. meshSync uses it as the reciprocity cue: the peer who
 * pulled from us is worth pulling from, immediately, instead of on the next
 * cooldown boundary. Both servers emit it (CrewBeaconModule.kt and
 * CrewBeacon.swift); the peer id is whatever name the SERVER knows that
 * central by.
 *
 * `dialable` is the server saying whether that name is an ADDRESS this
 * phone could dial back, and it is the difference between a cue and a
 * route. Android names a central by its MAC — the same address space the
 * scanner reports, so the id is a live route to a peer that may not be
 * discoverable at all (measured 2026-08-26: an iPhone holding its beacon
 * for the walkie pulled from two Pixels eleven times without either Pixel
 * ever sighting it once). iOS names a central by an opaque CBCentral
 * identifier, which is NOT the peripheral identifier retrievePeripherals
 * takes, so there it stays false and the event stays what it always was.
 *
 * ABSENT MEANS FALSE, deliberately: a server that does not say cannot have
 * its silence read as a promise.
 */
export function onSyncServed(
  cb: (s: { peerId: string; dialable: boolean }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'CrewSyncServed',
    (e: { peerId?: string; dialable?: boolean }) => {
      if (e && typeof e.peerId === 'string') {
        cb({ peerId: e.peerId, dialable: e.dialable === true });
      }
    },
  );
  return () => sub.remove();
}

/**
 * Scan duty cycle by app posture: foreground = fast (the user is looking at
 * the pod, seconds matter), background = frugal (the battery-honest default
 * both modules ship with). Android spends it as SCAN_MODE_LOW_LATENCY vs
 * BALANCED; iOS as allowDuplicates plus a slow rescan tick — same bargain,
 * different knobs, and neither is JS's business. Deliberately a SCAN knob
 * only: restarting the ADVERTISER to change its interval would mint a fresh
 * random address and re-open the rotation wound the AdvertisingSet path
 * closed. The optional guard stays: a module built without the method must
 * keep its own default rather than throw.
 */
export async function setScanPosture(lowLatency: boolean): Promise<void> {
  if (!native?.setScanMode) {
    return;
  }
  try {
    await native.setScanMode(lowLatency);
  } catch {
    // Radio off / permission gone: the next startScan reads the stored
    // posture anyway.
  }
}

/**
 * The GATT server's "peer X wants these ids" callback (payload stays
 * base64 — meshSync owns the want codec).
 *
 * AND THE REQUEST'S IDENTITY RIDES WITH IT. Both servers have always minted
 * `requestId` (this exact ask) and `serverEpoch` (the offer it was built
 * against) and put them on the event; this function used to read the peer
 * and the bytes and drop the other two on the floor. That drop is what made
 * an answer addressable only by PEER — and a peer is not a question. A want
 * queued for central X, a stop, a restart, a second want from the SAME
 * central, and then the first callback finally running: the answer it
 * computed goes back named "X", and X's newest request is what it fills.
 *
 * SO AN EVENT WITH NO IDENTITY IS NOT DELIVERED AT ALL, rather than
 * delivered with two undefineds for the caller to notice. There is no
 * answer this file could send for such a want that the server could match,
 * so handing it up would only produce a reply that must be refused — and
 * the MSG_CHAR not-ready frame already covers a want that goes unanswered.
 */
export function onSyncWant(
  cb: (w: {
    peerId: string;
    payload: string;
    requestId: number;
    serverEpoch: number;
  }) => void,
): () => void {
  const sub = getEmitter().addListener(
    'CrewSyncWant',
    (e: {
      peerId?: string;
      payload?: string;
      requestId?: number;
      serverEpoch?: number;
    }) => {
      if (!e || typeof e.peerId !== 'string' || typeof e.payload !== 'string') {
        return;
      }
      if (
        typeof e.requestId !== 'number' ||
        typeof e.serverEpoch !== 'number' ||
        !Number.isFinite(e.requestId) ||
        !Number.isFinite(e.serverEpoch)
      ) {
        return;
      }
      cb({
        peerId: e.peerId,
        payload: e.payload,
        requestId: e.requestId,
        serverEpoch: e.serverEpoch,
      });
    },
  );
  return () => sub.remove();
}
