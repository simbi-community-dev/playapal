/**
 * Pocket alerts (src/crews/pocketAlerts.ts): the four laws that keep a
 * pocketed phone's buzz trustworthy, each pinned to the mutation it dies
 * on:
 *
 *  - FOREGROUND-SUPPRESSION: a visible app never posts a notification —
 *    the in-app surfaces own the announcement.
 *  - ACCEPT-NOT-COMPOSE: the lane subscribes ONLY the accept hook; the
 *    store's own-write emitters must never reach a buzz.
 *  - BURST-BATCHING: one accept batch = at most ONE notification.
 *  - PERMISSION-RESPECT: a stored decline silences everything and stops
 *    all asking, permanently, until the deliberate Settings re-ask.
 *  - MENTION-ESCALATION (2026-08-26): a batch carrying "@me" earns the
 *    LOUD surface — its own category, the sender's name, their words —
 *    and still only ONE buzz.
 *
 * Everything native is mocked at the module seam (the meshResponsiveness
 * harness); the policy and wiring under test are real.
 *
 * PLANTED AND MEASURED, 2026-08-26 — every sharp pin below was proven by
 * making the code wrong and watching THIS suite go red, then reverting.
 * A pin nobody has seen fail is a pin nobody has tested:
 *
 *   escalation removed, mentions fold into the summary      4 failed
 *   voice notes run through the matcher                     4 failed
 *   mention exempted from foreground suppression            7 failed
 *   unnameable pod goes SILENT instead of degrading         8 failed
 *   one alert per mention (law 4 broken)                    1 failed
 *   mention body pasted whole, no clamp                     1 failed
 *   CH_MENTIONS registered at IMPORTANCE_DEFAULT            1 failed
 *   'mention' route removed (falls to the quiet channel)    1 failed
 *   Android opens the system-wide notification page         1 failed
 *   iOS categoryIdentifier dropped                          1 failed
 *   iOS .timeSensitive dropped                              1 failed
 *   iOS uses openSettingsURLString unconditionally          1 failed
 *   CrewMessage gains a `mentions` field                    1 failed
 *   an in-app mute switch appears beside the choice         1 failed
 *   a refused ask left holding a sentence, no OS page       1 failed
 *   a granted phone re-asks instead of opening the page     1 failed
 *   the row goes back under the collapsed Privacy group     1 failed
 *   the row's copy promises an instant buzz                 1 failed
 *
 * Baseline on the clean tree: all green. The matcher's own mutations
 * (longest-first, both word boundaries, the case fold) are tabled in
 * podMentions.test.ts, which owns them.
 */

let mockAppStateCurrent = 'background';
const mockNotify = jest.fn(async () => true);
const mockCancel = jest.fn(async () => undefined);
const mockRequestPermission = jest.fn(async () => true);

jest.mock('react-native', () => ({
  NativeModules: {
    PocketAlerts: {
      notify: (...a: unknown[]) => mockNotify(...(a as [])),
      cancel: (...a: unknown[]) => mockCancel(...(a as [])),
      requestPermission: () => mockRequestPermission(),
    },
  },
  AppState: {
    get currentState() {
      return mockAppStateCurrent;
    },
  },
  Platform: { OS: 'android', Version: 33 },
}));

const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (k: string) => mockSettings.get(k) ?? null,
  setSetting: (k: string, v: string) => {
    mockSettings.set(k, v);
  },
}));

// The store's three emitters, all observable: the wiring law is that the
// alert lane touches exactly one of them.
let mockAcceptedCb: ((r: unknown[]) => void) | undefined;
let mockChangedSubs = 0;
let mockComposeSubs = 0;
jest.mock('../src/crews/messages', () => ({
  POD_KINDS: ['text', 'voice'],
  subscribeRecordsAccepted: (cb: (r: unknown[]) => void) => {
    mockAcceptedCb = cb;
    return () => {
      mockAcceptedCb = undefined;
    };
  },
  subscribeMessagesChanged: () => {
    mockChangedSubs += 1;
    return () => {};
  },
  subscribeLocalCompose: () => {
    mockComposeSubs += 1;
    return () => {};
  },
}));

const mockEnsureNotificationPermission = jest.fn(async () => true);
jest.mock('../src/crews/radio', () => ({
  ensureNotificationPermission: () => mockEnsureNotificationPermission(),
}));

