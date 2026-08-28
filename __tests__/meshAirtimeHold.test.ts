/**
 * THE RECEIVE HALF OF THE AIRTIME TRADE — the walkie's scan gets the radio,
 * so an iPhone can actually FIND the Android standing next to it.
 *
 * The measured defect (field, 3-4 minutes to sight a podmate; "Look again"
 * curing it in ~10 s): on iOS the walkie's BLE scan is the iPhone's only
 * road to discovering an Android peer — being dialled teaches an iPhone
 * nothing, because an Android central never writes its ident — and that
 * scan shares ONE radio with meshSync's dial queue, which foreground dials
 * every known peer every 15 s as a two-pass connect-and-read op under a
 * 60 s native timeout. meshSync's own addressFresh doc already banked the
 * consequence: "a live iPhone can go unsighted for minutes because WE were
 * busy". The cure is to stop being busy for the length of the gesture.
 *
 * THE TENSION THIS SUITE EXISTS TO PIN, because the cure trades one
 * starvation for a slower clock and the previous lane fixed the OTHER
 * direction (a beacon hold starving mail on Android):
 *
 *   (a) HELD: the ambient clock is the frugal 60 s one and the automatic
 *       nudges stand down — but the MANUAL check never is, because that
 *       one is the human asking.
 *   (b) RELEASED: the 15 s foreground clock is back, to the millisecond.
 *   (c) WALKIE CLOSED (and Android, always): byte-identical to before.
 *   (d) THE LEAK: every path out of releaseCrewAdvertising hands the clock
 *       back — a leaked hold is not a slow phone, it is a phone that never
 *       syncs on the fast clock again for the life of the process.
 *   (e) Rapid open/close/open strands nothing.
 *
 * Driven end-to-end through share.ts's REAL holdCrewAdvertising /
 * releaseCrewAdvertising, not through the meshSync setter, so deleting the
 * wiring is a mutation this file dies on. Same injected-everything harness
 * as meshResponsiveness.test.ts. Each assertion names the mutation it dies
 * on.
 *
 * THE COMPOSITION HALF (f)-(i), added 2026-08-27 after a cross-family review
 * ruled the hold above RISK — not wrong, but wrong TOGETHER with two things
 * that were already true:
 *
 *   (f) THE EIGHT-MINUTE BAR, BROKEN BY COMPOSITION. The served-route
 *       breaker rests five minutes; the hold stands the nudges down and
 *       slows the ambient clock; so the next usable radio event was 120-150
 *       s away and the two-pass sync 120 s behind that — 9 to 9.5 minutes
 *       for a message between phones a foot apart, on a bar of eight. The
 *       cure keeps the breaker and stops it eating the EVIDENCE: each fresh
 *       CrewSyncServed earns ONE priority dial at the front of the queue,
 *       and failure spends that proof. (A timer armed for the breaker's
 *       expiry was the first attempt and bounded nothing — it can fire into
 *       an op already in flight: 300 + 120 + 120 = 540 s.)
 *   (g) THE LIFECYCLE LEAK. A startWalkie rejection lands after BOTH holds
 *       are taken, and the stop path early-returns on exactly the state a
 *       failed start leaves — so both leaked, permanently. Every cleanup
 *       step is guarded on its own (a chain would let one throw strand the
 *       radio), the original error is what the caller sees, and the beacon
 *       is handed back EXCEPT when stopWalkie reports its own advertiser
 *       still up: overlap beats a slow clock.
 *   (h)/(i) The non-effects that must stay non-effects: Android, and a peer
 *       with no served history at all.
 *
 * THE CROSS-FAMILY HALF (n)-(p), added after the review of ac124d8, which
 * ruled the session epoch SOUND and incomplete:
 *
 *   (n) PHYSICAL RADIO OWNERSHIP. The epoch makes a dead session's
 *       COMPLETION harmless and says nothing about the RADIO: stopMeshSync
 *       cannot cancel a native op in flight and Android's stopAll leaves
 *       syncBusy set, so the replacement session dialled into that latch,
 *       was answered 'busy', and paid a cooldown, a fairness turn and a
 *       spent claim for a dead session's leftover. The cure is a
 *       process-wide TICKETED native-op arbiter that outlives the epoch
 *       bump: every dial chains through it, a new epoch's drain waits for
 *       the outstanding op before its first dial, and settlement releases
 *       the slot on BOTH roads and only for the ticket that owns it.
 *   (o) ROUTE-GUARD NON-VACUITY. (l)'s pipeline arm mocked meshSync's
 *       syncLink and separately drove an ad-hoc conductor, so meshSync's own
 *       linkFor was never on the path: deleting its post-pass guard left all
 *       54 arms green. These arms run the REAL route — drain -> linkFor ->
 *       the real conductor — and mock only the transport.
 *   (p) THE MANUAL CHECK. checkPodUpdates captured a counter and no epoch,
 *       so a stop/start across its await produced a negative `moved`, a
 *       tally of a discarded address book, and a surface write for a pod
 *       that no longer exists. It now returns a structured cancelled result.
 *
 * …and the want ledger's own half, asserted inside (o): the want stamp goes
 * down before the second pass, so a cancellation after it OWNS that stamp
 * and rolls it back. Left standing, a dead epoch's back-off filtered valid
 * ids out of the next epoch's want list for the whole retry window.
 *
 * The bar is a FOREGROUND bar (docs/TEST-MATRIX.md). Background delivery has
 * no deterministic guarantee at this layer — the OS decides when a
 * backgrounded app's radio runs — and claiming one would be the kind of
 * number this repo refuses to print.
 */

let mockSighting: ((s: { peerId: string; via?: string }) => void) | undefined;
let mockServed:
  | ((s: { peerId: string; dialable?: boolean }) => void)
  | undefined;
let mockCompose: (() => void) | undefined;
let mockMessagesChanged: (() => void) | undefined;
/**
 * THE NATIVE RADIO'S OWN STATE STREAM — the seam radio.ts already exposes,
 * and the one meshSync now listens to for the adapter's return (row 123).
 *
 * A LIST, not a slot: share.ts subscribes to this stream too, and a single
 * slot would silently mean "whoever subscribed last". Both modules really do
 * hear every event on a phone, so the harness fans out the same way.
 */
type MockRadioState = {
  advertising: boolean;
  scanning: boolean;
  adapterEnabled?: boolean;
};
const mockRadioStates: Array<(s: MockRadioState) => void> = [];
const mockEmitRadioState = (s: MockRadioState): void => {
  for (const cb of [...mockRadioStates]) {
    cb(s);
  }
};
let mockWant:
  | ((w: {
      peerId: string;
      payload: string;
      requestId: number;
      serverEpoch: number;
    }) => void)
  | undefined;
let mockAppStateCurrent = 'active';
let mockPlatformOS = 'ios';
/** Every setCrewAdvertisingHold(x) the transmit half was asked for. */
const mockAdvHold: boolean[] = [];
let mockAdvHoldThrows = false;
let mockRefreshThrows = false;
let mockRefreshes = 0;
/** The StartSessionOpts share.ts last handed startCrewSession — the wire
 * the recovery transaction's third leg arrives on. */
let mockSessionOpts: { awaitMeshDigest?: () => Promise<boolean> } | null = null;
/** The walkie's own native half, for the (g) lifecycle arms: what the
 * session asked the radio to do, and whether its start refuses. */
const mockWalkieCalls: string[] = [];
let mockStartWalkieThrows: Error | null = null;
let mockWalkieOn = false;
/** A radio that answers stopWalkie with strict `false`: its own advertiser
 * did NOT go down. Undefined is today's real answer (Promise<void>). */
/**
 * WHAT THE RADIO ANSWERS ITS STOP WITH — re-anchored onto the native lane's
 * structured outcome (union merge, 2026-08-27).
 *
 * This suite was written against a stopWalkie that resolved void, and read
 * a strict `false` as "the advertiser is still up". The native lane replaced
 * that with a PROOF from the process arbiter: `{ outcome }`, where `clear`
 * is the only word that means "the exact owner's advertiser is proven off
 * the air", and `debt` / `notOwner` / `unknown` all park the mirror.
 *
 * The two rules compose without either side losing an arm, because they were
 * always the same rule. `undefined` here is an ordinary clean stop and
 * answers `clear`, which is what the real walkie.ts now resolves. Anything
 * an arm sets explicitly is passed through verbatim — so the `false` arm
 * below still parks, and now for the STRONGER reason: an answer this world
 * does not recognise has told it nothing about the air, and nothing has
 * never proved a radio quiet.
 */
let mockStopWalkieResult: unknown;
/** A peers listener that refuses to detach — the throwing cleanup STEP. */
let mockOffPeersThrows = false;
/** The call half of a start, for the road that fails AFTER the listeners
 * are up: only that road can leave a step to throw on the way out. */
let mockCallsPresent = false;
let mockRuntimeStartThrows: Error | null = null;
/**
 * THE TRANSPORT BOUNDARY, and the only thing section (o) mocks. The
 * route-guard arms drive meshSync's REAL drain through its REAL linkFor into
 * the REAL syncLink conductor, so the base64 seam and the native
 * syncWithPeer call are where the harness stops and the production pipeline
 * begins. Defaults are byte-identical to what every other arm sees.
 */
let mockB64ToBytes: (s: string) => Uint8Array = () => new Uint8Array();
let mockBytesToB64: (b: Uint8Array) => string = () => '';
/** Monotonic over the want attempts this suite's ledger stub hands out. */
let mockAttemptSeq = 0;
/** Every scoped digest publish the mesh made, in order. */
const mockPublishes: Array<{ epoch: number; rev: number }> = [];
/** A native side that refuses the publish as stale. */
let mockPublishRejects = false;
/**
 * HOLD ONE PUBLISH OPEN ON THE BRIDGE, for the arms that are about WHEN a
 * republish comes home rather than whether it went out.
 *
 * A publish that settles on the next microtask cannot be outlived by a
 * stop/start, so the completion handlers' identity guards would be
 * unreachable by construction — and an unreachable guard is one no arm can
 * prove. Parking the native promise makes the crossing observable: the
 * republish is in flight, the camper's pod is replaced under it, and the
 * completion then lands on a world that is not its own.
 */
let mockParkPublish = false;
const mockParkedPublishes: Array<() => void> = [];
const mockReleasePublishes = (): void => {
  const waiting = mockParkedPublishes.splice(0, mockParkedPublishes.length);
  for (const release of waiting) {
    release();
  }
};
/** How many times production asked native to end its session. */
let mockEndSessions = 0;
/** How many times production asked native to retire the sharing surface. */
let mockStopAlls = 0;
/**
 * HOLD THE NATIVE RETIREMENT OPEN, for the arms that are about WHEN a stop
 * has actually happened rather than whether it was asked for.
 *
 * A retirement that lands on the next microtask is indistinguishable from one
 * that lands synchronously, because teardownSession has several awaits after
 * the mesh stop and any of them would let it through — so a missing `await`
 * on the mesh stop would be invisible, which is exactly the shape that let
 * this defect live. Parking the native promise makes the ordering observable:
 * with the await, teardown cannot resolve; without it, teardown resolves over
 * a phone that has retired nothing.
 */
let mockParkEndSession = false;
const mockParked: Array<() => void> = [];
const mockReleaseEndSession = (): void => {
  const waiting = mockParked.splice(0, mockParked.length);
  for (const release of waiting) {
    release();
  }
};
/** What the modelled native teardown does to the op on the radio. */
let mockOnEndSession: (() => void) | null = null;

/**
 * THE SERVER A CENTRAL CAN STILL READ — modelled, because the stop that
 * matters happens on the other side of a bridge.
 *
 * `mesh` is the offer's scope (endSession): the digest and message streams
 * answer the not-ready retry frame. `surface` is the sharing surface's
 * (stopAll): nothing is published, so nothing is answered at all. `buffers`
 * is what JS already assembled for a central under the session that is
 * ending — the bytes the whole class is about.
 */
const mockServer = {
  buffers: new Map<string, string>(),
  meshRetired: false,
  surfaceRetired: false,
};

/**
 * EACH VERB IS MODELLED AT ITS OWN CONTRACT, not at iOS's superset.
 *
 * On a phone `stopAll` retires the mesh scope as well as the surface — it is
 * `.everything`. Modelling that here would let one barrier COVER FOR the
 * other: a missing `await` on the mesh stop would hide behind the sharing
 * stop that follows it in the same teardown, and the arm would stay green
 * over exactly the defect it names. So the model keeps them separable, which
 * is strictly weaker than production and therefore safe: a MSG read is gated
 * by the mesh scope, a payload read by the surface, and each plant below
 * kills its own arm and nobody else's.
 */
const mockReadMsg = (central: string): string => {
  if (mockServer.meshRetired) {
    return 'refused';
  }
  return mockServer.buffers.get(central) ?? 'not-ready';
};

/** What a previously-known central gets from the payload characteristic. */
const mockReadPayload = (): string =>
  mockServer.surfaceRetired ? 'refused' : 'this-phone';

/**
 * A READ ALREADY QUEUED ON MAIN when the stop ran — finding 109's R, and the
 * only reachable ordering the review left standing (the E-clears-B variant
 * is FIFO-refuted and deliberately not armed here: an unreachable arm is
 * vacuity). Queued before the stop, drained after it, answered by whatever
 * the gate says at the moment it actually runs.
 */
const mockQueuedReads: string[] = [];
const mockDrainReads = (): string[] => {
  const out = mockQueuedReads.map(mockReadMsg);
  mockQueuedReads.length = 0;
  return out;
};
/** The DB every arm but (u) never touches. */
let mockDbConn: unknown = {};

