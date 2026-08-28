/**
 * THE UNION MATRIX — the seven cells neither lane could state alone.
 *
 * TWO LANES BUILT ONE RADIO'S AIRTIME FROM OPPOSITE ENDS, and both are green
 * on their own harness. That is exactly the evidence this file exists to
 * refuse. The native lane doubled share.ts down to two spies, so nothing it
 * asserts can see a mesh cadence hold; the mesh lane doubled the walkie flat,
 * so nothing it asserts can see the arbiter's lease, its debt phase or its
 * terminal. Each lane's green is a statement about ITS half. The composed
 * tree is a third artefact, and the defects that live in it live precisely at
 * the seam neither file crosses:
 *
 *   - a hold has TWO halves now (the crew advertiser off the air; meshSync's
 *     dial queue parked), taken together by share.ts and handed back
 *     together, and a bug that releases one is invisible to both suites;
 *   - the decision to hand them back is the ARBITER'S, not this world's, and
 *     the mesh suite has no arbiter to refuse with;
 *   - and the ambient drain the hold parks is the mesh lane's, driven by a
 *     walkie the mesh lane cannot open for real.
 *
 * THE HARNESS IS THE POINT. share.ts is REAL — hold and release run their own
 * serialized flip queue, drive setCrewAdvertisingHold on one side and
 * setMeshAirtimeHold on the other. meshSync is REAL. walkieSession is REAL.
 * session.ts is REAL. What is doubled is the module boundary underneath: the
 * radio's native verbs and the walkie module, whose arbiter answers (a stop's
 * outcome, a queried state, a pushed event) are driveable from an arm.
 *
 * Individual lane green is not evidence for these cells. Each arm names the
 * mutation it dies on, and four of them are planted for real in
 * tools/plants/native-ack.
 *
 * ------------------------------------------------------------------------
 * AND THE SAME REFUSAL, ONE SEAM OVER: THE RECOVERY TRANSACTION (section R).
 *
 * The bounce-recovery contract has no single owner either. It exists ONLY as
 * a composition of three modules that deliberately do not import each other:
 *
 *   share.ts        constructs the CrewSession and INJECTS the mesh barrier
 *                   (`awaitMeshDigest: awaitMeshDigestReady`), and wires the
 *                   one native radio-state stream to session.noteRadioState;
 *   session.ts      classifies the outage, mints a generation, and spans the
 *                   three legs under recoverRadio — clearing the camper's
 *                   interruption exactly once, for that generation, of that
 *                   session;
 *   meshSync.ts     answers whether THIS session's offer is servable now —
 *                   the withdrawal floor, the republish target and the ack.
 *
 * Each of the three has a green suite, and each of those suites doubles the
 * other two: session's own arms hand recoverRadio a HAND-WRITTEN barrier,
 * meshSync's arms have no session at all, and share.ts's have neither. Per
 * union/composition law that is exactly the arrangement in which three green
 * arms can agree on MISMATCHED epoch, floor and session semantics — a barrier
 * whose floor is per-mesh-epoch handed to a transaction whose generation is
 * per-session, with the wire between them (one line in share.ts) covered by
 * nobody. Deleting that line once left every arm in this repo green while a
 * bounced phone reported recovery off two legs.
 *
 * Section R crosses it for real. The three legs are independently holdable at
 * the NATIVE boundary and nowhere else, and every verdict is read through the
 * surfaces the app itself reads: session.radioInterrupted() (what the share
 * switch renders), subscribeSessionChanged/sessionRevision (when it
 * re-renders), and meshSync.meshRepublishReady() (whether a peer could read
 * this phone's mailbox). No arm reaches into a module global.
 */
let mockSighting: ((s: { peerId: string; via?: string }) => void) | undefined;
let mockMessagesChanged: (() => void) | undefined;
let mockWant:
  | ((w: { peerId: string; payload: string }) => void)
  | undefined;
let mockAppStateCurrent = 'active';
let mockPlatformOS = 'ios';
/** Every setCrewAdvertisingHold(x) the transmit half was asked for. */
const mockAdvHold: boolean[] = [];
/** …and the cached bit those flips leave behind (radio.ts's own). */
let mockAdvHeld = false;
let mockAdvHoldThrows = false;
/** The walkie's own native half, for the (g) lifecycle arms: what the
 * session asked the radio to do, and whether its start refuses. */
const mockWalkieCalls: string[] = [];
let mockStartWalkieThrows: Error | null = null;
let mockWalkieOn = false;
/** A radio that answers stopWalkie with strict `false`: its own advertiser
 * did NOT go down. Undefined is today's real answer (Promise<void>). */
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
/** How many times production asked native to end its session. */
let mockEndSessions = 0;
/** What the modelled native teardown does to the op on the radio. */
let mockOnEndSession: (() => void) | null = null;
/** Held open by the M7 arms, so the permission answer lands in a world that
 *  has moved on underneath it. */
let mockPermGate: Promise<void> | null = null;

/* -------------------------------------------------------------------------
 * THE RECOVERY TRANSACTION'S THREE KNOBS.
 *
 * The composed arm below drives a REAL share.ts construction, a REAL
 * CrewSession and a REAL meshSync, and the only thing left doubled is the
 * native boundary underneath. A recovery is three legs — the scan effect,
 * the advertise/payload effect and the digest publish ACK — and the whole
 * claim being proved is that no two of them are enough. So the double has to
 * let an arm hold each leg SEPARATELY, release them in whatever order it
 * likes, and leave any one of them held FOREVER: a leg that always settles
 * on the next microtask cannot tell a conjunction from a race.
 *
 * A gate is one leg, parked. The production code is suspended inside the
 * native call exactly where a phone suspends — mid-startScan, mid-advertise,
 * between publishSyncDigest and its ack — and the arm holds the switch.
 * ------------------------------------------------------------------------- */
interface MockGate {
  /** What the production call is awaiting. */
  promise: Promise<void>;
  /** The native effect landed. */
  release: () => void;
  /** …or the native side refused it (a rejected publish, a radio that says
   *  no), which is a different settlement and a different road. */
  refuse: (e?: Error) => void;
}

/** Declared as a FUNCTION, not a const arrow: the jest.mock factories below
 *  reach it while their module is first required, which is before this
 *  module body has run. */
