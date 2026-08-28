/**
 * THE OTHER HALF OF A BUZZ — where a tapped pocket notification LANDS.
 *
 * THE GAP, as the owner met it: a podmate types "@Kupo, bring water", the
 * pocket buzzes with their name and their words, the camper taps it — and
 * the app opens generically. Everything needed to do better was already on
 * the phone. The notification is minted HERE, on this handset, from a
 * record already in this handset's store, so it knows exactly which pod it
 * is about; the only thing missing was a way to say so.
 *
 * THE ARC THIS SUITE PINS, end to end in the half that is testable:
 *
 *   pocketAlertFor  puts the pod's CODE on the alert
 *        -> native   carries it on the tap intent / userInfo
 *        -> drainTap hands the tapped pair back, once
 *        -> podLandingForTap  decides the destination (pod + pane)
 *        -> podLanding.ts     publishes it as a standing request
 *        -> App.tsx  opens the Pods tab, which MOUNTS the card
 *        -> CrewSection  consumes the landing: that pod, its Mail pane
 *
 * WIRE-COMPATIBLE BY CONSTRUCTION and worth saying once: a local
 * notification's payload is written and read by ONE phone. Nothing here
 * crosses a radio, so there is no peer, no version and no pod-mate this
 * change can be incompatible with.
 *
 * The native halves get careful reads and source-shape pins (no Kotlin or
 * Swift runs under jest); everything above them is executed for real.
 *
 * Each assertion names the mutation it dies on; every one was planted as a
 * failing mutation before this file was committed.
 */

let mockAppStateCurrent = 'background';
let mockAppStateCb: ((s: string) => void) | undefined;
let mockAppStateArms = 0;
const mockAppStateRemove = jest.fn();
let mockWakeCb: (() => void) | undefined;
const mockWakeRemove = jest.fn();
const mockNotify = jest.fn(async (..._a: unknown[]) => true);
const mockDrainTap = jest.fn(async (): Promise<unknown> => null);

jest.mock('react-native', () => ({
  NativeModules: {
    PocketAlerts: {
      notify: (...a: unknown[]) => mockNotify(...(a as [])),
      cancel: async () => undefined,
      requestPermission: async () => true,
      drainTap: () => mockDrainTap(),
    },
  },
  AppState: {
    get currentState() {
      return mockAppStateCurrent;
    },
    addEventListener: (_e: string, cb: (s: string) => void) => {
      mockAppStateArms += 1;
      mockAppStateCb = cb;
      return { remove: mockAppStateRemove };
    },
  },
  DeviceEventEmitter: {
    addListener: (_e: string, cb: () => void) => {
      mockWakeCb = cb;
      return { remove: mockWakeRemove };
    },
  },
  Platform: { OS: 'android', Version: 33 },
}));

jest.mock('../src/crews/messages', () => ({
  POD_KINDS: ['text', 'voice'],
  subscribeRecordsAccepted: () => () => {},
}));

const mockSettings = new Map<string, string>([['pocket_alerts_choice', 'granted']]);
jest.mock('../src/events/db', () => ({
  getSetting: (k: string) => mockSettings.get(k) ?? null,
  setSetting: (k: string, v: string) => {
    mockSettings.set(k, v);
  },
  getDb: () => ({}),
}));

import {
  POCKET_ALERT_TAP_EVENT,
  notifyCallRing,
  pocketAlertFor,
  podLandingForTap,
  startPocketAlertTaps,
} from '../src/crews/pocketAlerts';
import {
  clearPodLanding,
  landOnPod,
  podLanding,
  podLandingRevision,
  __resetPodLandingForTests,
  subscribePodLanding,
} from '../src/crews/podLanding';

const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/PocketAlertsModule.kt';
const MAIN = 'android/app/src/main/java/com/playapal/MainActivity.kt';
const SWIFT = 'ios/PlayaPal/PocketAlerts.swift';
const APPDEL = 'ios/PlayaPal/AppDelegate.swift';
const BRIDGE = 'ios/PlayaPal/PocketAlertsBridge.m';

const MINE = 4242;
const rec = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  crew_code: '4207',
  kind: 'text',
  origin: 'heard',
  from_hash: 99,
  to_hash: null,
  body: 'hello pod',
  created_min: 100,
  ...over,
});