jest.mock('react-native', () => ({
  NativeModules: {
    CrewBeacon: {
      setSyncDigest: jest.fn(async () => undefined),
      // THE SCOPED PUBLISH and THE CANCEL — the two native verbs this lane
      // adds. Both are called through optional bindings in production (a
      // module that predates them must degrade, not throw), so the mock
      // carries them present and one arm deletes them to drive the degrade.
      publishSyncDigest: jest.fn(async (b64: string, epoch: number, rev: number) => {
        mockPublishes.push({ epoch, rev });
        if (mockPublishRejects) {
          throw new Error('a newer digest is already published');
        }
        if (mockParkPublish) {
          mockParkPublish = false;
          await new Promise<void>(release => {
            mockParkedPublishes.push(release);
          });
        }
      }),
      endSession: jest.fn(async () => {
        mockEndSessions += 1;
        // THE NATIVE TEARDOWN, modelled: endSession cancels the exact
        // in-flight SyncClient, whose own terminal settles the bridge
        // promise by the failure road. An arm installs the settle switch of
        // whatever it parked on the radio.
        mockOnEndSession?.();
        // …AND THE RETIREMENT LANDS BEHIND A HOP, WHICH IS THE FIX TO THIS
        // STUB (row 107). It used to do everything synchronously inside this
        // async body — i.e. before its caller could even choose to await —
        // and that is STRONGER than anything the JS lifecycle was entitled
        // to assume. A stub stronger than production is a stub that hides
        // production: `stopMeshSync` fire-and-forgot this call, teardown ran
        // on through masterOff and RESOLVED, and no arm in this file could
        // tell. Native is a true synchronous barrier now, but the stub
        // deliberately models the WEAKER contract, so what the arms below
        // prove is the JS half — the await — rather than the mock's manners.
        if (mockParkEndSession) {
          mockParkEndSession = false;
          await new Promise<void>(release => {
            mockParked.push(release);
          });
        } else {
          await Promise.resolve();
        }
        mockServer.meshRetired = true;
        mockServer.buffers.clear();
      }),
      // THE SHARING SURFACE'S BARRIER, which had no production caller at all
      // until this commit. Same shape: the retirement is observable only
      // after the promise it hands back has actually settled.
      stopAll: jest.fn(async () => {
        mockStopAlls += 1;
        await Promise.resolve();
        mockServer.surfaceRetired = true;
      }),
      provideSyncMessages: jest.fn(async () => undefined),
      syncWithPeer: jest.fn(async (): Promise<{
        digest?: string;
        messages?: string;
      }> => ({ digest: '', messages: '' })),
    },
  },
  AppState: {
    get currentState() {
      return mockAppStateCurrent;
    },
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

jest.mock('../src/crews/radio', () => ({
  // meshSync's half of this module.
  onSighting: (cb: (s: { peerId: string; via?: string }) => void) => {
    mockSighting = cb;
    return () => {
      mockSighting = undefined;
    };
  },
  onSyncServed: (cb: (s: { peerId: string; dialable?: boolean }) => void) => {
    mockServed = cb;
    return () => {
      mockServed = undefined;
    };
  },
  onSyncWant: (
    cb: (w: {
      peerId: string;
      payload: string;
      requestId: number;
      serverEpoch: number;
    }) => void,
  ) => {
    mockWant = cb;
    return () => {
      mockWant = undefined;
    };
  },
  setScanPosture: async () => undefined,
  b64ToBytes: (s: string) => mockB64ToBytes(s),
  bytesToB64: (b: Uint8Array) => mockBytesToB64(b),
  // share.ts's half.
  crewRadio: () => ({}),
  crewRadioPresent: () => true,
  ensureCrewPermissions: async () => true,
  haveCrewPermissions: async () => true,
  onPocketTick: () => () => undefined,
  onRadioState: (cb: (s: MockRadioState) => void) => {
    mockRadioStates.push(cb);
    return () => {
      const at = mockRadioStates.indexOf(cb);
      if (at >= 0) {
        mockRadioStates.splice(at, 1);
      }
    };
  },
  setCrewAdvertisingHold: async (hold: boolean) => {
    mockAdvHold.push(hold);
    if (mockAdvHoldThrows) {
      throw new Error('the radio refused');
    }
  },
  startPocketSession: async () => undefined,
  stopPocketSession: async () => undefined,
  // The typed, awaited full-sharing barrier share.ts's teardown now takes.
  // Routed at the same native verb production routes it at, so a plant that
  // removes the call site is a plant this mock cannot paper over.
  stopAllRadio: async () => {
    const rn = jest.requireMock('react-native') as {
      NativeModules: { CrewBeacon: { stopAll: () => Promise<void> } };
    };
    await rn.NativeModules.CrewBeacon.stopAll();
  },
}));

// The four meshSync reads, plus the store seam the REAL syncLink conductor
// writes through — the (l) pipeline arm drives that conductor for real
// (jest.requireActual) to prove a stale session cannot ingest or ack into
// the live pod, and these spies are where that proof is read.
jest.mock('../src/crews/messages', () => ({
  messagesRevision: () => 0,
  subscribeMessagesChanged: (cb: () => void) => {
    mockMessagesChanged = cb;
    return () => {
      mockMessagesChanged = undefined;
    };
  },
  subscribeLocalCompose: (cb: () => void) => {
    mockCompose = cb;
    return () => {
      mockCompose = undefined;
    };
  },
  epochMinutes: (ms: number) => Math.floor(ms / 60000),
  pruneExpired: jest.fn(),
  wantsFrom: jest.fn(() => ['m1']),
  // THE WANT LEDGER'S OWN VERBS, which is what the conductor spends now.
  // openWantAttempt is the stamp (it writes the row and keeps the preimage);
  // exactly one of the three terminals runs per attempt. Spied rather than
  // simulated: what section (o) asserts is WHICH terminal a cancellation
  // reaches, and the ledger's own suite (wantLedger) owns what each does to
  // the table.
  openWantAttempt: jest.fn((ids: string[]) => ({
    token: (mockAttemptSeq += 1),
    ids,
    wrote: new Map(),
    prior: new Map(),
  })),
  commitWantAttempt: jest.fn(),
  forgiveWantAttempt: jest.fn(),
  rollBackWantAttempt: jest.fn(),
  heldIdsAmong: jest.fn((ids: string[]) => ids),
  acceptIncoming: jest.fn(() => 1),
  messagesByIds: jest.fn(() => []),
  syncDigest: jest.fn(() => []),
  utf8ByteLength: jest.fn(() => 0),
}));

jest.mock('../src/crews/syncLink', () => ({
  serveDigest: () => new Uint8Array(),
  // Spied, because M6's crew scope is decided at THIS call site: what the
  // mesh hands the serving codec is the whole guard.
  serveMessages: jest.fn(() => new Uint8Array()),
  syncWithPeer: jest.fn(async () => ({ accepted: 0 })),
}));

jest.mock('../src/crews/session', () => ({
  masterOff: async () => undefined,
  noteRadioState: () => undefined,
  sessionActive: () => true,
  // THE OPTS ARE KEPT, because one of them is a seam: the mesh readiness
  // barrier share.ts threads in is the third leg of the session's recovery
  // transaction, and a wiring that went missing would leave every arm on
  // both sides of it green (the session's own suite injects a fake; this
  // one mocks the session). Capturing it here is what makes the wire itself
  // armable — see section (x).
  startCrewSession: (opts: { awaitMeshDigest?: () => Promise<boolean> }) => {
    mockSessionOpts = opts;
    return {
    started: Promise.resolve(),
    refresh: async () => {
      mockRefreshes += 1;
      if (mockRefreshThrows) {
        throw new Error('the radio refused to come back right now');
      }
    },
    };
  },
}));

jest.mock('../src/crews/crew', () => ({
  listCrews: () => [{ id: 'pod-1', code: 'amber-lantern-31' }],
  subscribeCrewsChanged: () => () => undefined,
}));

jest.mock('../src/crews/presence', () => ({
  pruneSightings: () => undefined,
}));

jest.mock('../src/events/db', () => ({
  // SWAPPABLE, for section (u) alone: every other arm mocks the store
  // wholesale and never reaches a connection, while the want ledger's own
  // transaction and its exact-CAS rollback are SQL and can only be pinned
  // against a real one.
  getDb: () => mockDbConn,
  getSetting: () => null,
  setSetting: () => undefined,
}));

jest.mock('../src/friends/friendCard', () => ({
  getMyCard: () => ({ id: 'me' }),
}));

// The walkie's own module, for (g): the session under test is the REAL
// walkieSession, so the rejection has to come from where it comes from on a
// phone — the native channel start.
jest.mock('../src/crews/walkie', () => ({
  walkieOn: () => mockWalkieOn,
  walkieChannelRevision: () => 0,
  subscribeWalkieChannel: () => () => undefined,
  dedupeWalkiePeers: (rows: unknown[]) => rows,
  formatChannelNames: () => '',
  onWalkiePeers: () => () => {
    if (mockOffPeersThrows) {
      throw new Error('the peers listener refused to detach');
    }
  },
  setWalkieCallMuted: async () => undefined,
  startWalkie: async () => {
    mockWalkieCalls.push('startWalkie');
    if (mockStartWalkieThrows) {
      throw mockStartWalkieThrows;
    }
    mockWalkieOn = true;
  },
  stopTalking: async () => {
    mockWalkieCalls.push('stopTalking');
  },
  stopWalkie: async () => {
    mockWalkieCalls.push('stopWalkie');
    mockWalkieOn = false;
    return mockStopWalkieResult === undefined
      ? { outcome: 'clear' }
      : mockStopWalkieResult;
  },
  // THE ARBITER SEAM the native lane added beside this one. A parked mirror
  // subscribes here and queries there; an 'arbiter' capability with a null
  // state is "the question is open", which keeps a parked hold parked and
  // leaves every arm in this file deciding on its own terms.
  walkieAirtimeState: async () => ({ capability: 'arbiter', state: null }),
  onWalkieAirtimeState: () => () => undefined,
  compareWalkieRevision: () => 0,
}));

jest.mock('../src/crews/callRuntime', () => ({
  callsPresent: () => mockCallsPresent,
  CallRuntime: class {
    start() {
      mockWalkieCalls.push('runtime.start');
      if (mockRuntimeStartThrows) {
        throw mockRuntimeStartThrows;
      }
    }
    subscribe() {
      return () => undefined;
    }
    snapshot() {
      return null;
    }
    notePeers() {
      return undefined;
    }
    destroy() {
      mockWalkieCalls.push('runtime.destroy');
    }
  },
}));

jest.mock('../src/crews/videoCall', () => ({
  walkiePttSuppressed: () => false,
}));

jest.mock('../src/crews/pocketAlerts', () => ({
  armPocketAlerts: () => undefined,
  pocketAlertsChoice: () => 'denied',
  startPocketAlerts: () => undefined,
  stopPocketAlerts: () => undefined,
}));

import { syncWithPeer as linkSync } from '../src/crews/syncLink';
import {
  awaitMeshDigestReady,
  checkPodUpdates,
  lastPodSyncMs,
  meshAirtimeHeld,
  meshRepublishReady,
  meshRevision,
  startMeshSync,
  stopMeshSync,
} from '../src/crews/meshSync';
import { checkOutcomePhrase } from '../src/crews/podStatus';
import {
  holdCrewAdvertising,
  releaseCrewAdvertising,
  startMailboxPresence,
  stopMailboxPresence,
} from '../src/crews/share';
import {
  __resetWalkieSessionForTests,
  startWalkieSession,
  stopWalkieSession,
} from '../src/crews/walkieSession';

const CODES = () => ['amber-lantern-31'];
/** THE SECOND SESSION'S codes, distinct on purpose: a dial that carried
 * these was placed by the session that is actually running, and a dial
 * that carried CODES was placed by one that is not. */
const NEW_CODES = () => ['jade-compass-77'];
const PEER = 'AA:BB:CC:DD:EE:01';
/** meshSync's own constants, restated so a drift in either is a failure. */
const FOREGROUND_CLOCK_MS = 15_000;
/** …and the composition half's: the breaker's rest, and the bar it has to
 * fit inside. */
const REST_MS = 5 * 60_000;
/** THE BAR (docs/TEST-MATRIX.md): a message between two adjacent phones,
 * app open on both, in under eight minutes. */
const BAR_MS = 8 * 60_000;
/** The three rotating central names that strike the breaker out. */
const PULLED_A = '5A:34:2C:79:29:2C';
const PULLED_B = '44:8E:7A:85:47:46';
const PULLED_C = '4C:45:D4:F8:21:E4';
/** …and the live routes handed over DURING the rest that follows, one per
 * rotation of the same podmate's central name. */
const ROUTE_1 = '6F:7B:E5:21:17:B2';
const ROUTE_2 = '7A:11:22:33:44:55';
const ROUTE_3 = '8B:99:88:77:66:55';
/** Ordinary peers already waiting in the dial queue — the three the
 * priority dial has to get in front of. GATT-sighted, because addressFresh
 * never condemns that population and this queue has to still be there
 * minutes later. */
const WAITING_1 = '11:22:33:44:55:01';
const WAITING_2 = '11:22:33:44:55:02';
const WAITING_3 = '11:22:33:44:55:03';

const POD = {
  crewId: 'pod-1',
  crewCode: 'amber-lantern-31',
  myCardId: 'me',
  myName: 'Pug',
};

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

/** Every op an arm put on the radio and has not settled yet. See the
 * afterEach: the arbiter is process-wide, so a leaked op is a leaked RADIO.
 * Settling a promise twice is a no-op, so an arm settling its own op
 * explicitly (which is what the arms are about) costs nothing here. */
const inFlight: Array<(ok: boolean) => void> = [];
/** …and every native pass an arm parked ON the radio. Same reason: an
 * un-released gate is an op that never settles, which is a held arbiter. */
const parked: Array<() => void> = [];

/** The native transport itself — the one call section (o)'s arms park and
 * count, and the boundary the real pipeline stops at. */
const crewNative = (
  jest.requireMock('react-native') as {
    NativeModules: { CrewBeacon: Record<string, jest.Mock> };
  }
).NativeModules.CrewBeacon;
const nativeSync = crewNative.syncWithPeer;
/** The serving side's three native verbs, as the mesh actually calls them. */
const nativePublish = crewNative.publishSyncDigest;
const nativeSetDigest = crewNative.setSyncDigest;
const nativeProvide = crewNative.provideSyncMessages;
/**
 * THE WANT AS A NATIVE SERVER RAISES IT — the peer, the bytes, AND the
 * identity of the request: `requestId` names this exact ask and
 * `serverEpoch` the offer it was built against. Both modules have always
 * put them on the event; radio.ts used to drop them, which is what made an
 * answer addressable only by peer.
 *
 * The counter is monotonic and never reset inside an arm, exactly as
 * wantTicketSeq is over a phone's process — an arm that reused an id would
 * be asserting against a world neither server can produce.
 */
let wantSeq = 0;
const SERVER_EPOCH = 7;
const wantBody = (peerId: string, serverEpoch: number = SERVER_EPOCH) => {
  wantSeq += 1;
  return { peerId, payload: 'WANT', requestId: wantSeq, serverEpoch };
};
/** …and the codec seam the crew scope is decided at. */
const serveSpy = (
  jest.requireMock('../src/crews/syncLink') as { serveMessages: jest.Mock }
).serveMessages;

const dials = () => (linkSync as jest.Mock).mock.calls.length;
/** The crew codes the nth dial actually handed the conductor. */
const codesOfDial = (n: number) =>
  (linkSync as jest.Mock).mock.calls[n][1] as string[];
/** …and the epoch predicate it threaded down the pipeline with them. */
const epochOfDial = (n: number) =>
  (linkSync as jest.Mock).mock.calls[n][3] as () => boolean;

let now = 1_756_000_000_000;
let logs: string[] = [];

beforeEach(() => {
  now = 1_756_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  (linkSync as jest.Mock).mockReset();
  (linkSync as jest.Mock).mockImplementation(async () => ({ accepted: 0 }));
  mockAdvHold.length = 0;
  mockAdvHoldThrows = false;
  mockRefreshThrows = false;
  mockRefreshes = 0;
  mockSessionOpts = null;
  mockPlatformOS = 'ios';
  mockAppStateCurrent = 'active';
  mockWalkieCalls.length = 0;
  mockStartWalkieThrows = null;
  mockWalkieOn = false;
  mockStopWalkieResult = undefined;
  mockOffPeersThrows = false;
  mockCallsPresent = false;
  mockRuntimeStartThrows = null;
  mockB64ToBytes = () => new Uint8Array();
  mockBytesToB64 = () => '';
  mockPublishes.length = 0;
  mockPublishRejects = false;
  mockParkPublish = false;
  mockReleasePublishes();
  mockEndSessions = 0;
  mockStopAlls = 0;
  mockParkEndSession = false;
  mockReleaseEndSession();
  mockOnEndSession = null;
  mockServer.buffers.clear();
  mockServer.meshRetired = false;
  mockServer.surfaceRetired = false;
  mockQueuedReads.length = 0;
  nativeSync.mockReset();
  nativeSync.mockImplementation(async () => ({ digest: '', messages: '' }));
  nativePublish.mockClear();
  nativeSetDigest.mockClear();
  nativeProvide.mockClear();
  nativeProvide.mockImplementation(async () => undefined);
  serveSpy.mockClear();
  wantSeq = 0;
  startMeshSync(CODES);
});

afterEach(async () => {
  // THE RADIO OUTLIVES THE SESSION, so it outlives the ARM too. The
  // native-op arbiter is deliberately not cleared by stopMeshSync (it owns
  // the hardware, not the pod), so an op an arm put in flight and never
  // settled would hold the radio into the NEXT arm and park its first dial
  // — exactly as a never-settling native op would park a phone. Settling
  // them here makes that leak impossible to write by accident.
  //
  // IN ROUNDS, because settling one op can let a parked drain reach the
  // NEXT armed op — which only then becomes a live promise to settle.
  for (let round = 0; round < 8; round++) {
    for (const settle of inFlight) {
      settle(false);
    }
    for (const open of parked) {
      open();
    }
    await flush();
  }
  inFlight.length = 0;
  parked.length = 0;
  mockAdvHoldThrows = false;
  mockPlatformOS = 'ios';
  await releaseCrewAdvertising().catch(() => undefined);
  mockParkEndSession = false;
  mockReleaseEndSession();
  mockParkPublish = false;
  mockReleasePublishes();
  await stopMailboxPresence().catch(() => undefined);
  await stopMeshSync();
  jest.restoreAllMocks();
});

/** t0: one sighting, one dial, the peer's clock stamped. */
const firstDial = async () => {
  mockSighting!({ peerId: PEER, via: 'adv' });
  await flush();
  expect(dials()).toBe(1);
};

describe('(a) held: the frugal clock, and the automatic nudges stand down', () => {
  it('a foreground app with the walkie open re-syncs on the 60 s clock', async () => {
    // THE LOAD-BEARING ONE. Mutation: leave cooldownMs() as
    // `foreground ? FOREGROUND : PEER` (i.e. delete the `&& !airtimeHeld`)
    // and the dial below happens — which is the radio the walkie's scan
    // needed, taken away 20 seconds into the gesture.
    await firstDial();
    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(true);

    now += 20_000; // past the 15 s foreground clock, inside the 60 s one
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);
  });

  it('a compose does not nudge the radio, and says why in one line', async () => {
    // Mutation: drop the early return in nudgeSync — a compose reaches
    // through the hold and dials every peer on the air, which is the exact
    // connect/read cycle that starves the scan. The log line is half the
    // assertion: this is the layer whose silence made the 2026-08-25
    // diagnosis run on two logcat dumps with zero JS lines.
    await firstDial();
    await holdCrewAdvertising();
    now += 6_000; // past the nudge floor, inside every cooldown
    mockSighting!({ peerId: PEER, via: 'adv' });
    logs.length = 0;
    mockCompose!();
    await flush();
    expect(dials()).toBe(1);
    expect(logs.join('\n')).toContain('nudge skipped reason=walkie-airtime');
  });

  it('a peer that pulled from us does not trigger the dial-back either', async () => {
    // Mutation: gate only the compose path — the reciprocity nudge is the
    // busier of the two (every podmate's pull fires one) and it would keep
    // the radio in exactly the cycle the hold exists to end.
    await firstDial();
    await holdCrewAdvertising();
    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    mockServed!({ peerId: 'F0:0F:00:00:00:99' });
    await flush();
    expect(dials()).toBe(1);
  });

  it('the MANUAL check is never held — "Look again" still dials', async () => {
    // THE HALF THAT KEEPS THE TRADE HONEST, and the one the field report
    // already proved matters ("Look again" fixed the sighting in ~10 s).
    // Mutation: route checkPodUpdates through nudgeSync (or teach it the
    // flag) and the one button a camper presses when mail feels stuck
    // becomes a no-op for the whole walkie session — a fake spinner, which
    // is the rule this repo breaks for nobody.
    await firstDial();
    await holdCrewAdvertising();
    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    const r = await checkPodUpdates();
    expect(dials()).toBe(2);
    expect(r.inRange).toBe(1);
  });
});

describe('(b) released: the foreground clock comes back exactly as it was', () => {
  it('the very sighting the hold refused dials once the hold clears', async () => {
    // Same peer, same instant, same 20 s of elapsed time — the ONLY thing
    // that differs between the refused dial and this one is the flag.
    // Mutation: drop setMeshAirtimeHold(false) from releaseCrewAdvertising
    // and the walkie's slow clock outlives the walkie forever.
    await firstDial();
    await holdCrewAdvertising();
    now += 20_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);

    await releaseCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
  });

  it('the restored clock is the foreground constant, to the millisecond', async () => {
    // Mutation: restore some OTHER number on release (or leave the peer's
    // clock stretched) — "it went fast again" is not the claim; the claim
    // is that the cadence is the one the walkie-closed app always ran.
    await firstDial();
    await holdCrewAdvertising();
    await releaseCrewAdvertising();

    now += FOREGROUND_CLOCK_MS - 1;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1); // one millisecond short

    now += 1;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // exactly FOREGROUND_SYNC_COOLDOWN_MS
  });

  it('the nudges resume, silently', async () => {
    // Mutation: latch the skip (a "held once" flag) — composes never nudge
    // again after the first walkie of the session.
    await firstDial();
    await holdCrewAdvertising();
    await releaseCrewAdvertising();
    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    logs.length = 0;
    mockCompose!();
    await flush();
    expect(dials()).toBe(2);
    expect(logs.join('\n')).not.toContain('nudge skipped');
  });
});

describe('(c) walkie closed — and Android, always — is byte-identical', () => {
  it('no hold is ever engaged by simply running the mesh', async () => {
    // Mutation: default airtimeHeld to true, or engage it from anywhere in
    // meshSync's own lifecycle. The flag has exactly one writer.
    expect(meshAirtimeHeld()).toBe(false);
    await firstDial();
    now += FOREGROUND_CLOCK_MS;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
    mockCompose!();
    await flush();
    expect(dials()).toBe(2); // the nudge floor, not the hold, is what stops it
    expect(meshAirtimeHeld()).toBe(false);
  });

  it('Android opening the walkie holds NOTHING — neither half', async () => {
    // THE OTHER DIRECTION OF LAST NIGHT'S FIX, pinned. Mutation: move the
    // setMeshAirtimeHold call above walkieNeedsAirtime()'s gate (or gate it
    // separately) and every Android walkie session slows pod mail to 60 s
    // to cure a problem Android does not have: an Android advertisement
    // carries its payload inline, so its peers never needed our scan.
    mockPlatformOS = 'android';
    await firstDial();
    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
    expect(mockAdvHold).toEqual([]); // the transmit half stays out too

    now += FOREGROUND_CLOCK_MS;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
  });
});

describe('(d) the leak arm: every path out of release hands the clock back', () => {
  it('a phone with NO session standing still releases', async () => {
    // The `if (!a) return` path — a walkie opened on a phone that is not
    // carrying mail, or one whose session was torn down while the walkie
    // was open (backgrounding does exactly that). Mutation: put
    // setMeshAirtimeHold(false) after that early return and the commonest
    // walkie-on-a-quiet-phone case strands the hold forever.
    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(true);
    await releaseCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
    expect(mockRefreshes).toBe(0); // there was nothing to refresh
  });

  it('a refresh the radio refuses still releases', async () => {
    // The swallowed-catch path: releaseCrewAdvertising deliberately eats a
    // failed refresh(), because failing the walkie's STOP over a beacon
    // that will not come back helps nobody. Mutation: put
    // setMeshAirtimeHold(false) after the refresh and a radio hiccup at
    // walkie-close costs the fast clock for the life of the process.
    await startMailboxPresence();
    await holdCrewAdvertising();
    mockRefreshThrows = true;
    await releaseCrewAdvertising();
    expect(mockRefreshes).toBeGreaterThan(0); // the path really was taken
    expect(meshAirtimeHeld()).toBe(false);
  });

  it('a radio that refuses the un-hold still releases the mesh clock', async () => {
    // Defensive ordering, and the reason the call sits BEFORE the await:
    // setCrewAdvertisingHold documents that it never throws, but "never"
    // is a property of today's radio.ts, not of this seam. Mutation: move
    // the call below `await setCrewAdvertisingHold(false)` and this arm
    // dies — one throw upstream, one permanently slow phone.
    await holdCrewAdvertising();
    mockAdvHoldThrows = true;
    await expect(releaseCrewAdvertising()).rejects.toThrow();
    expect(meshAirtimeHeld()).toBe(false);
  });

  it('a hold whose radio call throws still engages, and still releases', async () => {
    // The mirror. walkieSession catches the hold's rejection on purpose (a
    // degraded rung never fails the rung above it) and opens the walkie
    // anyway — so the mesh hold must be ON for the session that IS running,
    // and must still come off at the end of it.
    mockAdvHoldThrows = true;
    await expect(holdCrewAdvertising()).rejects.toThrow();
    expect(meshAirtimeHeld()).toBe(true);
    mockAdvHoldThrows = false;
    await releaseCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
  });

  it('a mesh restart underneath an open walkie does NOT forget the hold', async () => {
    // Backgrounding with the walkie open tears mailbox presence down and
    // re-arms it on the way back — meshSync stops and starts. Mutation:
    // reset airtimeHeld in startMeshSync ("clean slate") and the fast clock
    // returns underneath a still-open walkie, silently, which is the
    // original bug wearing a lifecycle costume.
    await holdCrewAdvertising();
    stopMeshSync();
    startMeshSync(CODES);
    expect(meshAirtimeHeld()).toBe(true);

    // …and the hold is a SCHEDULER state, so what survives the restart is
    // the parking and not merely a slower number: the sighting is heard,
    // the address is queued, and nothing goes to the radio.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(0);
    expect(logs.join('\n')).toContain('park reason=walkie-airtime');

    // The walkie closes, and the very entry the hold parked dials — with no
    // further radio event to prompt it.
    await releaseCrewAdvertising();
    await flush();
    expect(dials()).toBe(1);
    expect(dialedAddrs()).toEqual([PEER]);
  });
});

describe('(e) rapid open/close/open strands nothing', () => {
  it('an interleaved burst settles on the LAST intent, not the last to finish', async () => {
    // Mutation: drop the serialized() wrapper from either verb (or set the
    // flag outside it) and a fast off→on→off toggle can settle held-true
    // with the walkie shut, or held-false with it open. share.ts's flip
    // queue is what makes the last word the true one.
    const burst = [
      holdCrewAdvertising(),
      releaseCrewAdvertising(),
      holdCrewAdvertising(),
    ];
    await Promise.all(burst);
    expect(meshAirtimeHeld()).toBe(true);
    expect(mockAdvHold).toEqual([true, false, true]);

    await releaseCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
  });

  it('a redundant release on an already-open phone cannot strand the clock', async () => {
    // stopWalkieSession's queued duplicate (a second off tap, or the
    // channel watcher filing a stop behind one already running) reaches
    // release twice. Idempotence, both directions.
    await holdCrewAdvertising();
    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(true);
    await releaseCrewAdvertising();
    await releaseCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);

    await firstDial();
    now += FOREGROUND_CLOCK_MS;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (f) THE COMPOSITION: the served-route breaker underneath an open walkie.
//
// ONE clock, deliberately, and that is the ruling this section pins. The
// first cure retained the route and dialled it on a timer armed at the
// breaker's expiry — and bounded nothing, because the expiry instant can
// land while an unrelated two-pass sync is ALREADY in flight and the
// target's own two passes queue up behind it: 300 + 120 + 120 = 540 s
// before a timer's own jitter, past the eight-minute bar again.
//
// So the debt is keyed to the EVIDENCE instead. Each fresh CrewSyncServed
// is new authoritative reachability proof and earns exactly ONE priority
// reciprocal dial at the FRONT of the queue, so the only thing that can
// precede it is the operation already running: current op (120 s) + target
// (120 s) = 240 s from the event, whatever the rest has left. Failure
// SPENDS that proof, so the identical re-arrival is refused exactly as the
// breaker always refused it, and the next fresh event — in practice the
// peer's next rotated central name — starts the cycle again.
// ---------------------------------------------------------------------------

/** Advance the wall clock and let the drain settle. There are no timers to
 * advance any more: the cure has none. */
const tick = async (ms: number) => {
  now += ms;
  await flush();
};

/** Three straight failures on rotating central names: the served-route
 * breaker strikes out and rests. Leaves the link HEALTHY, because the
 * question after this point is never "can we reach anyone" — it is whether
 * the proof we were handed during the rest is allowed to act. */
const tripServedBreaker = async () => {
  (linkSync as jest.Mock).mockImplementation(async () => {
    throw new Error('could not connect');
  });
  for (const addr of [PULLED_A, PULLED_B, PULLED_C]) {
    mockServed!({ peerId: addr, dialable: true });
    await flush();
  }
  (linkSync as jest.Mock).mockImplementation(async () => ({ accepted: 0 }));
};

/** Every address the [mesh] log says was actually dialled. */
const dialedAddrs = () =>
  logs
    .filter(l => l.startsWith('[mesh] dial '))
    .map(l => l.split(' ')[2]);

/**
 * Give the one-at-a-time sync worker to an ordinary SCAN-sighted peer and
 * hand back the switch that ends its op. Scan-sighted on purpose: its
 * outcome never touches the served breaker, so the interleaving stays the
 * subject.
 */
const holdTheWorker = async (addr: string) => {
  const settle = armTheRadio(0);
  mockSighting!({ peerId: addr, via: 'adv' });
  await flush();
  return settle;
};

/**
 * Arm the NEXT dial as an op this arm settles by hand, and hand back the
 * switch. The switch is LAZY — it reads the resolver when it is pulled, not
 * when it is handed over — because with the native-op arbiter a queued dial
 * no longer necessarily reaches the radio in the same turn it was queued:
 * a dead session's op may still hold the hardware. Registered in `inFlight`
 * so the suite can never leak the radio into the next arm.
 */
const armTheRadio = (accepted = 0) => {
  let settle: ((ok: boolean) => void) | null = null;
  (linkSync as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<{ accepted: number }>((resolve, reject) => {
        settle = ok =>
          ok ? resolve({ accepted }) : reject(new Error('connect timeout'));
      }),
  );
  const pull = (ok: boolean) => {
    settle?.(ok);
  };
  inFlight.push(pull);
  return pull;
};

describe('(f) the served-route rest no longer eats the eight-minute bar', () => {
  it('both hot + three prior failures: the fresh pull is dialled at once', async () => {
    // THE ARM THE COMPOSITION REVIEW ORDERED, and the one ce53ede fails on
    // its own. Everything here was already true before this commit: the
    // breaker rests five minutes (meshSync, SERVED_DIAL_REST_MS), and with
    // the walkie open the automatic nudges stand down and the ambient clock
    // is the 60 s one. Composed, the route this phone was HANDED during the
    // rest was stamped, dropped, and left to expire — the next dial waited
    // on whatever the radio volunteered next (120-150 s), plus two more
    // native passes: 9-9.5 minutes.
    //
    // Mutation: drop the claim from the onSyncServed handler and the dial
    // below never happens at all — not late, never — because under the hold
    // nothing else in this file will ever come back to a served-only
    // address.
    await tripServedBreaker();
    expect(dials()).toBe(3);
    const stuckAt = now; // the breaker trips: this is when the mail is stuck


    // One slow-clock event later the podmate pulls from us again and hands
    // over a live, dialable route. That pull is proof, and the proof acts.
    await tick(120_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    expect(dials()).toBe(4);
    expect(dialedAddrs()).toContain(ROUTE_1);
    const line = logs.join('\n');
    expect(line).toContain(`served-evidence dial ${ROUTE_1} gen=1`);
    expect(line).toContain(`dial ${ROUTE_1} via=nudge known=served evidence=1`);

    // The bound: the one slow-clock event that carried the proof, and no
    // waiting on the breaker at all. The rest window has not even expired.
    expect(now - stuckAt).toBe(120_000);
    expect(now - stuckAt).toBeLessThan(REST_MS);
    expect(now - stuckAt).toBeLessThan(BAR_MS);
  });

  it('a pull mid-sync is dialled after the op in FLIGHT, not behind the queue', async () => {
    // THE INTERLEAVING THAT KILLED THE TIMER DESIGN, now the arm. A timer
    // armed for the breaker's expiry fires into whatever the radio is
    // already doing: one unrelated two-pass sync in flight (120 s) and the
    // target's own two passes behind it puts 540 s on a 480 s bar.
    //
    // Mutation: queue.push instead of queue.unshift. The proof then waits
    // behind every peer already queued — three of them here, 360 s of
    // native ops — and both the order and the bound below die.
    await tripServedBreaker();
    const stuckAt = now;

    // One ordinary peer takes the worker for a full two-pass op; three more
    // are already waiting behind it. The in-flight one FAILS on purpose: it
    // is the worst case the bound is stated against (two native passes that
    // end in a timeout), and a success would open the breaker by itself,
    // which would prove nothing about the priority path. The waiting three
    // are GATT-sighted — the population addressFresh never condemns — so
    // the freshness gate cannot quietly empty the queue this arm needs.
    await tick(120_000);
    const settle = await holdTheWorker(PEER);
    expect(dials()).toBe(4);
    for (const waiting of [WAITING_1, WAITING_2, WAITING_3]) {
      mockSighting!({ peerId: waiting, via: 'gatt' });
    }
    await flush();
    expect(dials()).toBe(4); // one op running, three entries waiting

    // 30 s into that connection the podmate pulls from us.
    await tick(30_000);
    const eventAt = now;
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4); // nothing preempts the connection in flight

    // From here every dial costs the worst-case pair of native passes.
    const doneAt = new Map<string, number>();
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      now += 120_000;
      doneAt.set(target, now);
      return { accepted: 0 };
    });

    await tick(90_000); // …and the op in flight reaches its own 120 s
    settle(false);
    await flush();

    // FRONT OF THE QUEUE: the dial the fresh proof authorised runs on the
    // very next turn of the worker, ahead of the three already waiting.
    expect(dialedAddrs().slice(3)).toEqual([
      PEER,
      ROUTE_1,
      WAITING_1,
      WAITING_2,
      WAITING_3,
    ]);

    // THE CLASS GATE IS NOT IN THIS PATH, and this is where that is
    // pinned: the turn before the proof was an ORDINARY one, so the class
    // credit is in hand and the front is still the front. The 210 s below
    // is therefore the same number after the class rule as before it.
    expect(logs.join('\n')).not.toContain('served-class');

    const route1 = doneAt.get(ROUTE_1)!;
    // The reviewer's own arithmetic: what the op in flight had left (90 s
    // of its 120) plus the target's own 120 s — inside the 240 s the bound
    // claims, and inside the bar with two minutes to spare.
    expect(route1 - eventAt).toBe(210_000);
    expect(route1 - eventAt).toBeLessThanOrEqual(240_000);
    expect(route1 - stuckAt).toBe(360_000);
    expect(route1 - stuckAt).toBeLessThan(BAR_MS);
  });

  it('the SAME address pulling again after a failure is a new occurrence', async () => {
    // THE OWNER MODEL, and the arm that replaces this suite's old
    // "identical re-arrival never re-dials" (review, round 5). Native
    // raises CrewSyncServed once per COMPLETED digest pull, so a second
    // callback for one address is a second connection the peer actually
    // made — minutes of mail later — and the only thing it shares with the
    // first is spelling. Keying freshness on the address made ROTATION the
    // retry capability: a podmate whose central name happened not to rotate
    // went mute for the rest of the window, which on the hostile
    // interleaving is 570 s against a 480 s bar.
    //
    // Mutation (plant 03): restore the address-keyed test — refuse any pull
    // from a name that already carries a claim — and the second dial below
    // never happens.
    await tripServedBreaker();
    await tick(10_000);

    (linkSync as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('could not connect');
    });
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);
    expect(logs.join('\n')).toContain(`served-evidence spent ${ROUTE_1} gen=1`);

    // The podmate connects to us AGAIN, from the very same address, well
    // inside the rest window. That is a live radio saying so a second time,
    // and it earns a second attempt with its own generation.
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    expect(dials()).toBe(5);
    expect(logs.join('\n')).toContain(`served-evidence dial ${ROUTE_1} gen=2`);
    expect(logs.join('\n')).toContain(
      `dial ${ROUTE_1} via=nudge known=served evidence=2`,
    );
    expect(dialedAddrs().filter(a => a === ROUTE_1)).toHaveLength(2);
  });

  it('N pulls buy at most N dials, and nothing re-dials itself', async () => {
    // THE STORM BOUND, now that the address is not what bounds it. One
    // occurrence earns one attempt; this file never schedules a retry for
    // itself; and an occurrence exists only when a peer COMPLETES a digest
    // pull from us. So the cadence is the peer's own connection rate, and
    // the worst case is exactly the pull count — five here, every one of
    // them failing, from a name that never rotates.
    //
    // Mutation (plant 14): re-dial once on a failure that has nothing
    // banked — the self-scheduled retry this model refuses — and the sixth
    // dial below appears with no pull behind it.
    await tripServedBreaker();
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });

    for (let i = 0; i < 5; i++) {
      await tick(10_000);
      mockServed!({ peerId: ROUTE_1, dialable: true });
      await flush();
    }
    expect(dials()).toBe(3 + 5);
    expect(dialedAddrs().filter(a => a === ROUTE_1)).toHaveLength(5);

    // …and then nobody pulls for ten minutes. Nothing in this file has an
    // appointment with that address: no timer, no retry, no queue entry.
    await tick(10 * 60_000);
    expect(dials()).toBe(3 + 5);
  });

  it('a pull mid-attempt is BANKED, the latest wins, and failure promotes one', async () => {
    // THE SECOND SLOT. One attempt is in flight at a time, so a pull that
    // lands while the current dial is outstanding cannot have its own dial
    // — and must not be thrown away either, because it is a later
    // connection than the one being answered. It is banked, and a second
    // mid-attempt pull REPLACES it: two occurrences that both mean "the
    // peer is still there" coalesce, by GEN and never by spelling. The
    // failure of the current attempt promotes exactly the latest, for one
    // priority dial.
    //
    // Mutations: plant 04 drops the promotion (the banked pull is silently
    // lost — the podmate is mute until it pulls again); plant 13 promotes
    // every banked occurrence instead of the latest (two dials for one
    // slot, and the coalescing claim is false).
    await tripServedBreaker();
    await tick(10_000);

    // The claimed attempt takes the radio and stays on it.
    let settle!: (ok: boolean) => void;
    (linkSync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<{ accepted: number }>((resolve, reject) => {
          settle = ok =>
            ok ? resolve({ accepted: 0 }) : reject(new Error('connect timeout'));
        }),
    );
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);
    expect(logs.join('\n')).toContain(`served-evidence dial ${ROUTE_1} gen=1`);

    // Two more pulls arrive while that connection is up.
    await tick(20_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(logs.join('\n')).toContain(
      `served-evidence banked ${ROUTE_1} gen=2 replaces=0`,
    );
    await tick(20_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(logs.join('\n')).toContain(
      `served-evidence banked ${ROUTE_1} gen=3 replaces=2`,
    );
    expect(dials()).toBe(4); // one attempt in flight, always

    // The attempt dies. The current claim is consumed and the LATEST banked
    // occurrence — gen 3, not gen 2 — takes the slot for one dial.
    settle(false);
    await flush();

    expect(logs.join('\n')).toContain(`served-evidence spent ${ROUTE_1} gen=1`);
    expect(logs.join('\n')).toContain(
      `served-evidence promote ${ROUTE_1} gen=3`,
    );
    expect(logs.join('\n')).toContain(
      `dial ${ROUTE_1} via=nudge known=served evidence=3`,
    );
    expect(logs.join('\n')).not.toContain('evidence=2');
    expect(dials()).toBe(5); // exactly one promotion, not two
    expect(logs.filter(l => l.includes('served-evidence promote'))).toHaveLength(
      1,
    );

    // …and the promotion is spent like any other attempt: no second one.
    await tick(10_000);
    expect(dials()).toBe(5);
  });

  it('a dial that COMPLETES clears the banked occurrence too', async () => {
    // The other half of the two slots. Success opens the breaker outright,
    // so both slots go: a banked occurrence is a promise of one more dial
    // on a failure that is no longer coming. Mutation: clear only the
    // current claims on dial-ok and the stale bank survives — the next
    // failure on that address promotes proof from a window the radio has
    // already answered, which is a dial nobody's pull asked for.
    await tripServedBreaker();
    await tick(10_000);

    let settle!: (ok: boolean) => void;
    (linkSync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<{ accepted: number }>(resolve => {
          settle = () => resolve({ accepted: 0 });
        }),
    );
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    await tick(20_000);
    mockServed!({ peerId: ROUTE_1, dialable: true }); // banked behind it
    await flush();
    expect(logs.join('\n')).toContain(`served-evidence banked ${ROUTE_1}`);

    const mark = logs.length;
    settle(true);
    await flush();
    expect(logs.join('\n')).toContain('served-evidence clear reason=dial-ok');
    // A dial DOES follow the success — the ordinary reciprocity nudge any
    // completed pull earns — and that is exactly why the count is the wrong
    // thing to assert here. What the arm is about is the CLASS of that dial:
    // nothing after the success carries an evidence generation or a promoted
    // turn, because the success consumed both slots.
    const afterOk = since(mark)
      .split('\n')
      .filter(l => l.startsWith('[mesh] dial '));
    expect(afterOk.length).toBeGreaterThan(0);
    expect(afterOk.some(l => l.includes('evidence='))).toBe(false);
    expect(afterOk.some(l => l.includes('turn=promoted'))).toBe(false);
    expect(since(mark)).not.toContain('served-evidence promote');

    // THE PROOF OF THE CLEAR, because a slot nobody reads is invisible: put
    // the phone back where a promotion could happen — the breaker struck
    // out again, one fresh pull from this same address, and that attempt
    // failing. A surviving bank would promote itself into a second dial
    // that no pull of the podmate's ever asked for.
    await releaseCrewAdvertising();
    await tick(20_000); // ROUTE_1 falls out of the nudge's fresh window
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });
    for (const addr of [PULLED_A, PULLED_B, PULLED_C]) {
      await tick(1_000);
      mockServed!({ peerId: addr, dialable: true });
      await flush();
    }
    const struck = dials();

    logs.length = 0;
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(struck + 1);
    expect(logs.join('\n')).toContain(`served-evidence spent ${ROUTE_1}`);
    expect(logs.join('\n')).not.toContain('served-evidence promote');
  });

  it('the NEXT fresh pull — a rotated name — starts the cycle again', async () => {
    // The other half of the same rule, and the reason the debt is keyed to
    // the EVIDENCE rather than to the path: a central's name rotates, so
    // the peer's next pull is by construction a name this phone has never
    // spent. Mutation: allow one priority dial per rest window whatever the
    // address (`servedEvidence.size === 0`) and the podmate that rotated
    // once is mute until the rest expires — which is the 9.5 minutes again.
    await tripServedBreaker();
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });

    const rotations = [ROUTE_1, ROUTE_2, ROUTE_3];
    for (let i = 0; i < rotations.length; i++) {
      await tick(10_000);
      mockServed!({ peerId: rotations[i], dialable: true });
      await flush();
      expect(dials()).toBe(4 + i);
      expect(logs.join('\n')).toContain(
        `served-evidence dial ${rotations[i]} gen=${i + 1}`,
      );
    }
    expect(dialedAddrs()).toEqual([
      PULLED_A,
      PULLED_B,
      PULLED_C,
      ROUTE_1,
      ROUTE_2,
      ROUTE_3,
    ]);
  });

  it('the breaker still refuses a served-only address carrying no fresh proof', async () => {
    // THE BYPASS IS FOR ONE OCCURRENCE, and this is the arm that says so.
    // What crosses the rest window is a CLAIM — a pull this phone has not
    // answered yet. Everything else the ordinary paths queue is dropped at
    // the dial exactly as it always was, and the population that matters
    // here is the served-only address nobody has pulled from since the
    // breaker tripped: known, dialable-looking, and carrying no proof at
    // all. Mutation (plant 07): bypass the breaker for served-only
    // addresses unconditionally and the circuit breaking is gone — every
    // sighting and every compose re-dials the rotated corpses.
    //
    // ROUTE_1 pulls while the breaker is CLOSED, so no claim is ever minted
    // for it, and the reciprocity dial that follows succeeds.
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(1);

    // Three other rotations then strike the path out.
    await tripServedBreaker();
    expect(dials()).toBe(4);

    // A compose nudges every fresh address it can see, ROUTE_1 among them —
    // and the rest window drops it, because a nudge is a request to dial
    // and never proof about a peer.
    logs.length = 0;
    await tick(10_000);
    mockCompose!();
    await flush();
    expect(dials()).toBe(4);
    expect(logs.join('\n')).toContain(
      `drop ${ROUTE_1} reason=served-dial-resting`,
    );
  });

  it('the human asking does not spend a claim the radio was too busy to serve', async () => {
    // OWNERSHIP: a check is a request to dial, never proof about a peer.
    // The camper taps "Check for pod updates" while another connection is
    // up, so the check's own drain has not reached the claimed route and
    // has learned nothing about it. Mutation: consume (or clear) the
    // evidence in checkPodUpdates — the direct translation of the deleted
    // design's cancel-the-appointment line — and the claim's queue entry is
    // dropped as resting the moment the radio frees up. The camper's own
    // gesture would then be what silences the podmate.
    await tripServedBreaker();
    await tick(30_000);
    const settle = await holdTheWorker(PEER);
    expect(dials()).toBe(4);

    await tick(30_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4); // claimed and queued, waiting on the radio

    const checking = checkPodUpdates();
    await flush();
    settle(false);
    await flush();
    await checking;

    expect(dialedAddrs()).toContain(ROUTE_1);
    expect(logs.join('\n')).not.toContain(`served-evidence spent ${ROUTE_1}`);
  });

  it("another peer's success consumes nothing — the claimed dial still runs", async () => {
    // The same ownership rule from the other side. A dial that COMPLETES
    // pays the debt (the breaker opens, the claims are cleared), and that
    // is all it does: the queue entry the proof authorised is still owed,
    // because the mail behind it sits on that peer alone. Mutation: let the
    // dial-ok clear take the claimed ENTRIES out of the queue too — the
    // deleted design's "the appointment is moot" reasoning, which in a
    // queue is one peer's success silencing another peer's mailbox.
    await tripServedBreaker();
    await tick(30_000);
    const settle = await holdTheWorker(PEER);

    await tick(30_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);

    settle(true); // the unrelated op completes
    await flush();

    expect(logs.join('\n')).toContain(`dial-ok ${PEER}`);
    expect(dialedAddrs()).toContain(ROUTE_1);
    expect(logs.join('\n')).not.toContain(`served-evidence spent ${ROUTE_1}`);
  });

  it('a mesh restart forgets the debt — the same name is fresh proof again', async () => {
    // The lifecycle half, in the world (d) already describes: backgrounding
    // with the walkie open tears mailbox presence down and re-arms it, and
    // the mesh stops and starts underneath. A claim can only act through a
    // queue entry, and a stopped pod has no queue — so an OUTSTANDING claim
    // carried across a restart is an attempt that can never run and never
    // fail, and the next pull from that name would be banked behind it
    // forever. The debt is re-newed with every other address map at start.
    //
    // Mutation (plant 05): leave servedEvidence standing across
    // startMeshSync and the podmate below is mute for the life of the new
    // session — a stall inherited from a session that no longer exists.
    await tripServedBreaker();
    await tick(10_000);

    // The radio is busy with an ordinary peer, so the claim below is queued
    // and still unspent when the app backgrounds.
    const settle = await holdTheWorker(PEER);
    expect(dials()).toBe(4);
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4); // claimed, waiting on the radio
    expect(logs.join('\n')).toContain(`served-evidence dial ${ROUTE_1}`);
    expect(logs.join('\n')).not.toContain(`served-evidence spent ${ROUTE_1}`);

    stopMeshSync();
    settle(false); // the op that was in flight unwinds into the stopped pod
    await flush();
    startMeshSync(CODES);

    await tripServedBreaker(); // the new session strikes out too
    expect(dials()).toBe(7);

    // The same podmate pulls again, under the same name.
    const from = logs.length;
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    // A FRESH DEBT, FROM GENERATION ONE. The occurrence counter and both
    // evidence slots die with the session that learned them, so this pull is
    // CLAIMED. Carried across, the old unspent claim is still outstanding
    // and this pull is BANKED behind an attempt that can never run — a
    // stall inherited from a session that no longer exists, and the reason
    // the generation is asserted rather than the dial count: the ordinary
    // reciprocity nudge would dial this address either way, which is
    // exactly how a carried debt hides.
    expect(since(from)).toContain(`served-evidence dial ${ROUTE_1} gen=1`);
    expect(since(from)).not.toContain(`served-evidence banked ${ROUTE_1}`);
    expect(dials()).toBe(8);
    expect(dialedAddrs().filter(a => a === ROUTE_1)).toHaveLength(1);
  });

  it('the priority dial and the nudge behind it are ONE queue entry', async () => {
    // AN EFFICIENCY PIN, and it claims nothing else. With the walkie closed
    // a served event runs both roads: the priority claim unshifts the
    // address and the reciprocity nudge that follows would push it again.
    // The includes guard keeps that one entry. A duplicate would be a
    // second connect fetching mail the first one already had — waste, not a
    // wrong outcome — so no behaviour is proven here and none is claimed.
    await tripServedBreaker();
    const settle = await holdTheWorker(PEER);
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    settle(true);
    await flush();

    expect(dialedAddrs().filter(a => a === ROUTE_1)).toHaveLength(1);
  });

  // THE REMAINING COMPOSITION GAP, and it needs a Swift change rather than a
  // test: the native stop promise resolves before WalkieBleVoice's queued
  // advertiser-stop effect has run, so releaseCrewAdvertising can restart
  // crew advertising while the walkie's advertiser is still on the air —
  // the two-advertiser overlap this whole lane exists to prevent, in the
  // one window a source-level mock cannot see. Proving it needs the native
  // side to ACK completion (an advertiser-stopped event / a promise that
  // resolves on the effect, not on the queue accepting it), and then this
  // arm asserts the release waits for that ack.
  test.todo(
    'the release waits for WalkieBleVoice to ACK its advertiser stop (needs the native completion event)',
  );
});