function mockMakeGate(list: MockGate[]): Promise<void> {
  let release!: () => void;
  let refuse!: (e?: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    release = () => res();
    refuse = (e?: Error) => rej(e ?? new Error('the native side refused'));
  });
  // Never an unhandled rejection just because an arm chose `refuse` and the
  // production road swallowed it.
  promise.catch(() => undefined);
  list.push({ promise, release, refuse });
  return promise;
}

/** LEG 1 — every startScan the session asked for that an arm chose to hold,
 *  in call order. */
const mockScanGates: MockGate[] = [];
/** LEG 2 — the same for the advertise/payload effect. */
const mockAdvGates: MockGate[] = [];
/** LEG 3 — the same for the native digest publish, held BETWEEN the call and
 *  its ack, which is the window `digestInstalled` lives in. */
const mockPublishGates: MockGate[] = [];
/** Which of the three the double is holding right now. Flipped by the arm
 *  before it triggers the effect; a leg armed here is a leg that does not
 *  settle until the arm says so. */
const mockHold = { scan: false, advertise: false, publish: false };

/** Every CrewRadio share.ts minted, newest last — one per session, so a
 *  replaced session's radio is a different object from the live one's. */
const mockRadios: Array<{ calls: string[] }> = [];

/** THE NATIVE RADIO-STATE STREAM, as a real fan-out rather than a stub.
 *  BOTH consumers subscribe to it in production — share.ts wires it to
 *  session.noteRadioState, meshSync wires its own withdrawal/republish
 *  listener — and the composed arm turns on ONE event reaching both. */
const mockRadioStateListeners = new Set<
  (s: {
    advertising: boolean;
    scanning: boolean;
    adapterEnabled?: boolean;
    error?: string;
  }) => void
>();

/** The DB nothing here touches. */
let mockDbConn: unknown = {};

/** ONE VERSIONED BODY, the shape the real decoder accepts. An arm overrides
 *  only the field it is about, so a body can never drift into being
 *  unreadable for a reason the arm did not intend. */
const mockAirtime = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  processIncarnation: 'proc-1',
  revision: '4',
  revisionHi: 0,
  revisionLo: 4,
  phase: 'idle',
  leaseId: null,
  opId: null,
  rung: 'none',
  debtCount: 0,
  crewMayAdvertise: true,
  holdRequired: false,
  why: 'query',
  ...over,
});

/** The arbiter's slot, free. */
const CLEAR = mockAirtime();
/** The same slot, still owed — the process is proving an advertiser down. */
const HOLDING = mockAirtime({
  phase: 'debt',
  debtCount: 1,
  crewMayAdvertise: false,
  holdRequired: true,
  revision: '7',
  revisionLo: 7,
  why: 'debt-transfer',
});
/** …and one settlement LATER: the only thing that tells a body describing
 *  the world after the settlement from one describing it before. */
const SETTLED = mockAirtime({
  revision: '9',
  revisionLo: 9,
  why: 'debt-settled',
});

/** THE ARBITER, as an arm drives it: what a stop answers, what a query
 *  answers, and who is listening for a push. */
const mockSeam: {
  capability: string;
  state: unknown;
  stop: unknown;
  listeners: Set<(s: unknown) => void>;
  asked: number;
} = {
  capability: 'arbiter',
  state: CLEAR,
  stop: { v: 2, outcome: 'clear', why: 'not-advertising', state: CLEAR },
  listeners: new Set(),
  asked: 0,
};