import { hash32 } from '../src/crews/beacon';
import {
  POCKET_ALERTS_CHOICE_KEY,
  armPocketAlerts,
  callRingTransition,
  clearCallRing,
  notifyCallRing,
  openNotificationSettings,
  pocketAlertFor,
  pocketAlertsChoice,
  reAskPocketAlerts,
  startPocketAlerts,
  stopPocketAlerts,
  type PodIdentity,
} from '../src/crews/pocketAlerts';
import type { CrewRecord } from '../src/crews/messages';

const ME = 'aaaa1111';
const BOB = 'bbbb2222';
const CARA = 'cccc3333';
const MY_HASH = hash32(ME);

/** The pod as this phone knows it: I am Kupo, Bob is Rusty, and Cara is
 * "Kupo Two" — the name that CONTAINS mine, which is the case the whole
 * longest-first rule exists for. */
const MY_NAME = 'Kupo';
const podIdentity = (): PodIdentity => ({
  myName: MY_NAME,
  names: new Map([
    [hash32(BOB), 'Rusty'],
    [hash32(CARA), 'Kupo Two'],
  ]),
});
const identity = () => podIdentity();

const rec = (over: Partial<CrewRecord> = {}): CrewRecord => ({
  id: 'cafe-1-beef',
  crew_code: 'dusty-llamas-7',
  from_hash: hash32(BOB),
  to_hash: null,
  kind: 'text',
  body: 'meet at the trash fence at 3',
  mime: '',
  created_min: 100,
  expires_min: 200,
  hops: 1,
  origin: 'heard',
  read_at: null,
  ...over,
});

beforeEach(() => {
  mockSettings.clear();
  mockAppStateCurrent = 'background';
  mockAcceptedCb = undefined;
  mockChangedSubs = 0;
  mockComposeSubs = 0;
  mockNotify.mockClear();
  mockCancel.mockClear();
  mockRequestPermission.mockClear();
  mockEnsureNotificationPermission.mockClear();
  mockEnsureNotificationPermission.mockResolvedValue(true);
});

afterEach(() => {
  stopPocketAlerts();
});

// ------------------------------------------------------------ pure policy

describe('pocketAlertFor — the decision, pure', () => {
  it('FOREGROUND-SUPPRESSION: a visible app earns null, always', () => {
    // Mutation: drop the `visible` gate — the app notifies over its own
    // open inbox and the buzz becomes the app interrupting itself.
    expect(pocketAlertFor([rec()], MY_HASH, true)).toBeNull();
    expect(pocketAlertFor([rec()], MY_HASH, false)).not.toBeNull();
  });

  it('CARRY ≠ SHOW: relayed mail addressed to someone else never buzzes', () => {
    // Mutation: drop the to_hash filter — every relay hop vibrates every
    // carrier for a stranger's mail.
    const toCara = rec({ to_hash: hash32(CARA) });
    expect(pocketAlertFor([toCara], MY_HASH, false)).toBeNull();
    // …while pod-wide (null) and to-me both do.
    expect(pocketAlertFor([rec({ to_hash: MY_HASH })], MY_HASH, false)).not.toBeNull();
  });

  it('my own records and non-pod kinds are invisible to the buzz', () => {
    expect(pocketAlertFor([rec({ from_hash: MY_HASH })], MY_HASH, false)).toBeNull();
    expect(
      pocketAlertFor([rec({ kind: 'pod-member' as CrewRecord['kind'] })], MY_HASH, false),
    ).toBeNull();
    // A row that is not a heard row (defensive: the hook only hands heard
    // rows, but the filter must not depend on that).
    expect(pocketAlertFor([rec({ origin: 'mine' })], MY_HASH, false)).toBeNull();
  });

  it('a lone voice note takes the voice channel with its own sentence', () => {
    const a = pocketAlertFor([rec({ kind: 'voice', mime: 'audio/aac' })], MY_HASH, false);
    expect(a).not.toBeNull();
    expect(a!.category).toBe('voice');
    expect(a!.body).toContain('voice note');
  });

  it('BURST-BATCHING: N arrivals fold into ONE summary alert', () => {
    // Mutation: return one alert per record (or count wrong) — a drained
    // mailbox becomes a pocket rattling N times.
    const batch = [
      rec({ id: 'a' }),
      rec({ id: 'b' }),
      rec({ id: 'c', kind: 'voice' }),
      rec({ id: 'ignored', to_hash: hash32(CARA) }), // not mine — not counted
    ];
    const a = pocketAlertFor(batch, MY_HASH, false);
    expect(a).not.toBeNull();
    expect(a!.category).toBe('message');
    expect(a!.body).toContain('2 messages');
    expect(a!.body).toContain('1 voice note');
  });
});