/** One native pass — the op cost the ALTERNATION arm below runs at.
 * The 240 s and 360 s bounds are stated against the two-pass worst case
 * (120 s per op, as everywhere else in this file); the alternation arm
 * needs seven ops back to back, and at 120 s each the address forget
 * horizon (ADDRESS_FORGET_MS, 5 minutes) would quietly retire the waiting
 * peers halfway through — which would end the storm by deleting its
 * victims instead of by yielding to them. So the order is measured at one
 * pass per op and the arithmetic is left to the bound arm. */
const ONE_PASS_MS = 60_000;

// ---------------------------------------------------------------------------
// (j) THE FAIRNESS EPOCH — the cross-family NO-GO on the section above, and
// the half it could not see.
//
// (f) proved the priority dial is FAST. The finding is that it is fast at
// everybody else's expense, without bound: "N callbacks buy at most N
// dials" bounds the WORK and says nothing about WHOSE work it displaces. N
// is unbounded in time. A podmate this phone can be pulled FROM but cannot
// dial back — a rotated central name, the exact population the served path
// exists for — completes one digest pull inside every 120 s failure, and
// each one banks a newer occurrence that the failure promotes straight back
// to the FRONT of the queue. The breaker cannot see it, because fresh proof
// is precisely what the breaker was told to let through. Three unrelated
// peers behind that address wait forever.
//
// The cure is a CREDIT, one per address per fairness epoch. The first claim
// of an epoch takes the front exactly as before (the 210 s arm in (f) is
// untouched and is the pin on that). A claim made before the address has
// yielded goes NEXT-AFTER-ONE — behind the first unrelated peer waiting and
// never behind more. An epoch ends at a dial TURN: the address taking it
// spends its own credit and every other address gets one back; an idle
// worker (queue drained) owes nobody a turn and restores everyone's.
//
// So the debt charged to an unrelated peer is exactly ONE native op, never
// the whole queue: current op + one fairness peer + the target = 360 s from
// the proof, inside the 480 s owner bar.
// ---------------------------------------------------------------------------

describe('(j) the fairness epoch: a storming peer cannot monopolise the worker', () => {
  it('a sustained callback storm alternates with three waiting peers', async () => {
    // THE ARM THE REVIEWER ORDERED. The podmate completes a digest pull
    // during EVERY op that runs, so there is always a newer occurrence
    // banked behind the attempt in flight and every failure has one to
    // promote — the endless failure->promote cycle, verbatim.
    //
    // Mutation (plant 18): promotion always unshifts, i.e. the d9a6c27
    // placement. The storm then takes five consecutive turns and the three
    // waiting peers are not dialled until it runs out of pulls.
    // Mutation (plant 20): the dial turn restores EVERY credit including
    // the dialling address's own, which is the same monopoly by another
    // road.
    await tripServedBreaker();
    await tick(10_000);

    // One ordinary op holds the single-flight worker; three unrelated peers
    // queue behind it. GATT-sighted, as everywhere in this file: the
    // population addressFresh never condemns.
    const settle = await holdTheWorker(PEER);
    expect(dials()).toBe(4);
    const queuedAt = now;
    for (const waiting of [WAITING_1, WAITING_2, WAITING_3]) {
      mockSighting!({ peerId: waiting, via: 'gatt' });
    }
    await flush();
    expect(dials()).toBe(4);

    // EVERY op fails, the storm's and the peers' alike. A success would
    // open the breaker outright and clear both slots, which ends the
    // subject rather than testing it; and a phone that cannot complete a
    // dial is the world this whole path was written for.
    const doneAt: Array<{ addr: string; at: number }> = [];
    let pulls = 0;
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      now += ONE_PASS_MS;
      doneAt.push({ addr: target, at: now });
      if (pulls < 4) {
        pulls += 1;
        mockServed!({ peerId: ROUTE_1, dialable: true });
      }
      throw new Error('could not connect');
    });

    // The pull that spends the storm address's one priority credit. (What
    // that placement was is asserted below, AFTER the dial order — so a
    // tree with no fairness placement at all dies on the starvation and
    // not on a missing log line.)
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);

    settle(false);
    await flush();

    // BOUNDED ALTERNATION: the storm gets the front once, and after that it
    // is behind exactly one waiting peer every single time.
    expect(dialedAddrs().slice(3)).toEqual([
      PEER,
      ROUTE_1,
      WAITING_1,
      ROUTE_1,
      WAITING_2,
      ROUTE_1,
      WAITING_3,
      ROUTE_1,
    ]);
    const timed = doneAt.map(d => d.addr);
    for (let i = 1; i < timed.length; i++) {
      // Stated as the property, not only as the list above: never two
      // consecutive storm dials.
      expect([timed[i - 1], timed[i]]).not.toEqual([ROUTE_1, ROUTE_1]);
    }

    // …and it yields by ONE turn, not by the queue: every promotion lands
    // at index 1, behind whichever peer is at the head.
    expect(logs.filter(l => l.includes('served-fairness'))).toEqual([
      `[mesh] served-fairness ${ROUTE_1} pos=1 behind=${WAITING_1}`,
      `[mesh] served-fairness ${ROUTE_1} pos=1 behind=${WAITING_2}`,
      `[mesh] served-fairness ${ROUTE_1} pos=1 behind=${WAITING_3}`,
    ]);
    expect(
      logs.filter(l => l === `[mesh] served-priority ${ROUTE_1} pos=front`),
    ).toHaveLength(1);

    // MAX WAIT, in numbers. Each unrelated peer pays one storm turn and
    // nothing more: its own op plus exactly one of the storm's, so the
    // gap between consecutive unrelated dials is 2 x ONE_PASS_MS however
    // long the storm runs. All three are served inside the owner bar.
    const at = (addr: string) => doneAt.find(d => d.addr === addr)!.at;
    expect(at(WAITING_1) - queuedAt).toBe(2 * ONE_PASS_MS);
    expect(at(WAITING_2) - at(WAITING_1)).toBe(2 * ONE_PASS_MS);
    expect(at(WAITING_3) - at(WAITING_2)).toBe(2 * ONE_PASS_MS);
    expect(at(WAITING_3) - queuedAt).toBe(6 * ONE_PASS_MS);
    expect(at(WAITING_3) - queuedAt).toBeLessThan(BAR_MS);
  });

  it('the promoted dial waits behind ONE peer: 360 s from the proof', async () => {
    // THE OWNER BAR, preserved in numbers. The fairness yield costs the
    // promoted dial one unrelated op and never the rest of the queue, so
    // the worst case from the proof is: the op already in flight (120 s) +
    // one fairness peer (120 s) + the target itself (120 s) = 360 s, with
    // two minutes of the 480 s bar still unspent — and WAITING_2 and
    // WAITING_3 are still behind it, which is the "one turn, not all
    // queue" half.
    //
    // Mutation (plant 02): append instead of placing, and the promoted dial
    // waits out the whole queue. Mutation (plant 18): always unshift, and
    // the number is 240 but the peers starve — which is why this arm and
    // the storm arm above are both required.
    await tripServedBreaker();
    await tick(10_000);

    const settle = await holdTheWorker(PEER);
    for (const waiting of [WAITING_1, WAITING_2, WAITING_3]) {
      mockSighting!({ peerId: waiting, via: 'gatt' });
    }
    await flush();
    expect(dials()).toBe(4);

    // Pull #1 spends the credit and takes the front — the (f) path.
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    // Every op is now the two-pass worst case, and the podmate's NEXT pull
    // lands at the instant its own priority dial STARTS. That pull is the
    // proof the 360 s is measured from: it is banked behind the attempt in
    // flight, and that attempt's failure is what promotes it.
    const doneAt: Array<{ addr: string; at: number }> = [];
    let proofAt = 0;
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      if (target === ROUTE_1 && proofAt === 0) {
        proofAt = now;
        mockServed!({ peerId: ROUTE_1, dialable: true });
      }
      now += 120_000;
      doneAt.push({ addr: target, at: now });
      throw new Error('could not connect');
    });

    settle(false);
    await flush();

    expect(dialedAddrs().slice(3)).toEqual([
      PEER,
      ROUTE_1,
      WAITING_1,
      ROUTE_1,
      WAITING_2,
      WAITING_3,
    ]);
    expect(logs.join('\n')).toContain(
      `served-fairness ${ROUTE_1} pos=1 behind=${WAITING_1}`,
    );

    // ONE unrelated turn between the proof's own dial and the promoted one.
    const between = doneAt
      .map(d => d.addr)
      .slice(1, doneAt.map(d => d.addr).lastIndexOf(ROUTE_1));
    expect(between).toEqual([WAITING_1]);

    // AND THE CLASS GATE ADDS NOTHING TO THIS COMPOSITION: the promotion
    // is already behind the first ordinary waiter by the per-address rule,
    // so the class floor is the same index and never fires. One ordinary
    // op is charged, once — after the class rule exactly as before it.
    expect(logs.join('\n')).not.toContain('served-class');

    const promoted = doneAt.filter(d => d.addr === ROUTE_1)[1].at;
    expect(promoted - proofAt).toBe(360_000);
    expect(promoted - proofAt).toBeLessThanOrEqual(BAR_MS);
  });

  it("another address's dial hands the storming peer its credit back", async () => {
    // THE EPOCH BOUNDARY, from the restoring side. The yield is one turn,
    // so once an unrelated peer has actually been served the storm address
    // is a first-claimant again and its next pull takes the front — which
    // is what keeps the cure a FAIRNESS rule and not a demotion.
    //
    // Mutation (plant 19): the dial turn never restores anybody's credit.
    // The address that yielded once then yields forever, and its fresh
    // proof — a pull that arrived after a peer was served — is placed
    // behind WAITING_2 instead of ahead of it.
    await tripServedBreaker();
    await tick(10_000);

    const settle = await holdTheWorker(PEER);
    for (const waiting of [WAITING_1, WAITING_2, WAITING_3]) {
      mockSighting!({ peerId: waiting, via: 'gatt' });
    }
    await flush();

    // Pull #1: the first claim of the epoch, straight to the front.
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    // Its dial fails with NOTHING banked behind it, so no promotion
    // happens; WAITING_1 then takes a turn, and the podmate's next pull
    // arrives inside that turn — after an unrelated peer has been served.
    let pulled = false;
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      now += 120_000;
      if (target === WAITING_1 && !pulled) {
        pulled = true;
        mockServed!({ peerId: ROUTE_1, dialable: true });
      }
      throw new Error('could not connect');
    });

    settle(false);
    await flush();

    expect(dialedAddrs().slice(3)).toEqual([
      PEER,
      ROUTE_1,
      WAITING_1,
      ROUTE_1,
      WAITING_2,
      WAITING_3,
    ]);
    // Both of the storm address's claims took the front, and neither had to
    // yield: one turn of debt was paid by WAITING_1 and the credit came
    // back with it.
    expect(
      logs.filter(l => l === `[mesh] served-priority ${ROUTE_1} pos=front`),
    ).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('served-fairness');
  });

  it('an idle worker hands the credit back, and says so in one line', async () => {
    // THE OTHER EPOCH BOUNDARY, and an honest note about what can be
    // observed. A worker only goes idle when its queue is EMPTY, so at that
    // moment the two placements — the front, and behind the first unrelated
    // peer — are the same single entry, and NO dial order can separate
    // them. That is not a weakness of the arm, it is why an idle worker is
    // a safe epoch boundary: there is nobody waiting to be jumped. What the
    // reset decides is the state the next epoch STARTS in, and the
    // placement log is where that state is visible.
    //
    // Mutation (plant 21): drop only the idle reset. The address that
    // dialled last stays marked forever, so its next claim — with the queue
    // long since empty — is filed as a fairness yield to nobody.
    await tripServedBreaker();
    await tick(10_000);
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });

    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);
    expect(logs.join('\n')).toContain(`served-priority ${ROUTE_1} pos=front`);

    // That dial spent the credit and drained the queue: the worker is idle.
    logs.length = 0;
    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();

    expect(dials()).toBe(5);
    expect(logs.join('\n')).toContain(`served-priority ${ROUTE_1} pos=front`);
    expect(logs.join('\n')).not.toContain('served-fairness');
  });
});

