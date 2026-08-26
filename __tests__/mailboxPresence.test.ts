/**
 * THE MAILBOX DECOUPLING (src/crews/share.ts), pinned against the control
 * experiment that found it — two Pixels, adjacent, both apps foreground,
 * 2026-08-25:
 *
 *   "Share my position with My pod" OFF on both phones: ZERO PlayaMesh log
 *   lines in 47 s, and neither a pod message nor a voice note arrived. The
 *   BLE radio never ran, because the ONLY caller that ever started it was
 *   the position-share session. Flipping the toggle ON both sides woke the
 *   radio (225/248 lines) and the same message delivered in 27.4 s.
 *
 * So the defect was never in the message layer: mail was a side-effect of
 * consenting to be located. This suite holds the fix's two halves at once —
 * the radio comes up for MAIL, and a coordinate still leaves this phone
 * only while the toggle says so.
 *
 * Everything native is injected (the fake radio records exactly what went on
 * the air, and the frames are decoded with the REAL protocol), so each
 * assertion is about behaviour, not about a mock's shape. Each names the
 * mutation it dies on.
 */

const mockSettings = new Map<string, string>();
let mockCrews: Array<{ id: string; name: string; code: string; memberIds: string[] }> = [];
let mockCrewWatchers: Array<() => void> = [];
let mockAppState = 'active';
let mockAppHandler: ((s: string) => void) | undefined;
let mockGranted = true;
let mockAsked = 0;
/** Every payload handed to the radio, in order, plus the verbs called. */
const ads: Uint8Array[] = [];
const calls: string[] = [];
let mockFix: { lat: number; lon: number } | null = { lat: 40.7855, lon: -119.2065 };
let mockWatches = 0;
const meshStarts: number[] = [];
const meshStops: number[] = [];

jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mockAppState;
    },
    addEventListener: (_: string, cb: (s: string) => void) => {
      mockAppHandler = cb;
      return {
        remove: () => {
          mockAppHandler = undefined;
        },
      };
    },
  },
}));

jest.mock('@react-native-community/geolocation', () => ({
  __esModule: true,
  default: {
    getCurrentPosition: (ok: (p: any) => void) => {
      if (mockFix) {
        ok({ coords: { latitude: mockFix.lat, longitude: mockFix.lon } });
      }
    },
    watchPosition: (ok: (p: any) => void) => {
      mockWatches += 1;
      if (mockFix) {
        ok({ coords: { latitude: mockFix.lat, longitude: mockFix.lon } });
      }
      return mockWatches;
    },
    clearWatch: () => {
      mockWatches -= 1;
    },
  },
}));

jest.mock('../src/events/db', () => ({
  getDb: () => ({}),
  getSetting: (k: string) => (mockSettings.has(k) ? mockSettings.get(k)! : null),
  setSetting: (k: string, v: string) => {
    mockSettings.set(k, v);
  },
}));

jest.mock('../src/friends/friendCard', () => ({
  getMyCard: () => ({ id: MY_CARD }),
}));

jest.mock('../src/crews/crew', () => ({
  listCrews: () => mockCrews,
  subscribeCrewsChanged: (cb: () => void) => {
    mockCrewWatchers.push(cb);
    return () => {
      mockCrewWatchers = mockCrewWatchers.filter(w => w !== cb);
    };
  },
}));

jest.mock('../src/crews/meshSync', () => ({
  startMeshSync: () => {
    meshStarts.push(Date.now());
  },
  stopMeshSync: () => {
    meshStops.push(Date.now());
  },
}));

jest.mock('../src/crews/radio', () => ({
  crewRadioPresent: () => true,
  crewRadio: () => ({
    advertise: async (p: Uint8Array) => {
      calls.push('advertise');
      ads.push(p);
    },
    stopAdvertising: async () => {
      calls.push('stopAdvertising');
    },
    startScan: async () => {
      calls.push('startScan');
    },
    stopScan: async () => {
      calls.push('stopScan');
    },
  }),
  ensureCrewPermissions: async () => {
    mockAsked += 1;
    return mockGranted;
  },
  haveCrewPermissions: async () => mockGranted,
  ensureNotificationPermission: async () => false,
  onPocketTick: () => () => undefined,
  onRadioState: () => () => undefined,
  startPocketSession: async () => undefined,
  stopPocketSession: async () => {
    calls.push('stopPocket');
  },
}));

import {
  BEACON_LENGTH,
  decodeBeacon,
  MAILBOX_LENGTH,
} from '../src/crews/beacon';
import {
  installMailboxPresence,
  mailboxPresenceOn,
  sharingCrewId,
  startCrewSharing,
  startMailboxPresence,
  stopCrewSharing,
  stopMailboxPresence,
} from '../src/crews/share';