/** Push the arbiter's own event at every JS world listening for it. */
const mockPush = (body: unknown): void => {
  for (const cb of [...mockSeam.listeners]) {
    cb(body);
  }
};

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
        // LEG 3'S HOLD, and it is deliberately AFTER the record and BEFORE
        // the ack: an arm can see that the offer went out while the ack that
        // makes it servable is still in the air. That gap is the entire
        // difference between "republished" and "readable by a peer".
        if (mockHold.publish) {
          await mockMakeGate(mockPublishGates);
        }
        if (mockPublishRejects) {
          throw new Error('a newer digest is already published');
        }
      }),
      endSession: jest.fn(async () => {
        mockEndSessions += 1;
        // THE NATIVE TEARDOWN, modelled: endSession cancels the exact
        // in-flight SyncClient, whose own terminal settles the bridge
        // promise by the failure road. An arm installs the settle switch of
        // whatever it parked on the radio.
        mockOnEndSession?.();
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
  // Subscribed and never driven here: reciprocity is the mesh lane's own
  // suite, and a union cell that needed it would capture it.
  onSyncServed: () => () => undefined,
  onSyncWant: (cb: (w: { peerId: string; payload: string }) => void) => {
    mockWant = cb;
    return () => {
      mockWant = undefined;
    };
  },
  setScanPosture: async () => undefined,
  b64ToBytes: (s: string) => mockB64ToBytes(s),
  bytesToB64: (b: Uint8Array) => mockBytesToB64(b),
  // share.ts's half.
  //
  // THE SESSION'S OWN RADIO, and it is no longer an empty object. The
  // composed arm builds a REAL CrewSession through share.ts's real
  // construction site, so this is the module boundary the session's two
  // radio legs actually stop at — and each leg is independently holdable
  // (mockHold above), which is what lets an arm keep the scan back while the
  // payload lands, or either of them back forever.
  crewRadio: () => {
    const radio = {
      calls: [] as string[],
      advertise: async (): Promise<void> => {
        radio.calls.push('advertise');
        if (mockHold.advertise) {
          await mockMakeGate(mockAdvGates);
        }
      },
      stopAdvertising: async (): Promise<void> => {
        radio.calls.push('stopAdvertising');
      },
      startScan: async (): Promise<void> => {
        radio.calls.push('startScan');
        if (mockHold.scan) {
          await mockMakeGate(mockScanGates);
        }
      },
      stopScan: async (): Promise<void> => {
        radio.calls.push('stopScan');
      },
    };
    mockRadios.push(radio);
    return radio;
  },
  crewRadioPresent: () => true,
  // The teardown's own verb (share.ts calls it on every session end); absent
  // here it threw a TypeError into a swallowing catch, which is a seam that
  // reads as working.
  stopAllRadio: async () => undefined,
  // A ROUND-TRIP AN ARM CAN HOLD OPEN. On a phone this raises a system
  // dialog, which is a suspension with no upper bound — see the M7 arms.
  ensureCrewPermissions: async () => {
    if (mockPermGate) {
      await mockPermGate;
    }
    return true;
  },
  haveCrewPermissions: async () => true,
  onPocketTick: () => () => undefined,
  // ONE EVENT, TWO CONSUMERS — the seam the composed arm turns on. share.ts
  // subscribes session.noteRadioState here and meshSync subscribes its own
  // withdrawal/republish listener, and the ORDER they see an adapter event in
  // is production's order because it is production doing the subscribing.
  onRadioState: (
    cb: (s: {
      advertising: boolean;
      scanning: boolean;
      adapterEnabled?: boolean;
      error?: string;
    }) => void,
  ) => {
    mockRadioStateListeners.add(cb);
    return () => {
      mockRadioStateListeners.delete(cb);
    };
  },
  setCrewAdvertisingHold: async (hold: boolean) => {
    mockAdvHold.push(hold);
    if (mockAdvHoldThrows) {
      throw new Error('the radio refused');
    }
    mockAdvHeld = hold;
  },
  // THE CACHED BIT, and it is a real seam here rather than a stub: the
  // adoption road reads it to decide whether this world's cadence still has
  // to be suppressed, and a mock that always answered false would make every
  // adoption re-take a hold it already had.
  crewAdvertisingHeld: () => mockAdvHeld,
  startPocketSession: async () => undefined,
  stopPocketSession: async () => undefined,
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
  subscribeLocalCompose: () => () => undefined,
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

// src/crews/session IS NOT DOUBLED, and that is the composed arm's whole
// point. The recovery contract exists only as share.ts's construction site
// handing the REAL meshSync barrier to a REAL CrewSession, and three
// separately-green arms can agree on mismatched epoch/floor/session
// semantics — so the seam has to be crossed for real here. The session's own
// suite drives it with a fake barrier; the mesh's suite has no session at
// all; only this file has both, with nothing between them but the native
// doubles above.

jest.mock('../src/crews/crew', () => ({
  listCrews: () => [{ id: 'pod-1', code: 'amber-lantern-31' }],
  subscribeCrewsChanged: () => () => undefined,
}));

jest.mock('../src/crews/presence', () => ({
  pruneSightings: () => undefined,
  // The real session's decode road writes through these. No arm feeds the
  // fake radio a beacon, but a module whose imports are undefined is a
  // harness that works until somebody writes the arm that needs them.
  reportHeard: () => undefined,
  reportSighting: () => undefined,
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

/**
 * THE WALKIE'S OWN MODULE — and here it is the NATIVE ARBITER SEAM, driveable
 * (union harness, 2026-08-27).
 *
 * The mesh lane's suite doubled this module flat: a stopWalkie that answered
 * one canned value and no arbiter at all. The native lane's suite drives the
 * arbiter in full but doubles share.ts down to two spies, so it cannot see a
 * mesh hold. NEITHER FILE CAN STATE A UNION CELL, which is the whole reason
 * this one exists: the REAL share.ts sits in the middle, the REAL meshSync on
 * one side, the REAL walkieSession on the other, and the arbiter's three
 * answers — the stop's outcome, the queried state, the pushed event — are
 * driveable from an arm.
 */
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
    return mockSeam.stop;
  },
  walkieAirtimeState: async () => {
    mockSeam.asked += 1;
    return { capability: mockSeam.capability, state: mockSeam.state };
  },
  onWalkieAirtimeState: (cb: (s: unknown) => void) => {
    mockSeam.listeners.add(cb);
    return () => mockSeam.listeners.delete(cb);
  },
  // The REAL comparator's rule, so a body above 2^53 compares the way
  // production does rather than the way a double found convenient.
  compareWalkieRevision: (
    a: { revisionHi: number; revisionLo: number },
    b: { revisionHi: number; revisionLo: number },
  ) => {
    if (a.revisionHi !== b.revisionHi) {
      return a.revisionHi < b.revisionHi ? -1 : 1;
    }
    if (a.revisionLo !== b.revisionLo) {
      return a.revisionLo < b.revisionLo ? -1 : 1;
    }
    return 0;
  },
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
  checkPodUpdates,
  meshAirtimeHeld,
  meshRepublishReady,
  startMeshSync,
  stopMeshSync,
} from '../src/crews/meshSync';
import { checkOutcomePhrase } from '../src/crews/podStatus';
import {
  radioInterrupted,
  sessionRevision,
  subscribeSessionChanged,
} from '../src/crews/session';
import {
  releaseCrewAdvertising,
  startMailboxPresence,
  stopMailboxPresence,
} from '../src/crews/share';
import {
  __resetWalkieSessionForTests,
  startWalkieSession,
  stopWalkieSession,
  walkieHoldReason,
} from '../src/crews/walkieSession';

const CODES = () => ['amber-lantern-31'];
/** THE SECOND SESSION'S codes, distinct on purpose: a dial that carried
 * these was placed by the session that is actually running, and a dial
 * that carried CODES was placed by one that is not. */
const NEW_CODES = () => ['jade-compass-77'];
const PEER = 'AA:BB:CC:DD:EE:01';
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
/** …and the codec seam the crew scope is decided at. */
const serveSpy = (
  jest.requireMock('../src/crews/syncLink') as { serveMessages: jest.Mock }
).serveMessages;

const dials = () => (linkSync as jest.Mock).mock.calls.length;
/** The crew codes the nth dial actually handed the conductor. */
const codesOfDial = (n: number) =>
  (linkSync as jest.Mock).mock.calls[n][1] as string[];

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
  mockPlatformOS = 'ios';
  mockAppStateCurrent = 'active';
  mockWalkieCalls.length = 0;
  mockStartWalkieThrows = null;
  mockWalkieOn = false;
  mockOffPeersThrows = false;
  mockCallsPresent = false;
  mockRuntimeStartThrows = null;
  mockB64ToBytes = () => new Uint8Array();
  mockBytesToB64 = () => '';
  mockPublishes.length = 0;
  mockPublishRejects = false;
  mockEndSessions = 0;
  mockOnEndSession = null;
  nativeSync.mockReset();
  nativeSync.mockImplementation(async () => ({ digest: '', messages: '' }));
  nativePublish.mockClear();
  nativeSetDigest.mockClear();
  nativeProvide.mockClear();
  serveSpy.mockClear();
  mockAdvHeld = false;
  mockPermGate = null;
  mockHold.scan = false;
  mockHold.advertise = false;
  mockHold.publish = false;
  mockScanGates.length = 0;
  mockAdvGates.length = 0;
  mockPublishGates.length = 0;
  mockRadios.length = 0;
  mockRadioStateListeners.clear();
  mockSeam.capability = 'arbiter';
  mockSeam.state = CLEAR;
  mockSeam.stop = { v: 2, outcome: 'clear', why: 'not-advertising', state: CLEAR };
  mockSeam.listeners.clear();
  mockSeam.asked = 0;
  __resetWalkieSessionForTests();
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
  // A HELD LEG IS A SUSPENDED PRODUCTION CALL, so it outlives the arm the
  // same way an unsettled radio op does. Stop holding, then hand every gate
  // back — an arm that deliberately never released one (which is the point of
  // several of them) must not leave a session parked inside the next arm.
  mockHold.scan = false;
  mockHold.advertise = false;
  mockHold.publish = false;
  for (const g of [...mockScanGates, ...mockAdvGates, ...mockPublishGates]) {
    g.release();
  }
  await flush();
  mockAdvHoldThrows = false;
  mockPlatformOS = 'ios';
  await releaseCrewAdvertising().catch(() => undefined);
  await stopMailboxPresence().catch(() => undefined);
  stopMeshSync();
  __resetWalkieSessionForTests();
  jest.restoreAllMocks();
});

/** BOTH HALVES, READ AS ONE FACT. The transmit half is radio.ts's cached
 *  suppression (what setCrewAdvertisingHold was last asked for); the receive
 *  half is meshSync's own airtime hold. A cell that finds them disagreeing
 *  has found the composed defect neither lane's suite can see. */
const halves = (): { advertiser: boolean; mesh: boolean } => ({
  advertiser: mockAdvHold.length > 0 && mockAdvHold[mockAdvHold.length - 1],
  mesh: meshAirtimeHeld(),
});

/** Let every already-queued microtask run — the park's query, its rejection,
 *  the finally's decrement and the re-drive it fires. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
};

/** Arm the NEXT dial as a promise this arm settles by hand, so a borrow can
 *  be caught while it is still on the radio. */
const armRadioOnce = (accepted = 0): ((ok: boolean) => void) => {
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

/** A want whose payload actually decodes to one id, so the serving road is
 *  reached for a reason other than the codec. */
const aWant = (): void => {
  const json = '["m1"]';
  mockB64ToBytes = () =>
    Uint8Array.from(Array.from(json).map(c => c.charCodeAt(0)));
};

/** Park one ambient op ON the radio and hand back its settle switch, so an
 *  arm can ask what the queue behind it did while it was in flight. */
const parkAmbientOp = async (): Promise<(ok: boolean) => void> => {
  let release!: (ok: boolean) => void;
  (linkSync as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(res => {
        release = (ok: boolean) => res({ accepted: ok ? 1 : 0 });
      }),
  );
  mockSighting!({ peerId: PEER, via: 'adv' });
  await flush();
  expect(dials()).toBe(1);
  inFlight.push((ok: boolean) => release(ok));
  return (ok: boolean) => release(ok);
};

describe('THE UNION MATRIX: seven cells, on the composed tree', () => {
  it('(1) opening the Walkie takes the native suppression AND parks the queued ambient work after the op in flight', async () => {
    // CELL 1. The native lane proves the arbiter is asked; the mesh lane
    // proves the queue parks. Neither proves they happen on ONE gesture, and
    // the ordering inside that gesture is the whole safety property: the op
    // ALREADY on the radio finishes (cancelling it mid-connect is how a peer
    // is left half-read), and nothing behind it starts.
    //
    // Mutation: park at the drain's head instead of after the current op —
    // or take the mesh hold without the advertiser hold. Both die here.
    const finish = await parkAmbientOp();

    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    // The walkie's own radio came up, and it came up AFTER the hold: two
    // advertisers overlapping is the overflow-area defect this order exists
    // to prevent.
    expect(mockWalkieCalls).toEqual(['startWalkie']);
    expect(mockAdvHold).toEqual([true]);

    // Three more peers arrive while the gesture is open. Under the hold they
    // buy evidence, never a dial.
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    mockSighting!({ peerId: WAITING_2, via: 'gatt' });
    mockSighting!({ peerId: WAITING_3, via: 'gatt' });
    await flush();
    expect(dials()).toBe(1);

    // …and the op that was already on the radio is allowed to FINISH.
    finish(true);
    await flush();
    expect(dials()).toBe(1);
    expect(halves()).toEqual({ advertiser: true, mesh: true });
  });

  it('(2) a debt stop keeps BOTH halves, a duplicate stop keeps BOTH, and ONE exact native terminal hands BOTH back', async () => {
    // CELL 2. The mesh lane's failed-start arms end at "the holds came
    // back"; the native lane's debt arms end at "the mirror parked". The
    // composed question is whether the PARK is symmetric — and it is only
    // symmetric because both halves ride one releaseCrewAdvertising.
    //
    // Mutation: release the mesh half on the park road ("the cadence is
    // cheap, hand it back early") and this arm dies at the first assertion
    // after the stop — with the advertiser still suppressed and the mesh
    // clock fast, which is the mismatched state cell 6 is also about.
    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // The arbiter cannot prove this advertiser down: a DEBT, not a clear.
    mockSeam.stop = { v: 2, outcome: 'debt', why: 'unsettled', state: HOLDING };
    mockSeam.state = HOLDING;
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    expect(walkieHoldReason()).toBe('watching');

    // A SECOND TAP re-drives the native stop and finds the same answer. One
    // debt is one debt: nothing is handed back, and nothing is double-held.
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    expect(mockWalkieCalls.filter(c => c === 'stopWalkie')).toHaveLength(2);

    // …and THE terminal — the arbiter saying the book is clear, at a
    // revision later than the one this world adopted.
    mockSeam.state = SETTLED;
    mockPush(SETTLED);
    await drain();
    expect(halves()).toEqual({ advertiser: false, mesh: false });
    expect(walkieHoldReason()).toBe('none');
    // Exactly once. A second terminal cannot flip anything again.
    mockPush(SETTLED);
    await drain();
    expect(mockAdvHold).toEqual([true, false]);
  });

  it('(3) rapid open-close-open: a stale native event cannot release either half', async () => {
    // CELL 3. THE HEADLINE COMPOSED RACE. A settlement dispatched for the
    // FIRST session is delivered during the SECOND session's awaits. Every
    // JS question it is asked answers "yes, clear" — the slot is free, the
    // process is the same — and only "is this still the hold I parked?"
    // catches it. Get it wrong and the camper's OPEN walkie has its crew
    // beacon back on the air (overlap, permanent) and its pod mail back on
    // the fast clock (the scan starved), while the walkie is live.
    //
    // Mutation: drop the generation fence in releaseDeferredHold, or drop
    // cancelDeferredCrewRelease from the start road. Both die here.
    await startWalkieSession(POD);
    mockSeam.stop = { v: 2, outcome: 'debt', why: 'unsettled', state: HOLDING };
    mockSeam.state = HOLDING;
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // …and the camper taps it straight back on. The parked mirror belongs to
    // a session nobody has any more.
    mockSeam.stop = { v: 2, outcome: 'clear', why: 'not-advertising', state: CLEAR };
    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // NOW the first close's settlement lands. It is honest, current and
    // completely irrelevant.
    mockSeam.state = SETTLED;
    mockPush(SETTLED);
    await drain();
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // And the live session's own close is still the one that hands them back.
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: false, mesh: false });
  });

  it('(4) the native endSession cancels the exact op, and the replacement mesh dials at once — no busy, no cooldown, no spent evidence', async () => {
    // CELL 4. The mesh lane proves the cancel reaches the radio. What it
    // cannot show is that the cancel composes with a WALKIE hold standing
    // over it: the replacement session must not inherit either half, and
    // must not pay a cooldown for a dead session's leftover.
    //
    // Mutation: let stopMeshSync return without endSession — the op runs to
    // its own 60 s timeout, the replacement's first dial is refused 'busy',
    // and it pays a cooldown and a spent claim for it.
    const finish = await parkAmbientOp();
    // The native teardown, modelled: endSession cancels the exact in-flight
    // client and its own terminal settles the bridge promise by the failure
    // road.
    mockOnEndSession = () => finish(false);

    stopMeshSync();
    startMeshSync(NEW_CODES);
    await flush();
    expect(mockEndSessions).toBe(1);

    // The replacement dials AT ONCE, and it dials with its OWN codes.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2);
    expect(codesOfDial(1)).toEqual(NEW_CODES());
  });

  it('(5) while held, the manual Check is the only explicit borrow — and a cancelled one reaches PodLinks as no note at all', async () => {
    // CELL 5. Two halves of one rule, and the second is the one a lane
    // suite keeps proving in isolation: the borrow is real, and its
    // CANCELLATION is rendered honestly. A cancelled check that returned
    // zeros would print "Nobody in range right now" over a pod the phone
    // never got to ask about — a confident sentence built out of a
    // teardown.
    //
    // Mutation: teach checkPodUpdates the hold (it stops dialling — a fake
    // spinner on the one button a camper presses when mail feels stuck), or
    // render a cancelled result as its numbers.
    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // Ambient sightings buy nothing while the gesture is open.
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(0);

    // The human asking DOES borrow the radio — its own routes, and only
    // those.
    const settleCheck = armRadioOnce(0);
    const done = checkPodUpdates();
    await flush();
    expect(dials()).toBe(1);
    settleCheck(true);
    const res = await done;
    expect(res.cancelled).toBeUndefined();
    // …and the hold is untouched by the borrow: it was a loan, not a
    // release.
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    // Now the cancelled road, end to end into the surface's own phrase: the
    // pod is replaced underneath the gesture while its dial is on the radio.
    // Past the borrowed route's own cooldown and freshly sighted, so the
    // second tap has something to dial — under the hold that sighting buys
    // evidence and nothing else, which is cell 1's rule still holding here.
    now += 6 * 60_000;
    mockSighting!({ peerId: WAITING_1, via: 'gatt' });
    await flush();
    expect(dials()).toBe(1);
    const settleSecond = armRadioOnce(0);
    const second = checkPodUpdates();
    await flush();
    expect(dials()).toBe(2);
    stopMeshSync();
    startMeshSync(NEW_CODES);
    settleSecond(true);
    const cancelled = await second;
    expect(cancelled.cancelled).toBe(true);
    expect(checkOutcomePhrase(cancelled)).toBeNull();
    // …and the walkie's hold is still nobody else's business.
    expect(halves()).toEqual({ advertiser: true, mesh: true });
  });

  it('(6) admission, refusal and a degraded arbiter each leave the two halves AGREEING', async () => {
    // CELL 6. Three roads out of a start, and the invariant is not "the
    // holds are released" — on one of them they must stay. The invariant is
    // that the two halves are never left DISAGREEING, because a phone whose
    // advertiser is suppressed and whose mesh clock is fast is a phone
    // starving the very scan the suppression was bought for.
    //
    // Mutation: return early from abandonFailedStart's road without the
    // shared teardown, or release only one half anywhere. Every road dies.

    // (i) REFUSED START: the native channel will not open.
    mockStartWalkieThrows = new Error('the radio refused the channel');
    await expect(startWalkieSession(POD)).rejects.toThrow(
      'the radio refused the channel',
    );
    await drain();
    expect(halves()).toEqual({ advertiser: false, mesh: false });
    expect(mockAdvHold).toEqual([true, false]);
    mockStartWalkieThrows = null;

    // (ii) ADMITTED, then the ordinary close.
    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: false, mesh: false });

    // (iii) A DEGRADED BLE RESULT: the arbiter answers something this JS
    // cannot read. There is no third road — the event carries the same body
    // the query does — so the hold PARKS with a reason on the record, and it
    // parks on BOTH halves or not at all.
    mockSeam.capability = 'absent';
    mockSeam.stop = { v: 2, outcome: 'unknown', why: 'no-arbiter', state: null };
    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    await stopWalkieSession();
    await drain();
    expect(halves()).toEqual({ advertiser: true, mesh: true });
    expect(walkieHoldReason()).toBe('absent');
  });

  it('(7) nothing is served until THIS session has an installed offer — and the walkie hold does not stop the offer being published', async () => {
    // CELL 7. The serving side, composed with the hold. Two ways to get this
    // wrong and they point in opposite directions: answer a want before the
    // current crew's digest is installed (the confident empty sentence "this
    // phone carries nothing", said to a podmate holding a phone that does),
    // or let the airtime hold suppress the PUBLISH as though it were a dial.
    // The hold parks the dial queue. It has nothing to do with what this
    // phone offers when somebody reads from it.
    //
    // Mutation: serve on any want with `running` true, or gate pushDigest on
    // the airtime hold.
    nativePublish.mockClear();
    mockPublishRejects = true; // this session's offer never lands
    stopMeshSync();
    startMeshSync(CODES);
    await flush();

    await startWalkieSession(POD);
    expect(halves()).toEqual({ advertiser: true, mesh: true });

    aWant();
    mockWant!({ peerId: PEER, payload: 'WANT' });
    await flush();
    expect(nativeProvide).not.toHaveBeenCalled();

    // The offer lands — under the hold, because the hold is about the DIAL
    // QUEUE and not about what this phone serves.
    mockPublishRejects = false;
    mockMessagesChanged!();
    await flush();
    expect(nativePublish).toHaveBeenCalled();

    aWant();
    mockWant!({ peerId: PEER, payload: 'WANT' });
    await flush();
    expect(nativeProvide).toHaveBeenCalledTimes(1);
    // …and the hold is exactly where it was through all of it.
    expect(halves()).toEqual({ advertiser: true, mesh: true });
  });
});