// ---------------------------------------------------------------------------
// (k) THE CLASS-LEVEL FAIRNESS EPOCH — the cross-family NO-GO on (j), and
// the half a single-storm arm cannot see.
//
// (j)'s credit is PER ADDRESS, and a dial turn restores every OTHER
// address's. Two storming podmates therefore hand it back and forth: A and
// B both take a front, B's turn restores A's credit, A's turn restores
// B's, and the queue cycles B, A, B, A while an ordinary peer C waits
// forever. Every clause of (j) still holds — no address takes two
// consecutive turns, each yields to "one unrelated peer" — and C starves
// anyway, because the peer each of them yielded to was the OTHER storm.
//
// So the outer credit belongs to the served-priority CLASS. Any promoted
// turn spends it; while it is spent every promotion is placed behind the
// first ORDINARY waiter, including a first claim carrying its own credit;
// and only an ordinary dial turn or a truly idle worker hands it back — a
// different served address does not. The per-address rule of (j) is kept
// beneath it and still owns the occurrence, the current+pending slots and
// every placement the class gate leaves open, so the class rule can only
// move a promotion further back and never forward. Net law: promoted and
// ordinary turns ALTERNATE whenever both classes are waiting.
// ---------------------------------------------------------------------------

/** The two storming podmates and the ordinary peer they starve on
 * 6e0e003 — named for the roles, because the arms below are about the
 * CLASS and never about which address is which. */
let bSettle: () => void = () => undefined;
const STORM_A = ROUTE_1;
const STORM_B = ROUTE_2;
const ORDINARY_C = WAITING_1;

/** Every dial the log recorded, with the CLASS of its turn read off the
 * log line rather than off the address: `turn=promoted` is a served
 * priority placement taking its go, `turn=ordinary` is a sighting or a
 * nudge taking one. Reading the class off the address instead would be the
 * very assumption the finding killed — that a rule about one storm is a
 * rule about the storming class. */
const dialTurns = () =>
  logs
    .filter(l => l.startsWith('[mesh] dial '))
    .map(l => ({
      addr: l.split(' ')[2],
      promoted: l.includes(' turn=promoted'),
    }));

/**
 * THE ARM THE REVIEWER PRE-ANNOUNCED: two storm addresses A and B, each
 * completing a digest pull inside every op that runs (<= 120 s, here one
 * pass), and one ordinary peer C continuously on the air behind them.
 *
 * `supply` caps the pulls and the sightings so the drain terminates — an
 * uncapped storm is not a stronger arm, it is a hang.
 */
const twoStormsAndAnOrdinary = async (supply: number) => {
  await tripServedBreaker();
  await tick(10_000);

  // One ordinary op holds the single-flight worker and C waits behind it,
  // exactly as in (j) — the difference is only that TWO storms arrive.
  const settle = await holdTheWorker(PEER);
  expect(dials()).toBe(4);
  mockSighting!({ peerId: ORDINARY_C, via: 'gatt' });
  await flush();
  expect(dials()).toBe(4);
  const queuedAt = now;

  // Every op fails, the storms' and C's alike: a success would open the
  // breaker outright and end the subject rather than test it.
  const doneAt: Array<{ addr: string; at: number }> = [];
  let left = supply;
  (linkSync as jest.Mock).mockImplementation(async () => {
    const target = dialedAddrs()[dialedAddrs().length - 1];
    now += ONE_PASS_MS;
    doneAt.push({ addr: target, at: now });
    if (left > 0) {
      left -= 1;
      mockServed!({ peerId: STORM_A, dialable: true });
      mockServed!({ peerId: STORM_B, dialable: true });
      mockSighting!({ peerId: ORDINARY_C, via: 'gatt' });
    }
    throw new Error('could not connect');
  });

  // Both storms pull while the ordinary op still holds the radio: two
  // first claims of an epoch, each with its own per-address credit in
  // hand, and on 6e0e003 both of them take the front.
  mockServed!({ peerId: STORM_A, dialable: true });
  mockServed!({ peerId: STORM_B, dialable: true });
  await flush();
  expect(dials()).toBe(4);

  settle(false);
  await flush();
  return { doneAt, queuedAt };
};

describe('(k) the class epoch: two storming peers cannot alternate a third away', () => {
  it('A + B storming, C waiting: C is served and no two promoted turns run back to back', async () => {
    // THE ARM THE REVIEWER PRE-ANNOUNCED, verbatim: "TWO storm addresses
    // A+B plus ordinary C. Per-address credit restoration by another
    // address may let A/B alternate priority and still starve C; GO
    // requires the entire served-priority class never gets consecutive
    // promoted turns while any ordinary waiter exists, not merely no
    // same-address adjacency."
    //
    // Mutation (plant 00c): the whole of 6e0e003 — the per-address credit
    // with no class above it. A and B hand the front back and forth
    // (B's turn restores A, A's turn restores B) and C is never dialled
    // at all, which is the finding this commit cures.
    // Mutation (plant 22): the class gate deleted from both the placement
    // and the turn. Same starvation by the same road.
    // Mutation (plant 25): a DIFFERENT served address restores the class
    // credit — the per-address rule lifted one level and no better for it.
    const { doneAt, queuedAt } = await twoStormsAndAnOrdinary(8);

    // THE STARVATION ITSELF, first and in plain addresses — no log marker
    // this commit introduced, so a tree that predates the marker still
    // dies here on the defect rather than on the telemetry.
    expect(dialedAddrs().slice(3)).toEqual([
      PEER,
      STORM_B,
      ORDINARY_C,
      STORM_A,
      ORDINARY_C,
      STORM_B,
      ORDINARY_C,
      STORM_A,
      ORDINARY_C,
      STORM_B,
      ORDINARY_C,
    ]);

    // C IS ACTUALLY SERVED, and on a bounded clock: two ops after it was
    // queued, and every two ops after that however long the storms run.
    const cAt = doneAt.filter(d => d.addr === ORDINARY_C).map(d => d.at);
    expect(cAt).toHaveLength(5);
    expect(cAt[0] - queuedAt).toBe(2 * ONE_PASS_MS);
    expect(cAt[0] - queuedAt).toBeLessThan(BAR_MS);
    for (let i = 1; i < cAt.length; i++) {
      expect(cAt[i] - cAt[i - 1]).toBe(2 * ONE_PASS_MS);
    }

    // AND BOTH STORMS STILL MAKE PROGRESS. The cure is a fairness rule and
    // not a mute: yielding to the ordinary class must not cost the served
    // class its reciprocal dials, which are the whole reason (f) exists.
    // (Plant 24 — the class credit that is never handed back — dies here.)
    const dialled = doneAt.map(d => d.addr);
    expect(dialled.filter(a => a === STORM_A).length).toBeGreaterThanOrEqual(2);
    expect(dialled.filter(a => a === STORM_B).length).toBeGreaterThanOrEqual(2);

    // THE SAME ORDER, with the CLASS of every turn read off its log line.
    // Promoted and ordinary strictly alternate: each storm takes one turn,
    // and the ordinary peer takes the next one every single time.
    expect(dialTurns().slice(4)).toEqual([
      { addr: STORM_B, promoted: true },
      { addr: ORDINARY_C, promoted: false },
      { addr: STORM_A, promoted: true },
      { addr: ORDINARY_C, promoted: false },
      { addr: STORM_B, promoted: true },
      { addr: ORDINARY_C, promoted: false },
      { addr: STORM_A, promoted: true },
      { addr: ORDINARY_C, promoted: false },
      { addr: STORM_B, promoted: true },
      { addr: ORDINARY_C, promoted: false },
    ]);

    // …and stated as the PROPERTY the reviewer asked for rather than as
    // the list above: no two promoted turns run back to back while an
    // ordinary peer is waiting, and the class of each turn is read off the
    // log line rather than off the address. C is supplied continuously, so
    // it is waiting at every one of these boundaries.
    const turns = dialTurns();
    for (let i = 1; i < turns.length; i++) {
      expect([turns[i - 1].promoted, turns[i].promoted]).not.toEqual([
        true,
        true,
      ]);
    }

    // THE CLASS CREDIT'S LIFECYCLE, in the log. Every promotion after the
    // two opening fronts is filed against the CLASS, and the entry that
    // was already sitting ahead of C when the class went into debt gives
    // its turn up at the worker instead.
    expect(
      logs.filter(l => l.includes('served-class-fairness')),
    ).toHaveLength(5);
    expect(logs.filter(l => l.includes('served-class-yield'))).toHaveLength(5);
    expect(logs.filter(l => l.includes('pos=front'))).toEqual([
      `[mesh] served-priority ${STORM_A} pos=front`,
      `[mesh] served-priority ${STORM_B} pos=front`,
    ]);
  });

  it('the alternation law: with both classes supplied, the classes take turns', async () => {
    // THE LAW ITSELF, stated in both directions over a longer run and
    // without naming a single address: while both classes are waiting,
    // consecutive turns never belong to the same class. Two promoted turns
    // in a row is the starvation this commit cures; two ORDINARY turns in
    // a row is its mirror — a class credit that is never handed back would
    // mute the served path entirely, and (f)'s whole bound with it.
    //
    // Mutation (plant 23): the class credit is never spent, so nothing
    // gates the second storm and the promoted side runs back to back.
    // Mutation (plant 24): it is never handed back, so the ordinary side
    // runs back to back instead and the storms never dial again.
    const { doneAt } = await twoStormsAndAnOrdinary(12);
    const classes = dialTurns()
      .slice(4)
      .map(t => t.promoted);
    // The storms run until the breaker's rest window lapses under them —
    // ten turns here, and the law is asserted over every one of them.
    expect(classes.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < classes.length; i++) {
      expect(classes[i]).toBe(!classes[i - 1]);
    }
    // Both storms are on the promoted side of that alternation — one
    // address monopolising it would satisfy the law above and still be the
    // defect, so the two are pinned together.
    const promotedAddrs = dialTurns()
      .slice(4)
      .filter(t => t.promoted)
      .map(t => t.addr);
    expect(new Set(promotedAddrs)).toEqual(new Set([STORM_A, STORM_B]));
    expect(
      doneAt.filter(d => d.addr === ORDINARY_C).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('an ORDINARY turn hands the class credit back; a second served address does not', async () => {
    // THE LIFECYCLE, both ends of it, in one dial order. The class credit
    // is spent by B's promoted turn (so A, already sitting ahead of C,
    // gives its turn up); C's ORDINARY turn hands it back (so B's next
    // claim takes the front again, exactly as (f)'s 210 s path does); and
    // nothing in between — least of all A's or B's own served turns —
    // restores it.
    //
    // Mutation (plant 24): the credit is never handed back. B's second
    // claim is filed behind D instead of at the front, and the order dies.
    // Mutation (plant 25): a different served address hands it back. A
    // then never yields at all and dials straight after B.
    // Mutation (plant 22): no class gate, same.
    await tripServedBreaker();
    await tick(10_000);

    // Two ordinary peers waiting, so the queue still holds one after C has
    // taken its turn — without that, the class gate would have nobody to
    // defer to and the arm could not tell the two rules apart.
    const settle = await holdTheWorker(PEER);
    for (const waiting of [ORDINARY_C, WAITING_2]) {
      mockSighting!({ peerId: waiting, via: 'gatt' });
    }
    await flush();
    expect(dials()).toBe(4);

    // Both storms claim a front while the class credit is in hand.
    mockServed!({ peerId: STORM_A, dialable: true });
    mockServed!({ peerId: STORM_B, dialable: true });
    await flush();

    // Every dial fails, and B pulls again DURING C's ordinary turn — the
    // moment the class credit has just come back.
    let pulled = false;
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      now += ONE_PASS_MS;
      if (target === ORDINARY_C && !pulled) {
        pulled = true;
        mockServed!({ peerId: STORM_B, dialable: true });
      }
      throw new Error('could not connect');
    });

    settle(false);
    await flush();

    expect(dialTurns().slice(4)).toEqual([
      { addr: STORM_B, promoted: true },
      { addr: ORDINARY_C, promoted: false },
      { addr: STORM_B, promoted: true },
      { addr: WAITING_2, promoted: false },
      { addr: STORM_A, promoted: true },
    ]);
    const line = logs.join('\n');
    // A was ahead of C when B spent the class credit, and gave the turn up
    // at the worker — the placement gate could not have reached it.
    expect(line).toContain(
      `served-class-yield ${STORM_A} pos=1 behind=${ORDINARY_C}`,
    );
    expect(line).toContain(
      `served-class-yield ${STORM_A} pos=1 behind=${WAITING_2}`,
    );
    // …and B's claim, made after an ORDINARY turn, is a front again.
    expect(
      logs.filter(l => l === `[mesh] served-priority ${STORM_B} pos=front`),
    ).toHaveLength(2);
  });

  it('an ordinary-free queue: the class credit gates nothing, and the bound is 210 s', async () => {
    // THE BOUND (f) IS STATED AGAINST, re-asserted with the class credit
    // ALREADY SPENT. The gate defers to the ORDINARY class and to nothing
    // else, so when every waiter is itself a promotion — or there is no
    // waiter at all — a fresh claim takes the front exactly as it did
    // before this commit, and the arithmetic is (f)'s own: what the op in
    // flight has left (90 s of its 120) plus the target's own 120 s.
    //
    // Mutation (plant 26): the gate defers to whatever is at the head of
    // the queue instead of to the first ORDINARY waiter. The fresh claim
    // is then filed behind another storm, the front is not the front, and
    // the 210 s becomes 330.
    await tripServedBreaker();
    await tick(120_000);

    // An ordinary op holds the worker; two storms take their fronts.
    const settle = await holdTheWorker(PEER);
    mockServed!({ peerId: STORM_A, dialable: true });
    mockServed!({ peerId: STORM_B, dialable: true });
    await flush();
    expect(dials()).toBe(4);

    // B's turn spends the class credit and leaves A — a PROMOTED entry,
    // and the only one waiting — behind it.
    const doneAt = new Map<string, number>();
    (linkSync as jest.Mock).mockImplementation(async () => {
      const target = dialedAddrs()[dialedAddrs().length - 1];
      now += 120_000;
      doneAt.set(target, now);
      throw new Error('could not connect');
    });
    (linkSync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<{ accepted: number }>((_res, rej) => {
          bSettle = () => rej(new Error('connect timeout'));
        }),
    );
    settle(false);
    await flush();
    expect(dialedAddrs().slice(3)).toEqual([PEER, STORM_B]);

    // 30 s into B's op a THIRD podmate hands over fresh proof. The class
    // credit is spent, and the queue holds one waiter — but that waiter is
    // promoted, not ordinary, so the gate has nobody to defer to.
    await tick(30_000);
    const eventAt = now;
    mockServed!({ peerId: ROUTE_3, dialable: true });
    await flush();
    expect(logs.join('\n')).toContain(`served-priority ${ROUTE_3} pos=front`);
    expect(logs.join('\n')).not.toContain(`served-class-fairness ${ROUTE_3}`);

    await tick(90_000);
    bSettle();
    await flush();

    // FRONT: ahead of the storm that was already waiting, and dialled on
    // the very next turn of the worker.
    expect(dialedAddrs().slice(3)).toEqual([PEER, STORM_B, ROUTE_3, STORM_A]);
    expect(logs.join('\n')).not.toContain(`served-class-yield ${ROUTE_3}`);
    expect(doneAt.get(ROUTE_3)! - eventAt).toBe(210_000);
    expect(doneAt.get(ROUTE_3)! - eventAt).toBeLessThanOrEqual(240_000);
    expect(doneAt.get(ROUTE_3)! - eventAt).toBeLessThan(BAR_MS);
  });
});

// ---------------------------------------------------------------------------
// (l) THE SESSION EPOCH — the stop/start race, and the two things this lane's
// evidence machinery gave it to break.
//
// PROVENANCE, because it decides how this section is read, and the hash this
// section cited through ac124d8 was WRONG: 15db991 is a walkie-BLE commit
// that never touched src/crews/meshSync.ts. The race is a PRE-EXISTING CLASS
// traced to 949d0bd — the commit that CREATED this file with an async drain
// (a shared `syncing` boolean and a loop awaiting linkSync). stopMeshSync
// clears the queue and the markers and cannot cancel a native op already in
// flight, so the drain awaiting that op wakes up in whatever world it finds
// and mutates shared module state after the await. Nothing in the airtime
// chain introduced that.
//
// What the chain did was AMPLIFY THE CONSEQUENCES by composition:
//   a9a4251 gave a completed dial the power to clear every claim, so an OLD
//     session's success can now erase the NEW session's current + pending
//     evidence;
//   d9a6c27 gave a failure the power to promote a banked occurrence, so an
//     OLD session's failure can now re-add queue, nudge and promoted markers
//     to a session that never earned them — or, with running=false, to no
//     session at all.
//
// So the cure is an identity rather than another flag. Every start and every
// stop mints an epoch; the drain and each dial capture the epoch they began
// in; after EVERY await the capture must still be current before one shared
// write happens; and a stale completion does only what it alone owns, which
// is a log line (native owns the connection). The drain-ownership flag is
// epoch-scoped for the same reason — a boolean is INHERITED across a restart
// in both directions.
//
// AND THE PREDICATE GOES DOWN THE PIPELINE. A guard in meshSync alone is
// necessary and not sufficient: syncLink stamps its want ledger, makes its
// SECOND radio pass, accepts incoming rows into the store and acks the
// ledger, all before its promise returns — and linkFor's own fetchDigest
// stamps lastSeen / digestSig / offeredSame the instant the first pass lands.
// The lower layers are NOT pure until return, so the epoch predicate is
// threaded rather than assumed, and the arm below drives the REAL conductor
// to prove a stale session cannot import or ack into the pod that replaced
// it.
// ---------------------------------------------------------------------------

/** The log lines written after a mark — every arm here is about what the
 * SECOND session did or did not see. */
const since = (from: number) => logs.slice(from).join('\n');

/** The served-evidence world of a live session: the breaker resting, a
 * CURRENT claim whose dial is in flight on a switch the arm holds, and the
 * LATEST occurrence banked behind it. Returns the switch. */
const servedClaimInFlight = async (addr: string, accepted = 0) => {
  const settle = armTheRadio(accepted);
  const before = dials();
  mockServed!({ peerId: addr, dialable: true });
  await flush();
  expect(dials()).toBe(before + 1);
  // …and the pull that lands while that attempt is outstanding: banked, not
  // dialled. No tick, so the nudge floor keeps this to one queue entry.
  mockServed!({ peerId: addr, dialable: true });
  await flush();
  expect(dials()).toBe(before + 1);
  return settle;
};

describe('(l) the session epoch: a stopped session cannot act on a live one', () => {
  it('THE HEADLINE ARM: an old FAILURE promotes nothing into the new session', async () => {
    // The reviewer's own script, brought forward one composition: served
    // current claim + banked pending in flight -> stop mid-await -> IMMEDIATE
    // start with DISTINCT crewCodes -> the live session queues work of its
    // own -> settle the OLD failure. Zero old promotion, spend, strike or
    // dial-fail bookkeeping, and the live session's own queue comes through
    // the collision whole.
    //
    // WHY THE LIVE SESSION'S WORK IS QUEUED RATHER THAN DIALLED here, and it
    // is the second refusal this lane added: the RADIO is still held by the
    // dead session's op. The native-op arbiter (section (n)) parks the live
    // drain until that op settles, precisely so the replacement session
    // cannot be answered 'busy' and charged a cooldown, a fairness turn and a
    // spent claim for a dead session's leftover. So the collision this arm
    // drives is the one that remains reachable: a stale completion landing on
    // a live session's QUEUE, breaker and counters.
    //
    // Mutation (plant 27): the post-await guards deleted — the 949d0bd shape.
    // The old failure then logs its ordinary dial-fail, spends and FORGETS
    // ROUTE_1 — taking the live session's own queue entry for that address
    // out with the name — and strikes the live session's breaker.
    await tripServedBreaker();
    await tick(10_000);
    const settleOld = await servedClaimInFlight(ROUTE_1);
    expect(logs.join('\n')).toContain(`served-evidence dial ${ROUTE_1} gen=1`);
    expect(logs.join('\n')).toContain(
      `served-evidence banked ${ROUTE_1} gen=2 replaces=0`,
    );

    // The app backgrounds and comes straight back: a new session, with a
    // different pod's codes, over an op that is still on the radio.
    stopMeshSync();
    startMeshSync(NEW_CODES);
    const from = logs.length;
    const mark = dials();

    // The live session hears the SAME address the dead dial is about to fail
    // on, plus an unrelated peer, and queues both. Nothing dials: the dead
    // op still owns the radio.
    mockSighting!({ peerId: ROUTE_1, via: 'gatt' });
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark);
    // DEFERRED, not parked: the live drain leaves its queue intact and
    // returns, so the worker is free and the entries are still there. The
    // arbiter's own release is what re-enters it.
    expect(since(from)).toContain('defer reason=radio-busy');

    // NOW the dead session's dial finally fails. Everything from this mark
    // on is the stale completion's doing and nobody else's.
    const settled = logs.length;
    settleOld(false);
    await flush();
    await flush();

    // ZERO old bookkeeping: no ordinary failure line, no promotion, no spend,
    // no strike.
    expect(since(settled)).toContain(
      `drop ${ROUTE_1} reason=stale-epoch phase=dial-fail`,
    );
    expect(since(settled)).not.toContain(`dial-fail ${ROUTE_1}`);
    expect(since(settled)).not.toContain('served-evidence promote');
    expect(since(settled)).not.toContain(`served-evidence spent ${ROUTE_1}`);
    expect(since(settled)).not.toContain('served-dials resting');

    // …and the live session's own queue came through whole, in its own
    // order, on its own codes. A stale forgetAddress would have taken
    // ROUTE_1's entry with the name.
    expect(dialedAddrs().slice(mark)).toEqual([ROUTE_1, WAITING_1]);
    for (let i = mark; i < dials(); i++) {
      expect(codesOfDial(i)).toEqual(['jade-compass-77']);
    }
  });

  it('THE TWIN ARM: an old SUCCESS erases none of the new session evidence', async () => {
    // The a9a4251 half of the amplification, from the other side. A completed
    // dial pays the debt outright — it opens the breaker, zeroes the strikes,
    // clears BOTH evidence slots and stamps the pod's "last caught up" line
    // and its accepted counter — and every one of those writes lands in
    // whatever session is live when the promise resolves.
    //
    // Mutation (plant 27): the same deleted guards. The old success then
    // stamps a dead pod's success onto the LIVE pod's surfaces: lastPodSyncMs
    // starts reading as caught-up in a session that has never completed a
    // dial, and the mail it counted is added to a counter the human's own
    // check subtracts from.
    await tripServedBreaker();
    await tick(10_000);
    const settleOld = await servedClaimInFlight(ROUTE_1, 3);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    const from = logs.length;
    // The live session has completed nothing, so it says so.
    expect(lastPodSyncMs()).toBe(null);

    // The dead session's dial SUCCEEDS, carrying three accepted messages.
    const settled = logs.length;
    settleOld(true);
    await flush();
    await flush();

    expect(since(settled)).toContain(
      `drop ${ROUTE_1} reason=stale-epoch phase=dial-ok`,
    );
    expect(since(settled)).not.toContain('served-evidence clear');
    expect(since(settled)).not.toContain(`dial-ok ${ROUTE_1}`);
    // THE SURFACES: a dead pod's success is not this pod's recency line, and
    // its three messages are not this pod's mail.
    expect(lastPodSyncMs()).toBe(null);
    const checked = await checkPodUpdates();
    expect(checked.cancelled).toBe(undefined);
    expect(checked.moved).toBe(0);
    expect(since(from)).not.toContain(`dial-ok ${ROUTE_1}`);
  });

  it('a stale drain resumes into nothing: no dial, and never the old codes', async () => {
    // THE OLD-CREWCODES DISCRIMINATION. `running` flips true again the
    // instant the new session starts, so the pre-cure loop condition is
    // satisfied for a drain that belongs to a session that is gone: it shifts
    // the LIVE queue and dials the live session's peers with the dead
    // session's crew codes — the getter it captured at launch.
    //
    // Mutation (plant 28): the drain has no epoch discrimination at all
    // (guards and loop condition both). The stale drain then takes the live
    // session's waiting entries and dials them with CODES — dying on the
    // codes AND on the missing stale-epoch line.
    // Mutation (plant 29): the same, plus the codes RE-READ from the module
    // instead of taken from the capture. The stale dial then carries the new
    // session's codes, so only the stale-epoch clause can see it — which is
    // why both are asserted.
    const settleOld = await holdTheWorker(PEER);
    expect(dials()).toBe(1);
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(1); // one op in flight, one entry waiting

    stopMeshSync();
    startMeshSync(NEW_CODES);
    const from = logs.length;
    const mark = dials();

    // The live session queues two of its own behind the dead op.
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    mockSighting!({ peerId: WAITING_3, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark);

    // The dead session's op unwinds. Its drain resumes into a queue that is
    // not its own and must take nothing from it.
    settleOld(false);
    await flush();
    await flush();

    expect(since(from)).toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-fail`,
    );
    // The live session's own drain services its own queue, in its own order.
    // WAITING_1 — the DEAD session's entry — is nowhere in it: the reset took
    // it, and no stale drain put it back.
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_2, WAITING_3]);
    expect(dialedAddrs()).not.toContain(WAITING_1);
    // NEVER THE OLD CODES, over every dial since the restart: a stale drain
    // that reached the radio would carry the getter it captured at launch,
    // which is the session that is gone.
    for (let i = mark; i < dials(); i++) {
      expect(codesOfDial(i)).toEqual(['jade-compass-77']);
    }
  });

  it('the overlap the restart arm settled away: an ordinary op still in flight', async () => {
    // The existing restart arm ('a mesh restart forgets the debt') settles
    // its in-flight op BEFORE calling startMeshSync, so the whole overlap
    // window is outside it. This is that arm's world with the settle moved to
    // the end, which is the interleaving a background bounce actually
    // produces: the radio does not stop because JS did.
    //
    // Mutation (plant 27): the guards deleted. The stale completion runs its
    // ordinary bookkeeping inside the live session and the stale-epoch line
    // never appears.
    await tripServedBreaker();
    await tick(10_000);
    const settleOld = await holdTheWorker(PEER);
    expect(dials()).toBe(4);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    const from = logs.length;
    const mark = dials();
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark); // the dead op still owns the radio

    settleOld(false);
    await flush();
    await flush();

    expect(since(from)).toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-fail`,
    );
    expect(since(from)).not.toContain(`dial-fail ${PEER}`);
    expect(since(from)).not.toContain('served-evidence promote');
    // …and the live session finishes its own work, with its own machinery
    // intact underneath the collision: its own breaker, its own claim, and
    // the class rule putting the promotion behind the ordinary peer already
    // waiting.
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1]);

    await tripServedBreaker();
    const mark2 = dials();
    const settleNew = await servedClaimInFlight(ROUTE_1);
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark2 + 1);
    settleNew(false);
    await flush();
    await flush();
    expect(dialedAddrs().slice(mark2)).toEqual([ROUTE_1, WAITING_2, ROUTE_1]);
  });

  it('a stop with NO start: the old failure re-adds nothing to a dead pod', async () => {
    // running=false is the other half of the same window, and the one where
    // the promotion has nobody to answer to at all: it re-adds a queue entry,
    // a nudge marker and a promoted marker to a pod that has stopped, and the
    // next start inherits them.
    //
    // Mutation (plant 27): the guards deleted. `served-priority` and
    // `served-evidence promote` both appear after the stop.
    await tripServedBreaker();
    await tick(10_000);
    const settleOld = await servedClaimInFlight(ROUTE_1);

    stopMeshSync();
    const from = logs.length;
    settleOld(false);
    await flush();

    expect(since(from)).not.toContain('served-evidence promote');
    expect(since(from)).not.toContain('served-priority');
    expect(since(from)).not.toContain('served-evidence spent');
    expect(since(from)).toContain(
      `drop ${ROUTE_1} reason=stale-epoch phase=dial-fail`,
    );

    // …and the world the NEXT start inherits is the empty one: the only dial
    // is the one that session's own sighting asks for.
    startMeshSync(NEW_CODES);
    const mark = dials();
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1]);
  });

  it('the worker is not inherited: a new start drains under an unresolved old drain', async () => {
    // THE DRAIN-OWNERSHIP FLAG, and both directions of the inheritance a
    // boolean has. Forwards: an old drain still awaiting its native op holds
    // the flag, so the live session cannot start a drain of its own until a
    // dead session's radio op returns. Backwards: that dead drain's `finally`
    // then clears the flag out from under the live drain, which is a second
    // concurrent drain on a native side that rejects them.
    //
    // OWNERSHIP IS NOT THE RADIO, and the arbiter is why the two have to be
    // said separately now. The live session takes the WORKER at once — the
    // proof is that its own queue entry is dialled the instant the dead op
    // settles, with no further sighting to re-enter on — while the RADIO
    // stays with the op that is still out. A boolean loses the first and a
    // missing arbiter loses the second.
    //
    // Mutation (plant 30): the ownership flag restored to a shared boolean —
    // any drain claims it, any drain's finally releases it. The live
    // session's drain never launches (forwards), so when the old drain
    // unwinds there is nothing parked to service WAITING_1 and no further
    // event to re-enter on: zero dials.
    const settleOld = await holdTheWorker(PEER);
    expect(dials()).toBe(1);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    const mark = dials();

    // FORWARDS: the live session's drain launches immediately, with the old
    // drain's promise still unresolved — and parks on the RADIO, which the
    // dead op still holds.
    const from = logs.length;
    const settleNew = armTheRadio();
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark);
    expect(since(from)).toContain('defer reason=radio-busy');

    // The dead op settles: the arbiter hands the radio over, re-enters the
    // drain itself, and the live session's queued work goes out at once, on
    // its own codes, with no new sighting to prompt it.
    settleOld(false);
    await flush();
    await flush();
    expect(dials()).toBe(mark + 1);
    expect(codesOfDial(mark)).toEqual(['jade-compass-77']);

    // BACKWARDS: the old drain's finally hands back only its OWN epoch's
    // ownership, so the live drain still holds the worker and the next
    // sighting waits its turn instead of dialling on top of the op in flight.
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark + 1);

    settleNew(false);
    await flush();
    await flush();
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1, WAITING_2]);
  });

  it('the pipeline refuses a stale session: no second pass, no ingest, no ack', async () => {
    // THE ADDENDUM, and the reason the guard in this file is necessary but
    // not sufficient. The lower layers are NOT pure until return — linkFor's
    // fetchDigest stamps lastSeen/digestSig/offeredSame the instant the first
    // pass lands, and syncLink stamps its want ledger, makes a SECOND radio
    // pass, accepts rows into the store and acks the ledger, all inside the
    // promise meshSync is awaiting. So the epoch predicate is THREADED rather
    // than assumed, and this arm drives the REAL conductor (requireActual) to
    // prove what the threading buys: a session that ended mid-exchange
    // cannot import or ack into the pod that replaced it.
    //
    // Mutation (plant 31): meshSync hands down `() => running` instead of the
    // epoch predicate. It answers TRUE again the moment the new session
    // starts, so a dead session's exchange completes into the live pod's
    // store — and the first assertion below dies before the conductor is
    // even reached.
    const store = jest.requireMock('../src/crews/messages') as Record<
      string,
      jest.Mock
    >;
    const real = jest.requireActual('../src/crews/syncLink');

    // THE MESH'S HALF: the predicate a real dial threaded down answers for
    // the SESSION, not for the flag. A restart flips `running` back to true
    // and this still answers false, which is the whole discrimination.
    await firstDial();
    const live = epochOfDial(0);
    expect(live()).toBe(true);
    stopMeshSync();
    expect(live()).toBe(false);
    startMeshSync(NEW_CODES);
    expect(live()).toBe(false);
    expect(epochOfDial(0)).not.toBe(undefined);

    // THE CONDUCTOR'S HALF, run for real against that kind of predicate.
    const digest = real.encodeDigest([{ id: 'm1', expires_min: 999_999 }]);
    const bundle = real.encodeMessages([]);
    for (const k of [
      'pruneExpired',
      'openWantAttempt',
      'commitWantAttempt',
      'forgiveWantAttempt',
      'rollBackWantAttempt',
      'acceptIncoming',
    ]) {
      store[k].mockClear();
    }

    // (i) the session ends while the FIRST pass is out: no want stamp, no
    // second pass at all.
    let current = true;
    const fetchMessages = jest.fn(async () => bundle);
    const outDigest = await real.syncWithPeer(
      {
        fetchDigest: async () => {
          current = false;
          return digest;
        },
        fetchMessages,
      },
      ['jade-compass-77'],
      100,
      () => current,
    );
    expect(outDigest).toEqual({ accepted: 0, cancelled: true, at: 'digest' });
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(store.openWantAttempt).not.toHaveBeenCalled();
    expect(store.acceptIncoming).not.toHaveBeenCalled();
    expect(store.commitWantAttempt).not.toHaveBeenCalled();

    // (ii) the session ends while the SECOND pass is out: the ingest and the
    // ack are the authoritative writes, and neither happens.
    current = true;
    const outMessages = await real.syncWithPeer(
      {
        fetchDigest: async () => digest,
        fetchMessages: async () => {
          current = false;
          return bundle;
        },
      },
      ['jade-compass-77'],
      100,
      () => current,
    );
    expect(outMessages).toEqual({
      accepted: 0,
      cancelled: true,
      at: 'messages',
    });
    expect(store.openWantAttempt).toHaveBeenCalledTimes(1); // stamped live
    expect(store.acceptIncoming).not.toHaveBeenCalled();
    expect(store.commitWantAttempt).not.toHaveBeenCalled();
    // …AND THE STAMP IS ROLLED BACK — rolled back, not FORGIVEN. The want
    // stamp goes down before the second pass by design, so a cancellation
    // after it OWNS that stamp: left standing it filters exactly these ids
    // out of the next session's want list for the whole retry window
    // (wantsFrom drops a backed-off id), which is a dead pod suppressing
    // valid mail in the pod that replaced it.
    //
    // The verb matters as much as the call. forgiveWants is a COMMUTATION —
    // it re-arms at the two-minute base step and does nothing at all once
    // tries passes FORGIVE_TRIES_CEILING — so a cancelled pass that called
    // it left a clean id two minutes suppressed and a dirty id up to six
    // hours suppressed, for a pass that never happened.
    expect(store.rollBackWantAttempt).toHaveBeenCalledTimes(1);
    expect(store.rollBackWantAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['m1'] }),
    );
    expect(store.forgiveWantAttempt).not.toHaveBeenCalled();

    // (iii) the second pass FAILS on a session that has ended: the throw is
    // swallowed into a cancellation, and the stamp is rolled back on this
    // road too.
    current = true;
    const outFail = await real.syncWithPeer(
      {
        fetchDigest: async () => digest,
        fetchMessages: async () => {
          current = false;
          throw new Error('connect timeout');
        },
      },
      ['jade-compass-77'],
      100,
      () => current,
    );
    expect(outFail).toEqual({
      accepted: 0,
      cancelled: true,
      at: 'transport-error',
    });
    expect(store.rollBackWantAttempt).toHaveBeenCalledTimes(2);
    expect(store.forgiveWantAttempt).not.toHaveBeenCalled();
    expect(store.acceptIncoming).not.toHaveBeenCalled();

    // …and with a LIVE session the same exchange still moves mail, so the
    // guard is a cancellation and not a mute.
    const outLive = await real.syncWithPeer(
      { fetchDigest: async () => digest, fetchMessages: async () => bundle },
      ['jade-compass-77'],
      100,
      () => true,
    );
    expect(outLive).toEqual({ accepted: 1 });
    expect(store.acceptIncoming).toHaveBeenCalledTimes(1);
    expect(store.commitWantAttempt).toHaveBeenCalledTimes(1);
    expect(store.commitWantAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['m1'] }),
      ['m1'],
    );
  });
});