const MY_CARD = 'aaaa1111';
const CENTER = { lat: 40.783242, lon: -119.207871 };
const POD = {
  id: 'pod-1',
  name: 'My pod',
  code: 'dusty llamas',
  memberIds: [MY_CARD],
};
const POD_B = {
  id: 'pod-2',
  name: 'Other pod',
  code: 'amber lantern',
  memberIds: [MY_CARD],
};

/** Drain the serialized flip queue: every mocked await settles inside a
 * microtask, so a handful of turns runs a whole arm/teardown chain. Tests
 * fire the LIFECYCLE and wait here — calling the verb by hand would prove
 * only that the verb works, never that the app calls it. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
};

const lastAd = () => ads[ads.length - 1];
const kindOf = (wire: Uint8Array, code = POD.code) =>
  decodeBeacon(wire, [code], Date.now(), CENTER)?.kind ?? null;

let uninstall: (() => void) | null = null;

beforeEach(() => {
  mockSettings.clear();
  mockCrews = [POD];
  mockCrewWatchers = [];
  mockAppState = 'active';
  mockAppHandler = undefined;
  mockGranted = true;
  mockAsked = 0;
  mockFix = { lat: 40.7855, lon: -119.2065 };
  mockWatches = 0;
  ads.length = 0;
  calls.length = 0;
  meshStarts.length = 0;
  meshStops.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  uninstall?.();
  uninstall = null;
  await stopCrewSharing();
  await stopMailboxPresence();
  jest.restoreAllMocks();
});

describe('the radio comes up for MAIL, not only for consent', () => {
  test('an open app with a pod is on the air, position-free', async () => {
    // THE ROOT FIX. Mutation: delete installMailboxPresence's arming call
    // (or gate it on sharing) — the phone is silent with the app open, which
    // is precisely the measured 47-second nothing.
    uninstall = installMailboxPresence();
    await startMailboxPresence();
    expect(mailboxPresenceOn()).toBe(true);
    expect(sharingCrewId()).toBeNull(); // nobody consented to be located
    expect(calls).toEqual(['startScan', 'advertise']);
    expect(lastAd().length).toBe(MAILBOX_LENGTH);
    expect(kindOf(lastAd())).toBe('mailbox');
    // And the mesh — the thing that actually moves messages — is running.
    expect(meshStarts).toHaveLength(1);
  });

  test('mailbox posture never wakes the GPS', async () => {
    // Mutation: start the position watch unconditionally in armSession —
    // a phone carrying mail burns the high-accuracy GPS for a coordinate it
    // is not allowed to send.
    await startMailboxPresence();
    expect(mockWatches).toBe(0);
  });

  test('no pod, no mailbox — an advert for nobody is a claim about nothing', async () => {
    mockCrews = [];
    await startMailboxPresence();
    expect(mailboxPresenceOn()).toBe(false);
    expect(calls).toEqual([]);
  });

  test('an ungranted phone stays quiet instead of raising a dialog', async () => {
    // Mutation: call ensureCrewPermissions (the ASKING one) from the
    // lifecycle path — a permission prompt appears because an app was
    // opened, with no payoff on screen to justify it (design §5).
    mockGranted = false;
    await startMailboxPresence();
    expect(mockAsked).toBe(0);
    expect(mailboxPresenceOn()).toBe(false);
  });

  test('joining a pod arms it right then, not at the next app switch', async () => {
    mockCrews = [];
    uninstall = installMailboxPresence();
    await startMailboxPresence();
    expect(mailboxPresenceOn()).toBe(false);
    mockCrews = [POD];
    for (const w of mockCrewWatchers) {
      w();
    }
    await flush();
    expect(mailboxPresenceOn()).toBe(true);
  });
});

describe('sharing layers a position onto the same radio', () => {
  test('turning sharing ON adds the place without restarting anything', async () => {
    // Mutation: tear the session down and rebuild it on the toggle (the old
    // shape) — a fresh BLE address, a dropped scan window, and every peer's
    // freshness bookkeeping reset to prove nothing.
    await startMailboxPresence();
    calls.length = 0;
    await startCrewSharing(POD);
    expect(sharingCrewId()).toBe(POD.id);
    expect(calls).toEqual(['advertise']); // no stopScan, no startScan
    expect(lastAd().length).toBe(BEACON_LENGTH);
    expect(kindOf(lastAd())).toBe('position');
    expect(mockWatches).toBe(1); // and NOW the GPS is running
  });

  test('SHARING OFF STILL DELIVERS: the radio stays up, position-free', async () => {
    // The lane's headline. Mutation: make stopCrewSharing tear the session
    // down (what it did before) — the last frame stops existing, the mesh
    // stops, and two adjacent phones exchange nothing again.
    await startMailboxPresence();
    await startCrewSharing(POD);
    calls.length = 0;
    await stopCrewSharing();

    expect(sharingCrewId()).toBeNull();
    expect(mailboxPresenceOn()).toBe(true);
    expect(calls).toContain('advertise');
    expect(calls).not.toContain('stopScan');
    expect(lastAd().length).toBe(MAILBOX_LENGTH);
    expect(kindOf(lastAd())).toBe('mailbox');
    expect(meshStops).toHaveLength(0); // mail never stopped moving
    expect(mockWatches).toBe(0); // ...and the GPS went back to sleep
  });

  test('the intent still clears on a stop, so the switch reads honestly', async () => {
    await startCrewSharing(POD);
    expect(mockSettings.get('crew_sharing_intent')).toBe(POD.id);
    await stopCrewSharing();
    expect(mockSettings.get('crew_sharing_intent')).toBe('');
  });

  test('switching pods moves the position, never leaves two on the air', async () => {
    mockCrews = [POD, POD_B];
    await startCrewSharing(POD);
    await startCrewSharing(POD_B);
    expect(sharingCrewId()).toBe(POD_B.id);
    expect(kindOf(lastAd(), POD_B.code)).toBe('position');
    expect(decodeBeacon(lastAd(), [POD.code], Date.now(), CENTER)).toBeNull();
  });

  test('a denied permission still throws the in-context copy', async () => {
    mockGranted = false;
    await expect(startCrewSharing(POD)).rejects.toThrow(/Bluetooth permission/);
    expect(mockAsked).toBe(1); // the toggle DOES ask — that is consent in context
  });
});

describe('battery honesty: foreground is the mailbox’s whole life', () => {
  test('backgrounding stops the mailbox', async () => {
    // Mutation: keep the mailbox armed in the background without the
    // foreground service the pocket lane owes — a silent battery cost the
    // camper never agreed to.
    uninstall = installMailboxPresence();
    await startMailboxPresence();
    expect(mailboxPresenceOn()).toBe(true);
    mockAppHandler!('background');
    await flush();
    expect(mailboxPresenceOn()).toBe(false);
    expect(calls).toContain('stopScan');
    expect(meshStops).toHaveLength(1);
  });

  test('...unless a SHARE session is holding the radio', async () => {
    // Mutation: let the background handler tear down any session — a
    // pocketed phone with sharing deliberately ON goes invisible, which is
    // the Phase C promise broken.
    uninstall = installMailboxPresence();
    await startCrewSharing(POD);
    mockAppHandler!('background');
    await flush();
    expect(sharingCrewId()).toBe(POD.id);
    expect(mailboxPresenceOn()).toBe(true);
  });

  test("iOS's transient 'inactive' is not a stop", async () => {
    // Mutation: treat any non-active state as background — a notification
    // shade pulled down flaps the radio, which costs more than it saves.
    uninstall = installMailboxPresence();
    await startMailboxPresence();
    mockAppHandler!('inactive');
    await flush();
    expect(mailboxPresenceOn()).toBe(true);
  });
});


describe('the pocket buzz rides the mesh window in both postures (seam pins)', () => {
  const shareSrc = require('fs').readFileSync('src/crews/share.ts', 'utf8');
  test('teardown stops the alert subscription with the mesh', () => {
    // Mutation: drop stopPocketAlerts() from teardownSession — the
    // subscription outlives the radio it listens through.
    const teardown = shareSrc.slice(
      shareSrc.indexOf('async function teardownSession'),
      shareSrc.indexOf('\n}', shareSrc.indexOf('async function teardownSession')),
    );
    expect(teardown).toMatch(/stopPocketAlerts\(\)/);
  });
  test('mailbox posture arms the buzz only on a stored grant, never a prompt', () => {
    // Mutation: arm unconditionally — a phone that was never asked gets a
    // permission dialog for merely opening the app; or drop the arm — a
    // granted phone in mailbox-only posture never buzzes.
    expect(shareSrc).toMatch(/pocketAlertsChoice\(\) === 'granted'[\s\S]{0,220}startPocketAlerts/);
    expect(shareSrc).not.toMatch(/armPocketAlerts[\s\S]{0,400}startMeshSync\(\) => listCrews/);
  });
});
