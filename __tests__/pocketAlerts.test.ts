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
 *
 * Everything native is mocked at the module seam (the meshResponsiveness
 * harness); the policy and wiring under test are real.
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
  pocketAlertFor,
  pocketAlertsChoice,
  reAskPocketAlerts,
  startPocketAlerts,
  stopPocketAlerts,
} from '../src/crews/pocketAlerts';
import type { CrewRecord } from '../src/crews/messages';

const ME = 'aaaa1111';
const BOB = 'bbbb2222';
const CARA = 'cccc3333';
const MY_HASH = hash32(ME);

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