// ---------------------------------------------------------------------------
// (m) THE PROMOTED PREFIX — the second cross-family NO-GO on (k), and the half
// two storms cannot show.
//
// (k)'s class gate makes a promoted head give its turn up to the first
// ORDINARY waiter. It did that ONE HEAD AT A TIME, and a one-head splice
// REVERSES the promoted run it moves through: with a spent class and
// [P1,P2,C] the splices give [P2,C,P1] and then [C,P2,P1], so the promoted
// class serves P2 twice before P1 once. With three storm addresses and an
// ordinary peer that is a D,A,D,A cycle while B waits behind them for good.
//
// Every clause of (k) still holds while it happens: the ordinary class is
// protected, promoted and ordinary turns alternate, no address takes two
// turns running. The starvation is INSIDE the served class — the class the
// cure of (f) exists to serve — and the queue's FIFO occurrence order is
// corrupted by the yield rather than by any placement.
//
// So the rotation is atomic: identify the whole contiguous promoted prefix
// ahead of the first ordinary waiter, and move THAT — in one splice, internal
// order untouched — behind that one waiter. Never repeated one-head splices.
// ---------------------------------------------------------------------------

/** The third storming podmate, so the promoted prefix can be longer than the
 * one entry two storms can build. */
const STORM_D = ROUTE_3;

/**
 * THREE storm addresses, each completing a digest pull inside every op that
 * runs, and one ordinary peer continuously on the air behind them. `supply`
 * caps the pulls so the drain terminates — an uncapped storm is a hang, not a
 * stronger arm.
 */
const threeStormsAndAnOrdinary = async (supply: number) => {
  await tripServedBreaker();
  await tick(10_000);

  const settle = await holdTheWorker(PEER);
  expect(dials()).toBe(4);
  mockSighting!({ peerId: ORDINARY_C, via: 'gatt' });
  await flush();
  expect(dials()).toBe(4);
  const queuedAt = now;

  const doneAt: Array<{ addr: string; at: number }> = [];
  let left = supply;
  (linkSync as jest.Mock).mockImplementation(async () => {
    const target = dialedAddrs()[dialedAddrs().length - 1];
    now += ONE_PASS_MS;
    doneAt.push({ addr: target, at: now });
    if (left > 0) {
      left -= 1;
      mockServed!({ peerId: STORM_A, dialable: true });
      mockServed!({ peerId: STORM_B, dialable: true });
      mockServed!({ peerId: STORM_D, dialable: true });
      mockSighting!({ peerId: ORDINARY_C, via: 'gatt' });
    }
    throw new Error('could not connect');
  });

  // All three claim a front while the ordinary op still holds the radio:
  // three first claims of an epoch, so the queue carries a promoted PREFIX of
  // three ahead of the one ordinary waiter.
  mockServed!({ peerId: STORM_A, dialable: true });
  mockServed!({ peerId: STORM_B, dialable: true });
  mockServed!({ peerId: STORM_D, dialable: true });
  await flush();
  expect(dials()).toBe(4);

  settle(false);
  await flush();
  return { doneAt, queuedAt };
};

describe('(m) the promoted prefix: a storm cannot be starved by the yield itself', () => {
  it('three storms and an ordinary peer: every storm progresses, in order', async () => {
    // THE ARM THE REVIEWER ORDERED. Mutation (plant 32): the one-head splice
    // restored — the 68a6058 yield, verbatim. One storm is then starved
    // outright while the other two cycle, and the promoted run is reversed.
    const { doneAt, queuedAt } = await threeStormsAndAnOrdinary(18);
    const order = doneAt.map(d => d.addr);
    const promoted = dialTurns()
      .slice(4)
      .filter(t => t.promoted)
      .map(t => t.addr);

    // EVERY STORM PROGRESSES — none is queued forever behind the other two.
    for (const storm of [STORM_A, STORM_B, STORM_D]) {
      expect(order.filter(a => a === storm).length).toBeGreaterThanOrEqual(1);
    }
    // …and the ordinary peer is still served on (k)'s clock: it takes every
    // other turn, however many storms are shouting.
    const cAt = doneAt.filter(d => d.addr === ORDINARY_C).map(d => d.at);
    expect(cAt[0] - queuedAt).toBe(2 * ONE_PASS_MS);
    for (let i = 1; i < cAt.length; i++) {
      expect(cAt[i] - cAt[i - 1]).toBe(2 * ONE_PASS_MS);
    }

    // MAX WAIT, per address and in numbers. The promoted turns rotate over
    // the three storms with one ordinary turn between each, so the LAST of
    // them takes its first turn on op 5 — three promoted turns and the two
    // ordinary ones interleaved — and no storm ever waits longer than one
    // full round after that. On the one-head yield the third storm's first
    // turn lands on op 7 instead, which is this bound going red.
    for (const storm of [STORM_A, STORM_B, STORM_D]) {
      const at = doneAt.filter(d => d.addr === storm).map(d => d.at);
      expect(at[0] - queuedAt).toBeLessThanOrEqual(5 * ONE_PASS_MS);
      for (let i = 1; i < at.length; i++) {
        expect(at[i] - at[i - 1]).toBeLessThanOrEqual(6 * ONE_PASS_MS);
        expect(at[i] - at[i - 1]).toBeLessThan(BAR_MS);
      }
    }

    // PROMOTED FIFO STABILITY: the promoted turns are a strict rotation of
    // the three storms in the order the queue held them, repeated. A yield
    // that reversed the prefix cannot produce this, and neither can one that
    // lets a subset cycle — on the one-head splice the promoted turns are
    // D,A,D,B,D, which is the reviewer's D,A,D,A with B arriving late.
    const round = promoted.slice(0, 3);
    expect(new Set(round)).toEqual(new Set([STORM_A, STORM_B, STORM_D]));
    for (let i = 0; i < promoted.length; i++) {
      expect(promoted[i]).toBe(round[i % 3]);
    }

    // …and the rotation moved the WHOLE prefix in ONE operation: each run of
    // adjacent yield lines numbers its entries 1, 2, 3 from the front of the
    // prefix, which is the internal order preserved. Repeated one-head
    // splices number them by the index each head landed at, so the same pair
    // comes out 2 then 1 — the reversal, read straight off the log.
    const yieldRuns: number[][] = [];
    let run: number[] = [];
    for (const line of logs) {
      if (line.includes('served-class-yield')) {
        run.push(Number(/pos=(\d+)/.exec(line)![1]));
      } else if (run.length > 0) {
        yieldRuns.push(run);
        run = [];
      }
    }
    expect(yieldRuns.some(r => r.length >= 2)).toBe(true);
    for (const r of yieldRuns) {
      expect(r).toEqual(r.map((_, i) => i + 1));
      expect(
        logs.filter(l => l.includes('served-class-yield')).length,
      ).toBeGreaterThanOrEqual(r.length);
    }
    for (const line of logs.filter(l => l.includes('served-class-yield'))) {
      expect(line).toContain(`behind=${ORDINARY_C}`);
    }
  });
});

describe('(h) Android: the holds still never engage, and the cure is not platform-shaped', () => {
  it('no hold on either half — and the fresh pull is dialled the same way', async () => {
    // Mutation: key the priority dial on airtimeHeld instead of on the
    // breaker. The rest window is not an iOS mechanism — a Pixel whose
    // podmate rotates its central name strikes out the same way — and a
    // cure that only applies while a walkie is open would be a second,
    // hidden clock.
    mockPlatformOS = 'android';
    await tripServedBreaker();
    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(false);
    expect(mockAdvHold).toEqual([]); // the transmit half stays out too

    await tick(10_000);
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(4);
    expect(dialedAddrs()).toContain(ROUTE_1);
  });
});

describe('(i) a peer with no served history is dialable in both directions', () => {
  it('inbound: a pull from a name never seen before is dialled back at once', async () => {
    // No rest, no hold, no history — the ordinary road, and the bar is not
    // even close. Mutation: gate the served path on prior state of any kind.
    expect(dials()).toBe(0);
    const t0 = now;
    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(1);
    expect(now - t0).toBeLessThan(BAR_MS);
  });

  it('outbound: a first sighting of an unknown name is dialled at once', async () => {
    expect(dials()).toBe(0);
    const t0 = now;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);
    expect(now - t0).toBeLessThan(BAR_MS);
  });

  it('…and with the walkie open that road PARKS, and the release runs it', async () => {
    // THE RULING THIS ARM CARRIES, and it reverses the one it replaces. The
    // hold used to be a clock, so a first meeting slipped past it — an
    // address with no lastSynced stamp is inside no cooldown — and the
    // walkie's scan went on sharing its radio with a two-pass connect. The
    // hold is now a scheduler state: while the human is holding the walkie
    // open, NOTHING ambient dials, first meeting included, and the queue is
    // what carries the meeting across to the release.
    //
    // Mutation: gate the hold in cooldownMs() alone (the shape this
    // replaces) and the first sighting dials straight through it.
    await holdCrewAdvertising();
    const t0 = now;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(0);

    await releaseCrewAdvertising();
    await flush();
    expect(dials()).toBe(1);
    expect(dialedAddrs()).toEqual([PEER]);
    // …and the whole detour still fits inside the delivery bar, because the
    // walkie session is the thing bounding it.
    expect(now - t0).toBeLessThan(BAR_MS);
  });
});