// ------------------------------------------------------------- mentions
//
// "if kupo is in a pod with me, and i type @kupo in chat, it would send her
// phone a real buzz" (owner, 2026-08-26). The buzz is minted HERE, on the
// receiving phone, at the moment the record is accepted off the mesh.

describe('a mention outranks the batch', () => {
  test('MENTION-ESCALATION: my name earns the loud category, the sender and the words', () => {
    // Mutation: fold mentions into the summary alert and the feature is
    // gone — a message written TO this camper arrives as "a message came
    // in", on the quiet channel, indistinguishable from pod chatter.
    const a = pocketAlertFor(
      [rec({ body: '@Kupo can you bring water to the shade?' })],
      MY_HASH,
      false,
      identity,
    );
    expect(a).not.toBeNull();
    expect(a!.category).toBe('mention');
    expect(a!.title).toBe('Rusty mentioned you');
    expect(a!.body).toBe('@Kupo can you bring water to the shade?');
  });

  test('LONGEST FIRST survives the seam: "@Kupo Two" never buzzes Kupo', () => {
    // The mentions.ts rule, re-pinned where it does damage. Mutation: match
    // my name without the rest of the roster in the pool and this camper
    // gets every buzz meant for the podmate whose name contains theirs.
    const a = pocketAlertFor(
      [rec({ body: '@Kupo Two bring water' })],
      MY_HASH,
      false,
      identity,
    );
    expect(a).not.toBeNull();
    expect(a!.category).toBe('message'); // ordinary pod mail, quietly
  });

  test('ONE DRAIN, ONE BUZZ still holds — the newest mention takes the slot', () => {
    // Mutation: return an alert per mention and a phone that was away for
    // an hour rattles once per message the moment it comes back.
    const a = pocketAlertFor(
      [
        rec({ id: 'm1', body: '@Kupo where are you', created_min: 100 }),
        rec({
          id: 'm2',
          from_hash: hash32(CARA),
          body: 'hey @kupo, dinner is on',
          created_min: 140,
        }),
        rec({ id: 'plain', body: 'shade is up at 4:30 & D', created_min: 150 }),
      ],
      MY_HASH,
      false,
      identity,
    );
    expect(a).not.toBeNull();
    expect(a!.category).toBe('mention');
    expect(a!.title).toBe('Kupo Two mentioned you'); // newest, by sender clock
    expect(a!.body).toContain('dinner is on');
    expect(a!.body).toContain('and 1 more mention');
  });

  test('a voice note is never a mention — there is no text in it to match', () => {
    // Mutation: run the matcher over every kind and base64 audio starts
    // matching short names at random, which is a buzz nobody can explain.
    const a = pocketAlertFor(
      [rec({ kind: 'voice', mime: 'audio/aac', body: 'QEt1cG8gaGVsbG8=' })],
      MY_HASH,
      false,
      identity,
    );
    expect(a!.category).toBe('voice');
  });

  test('the loudest surface still obeys law 3 and law 2', () => {
    // Mutation: exempt mentions from foreground suppression or from the
    // inbox predicate. A visible app interrupting itself is the first; a
    // RELAYED mention of me, addressed to someone else, is the second —
    // this phone carries other people's mail and must not read it aloud.
    const mention = rec({ body: '@Kupo bring water' });
    expect(pocketAlertFor([mention], MY_HASH, true, identity)).toBeNull();
    expect(
      pocketAlertFor(
        [{ ...mention, to_hash: hash32(CARA) }],
        MY_HASH,
        false,
        identity,
      ),
    ).toBeNull();
    // …and my OWN message naming myself buzzes nothing (law 1).
    expect(
      pocketAlertFor(
        [{ ...mention, from_hash: MY_HASH, origin: 'mine' }],
        MY_HASH,
        false,
        identity,
      ),
    ).toBeNull();
  });

  test('an unnameable pod degrades to the summary buzz, never to silence', () => {
    // Mutation: return null (or throw) when the roster cannot be resolved.
    // A phone whose store is mid-open would then go silent on real mail —
    // trading a missing escalation for a missing notification.
    const body = '@Kupo bring water';
    expect(pocketAlertFor([rec({ body })], MY_HASH, false)!.category).toBe(
      'message',
    );
    expect(
      pocketAlertFor([rec({ body })], MY_HASH, false, () => null)!.category,
    ).toBe('message');
  });

  test('a long mention is clamped, not pasted whole into the shade', () => {
    const long = `@Kupo ${'water '.repeat(60)}`;
    const a = pocketAlertFor([rec({ body: long })], MY_HASH, false, identity);
    expect(a!.category).toBe('mention');
    expect([...a!.body].length).toBeLessThanOrEqual(160);
    expect(a!.body.endsWith('…')).toBe(true);
  });
});