// ---------------------------------------------------------------------------
// M7 — THE PERMISSION AWAIT, THE WALKIE'S HALF.
//
// The mesh lane traced this and handed it to the two files that own the code,
// deliberately shipping no arm (an arm without its fix is a red suite, which
// is not a handoff). share.ts's half lives in mailboxPresence.test.ts; this is
// the walkie's, and it belongs here because the thing that must not happen is
// a COMPOSED effect: everything past that await opens a radio and takes BOTH
// halves of the airtime hold.
//
// NOTHING ELSE CAN CATCH IT. The stop the camper filed while the dialog was up
// is queued BEHIND this start, because the lifecycle queue is held by the very
// operation that is suspended — so it cannot run until the start it was meant
// to cancel has finished arming.
// ---------------------------------------------------------------------------

describe('M7: the gesture is re-read on the far side of the permission dialog', () => {
  it('the camper closed the walkie while the dialog was up: nothing arms, and no hold is taken', async () => {
    // Mutation: delete the stopEpoch re-read after ensureCrewPermissions.
    // The radio opens for a panel that is shut, both halves of the hold go
    // on, and the queued stop then tears down a session that should never
    // have existed — exercising every stale-event fence in walkieSession for
    // no reason at all.
    let open!: () => void;
    mockPermGate = new Promise<void>(r => {
      open = r;
    });
    const starting = startWalkieSession(POD);
    await flush();
    // Suspended inside the ask: no radio, no holds.
    expect(mockWalkieCalls).toEqual([]);
    expect(halves()).toEqual({ advertiser: false, mesh: false });

    // The camper taps the walkie shut. NOT awaited: it is queued behind the
    // start, which is the whole reason the re-read has to exist.
    const stopping = stopWalkieSession();
    open();
    await starting;
    await stopping;
    await drain();

    expect(mockWalkieCalls).toEqual([]);
    expect(mockAdvHold).toEqual([]);
    expect(halves()).toEqual({ advertiser: false, mesh: false });
  });

  it('backgrounded while the dialog was up: same answer', async () => {
    // The other reason the gesture can stop being anybody's intent. Mutation:
    // read only the stop epoch and a grant that arrives after the app is gone
    // still opens the radio and parks the pod's mail clock.
    let open!: () => void;
    mockPermGate = new Promise<void>(r => {
      open = r;
    });
    const starting = startWalkieSession(POD);
    await flush();
    mockAppStateCurrent = 'background';
    open();
    await starting;
    await drain();

    expect(mockWalkieCalls).toEqual([]);
    expect(halves()).toEqual({ advertiser: false, mesh: false });
  });

  it('…and an ordinary grant still opens the channel, so the re-read is a gate and not a wall', async () => {
    // THE NON-VACUITY HALF. iOS reports 'inactive' for the whole life of a
    // permission sheet, so a posture test stricter than 'background' would
    // refuse exactly the grants this road exists to act on — and both arms
    // above would still be green while the walkie never opened for anyone.
    let open!: () => void;
    mockPermGate = new Promise<void>(r => {
      open = r;
    });
    const starting = startWalkieSession(POD);
    await flush();
    mockAppStateCurrent = 'inactive';
    open();
    await starting;
    await drain();

    expect(mockWalkieCalls).toEqual(['startWalkie']);
    expect(halves()).toEqual({ advertiser: true, mesh: true });
  });
});