beforeEach(() => {
  __resetPodLandingForTests();
  mockAppStateCurrent = 'background';
  mockAppStateCb = undefined;
  mockAppStateArms = 0;
  mockWakeCb = undefined;
  mockDrainTap.mockReset();
  mockDrainTap.mockResolvedValue(null);
  mockNotify.mockClear();
  mockAppStateRemove.mockClear();
  mockWakeRemove.mockClear();
});

describe('the buzz carries the pod it is about', () => {
  test('a mention names the pod of the message that mentioned me', () => {
    // THE LOAD-BEARING ONE. Mutation: drop crewCode from the mention
    // branch and the loudest buzz in the app — one human choosing one
    // other human — is the one that still opens a home screen.
    const alert = pocketAlertFor(
      [
        rec({ id: 'a', crew_code: '1111', body: 'nothing for you', created_min: 200 }),
        rec({ id: 'b', crew_code: '2222', body: 'hey @Kupo bring water', created_min: 150 }),
      ] as never,
      MINE,
      false,
      () => ({ selfNames: ['Kupo'], names: new Map([[99, 'Dusty']]) }),
    );
    expect(alert?.category).toBe('mention');
    // The MENTIONING pod, not the newest record's — being named is the
    // whole reason this buzz is loud, so it must land where the naming
    // happened even when another pod was busier.
    expect(alert?.crewCode).toBe('2222');
  });

  test('a summary names the pod whose conversation is freshest', () => {
    // Mutation: take mine[0].crew_code. Accept order is arrival order, so
    // a batch spanning two pods would land on whichever the radio drained
    // first — an arbitrary room, which is worse than none because it looks
    // deliberate.
    const alert = pocketAlertFor(
      [
        rec({ id: 'a', crew_code: '1111', created_min: 100 }),
        rec({ id: 'b', crew_code: '2222', created_min: 300 }),
        rec({ id: 'c', crew_code: '3333', created_min: 200 }),
      ] as never,
      MINE,
      false,
    );
    expect(alert?.category).toBe('message');
    expect(alert?.crewCode).toBe('2222');
  });

  test('a lone message and a lone voice note both carry their pod', () => {
    // Mutation: leave the single-record branches behind. The commonest
    // buzz of all — one message, one pod — would be the one that does not
    // steer, and nobody would notice until camp.
    const one = pocketAlertFor([rec({ crew_code: '7777' })] as never, MINE, false);
    expect(one).toMatchObject({ category: 'message', crewCode: '7777' });
    const voice = pocketAlertFor(
      [rec({ crew_code: '8888', kind: 'voice' })] as never,
      MINE,
      false,
    );
    expect(voice).toMatchObject({ category: 'voice', crewCode: '8888' });
  });

  test('the pod code reaches native as its own argument', () => {
    // Mutation: keep the three-argument notify(). Both native halves would
    // then attach an empty payload to every buzz and the whole arc is
    // decorative — the JS decides a destination it never posts.
    notifyCallRing('Dusty');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]).toHaveLength(4);
  });

  test('a call ring deliberately carries NO pod', () => {
    // Mutation: give the call a pod. The ringing panel lives ABOVE every
    // tab, so steering to a Mail pane would move the camper AWAY from the
    // thing that is ringing — the one surface they opened the app for.
    notifyCallRing('Dusty');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]?.[3] ?? 'missing').toBe('');
  });
});

describe('where a tapped buzz lands', () => {
  test('pod mail of every kind lands on that pod, on Mail', () => {
    // Mutation: send a mention to the People pane. The buzz was about
    // words that are waiting; People is a roster, not an answer.
    for (const category of ['message', 'voice', 'mention'] as const) {
      expect(podLandingForTap({ category, crewCode: '4207' })).toEqual({
        crewCode: '4207',
        pane: 'mail',
      });
    }
  });

  test('a call, a codeless buzz and an unreadable one steer nowhere', () => {
    // Mutation: steer on anything with a category. A call would drag the
    // camper off the ringing panel; a payload from an older native (no
    // code) would land on a pod named '' and consume the request for
    // nothing. Nowhere is the honest answer to all three.
    expect(podLandingForTap({ category: 'call', crewCode: '4207' })).toBeNull();
    expect(podLandingForTap({ category: 'mention', crewCode: '' })).toBeNull();
    expect(podLandingForTap(null)).toBeNull();
    expect(podLandingForTap(undefined)).toBeNull();
  });
});