describe('(g) a start that fails hands BOTH holds back', () => {
  afterEach(() => {
    mockStartWalkieThrows = null;
    mockRuntimeStartThrows = null;
    // Cleared before the reset seam runs: that one detaches the very
    // listener this suite can make throw.
    mockOffPeersThrows = false;
    mockCallsPresent = false;
    mockStopWalkieResult = undefined;
    __resetWalkieSessionForTests();
    mockWalkieOn = false;
  });

  it('a rejected startWalkie releases the advertiser hold AND the mesh hold', async () => {
    // THE LIFECYCLE LEAK, found by composition review. By the time
    // startWalkie is awaited this phone has taken both holds; the teardown
    // that returns them is guarded by `!state.session && !walkieOn()`, which
    // is precisely the state a failed start leaves behind — so stopping
    // early-returns and both holds stand for the life of the process. The
    // beacon never comes back on the air, and pod mail never runs the fast
    // clock again. Mutation: delete the try/catch on the start road and this
    // arm dies on both assertions at once.
    mockStartWalkieThrows = new Error('the radio refused the channel');
    await expect(startWalkieSession(POD)).rejects.toThrow(
      'the radio refused the channel',
    );
    expect(meshAirtimeHeld()).toBe(false);
    expect(mockAdvHold).toEqual([true, false]);
  });

  it('the caller still gets the ORIGINAL error, not the cleanup', async () => {
    // Mutation: swallow the rejection after cleaning up ("we recovered").
    // A camper taps the walkie, nothing opens, and no surface can say why —
    // the tap silently succeeded as far as every caller can tell.
    mockStartWalkieThrows = new Error('the radio refused the channel');
    await expect(startWalkieSession(POD)).rejects.toThrow(
      'the radio refused the channel',
    );
    // …and the partial native state was stopped on the way out, so nothing
    // is left half-up behind the released holds.
    expect(mockWalkieCalls).toEqual(['startWalkie', 'stopTalking', 'stopWalkie']);
  });

  it('and the very next start is clean', async () => {
    // Mutation: leave the session's own bookkeeping (listeners, runtime,
    // state) standing after the failure and the retry is refused by the
    // idempotence guard — one bad tap, and the walkie is dead until restart.
    mockStartWalkieThrows = new Error('the radio refused the channel');
    await expect(startWalkieSession(POD)).rejects.toThrow();

    mockStartWalkieThrows = null;
    await startWalkieSession(POD);
    expect(meshAirtimeHeld()).toBe(true);
    expect(mockAdvHold).toEqual([true, false, true]);

    await stopWalkieSession();
    expect(meshAirtimeHeld()).toBe(false);
    expect(mockAdvHold).toEqual([true, false, true, false]);
  });

  it('a cleanup step that THROWS still hands both holds back, and still rethrows', async () => {
    // THE STEPS ARE A LIST OF DEBTS, NOT A CHAIN. This is the only start
    // road that can prove it: the failure has to land AFTER the listeners
    // are up, so there is a cleanup step left to explode. A listener that
    // refuses to detach then takes the mic, the socket and BOTH holds down
    // with it — the same permanent leak (g) exists to close, wearing a
    // different sleeve. Mutation: put the cleanup back on one unguarded
    // sequence and this arm dies on every assertion after the throw.
    mockCallsPresent = true;
    mockOffPeersThrows = true;
    mockRuntimeStartThrows = new Error('the call runtime refused to start');

    await expect(startWalkieSession(POD)).rejects.toThrow(
      'the call runtime refused to start',
    );

    expect(mockAdvHold).toEqual([true, false]);
    expect(meshAirtimeHeld()).toBe(false);
    // …and every step AFTER the throwing one still ran, in order.
    expect(mockWalkieCalls).toEqual([
      'startWalkie',
      'runtime.start',
      'runtime.destroy',
      'stopTalking',
      'stopWalkie',
    ]);
  });

  it('a stopWalkie that answers FALSE keeps the beacon off the air', async () => {
    // THE ONE CONFLICT WHERE THE HOLD IS NOT HANDED BACK, and it is a
    // ruling, not an oversight: strict `false` is the radio saying its own
    // advertiser is still up, and re-advertising the crew beacon into that
    // overlap is what pushes this iPhone's service UUIDs into
    // CoreBluetooth's overflow area — invisible to every Android scan, and
    // never revisited. A held clock is visible and comes back at the next
    // stop; an overflowed advertiser does not. Mutation: release anyway
    // ("never leak a hold") and this arm dies — which is the trade being
    // made deliberately rather than by accident.
    mockStopWalkieResult = false;
    mockStartWalkieThrows = new Error('the radio refused the channel');

    await expect(startWalkieSession(POD)).rejects.toThrow(
      'the radio refused the channel',
    );

    expect(mockWalkieCalls).toEqual(['startWalkie', 'stopTalking', 'stopWalkie']);
    expect(mockAdvHold).toEqual([true]); // asked to hold, never asked to release
  });

  it('a failed start leaves the pod on the FAST clock, not the walkie clock', async () => {
    // The composition assertion, said in the currency this file cares about:
    // a leaked airtime hold is not a failed walkie, it is a phone whose pod
    // mail runs the 60 s clock forever afterwards with no walkie open to
    // explain it.
    mockStartWalkieThrows = new Error('the radio refused the channel');
    await expect(startWalkieSession(POD)).rejects.toThrow();

    await firstDial();
    now += FOREGROUND_CLOCK_MS;
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (n) THE NATIVE-OP ARBITER — the third cross-family NO-GO, and the half the
// session epoch cannot reach.
//
// The epoch stamp makes a dead session's COMPLETION harmless. It says nothing
// about the RADIO. stopMeshSync cannot cancel a native op already in flight,
// and the Android module's stopAll neither clears nor cancels its syncBusy
// latch — so the replacement session was free to dial into that latch, be
// answered 'busy', and pay for it: a cooldown stamped at a dial that never
// reached the air, a fairness turn taken, its own fresh served evidence spent,
// a strike against its breaker. A dead session's leftover radio state charged
// to a live pod.
//
// So ownership of the radio is NOT session-scoped. The arbiter is a ticketed
// slot that outlives resetMeshWorld and outlives the epoch bump, every dial
// chains through it, and a new epoch's drain waits for the outstanding op
// before its first dial. The stale op's own result is consumed locally by the
// stale guard, exactly as the existing contract says.
// ---------------------------------------------------------------------------

const holds = () => logs.filter(l => l.startsWith('[mesh] arbiter hold'));
const releases = () =>
  logs.filter(l => l.startsWith('[mesh] arbiter release'));
/** Tickets are monotonic over the PROCESS, not over an arm — the counter is
 * deliberately not reset by a lifecycle verb (a reset counter could mint a
 * ticket a live slot already holds), so an arm reads them relatively. */
const ticketOf = (line: string) => line.match(/ticket=(\d+)/)![1];

describe('(n) the native-op arbiter: the radio outlives the session', () => {
  it('an epoch bump never clears the arbiter: the replacement session waits', async () => {
    // THE HEADLINE ARBITER ARM. A background bounce lands mid-op; the new
    // session hears a peer immediately and queues it; and NOTHING of that
    // work reaches the radio — or its own bookkeeping — until the dead
    // session's op has settled.
    //
    // Mutation (plant 33): resetMeshWorld clears the arbiter with everything
    // else. The live drain then finds an empty slot, dials into the native
    // syncBusy latch the dead op still holds, and the busy rejection is
    // charged to the live session as a dial, a cooldown and a failure.
    const settleOld = await holdTheWorker(PEER);
    expect(dials()).toBe(1);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    const from = logs.length;
    const mark = dials();

    const ticket = ticketOf(holds()[holds().length - 1]);

    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    // Not dialled, and nothing charged: no dial line, so no cooldown stamp,
    // no fairness turn, no spent claim.
    expect(dials()).toBe(mark);
    // BUSY, DEFERRED, AND NOTHING CHARGED: the live drain names the ticket
    // it is standing off, leaves its queue alone, and returns. Parking on
    // that ticket instead is what turned a busy radio into head-of-line
    // blocking of up to a native timeout.
    expect(since(from)).toContain(`arbiter busy ticket=${ticket}`);
    expect(since(from)).toContain('defer reason=radio-busy');
    expect(since(from)).not.toContain(`dial ${WAITING_1}`);

    // The dead op settles. The radio changes hands and the live session's
    // own queued work goes out at once, on its own codes, with no further
    // event to prompt it.
    settleOld(false);
    await flush();
    await flush();
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1]);
    expect(codesOfDial(mark)).toEqual(['jade-compass-77']);
    expect(since(from)).toContain(`arbiter release ticket=${ticket} ok=0`);
  });

  it('both settlement roads hand the radio back: a throw and a success', async () => {
    // THE TERMINAL CONTRACT, proved on BOTH roads. A settlement proof that
    // only covered fulfilment would leave a thrown op holding the slot for
    // the life of the process — and the radio with it.
    //
    // Mutation (plant 34): the settlement attaches a fulfilment handler
    // only, so a rejected op never releases. The throw road below then wedges
    // the arbiter: the next drain parks on a corpse, refuses the radio rather
    // than dial on top of it, and nothing is ever dialled again.
    const settleThrow = await holdTheWorker(PEER);
    stopMeshSync();
    startMeshSync(NEW_CODES);
    const markThrow = dials();
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(markThrow);
    settleThrow(false); // THE THROW ROAD
    await flush();
    await flush();
    expect(dialedAddrs().slice(markThrow)).toEqual([WAITING_1]);

    // …and the same again with a completion.
    const settleOk = armTheRadio();
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    await flush();
    stopMeshSync();
    startMeshSync(NEW_CODES);
    const markOk = dials();
    mockSighting!({ peerId: WAITING_3, via: 'gatt' });
    await flush();
    expect(dials()).toBe(markOk);
    settleOk(true); // THE SUCCESS ROAD
    await flush();
    await flush();
    expect(dialedAddrs().slice(markOk)).toEqual([WAITING_3]);

    expect(logs.join('\n')).toContain('ok=0');
    expect(logs.join('\n')).toContain('ok=1');
    // The slot was never taken back by force: both settlements released it
    // themselves, well inside the terminal.
    expect(logs.join('\n')).not.toContain('arbiter terminal');
  });

  it('the ticket owns the slot: every op releases the radio it took', async () => {
    // THE TICKET LAW from the side that can be driven: the release belongs to
    // the SETTLEMENT of the op that took the radio, and it happens whether or
    // not anybody is waiting on it. (The other half — a settlement that finds
    // a NEWER ticket in the slot, and a waiter deferring to that ticket
    // rather than nulling it — is unreachable while the arbiter itself
    // serializes every dial, which is exactly what makes it a guard. It is
    // asserted here as an invariant on the log: no `arbiter kept` line ever
    // appears, because no settlement is ever late.)
    //
    // Mutation (plant 35): the clear moves out of the ticketed settlement and
    // into the WAITER. An op that settles with nobody parked on it then
    // leaves a corpse in the slot, the next dial of the very same drain parks
    // on it, and the worker wedges after exactly one dial.
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    await flush();
    mockSighting!({ peerId: WAITING_3, via: 'gatt' });
    await flush();

    expect(dialedAddrs()).toEqual([WAITING_1, WAITING_2, WAITING_3]);
    // NOBODY EVER WAITED. Three sequential dials in one drain, and not one of
    // them found the slot still occupied — because the release belongs to the
    // settlement, which runs before the drain's own continuation. A clear
    // that lived in the WAITER would leave a corpse in the slot after every
    // dial and make the next one park on it.
    expect(logs.join('\n')).not.toContain('arbiter busy');
    expect(holds().length).toBe(3);
    expect(releases().length).toBe(3);
    expect(logs.join('\n')).not.toContain('arbiter kept');
    expect(logs.join('\n')).not.toContain('arbiter terminal');
    // Tickets are monotonic, and each release names the ticket that took the
    // radio — never a neighbour's.
    const first = Number(ticketOf(holds()[0]));
    const run = [`${first}`, `${first + 1}`, `${first + 2}`];
    expect(holds().map(ticketOf)).toEqual(run);
    expect(releases().map(ticketOf)).toEqual(run);
  });
});

// ---------------------------------------------------------------------------
// (o) THE ROUTE GUARD, RUN FOR REAL — the fourth cross-family NO-GO, and the
// vacuity it named.
//
// (l)'s pipeline arm mocked meshSync's syncLink and then, separately, drove an
// ad-hoc conductor with hand-written link objects. Neither half ever ran
// meshSync's OWN linkFor: measured on ac124d8, deleting linkFor's post-pass
// isCurrent guard left all 54 active arms green. A guard no arm can kill is
// not a guard.
//
// So these arms run the REAL route end to end — meshSync's drain -> its own
// linkFor -> the REAL syncLink conductor (jest.requireActual) — and mock only
// the transport boundary: the base64 seam and the native syncWithPeer call.
// The session is stopped and restarted WHILE a pass is on the radio, and each
// arm asserts the refusal at one checkpoint, with a mutation that kills it.
//
// THE CHECKPOINTS, in the order the exchange reaches them:
//   C0  conductor ENTRY          — an exchange that begins stale never dials
//   C1  linkFor post-pass 1      — no lastSeen/digestSig/offeredSame stamp
//   C2  conductor post-digest    — no want stamp, no second pass
//   C3  conductor transport-error— no live forgiveness; the stamp rolled back
//   C4  conductor pre-ingest     — no acceptIncoming, no ledger commit
// ---------------------------------------------------------------------------

/** The store spies the conductor writes through. */
const ledger = () =>
  jest.requireMock('../src/crews/messages') as Record<string, jest.Mock>;

/**
 * Point meshSync's drain at the REAL conductor and hand back the frames the
 * transport will answer with. Everything above the base64 seam is production
 * code from here down.
 */
const realRoute = () => {
  const real = jest.requireActual('../src/crews/syncLink');
  const digest = real.encodeDigest([{ id: 'm1', expires_min: 999_999 }]);
  const bundle = real.encodeMessages([]);
  mockB64ToBytes = (s: string) =>
    s === 'DIGEST' ? digest : s === 'BUNDLE' ? bundle : new Uint8Array();
  mockBytesToB64 = () => 'WANT';
  (linkSync as jest.Mock).mockImplementation(
    (
      link: unknown,
      codes: string[],
      nowMin: number,
      isCurrent: () => boolean,
    ) => real.syncWithPeer(link, codes, nowMin, isCurrent),
  );
  const passes: string[] = [];
  nativeSync.mockImplementation(async (peerId: string, payload: string) => {
    passes.push(payload === '' ? `digest:${peerId}` : `messages:${peerId}`);
    return payload === '' ? { digest: 'DIGEST' } : { messages: 'BUNDLE' };
  });
  for (const k of [
    'pruneExpired',
    'openWantAttempt',
    'commitWantAttempt',
    'forgiveWantAttempt',
    'rollBackWantAttempt',
    'acceptIncoming',
  ]) {
    ledger()[k].mockClear();
  }
  return { real, passes };
};

/** A native pass that parks on the radio until the arm lets it finish. */
const parkedPass = (
  passes: string[],
  answer: () => { digest?: string; messages?: string },
  fail?: Error,
) => {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  nativeSync.mockImplementationOnce(async (peerId: string, payload: string) => {
    passes.push(payload === '' ? `digest:${peerId}` : `messages:${peerId}`);
    await gate;
    if (fail) {
      throw fail;
    }
    return answer();
  });
  const open = () => {
    release();
  };
  parked.push(open);
  return open;
};

describe('(o) the real route: meshSync -> linkFor -> the real conductor', () => {
  it('C0 the conductor ENTRY refuses: an exchange that begins stale never dials', async () => {
    // The one checkpoint the drain cannot reach on its own — nothing awaits
    // between the dial log and the conductor's first line — so it is driven
    // directly, against the same kind of predicate a real dial threads down.
    //
    // Mutation (plant 39): the entry check deleted. The exchange then goes to
    // the radio for a session that has already ended.
    const { real } = realRoute();
    const fetchDigest = jest.fn(async () => new Uint8Array());
    const fetchMessages = jest.fn(async () => new Uint8Array());
    const out = await real.syncWithPeer(
      { fetchDigest, fetchMessages },
      ['jade-compass-77'],
      100,
      () => false,
    );
    expect(out).toEqual({ accepted: 0, cancelled: true, at: 'digest' });
    expect(fetchDigest).not.toHaveBeenCalled();
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(ledger().openWantAttempt).not.toHaveBeenCalled();
  });

  it('C1/C2 the session ends on pass 1: nothing stamped, no second pass', async () => {
    // THE ARM linkFor's OWN GUARD DIES ON. The first pass lands into a
    // session that has been stopped and restarted, and linkFor's stamps —
    // lastSeen, the digest signature, the idle-clock scratch — would go into
    // the LIVE session's address book: a name the live pod never heard,
    // stamped as heard just now. The conductor then refuses before the want
    // ledger and before the second radio pass.
    //
    // Mutation (plant 38): linkFor's post-pass isCurrent guard deleted. The
    // live session's address book gains PEER, and the human's own check then
    // reports a podmate in range that this pod has never met.
    // Mutation (plant 40): the conductor's post-digest checkpoint deleted.
    // The want ledger is stamped and a SECOND radio pass goes out for a pod
    // that no longer exists.
    const { passes } = realRoute();
    const finishPass1 = parkedPass(passes, () => ({ digest: 'DIGEST' }));

    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(passes).toEqual([`digest:${PEER}`]); // pass 1 is on the radio

    stopMeshSync();
    startMeshSync(NEW_CODES);
    finishPass1();
    await flush();
    await flush();

    // C2: no want stamp, no second pass, no ingest.
    expect(passes).toEqual([`digest:${PEER}`]);
    expect(ledger().openWantAttempt).not.toHaveBeenCalled();
    expect(ledger().acceptIncoming).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-ok`,
    );

    // C1: and the live session's address book never learned the name.
    const r = await checkPodUpdates();
    expect(r.inRange).toBe(0);
  });

  it('C3 the session ends on a FAILING pass 2: no live forgiveness, and the stamp rolls back', async () => {
    // The want stamp goes down BEFORE the second pass by design (a peer that
    // walks away mid-transfer must still count as a try). A cancellation
    // after it therefore OWNS that stamp: left standing, wantsFrom filters
    // exactly these ids out of the NEXT session's want list for the whole
    // retry window — a dead pod suppressing valid mail in the pod that
    // replaced it. So the attempt is tokened and rolled back.
    //
    // Mutation (plant 41): the transport-error checkpoint deleted. The dead
    // session's failure then commutes the ledger as a LIVE one and re-throws,
    // so the drain logs the failure phase instead of the completion phase.
    // Mutation (plant 36): the rollback deleted. The stamp stands, and the
    // next session's want list is short exactly these ids.
    const { passes } = realRoute();
    // Pass 1 answers normally; the PARKED implementation is registered second
    // so the once-queue hands it to the second call.
    nativeSync.mockImplementationOnce(async (peerId: string) => {
      passes.push(`digest:${peerId}`);
      return { digest: 'DIGEST' };
    });
    const finishPass2 = parkedPass(
      passes,
      () => ({ messages: 'BUNDLE' }),
      new Error('connect timeout'),
    );

    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(passes).toEqual([`digest:${PEER}`, `messages:${PEER}`]);
    expect(ledger().openWantAttempt).toHaveBeenCalledTimes(1);
    expect(ledger().openWantAttempt).toHaveBeenLastCalledWith(
      ['m1'],
      expect.any(Number),
    );

    stopMeshSync();
    startMeshSync(NEW_CODES);
    finishPass2();
    await flush();
    await flush();

    // THE ROLLBACK, scoped to this attempt's own preimage — and it is the
    // ROLLBACK verb, never the forgiveness one: a cancelled pass answered
    // for nothing, so it owes the ids the row they had, not a commuted
    // sentence with a two-minute floor and a six-hour hole.
    expect(ledger().rollBackWantAttempt).toHaveBeenCalledTimes(1);
    expect(ledger().rollBackWantAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['m1'] }),
    );
    expect(ledger().forgiveWantAttempt).not.toHaveBeenCalled();
    expect(ledger().acceptIncoming).not.toHaveBeenCalled();
    expect(ledger().commitWantAttempt).not.toHaveBeenCalled();
    // A CANCELLATION, not a throw: the drain sees a cancelled outcome, so the
    // completion phase is what it logs.
    expect(logs.join('\n')).toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-ok`,
    );
    expect(logs.join('\n')).not.toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-fail`,
    );
  });

  it('C4 the session ends on a LANDING pass 2: no ingest, no ack, and the stamp rolls back', async () => {
    // The authoritative writes: acceptIncoming puts a peer's rows into THIS
    // phone's store under the crew codes it was handed, and clearWants acks
    // the ledger. A dead session doing either is a pod that no longer exists
    // importing mail into the pod that replaced it.
    //
    // Mutation (plant 42): the pre-ingest checkpoint deleted. The dead
    // session's rows land in the live pod's store and its ledger is acked.
    // Mutation (plant 36): the rollback deleted — same suppression as C3.
    const { passes } = realRoute();
    nativeSync.mockImplementationOnce(async (peerId: string) => {
      passes.push(`digest:${peerId}`);
      return { digest: 'DIGEST' };
    });
    const finishPass2 = parkedPass(passes, () => ({ messages: 'BUNDLE' }));

    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(passes).toEqual([`digest:${PEER}`, `messages:${PEER}`]);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    finishPass2();
    await flush();
    await flush();

    expect(ledger().acceptIncoming).not.toHaveBeenCalled();
    expect(ledger().commitWantAttempt).not.toHaveBeenCalled();
    expect(ledger().rollBackWantAttempt).toHaveBeenCalledTimes(1);
    expect(ledger().rollBackWantAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['m1'] }),
    );
    expect(logs.join('\n')).toContain(
      `drop ${PEER} reason=stale-epoch phase=dial-ok`,
    );
    expect(lastPodSyncMs()).toBe(null);
  });

  it('…and a LIVE session on the same real route still moves mail', async () => {
    // The guard is a cancellation, not a mute: the identical route, run
    // without a lifecycle event, makes both passes, stamps, ingests and acks.
    // Without this every mutation above could be "passed" by breaking the
    // route outright.
    const { passes } = realRoute();
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    await flush();

    expect(passes).toEqual([`digest:${PEER}`, `messages:${PEER}`]);
    expect(ledger().openWantAttempt).toHaveBeenCalledTimes(1);
    expect(ledger().acceptIncoming).toHaveBeenCalledTimes(1);
    expect(ledger().commitWantAttempt).toHaveBeenCalledTimes(1);
    expect(ledger().rollBackWantAttempt).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(`dial-ok ${PEER} accepted=1`);
    expect(lastPodSyncMs()).not.toBe(null);
  });
});

// ---------------------------------------------------------------------------
// (p) THE MANUAL CHECK ACROSS A LIFECYCLE EVENT — the fifth cross-family
// NO-GO.
//
// checkPodUpdates captured `accBefore` and no epoch, awaited the drain, and
// then unconditionally notified the surfaces and reported
// `acceptedTotal - accBefore`. Both readings are SESSION-scoped:
// resetMeshWorld zeroes acceptedTotal, so a stop/start across the await makes
// the subtraction negative (or a count of another pod's mail), and `inRange`
// is a tally of an address book that has since been thrown away. The surface
// write is the third: a pod card re-rendered off a session it is not showing.
//
// So the epoch is captured beside the counter, and a superseded check returns
// a STRUCTURED cancelled result having notified nothing, subtracted nothing
// and reported nothing. The caller reads it as silently-superseded.
// ---------------------------------------------------------------------------

describe('(p) the manual check: a superseded "Look again" answers cancelled', () => {
  it('a pod replaced mid-check reports cancelled, not a negative count', async () => {
    // Mutation (plant 37): the epoch capture and the post-await check
    // deleted. The camper's tap then answers "Nobody in range" for a pod that
    // has one podmate on the air, having moved the pod card underneath the
    // human and computed `0 - 5 = -5` messages moved.
    // GATT-sighted, so the freshness gate — which judges an ADVERTISER's
    // silence — cannot condemn the name over the 30 s the check waits.
    const settleFirst = armTheRadio(5);
    mockSighting!({ peerId: PEER, via: 'gatt' });
    await flush();
    settleFirst(true);
    await flush();
    // Five messages landed in THIS session, so the check's baseline is five.
    expect(lastPodSyncMs()).not.toBe(null);

    await tick(30_000);
    const settleCheck = armTheRadio(0);
    const checking = checkPodUpdates();
    await flush();
    expect(dials()).toBe(2); // the check's own dial is on the radio

    // The app backgrounds and comes straight back underneath the gesture.
    stopMeshSync();
    startMeshSync(NEW_CODES);
    const rev = meshRevision();
    const from = logs.length;

    settleCheck(true);
    await flush();
    await flush();
    const r = await checking;

    // THE STRUCTURED SHAPE, and every field of it: no count, no tally, and
    // the flag that says why.
    expect(r).toEqual({ inRange: 0, moved: 0, cancelled: true });
    // NO SURFACE WRITE: the pod card is not re-rendered off a session it is
    // not showing.
    expect(meshRevision()).toBe(rev);
    expect(since(from)).toContain('check cancelled');
  });

  it('a check whose session survives still reports the honest numbers', async () => {
    // The other side of the same gate — without this the cancellation could
    // be "passed" by making every check answer cancelled.
    const settleFirst = armTheRadio(2);
    mockSighting!({ peerId: PEER, via: 'gatt' });
    await flush();
    settleFirst(true);
    await flush();

    await tick(30_000);
    const settleCheck = armTheRadio(3);
    const checking = checkPodUpdates();
    await flush();
    const rev = meshRevision();
    settleCheck(true);
    await flush();
    const r = await checking;

    expect(r.cancelled).toBe(undefined);
    expect(r.inRange).toBe(1);
    expect(r.moved).toBe(3);
    // …and this one DOES move the surface, which is what makes the
    // cancelled arm's "unchanged" mean something.
    expect(meshRevision()).toBeGreaterThan(rev);
  });
});

// ---------------------------------------------------------------------------
// (q) THE HOLD IS A SCHEDULER STATE — the architecture round's M1, and the
// reversal of what (a) used to be able to claim.
//
// The hold shipped as a CLOCK and a nudge-suppressor: cooldownMs() returned
// the frugal number and nudgeSync() returned early. Neither touches the
// worker, so with the walkie open this phone still dialled — the ambient
// queue drained, a first meeting went out immediately (no cooldown to slow),
// and every served pull took the front of the queue and dialled at once.
// Each of those is a two-pass connect-and-read under a 60 s native timeout,
// on the ONE radio whose scan is the iPhone's only road to finding the
// Android beside it. A trade that leaves the expensive half running is not a
// trade.
//
// So while the hold stands: the operation already in flight finishes, and
// then NOTHING ambient, queued or sighted goes to the radio. Evidence keeps
// being recorded — the address book, the heartbeat, the served claims — so
// the release has a real queue rather than a reconstruction. The manual
// check is the sole explicit borrow, and it borrows only its own routes.
// ---------------------------------------------------------------------------

describe('(q) held: the worker parks, and only the human may borrow it', () => {
  it('one op in flight + three ambient sightings: zero further dials', async () => {
    // THE REQUIRED ARM, verbatim. Mutation: put the hold back in
    // cooldownMs() alone and all three sightings dial straight through it.
    const settle = await holdTheWorker(PEER);
    expect(dials()).toBe(1); // the op already on the radio

    await holdCrewAdvertising();
    expect(meshAirtimeHeld()).toBe(true);

    // The op in flight is allowed to finish — the hold is "after the current
    // op", not a kill.
    settle(true);
    await flush();
    expect(dials()).toBe(1);

    // Three ordinary peers appear, well past every clock.
    for (const addr of [WAITING_1, WAITING_2, WAITING_3]) {
      await tick(120_000);
      mockSighting!({ peerId: addr, via: 'gatt' });
      await flush();
    }
    expect(dials()).toBe(1);
    expect(logs.join('\n')).toContain('park reason=walkie-airtime');

    // …AND THE EVIDENCE IS ALL THERE. The release dials every one of them,
    // in the order they were heard, with no further radio event.
    await releaseCrewAdvertising();
    await flush();
    await flush();
    await flush();
    expect(dialedAddrs().slice(1)).toEqual([WAITING_1, WAITING_2, WAITING_3]);
  });

  it('a served pull under the hold records its claim and dials nothing', async () => {
    // The served-priority path is the one that reaches the queue without
    // going through nudgeSync at all, so the old hold never touched it: a
    // podmate pulling from us dialled back immediately, mid-walkie.
    // Mutation: let queueServedPriority call the drain directly again.
    await tripServedBreaker();
    await holdCrewAdvertising();
    await tick(10_000);
    const mark = dials();

    mockServed!({ peerId: ROUTE_1, dialable: true });
    await flush();
    expect(dials()).toBe(mark);
    // The CLAIM still happened: the evidence model is untouched by the hold,
    // which is what makes the release immediate instead of another round of
    // waiting for proof.
    expect(logs.join('\n')).toContain(`served-evidence dial ${ROUTE_1} gen=1`);
    expect(logs.join('\n')).toContain('served-priority ' + ROUTE_1);

    await releaseCrewAdvertising();
    await flush();
    expect(dials()).toBe(mark + 1);
    expect(dialedAddrs()[mark]).toBe(ROUTE_1);
  });

  it('the manual check borrows the radio, and borrows only its own routes', async () => {
    // THE SOLE EXPLICIT BORROW. The human tapped, so the human's routes go
    // out — and nothing else does, because the walkie is still open.
    // Mutation: drop the `borrow` argument and the check drains the whole
    // queue, spending the walkie's airtime on peers nobody asked about.
    mockSighting!({ peerId: PEER, via: 'gatt' });
    await flush();
    expect(dials()).toBe(1);

    await holdCrewAdvertising();
    await tick(120_000);
    // An ambient peer arrives during the walkie and parks.
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(1);

    // …and now the camper taps Check. The batch it freezes is every address
    // the freshness gate believes in AT THE TAP — both of these — and the
    // borrow dials exactly those, including the one the hold had parked.
    const r = await checkPodUpdates();
    expect(r.cancelled).toBe(undefined);
    expect(r.inRange).toBe(2);
    expect(dials()).toBe(3);
    expect(dialedAddrs().slice(1).sort()).toEqual([PEER, WAITING_1].sort());

    // The hold is still on, and the moment the check is done the worker
    // parks again: a peer arriving after it dials nothing.
    await tick(120_000);
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    await flush();
    expect(dials()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (r) THE NATIVE CANCEL — M2's teardown half.
//
// The epoch made a dead session's COMPLETION harmless and left the RADIO to
// it: stopMeshSync could not cancel an operation in flight and the Android
// module's stopAll neither cleared nor cancelled its latch. So the pod that
// replaced the dead one waited out a 60-second native timeout before it
// could dial at all — and the first arbiter's answer to that (park the new
// drain on the old op) was head-of-line blocking wearing a guard's name.
//
// Production teardown now ENDS THE NATIVE SESSION: the exact in-flight
// SyncClient is cancelled at the source, its own terminal settles the bridge
// promise, and the live session dials immediately — with nothing charged to
// it for the dead session's leftover.
// ---------------------------------------------------------------------------

describe('(r) the native cancel: a stop reaches the radio', () => {
  it('a restart over an in-flight op ends the native session and dials at once', async () => {
    // Mutation: delete the endSession call from stopMeshSync. The op runs to
    // its own timeout, the live session defers on every sighting, and the
    // first dial of the new pod waits out a minute of somebody else's radio.
    const settleOld = await holdTheWorker(PEER);
    expect(dials()).toBe(1);
    // The modelled native teardown: cancelling the op settles its promise by
    // the failure road, exactly as the SyncClient's terminal does.
    mockOnEndSession = () => settleOld(false);

    stopMeshSync();
    expect(mockEndSessions).toBe(1);
    startMeshSync(NEW_CODES);
    const mark = dials();

    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    await flush();

    // NO WAIT AND NOTHING CHARGED: the radio was handed back by the cancel,
    // so the live session's first sighting dials on its own codes.
    expect(dials()).toBe(mark + 1);
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1]);
    expect(codesOfDial(mark)).toEqual(['jade-compass-77']);
    expect(logs.join('\n')).toContain('native end reason=stop sent=1');
  });

  it('a native side that cannot cancel still cannot wedge the radio forever', async () => {
    // THE TERMINAL. A module without the verb (or one whose promise never
    // settles) leaves the slot held — and the old arbiter had no answer at
    // all for that: it parked, and stayed parked, for the life of the
    // process. The slot now has a deadline, read at the one moment it
    // matters: the next drain that wants the radio.
    //
    // Mutation: delete the terminal branch from radioBusy and this arm hangs
    // on a corpse forever.
    const settleStuck = await holdTheWorker(PEER); // never settled, yet
    stopMeshSync();
    startMeshSync(NEW_CODES);
    const mark = dials();

    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark); // busy: deferred, nothing charged

    // Past the terminal, the next attempt takes the radio back — and tells
    // the hardware before it stops believing in it.
    await tick(120_000);
    const settleNew = armTheRadio();
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    await flush();
    expect(logs.join('\n')).toContain('arbiter terminal');
    expect(logs.join('\n')).toContain('native end reason=op-terminal');
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1]);

    // AND NOW THE LATE SETTLEMENT — the one road that can produce one, and
    // the reason the release is scoped to a TICKET rather than "clear the
    // slot". The evicted op finally settles while a NEWER op holds the
    // radio: its release owns nothing, says so, and leaves the live op's
    // claim standing. A release that just nulled the slot would hand the
    // radio to a second caller on top of a live connection.
    const stuck = ticketOf(holds()[holds().length - 2]);
    const live = ticketOf(holds()[holds().length - 1]);
    const from = logs.length;
    settleStuck(false);
    await flush();
    // It says whose slot it is NOT, and it names the op that has it — the
    // live ticket, still holding the radio it took.
    expect(since(from)).toContain(`arbiter kept ticket=${stuck} owner=${live}`);
    expect(since(from)).not.toContain(`arbiter release ticket=${live}`);
    settleNew(true);
    await flush();
    expect(logs.join('\n')).toContain(`arbiter release ticket=${live} ok=1`);
  });
});

// ---------------------------------------------------------------------------
// (s) THE SERVED OFFER'S SCOPE — M5, and the lie an unset digest told.
//
// frameFor() answers an empty buffer as a COMPLETE one-frame stream with an
// empty body, which a central reads as the finished sentence "this phone
// carries nothing". So every window between the GATT server opening and this
// session's first publish landing was a window in which a podmate asked and
// was confidently told there was no mail. The window is not theoretical: the
// server opens with the advertiser, the publish crosses the bridge, and a
// background bounce re-opens the server before the new session's first push
// has resolved.
//
// So an offer carries WHOSE it is (the mesh epoch) and WHICH one it is (that
// session's revision), the ACK is what makes it installed, and a publish
// that is not strictly newer is refused rather than installed over the live
// one. The JS half is pinned here; the native half — the not-ready frame,
// the (epoch, rev) floor, the clear on endSession — is CrewBeaconModule's.
// ---------------------------------------------------------------------------

/**
 * A want frame a peer actually wrote: the base64 seam is mocked, so this is
 * where the JSON array of ids comes from. Set before every mockWant below —
 * an undecodable want is served nothing on ANY branch, which would make the
 * scope arms pass for the wrong reason.
 */
const aWant = () => {
  const json = '["m1"]';
  mockB64ToBytes = () =>
    Uint8Array.from(Array.from(json).map(c => c.charCodeAt(0)));
};

describe('(s) the digest is published with its session, and acked before it counts', () => {
  it('start publishes the new session epoch, and a store change republishes', async () => {
    // Mutation: publish without the epoch (the bare setSyncDigest shape) and
    // native has nothing to refuse a dead session's late offer with.
    expect(mockPublishes.length).toBe(1);
    const first = mockPublishes[0];
    expect(first.rev).toBe(1);

    // MEMBERSHIP MOVES THE OFFER. pod-member records ride the same store, so
    // a roster change is a store change is a republish — at a HIGHER
    // revision, which is what lets native order two publishes that cross the
    // bridge together.
    mockMessagesChanged!();
    await flush();
    expect(mockPublishes.length).toBe(2);
    expect(mockPublishes[1]).toEqual({ epoch: first.epoch, rev: 2 });

    // …and a NEW session is a new epoch, whose first revision starts over.
    stopMeshSync();
    startMeshSync(NEW_CODES);
    await flush();
    const third = mockPublishes[2];
    expect(third.epoch).toBeGreaterThan(first.epoch);
    expect(third.rev).toBe(1);
  });

  it('a publish whose session ended is never installed, and says so', async () => {
    // THE STALE PUBLISH PAST A RESTART. A push in flight across a stop/start
    // belongs to a pod that no longer exists; installed, it becomes this
    // phone's offer to everyone until the next store change happens along.
    //
    // Mutation: drop the post-ACK epoch check and the dead session's offer
    // is recorded as installed — after which this session answers wants
    // against a digest it never published.
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    nativePublish.mockImplementationOnce(async () => {
      await gate;
    });
    mockMessagesChanged!();
    await flush();

    const from = logs.length;
    stopMeshSync();
    startMeshSync(NEW_CODES);
    release();
    await flush();
    await flush();
    expect(since(from)).toContain('digest stale-ack');
  });

  it('nothing is served until this session has an installed offer', async () => {
    // THE INSTALL GATE, from the JS side: a want that arrives before this
    // session's own publish has been acked was built against somebody
    // else's digest — a dead session's, or none at all — and answering it
    // serves rows nobody was offered.
    //
    // Mutation: drop the digestInstalled check in the want handler.
    stopMeshSync();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    nativePublish.mockImplementationOnce(async () => {
      await gate;
    });
    startMeshSync(CODES);
    const from = logs.length;

    aWant();
    mockWant!(wantBody(PEER));
    expect(nativeProvide).not.toHaveBeenCalled();
    expect(since(from)).toContain('want-drop');
    expect(since(from)).toContain('reason=digest-not-installed');

    release();
    await flush();
    aWant();
    mockWant!(wantBody(PEER));
    expect(nativeProvide).toHaveBeenCalledTimes(1);
  });

  it('a module without the scoped verb still publishes, the old way', async () => {
    // THE DEGRADE, and it is load-bearing: the scoped publish is newer than
    // the iOS module, and a teardown-time throw on a phone that does not
    // know the verb would be a worse bug than the one being fixed.
    //
    // Mutation: call native.publishSyncDigest unconditionally.
    const crew = (
      jest.requireMock('react-native') as {
        NativeModules: { CrewBeacon: Record<string, unknown> };
      }
    ).NativeModules.CrewBeacon;
    const scoped = crew.publishSyncDigest;
    delete crew.publishSyncDigest;
    try {
      stopMeshSync();
      startMeshSync(CODES);
      await flush();
      expect(nativeSetDigest).toHaveBeenCalled();
      expect(logs.join('\n')).toContain('scoped=0');
      // …and the serving side is still armed, because the ACK still came.
      aWant();
    mockWant!(wantBody(PEER));
      expect(nativeProvide).toHaveBeenCalledTimes(1);
    } finally {
      crew.publishSyncDigest = scoped;
    }
  });

  it('a stopped session serves nothing at all', async () => {
    // THE STOP CLEAR, JS half. Mutation: leave digestInstalled standing
    // across resetMeshWorld and a stopped pod keeps answering wants — with
    // the crew codes of a session that has ended.
    await flush();
    aWant();
    // Held across the stop on purpose: the unsubscribe is the first guard
    // and the handler's own `running` check is the second. Calling the
    // captured handler after the stop is what proves the second one exists —
    // a mutation that drops it would otherwise be invisible behind the
    // teardown that usually hides it.
    const serve = mockWant!;
    serve(wantBody(PEER));
    expect(nativeProvide).toHaveBeenCalledTimes(1);

    stopMeshSync();
    expect(mockWant).toBe(undefined); // the listener is detached…
    serve(wantBody(PEER)); // …and the handler still refuses
    expect(nativeProvide).toHaveBeenCalledTimes(1);
  });

  it('a want is answered under the codes the session is serving NOW', async () => {
    // M6's crew scope, at the seam where it is decided. A want list is an
    // unauthenticated write: without the scope, "which ids may I ask for" is
    // answered by the id space alone — every row this phone carries, for
    // every pod it is in, to whoever holds a connection.
    //
    // Mutation: drop the third argument at the call site (or the filter in
    // messagesByIds) and serveMessages answers from the whole store.
    await flush();
    aWant();
    mockWant!(wantBody(PEER));
    expect(serveSpy).toHaveBeenCalledTimes(1);
    expect(serveSpy).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.any(Number),
      ['amber-lantern-31'],
    );

    // …and after a pod switch it is the NEW codes, not the ones the offer
    // that started this was built from.
    stopMeshSync();
    startMeshSync(NEW_CODES);
    await flush();
    aWant();
    mockWant!(wantBody(PEER));
    expect(serveSpy).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.any(Number),
      ['jade-compass-77'],
    );
  });
});

// ---------------------------------------------------------------------------
// (u) THE WANT LEDGER'S ATTEMPT — M3, and the difference between an UNDO and
// a second policy wearing the word.
//
// The stamp goes down before the second pass by design (a peer that walks
// away mid-transfer must still count as a try), so a cancelled pass owns a
// stamp nobody will ever answer for. The first cure called forgiveWants, and
// forgiveWants is a COMMUTATION: it re-arms at the two-minute base step —
// never at whatever the row had before — and does nothing AT ALL once tries
// passes FORGIVE_TRIES_CEILING. So a cancelled pass left a clean id two
// minutes suppressed and an id with history up to six hours suppressed, for
// a pass that never happened.
//
// A rollback is the row that was there. It is written under one transaction
// with the stamp's preimage, and it is applied only where the row is still
// byte-identical to what this attempt wrote — because a LATER attempt that
// re-stamped the same id owns that debt now.
//
// Driven against a real in-memory SQLite (the wantLedger idiom), because
// every claim here is SQL: a transaction, a compare-and-set, and a table
// that must be empty after a failure.
// ---------------------------------------------------------------------------

const { DatabaseSync: LedgerDb } = require('node:sqlite');

/**
 * A phone's store, with one hook: `breakAfter` makes the Nth LEDGER write
 * throw, so the partial-failure arm can be driven rather than argued.
 *
 * Armed AFTER the schema is applied, and counting only crew_sync_wants
 * writes, because the schema itself carries an INSERT: counting every write
 * from construction made the hook fire on the FIRST ledger stamp, which is a
 * case where nothing partial exists and the arm passed whatever the code
 * did. (Found by planting it: the mutation left the arm green.)
 */
const makeLedgerPhone = () => {
  const db = new LedgerDb(':memory:');
  let writes = 0;
  const conn = {
    breakAfter: null as number | null,
    execute(sql: string, params: unknown[] = []) {
      if (
        conn.breakAfter !== null &&
        /^\s*insert into crew_sync_wants/i.test(sql.trim()) &&
        ++writes === conn.breakAfter
      ) {
        throw new Error('disk I/O error');
      }
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  };
  const { BASE_TABLES_SQL } = jest.requireActual('../src/events/schema');
  for (const sql of BASE_TABLES_SQL as string[]) {
    conn.execute(sql);
  }
  return conn;
};

type LedgerRow = { id: string; asked_min: number; tries: number; retry_min: number };
const ledgerRow = (id: string): LedgerRow | undefined => {
  const res = (mockDbConn as ReturnType<typeof makeLedgerPhone>).execute(
    'SELECT id, asked_min, tries, retry_min FROM crew_sync_wants WHERE id = ?',
    [id],
  );
  return (res.rows?._array as LedgerRow[])[0];
};

const realLedger = () =>
  jest.requireActual('../src/crews/messages') as {
    openWantAttempt: (ids: string[], nowMin: number) => { ids: string[] };
    commitWantAttempt: (a: unknown, landed: string[]) => void;
    forgiveWantAttempt: (a: unknown, nowMin: number) => void;
    rollBackWantAttempt: (a: unknown) => number;
    recordWants: (ids: string[], nowMin: number) => void;
    wantsFrom: (
      digest: Array<{ id: string; expires_min: number }>,
      nowMin: number,
    ) => string[];
  };

describe('(u) the want attempt: an exact preimage, and a CAS that respects a newer row', () => {
  const T = 1_000_000;

  afterEach(() => {
    mockDbConn = {};
  });

  it('rollback restores the exact prior row — not a commuted sentence', async () => {
    // THE REQUIRED ARM. An id with real refusal history (tries past the
    // forgiveness ceiling) is stamped by a pass that is then cancelled.
    //
    // Mutation: call forgiveWants instead of rollBackWantAttempt. Above the
    // ceiling forgiveWants does NOTHING, so the row keeps the stamp of a
    // pass that never happened — hours of suppression the id never earned.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();

    // Five honest strikes: this id has a history, and a back-off it earned.
    for (let i = 0; i < 5; i++) {
      led.recordWants(['poison-1'], T + i);
    }
    const before = ledgerRow('poison-1')!;
    expect(before.tries).toBe(4);

    const attempt = led.openWantAttempt(['poison-1'], T + 100);
    const stamped = ledgerRow('poison-1')!;
    expect(stamped.tries).toBe(5); // the stamp this pass wrote
    expect(stamped.asked_min).toBe(T + 100);

    expect(led.rollBackWantAttempt(attempt)).toBe(1);
    expect(ledgerRow('poison-1')).toEqual(before);
  });

  it('a first-ever want rolls back to NO ROW, not to a two-minute floor', async () => {
    // The other end of the same rule. forgiveWants on a fresh id leaves a
    // row backed off to now+2min; the id had no debt at all before this
    // pass, and a cancelled pass earns it none.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();
    expect(ledgerRow('m1')).toBe(undefined);

    const attempt = led.openWantAttempt(['m1'], T);
    expect(ledgerRow('m1')).not.toBe(undefined);
    expect(led.rollBackWantAttempt(attempt)).toBe(1);
    expect(ledgerRow('m1')).toBe(undefined);

    // …and the proof it MEANS something: the id is offerable again at once.
    expect(led.wantsFrom([{ id: 'm1', expires_min: T + 10_000 }], T)).toEqual([
      'm1',
    ]);
  });

  it('a NEWER row wins the CAS: a stale rollback undoes nothing', async () => {
    // THE REQUIRED ARM. Two passes stamp the same id — the first one's
    // session dies, the second is live — and the dead one's rollback must
    // not erase the live pass's debt.
    //
    // Mutation: drop the WHERE clause (restore unconditionally) and the
    // live pass's stamp is wiped by a dead session, so an id it is waiting
    // on is re-offered every sighting: the starvation the ledger exists to
    // stop, reintroduced through the cure.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();

    const first = led.openWantAttempt(['m1'], T);
    const second = led.openWantAttempt(['m1'], T + 5);
    const live = ledgerRow('m1')!;
    expect(live.asked_min).toBe(T + 5);
    expect(live.tries).toBe(1);

    // The FIRST attempt's session ended. Its preimage is "no row at all",
    // and applying that would delete the live pass's stamp.
    expect(led.rollBackWantAttempt(first)).toBe(0);
    expect(ledgerRow('m1')).toEqual(live);

    // The live one's own rollback still works, and restores what IT found.
    expect(led.rollBackWantAttempt(second)).toBe(1);
    expect(ledgerRow('m1')!.asked_min).toBe(T);
  });

  it('one terminal per attempt: a second one does nothing', async () => {
    // Mutation: drop the open-set check from the terminals. A rollback that
    // runs twice can undo a LATER attempt's stamp on the second pass, which
    // is the same defect as the missing CAS arriving by a different road.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();
    const attempt = led.openWantAttempt(['m1'], T);
    expect(led.rollBackWantAttempt(attempt)).toBe(1);
    expect(led.rollBackWantAttempt(attempt)).toBe(0);

    const committed = led.openWantAttempt(['m2'], T);
    led.commitWantAttempt(committed, []);
    expect(led.rollBackWantAttempt(committed)).toBe(0);
    expect(ledgerRow('m2')).not.toBe(undefined); // the commit's word stands
  });

  it('a DB that fails halfway leaves no stamps and no attempt behind', async () => {
    // THE REQUIRED ARM. Two ids, and the SECOND write throws. Without the
    // transaction the first id keeps a stamp nobody owns; without
    // registering the token only after the commit, a half-written attempt
    // sits in the open set holding a preimage for rows that were never
    // written.
    //
    // Mutation: drop inTransaction from openWantAttempt.
    const phone = makeLedgerPhone();
    mockDbConn = phone;
    phone.breakAfter = 2; // the SECOND id's stamp, so the first is partial
    const led = realLedger();
    expect(() => led.openWantAttempt(['m1', 'm2'], T)).toThrow();
    expect(ledgerRow('m1')).toBe(undefined);
    expect(ledgerRow('m2')).toBe(undefined);

    // …and the next attempt on the same ids is a FIRST attempt: nothing
    // partial survived to inflate its tries.
    mockDbConn = makeLedgerPhone();
    const fresh = realLedger().openWantAttempt(['m1', 'm2'], T);
    expect(ledgerRow('m1')!.tries).toBe(0);
    expect(fresh.ids).toEqual(['m1', 'm2']);
  });

  it('commit acks what landed and leaves the misses backed off', async () => {
    // The live terminal, unchanged in meaning: clearing the whole request
    // would reset the back-off on every id the accept gate refused.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();
    const attempt = led.openWantAttempt(['landed-1', 'poison-1'], T);
    led.commitWantAttempt(attempt, ['landed-1']);
    expect(ledgerRow('landed-1')).toBe(undefined);
    expect(ledgerRow('poison-1')).not.toBe(undefined);
  });

  it('forgive commutes a LIVE transport failure, and is not a rollback', async () => {
    // Kept as its own verb because it is its own decision: the radio really
    // did try, so the strike stands and only its growth is undone.
    mockDbConn = makeLedgerPhone();
    const led = realLedger();
    const attempt = led.openWantAttempt(['m1'], T);
    led.forgiveWantAttempt(attempt, T);
    const row = ledgerRow('m1')!;
    expect(row.tries).toBe(0); // the strike stands
    expect(row.retry_min).toBe(T + 2); // re-armed at the base step
  });
});

// ---------------------------------------------------------------------------
// (t) THE SERVING SCOPE, END TO END — M6's crew half.
//
// A want list is an unauthenticated write: whoever holds a connection to
// this phone's GATT server names ids, and the serve path turns those names
// into rows. Unscoped, the only thing between a stranger and every pod's
// mail on this phone is that they would have to guess an id — and ids are
// handed out in every digest this phone has ever answered, including to a
// pod it has since left.
// ---------------------------------------------------------------------------

describe('(t) a want is answered from the pod being served, and no other', () => {
  it('the store filters by crew when the caller has a scope', async () => {
    // The gate itself, against a real store — and the REMOVED-POD case is
    // what it is for: a phone that has left a pod still HOLDS that pod's
    // rows for as long as they live, and every peer it ever answered knows
    // those ids. Unscoped, leaving a pod takes nothing away from the people
    // who were in it. Mutation: drop the crew predicate from messagesByIds
    // and the id alone decides.
    mockDbConn = makeLedgerPhone();
    const store = jest.requireActual('../src/crews/messages') as {
      composeText: (
        crewCode: string,
        myCardId: string,
        text: string,
        toCardId: string | null,
        nowMin: number,
        rand?: () => number,
      ) => { id: string };
      messagesByIds: (ids: string[], crewCodes?: string[]) => Array<{ id: string }>;
    };
    const mine = store.composeText('amber-lantern-31', 'me', 'ours', null, 10);
    const theirs = store.composeText('jade-compass-77', 'me', 'theirs', null, 10);
    const asked = [mine.id, theirs.id];

    // Unscoped — the codec suites' form — is the whole store.
    expect(store.messagesByIds(asked).length).toBe(2);
    // Scoped is the pod being served, and nothing else.
    expect(
      store.messagesByIds(asked, ['amber-lantern-31']).map(r => r.id),
    ).toEqual([mine.id]);
    // A session serving NO pod serves no rows — which is not the same
    // answer as "no scope was given".
    expect(store.messagesByIds(asked, [])).toEqual([]);
    mockDbConn = {};
  });

  it('two peers asking at once are answered each with its own bytes', async () => {
    // THE A/B REORDER, on the JS side of the seam. Two centrals write want
    // lists and the answers go back one per event, each addressed to the
    // peer that asked: nothing here can fill B's buffer with A's rows,
    // because the peerId the answer carries is the one the event carried.
    //
    // KEPT AND STRENGTHENED, not superseded (section (w) is the same-peer
    // case this one cannot reach). It used to say the other half "cannot be
    // driven from here" and that was true of a reply carrying only a peer:
    // the request had no name, so nothing in JS could be asserted about
    // which question was being answered. It has one now, so this arm holds
    // the identity too — each answer carries the id and the epoch of the
    // event that asked, not of the other peer's and not a freshly minted
    // one.
    //
    // Mutation: answer with a captured peerId instead of the event's, or
    // with a captured requestId instead of the event's.
    await flush();
    const bytesFor: Record<string, string> = {
      [PEER]: 'A-ROWS',
      [WAITING_1]: 'B-ROWS',
    };
    let asked = '';
    serveSpy.mockImplementation(() => new Uint8Array());
    mockB64ToBytes = () => {
      const json = '["m1"]';
      return Uint8Array.from(Array.from(json).map(c => c.charCodeAt(0)));
    };
    mockBytesToB64 = () => bytesFor[asked];

    asked = PEER;
    const a = wantBody(PEER);
    mockWant!(a);
    asked = WAITING_1;
    const b = wantBody(WAITING_1);
    mockWant!(b);

    expect(a.requestId).not.toBe(b.requestId);
    expect(nativeProvide.mock.calls).toEqual([
      [PEER, a.requestId, a.serverEpoch, 'A-ROWS'],
      [WAITING_1, b.requestId, b.serverEpoch, 'B-ROWS'],
    ]);
  });

  it('serveMessages hands the scope down instead of dropping it', async () => {
    // The link between the two halves, and the one a mutation would break
    // silently: meshSync passes the codes (section (s)) and the store
    // filters on them (above), so the only thing left to lose is the
    // forwarding in between.
    const real = jest.requireActual('../src/crews/syncLink');
    ledger().messagesByIds.mockClear();
    real.serveMessages(['m1'], 100, ['amber-lantern-31']);
    expect(ledger().messagesByIds).toHaveBeenLastCalledWith(
      ['m1'],
      ['amber-lantern-31'],
    );
  });
});

// ---------------------------------------------------------------------------
// (w) THE ANSWER NAMES ITS QUESTION — the cross-family binding NO-GO on the
// union, and the one defect in this file whose reproducer needs no second
// peer at all.
//
// The seam had three links and the identity survived none of them. Both
// servers minted a `requestId` for every want and stamped the `serverEpoch`
// it was built under, and put both on the CrewSyncWant event. radio.ts read
// the peer and the bytes and dropped the other two. meshSync answered
// `provideSyncMessages(peerId, b64)`. iOS installed the bytes against the
// peer with nothing consulted; Android matched by ARRIVAL ORDER, which is
// the same thing as the right answer only while every want is answered, in
// order, by a session that is still alive.
//
// So, with ONE central and no concurrency at all:
//
//   1. that central writes a want; the event is queued for JS
//   2. the walkie closes / the pod changes: stopMeshSync, endSession
//   3. a new session starts — `running` is true again, the digest is
//      published again, and the SAME central writes a new want
//   4. the callback from step 1 finally runs. It reads the module globals,
//      finds a live session, computes rows under the crew codes captured in
//      ITS closure — the dead pod's — and answers "for peer X".
//
// Step 4's bytes are what the central reads as the answer to step 3.
//
// The cure is one identity carried end to end: the event's requestId and
// serverEpoch reach the listener (radio.ts), ride the reply back down
// (meshSync), and are what each server matches against — the exact request
// it still has open at that id, under the offer it publishes right now,
// with every id minted before a stop dead forever. The native halves are
// held by iosMeshParity, which reads both modules; these are the arms JS
// can drive.
// ---------------------------------------------------------------------------

describe('(w) a want is answered by the session that was asked', () => {
  /** The dead session's own listener, held across the stop the way the
   * event queue holds a callback that has not run yet. */
  const captureListener = () => mockWant!;

  it('the SAME central: a dead session cannot fill the live one', async () => {
    // THE REVIEWER'S REPRODUCER, verbatim and with one peer. Plant (a)
    // restores the peer-only install — the stale-session fence deleted and
    // the reply addressed to a peer again — and this arm goes red twice
    // over: A's bytes reach the radio at all, and they reach it wearing no
    // request id for the server to refuse them by.
    await flush();
    aWant();
    const serveA = captureListener();

    // The walkie closes and the pod changes underneath the queued callback.
    stopMeshSync();
    startMeshSync(NEW_CODES);
    await flush();

    // The same central asks again, and THIS session answers it.
    const b = wantBody(PEER);
    aWant();
    mockWant!(b);
    expect(nativeProvide).toHaveBeenCalledTimes(1);
    expect(nativeProvide).toHaveBeenLastCalledWith(
      PEER,
      b.requestId,
      b.serverEpoch,
      expect.any(String),
    );

    // …and now the delayed callback from the session that ENDED runs. It
    // finds `running` true and an installed digest, because both of those
    // belong to the session that replaced it.
    const from = logs.length;
    serveA(wantBody(PEER));

    // Nothing more reaches the radio: B's request is not filled by A's
    // bytes, and no row was read under the dead pod's codes to fill it with.
    expect(nativeProvide).toHaveBeenCalledTimes(1);
    expect(serveSpy).toHaveBeenCalledTimes(1);
    // And the refusal is named, not a silence.
    expect(since(from)).toContain('want-drop');
    expect(since(from)).toContain('reason=stale-session');
  });

  it("the reply carries the event's own identity, never a fresh one", () => {
    // THE PIPELINE, asserted as one hop: whatever identity arrived is
    // exactly what goes back down. Mutation: mint an id here, or forward
    // the live epoch instead of the one the want was built against — either
    // makes the server's match a formality that always succeeds.
    const w = wantBody(PEER, 41);
    aWant();
    mockWant!(w);
    expect(nativeProvide).toHaveBeenLastCalledWith(
      PEER,
      w.requestId,
      41,
      expect.any(String),
    );
  });

  it("a server's refusal is written down, in the server's own words", async () => {
    // THE REFUSAL HAS A READER. Both modules answer an unmatched reply with
    // a named reason instead of installing it; a reason nothing records is
    // a want that went unserved in silence, which is the shape this whole
    // class hid in. Mutation: drop the resolution handler and the seam goes
    // quiet again.
    nativeProvide.mockImplementation(async () => 'stale-request');
    const from = logs.length;
    aWant();
    mockWant!(wantBody(PEER));
    await flush();
    expect(since(from)).toContain('want-refused');
    expect(since(from)).toContain('reason=stale-request');
  });

  it('an install is not reported as a refusal', async () => {
    // The other direction, because a log line that fires on success would
    // be noise that trains the reader to ignore it. Mutation: log
    // unconditionally.
    const from = logs.length;
    aWant();
    mockWant!(wantBody(PEER));
    await flush();
    expect(since(from)).not.toContain('want-refused');
  });
});

// ---------------------------------------------------------------------------
// (v) THE CHECK'S OWN BATCH, AND THE SURFACE THAT READS IT — M4.
//
// The tap used to queue every fresh address, await the GLOBAL drain, and
// subtract two SESSION-wide counters across that await. So the answer
// included whatever an ambient dial happened to move, `inRange` was a tally
// of an address book that could be emptied underneath it, and a restart made
// the subtraction negative. And when the result WAS honest about being
// superseded, the surface rendered its zeros as "Nobody in range right now"
// — a claim about the pod, made to a camper standing beside their podmate.
// ---------------------------------------------------------------------------

describe('(v) the check counts its own routes, and a cancelled one says nothing', () => {
  it("another peer's mail is not reported as the answer to the tap", async () => {
    // THE INTERLEAVING, and it is the ordinary one: the camper taps while
    // an ambient dial is already on the radio. That dial is not an answer
    // to the tap — it was going to happen anyway, to a peer the check could
    // not even queue (synced seconds ago, so it is counted as in range and
    // deliberately not re-dialled) — and it completes while the check is
    // still waiting on its own route.
    //
    // Mutation (plant 52): noteCheckDone counts every entry rather than the
    // ones this check queued. The tap then reports the ambient dial's two
    // messages as its own result, which is the session-counter defect
    // arriving by its other road.
    mockSighting!({ peerId: PEER, via: 'gatt' });
    await flush();
    const mark = dials();

    await tick(30_000);
    const settleAmbient = armTheRadio(2);
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(mark + 1); // the ambient dial is on the radio

    // The tap: PEER is in range and past the floor (queued, and this
    // check's own), WAITING_1 is in range and was dialled a moment ago
    // (counted, not re-dialled — and not this check's).
    const settleMine = armTheRadio(1);
    const checking = checkPodUpdates();
    await flush();

    settleAmbient(true); // …lands while the check is still pending
    await flush();
    settleMine(true);
    await flush();
    await flush();

    const r = await checking;
    expect(r.cancelled).toBe(undefined);
    expect(r.inRange).toBe(2);
    expect(dialedAddrs().slice(mark)).toEqual([WAITING_1, PEER]);
    // ONE message: the check's own route moved one, the ambient dial moved
    // two, and only the first is an answer to the tap.
    expect(r.moved).toBe(1);
  });

  it('a cancelled check is rendered as no note at all', async () => {
    // THE PARKED UI FIX. checkOutcomePhrase used to take {inRange, moved}
    // and nothing else, so a cancelled result — zeros that mean "we could
    // not ask" — came out as the zero-in-range sentence.
    //
    // Mutation: drop the cancelled branch and the camper standing next to
    // their podmate is told "Nobody in range right now" because their own
    // phone bounced.
    expect(checkOutcomePhrase({ inRange: 0, moved: 0, cancelled: true })).toBe(
      null,
    );
    // …and the honest results still speak.
    expect(checkOutcomePhrase({ inRange: 0, moved: 0 })).toMatch(
      /Nobody in range/,
    );
    expect(checkOutcomePhrase({ inRange: 2, moved: 1 })).toMatch(/1 new/);
  });

  it('the pod card consumes the whole result, cancellation included', async () => {
    // The wiring pin, in podStatus.test.ts's own source-reading idiom: a
    // discriminated result nobody passes through is a discrimination that
    // does not exist. Mutation: destructure inRange/moved at the call site
    // and the flag never reaches the phrase.
    const podLinks = require('fs').readFileSync(
      'src/crews/PodLinks.tsx',
      'utf8',
    ) as string;
    expect(podLinks).toMatch(
      /setCheckNote\(checkOutcomePhrase\(await checkPodUpdates\(\)\)\)/,
    );
    expect(podLinks).not.toMatch(/inRange:/);
  });
});

// ------------------------------------------------ (w) the stop as a barrier
//
// AN EXPLICIT STOP IS A BARRIER, OR IT IS A CLAIM (rows 107 and 109).
//
// `stopMeshSync()` fire-and-forgot `native.endSession()` and returned void, so
// teardownSession proceeded through masterOff and RESOLVED while the native
// side had retired nothing — on iOS that verb only enqueued its work. The UI
// finished saying "off" over a phone whose previous session's services,
// per-central buffers and open wants were all still live and still readable,
// and the replacement session could be admitted on top of them.
//
// The confirmed ordering, and the ONLY one armed here: a CoreBluetooth read R
// is already queued on main when the stop runs. Main's order is R -> the
// stop's own cleanup, so a cleanup is something R got in front of. The
// E-clears-B-digest variant is FIFO-refuted (the shared queue preserves
// endSession before the later publish, and both land on main in order) and is
// deliberately NOT armed: a passing plant for a refuted claim is vacuity.
//
// Both cures are built, because the reviewer offered OR and the stub-masking
// above is the proof that an async road rots unwatched: native completes its
// retirement before its call returns, AND the JS lifecycle awaits the promise
// through teardown. These arms drive the JS half, which is the half a JS
// harness can actually execute; iosMeshParity holds the native half.

describe('(w) an explicit stop is a barrier, not a claim', () => {
  it('R QUEUED BEFORE E — a read draining after teardown resolves is refused', async () => {
    // Mutation (plant 67): drop the `await` on stopMeshSync in
    // teardownSession. Teardown then resolves before the native retirement
    // has landed, R drains into a live buffer, and a central reads the dead
    // session's mail after the UI said off.
    await startMailboxPresence();
    // Session A answered a want for central C: those bytes are readable.
    mockServer.buffers.set('C', 'A-mail');
    expect(mockReadMsg('C')).toBe('A-mail');
    // R is already on main's queue when the stop begins.
    mockQueuedReads.push('C');
    // THE STOP, with the native retirement held open. A retirement that
    // lands on the next microtask would slip through teardown's own later
    // awaits and prove nothing about the ordering.
    mockParkEndSession = true;
    let resolved = false;
    const teardown = stopMailboxPresence().then(() => {
      resolved = true;
    });
    // A LONG DRAIN, and the length is the point. teardownSession has several
    // awaits after the mesh stop — the pocket session, masterOff, the sharing
    // barrier — and each costs a handful of microtasks, so the suite's
    // ordinary 8-tick flush cannot tell "blocked on the radio" from "not
    // there yet". Two hundred ticks is far past the whole chain: if teardown
    // is going to resolve without the native retirement, it has resolved.
    for (let i = 0; i < 200; i += 1) {
      await Promise.resolve();
    }
    // TEARDOWN MAY NOT RESOLVE YET. The whole finding is that it did.
    expect(resolved).toBe(false);
    expect(mockServer.meshRetired).toBe(false);
    // The native side settles; only now may teardown finish.
    mockReleaseEndSession();
    await teardown;
    expect(resolved).toBe(true);
    // R drains now — after teardown returned, before anything else runs.
    expect(mockDrainReads()).toEqual(['refused']);
    // …and the native side really was told, rather than the JS world merely
    // forgetting. A stop that only disowns is the defect this replaced.
    expect(mockEndSessions).toBeGreaterThan(0);
  });

  it('the retirement is observed BEFORE a replacement session is admitted', async () => {
    // The other half of the same sentence: a start that races the previous
    // stop would be a fresh session serving from the dead one's buffers.
    // share.ts serializes both verbs, so the stop is complete before the
    // start begins — and the assertion is on the SERVER's state at the
    // moment the new session exists, not on a call count.
    await startMailboxPresence();
    mockServer.buffers.set('C', 'A-mail');
    await stopMailboxPresence();
    expect(mockServer.buffers.size).toBe(0);
    expect(mockReadMsg('C')).toBe('refused');
    await startMailboxPresence();
    // The replacement world has to publish before this phone serves anybody
    // again; nothing it inherited is readable.
    expect(mockReadMsg('C')).toBe('refused');
  });

  it('THE PRIVACY PATH — user-off retires the surface a known central can reach', async () => {
    // Row 108, armed exactly. Mutation (plant 68): drop the awaited
    // stopAllRadio from teardownSession. Then the camper disables their last
    // mailbox, the UI teardown completes, and iOS's payload service and its
    // last value are STILL published — so a central that learned this
    // iPhone's identifier while sharing reconnects by it and reads the
    // payload back after sharing said off. stopAdvertising cannot close
    // that: on iOS it stops discovery only, and endSession clears the mesh
    // scope only.
    await startMailboxPresence();
    expect(mockReadPayload()).toBe('this-phone');
    await stopMailboxPresence();
    // The surface itself, not just the announcement.
    expect(mockStopAlls).toBeGreaterThan(0);
    expect(mockServer.surfaceRetired).toBe(true);
    // …and the known central's payload read is refused rather than answered.
    expect(mockReadPayload()).toBe('refused');
  });

  it('the WALKIE hold keeps its stopAdvertising-only semantics', async () => {
    // THE TRADE THAT MUST SURVIVE THE CURE. A walkie hold is temporary and
    // deliberately keeps the mailbox reachable — pod mail keeps flowing to
    // peers that already hold this address, which on iOS is the direction it
    // already flowed. Mutation: route the hold through stopAll too, and
    // every walkie session silently stops serving mail for its duration.
    await startMailboxPresence();
    mockServer.buffers.set('C', 'A-mail');
    const before = mockStopAlls;
    await holdCrewAdvertising();
    expect(mockStopAlls).toBe(before);
    expect(mockServer.surfaceRetired).toBe(false);
    expect(mockReadPayload()).toBe('this-phone');
    expect(mockReadMsg('C')).toBe('A-mail');
    await releaseCrewAdvertising();
    expect(mockReadMsg('C')).toBe('A-mail');
  });
});

// ------------------------------- (x) the adapter comes back, and so does the offer
//
// AN ADAPTER BOUNCE WITHDRAWS THIS PHONE'S DIGEST ON BOTH PLATFORMS, and
// nothing was putting it back (row 123, blocker 1 — confirmed).
//
// Android's `onAdapterOff` closes the GATT server; iOS's two `.poweredOff`
// arcs take the `.radio` retirement. Both clear `syncDigest` and set
// `digestReady` false, deliberately: a reopened radio must not answer from an
// offer published for a session that has since gone.
//
// The recovery road then restarts the SCAN and refreshes the payload, and
// stops. `meshSync` never stopped running, so `startMeshSync` does not fire
// again; `pushDigest` runs at start and on a store revision, and neither
// happens. So the phone serves `total=0` to every podmate INDEFINITELY —
// until somebody happens to write or receive a message on it. Sharing reads
// as on, the pod's mailbox reads as empty, and nothing anywhere is an error.
//
// THE CURE IS ON THIS SIDE OF THE BRIDGE: the return of the adapter is a
// publish. It rides the state stream radio.ts already exposes, it is
// EDGE-triggered (that stream carries an event per advertise/scan
// transition), and the strictly-newer rule admits it by construction —
// pushDigest bumps the revision on every call, so the republish is (epoch,
// rev + 1) inside the same session, strictly newer than the floor both
// natives kept through the retirement.

describe('(x) an adapter bounce republishes the current offer', () => {
  it('off -> on republishes with no store change at all', async () => {
    // Mutation (the plant): drop the onRadioState subscription from
    // startMeshSync. Nothing else in this arm changes, and the phone serves
    // an empty mailbox for the rest of the evening.
    const first = mockPublishes[0];
    expect(mockPublishes.length).toBe(1);

    // The adapter goes down. This is the event the native side emits from
    // its own poweredOff/STATE_OFF road; the offer is gone with it.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    expect(mockPublishes.length).toBe(1); // nothing to publish onto a dead radio

    // …and it comes back. NO store change: nothing was written, nothing was
    // received, the camper did nothing.
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();

    // THE CURRENT DIGEST IS PUBLISHED AGAIN, in this session, at a strictly
    // newer revision — which is exactly what lets the native side admit it
    // over the floor it deliberately kept.
    expect(mockPublishes.length).toBe(2);
    expect(mockPublishes[1]).toEqual({ epoch: first.epoch, rev: first.rev + 1 });
    expect(logs.join('\n')).toContain('digest republish reason=adapter-on');
  });

  it('a peer can fetch the current offer once the radio is back', async () => {
    // The reviewer's exit condition, said in the terms this file can check:
    // "peer can fetch current offer" is, on this side, "this session has an
    // installed offer again", which is the gate the want handler consults.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    const from = logs.length;
    aWant();
    mockWant!(wantBody(PEER));
    expect(nativeProvide).toHaveBeenCalled();
    expect(since(from)).not.toContain('reason=digest-not-installed');
  });

  it('it is an EDGE, not a level: an on-on tick republishes nothing', async () => {
    // Mutation: republish on every state event. That stream fires on every
    // advertise/scan transition, so this would spend radio time re-offering
    // an unchanged digest several times a minute — and the fix for a silent
    // mailbox would become a chatty one.
    expect(mockPublishes.length).toBe(1);
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    mockEmitRadioState({ advertising: false, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(1);
  });

  it('a module that cannot say reads as UNCHANGED, never as off', async () => {
    // The honesty rule this field already carries everywhere else: an event
    // with no adapterEnabled must not be read as a power cycle, or a module
    // that omits the field republishes on every tick.
    mockEmitRadioState({ advertising: true, scanning: true });
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(1);
  });

  it('RECOVERY IS THE ACK, not the publish', async () => {
    // Mutation (the ready-before-ACK plant): report ready off the publish
    // going out rather than off the ack coming back.
    //
    // THE TWO INDEPENDENT RACES this closes. The republish was fire-and-
    // forget from this listener, and the session's own honesty machine
    // cleared the interruption as soon as the scan and the payload were
    // back. Both of those are true BEFORE any offer is installed, so the app
    // said "recovered" over a phone whose digest characteristic still
    // answered the not-ready frame — sharing reads as on, the pod's mailbox
    // reads as empty, and nothing anywhere is an error.
    expect(meshRepublishReady()).toBe(true);

    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });

    // THE REPUBLISH IS IN FLIGHT. Nothing this session serves has been
    // installed since the radio came back, so readiness is FALSE — measured
    // at the one instant the old shape reported success.
    expect(meshRepublishReady()).toBe(false);

    await flush();
    // …and the ack is what turns it true.
    expect(meshRepublishReady()).toBe(true);
    expect(mockPublishes.length).toBe(2);
  });

  it('a want arriving mid-republish is not answered from a withdrawn offer', async () => {
    // THE READINESS PREDICATE'S OWN CALLER, and the reason it is a predicate
    // rather than a report. Both native modules withdraw the offer on a
    // power cycle, so between the adapter returning and the republish being
    // acked, `digestInstalled` says "installed" about a characteristic that
    // is answering the not-ready frame. A want served in that window is
    // rows chosen against an offer the pod cannot read.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    const from = logs.length;
    aWant();
    mockWant!(wantBody(PEER));
    expect(nativeProvide).not.toHaveBeenCalled();
    expect(since(from)).toContain('reason=digest-not-installed');
    // …and the ack opens it again, with no second ask from the peer beyond
    // the retry the not-ready protocol already has it doing.
    await flush();
    mockWant!(wantBody(PEER));
    expect(nativeProvide).toHaveBeenCalled();
  });

  it('a republish the native side REFUSES leaves recovery unready', async () => {
    // The other half, and the reason readiness compares a REVISION rather
    // than counting promises: a publish that rejected still minted its
    // revision, and the installed revision never reaches it. Silence is not
    // an ack, and neither is a settled promise.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    mockPublishRejects = true;
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(2);
    expect(meshRepublishReady()).toBe(false);
  });

  it('THE BARRIER IS AN IDENTITY: a pre-bounce ack cannot settle a post-bounce recovery', async () => {
    // THE OTHER HALF OF THE ROW-132 CURE, from the mesh's side. The session
    // asks this file for the digest leg of its recovery transaction; the
    // question it is really asking is "can a podmate READ my mailbox now",
    // and at the instant the adapter comes back the honest answer is no —
    // even though `digestInstalled` still names an acked revision, because
    // both native modules withdrew that offer on the power cycle.
    //
    // Mutation (the barrier-ignores-the-withdrawal plant): settle the leg on
    // meshRepublishReady() alone, and the pre-bounce ack settles a
    // post-bounce recovery instantly — which is the blocker, re-shipped
    // behind a barrier that looks like a cure.
    let settled: boolean | null = null;

    // Before anything is withdrawn, the offer IS servable: a recovery minted
    // now has nothing to wait for.
    void awaitMeshDigestReady().then(v => {
      settled = v;
    });
    await flush();
    expect(settled).toBe(true);

    // THE WITHDRAWAL. Native has dropped the digest; the ack sitting in
    // `digestInstalled` is now about a characteristic nobody can read.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    settled = null;
    void awaitMeshDigestReady().then(v => {
      settled = v;
    });
    await flush();
    expect(settled).toBeNull(); // HELD, on the pre-bounce ack's own evidence

    // …and the republish the adapter's return owes is what settles it.
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(2);
    expect(settled).toBe(true);
  });

  it('a recovery leg minted in a session that ends is SUPERSEDED, never ready', async () => {
    // Arrival order would call this "the ack never came". Identity calls it
    // what it is: the pod this leg was minted for stopped existing, so the
    // leg says false and the session it belonged to clears nothing.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    let settled: boolean | null = null;
    void awaitMeshDigestReady().then(v => {
      settled = v;
    });
    await flush();
    expect(settled).toBeNull();

    await stopMeshSync();
    await flush();
    expect(settled).toBe(false);
  });

  it('NO MESH, NO WORK: a leg minted with nothing running settles trivially', async () => {
    // A phone with no pod publishes no digest, so a recovery that waited for
    // one would never finish. The rule is stated where the leg is minted and
    // armed here: not-running is "no work", never "not ready".
    await stopMeshSync();
    await expect(awaitMeshDigestReady()).resolves.toBe(true);
  });

  it('THE WIRING: share.ts hands the session THIS barrier, not a stub', async () => {
    // THE VACUITY THIS ARM CLOSES. The recovery transaction spans two files
    // by design — session.ts must not import this one — so the barrier
    // reaches it as an injected opt. Both sides are armed elsewhere and
    // NEITHER can see the wire: the session's suite injects a fake, and this
    // one mocks the session. Delete the one line in share.ts that threads it
    // and every arm in the repo stays green while a bounced phone reports
    // recovery off two legs again. So the wire is armed here.
    await startMailboxPresence();
    const injected = mockSessionOpts?.awaitMeshDigest;
    expect(typeof injected).toBe('function');

    // …and it is THIS file's barrier rather than any function of the right
    // shape: after the adapter withdraws the offer, what share.ts handed
    // over must HOLD, and settle on the republish's ack.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    let settled: boolean | null = null;
    void injected!().then(v => {
      settled = v;
    });
    await flush();
    expect(settled).toBeNull();
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(settled).toBe(true);
  });

  it('A STALE REPUBLISH COMPLETION CANNOT DECREMENT THE WORLD THAT REPLACED IT', async () => {
    // Mutation (the plant): drop the identity guards from the republish's
    // `.then`/`.finally`, exactly as they were before this cure.
    //
    // THE COMPLETION IS A SECOND WRITER. `pushDigest` guards its own writes
    // by epoch; these two handlers run a microtask LATER, on whatever world
    // exists by then, and `resetMeshWorld` has meanwhile put
    // `republishOutstanding` back to 0 for the pod that replaced this one.
    // A decrement out of the dead session therefore takes the LIVE counter
    // to -1 — and `meshRepublishReady` compares it against 0 exactly, so the
    // replacement pod can never report ready again. Not "reports late": the
    // recovery leg of every bounce in that session waits forever, on a phone
    // whose mailbox is perfectly readable.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await flush();
    // The republish goes out and is HELD on the bridge.
    mockParkPublish = true;
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(2);
    expect(meshRepublishReady()).toBe(false); // in flight, as it must be

    // …and the camper's pod is replaced UNDER it: a walkie close, a pod
    // change, a background bounce. The counters are reset for the new world.
    await stopMeshSync();
    startMeshSync(CODES);
    await flush();
    const fresh = mockPublishes.length;
    expect(meshRepublishReady()).toBe(true); // the new session published and was acked

    // NOW the dead session's republish comes home.
    mockReleasePublishes();
    await flush();

    // IT CHANGED NOTHING. Not the counter, not the target, not the offer.
    expect(meshRepublishReady()).toBe(true);
    expect(mockPublishes.length).toBe(fresh);
    expect(logs.join('\n')).toContain('digest republish drop reason=stale-epoch');

    // …and the live session's own recovery still works, which is the fact
    // the counter going negative destroys.
    let settled: boolean | null = null;
    void awaitMeshDigestReady().then(v => {
      settled = v;
    });
    await flush();
    expect(settled).toBe(true);
  });

  it('a bounce after the session ended publishes nothing', async () => {
    // A state event is a native fact, and native does not know a pod ended.
    //
    // THIS ONE IS BELT AND BRACES, AND IS NAMED AS SUCH rather than dressed
    // up: stopMeshSync drops the subscription AND the listener carries the
    // session epoch, so removing either alone leaves this green. What it
    // pins is the field property — a bounce after the camper stopped sharing
    // is inert — and it would only redden if BOTH went. The arms that
    // discriminate are the three above it.
    mockEmitRadioState({ advertising: false, scanning: false, adapterEnabled: false });
    await stopMeshSync();
    const before = mockPublishes.length;
    mockEmitRadioState({ advertising: true, scanning: true, adapterEnabled: true });
    await flush();
    expect(mockPublishes.length).toBe(before);
  });
});