// ---------------------------------------------------------------------------
// SECTION R — THE RECOVERY TRANSACTION, COMPOSED.
//
// Real share.ts construction and injection -> real CrewSession
// noteRadioState/recoverRadio -> real meshSync awaitMeshDigestReady and its
// ack. Only the native boundary is doubled, and it is doubled so that the
// three legs can be held INDEPENDENTLY: an arm chooses the order and the
// timing of the scan settle, the payload settle and the digest ack, including
// never.
//
// WHY EACH ARM IS HERE RATHER THAN IN A UNIT SUITE: every one of them turns on
// a fact that lives BETWEEN two of the three modules. The floor is meshSync's
// number and the generation is session's; whether they refer to the same
// outage is decided by share.ts's one injected line and by the ORDER the two
// listeners see one native event in. A hand-written barrier agrees with
// whatever the arm that wrote it believed.
// ---------------------------------------------------------------------------

/** One native CrewBeaconState event, delivered to everyone production
 *  subscribed — share.ts's session wire and meshSync's own listener, in the
 *  order they subscribed, which is the order a phone delivers them in. */
const emitRadioState = (s: {
  advertising: boolean;
  scanning: boolean;
  adapterEnabled?: boolean;
  error?: string;
}): void => {
  for (const cb of [...mockRadioStateListeners]) {
    cb(s);
  }
};