// --------------------------------------------------------------- wiring

describe('the wiring — which store events can reach the shade', () => {
  const arm = async () => {
    await armPocketAlerts(); // stores 'granted' via the mocked ask
    startPocketAlerts(() => ME);
  };

  it('ACCEPT-NOT-COMPOSE: only the accept hook is subscribed at all', async () => {
    // Mutation: rewire onto subscribeMessagesChanged (fires on compose,
    // markRead, prune) or subscribeLocalCompose — a camper's own message
    // buzzes their own pocket. The lane must never even LISTEN there.
    await arm();
    expect(mockAcceptedCb).toBeDefined();
    expect(mockChangedSubs).toBe(0);
    expect(mockComposeSubs).toBe(0);
  });

  it('a backgrounded accept batch buzzes once; a foregrounded one never', async () => {
    await arm();
    mockAcceptedCb!([rec({ id: 'a' }), rec({ id: 'b' })]);
    expect(mockNotify).toHaveBeenCalledTimes(1); // one batch, one buzz
    mockAppStateCurrent = 'active';
    mockAcceptedCb!([rec({ id: 'c' })]);
    expect(mockNotify).toHaveBeenCalledTimes(1); // suppressed while visible
  });

  it('the mention reaches the native poster on its own category', async () => {
    // The end-to-end wiring, not just the decision: a live batch carrying
    // "@Kupo" must arrive at native.notify tagged 'mention', because that
    // string is the ONLY thing routing it to the high-importance channel.
    // Mutation: post mentions on 'message' and the loud channel exists but
    // nothing is ever posted to it.
    await armPocketAlerts();
    startPocketAlerts(() => ME, identity);
    mockAcceptedCb!([rec({ body: 'water at 7 @Kupo' })]);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [category, title, body] = mockNotify.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(category).toBe('mention');
    expect(title).toBe('Rusty mentioned you');
    expect(body).toBe('water at 7 @Kupo');
  });

  it('PERMISSION-RESPECT: a stored decline is silent and never re-asks', async () => {
    // Mutation: drop the stored-choice short-circuit in armPocketAlerts —
    // every share toggle nags a camper who already said no.
    mockSettings.set(POCKET_ALERTS_CHOICE_KEY, 'denied');
    expect(await armPocketAlerts()).toBe(false);
    expect(mockEnsureNotificationPermission).not.toHaveBeenCalled();
    startPocketAlerts(() => ME);
    mockAcceptedCb!([rec()]);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('the Settings re-ask is the one road back from a decline', async () => {
    mockSettings.set(POCKET_ALERTS_CHOICE_KEY, 'denied');
    expect(await reAskPocketAlerts()).toBe(true);
    expect(mockEnsureNotificationPermission).toHaveBeenCalledTimes(1);
    expect(pocketAlertsChoice()).toBe('granted');
  });

  it('a fresh decline is remembered — the second arm asks nothing', async () => {
    mockEnsureNotificationPermission.mockResolvedValue(false);
    expect(await armPocketAlerts()).toBe(false);
    expect(pocketAlertsChoice()).toBe('denied');
    expect(await armPocketAlerts()).toBe(false);
    expect(mockEnsureNotificationPermission).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------ call ring

describe('the call ring — highest urgency, same reduced truth', () => {
  it('callRingTransition mirrors the reducer: enter shows, every exit clears', () => {
    // Mutation: clear only on 'ended' — an answered or declined call
    // leaves "X is calling" lying in the shade.
    expect(callRingTransition('idle', 'ringing')).toBe('show');
    expect(callRingTransition('ended', 'ringing')).toBe('show');
    expect(callRingTransition('ringing', 'connecting')).toBe('clear'); // answered
    expect(callRingTransition('ringing', 'idle')).toBe('clear'); // declined
    expect(callRingTransition('ringing', 'ended')).toBe('clear'); // missed/timeout
    expect(callRingTransition('ringing', 'ringing')).toBeNull(); // retransmit
    expect(callRingTransition('idle', 'calling')).toBeNull(); // outbound never buzzes
    expect(callRingTransition('connecting', 'live')).toBeNull();
  });

  it('rings by name when granted + pocketed; never when visible or declined', async () => {
    await armPocketAlerts();
    notifyCallRing('Marisol');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [category, title] = mockNotify.mock.calls[0] as unknown as [string, string];
    expect(category).toBe('call');
    expect(title).toContain('Marisol');

    mockAppStateCurrent = 'active';
    notifyCallRing('Marisol');
    expect(mockNotify).toHaveBeenCalledTimes(1); // the in-app panel owns it

    mockAppStateCurrent = 'background';
    mockSettings.set(POCKET_ALERTS_CHOICE_KEY, 'denied');
    notifyCallRing('Marisol');
    expect(mockNotify).toHaveBeenCalledTimes(1); // a decline covers calls too
  });

  it('clearCallRing clears the call slot unconditionally', () => {
    // No permission/posture gate on the CLEAR: a shade entry that exists
    // must be removable from any state.
    mockSettings.set(POCKET_ALERTS_CHOICE_KEY, 'denied');
    clearCallRing();
    expect(mockCancel).toHaveBeenCalledWith('call');
  });
});

// ---------------------------------------------------------- the OS surface
//
// FOUR CATEGORIES IN THREE LANGUAGES, and nothing type-checks a Kotlin
// constant against a Swift string against a TypeScript union (the
// walkieCap.test.ts problem, same shape). The failure is silent and
// asymmetric: a JS category the native side does not route falls to the
// QUIET channel, so a mention lands looking exactly like pod chatter — on
// one platform, at camp scale, where nobody can debug it.
//
// These are source assertions because the failure is STRUCTURAL. Comments
// are stripped first: an assertion about a construct trips on any comment
// that quotes it, and the comments in these files quote everything.

const readAlertSrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

/** Source minus comments — line, block and Swift/Kotlin doc alike. */
const codeOf = (p: string): string =>
  readAlertSrc(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const KT = 'android/app/src/main/java/com/playapal/PocketAlertsModule.kt';
const SWIFT = 'ios/PlayaPal/PocketAlerts.swift';
const BRIDGE = 'ios/PlayaPal/PocketAlertsBridge.m';
const TS = 'src/crews/pocketAlerts.ts';

describe('the channels ARE the settings screen', () => {
  test('Android registers a Mentions channel at HIGH importance, with vibration', () => {
    // Mutation: register Mentions at IMPORTANCE_DEFAULT and the loud buzz
    // is indistinguishable from pod chatter — no heads-up, no vibration,
    // and no separate switch on the camper's own settings page.
    const kt = codeOf(KT);
    expect(kt).toMatch(/const val CH_MENTIONS = "pod-mentions"/);
    expect(kt).toMatch(
      /NotificationChannel\(\s*CH_MENTIONS,\s*"Mentions",\s*NotificationManager\.IMPORTANCE_HIGH,\s*\)\s*\.apply\s*\{\s*enableVibration\(true\)/,
    );
  });

  test('the importance split is the whole design: mentions and calls loud, mail quiet', () => {
    // Mutation: raise pod-messages to HIGH and every gossip drain becomes a
    // heads-up — the pocket that gets turned off by Tuesday.
    const kt = codeOf(KT);
    expect(kt).toMatch(
      /NotificationChannel\(\s*CH_MESSAGES,[^)]*IMPORTANCE_DEFAULT/,
    );
    expect(kt).toMatch(/NotificationChannel\(\s*CH_VOICE,[^)]*IMPORTANCE_DEFAULT/);
    expect(kt).toMatch(/NotificationChannel\(\s*CH_CALLS,[^)]*IMPORTANCE_HIGH/);
  });

  test('every JS category has a native route, and its own slot', () => {
    // Mutation: leave 'mention' out of route() and it silently falls to the
    // else branch — the quiet channel, in the message's own slot, where it
    // also REPLACES the mail summary that was already there.
    const kt = codeOf(KT);
    for (const [category, channel] of [
      ['voice', 'CH_VOICE'],
      ['mention', 'CH_MENTIONS'],
      ['call', 'CH_CALLS'],
    ] as const) {
      expect(kt).toMatch(new RegExp(`"${category}" -> Route\\(${channel},`));
    }
    const ids = [...kt.matchAll(/const val ID_\w+ = (\d+)/g)].map(m => m[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // 5050 is CrewShareService's persistent session notification.
    expect(ids).not.toContain('5050');
  });

  test('iOS gives the mention its own category and asks for time-sensitive', () => {
    // Mutation: drop the categoryIdentifier and iOS lists ONE lump called
    // "Playa Pal" in Settings > Notifications — the per-type control the
    // Settings row promises stops existing on that platform.
    const swift = codeOf(SWIFT);
    expect(swift).toMatch(/content\.categoryIdentifier = id/);
    expect(swift).toMatch(
      /category as String == "mention"[\s\S]{0,120}interruptionLevel = \.timeSensitive/,
    );
  });
});

describe('the one door to the granular settings', () => {
  test('Android opens the app-notification page, by package', () => {
    // Mutation: open ACTION_NOTIFICATION_SETTINGS (the system-wide page) or
    // drop EXTRA_APP_PACKAGE, and the tap dumps a camper in the middle of
    // every app's notification settings with no idea what to do there.
    const kt = codeOf(KT);
    expect(kt).toMatch(/Intent\(Settings\.ACTION_APP_NOTIFICATION_SETTINGS\)/);
    expect(kt).toMatch(/putExtra\(Settings\.EXTRA_APP_PACKAGE, ctx\.packageName\)/);
    // Pre-26 has no channel page; the app details screen carries the switch.
    expect(kt).toMatch(/Settings\.ACTION_APPLICATION_DETAILS_SETTINGS/);
    // Channels registered BEFORE the page opens, or the promised granular
    // switches are missing at the exact moment they were promised.
    expect(kt).toMatch(/fun openSettings\(promise: Promise\) \{\s*try \{\s*ensureChannels\(\)/);
  });

  test('iOS opens the NOTIFICATION settings URL, with the pre-16 fallback', () => {
    // Mutation: use openSettingsURLString unconditionally and iOS 16+
    // campers land one screen further away than the OS can take them.
    const swift = codeOf(SWIFT);
    expect(swift).toMatch(
      /#available\(iOS 16\.0, \*\)[\s\S]{0,120}UIApplication\.openNotificationSettingsURLString/,
    );
    expect(swift).toMatch(/UIApplication\.openSettingsURLString/);
    // The ObjC-raise law: a UIKit call reachable from a finger runs under
    // the catcher, or a raise aborts the app from a Settings row.
    expect(swift).toMatch(/ObjCTry\.run \{\s*UIApplication\.shared\.open/);
    // …and the method is actually exported to JS.
    expect(readAlertSrc(BRIDGE)).toMatch(/RCT_EXTERN_METHOD\(openSettings:/);
  });

  test('the JS seam never invents a door that is not there', () => {
    // An older native has no openSettings; the row's copy is written for
    // false, so the promise must resolve false rather than reject.
    return expect(openNotificationSettings()).resolves.toBe(false);
  });
});

describe('on by default, and no in-app off switch', () => {
  test('nothing but the OS permission can silence the buzz', () => {
    // Mutation: add an "alerts enabled" setting and a toggle for it. Then
    // there are two switches for one behaviour — the app's and the OS's —
    // and they disagree the first time a camper uses the other one. The
    // permission answer is the ONLY stored state this file keeps.
    const ts = codeOf(TS);
    const keys = [...ts.matchAll(/getSetting\(([^)]*)\)|setSetting\(([^,]*),/g)]
      .map(m => (m[1] ?? m[2]).trim());
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).toBe('POCKET_ALERTS_CHOICE_KEY');
    }
    expect(ts).not.toMatch(/enabled|muted|snooze/i);
  });

  test('a never-asked phone ASKS — it does not default itself to off', async () => {
    // Mutation: treat '' as a decline. The first pod feature then arms
    // silently and the camper never learns the app can buzz at all.
    expect(pocketAlertsChoice()).toBe('');
    expect(await armPocketAlerts()).toBe(true);
    expect(mockEnsureNotificationPermission).toHaveBeenCalledTimes(1);
    expect(pocketAlertsChoice()).toBe('granted');
  });
});

describe('the wire format did not move', () => {
  test('messages.ts gained no mention field, kind or flag', () => {
    // THE COMPATIBILITY PIN. A mention is the characters '@' + the name,
    // inside a body every build already carries. Mutation: add a `mentions`
    // column, a 'mention' kind, or a flag on the envelope — and a phone
    // running last week's build drops or mangles the record, splitting the
    // pod at the one layer that must never split.
    const msgs = codeOf('src/crews/messages.ts');
    const record = /export interface CrewMessage \{([\s\S]*?)\n\}/.exec(msgs);
    expect(record).not.toBeNull();
    const fields = [...record![1].matchAll(/^\s{2}(\w+)[?:]/gm)].map(m => m[1]);
    expect(fields).toEqual([
      'id',
      'crew_code',
      'from_hash',
      'to_hash',
      'kind',
      'body',
      'mime',
      'created_min',
      'expires_min',
      'hops',
      'origin',
      'read_at',
    ]);
    expect(msgs).not.toMatch(/mention/i);
    // The composer inserts characters, nothing else (mentions.ts).
    expect(codeOf('src/crews/mentions.ts')).toMatch(
      /return `\$\{head\}\$\{MENTION_SIGIL\}\$\{name\} `/,
    );
  });
});

describe('the Settings row is the door, not a description of one', () => {
  // SettingsScreen is never rendered in a suite (the radioTruthRendered
  // posture: these failures are STRUCTURAL — nobody called the accessor).
  // The bug this guards is exactly that one wearing a new hat: a row that
  // TELLS a camper to go and change something in system settings, on a
  // phone whose OS has already stopped showing the permission dialog, is
  // the app narrating a dead end.
  const screen = codeOf('src/screens/SettingsScreen.tsx');

  test('the row is top-level and called Notifications', () => {
    // Mutation: leave it buried under the collapsed "Privacy & data"
    // group. Correct about the privacy adjacency, wrong about the word a
    // camper hunts for — and it took a section tap to even see it.
    expect(screen).toMatch(
      /sectionTitle}[^>]*>\s*\n?\s*Notifications\s*\n?\s*<\/Text>/,
    );
  });

  test('a refused ask lands on the OS page instead of a sentence about it', () => {
    // THE LOAD-BEARING ONE. Mutation: drop the second
    // openNotificationSettings() call. The 'denied' copy still promises
    // system settings and the tap still does nothing — which is how the
    // old row behaved, and why this lane exists.
    expect(screen).toMatch(
      /const granted = await reAskPocketAlerts\(\);[\s\S]{0,200}if \(!granted\) \{\s*await openNotificationSettings\(\);/,
    );
    // …and a granted phone goes straight there, since there is nothing
    // left for the app itself to ask.
    expect(screen).toMatch(
      /alertsChoice === 'granted'\) \{\s*await openNotificationSettings\(\);/,
    );
  });

  test('the copy carries the mesh truth and promises no timing the radio cannot keep', () => {
    // Mutation: write "instantly". There is no push server out there; a
    // buzz lands when the two phones next hear each other, and a camper
    // who learns that from a missed message learns it at the worst
    // possible moment.
    expect(screen).toMatch(/buzzes ride the mesh/i);
    const rowCopy = /Notifications<\/Text>([\s\S]*?)rowChevron/.exec(screen);
    expect(rowCopy).not.toBeNull();
    expect(rowCopy![1]).not.toMatch(/instantly|right away|immediately/i);
  });
});