describe('the landing is a standing request, not an event', () => {
  test('a landing waits for a card that has not mounted yet', () => {
    // THE COLD-TAP SHAPE. Mutation: make this an emitter. On a cold start
    // the Pods card does not exist when the tap is drained — an event
    // fired into an empty room is a tap that silently does nothing, which
    // is the ORIGINAL bug wearing a fix's clothes.
    landOnPod('4207', 'mail');
    expect(podLanding()).toMatchObject({ crewCode: '4207', pane: 'mail' });
    // …still standing an arbitrary number of renders later.
    expect(podLanding()).toMatchObject({ crewCode: '4207' });
  });

  test('the newest tap wins, and a stale clear cannot swallow it', () => {
    // Mutation: clear unconditionally. A second buzz tapped while the
    // first was rendering would be consumed by the first consumer's clear
    // and the camper lands on the older pod — the wrong room, confidently.
    landOnPod('1111', 'mail');
    const first = podLanding()!.token;
    landOnPod('2222', 'mail');
    clearPodLanding(first);
    expect(podLanding()).toMatchObject({ crewCode: '2222' });
    clearPodLanding(podLanding()!.token);
    expect(podLanding()).toBeNull();
  });

  test('it publishes to useSyncExternalStore the way the card reads it', () => {
    // Mutation: mutate without bumping the revision. The card subscribes
    // but never re-renders, so the landing sits there unread forever.
    const seen: number[] = [];
    const off = subscribePodLanding(() => seen.push(podLandingRevision()));
    landOnPod('4207', 'mail');
    clearPodLanding(podLanding()!.token);
    off();
    landOnPod('9999', 'mail');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  test('an empty code is not a landing', () => {
    // Mutation: publish it anyway. Every call ring would post a request
    // no card can resolve, and the next real tap would be racing a queue
    // of ghosts.
    landOnPod('', 'mail');
    expect(podLanding()).toBeNull();
  });
});

describe('the tap is drained, not pushed', () => {
  test('a cold tap is collected on mount and steers before the tab opens', async () => {
    // THE ORDER IS THE PIN. Mutation: call onPod() before landOnPod().
    // Opening the tab is what MOUNTS the card, and a card that mounts
    // before the landing is published has nothing to consume — it would
    // need to be told twice, which is a race nobody would reproduce on a
    // desk.
    const order: string[] = [];
    mockDrainTap.mockResolvedValue({ category: 'mention', crewCode: '4207' });
    const stop = startPocketAlertTaps(() => {
      order.push(`open:${podLanding()?.crewCode ?? 'none'}`);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['open:4207']);
    expect(podLanding()).toMatchObject({ crewCode: '4207', pane: 'mail' });
    stop();
  });

  test('a warm tap is collected on the return to the foreground', async () => {
    // Mutation: drain only on mount. A tap that arrives while the process
    // is alive — the ordinary case for a phone that has been in a pocket
    // for ten minutes — would be stashed by native and never collected.
    const opens: string[] = [];
    const stop = startPocketAlertTaps(() => opens.push('open'));
    await Promise.resolve();
    mockDrainTap.mockResolvedValue({ category: 'message', crewCode: '5555' });
    mockAppStateCb?.('active');
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toEqual(['open']);
    expect(podLanding()).toMatchObject({ crewCode: '5555' });
    stop();
  });

  test('a background transition drains nothing', () => {
    // Mutation: drain on every state change. Going to the background would
    // consume a tap that has not happened yet, and the real tap that
    // follows would find an empty slot.
    const stop = startPocketAlertTaps(() => {});
    mockDrainTap.mockClear();
    mockAppStateCb?.('background');
    mockAppStateCb?.('inactive');
    expect(mockDrainTap).not.toHaveBeenCalled();
    stop();
  });

  test('Android can wake the drain without a background trip', async () => {
    // Mutation: drop the event listener. A tap taken from the shade over
    // an app that never left the foreground would wait for the camper to
    // background and return — which they have no reason to do, because as
    // far as they are concerned they already tapped it.
    const opens: string[] = [];
    const stop = startPocketAlertTaps(() => opens.push('open'));
    await Promise.resolve();
    mockDrainTap.mockResolvedValue({ category: 'mention', crewCode: '6666' });
    mockWakeCb?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(podLanding()).toMatchObject({ crewCode: '6666' });
    expect(opens).toEqual(['open']);
    stop();
  });

  test('a call tap opens the app and steers nowhere', async () => {
    // Mutation: land on the call's pod. See above — the ringing panel is
    // the destination and it is already on screen.
    const opens: string[] = [];
    mockDrainTap.mockResolvedValue({ category: 'call', crewCode: '4207' });
    const stop = startPocketAlertTaps(() => opens.push('open'));
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toEqual([]);
    expect(podLanding()).toBeNull();
    stop();
  });

  test('the teardown really lets go of both listeners', async () => {
    // Mutation: return a no-op teardown. A remounting shell would stack
    // listeners, and every foreground return would drain — and steer —
    // once per mount the app had ever done.
    const stop = startPocketAlertTaps(() => {});
    await Promise.resolve();
    stop();
    expect(mockAppStateRemove).toHaveBeenCalledTimes(1);
    expect(mockWakeRemove).toHaveBeenCalledTimes(1);
    mockDrainTap.mockClear();
    mockDrainTap.mockResolvedValue({ category: 'mention', crewCode: '7777' });
    mockAppStateCb?.('active');
    await Promise.resolve();
    await Promise.resolve();
    expect(podLanding()).toBeNull();
  });

  test('a native with no drain verb arms nothing at all', () => {
    // Mutation: read `native.drainTap` without the guard and hand the
    // undefined to the drain anyway. On an older native — or any build
    // where the module is absent — the shell would then hold two listeners
    // whose every wake-up is a swallowed exception: a lane that looks
    // armed, costs a subscription per mount, and can never deliver. The
    // honest shape is to arm nothing, so `pocketAlertsPresent()` stays the
    // single truth about whether this build has the seam.
    // Reset FIRST, then delete: the react-native mock factory re-runs on
    // every reset, so a deletion made before one is quietly undone.
    jest.resetModules();
    const rn = require('react-native');
    delete rn.NativeModules.PocketAlerts.drainTap;
    const fresh = require('../src/crews/pocketAlerts') as typeof import('../src/crews/pocketAlerts');
    mockAppStateArms = 0;
    let stop: (() => void) | undefined;
    expect(() => {
      stop = fresh.startPocketAlertTaps(() => {});
    }).not.toThrow();
    expect(mockAppStateArms).toBe(0);
    expect(() => stop?.()).not.toThrow();
    jest.resetModules();
  });
});

describe('the native halves carry the payload and hand it back once', () => {
  test('Android puts the category and the pod on the tap intent', () => {
    // Mutation: revert to `Intent(ctx, MainActivity::class.java)` bare.
    // The notification opens the app with nothing to say, which is the
    // original bug exactly.
    const kt = readSource(KT);
    expect(kt).toMatch(/\.putExtra\(EXTRA_CATEGORY, category\)/);
    expect(kt).toMatch(/\.putExtra\(EXTRA_CREW, crewCode\)/);
    expect(kt).toMatch(/fun notify\(\n\s*category: String,\n\s*title: String,\n\s*body: String,\n\s*crewCode: String,/);
  });

  test('Android does not let the FIRST buzz freeze the extras forever', () => {
    // THE SUBTLE ONE. A PendingIntent is keyed by request code and intent
    // shape, so without FLAG_UPDATE_CURRENT the second mention silently
    // reuses the first one's extras — every later tap lands on the pod the
    // FIRST buzz named, and the bug looks like "it works sometimes".
    // Mutation: drop the flag, or share one request code across the four
    // categories.
    const kt = readSource(KT);
    expect(kt).toMatch(/PendingIntent\.FLAG_IMMUTABLE or PendingIntent\.FLAG_UPDATE_CURRENT/);
    expect(kt).toMatch(/PendingIntent\.getActivity\(\n\s*ctx,\n\s*r\.id,/);
  });

  test('MainActivity consumes a tap on BOTH doors and neutralises it', () => {
    // Cold start lands in onCreate, a warm tap in onNewIntent (launchMode
    // singleTask). Mutation: hook only one and half the taps are silent.
    // Neutralising matters too: an activity recreation (rotation, theme
    // change) must not re-deliver a tap and yank a camper who has since
    // navigated away.
    const main = readSource(MAIN);
    expect((main.match(/PocketAlertsModule\.consumeTap\(intent, reactContext\(\)\)/g) ?? []).length).toBe(2);
    expect((main.match(/Intent\(Intent\.ACTION_MAIN\)/g) ?? []).length).toBe(4);
  });

  test('Android hands the tap back exactly once', () => {
    // Mutation: leave pendingTap standing after the drain. Every later
    // return to the foreground would re-steer the camper to a pod they
    // have long since left.
    const kt = readSource(KT);
    const drain = / {2}fun drainTap\(promise: Promise\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(drain).toBeDefined();
    expect(drain).toMatch(/pendingTap = null/);
    expect(drain).toMatch(/promise\.resolve\(null\)/);
    // Written on the main thread, read on the bridge thread.
    expect(kt).toMatch(/synchronized\(PENDING_LOCK\)/);
  });

  test('iOS attaches the payload and installs its listener before launch ends', () => {
    // THE COLD-TAP LAW on this platform. UNUserNotificationCenter delivers
    // a tap only to its delegate, and Apple requires that delegate to be
    // assigned before the app finishes launching — otherwise the response
    // for the notification that LAUNCHED the app never arrives at all.
    // Mutation: install lazily from the module and every tap works except
    // the one that mattered.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/content\.userInfo = \[\n\s*Self\.tapCategoryKey/);
    expect(swift).toMatch(/final class PocketAlertsTapObserver: NSObject, UNUserNotificationCenterDelegate/);
    expect(swift).toMatch(/didReceive response: UNNotificationResponse/);
    // Mutation: forget the completion handler — iOS terminates apps that
    // do not answer one.
    expect(swift).toMatch(/completionHandler\(\)/);
    const appdel = readSource(APPDEL);
    const install = appdel.indexOf('PocketAlertsTapObserver.install()');
    const start = appdel.indexOf('factory.startReactNative');
    expect(install).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(install);
  });

  test('iOS hands the tap back exactly once, and the bridge exposes it', () => {
    // Mutation: keep pendingTap, or leave drainTap out of the .m — a Swift
    // method with no RCT_EXTERN_METHOD line simply does not exist to JS,
    // and the failure is a silent undefined rather than an error.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/Self\.pendingTap = nil/);
    expect(swift).toMatch(/@objc\(drainTap:rejecter:\)/);
    const bridge = readSource(BRIDGE);
    expect(bridge).toMatch(/RCT_EXTERN_METHOD\(drainTap:/);
    expect(bridge).toMatch(/RCT_EXTERN_METHOD\(notify:\(NSString \*\)category\n\s*title:\(NSString \*\)title\n\s*body:\(NSString \*\)body\n\s*crewCode:\(NSString \*\)crewCode/);
  });
});

describe('the shell and the card complete the arc', () => {
  test('App.tsx arms the taps and answers with the Pods tab', () => {
    // Mutation: drop the effect. Every piece below it still works and
    // nothing ever calls it — the classic capability with no caller.
    const app = readSource('App.tsx');
    expect(app).toMatch(/startPocketAlertTaps\(\(\) => openTab\('pod'\)\)/);
  });

  test('CrewSection consumes the landing through the door, not a reach-in', () => {
    // Mutation: pass setActivePodId out through a prop or a ref. Two
    // callers holding this card's selection is two places that can
    // disagree about which pod is showing — the same failure the
    // walkie-stage routing steers one-way to avoid.
    const card = readSource('src/crews/CrewSection.tsx');
    expect(card).toMatch(/useSyncExternalStore\(subscribePodLanding, podLandingRevision\)/);
    expect(card).toMatch(/setActivePodId\(target\.id\);\n\s*setPane\(landing\.pane\);/);
    // Resolved by CODE — the pod's identity on the mesh, which is what the
    // record carried. Mutation: address it by local row id and a phone
    // that re-joined the pod lands nowhere.
    expect(card).toMatch(/listCrews\(\)\.find\(c => c\.code === landing\.crewCode\)/);
    // Consumed even when the pod is unknown, or a left pod's buzz leaves a
    // request standing that hijacks the next legitimate render.
    expect(card).toMatch(/clearPodLanding\(landing\.token\)/);
  });
});

describe('the event name is one string in two places', () => {
  test('JS and the Android module agree on the wake-up', () => {
    // Mutation: rename either. The wake is silently never delivered, and
    // the only symptom is a tap that waits for a background trip — which
    // reads as "sometimes it works".
    expect(POCKET_ALERT_TAP_EVENT).toBe('PlayaPalPocketAlertTap');
    expect(readSource(KT)).toMatch(/const val EVENT = "PlayaPalPocketAlertTap"/);
  });
});