/** The adapter died. */
const ADAPTER_OFF = { advertising: false, scanning: false, adapterEnabled: false };
/** …and came back. */
const ADAPTER_ON = { advertising: false, scanning: false, adapterEnabled: true };
/** The OTHER down reason, and the one that withdraws nothing: the adapter is
 *  up and the radio simply refused. */
const RADIO_REFUSED = {
  advertising: false,
  scanning: true,
  error: 'advertise failed: too many advertisers',
};

/** The interruption as the share switch reads it. */
const DOWN = { down: true, why: 'bluetooth-off' };
const REFUSED = { down: true, why: 'advertise-failed' };

/**
 * THE COMPOSED WORLD, built by production: share.ts arms a real CrewSession
 * over the doubled radio, hands it the REAL barrier, and starts the real
 * mesh — which publishes this session's first offer and gets its ack.
 */
const armComposed = async (): Promise<void> => {
  stopMeshSync(); // the bare mesh beforeEach started; share.ts owns it here
  await startMailboxPresence();
  await flush();
};

describe('(R) THE RECOVERY TRANSACTION, COMPOSED: share.ts -> session -> meshSync', () => {
  it('(a) COMPOSED: three legs held apart — the switch stays interrupted until the LAST one settles', async () => {
    // THE HEADLINE COMPOSED CELL. Nothing here is a model of anything: the
    // classification is session.ts's, the withdrawal floor is meshSync's, the
    // barrier that ties them together is the one share.ts actually injected,
    // and the three legs are held at the native calls a phone suspends in.
    //
    // Mutations that die here: the injected line deleted (the session falls
    // back to "no work" and clears on two legs), the digest leg dropped in
    // session.ts, the barrier settling on meshRepublishReady() alone.
    await armComposed();
    expect(radioInterrupted()).toBeNull();
    expect(meshRepublishReady()).toBe(true);

    // ONE EVENT, TWO CONSUMERS. session.ts classifies the outage and mints a
    // generation; meshSync records the revision the withdrawal left behind.
    emitRadioState(ADAPTER_OFF);
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    // …and the LIVE readiness predicate still says yes, about an offer the
    // native side has just dropped. That is the whole reason the barrier
    // captures a floor instead of polling this.
    expect(meshRepublishReady()).toBe(true);

    mockHold.scan = true;
    mockHold.advertise = true;
    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();

    // LEG 1 is on the radio, LEG 3 is in the air, and LEG 2 has not been
    // reached — the two radio legs are sequential because on Android a
    // setPayload into a module that is not advertising is a no-op.
    expect(mockScanGates).toHaveLength(1);
    expect(mockPublishGates).toHaveLength(1);
    expect(mockAdvGates).toHaveLength(0);
    expect(radioInterrupted()).toEqual(DOWN);
    expect(meshRepublishReady()).toBe(false);

    mockScanGates[0].release();
    await flush();
    expect(mockAdvGates).toHaveLength(1);
    expect(radioInterrupted()).toEqual(DOWN);

    mockAdvGates[0].release();
    await flush();
    // BOTH RADIO LEGS ARE BACK. The scan is up, a fresh beacon is on the air,
    // and the phone still says it cannot carry the session — because no peer
    // can read its mailbox yet.
    expect(radioInterrupted()).toEqual(DOWN);
    expect(meshRepublishReady()).toBe(false);

    mockPublishGates[0].release();
    await flush();
    expect(meshRepublishReady()).toBe(true);
    expect(radioInterrupted()).toBeNull();
  });

  it('(b) COMPOSED: the current ack clears exactly once, and a later ack cannot re-clear', async () => {
    // Read through the signal the share switch actually subscribes with. The
    // transaction must render TWICE across a whole bounce — down, then up —
    // and a recovery that reported success on each leg as it landed would be
    // three renders and two lies.
    await armComposed();
    let bumps = 0;
    const off = subscribeSessionChanged(() => {
      bumps += 1;
    });
    try {
      emitRadioState(ADAPTER_OFF);
      await flush();
      expect(bumps).toBe(1);
      expect(radioInterrupted()).toEqual(DOWN);

      mockHold.scan = true;
      mockHold.advertise = true;
      mockHold.publish = true;
      emitRadioState(ADAPTER_ON);
      await flush();
      expect(bumps).toBe(1);

      mockScanGates[0].release();
      await flush();
      mockAdvGates[0].release();
      await flush();
      expect(bumps).toBe(1); // the radio legs render nothing on their own

      mockPublishGates[0].release();
      await flush();
      expect(bumps).toBe(2); // THE ONE CLEAR
      expect(radioInterrupted()).toBeNull();

      // A SECOND ACK, for the same live session: an ordinary store change
      // republishes and the native side acks again. There is nothing left to
      // clear, and the switch does not re-render for it.
      mockHold.publish = false;
      const before = mockPublishes.length;
      mockMessagesChanged!();
      await flush();
      expect(mockPublishes.length).toBeGreaterThan(before);
      expect(bumps).toBe(2);
      expect(radioInterrupted()).toBeNull();
    } finally {
      off();
    }
  });

  it('(c) COMPOSED: the PRE-BOUNCE ack cannot settle a post-bounce recovery', async () => {
    // THE IDENTITY, and the reason the barrier is minted synchronously inside
    // noteRadioState. At the instant the adapter returns, share.ts's listener
    // runs BEFORE meshSync's — so the mesh has not yet counted its republish,
    // and meshRepublishReady() is still answering yes about the offer the
    // adapter withdrew. A barrier that asked only that question settles on the
    // spot, and the two radio legs then clear a phone whose digest
    // characteristic still answers the not-ready frame.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();
    expect(meshRepublishReady()).toBe(true); // the stale yes, in evidence

    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(mockPublishGates).toHaveLength(1);

    // The radio comes all the way back — and the republish this session owes
    // NEVER lands. The only ack this phone has is the pre-bounce one.
    for (let i = 0; i < 4; i += 1) {
      await flush();
    }
    expect(radioInterrupted()).toEqual(DOWN);
    expect(meshRepublishReady()).toBe(false);
  });

  it('(d) COMPOSED: a dead session ack cannot become the live session servable offer', async () => {
    // THE CROSS-EPOCH NUMBER COLLISION, which is precisely the mismatch three
    // separately-green arms are free to disagree about. Revisions are
    // per-mesh-session and reset with it, so a replaced session's rev 2 is
    // numerically indistinguishable from the live session's rev 2 — it clears
    // the live floor and it meets the live target. Only the epoch guard
    // inside the publish road can tell them apart, and no unit suite composes
    // a live session's recovery with a dead session's outstanding ack.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();

    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(mockPublishGates).toHaveLength(1);
    const deadAck = mockPublishGates[0]; // epoch A, rev 2, still in the air
    expect(radioInterrupted()).toEqual(DOWN);

    // THE REPLACEMENT, through production: teardown stops the mesh (new
    // epoch, revisions back to zero) and a fresh mailbox session arms.
    mockHold.publish = false;
    await stopMailboxPresence();
    await startMailboxPresence();
    await flush();
    expect(radioInterrupted()).toBeNull();
    expect(meshRepublishReady()).toBe(true);

    // The LIVE session bounces, and its own republish is refused by native —
    // so its target is rev 2 and its installed revision is still rev 1.
    emitRadioState(ADAPTER_OFF);
    await flush();
    mockPublishRejects = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    mockPublishRejects = false;
    expect(radioInterrupted()).toEqual(DOWN);
    expect(meshRepublishReady()).toBe(false);

    // NOW THE DEAD SESSION'S ACK COMES BACK, carrying a number the live
    // session's floor and target would both accept.
    deadAck.release();
    await flush();
    expect(meshRepublishReady()).toBe(false);
    expect(radioInterrupted()).toEqual(DOWN);
  });

  it('(e) COMPOSED: a stop mid-transaction clears nothing when the ack lands', async () => {
    // The camper put the phone away while the transaction was open. Stopped
    // while interrupted is just stopped — and the ack that arrives afterwards
    // must not raise a ghost, re-render the switch, or resurrect anything.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();

    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    // The two radio legs are already back. Interrupted is still the honest
    // answer, and it is the assertion a two-leg clear dies on.
    expect(radioInterrupted()).toEqual(DOWN);
    const gate = mockPublishGates[0];

    await stopMailboxPresence();
    expect(radioInterrupted()).toBeNull(); // no session, no badge
    const rev = sessionRevision();

    mockHold.publish = false;
    gate.release();
    await flush();
    expect(radioInterrupted()).toBeNull();
    expect(sessionRevision()).toBe(rev); // the late ack rendered nothing
  });

  it('(f) COMPOSED: a replacement mid-transaction cannot clear the session that replaced it', async () => {
    // The dead transaction is honest, current and completely irrelevant —
    // the same shape as cell (3) one seam over. Both fences are live here:
    // the mesh epoch moved under the barrier AND the session identity moved
    // under the clear, which is what a composed arm can say and a unit arm
    // with a hand-written barrier can only assume.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();

    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    const gate = mockPublishGates[0];

    mockHold.publish = false;
    await stopMailboxPresence();
    await startMailboxPresence();
    await flush();

    // The REPLACEMENT is the session the switch renders, and it has an outage
    // of its own.
    emitRadioState(ADAPTER_OFF);
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    const rev = sessionRevision();

    gate.release();
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    expect(sessionRevision()).toBe(rev);
  });

  it('(g) COMPOSED: a SECOND bounce supersedes the first, and only the second full settle clears', async () => {
    // A radio that goes down again UNDER an open transaction. The first
    // transaction's legs describe a world that no longer exists — and the
    // proof that the generation fence is real, rather than the arrival order
    // happening to be kind, is that the first transaction does not even reach
    // its payload leg: it re-asks after the scan and finds itself superseded.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();

    mockHold.scan = true;
    mockHold.advertise = true;
    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(mockScanGates).toHaveLength(1);
    expect(mockPublishGates).toHaveLength(1);

    // THE SECOND OUTAGE, and it lands while all three of the first
    // transaction's legs are still open. New generation, new withdrawal
    // floor, and a second recovery of its own.
    emitRadioState(ADAPTER_OFF);
    await flush();
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(mockScanGates).toHaveLength(2);
    expect(mockPublishGates).toHaveLength(2);

    // The FIRST transaction settles in full, and settles into nothing.
    mockScanGates[0].release();
    await flush();
    expect(mockAdvGates).toHaveLength(0); // superseded before the payload leg
    mockPublishGates[0].release();
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);

    // …and only the SECOND clears, and only once all three of ITS legs are in.
    mockScanGates[1].release();
    await flush();
    expect(mockAdvGates).toHaveLength(1);
    expect(radioInterrupted()).toEqual(DOWN);
    mockAdvGates[0].release();
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    mockPublishGates[1].release();
    await flush();
    expect(radioInterrupted()).toBeNull();
  });

  it('(h) COMPOSED: no mesh, no third leg — the two radio legs are the whole transaction', async () => {
    // THE NON-VACUITY HALF, and the rule it protects: a recovery must never
    // hang on a leg that has no work. A phone whose last pod was disbanded
    // has no digest to publish and nothing to wait for, and an unconditional
    // third leg would leave that camper interrupted for the rest of the
    // evening with no mesh anywhere that could ever un-interrupt them.
    await armComposed();
    emitRadioState(ADAPTER_OFF);
    await flush();
    await stopMeshSync();

    mockHold.scan = true;
    mockHold.advertise = true;
    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(mockPublishGates).toHaveLength(0); // no mesh: nothing republished
    expect(radioInterrupted()).toEqual(DOWN);

    mockScanGates[0].release();
    await flush();
    expect(radioInterrupted()).toEqual(DOWN);
    mockAdvGates[0].release();
    await flush();
    expect(radioInterrupted()).toBeNull();
  });

  it('(i) COMPOSED: advertise-failed — nothing withdrew, so the third leg is a no-op by construction', async () => {
    // THE OTHER NON-VACUITY HALF. Not every recovery has a mesh leg to wait
    // for: an `advertise-failed` outage never told the mesh the adapter was
    // off, so nothing was withdrawn, the floor never rose, and the ack this
    // session already holds is strictly newer than it. The barrier is a GATE,
    // not a wall — it settles at the mint and the two radio legs finish the
    // transaction.
    await armComposed();
    nativePublish.mockClear();

    emitRadioState(RADIO_REFUSED);
    await flush();
    expect(radioInterrupted()).toEqual(REFUSED);
    expect(nativePublish).not.toHaveBeenCalled(); // no withdrawal, no republish

    mockHold.scan = true;
    mockHold.advertise = true;
    mockHold.publish = true;
    emitRadioState(ADAPTER_ON);
    await flush();
    expect(nativePublish).not.toHaveBeenCalled();
    expect(mockPublishGates).toHaveLength(0);
    expect(radioInterrupted()).toEqual(REFUSED);

    mockScanGates[0].release();
    await flush();
    expect(radioInterrupted()).toEqual(REFUSED);
    mockAdvGates[0].release();
    await flush();
    expect(radioInterrupted()).toBeNull();
    expect(meshRepublishReady()).toBe(true);
  });
});
