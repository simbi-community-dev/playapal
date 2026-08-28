/**
 * A READY BLE LINK HAS TO KEEP PROVING IT (rung 3, WalkieBleLink.kt).
 *
 * THE CLASS, named by an adversarial cross-family read (codex, 2026-08-27,
 * on d61fecc) and confirmed against the file: every healing path this rung
 * owns is gated behind one flag that a real failure silently falsifies.
 *
 *   - Voice rides WRITE_NO_RESPONSE, so nothing on the audio path ever
 *     reports a failure and nothing ever comes back. A peer who walked out
 *     of range, or a GATT stack that wedged without delivering its
 *     disconnect, looks EXACTLY like a podmate who is not talking.
 *   - maybeConnect refuses to redial a peer that reads `ready`.
 *   - The scan damper spends every later sighting of that phone's address
 *     on the memo saying it is already reached.
 *   - "Look again" — the camper's own control, tapped precisely because
 *     the channel looks wrong — deliberately left every ready link alone.
 *
 * So the one state where the flag and the world disagree was also the one
 * state nothing in the rung could leave. The channel row stayed on screen,
 * the scan that would find the peer again was suppressed, and the camper's
 * only control could not heal it.
 *
 * THE CURE, pinned here: a ready link re-proves itself on a bounded window
 * with the ident read — the one operation on this link that ANSWERS, and
 * the same read the setup already does, so nothing new goes on the air and
 * a 0.8.6-era peer serves it unchanged. A proof that goes unanswered
 * demotes the link through dropClient, which is what makes the peer
 * re-scannable, re-dialable, and honestly absent from the channel list.
 *
 * WHY INBOUND FRAMES ARE NOT THE PROOF, pinned too: voice is asymmetric on
 * this rung by design — their frames ride THEIR central link to OUR
 * server. Hearing someone proves their pipe to us and says nothing about
 * the pipe our voice leaves on. An asymmetric wedge is exactly the case
 * worth catching, so the proof must travel on the link it vouches for.
 *
 * AND THE CURE'S OWN DEFECT, named by the same reviewer one pass later
 * (2026-08-27, on 5e16122) and cured below: the first watchdog armed its
 * deadline BEFORE the read and let the timeout own every outcome. But
 * `readCharacteristic` returns false when the stack is BUSY — and on this
 * rung the stack is busy exactly when the pair is TALKING, because voice
 * frames are the traffic. A refused read never reaches the air, so no
 * callback can ever clear the flag, and six seconds later the watchdog
 * demoted the healthiest link in the pod: a phone falling off the channel
 * mid-conversation for no reason. The deadline is now armed ONLY by a read
 * the stack ACCEPTED, and only an ACCEPTED read that went unanswered
 * demotes.
 *
 * TWO KINDS OF ASSERTION HERE, and the difference is stated rather than
 * blurred. Neither Kotlin nor Swift runs under jest (no gradle, no Mac —
 * fab and EAS are their compilers), so the SHAPE assertions read the real
 * sources in the walkieCap.test.ts idiom and each names the mutation it
 * dies on. The BEHAVIOURAL half runs a model of the watchdog whose
 * constants AND whose arming rule are both read out of those same sources:
 * the model does not know what the answer should be, it is told how the
 * native file behaves and then asked what happens to a link over ten
 * minutes of talk. Point it at the pre-fix source and the healthy peer
 * dies, which is the whole finding, executable.
 */
export {}; // module scope: walkieIdentProof.test.ts owns these names globally

const readLinkSource = (): string =>
  require('fs').readFileSync(
    'android/app/src/main/java/com/playapal/WalkieBleLink.kt',
    'utf8',
  ) as string;

/** One Kotlin `_`-grouped millisecond constant, as a number. */
const MS = (kt: string, name: string): number => {
  const m = new RegExp(`private const val ${name} = ([0-9_]+)L`).exec(kt);
  expect(m).not.toBeNull();
  return Number(m![1].replace(/_/g, ''));
};

const refusedIndex = (probe: string): number => probe.indexOf('if (!started)');

// --------------------------------------------------- the executable model

/**
 * THE WATCHDOG, AS A STATE MACHINE, so the false-positive direction can be
 * RUN rather than described. Constants and arming rule both come out of the
 * native source; nothing here encodes what the answer ought to be.
 */
type ProbeArming = 'accepted-only' | 'armed-always' | 'no-watchdog';

interface Bounds {
  windowMs: number;
  timeoutMs: number;
  tickMs: number;
  tries: number;
}

/** What the stack did on the tick where a probe was attempted. */
interface StackTick {
  /** Did the stack ACCEPT the read (Android: readCharacteristic returned
   *  true; iOS: the peripheral was connected and the read was issued)? */
  accepts: boolean;
  /** Did the far end's answer come back before the next tick? */
  answers: boolean;
}

const busy = { accepts: false, answers: false };
const talking = { accepts: true, answers: true };
const silent = { accepts: true, answers: false };
const quiet = (n: number): StackTick[] => new Array(n).fill(talking);

/** The tick on which a link born proven first owes a probe — derived, so a
 *  change to the window constants moves the traces with it. */
const firstProbe = (b: Bounds): number => Math.ceil(b.windowMs / b.tickMs) - 1;

/** A trace that is ordinary talk except on the first probe, which is `at`. */
const traceWith = (b: Bounds, at: StackTick, tail: number): StackTick[] => [
  ...quiet(firstProbe(b)),
  at,
  ...quiet(tail),
];

/** Run `trace` through the watchdog and report what became of the link. */
const runWatchdog = (
  trace: StackTick[],
  arming: ProbeArming,
  b: Bounds,
): { ready: boolean; log: string[] } => {
  if (arming === 'no-watchdog') {
    // Nothing ever probes, so nothing is ever demoted — which is precisely
    // the wedged-pipe-forever state defect D names on iOS.
    return { ready: true, log: [] };
  }
  const link = { ready: true, lastProof: 0, pending: false, probeAt: 0, refusals: 0 };
  const log: string[] = [];
  let now = 0;
  for (const step of trace) {
    now += b.tickMs;
    if (!link.ready) {
      break;
    }
    if (link.pending) {
      // Job one: collect on a proof that was never answered.
      if (now - link.probeAt >= b.timeoutMs) {
        link.ready = false;
        log.push('liveness-lost');
      }
      continue;
    }
    if (now - link.lastProof < b.windowMs) {
      continue; // job two: only a link that has gone quiet is asked
    }
    if (arming === 'accepted-only' && !step.accepts) {
      link.refusals += 1;
      log.push('liveness-busy');
      if (link.refusals >= b.tries) {
        link.ready = false;
        log.push('liveness-lost');
      }
      continue;
    }
    // ARMED. The pre-fix rule arms here even when the read was refused and
    // therefore never reached the air — that is the whole defect.
    link.refusals = 0;
    link.probeAt = now;
    link.pending = true;
    if (step.accepts && step.answers) {
      link.pending = false;
      link.lastProof = now;
      log.push('proof');
    }
  }
  return { ready: link.ready, log };
};

/** How the real Kotlin arms its deadline — read, never assumed. */
const androidArming = (kt: string): ProbeArming => {
  const probe = /private fun probeLiveness\(peer: VoicePeer\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
  if (!probe) {
    return 'no-watchdog';
  }
  const refused = refusedIndex(probe);
  const arm = probe.indexOf('peer.probePending = true');
  return refused > -1 && arm > refused ? 'accepted-only' : 'armed-always';
};

const androidBounds = (kt: string): Bounds => ({
  windowMs: MS(kt, 'LIVENESS_WINDOW_MS'),
  timeoutMs: MS(kt, 'LIVENESS_PROBE_TIMEOUT_MS'),
  tickMs: MS(kt, 'LIVENESS_TICK_MS'),
  tries: Number(/private const val LIVENESS_PROBE_TRIES = (\d+)/.exec(kt)?.[1] ?? 0),
});

describe('a ready link is asked to prove it, on a bounded window', () => {
  const kt = readLinkSource();

  test('the three bounds exist and compose into one honest sentence', () => {
    // Mutation: raise the window past the redial arc, or drop the timeout
    // below a GATT round trip, and the watchdog either never collects or
    // demotes healthy links. The ORDER is the invariant worth pinning: a
    // probe must be allowed less time than the window it renews, and the
    // tick must be finer than the timeout or a probe is judged a tick late.
    const win = /private const val LIVENESS_WINDOW_MS = (\d+)_(\d+)L/.exec(kt);
    const timeout = /private const val LIVENESS_PROBE_TIMEOUT_MS = (\d+)_(\d+)L/.exec(kt);
    const tick = /private const val LIVENESS_TICK_MS = (\d+)_(\d+)L/.exec(kt);
    expect(win).not.toBeNull();
    expect(timeout).not.toBeNull();
    expect(tick).not.toBeNull();
    const ms = (m: RegExpExecArray | null) => Number(`${m![1]}${m![2]}`);
    expect(ms(timeout)).toBeLessThan(ms(win));
    expect(ms(tick)).toBeLessThan(ms(timeout));
    // …and the window has to be shorter than a camper's patience with a
    // dead channel, not merely finite.
    expect(ms(win)).toBeLessThanOrEqual(30_000);
  });

  test('the watchdog runs for the life of the rung and survives its own throws', () => {
    // Mutation: reschedule INSIDE the try. One transient framework
    // exception then retires the only thing in this class that can demote
    // a dead link, and the rung is back to the pre-fix behaviour with a
    // watchdog in the source to reassure the next reader.
    expect(kt).toMatch(/private val liveness = object : Runnable \{/);
    expect(kt).toMatch(
      /\} catch \(_: Exception\) \{\n\s*\/\/ A peer map that threw mid-walk costs this tick, never the next\.\n\s*\}\n\s*handler\.postDelayed\(this, LIVENESS_TICK_MS\)/,
    );
    // Mutation: arm it somewhere the adapter's OFF->ON arc runs twice
    // without the remove, and two watchdogs tick against one peer map.
    expect(kt).toMatch(
      /handler\.removeCallbacks\(liveness\)\n\s*handler\.postDelayed\(liveness, LIVENESS_TICK_MS\)/,
    );
  });

  test('an unanswered proof DEMOTES the link, it does not just log it', () => {
    // THE LOAD-BEARING ONE. Mutation: log `voice//liveness-lost` and leave
    // `ready` alone. Every symptom stays: the row still claims a channel,
    // maybeConnect still refuses, the damper still suppresses, and the
    // only thing that changed is that logcat now describes the bug.
    // dropClient specifically — it closes the gatt, clears the flag, fires
    // onPeerLost, and resets the backoff, which together are what make the
    // next sighting a real redial.
    const body = /private val liveness = object : Runnable \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(body).toBeDefined();
    expect(body).toMatch(/if \(now - p\.probeAt >= LIVENESS_PROBE_TIMEOUT_MS\) \{/);
    expect(body).toMatch(/dropClient\(p\)/);
    expect(body).toMatch(/\} else if \(now - p\.lastProof >= LIVENESS_WINDOW_MS\) \{\n\s*probeLiveness\(p\)/);
  });

  test('the proof rides the ident read — nothing new goes on the air', () => {
    // WIRE COMPATIBILITY IS THE POINT. Mutation: mint a keepalive
    // characteristic (or a keepalive frame) and every 0.8.6-era peer in
    // the pod fails the probe and is demoted forever — a liveness guard
    // that kills exactly the links it was built to protect.
    expect(kt).toMatch(/private fun probeLiveness\(peer: VoicePeer\) \{/);
    expect(kt).toMatch(/getService\(SERVICE_UUID\)\?\.getCharacteristic\(IDENT_CHAR\)/);
    expect(kt).toMatch(/g\.readCharacteristic\(ident\)/);
    // Exactly three UUIDs in this rung: the service and its two
    // characteristics. A fourth is a new wire.
    expect((kt.match(/UUID\.fromString\(/g) ?? []).length).toBe(3);
  });

  test('only a read the stack ACCEPTED arms the deadline', () => {
    // THE FALSE-POSITIVE ONE, and the reason this test replaced its own
    // opposite. Mutation: restore `probePending = true` above the call and
    // let the timeout own every outcome. `readCharacteristic` returns
    // false for a BUSY stack — which on this rung means a link with voice
    // on it — and a read that never went out has nobody to answer it, so
    // the flag never clears and the watchdog demotes the one link in the
    // pod that is carrying a conversation. The read must be ISSUED before
    // a deadline exists.
    const probe = /private fun probeLiveness\(peer: VoicePeer\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(probe).toBeDefined();
    const read = probe!.indexOf('g.readCharacteristic(ident)');
    const refused = probe!.indexOf('if (!started)');
    const arm = probe!.indexOf('peer.probePending = true');
    expect(read).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(read);
    expect(arm).toBeGreaterThan(refused);
  });

  test('a refusal costs a turn, and only a run of them costs the link', () => {
    // Mutation: drop the counter and a genuinely wedged stack — one that
    // will not even ACCEPT a read — never demotes anyone, which is the
    // original bug back through the door the cure opened. Mutation: demote
    // on the FIRST refusal and we are back to killing talking links.
    const probe = /private fun probeLiveness\(peer: VoicePeer\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(probe).toMatch(/peer\.probeRefusals \+= 1/);
    expect(probe).toMatch(/if \(peer\.probeRefusals >= LIVENESS_PROBE_TRIES\) \{/);
    expect(probe).toMatch(/dropClient\(peer\)/);
    // …and the run has to outlast the accepted-read deadline, or a refusal
    // is a HARSHER verdict than silence on a read that actually went out.
    const tries = Number(/private const val LIVENESS_PROBE_TRIES = (\d+)/.exec(kt)?.[1]);
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(tries * MS(kt, 'LIVENESS_TICK_MS')).toBeGreaterThan(MS(kt, 'LIVENESS_PROBE_TIMEOUT_MS'));
    // The budget is per LINK: dropClient resets it with the rest of the
    // link's slate.
    const drop = /private fun dropClient\(peer: VoicePeer\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(drop).toMatch(/peer\.probeRefusals = 0/);
    // An accepted read clears the run — the counter counts CONSECUTIVE
    // refusals, not refusals since the link was born.
    const clear = probe!.indexOf('peer.probeRefusals = 0');
    expect(clear).toBeGreaterThan(refusedIndex(probe!));
  });
});

describe('the answer is stamped, and only a VALID answer is', () => {
  const kt = readLinkSource();

  test('a ready peer no longer discards its own liveness callback', () => {
    // Mutation: restore `if (stopped || peer.ready) { return@post }`. The
    // probe then goes out, the answer comes back, and handleIdent throws
    // it away — probePending never clears, and the watchdog demotes a
    // perfectly healthy link on its next tick. A guard that kills what it
    // guards is worse than no guard.
    expect(kt).not.toMatch(/if \(stopped \|\| peer\.ready\) \{/);
    expect(kt).toMatch(
      /if \(peer\.ready\) \{[\s\S]*?peer\.probePending = false\n\s*peer\.lastProof = SystemClock\.elapsedRealtime\(\)\n\s*return@post/,
    );
  });

  test('the stamp sits BELOW the pod and identity gate', () => {
    // Mutation: stamp at the top of handleIdent. A stranger's answer, a
    // wrong-pod answer, or another phone that picked up the rotated
    // address then renews a link to somebody who is not there — the memo
    // bug of 0567328 reborn one field over.
    const reject = kt.indexOf('voice//ident-reject');
    const stamp = kt.indexOf('peer.lastProof = SystemClock.elapsedRealtime()');
    expect(reject).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(reject);
  });

  test('a link is born proven, and a dropped link owes nothing', () => {
    // Mutation: leave lastProof at 0 when the peer goes ready and every
    // new link is instantly overdue — the watchdog probes at setup, on
    // every peer, forever. Mutation: skip the clear in dropClient and a
    // redialled peer inherits the dead one's pending probe.
    expect((kt.match(/peer\.lastProof = SystemClock\.elapsedRealtime\(\)/g) ?? []).length).toBe(2);
    expect((kt.match(/peer\.probePending = false/g) ?? []).length).toBe(3);
    const drop = /private fun dropClient\(peer: VoicePeer\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(drop).toMatch(/peer\.probePending = false/);
  });
});

describe('"Look again" reaches the links it used to spare', () => {
  const kt = readLinkSource();
  const refresh = / {2}fun refresh\(\) \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];

  test('the camper control re-probes a ready link instead of stepping over it', () => {
    // THE CAMPER-FACING ONE. Mutation: restore `if (!p.ready &&
    // !p.connecting)` as the only branch. The tap then restarts a scan
    // whose every sighting of this peer is suppressed by the very flag the
    // camper is complaining about, and the control is decorative in the
    // exact case it exists for.
    expect(refresh).toBeDefined();
    expect(refresh).toMatch(/if \(p\.ready\) \{/);
    expect(refresh).toMatch(/probeLiveness\(p\)/);
    // The not-connected half of the old loop must survive intact: a "look
    // again" that no longer forgives the 30 s backoff is a control that
    // lies about being immediate.
    expect(refresh).toMatch(
      /\} else if \(!p\.connecting\) \{\n\s*p\.backoffMs = CONNECT_BACKOFF_BASE_MS\n\s*p\.lastAttempt = 0L/,
    );
  });

  test('a tap that finds an already-overdue probe collects on it', () => {
    // Mutation: only ever probe. A camper tapping twice inside one timeout
    // window then re-arms nothing and waits for the watchdog anyway —
    // which is fine, but the control should be able to CLOSE a link that
    // has already failed to answer, since that is the whole request.
    expect(refresh).toMatch(/via=look-again/);
    expect(refresh).toMatch(/dropClient\(p\)/);
  });
});

describe('BEHAVIOUR — ten minutes of talk, run against the real constants', () => {
  const kt = readLinkSource();
  const arming = androidArming(kt);
  const bounds = androidBounds(kt);

  test('the Kotlin arms its deadline only on an accepted read', () => {
    // The model below is only worth running because this is where its rule
    // comes from. Mutation: any edit that puts `probePending = true` back
    // above the refusal check flips this to 'armed-always', and every
    // behavioural test under it fails — which is the pre-fix file, judged.
    expect(arming).toBe('accepted-only');
  });

  test('a peer that answers every probe is NEVER demoted', () => {
    // The floor. A healthy ten-minute conversation logs zero
    // liveness-lost, on any arming rule; if this ever fails the watchdog
    // is broken in a way no amount of arming discipline can save.
    const ticks = Math.ceil((10 * 60_000) / bounds.tickMs);
    const run = runWatchdog(quiet(ticks), arming, bounds);
    expect(run.ready).toBe(true);
    expect(run.log).not.toContain('liveness-lost');
    expect(run.log).toContain('proof');
  });

  test('a BUSY stack costs a turn, not the conversation', () => {
    // DEFECT B, EXECUTABLE. Ten minutes of talk on a stack that refuses
    // every other probe because voice frames are already in flight —
    // exactly what a live conversation looks like from readCharacteristic.
    // Under the cured rule the link survives every one of them; under the
    // rule this commit replaced, the healthy peer is dropped.
    const ticks = Math.ceil((10 * 60_000) / bounds.tickMs);
    const flaky: StackTick[] = new Array(ticks)
      .fill(null)
      .map((_, i) => (i % 2 === 0 ? busy : talking));
    expect(runWatchdog(flaky, arming, bounds).ready).toBe(true);
    // …and the same trace against the pre-fix rule, so the trace is proved
    // to DISCRIMINATE rather than to be trivially survivable.
    const before = runWatchdog(flaky, 'armed-always', bounds);
    expect(before.ready).toBe(false);
    expect(before.log).toContain('liveness-lost');
  });

  test('a refused read followed by an accepted one survives the deadline', () => {
    // The reviewer's named arm, first half: one refusal, then a retry the
    // stack takes and the peer answers. The link never had a deadline to
    // miss.
    const trace = traceWith(bounds, busy, 9);
    const run = runWatchdog(trace, arming, bounds);
    expect(run.ready).toBe(true);
    expect(run.log).toContain('liveness-busy');
    expect(run.log).not.toContain('liveness-lost');
  });

  test('an ACCEPTED read with no answer still demotes', () => {
    // The reviewer's named arm, second half — and the guard against curing
    // defect B by simply never demoting anyone. The read went out; silence
    // after that is the wedge this whole watchdog exists to catch.
    const trace = traceWith(bounds, silent, 9);
    const run = runWatchdog(trace, arming, bounds);
    expect(run.ready).toBe(false);
    expect(run.log).toContain('liveness-lost');
  });

  test('a stack that will not accept ANY read still loses the link', () => {
    // The other direction of the same cure: "busy" must stay bounded, or a
    // wedged stack is immortal and 5e16122 was undone.
    const wedged = [...quiet(firstProbe(bounds)), ...new Array(30).fill(busy)];
    const run = runWatchdog(wedged, arming, bounds);
    expect(run.ready).toBe(false);
    expect(run.log).toContain('liveness-lost');
    // And it must take LONGER than an accepted read's deadline: a refusal
    // is weaker evidence than silence on a read that actually went out.
    const refusalTicks = run.log.filter((l) => l === 'liveness-busy').length;
    expect(refusalTicks * bounds.tickMs).toBeGreaterThan(bounds.timeoutMs);
  });
});

// ------------------------------------------------------------------ iOS

/**
 * THE iPHONE'S OWNERSHIP SUBSTRATE — the thing four reverted rounds were
 * missing, pinned before anything is built on it.
 *
 * THE HISTORY, because it is the spec. b7b5389 mirrored the Android
 * watchdog above onto WalkieBleVoice.swift. The cross-family binding
 * reviewer then found one class, three times running, each time one layer
 * down: "callbacks are identifier-only … Retired link A can timeout/drop;
 * reconnect B reuses the same identifier; late A IDENT success can
 * clear/stamp or even promote B, while late A error/disconnect can kill B.
 * Queue serialization orders events but cannot identify their generation."
 * Then the discoveries, left qualified by a LIVE field: "Object identity +
 * live state is not callback provenance on a reused CBPeripheral." Then
 * the verdict on the whole shape: "do not add another mutable peer slot:
 * the callback API supplies no immutable operation token."
 *
 * 0628ea9 took the watchdog back out and banked the safe shape. This is
 * that shape, and the ruling it is built to, verbatim:
 *
 *   "use a per-dial-generation BleLinkGeneration owning a FRESH dedicated
 *   CBCentralManager, manager delegate, manager-produced CBPeripheral,
 *   peripheral delegate, services/chars/timers/ops. Shared manager scans
 *   only and passes UUID/advertisement facts — not its CBPeripheral
 *   object. Durable peer owns only backoff/current LinkID, never
 *   callbacks/handles/op state. Keep a process-lifetime weak-object
 *   quarantine above WalkieBleVoice: if a fresh manager returns the exact
 *   object of any still-live retired tombstone for that UUID, fail closed
 *   — do not re-delegate/connect; retry only after object death or adapter
 *   epoch. Retiring is monotonic and precedes cancel; old callbacks reach
 *   only retired owner. Multiple managers have no restoration IDs.
 *   didModifyServices retires whole generation. Adapter off/stop retire
 *   all; tombstones survive immediate restart."
 *
 * A PER-LINK DELEGATE ON A SHARED MANAGER IS NOT THIS, and an earlier
 * attempt at exactly that is parked at scrap/per-link-delegate. It left
 * didConnect / didFailToConnect / didDisconnectPeripheral arriving at one
 * shared manager and fenced them with a timed quarantine — a disconnect
 * barrier and a fixed delay, both of which the ruling above refuses by
 * name. Here those three callbacks arrive at the GENERATION'S OWN manager,
 * so there is no shared family left to fence.
 *
 * TWO KINDS OF ASSERTION, as everywhere in this suite. The SHAPE half
 * reads the real Swift in walkieCap's idiom (EAS is this project's only
 * Swift compiler) and each assertion names the mutation it dies on. The
 * BEHAVIOURAL half runs a model that reads WHICH OBJECT each handler is
 * installed on and WHAT ITS FIRST QUESTION ESTABLISHES — never an ideal
 * callback-carries-its-generation API, because none exists and assuming
 * one is how this gets declared fixed twice — and then delivers the
 * reviewer's own scenarios. Point every one of them at 0628ea9's flat
 * single-delegate file and they are all admitted, which is the finding,
 * executable.
 */

const readVoiceSource = (): string =>
  require('fs').readFileSync('ios/PlayaPal/WalkieBleVoice.swift', 'utf8') as string;

/** Who owns a link's callbacks. */
type Ownership = 'per-generation' | 'flat' | 'absent';

const ownership = (sw: string): Ownership => {
  const minted =
    /final class BleLinkGeneration: NSObject \{/.test(sw) &&
    /extension BleLinkGeneration: CBCentralManagerDelegate \{/.test(sw) &&
    /extension BleLinkGeneration: CBPeripheralDelegate \{/.test(sw) &&
    /manager = CBCentralManager\(delegate: self, queue: queue\)/.test(sw);
  if (minted) {
    return 'per-generation';
  }
  return /extension WalkieBleVoice: CBPeripheralDelegate \{/.test(sw) ? 'flat' : 'absent';
};

/**
 * Every callback family a link can produce, by the signature fragment that
 * is identical in both file shapes — so one reader works on the cured file
 * and on the one it replaces.
 */
const IOS_HANDLERS: Record<string, string> = {
  'ident-read': 'didUpdateValueFor characteristic: CBCharacteristic, error: Error?',
  'discover-services': 'didDiscoverServices error: Error?',
  'discover-chars': 'didDiscoverCharacteristicsFor service: CBService, error: Error?',
  'services-modified': 'didModifyServices invalidatedServices: [CBService]',
  connected: 'didConnect peripheral: CBPeripheral)',
  'connect-failed': 'didFailToConnect peripheral: CBPeripheral, error: Error?',
  disconnected: 'didDisconnectPeripheral peripheral: CBPeripheral, error: Error?',
  'ident-write': 'didWriteValueFor characteristic: CBCharacteristic, error: Error?',
};

const handlerBody = (sw: string, name: string): string => {
  const at = sw.indexOf(IOS_HANDLERS[name]);
  if (at < 0) {
    return '';
  }
  const end = sw.indexOf('\n  }\n', at);
  return end < 0 ? sw.slice(at) : sw.slice(at, end + 4);
};

/** The first thing a body actually asks, comments and signature skipped. */
const firstAsk = (body: string): string => {
  const open = body.indexOf('{');
  if (open < 0) {
    return '';
  }
  const lines = body
    .slice(open + 1)
    .split('\n')
    .map((l) => l.trim())
    // Comments, blanks, and a closure's own capture line — `[weak self] in`
    // is not a question, and a deferred body's first QUESTION is what this
    // reads.
    .filter((l) => l !== '' && !l.startsWith('//') && !/^\[[^\]]*\][^{}]*\bin$/.test(l));
  return lines[0] ?? '';
};

/**
 * WHAT A FIRST QUESTION ESTABLISHES — the model's one judgement, and it is
 * the reviewer's, not this file's.
 *
 *   'own-retirement' — the object being asked IS the link, and it knows it
 *     has been retired. Nothing else is needed and nothing else is read.
 *   'live-slot' — the handler asks a MUTABLE FIELD on the shared peer
 *     entry: an attempt epoch, a `connecting` flag, or a peripheral-to-peer
 *     lookup by identifier. Ruled not provenance, verbatim: "Object
 *     identity + live state is not callback provenance on a reused
 *     CBPeripheral." Three reverted rounds are this row.
 *   'none' — it asks nothing that could tell generations apart.
 */
type Provenance = 'own-retirement' | 'live-slot' | 'none';

const provenanceOf = (ask: string): Provenance => {
  if (/^guard\s+(let self, )?!(self\.)?retired\b/.test(ask) || /!(self\.)?retired,/.test(ask)) {
    return 'own-retirement';
  }
  if (/peerFor\(|peer\.attempt|peer\.connecting|\.identifier ==/.test(ask)) {
    return 'live-slot';
  }
  return 'none';
};

/** A late completion, as CoreBluetooth delivers one. */
interface LateCb {
  family: string;
  toRetiredLink: boolean;
}

/** Does this callback get to MUTATE anything a live link owns? */
const admits = (sw: string, cb: LateCb): boolean => {
  if (ownership(sw) !== 'per-generation') {
    return true; // one shared handler: nothing in the callback distinguishes
  }
  const body = handlerBody(sw, cb.family);
  if (body === '') {
    return true; // a family nobody implements is a family nobody fences
  }
  if (provenanceOf(firstAsk(body)) !== 'own-retirement') {
    return true;
  }
  return !cb.toRetiredLink;
};

/** The setup timer — deferred work is a callback family too. */
const timerAsk = (sw: string): string => {
  const at = sw.indexOf('WalkieBleVoice.setupTimeout) { [weak');
  const flat = sw.indexOf('Self.setupTimeout) { [weak');
  const from = at > -1 ? at : flat;
  if (from < 0) {
    return '';
  }
  return firstAsk(sw.slice(from));
};

const timerAdmits = (sw: string, toRetiredLink: boolean): boolean =>
  provenanceOf(timerAsk(sw)) === 'own-retirement' ? !toRetiredLink : true;

/** The writer the module is handed when a peer goes ready, and holds. */
const senderBody = (sw: string): string => {
  const at = sw.indexOf('onPeer(peer.key, peer.name, peer.hash)');
  if (at < 0) {
    return '';
  }
  const end = sw.indexOf('\n    }\n', at);
  return end < 0 ? sw.slice(at) : sw.slice(at, end + 6);
};

const writeBody = (sw: string): string =>
  /func write\(_ frame: Data\) \{[\s\S]*?\n {2}\}\n/.exec(sw)?.[0] ?? '';

/**
 * Does the writer reach through the GENERATION (which can answer for
 * itself) or through the durable PEER (which outlives its links, and whose
 * fields a dead generation left behind)?
 */
const senderAdmits = (sw: string, toRetiredLink: boolean): boolean => {
  const body = senderBody(sw);
  const throughGeneration = /\[weak gen\]/.test(body) && /gen\?\.write\(frame\)/.test(body);
  if (!throughGeneration) {
    return true;
  }
  return /!self\.retired/.test(writeBody(sw)) ? !toRetiredLink : true;
};

// ------------------------------------------------- the object quarantine

const bodyOf = (sw: string, marker: string, close = '\n  }\n'): string => {
  const at = sw.indexOf(marker);
  if (at < 0) {
    return '';
  }
  const end = sw.indexOf(close, at);
  return end < 0 ? sw.slice(at) : sw.slice(at, end + close.length);
};

/**
 * A body with its prose taken out, for the reads that are about what the
 * code DOES rather than what it says: a comment naming the state it
 * refuses must not read as the file accepting it.
 */
const codeOnly = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/**
 * A BRACE-MATCHED body — signature to the `}` that closes it.
 *
 * `bodyOf` above stops at the first line that is exactly a two-space `}`,
 * which is right for a flat method and wrong the instant one grows a
 * nested closure or a second declaration follows it. It is also SILENT
 * about being wrong: a truncated read is just a shorter string, and a
 * MISSED marker is the empty one — on which every `toContain` below
 * happily passes. That is a suite that stopped reading reporting as a file
 * that is fine, and it is exactly what happened to walkieLiveness's
 * `private func stopInternal()` anchor when the signature grew its proof
 * completion (310 pass / 1 fail on 2edcc6a, for a reason that had nothing
 * to do with the code).
 *
 * So: count braces, and every caller asserts the result is NON-EMPTY.
 */
const bracedBody = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  if (at < 0) {
    return '';
  }
  const open = src.indexOf('{', at);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  return '';
};

/**
 * THE QUARANTINE'S OWN BODY, and the reason this exists is the same one
 * `bracedBody` exists for. `singleLock` below used to count
 * `private let lock = NSLock()` ACROSS THE WHOLE FILE, which read as "the
 * register takes one lock" only for as long as the file held exactly one
 * register. It holds two now — the object quarantine and the advertiser
 * debt book, independent registers with independent locks, which is the
 * design and not a regression — so the count is scoped to the class the
 * claim is about.
 */
const quarantineClassBody = (sw: string): string =>
  bracedBody(sw, 'final class BleObjectQuarantine {');

const attachBody = (sw: string): string => bodyOf(sw, 'private func attach() {');
const retireBody = (sw: string): string => bodyOf(sw, 'func retire(_ why: String) {');
const dialBody = (sw: string): string =>
  bodyOf(sw, 'private func maybeConnect(_ hash: UInt32, _ id: UUID) {');
/**
 * The coordinator's close. The marker is the OPEN PAREN and not `()`
 * because stop() now carries the advertiser's proof completion (see the
 * advertiser-effect block at the foot of this file) — a reader anchored on
 * the old arity returns '' against the cured file, and every `toContain`
 * below it then passes on an empty string, which is a suite that stopped
 * reading rather than a file that changed.
 */
const stopBody = (sw: string): string => bracedBody(sw, 'func stop(_ proven:');
/**
 * THE REGISTER'S OTHER SPELLING, and the reader knows it on purpose. This
 * is e13c03f's tombstone-only door — the shape the binding review refused
 * — and the model can read it so that planting it back produces an EXACT
 * signature: the tombstone arms still pass, the ownership arms all fail.
 * A reader that could only see the cure would report the plant as "no
 * fence at all", which is a false statement about a file that does fence
 * the retire-then-dial ordering.
 */
const aliasesBody = (sw: string): string =>
  bodyOf(sw, 'func aliases(_ candidate: CBPeripheral, id: UUID) -> Bool {', '\n  }\n');

const claimBody = (sw: string): string =>
  bodyOf(
    sw,
    'func claim(_ candidate: CBPeripheral, id: UUID, label: String) -> Claim {',
    '\n  }\n',
  );
/**
 * THE ONE-STEP RETIREMENT, 9717080's spelling — ownership decided
 * atomically and the cancel then fired outside the lock. Read here for the
 * same reason `aliasesBody` is: a plant that restores it must produce an
 * EXACT signature (the ordinary arms still pass, the two window arms fail
 * with a casualty) rather than reading as "no ownership at all".
 */
const qRetireBody = (sw: string): string =>
  bodyOf(
    sw,
    'func retire(_ peripheral: CBPeripheral, claim ticket: UInt64, id: UUID) -> Retirement {',
    '\n  }\n',
  );

/** STEP ONE: reserve the exact object for the retiring ticket. */
const qBeginBody = (sw: string): string =>
  bodyOf(
    sw,
    'func beginRetire(_ peripheral: CBPeripheral, claim ticket: UInt64, id: UUID) -> Lease {',
    '\n  }\n',
  );
/** STEP THREE: spend the lease, and only the leaseholder may. */
const qFinalizeBody = (sw: string): string =>
  bodyOf(
    sw,
    'func finalizeRetire(_ peripheral: CBPeripheral, claim ticket: UInt64, id: UUID) -> Finalization {',
    '\n  }\n',
  );
const qResetBody = (sw: string): string => bodyOf(sw, 'func adapterReset() {');

/**
 * THE GENERATION'S HALF OF THE LEASE, which is where the whole of this
 * round lives: the register's three doors did not move, but the moment the
 * third one is CALLED did. `spendLease` is now the only caller of
 * `finalizeRetire`, and it is reached from a proven terminal rather than
 * from the statement after the issue.
 */
const genSpendBody = (sw: string): string => bodyOf(sw, '  private func spendLease(');
/** T1's router: the exact reserved object, on this generation's manager. */
const genTerminalBody = (sw: string): string => bodyOf(sw, '  private func noteLeaseTerminal(');
/** T3's router: an observed poweredOff, and no weaker adapter fact. */
const genPowerOffBody = (sw: string): string => bodyOf(sw, '  private func noteLeasePowerOff(');
/** T4: the bounded recheck / re-cancel / poison. */
const genRecheckBody = (sw: string): string => bodyOf(sw, '  private func leaseRecheck() {');
/**
 * The GENERATION'S state callback — the file has two of this name and the
 * coordinator's is the other one, so the read is anchored to the
 * generation's own extension.
 */
const genStateBody = (sw: string): string => {
  const ext = sw.indexOf('extension BleLinkGeneration: CBCentralManagerDelegate {');
  return ext < 0
    ? ''
    : bodyOf(sw.slice(ext), 'func centralManagerDidUpdateState(_ central: CBCentralManager) {');
};
/** The visibility filter every door reads the register through. */
const qLiveBody = (sw: string): string =>
  bodyOf(sw, 'private func liveLocked(_ id: UUID) -> [Record] {');

/**
 * LOCK DISCIPLINE, read rather than assumed: a register mutated outside
 * the lock is a register whose answer is a guess, and a claim door that
 * READS then INSERTS across a lock gap grants the same object twice —
 * which is the defect with an extra step, not a cure.
 */
const locksTheRegister = (body: string): boolean => {
  if (body === '') {
    return false;
  }
  const lock = body.indexOf('lock.lock()');
  const unlock = body.indexOf('defer { lock.unlock() }');
  // The register is reached directly or through the locked-context helper
  // that sweeps it; either way it must be reached AFTER the lock is taken.
  const reads = ['records', 'liveLocked('].map((t) => body.indexOf(t)).filter((i) => i > -1);
  const touch = reads.length === 0 ? -1 : Math.min(...reads);
  return lock > -1 && unlock > lock && touch > unlock;
};

/**
 * THE QUARANTINE, as the model can see it — every field read out of the
 * Swift, none of it assumed. The shape being read is an OWNERSHIP register
 * with THREE states per weak-boxed object: CLAIMED by a live generation,
 * RETIRING (reserved by a teardown whose cancel has not been issued yet),
 * or TOMBSTONED by the generation that retired off it.
 */
interface Quarantine {
  present: boolean;
  /** Ownership is DECIDED before the delegate seat and before connect. */
  checkedBeforeBinding: boolean;
  /** An attach RECORDS its claim; the register is not a list of the dead. */
  recordsClaims: boolean;
  /** A live generation's claim refuses a second generation. */
  refusesActiveClaim: boolean;
  /** …and so does a tombstone whose object has not died yet. */
  refusesLiveTombstone: boolean;
  /** Claim, reservation and finalization are the same lock. */
  singleLock: boolean;
  /** A retirement may transition only the claim it holds. */
  retiresOwnClaimOnly: boolean;
  /** A superseded retirement touches neither delegate nor connection. */
  supersededIsNoOp: boolean;
  /** The ownership transition happens BEFORE the cancel. */
  ownershipBeforeCancel: boolean;
  /** RETIREMENT IS A LEASE: reserve, then cancel, then finalize. */
  leasedRetire: boolean;
  /** A reserved object refuses a claim exactly as a live one does. */
  refusesRetiringLease: boolean;
  /** The cancel runs INSIDE the lease — the finalize follows it. */
  finalizeAfterCancel: boolean;
  /** An adapter reset may not release an object with a cancel in flight. */
  resetPreservesLease: boolean;
  /** Only the leasing ticket may spend the lease. */
  finalizedByLeaseholderOnly: boolean;
  /** A retirement that could reserve NOTHING cancels nothing. */
  unleasedIsNoOp: boolean;
  /**
   * THE LEASE OUTLIVES THE CANCEL IT ISSUED. `cancelPeripheralConnection`
   * is nonblocking: it books a teardown the stack performs later, so a
   * finalize on the next statement releases the object while the effect is
   * still owed. The lease is spent by a proven TERMINAL instead.
   */
  leaseHeldThroughTerminal: boolean;
  /** T1: didDisconnect for the EXACT object, on the generation's OWN manager. */
  terminalIsExactObjectOnOwnManager: boolean;
  /** …which it can only be if the generation kept manager, seat and self. */
  keepsManagerThroughLease: boolean;
  /** T2: the synchronous fast path is `.disconnected` and nothing weaker. */
  fastPathOnlyDisconnected: boolean;
  /** T3: an observed poweredOff on that manager — no other adapter fact. */
  powerOffIsTheOnlyStateTerminal: boolean;
  /** T4: a bounded recheck/re-cancel on the generation's own queue, then poison. */
  boundedRecheckThenPoison: boolean;
  /** How many looks T4 gets before the record is poisoned. */
  recheckBudget: number;
  /** A poison is freed by object death or a proven T3 — never by an epoch. */
  poisonHoldsThroughEpoch: boolean;
  /** A late duplicate terminal is a no-op, never a second transition. */
  terminalIsTicketIdempotent: boolean;
  /** Weak, so the object's death is a release rather than a wedge. */
  releasedByObjectDeath: boolean;
  /** An adapter cycle invalidates every object the stack ever vended. */
  releasedByAdapterEpoch: boolean;
  /** A stop()/start() must NOT wipe it. */
  clearedByStop: boolean;
}

const quarantineOf = (sw: string): Quarantine => {
  const attach = attachBody(sw);
  const claimed = attach.indexOf('BleObjectQuarantine.shared.claim(');
  // Whichever door this file has, the fence is where attach consults it.
  const decide = claimed > -1 ? claimed : attach.indexOf('BleObjectQuarantine.shared.aliases(');
  const seat = attach.indexOf('per.delegate = self');
  const dial = attach.indexOf('mgr.connect(per');
  const claim = claimBody(sw);
  const legacy = aliasesBody(sw);
  const qRetire = qRetireBody(sw);
  const qBegin = qBeginBody(sw);
  const qFinal = qFinalizeBody(sw);
  const reset = qResetBody(sw);
  const drop = retireBody(sw);
  const cancel = drop.indexOf('manager?.cancelPeripheralConnection(per)');
  const begin = drop.indexOf('BleObjectQuarantine.shared.beginRetire(per, claim: ticket, id: peripheralId)');
  // WHERE THE LEASE IS SPENT, in whichever of the two places this file
  // spends it. In retire() it is the statement after the issue — 15db991's
  // shape, and the one the substrate finding is about. In `spendLease` it
  // is reached from a proven terminal, which is arbitrarily far after the
  // cancel and is read as such.
  const spend = genSpendBody(sw);
  const finalizeInRetire = drop.indexOf(
    'BleObjectQuarantine.shared.finalizeRetire(per, claim: ticket, id: peripheralId)',
  );
  const finalizeInSpend = spend.indexOf(
    'BleObjectQuarantine.shared.finalizeRetire(per, claim: ticket, id: peripheralId)',
  );
  const finalize =
    finalizeInRetire > -1
      ? finalizeInRetire
      : finalizeInSpend > -1
        ? Number.MAX_SAFE_INTEGER
        : -1;
  const term = genTerminalBody(sw);
  const power = genPowerOffBody(sw);
  const recheck = genRecheckBody(sw);
  const disconnected = handlerBody(sw, 'disconnected');
  const genState = genStateBody(sw);
  const budget = Number(/static let leaseRecheckBudget = (\d+)/.exec(sw)?.[1] ?? '0');
  const oneStep = drop.indexOf('BleObjectQuarantine.shared.retire(per, claim: ticket, id: peripheralId)');
  // The ownership transition, in whichever spelling this file has.
  const transition = begin > -1 ? begin : oneStep;
  // Every filter the register is read through, so a plant that moves the
  // sweep into a helper is read rather than reported as absent.
  const filters = claim + legacy + qLiveBody(sw);
  // THE LIVE PATH, NEVER DEAD CODE — a plant that leaves the ownership API
  // in the file but stops CALLING it must read as no ownership at all.
  // (The plant that found this: e13c03f's attach/retire restored beside an
  // untouched register, where a claim discipline nothing reached still
  // parsed as present.)
  const owns = transition > -1 && /BleObjectQuarantine\.shared\.claim\(/.test(attach);
  // THE LEASE, and it is three facts: a reservation state the register can
  // hold, a door that puts the claim into it, and a second door that
  // spends it. Any one of them missing is 9717080's one-step retirement
  // wearing three names.
  const leased =
    owns &&
    begin > -1 &&
    finalize > -1 &&
    /case retiring\(UInt64\)/.test(sw) &&
    /held\.state = \.retiring\(ticket\)/.test(qBegin) &&
    // The label, not the whole case: a build that merges another verdict
    // into the authorized branch still HAS a lease, and must be read as
    // one so the arm that catches it is the arm about that verdict.
    /case \.authorized/.test(drop);
  return {
    present:
      /final class BleObjectQuarantine \{/.test(sw) &&
      /static let shared = BleObjectQuarantine\(\)/.test(sw) &&
      decide > -1 &&
      /BleObjectQuarantine\.shared\.(retire|beginRetire)\(/.test(drop),
    checkedBeforeBinding: decide > -1 && seat > decide && dial > decide,
    // The claim door writes the claim into the SAME register the refusal
    // reads, and hands back a ticket only it can mint.
    recordsClaims:
      /case claimed\(UInt64\)/.test(sw) &&
      /state: \.claimed\(tickets\)/.test(claim) &&
      /records\[id\] = live/.test(claim) &&
      /case \.granted\(let ticket\):\n\s*claimTicket = ticket/.test(attach),
    refusesActiveClaim:
      /case \.claimed:\n\s*return \.active\(held\.label\)/.test(claim) &&
      /case \.active\(let holder\):/.test(attach) &&
      /reason=object-claimed/.test(attach) &&
      attach.indexOf('case .active(let holder):') < seat,
    refusesLiveTombstone: owns
      ? /case \.tombstoned:\n\s*return \.retired\(held\.label\)/.test(claim) &&
        /case \.retired\(let holder\):/.test(attach) &&
        /reason=object-alias/.test(attach) &&
        attach.indexOf('case .retired(let holder):') < seat
      : // e13c03f's door: it knows the dead and nothing else, and this is
        // the one property the review did NOT take issue with.
        /live\.contains \{ \$0\.object === candidate \}/.test(legacy) &&
        /reason=object-alias/.test(attach),
    // THE LEASE IS FAIL-CLOSED THE SAME WAY A LIVE CLAIM IS, and it must
    // be, because between the reservation and the cancel this object is
    // about to be torn down: binding to it is binding to a corpse that has
    // not been told yet.
    refusesRetiringLease:
      leased &&
      /case \.retiring:\n\s*return \.retiring\(held\.label\)/.test(claim) &&
      /case \.retiring\(let holder\):/.test(attach) &&
      /reason=object-retiring/.test(attach) &&
      attach.indexOf('case .retiring(let holder):') < seat,
    singleLock:
      (quarantineClassBody(sw).match(/private let lock = NSLock\(\)/g) ?? [])
        .length === 1 &&
      locksTheRegister(claim) &&
      (leased
        ? locksTheRegister(qBegin) && locksTheRegister(qFinal)
        : locksTheRegister(qRetire)),
    retiresOwnClaimOnly: leased
      ? /if case \.claimed\(let mine\) = held\.state, mine == ticket \{\n\s*held\.state = \.retiring\(ticket\)/.test(
          qBegin,
        ) && /return \.superseded\(held\.label\)/.test(qBegin)
      : owns &&
        /if case \.claimed\(let mine\) = held\.state, mine == ticket \{\n\s*held\.state = \.tombstoned/.test(
          qRetire,
        ) &&
        /return \.superseded\(held\.label\)/.test(qRetire),
    supersededIsNoOp:
      owns &&
      /case \.superseded\(let holder\):/.test(drop) &&
      !/case \.superseded[\s\S]*?cancelPeripheralConnection/.test(drop) &&
      /gen-supersede gen=/.test(drop),
    ownershipBeforeCancel: transition > -1 && cancel > transition,
    leasedRetire: leased,
    // The cancel happens UNDER the lease, so the finalize is the last of
    // the three. A finalize that runs first is a lease that covers
    // nothing — the same window with one more function call in it.
    finalizeAfterCancel: leased && cancel > begin && finalize > cancel,
    // AN OBJECT WITH A CANCEL IN FLIGHT IS NOT THE EPOCH'S TO GIVE AWAY.
    // The reset turns the epoch and drops everything else; the reserved
    // record stays, epoch-stale, until its leaseholder spends the lease.
    resetPreservesLease:
      leased &&
      /\$0\.reserved/.test(reset) &&
      !/records\.removeAll\(\)/.test(reset) &&
      /\$0\.epoch == epoch \|\| \$0\.reserved/.test(qLiveBody(sw)),
    finalizedByLeaseholderOnly:
      leased &&
      /guard case \.retiring\(let mine\) = held\.state, mine == ticket else \{\n\s*return \.foreign\(held\.label\)/.test(
        qFinal,
      ) &&
      /held\.state = \.tombstoned/.test(qFinal) &&
      /return \.released/.test(qFinal),
    // NO LEASE, NO CANCEL: a retirement that found nothing to reserve owns
    // nothing, and a cancel issued without ownership is the shot that hits
    // whoever claimed the object in the meantime.
    unleasedIsNoOp:
      leased &&
      /case \.absent:/.test(drop) &&
      !/case \.absent:[\s\S]*cancelPeripheralConnection/.test(drop) &&
      /gen-unowned gen=/.test(drop),
    // ---------------------------------------------- the four terminals
    //
    // THE CANCEL IS NONBLOCKING, so the lease may not end where the call
    // returns. Read: retire() no longer spends anything, `spendLease` is
    // the one door onto the register's third step, and the disconnect
    // handler is a road into it.
    leaseHeldThroughTerminal:
      leased &&
      finalizeInRetire === -1 &&
      finalizeInSpend > -1 &&
      /lease = \.held\(ticket\)/.test(drop) &&
      /leasedObject = per/.test(drop) &&
      /noteLeaseTerminal\(peripheral, central: central\)/.test(disconnected),
    // T1. The exact reserved object AND this generation's own manager:
    // another object is another link and another manager is another
    // generation's stack.
    terminalIsExactObjectOnOwnManager:
      /guard let ticket = leaseTicket else \{ return false \}/.test(term) &&
      /peripheral === leased/.test(term) &&
      /central === manager/.test(term) &&
      /why: "did-disconnect"/.test(term),
    // …and T1 can only ever be delivered if the retiring generation kept
    // the manager, kept its seat on it and kept ITSELF alive to answer.
    keepsManagerThroughLease:
      /private var leaseHold: BleLinkGeneration\?/.test(sw) &&
      /leaseHold = self/.test(drop) &&
      !/manager = nil/.test(drop) &&
      !/manager\?\.delegate = nil/.test(drop) &&
      /central === manager/.test(term),
    // T2. Read BEFORE the issue (the issue is what changes it), and
    // `.disconnected` only — `.disconnecting` is an effect still owed.
    fastPathOnlyDisconnected:
      /let atIssue = per\.state/.test(drop) &&
      drop.indexOf('let atIssue = per.state') < cancel &&
      /if atIssue == \.disconnected \{/.test(drop) &&
      !/\.disconnecting/.test(codeOnly(drop)) &&
      /why: "disconnected-at-issue"/.test(drop),
    // T3. An OBSERVED poweredOff on that manager, and no weaker adapter
    // fact anywhere near the completion.
    powerOffIsTheOnlyStateTerminal:
      /if central\.state == \.poweredOff \{\n\s*_ = noteLeasePowerOff\(central\)/.test(genState) &&
      /central === manager/.test(power) &&
      /poisonToo: true/.test(power) &&
      !/\.resetting|\.unknown|\.unauthorized/.test(codeOnly(power)) &&
      !/adapterEpoch|adapterReset/.test(codeOnly(power)),
    // T4. A bounded recheck on the generation's OWN queue, a re-cancel
    // while the object is still up, and poison when the budget is out.
    boundedRecheckThenPoison:
      budget > 0 &&
      /static let leaseRecheckTick: TimeInterval/.test(sw) &&
      /queue\.asyncAfter\(deadline: \.now\(\) \+ WalkieBleVoice\.leaseRecheckTick\)/.test(sw) &&
      /scheduleLeaseRecheck\(\)/.test(drop) &&
      /if per\.state == \.disconnected \{/.test(recheck) &&
      /leaseRechecks \+= 1/.test(recheck) &&
      /if leaseRechecks > WalkieBleVoice\.leaseRecheckBudget \{/.test(recheck) &&
      /lease = \.poisoned\(ticket\)/.test(recheck) &&
      /manager\?\.cancelPeripheralConnection\(per\)/.test(recheck),
    recheckBudget: budget,
    // POISON IS FAIL-CLOSED, not a release: the epoch may not free it (the
    // register's own reservation rule), nothing in the recheck or the
    // spend consults an epoch, and only T3 carries `poisonToo`.
    poisonHoldsThroughEpoch:
      /\$0\.reserved/.test(reset) &&
      !/records\.removeAll\(\)/.test(reset) &&
      /\$0\.epoch == epoch \|\| \$0\.reserved/.test(qLiveBody(sw)) &&
      !/adapterEpoch|adapterReset/.test(codeOnly(recheck)) &&
      !/adapterEpoch|adapterReset/.test(codeOnly(spend)) &&
      /case \.poisoned\(let mine\) where mine == ticket && poisonToo:/.test(spend) &&
      /poisonToo: false/.test(term),
    // AND EVERY COMPLETION IS TICKET-IDEMPOTENT: the lease leaves `.held`
    // BEFORE the register is touched, so a second terminal for the same
    // ticket transitions nothing.
    terminalIsTicketIdempotent:
      /case \.held\(let mine\) where mine == ticket:/.test(spend) &&
      /default:\n\s*vlog\("lease-dup/.test(spend) &&
      spend.indexOf('lease = .spent') > -1 &&
      spend.indexOf('lease = .spent') < finalizeInSpend,
    releasedByObjectDeath:
      /weak var object: CBPeripheral\?/.test(sw) && /\$0\.object != nil/.test(filters),
    releasedByAdapterEpoch:
      /\$0\.epoch == epoch/.test(filters) &&
      /epoch &\+= 1/.test(reset) &&
      (/records\.removeAll\(\)/.test(reset) || /records\.removeValue\(forKey: key\)/.test(reset)),
    clearedByStop: /BleObjectQuarantine/.test(stopBody(sw)),
  };
};

/**
 * THE OWNERSHIP REGISTER, RUN — the reviewer's production ordering needs a
 * machine that can be stepped, because the whole finding is about WHEN
 * things happen: "native stop merely enqueues old WalkieBleVoice
 * retirement then drops it/resolves. Immediate new session can retrieve
 * the exact still-ACTIVE old CBPeripheral before its tombstone exists."
 * A predicate over a world-struct cannot express a retirement that has
 * been posted and has not run, which is why the old arm modelled
 * retire-then-attach and missed the ordering the field produces.
 *
 * ONE object is under test throughout — the exact CBPeripheral a fresh
 * manager hands back — and every fact this machine acts on comes out of
 * `quarantineOf`.
 */
type Owner = {
  by: string;
  state: 'claimed' | 'retiring' | 'tombstoned';
  /** Reserved through an adapter epoch that has since turned over. */
  stale?: boolean;
  /** T4's budget ran out with no terminal: fail-closed, and it STAYS. */
  poisoned?: boolean;
};

/** What one retirement still owes, between the issue and the terminal. */
type LeaseRun = { rechecks: number; poisoned: boolean; spent: boolean };

class ObjectRegister {
  /** Who owns the object under test, if anyone. */
  owner: Owner | null = null;
  /** Generations that took the delegate seat and connected, still live. */
  private bound = new Set<string>();
  /** Retirements posted to a queue and not yet run, in order. */
  private queued: string[] = [];
  /** Generations whose LIVE link somebody else's cancel tore down. */
  casualties: string[] = [];
  log: string[] = [];
  private objectAlive = true;
  /**
   * CANCELS ISSUED WHOSE EFFECT HAS NOT LANDED — the whole of this round.
   * `cancelPeripheralConnection` is nonblocking: it books a teardown, and
   * the stack performs it whenever it gets round to it. A generation is in
   * here from the ISSUE until the EFFECT, and the casualty of a cancel is
   * decided at the effect, over whoever is standing on the object THEN.
   */
  private inFlight: string[] = [];
  /** The terminal each authorized retirement is still waiting on. */
  private leases = new Map<string, LeaseRun>();

  constructor(private q: Quarantine) {}

  /** A dial resolved the address to the object and tried to build on it. */
  attach(gen: string): 'bound' | 'refused' {
    const held = this.owner;
    if (this.q.present && this.q.checkedBeforeBinding && held !== null && this.objectAlive) {
      const refuses =
        held.state === 'claimed'
          ? this.q.refusesActiveClaim
          : held.state === 'retiring'
            ? this.q.refusesRetiringLease
            : this.q.refusesLiveTombstone;
      if (refuses) {
        this.log.push(`refuse:${gen}`);
        return 'refused';
      }
    }
    if (this.q.recordsClaims) {
      this.owner = { by: gen, state: 'claimed' };
    }
    this.bound.add(gen);
    this.log.push(`bind:${gen}`);
    return 'bound';
  }

  /** stop() and dropClient POST the retirement; they do not run it. */
  enqueueRetire(gen: string): void {
    this.queued.push(gen);
    this.log.push(`enqueue-retire:${gen}`);
  }

  /** The link queue finally gets to the posted retirements. */
  drainRetires(): void {
    const due = this.queued;
    this.queued = [];
    for (const gen of due) {
      this.runRetire(gen);
    }
  }

  /**
   * STEP ONE, and the step the first build did not have: RESERVE the exact
   * object for this ticket, under the lock, and answer with the
   * retirement's permission to touch it at all. A build with no lease
   * tombstones here instead — which frees the object to the next epoch
   * while the cancel is still to come.
   */
  beginRetire(gen: string): 'authorized' | 'noop' {
    const held = this.owner;
    if (!this.q.retiresOwnClaimOnly) {
      // No ownership discipline at all: the retirement tombstones and
      // cancels whatever it happens to find.
      this.owner = { by: gen, state: 'tombstoned' };
      this.log.push(`tombstone:${gen}`);
      return 'authorized';
    }
    if (held !== null && held.by === gen && held.state === 'claimed') {
      const leases = this.q.leasedRetire && this.q.finalizeAfterCancel;
      this.owner = leases
        ? { by: gen, state: 'retiring', stale: held.stale }
        : { by: gen, state: 'tombstoned' };
      if (leases) {
        this.leases.set(gen, { rechecks: 0, poisoned: false, spent: false });
      }
      this.log.push(leases ? `lease:${gen}` : `tombstone:${gen}`);
      return 'authorized';
    }
    if (held !== null && this.q.supersededIsNoOp) {
      this.log.push(`retire-noop:${gen}`);
      this.bound.delete(gen);
      return 'noop';
    }
    if (held === null && this.q.leasedRetire && this.q.unleasedIsNoOp) {
      // NOTHING TO RESERVE, SO NOTHING TO CANCEL. The object died or the
      // epoch turned before this retirement got to it; whoever owns it now
      // does not owe this generation a teardown.
      this.log.push(`retire-unowned:${gen}`);
      this.bound.delete(gen);
      return 'noop';
    }
    // Ownership is gone and the retirement is authorized anyway — the
    // review's first window, and the cancel that follows is loaded.
    this.log.push(`retire-absent:${gen}`);
    return 'authorized';
  }

  /**
   * PHASE 1 — the cancel is ISSUED, outside the lock. Nothing has happened
   * to any link yet: this books a teardown with the stack.
   *
   * `atIssue` is the object's state as the retirement reads it in the
   * instant BEFORE the call, which is the whole of T2: a peripheral that
   * is already `.disconnected` has no link to tear down, so the cancel is
   * a no-op and no effect can ever land. `.disconnecting` is NOT that
   * case — a teardown in flight is an effect still owed.
   */
  cancelIssue(gen: string, atIssue: 'connected' | 'disconnecting' | 'disconnected' = 'connected'): void {
    const lease = this.leases.get(gen);
    const fastPath = atIssue === 'disconnected' && this.q.fastPathOnlyDisconnected;
    if (!fastPath) {
      this.inFlight.push(gen);
    }
    this.log.push(`retire-cancel:${gen}`);
    if (lease === undefined) {
      return; // a build with no lease at all has nothing to hold or spend
    }
    if (fastPath) {
      // T2 — nothing was connected, so nothing is owed.
      this.log.push(`terminal-none:${gen}`);
      this.spendLease(gen);
      return;
    }
    if (!this.q.leaseHeldThroughTerminal) {
      // THE SUBSTRATE FINDING, EXECUTABLE. The finalize is the statement
      // after the issue, so the lease covered the AUTHORIZATION and not
      // the EFFECT: the record is claimable again while the teardown this
      // call booked has not happened yet.
      this.log.push(`finalize-at-issue:${gen}`);
      this.spendLease(gen);
    }
  }

  /** PHASE 2 — and the call RETURNS, at once, having changed nothing. */
  cancelReturns(gen: string): void {
    this.log.push(`cancel-returns:${gen}`);
  }

  /**
   * PHASE 4 — the stack finally performs the teardown it booked. THIS is
   * where a link dies, and whoever is standing on the object at THIS
   * moment is who it kills.
   */
  cancelEffect(gen: string): void {
    const at = this.inFlight.indexOf(gen);
    if (at < 0) {
      this.log.push(`effect-none:${gen}`);
      return;
    }
    this.inFlight.splice(at, 1);
    this.cancel(gen);
    this.log.push(`cancel-effect:${gen}`);
  }

  /**
   * PHASE 5, T1 — didDisconnectPeripheral for the EXACT reserved object,
   * delivered on the retiring generation's OWN manager. The primary
   * completion, and the reason that generation keeps its manager, its
   * delegate seat and itself alive through the retirement.
   */
  disconnectTerminal(
    gen: string,
    object: 'exact' | 'other' = 'exact',
    manager: 'own' | 'other' = 'own',
  ): void {
    const lease = this.leases.get(gen);
    if (lease === undefined) {
      this.log.push(`terminal-nolease:${gen}`);
      return;
    }
    if (!this.q.keepsManagerThroughLease) {
      // The generation handed back its manager (and its seat on it) at
      // retirement, so this callback is delivered to nothing at all and
      // the lease's primary completion can never arrive.
      this.log.push(`terminal-lost:${gen}`);
      return;
    }
    if (this.q.terminalIsExactObjectOnOwnManager && (object !== 'exact' || manager !== 'own')) {
      this.log.push(`terminal-ignored:${gen}`);
      return;
    }
    if (this.q.terminalIsTicketIdempotent && (lease.spent || lease.poisoned)) {
      // A straggler: a second disconnect, or one arriving after T4 gave up
      // waiting for the first. It proves nothing about a teardown the
      // stack may still be sitting on, so it lifts nothing.
      this.log.push(`terminal-dup:${gen}`);
      return;
    }
    this.log.push(`terminal-disconnect:${gen}`);
    this.spendLease(gen);
  }

  /**
   * PHASE 5, T3 — an OBSERVED adapter state on the generation's own
   * manager. Only `poweredOff` is a terminal: every link is then
   * physically dead, so the teardown this cancel booked can no longer
   * reach anybody. It is also the only thing besides the object's own
   * death that lifts a poison.
   */
  stateTerminal(gen: string, state: 'poweredOff' | 'resetting' | 'unknown' | 'unauthorized'): void {
    const lease = this.leases.get(gen);
    if (lease === undefined) {
      this.log.push(`terminal-nolease:${gen}`);
      return;
    }
    if (this.q.powerOffIsTheOnlyStateTerminal && state !== 'poweredOff') {
      this.log.push(`terminal-ignored:${gen}@${state}`);
      return;
    }
    if (this.q.terminalIsTicketIdempotent && lease.spent) {
      this.log.push(`terminal-dup:${gen}`);
      return;
    }
    this.inFlight = this.inFlight.filter((g) => g !== gen);
    lease.poisoned = false;
    this.log.push(`terminal-poweroff:${gen}`);
    this.spendLease(gen);
  }

  /**
   * T4 — one turn of the bounded recheck, on the generation's own queue.
   * A stack that never delivers T1 must not strand the address for the
   * life of the process; a stack that has genuinely wedged must not be
   * declared finished either. So: re-read the object, re-issue the cancel
   * while it is still up, and when the budget is out POISON the record —
   * which refuses every claim exactly as the lease did, and which no
   * adapter reset and no epoch turn may free.
   */
  recheckTick(gen: string): 'spent' | 'recancel' | 'poison' | 'none' {
    const lease = this.leases.get(gen);
    if (lease === undefined || lease.spent) {
      return 'none';
    }
    if (!this.q.boundedRecheckThenPoison) {
      // NO FALLBACK AT ALL: the lease waits, for the life of the process,
      // on a terminal this stack is not going to deliver.
      this.log.push(`recheck-absent:${gen}`);
      return 'none';
    }
    if (lease.poisoned) {
      return 'poison';
    }
    if (!this.inFlight.includes(gen)) {
      // The effect landed after all and the object is disconnected: the
      // recheck IS the terminal.
      this.log.push(`terminal-recheck:${gen}`);
      this.spendLease(gen);
      return 'spent';
    }
    lease.rechecks += 1;
    if (lease.rechecks > this.q.recheckBudget) {
      lease.poisoned = true;
      const held = this.owner;
      if (held !== null && held.by === gen && held.state === 'retiring') {
        this.owner = { ...held, poisoned: true };
      }
      this.log.push(`lease-poison:${gen}`);
      return 'poison';
    }
    this.log.push(`lease-recheck:${gen}#${lease.rechecks}`);
    return 'recancel';
  }

  /** The lease leaves `.held` BEFORE the register is touched — which is
   *  the whole of ticket-idempotence. */
  private spendLease(gen: string): void {
    const lease = this.leases.get(gen);
    if (lease !== undefined) {
      lease.spent = true;
      lease.poisoned = false;
    }
    this.finalizeRetire(gen);
  }

  /**
   * STEP TWO, WHOLE — the issue and its effect in one breath, which is
   * what a build that cannot tell the two apart believes happens. Kept for
   * the arms whose question is the RESERVATION rather than the effect.
   */
  cancelFor(gen: string): void {
    this.cancelIssue(gen);
    this.cancelReturns(gen);
    this.cancelEffect(gen);
  }

  /**
   * STEP THREE: spend the lease. Only its holder may, and only this makes
   * the object claimable again — a tombstone inside its own epoch, or a
   * released address if the epoch turned while the lease was held.
   */
  finalizeRetire(gen: string): void {
    if (!this.q.leasedRetire) {
      this.log.push(`finalize-none:${gen}`);
      return;
    }
    const held = this.owner;
    if (held === null) {
      this.log.push(`finalize-absent:${gen}`);
      return;
    }
    if (held.state !== 'retiring' || (this.q.finalizedByLeaseholderOnly && held.by !== gen)) {
      this.log.push(`finalize-foreign:${gen}`);
      return;
    }
    if (held.stale) {
      this.owner = null;
      this.log.push(`finalize-release:${gen}`);
      return;
    }
    this.owner = { by: gen, state: 'tombstoned' };
    this.log.push(`finalize-tombstone:${gen}`);
  }

  /**
   * THE WHOLE TEARDOWN, UNINTERRUPTED — every phase the production flow
   * runs when nothing interleaves, and it is SIX now rather than three:
   * reserve, issue, return, effect, terminal, finalize. The middle three
   * are the seam this round is about, and an uninterrupted retirement must
   * still end exactly where 9717080 ended.
   */
  runRetire(gen: string): void {
    if (this.beginRetire(gen) === 'noop') {
      return;
    }
    this.cancelIssue(gen);
    this.cancelReturns(gen);
    this.cancelEffect(gen);
    this.disconnectTerminal(gen);
    if (!this.leases.has(gen)) {
      // No lease was taken at all, so there is no terminal to wait for and
      // the finalize is where it always was.
      this.finalizeRetire(gen);
    }
  }

  /** cancelPeripheralConnection on a SHARED object ends everyone's link. */
  private cancel(by: string): void {
    for (const g of this.bound) {
      if (g !== by) {
        this.casualties.push(g);
      }
    }
    this.bound.delete(by);
  }

  /** ARC released it — the ordinary release, moments after a retirement. */
  objectDies(): void {
    if (!this.q.releasedByObjectDeath) {
      // A STRONG BOX PREVENTS THE DEATH, which is the wedge caused by the
      // cure: the register holds alive the very thing whose death is the
      // release, and this address is never dialable again.
      this.log.push('object-held');
      return;
    }
    this.objectAlive = false;
    this.owner = null;
    // A DEAD OBJECT HAS NO LINK LEFT TO KILL. Whatever teardown was still
    // booked on it can no longer reach anybody, and nobody is standing on
    // it to be reached — which is why the weak box's emptying is one of
    // the two roads out of a poison.
    this.inFlight = [];
    this.bound.clear();
    this.log.push('object-died');
  }

  /** The adapter cycled: every object the stack vended is dead to it. */
  adapterCycles(): void {
    const held = this.owner;
    // A POISONED RECORD IS HELD BY A STRICTER RULE THAN A LEASE, and it is
    // read separately: an epoch turn is the very thing that must NOT free
    // a record whose teardown was never proven to land.
    const holds =
      held !== null && held.poisoned === true
        ? this.q.poisonHoldsThroughEpoch
        : this.q.resetPreservesLease;
    if (held !== null && held.state === 'retiring' && holds) {
      // THE ONE THING AN EPOCH MAY NOT FREE. A cancel for this object has
      // been authorized and not issued; releasing it here is the window
      // the review named, one state along from the tombstone. The record
      // goes epoch-stale and stays refused until the lease is spent.
      this.owner = { ...held, stale: true };
      this.log.push('adapter-cycle');
      return;
    }
    if (this.q.releasedByAdapterEpoch) {
      this.owner = null; // claims AND tombstones, under the same lock
    }
    this.log.push('adapter-cycle');
  }

  /**
   * TWO DIALS INSIDE ONE CLAIM WINDOW — the lock's whole job. Two
   * WalkieBleVoice instances overlap across a restart and own DIFFERENT
   * queues, so this register is the one structure here that two threads
   * reach at once.
   */
  raceAttach(a: string, b: string): ['bound' | 'refused', 'bound' | 'refused'] {
    if (this.q.singleLock) {
      return [this.attach(a), this.attach(b)];
    }
    // Read-then-insert across a lock gap: both dials looked, both saw a
    // free object, and both built on it.
    this.bound.add(a);
    this.bound.add(b);
    this.owner = { by: b, state: 'claimed' };
    this.log.push(`bind:${a}`, `bind:${b}`);
    return ['bound', 'bound'];
  }

  /** The camper closed the walkie and reopened it. */
  restart(): void {
    if (this.q.clearedByStop) {
      this.owner = null;
    }
    this.log.push('restart');
  }
}

/**
 * THE OLD SHAPE OF THIS TEST, kept as a convenience for the worlds that
 * are genuinely one question — retire first, then dial.
 */
interface DialWorld {
  sameObjectAsRetired: boolean;
  objectDied: boolean;
  adapterCycled: boolean;
  restarted: boolean;
}

const dialOutcome = (sw: string, w: DialWorld): 'bound' | 'refused' => {
  const reg = new ObjectRegister(quarantineOf(sw));
  if (w.sameObjectAsRetired) {
    reg.attach('gen1');
    reg.runRetire('gen1');
  }
  if (w.restarted) {
    reg.restart();
  }
  if (w.objectDied) {
    reg.objectDies();
  }
  if (w.adapterCycled) {
    reg.adapterCycles();
  }
  return reg.attach('gen2');
};

describe('the iPhone gives every dial its own CoreBluetooth stack', () => {
  const sw = readVoiceSource();

  test('a link is owned by a per-dial generation, manager and all', () => {
    // THE WHOLE SUBSTRATE. Mutation: put `extension WalkieBleVoice:
    // CBPeripheralDelegate` back and every generation shares one handler
    // again — the file 0628ea9 reverted to, and the reason its watchdog
    // could not be kept. Mutation: keep the per-link delegate but let the
    // generation borrow the SHARED manager (scrap/per-link-delegate) and
    // the three connection callbacks are a shared family again.
    expect(ownership(sw)).toBe('per-generation');
    expect(sw).not.toMatch(/extension WalkieBleVoice: CBPeripheralDelegate/);
    expect(sw).not.toMatch(/peripheral\.delegate = self/);
    // One construction site, and it is the dial.
    expect((sw.match(/BleLinkGeneration\(\n/g) ?? []).length).toBe(1);
    expect(dialBody(sw)).toContain('let link = BleLinkGeneration(');
    expect(dialBody(sw)).toMatch(/peer\.link = link\n\s*link\.open\(\)/);
  });

  test('the shared manager SCANS, and implements nothing a link could need', () => {
    // Mutation: implement didConnect/didFailToConnect/didDisconnect on the
    // coordinator "for logging". A connection handler on this class means
    // a link this class can answer for, and it can only answer by
    // identifier — which names the phone, not the link. Their ABSENCE is
    // the structural half of the ruling.
    const ext = bodyOf(sw, 'extension WalkieBleVoice: CBCentralManagerDelegate {', '\n}\n');
    expect(ext).not.toEqual('');
    for (const gone of ['didConnect', 'didFailToConnect', 'didDisconnectPeripheral']) {
      expect(`${gone}:${ext.includes(gone)}`).toBe(`${gone}:false`);
    }
    // Mutation: connect from the scanner. Then every generation is built
    // on the scanner's object and the isolation is decorative.
    expect(ext).not.toMatch(/\.connect\(/);
    // Mutation: hand the scan's CBPeripheral onward. An ADDRESS and the
    // advertisement's facts are what leave this callback.
    expect(ext).toMatch(/let id = peripheral\.identifier/);
    expect(ext).toMatch(/maybeConnect\(hash, id\)/);
    expect(sw).toMatch(/private func maybeConnect\(_ hash: UInt32, _ id: UUID\)/);
  });

  test('field logs expose raw sightings and paced backoff decisions', () => {
    // Mutation: remove OSLog or leave its values private and the release-build
    // field trace returns to "no audio and no errors". The sighting lands
    // before decode so a missing carrier is itself observable, once per UUID
    // per ten seconds rather than at duplicate-scan cadence.
    expect(sw).toContain('import os');
    expect(sw).toMatch(
      /private let wlog = Logger\(\n\s*subsystem: "com\.playapal\.walkie",\n\s*category: "ble"/,
    );
    const sight = bracedBody(sw, 'private func noteSighting(');
    expect(sight).not.toEqual('');
    expect(sight).toContain('Self.sightLogWindow');
    expect(sight).toContain('logAllowed(&sightLog');
    expect(sw).toContain('private let logKeyCap = 1_024');
    expect(sight).toContain('voice//sight id=');
    expect((sight.match(/privacy: \.public/g) ?? []).length).toBe(4);

    const ext = bracedBody(sw, 'extension WalkieBleVoice: CBCentralManagerDelegate {');
    expect(ext).not.toEqual('');
    const sightAt = ext.indexOf('noteSighting(id, advertisementData, advName, RSSI)');
    const decodeAt = ext.indexOf('decodePv(advertisementData)');
    expect(sightAt).toBeGreaterThanOrEqual(0);
    expect(decodeAt).toBeGreaterThan(sightAt);

    // Mutation: silently return from backoff again, or log every duplicate
    // sighting. One line is emitted per lastAttempt stamp and says the
    // remaining wait with public fields.
    const dial = dialBody(sw);
    expect(dial).not.toEqual('');
    expect(dial).toContain('logAllowed(');
    expect(dial).toContain('&dialLog');
    expect(dial).toContain('every: peer.backoff');
    expect(dial).toContain('voice//dial-skip hash=');
    expect(dial).toContain('reason=backoff wait=');
    expect((dial.match(/privacy: \.public/g) ?? []).length).toBe(2);
  });

  test('pre-connect quarantine refusals keep the floor while on-air failures double', () => {
    // Mutation: classify every failed setup alike and repeated object-lane
    // contention grows to a 30-second silence. Only failures before a
    // connection was accepted are exempt; setup/on-air failures retain the
    // exponential retry budget. lastAttempt is deliberately NOT cleared, so
    // the three-second floor still applies.
    const drop = bracedBody(sw, 'private func dropClient(_ peer: VoicePeer, _ why: String) {');
    expect(drop).not.toEqual('');
    expect(sw).toMatch(
      /static let preConnectRefusals: Set<String> = \[\n\s*"no-object",\n\s*"object-claimed",\n\s*"object-retiring",\n\s*"object-alias",\n\s*\]/,
    );
    expect(drop).toMatch(
      /if Self\.preConnectRefusals\.contains\(why\) \{\n\s*peer\.backoff = Self\.connectBackoffBase\n\s*return\n\s*\}\n\s*peer\.backoff = min\(peer\.backoff \* 2, Self\.connectBackoffCap\)/,
    );
    expect(drop).not.toContain('lastAttempt =');
  });

  test('several managers means NO restoration identifiers, said in the source', () => {
    // Mutation: add CBCentralManagerOptionRestoreIdentifierKey. A
    // restoration id must be unique per manager and this rung mints one
    // per dial — CoreBluetooth would restore state into an arbitrary
    // generation, which is the overlap this shape exists to remove,
    // reintroduced by the OS itself.
    // Code lines only: the source NAMES the thing it refuses, in the
    // comment beside the mint, and a rule that trips over its own warning
    // is a rule nobody keeps (walkieIdentProof's NSLog pin, same idiom).
    const code = sw
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/CBCentralManagerOptionRestoreIdentifierKey/);
    expect(code).not.toMatch(/willRestoreState/);
    expect(sw).toMatch(/manager = CBCentralManager\(delegate: self, queue: queue\)/);
  });

  test('the generation is minted with FROZEN facts, not slots', () => {
    // Mutation: make any of these `var`. A fact that can be reassigned is
    // a mutable peer slot with a new address, and "do not add another
    // mutable peer slot" is the verdict this shape answers.
    const cls = sw.slice(
      sw.indexOf('final class BleLinkGeneration: NSObject {'),
      sw.indexOf('// ---------------------------------------- the generation\'s manager seat'),
    );
    expect(cls).not.toEqual('');
    for (const frozen of [
      'let id: Int',
      'let dialedHash: UInt32',
      'let peripheralId: UUID',
      'let adapterEpoch: UInt64',
    ]) {
      expect(`${frozen}@${cls.includes(frozen)}`).toBe(`${frozen}@true`);
    }
    // …and both live flags are one-way and privately set.
    expect(cls).toMatch(/private\(set\) var retired = false/);
    expect(cls).toMatch(/private\(set\) var ready = false/);
  });

  test('retirement is MONOTONIC, and the cancel runs INSIDE the lease', () => {
    // Mutation: drop the guard and a second retirement re-runs the
    // teardown, quarantining an object twice and cancelling a connection
    // that is already somebody else's problem. Mutation: cancel first, and
    // everything the cancel provokes — its own disconnect notice, the read
    // that fails because the pipe closed — lands on a LIVE object.
    const drop = retireBody(sw);
    expect(drop).toMatch(/guard !retired else \{\n\s*return[^\n]*\n\s*\}\n\s*retired = true/);
    const retired = drop.indexOf('retired = true');
    for (const after of [
      'per.delegate = nil',
      'BleObjectQuarantine.shared.beginRetire(per, claim: ticket, id: peripheralId)',
      'lease = .held(ticket)',
      'manager?.cancelPeripheralConnection(per)',
    ]) {
      expect(`${after}@${drop.indexOf(after) > retired}`).toBe(`${after}@true`);
    }
    // RESERVE, THEN HOLD, THEN CANCEL — and the spend is not here at all.
    // Mutation: finalize on the statement after the issue (15db991's
    // shape) and the lease covers the AUTHORIZATION rather than the
    // EFFECT, which is this round's whole finding. Mutation: cancel first
    // and the window in which this object is owned by nobody is the window
    // the cancel's own disconnect notice arrives in.
    const begin = drop.indexOf('BleObjectQuarantine.shared.beginRetire(');
    const cancel = drop.indexOf('manager?.cancelPeripheralConnection(per)');
    const held = drop.indexOf('lease = .held(ticket)');
    expect(`${begin < held}/${held < cancel}`).toBe('true/true');
    expect(drop).not.toMatch(/BleObjectQuarantine\.shared\.finalizeRetire\(/);
    // Mutation: `per.delegate = nil` unconditionally. Cleared only while
    // it is still OURS — a blind clear is a retired link DEAFENING a
    // replacement in one line.
    expect(drop).toMatch(/if per\.delegate === self \{\n\s*per\.delegate = nil\n\s*\}/);
    // Mutation: leave the pipes behind. A retired link must hand nobody
    // anything even if a future handler forgets to ask.
    expect(drop).toMatch(/service = nil\n\s*voiceChar = nil\n\s*identChar = nil/);
    // Mutation: retire the link and leave the peer pointing at it. The
    // peer stops pointing FIRST, so nothing the teardown provokes can find
    // its way back to a current link.
    expect(sw).toMatch(/peer\.link = nil\n\s*link\.retire\(why\)/);
  });

  test('the durable peer keeps a backoff and a link id, and nothing else', () => {
    // The reverted rounds' residue, swept by name. Mutation: bring any of
    // them back and this file is adjudicating overlap again instead of
    // preventing it — the shape the reviewer refused whole.
    const peer = sw.slice(
      sw.indexOf('final class VoicePeer {'),
      sw.indexOf('// ------------------------------------------------------- the coordinator'),
    );
    expect(peer).not.toEqual('');
    for (const ghost of [
      'CBPeripheral',
      'CBCharacteristic',
      'voiceChar',
      'identChar',
      'attempt',
      'probePending',
      'linkAttempt',
      'readChar',
      'svcAttempt',
      'charAttempt',
    ]) {
      expect(`${ghost}:${peer.includes(ghost)}`).toBe(`${ghost}:false`);
    }
    // THE FLAGS ARE DERIVED, and that is the cure for D1 one layer down:
    // `ready` used to be a slot a dead link could leave true behind it.
    // Mutation: store them and the falsifiable flag is back.
    expect(peer).toMatch(/var link: BleLinkGeneration\?/);
    expect(peer).toMatch(/var ready: Bool \{ link\?\.ready \?\? false \}/);
    expect(peer).toMatch(/var connecting: Bool \{/);
    expect(peer).not.toMatch(/var ready = false/);
    expect(peer).not.toMatch(/var connecting = false/);
    // The dial counter survives for the log line alone — and a comment
    // saying so is not the pin; the absence of any guard reading it is.
    expect(sw).not.toMatch(/peer\.dials ==/);
    expect(sw).not.toMatch(/\.attempt == epoch/);
  });

  test('the bench can READ the isolation working, object by object', () => {
    // ON-GLASS DIAGNOSABILITY. Four rounds argued about which callback
    // belonged to which link with nothing in any log that could have
    // settled it. Mutation: drop the object tag and the next 3am bench is
    // back to inferring identity from timing.
    expect(sw).toMatch(/private func objTag\(_ o: AnyObject\?\) -> String/);
    for (const line of ['gen-mint gen=', 'gen-retire gen=', 'gen-refuse gen=']) {
      expect(`${line}${sw.includes(line)}`).toBe(`${line}true`);
    }
    expect(sw).toMatch(/"gen-mint gen=" \+ String\(id\)[\s\S]{0,120}objTag\(self\)/);
    expect(sw).toMatch(/"gen-retire gen=" \+ String\(id\)[\s\S]{0,160}objTag\(per\)/);
    expect(attachBody(sw)).toMatch(/reason=object-alias obj=" \+ objTag\(per\)/);
    // A late callback that found no current link says so rather than
    // vanishing: the one line that proves the fence fired.
    expect(sw).toMatch(/"gen-stale gen=" \+ String\(gen\.id\)/);
  });

  test('the wire and §5 did not move', () => {
    // A refactor of OWNERSHIP is not a refactor of behaviour. Mutation:
    // anything here and a build-44 iPhone or a 0.8.6 Android in the pod
    // stops being reachable — which would make the substrate a worse bug
    // than the one it cures.
    expect((sw.match(/CBUUID\(string:/g) ?? []).length).toBe(3);
    expect(sw).toMatch(/budget >= WalkieBleVoice\.minVoiceWrite/);
    expect(sw).toMatch(/peripheral\.readValue\(for: ident\)/);
    expect(sw).toMatch(/type: \.withoutResponse/);
    expect(sw).toMatch(/canSendWriteWithoutResponse/);
    expect(sw).toMatch(/CBAdvertisementDataLocalNameKey: pvName\(\)/);
    // The ONE thing on the air that has moved since the substrate landed
    // is a write PERMISSION beside the IDENT read — the reverse-direction
    // handshake, whose whole argument lives in walkieIdentProof. The READ
    // is untouched: same UUID, same bytes, same answer, so a peer that
    // never writes is unaffected in every direction. Mutation: change the
    // read, or drop the permission and orphan the handshake.
    expect(sw).toMatch(/properties: \[\.read, \.write\],\n\s*value: nil,\n\s*permissions: \[\.readable, \.writeable\]/);
    expect(sw).toMatch(/request\.characteristic\.uuid == Self\.identChar else \{\n\s*peripheral\.respond\(to: request, withResult: \.attributeNotFound\)/);
    // The proof still precedes the listing, on the link that carried it.
    const ident = sw.slice(sw.indexOf('fileprivate func handleIdent'));
    expect(ident).toMatch(/gen\.markReady\(\)[\s\S]{0,300}onPeer\(/);
  });
});

describe('BEHAVIOUR — generation 1 comes back while generation 2 is talking', () => {
  const sw = readVoiceSource();

  test('not one of generation 1’s late callbacks reaches generation 2', () => {
    // THE REVIEWER'S NAMED SCENARIO, run against every family at once:
    // generation 1 timed out and was retired, generation 2 has since
    // reconnected to the same phone and is carrying voice, and now
    // generation 1's delayed ident answer, ident error, service discovery,
    // characteristic discovery, service-invalidation notice, connect,
    // connect failure and disconnect all land — plus its setup timer and
    // the writer the module still holds. Pointed at 0628ea9's flat file
    // every one of them is admitted: the read stamps or promotes, the
    // errors run dropClient on a live conversation, the discovery
    // overwrites the live link's pipes, and the writer puts generation 1's
    // frames on generation 2's wire.
    for (const family of Object.keys(IOS_HANDLERS)) {
      const verdict = `${family}:${admits(sw, { family, toRetiredLink: true })}`;
      expect(verdict).toBe(`${family}:false`);
    }
    expect(timerAdmits(sw, true)).toBe(false);
    expect(senderAdmits(sw, true)).toBe(false);
  });

  test('POSITIVE CONTROL — generation 2’s own completions all land', () => {
    // A guard that refuses everything is the outage spelled differently:
    // without these the iPhone never sets a link up at all, and "no peers,
    // no errors" is exactly the bench report this whole rung is trying to
    // stop producing.
    for (const family of Object.keys(IOS_HANDLERS)) {
      const verdict = `${family}:${admits(sw, { family, toRetiredLink: false })}`;
      expect(verdict).toBe(`${family}:true`);
    }
    expect(timerAdmits(sw, false)).toBe(true);
    expect(senderAdmits(sw, false)).toBe(true);
  });

  test('a late callback that DOES arrive costs one log line and no mutation', () => {
    // The other half of "old callbacks reach only retired owner": the
    // retired object is where they land, and the coordinator's own
    // current-link test is an OBJECT IDENTITY test on a handle the
    // generation owns — not an epoch, not an address, not a live-state
    // guess. Mutation: compare gen.id, or look the peer up by identifier,
    // and three reverted rounds are back.
    // BOTH sites, named, and counted — one of them passing is not the pin.
    // (The plant that found this: swap generationFailed's test for a
    // voicePeers lookup keyed on the generation's address and handleIdent's
    // identical line kept a file-wide regex green.)
    const sites: Record<string, string> = {
      generationFailed:
        'fileprivate func generationFailed(_ gen: BleLinkGeneration, _ why: String) {',
      handleIdent: 'fileprivate func handleIdent(_ gen: BleLinkGeneration, _ value: Data?) {',
      publish: 'private func publish(_ gen: BleLinkGeneration, _ peer: VoicePeer) {',
      publishIfSettled: 'fileprivate func publishIfSettled(_ gen: BleLinkGeneration) {',
    };
    for (const [name, marker] of Object.entries(sites)) {
      const body = bodyOf(sw, marker);
      expect(`${name}:present`).toBe(body === '' ? `${name}:MISSING` : `${name}:present`);
      expect(`${name}:${/peer\.link === gen/.test(body)}`).toBe(`${name}:true`);
    }
    // Every place that acts on a generation asks it, and nowhere else needs
    // to — so the count tracks the list above rather than a magic number.
    expect((sw.match(/peer\.link === gen/g) ?? []).length).toBe(
      Object.keys(sites).length,
    );
    // Mutation: find the peer by the address the generation was dialled at.
    // The address names the PHONE, so a peer whose link was torn down then
    // owns every callback that phone ever produces — the defect's front
    // door, and where all four rounds started.
    expect(sw).not.toMatch(/first \{ \$0\.peripheral\?\.identifier == /);
    expect(sw).not.toMatch(/private func peerFor\(/);
    // Scoped to the ROUTING sites rather than banned file-wide: an
    // address lookup is the honest shape for a question that only HAS an
    // address (the reverse-direction ident write arrives from a CBCentral
    // and names no link of ours). What must never happen is a CALLBACK
    // finding its peer that way — that is the defect's front door, and
    // where all four rounds started.
    for (const [name, marker] of Object.entries(sites)) {
      const body = bodyOf(sw, marker);
      expect(`${name}:${/voicePeers\.values\.first/.test(body)}`).toBe(`${name}:false`);
      expect(`${name}:${/peripheralId ==/.test(body)}`).toBe(`${name}:false`);
    }
  });
});

/**
 * THE PRODUCTION ORDERING, and it is the whole of the binding no-go on the
 * first build of this substrate, verbatim:
 *
 *   "quarantine records only retired tombstones, but native stop merely
 *   enqueues old WalkieBleVoice retirement then drops it/resolves.
 *   Immediate new session can retrieve the exact still-ACTIVE old
 *   CBPeripheral before its tombstone exists, pass aliases(), replace
 *   delegate/connect; old queued retire then cancels the shared object and
 *   callbacks cross generations. Existing immediate-stop/start arm assumes
 *   old object already retired, so misses production ordering. Required
 *   class cure: quarantine atomically owns ACTIVE CLAIMS plus retired
 *   tombstones; attachment claims exact object under lock before
 *   delegate/connect, second generation fails closed while active or
 *   live-retired, retirement transitions only its own active claim to
 *   tombstone. Awaiting stop alone narrows but does not establish
 *   process-wide ownership."
 *
 * The old arm below (retire, THEN dial) is a real path — dropClient runs
 * inline on the link queue — but it is not the path stop() takes, and a
 * register of the dead has nothing to say about an object whose owner is
 * still alive. These arms step the ordering the field produces.
 */
describe('BEHAVIOUR — stop() ENQUEUES the retirement, and a new session dials into that window', () => {
  const sw = readVoiceSource();

  test('the new session is REFUSED the still-active object, tombstone or no tombstone', () => {
    // ARM 1, the no-go executed. The camper closes the walkie and reopens
    // it: stop() posts generation 1's teardown to the closing instance's
    // queue and RETURNS, the opening instance dials on its own queue, and
    // retrievePeripherals hands it the exact object generation 1 is still
    // standing on. No tombstone exists yet and none is coming for
    // milliseconds. Mutation: record only tombstones (e13c03f) and this
    // dial binds — it takes the delegate seat of a LIVE link.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('gen1')).toBe('bound');
    reg.enqueueRetire('gen1');
    expect(reg.attach('gen2')).toBe('refused');
  });

  test('the queued retirement then runs, and takes only its own link down', () => {
    // ARM 2. Generation 1's retirement finally runs. It transitions ITS
    // OWN claim to a tombstone and cancels ITS OWN connection; because
    // generation 2 was refused, there is nothing else on this object for
    // the cancel to reach. Mutation: cancel blind and generation 2 — had
    // it bound — dies with generation 1, which is the "callbacks cross
    // generations" half of the finding.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    reg.attach('gen2');
    reg.drainRetires();
    expect(reg.casualties).toEqual([]);
    expect(reg.owner).toEqual({ by: 'gen1', state: 'tombstoned' });
  });

  test('…and the refused session RECOVERS on its backoff, the whole way to a link', () => {
    // ARM 2b, and the reason a fail-closed refusal is not an outage. The
    // refusal costs the opening session one dial. Its peer's backoff
    // redials, generation 1's object has died in the meantime (the
    // ordinary release, milliseconds after the retirement let go of it),
    // and the next dial binds. Mutation: hold the box strongly and this
    // address is never dialable again — the wedge caused by the cure.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    expect(reg.attach('gen2')).toBe('refused');
    reg.drainRetires();
    reg.objectDies();
    expect(reg.attach('gen3')).toBe('bound');
    expect(reg.casualties).toEqual([]);
  });

  test('the adapter route out of the window recovers too', () => {
    // The second release condition, on the same ordering: the radio cycles
    // while the refusal is standing, every object the stack ever vended
    // stops meaning anything, and claims go with the tombstones.
    // Mutation: clear tombstones on adapterReset but leave claims, and an
    // address whose owner never got to retire is quarantined forever.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    expect(reg.attach('gen2')).toBe('refused');
    reg.adapterCycles();
    expect(reg.attach('gen3')).toBe('bound');
  });

  test('a retirement whose claim was SUPERSEDED touches nothing', () => {
    // ARM 3. The one way a live claim can be released out from under its
    // generation is an adapter epoch turning over. A new link is then
    // built on the same object, and generation 1's long-delayed retirement
    // arrives to find its claim gone. It must log and stop. Mutation: let
    // retire() tombstone and cancel whatever it finds, and this is the
    // no-go's second sentence with different timing — an old teardown
    // ending a live conversation.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    reg.adapterCycles();
    expect(reg.attach('gen2')).toBe('bound');
    reg.drainRetires();
    expect(reg.casualties).toEqual([]);
    expect(reg.log).toContain('retire-noop:gen1');
    expect(reg.owner).toEqual({ by: 'gen2', state: 'claimed' });
  });

  test('POSITIVE CONTROL — an unclaimed fresh object binds on the first dial', () => {
    // ARM 4. A fence that refuses the ordinary case is the outage spelled
    // differently: nearly every dial in the field is this one.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('gen1')).toBe('bound');
    expect(reg.casualties).toEqual([]);
    // …and the link it built retires cleanly, cancelling its own
    // connection and nobody else's.
    reg.runRetire('gen1');
    expect(reg.casualties).toEqual([]);
    expect(reg.log).toContain('retire-cancel:gen1');
  });

  test('two dials inside one claim window: exactly one is granted', () => {
    // THE LOCK, armed. Two WalkieBleVoice instances overlap across a
    // restart and own different queues, so the register is reached from
    // two threads at once. Mutation: read the register, decide, then
    // insert outside the lock — both dials see a free object, both take
    // the delegate seat, and the ownership register has certified the
    // exact collision it exists to prevent.
    const reg = new ObjectRegister(quarantineOf(sw));
    const [first, second] = reg.raceAttach('genA', 'genB');
    expect([first, second].filter((o) => o === 'bound')).toHaveLength(1);
  });

  test('the lock discipline, read out of the Swift', () => {
    // Mutation: a second NSLock (the claim door and the transition then
    // answer the same question under two locks, which is answering it
    // twice). Mutation: touch `records` before `lock.lock()`.
    const q = quarantineOf(sw);
    expect(q.singleLock).toBe(true);
    const qBody = quarantineClassBody(sw);
    expect(qBody.length).toBeGreaterThan(0);
    expect((qBody.match(/private let lock = NSLock\(\)/g) ?? []).length).toBe(1);
    for (const [name, body] of [
      ['claim', claimBody(sw)],
      ['beginRetire', qBeginBody(sw)],
      ['finalizeRetire', qFinalizeBody(sw)],
      ['adapterReset', qResetBody(sw)],
    ] as const) {
      expect(`${name}:${firstAsk(body)}`).toBe(`${name}:lock.lock()`);
      expect(`${name}:${/defer \{ lock\.unlock\(\) \}/.test(body)}`).toBe(`${name}:true`);
    }
    // Mutation: hand the ticket out of a generation's own counter. `id`
    // restarts at 1 with every WalkieBleVoice, and an immediate stop/start
    // is two instances both minting gen 1 — a token that cannot tell the
    // two apart cannot decide ownership between them.
    expect(sw).toMatch(/private var tickets: UInt64 = 0/);
    expect(claimBody(sw)).toMatch(/tickets &\+= 1/);
    expect(sw).not.toMatch(/state: \.claimed\(id\)/);
  });

  test('the state machine has three states and one door into each', () => {
    // Mutation: add a fourth state, or a second way into any of them.
    // Every transition in this register is one of exactly three: free →
    // claimed (the claim door), claimed → retiring (the leaseholder's
    // reservation) and retiring → tombstoned-or-released (the leaseholder
    // spending it), each under the same lock. The middle state is the
    // cancel window, and it exists because the cancel does not.
    expect(sw).toMatch(
      /private enum State \{\n\s*case claimed\(UInt64\)\n\s*case retiring\(UInt64\)\n\s*case tombstoned\n\s*\}/,
    );
    const cls = sw.slice(
      sw.indexOf('final class BleObjectQuarantine {'),
      sw.indexOf('// --------------------------------------------------------- the generation'),
    );
    expect(cls).not.toEqual('');
    expect((cls.match(/state: \.claimed\(/g) ?? []).length).toBe(1);
    expect((cls.match(/held\.state = \.retiring\(/g) ?? []).length).toBe(1);
    expect((cls.match(/held\.state = \.tombstoned/g) ?? []).length).toBe(1);
    // …and exactly one door spends a lease.
    expect((cls.match(/func finalizeRetire\(/g) ?? []).length).toBe(1);
    expect((cls.match(/func beginRetire\(/g) ?? []).length).toBe(1);
    // …and the only entry that mints a claim is the one that also refuses.
    expect((cls.match(/func claim\(/g) ?? []).length).toBe(1);
    // The generation spends its ticket exactly once: nil the moment it is
    // read, so a second retirement has nothing to transition with.
    const drop = retireBody(sw);
    expect(drop).toMatch(/let ticket = claimTicket\n\s*claimTicket = nil/);
    expect(attachBody(sw)).toMatch(/case \.granted\(let ticket\):\n\s*claimTicket = ticket/);
  });
});

/**
 * THE CANCEL WINDOW, and it is the whole of the binding no-go on the
 * OWNERSHIP build (9717080), verbatim:
 *
 *   "active claims close ordinary stop/start, but cancellation is still
 *   outside the atomic ownership decision. Adapter reset clears register;
 *   delayed A retire returns absent (or A transitions tombstoned),
 *   unlocks; reset/new epoch lets B claim same object/install
 *   delegate/connect; A then executes previously authorized cancel outside
 *   lock and kills B. Hostile interleaving reports casualty=true. Test
 *   model incorrectly makes ownership check+transition+cancel one
 *   synchronous step, so misses the production seam. .absent
 *   non-destructive alone is insufficient because tombstone -> reset -> B
 *   claim -> old cancel has same window. Required class cure: explicit
 *   retiring lease/finalization protocol (or proven-safe cancellation
 *   under ownership exclusion): beginRetire atomically reserves exact
 *   object for A; claims/reset cannot release that exact object while
 *   cancellation runs; cancel; finalize only A ticket, then
 *   tombstone/release per epoch. Preserve superseded retire no-op, adapter
 *   and watchdog redials."
 *
 * THE SEAM IS THE MODEL'S TOO, and the reviewer said so: the arms above
 * call `runRetire`, which decides ownership, transitions and cancels in
 * ONE step — the one shape production never has, because
 * `cancelPeripheralConnection` is issued after the lock is released. So
 * the retirement is split into the three steps the register really has,
 * and the arms below INTERLEAVE at the seam between them: that is the
 * only place these two windows exist.
 */
describe('BEHAVIOUR — the cancel runs OUTSIDE the lock, so retirement is a LEASE', () => {
  const sw = readVoiceSource();

  test('WINDOW 2, the headline — a reset under the lease cannot hand B the object', () => {
    // THE HOSTILE INTERLEAVING, STEP FOR STEP. Generation A owns the
    // object and its teardown is authorized. The radio then cycles — an
    // adapter reset, which the first build let clear the whole register —
    // and generation B, dialling on its own instance's queue, resolves the
    // address to THE SAME OBJECT and asks for it. It must be refused,
    // because A's cancel has not been issued yet and that cancel is loaded
    // at this exact object.
    //
    // Mutation (9717080 whole): the reservation is a tombstone, the reset
    // frees it, B binds, and A's cancel then tears down the link B is
    // standing on — casualty=true, in the failure line.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('genA')).toBe('bound');
    expect(reg.beginRetire('genA')).toBe('authorized');
    reg.adapterCycles();
    const intruder = reg.attach('genB');
    reg.cancelFor('genA');
    expect(`refused:${intruder === 'refused'} casualties:${reg.casualties.join(',')}`).toBe(
      'refused:true casualties:',
    );
    // AND THE RECOVERY IS THE OTHER HALF: a fence that never opens is an
    // outage. A spends its lease, and because the epoch turned underneath
    // it the record is RELEASED outright rather than left as a tombstone
    // for an epoch that no longer exists. B's backoff redials into a free
    // address.
    reg.finalizeRetire('genA');
    expect(reg.log).toContain('finalize-release:genA');
    expect(reg.owner).toBeNull();
    expect(reg.attach('genB')).toBe('bound');
    expect(reg.casualties).toEqual([]);
  });

  test('WINDOW 1 — a retirement that could reserve NOTHING cancels nothing', () => {
    // The reviewer's first spelling: the reset lands BEFORE the delayed
    // retirement runs, so A's beginRetire finds no record at all. The
    // first build read that as "no ownership to violate" and cancelled
    // anyway — but by then B may own the object, and A's cancel is a shot
    // fired at a link it has never had anything to do with.
    //
    // Mutation: `case .authorized, .absent:` (or 9717080's `case
    // .tombstoned, .absent:`) and the cancel fires with no lease behind
    // it — casualty=true.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('genA')).toBe('bound');
    reg.adapterCycles();
    const lease = reg.beginRetire('genA');
    expect(reg.attach('genB')).toBe('bound');
    if (lease === 'authorized') {
      reg.cancelFor('genA');
    }
    expect(`lease:${lease} casualties:${reg.casualties.join(',')}`).toBe('lease:noop casualties:');
    expect(reg.owner).toEqual({ by: 'genB', state: 'claimed' });
  });

  test('THEIR SECOND WINDOW — tombstone → reset → B → old cancel is UNREACHABLE', () => {
    // ".absent non-destructive alone is insufficient because tombstone ->
    // reset -> B claim -> old cancel has same window." It is insufficient
    // for the build that tombstones FIRST. Here the tombstone is the
    // finalize, and the finalize is after the cancel: the only state in
    // which a cancel is still owed is RETIRING, and that is exactly the
    // state a reset may not release. By the time a tombstone exists on
    // this object, its cancel has been issued.
    const q = quarantineOf(sw);
    expect(`finalizeAfterCancel:${q.finalizeAfterCancel}`).toBe('finalizeAfterCancel:true');
    expect(`resetPreservesLease:${q.resetPreservesLease}`).toBe('resetPreservesLease:true');
    const reg = new ObjectRegister(q);
    reg.attach('genA');
    reg.runRetire('genA');
    expect(reg.owner).toEqual({ by: 'genA', state: 'tombstoned' });
    reg.adapterCycles();
    expect(reg.attach('genB')).toBe('bound');
    expect(reg.casualties).toEqual([]);
  });

  test('the lease is spent by its HOLDER, and by nobody else', () => {
    // Mutation: finalize whatever is in the retiring slot. A second
    // instance's teardown could then release an object it never owned,
    // handing the next dial an object with a cancel still in flight —
    // which is this whole window rebuilt inside the cure.
    const q = quarantineOf(sw);
    expect(`finalizedByLeaseholderOnly:${q.finalizedByLeaseholderOnly}`).toBe(
      'finalizedByLeaseholderOnly:true',
    );
    const reg = new ObjectRegister(q);
    reg.attach('genA');
    reg.beginRetire('genA');
    reg.finalizeRetire('genB');
    expect(reg.log).toContain('finalize-foreign:genB');
    expect(reg.attach('genB')).toBe('refused');
    expect(reg.owner).toEqual({ by: 'genA', state: 'retiring' });
  });

  test('POSITIVE CONTROL — an uninterrupted retirement still ends where 9717080 ended', () => {
    // Nearly every teardown in the field is this one, and it must end
    // exactly where the ownership build ended — a tombstone that stands
    // until the object dies — or the lease has changed the ordinary path,
    // which is an outage wearing a cure's clothes. STATED IN THE
    // VOCABULARY BOTH BUILDS SHARE, so this arm passes under every plant
    // below: what it isolates is that the cure broke nothing.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('gen1')).toBe('bound');
    reg.runRetire('gen1');
    expect(reg.log).toContain('retire-cancel:gen1');
    expect(reg.owner).toEqual({ by: 'gen1', state: 'tombstoned' });
    expect(reg.casualties).toEqual([]);
    // …and the object's death still releases the address, exactly as
    // before.
    expect(reg.attach('gen2')).toBe('refused');
    reg.objectDies();
    expect(reg.attach('gen2')).toBe('bound');
  });

  test('…and it runs all six phases, in the one order that means anything', () => {
    // The same teardown, read as a protocol rather than an outcome:
    // reserve, issue, return, effect, terminal, spend, with nothing
    // interleaved. Mutation: any shortcut that reaches the tombstone
    // without passing through the reservation (9717080's one-step
    // retirement) or without passing through the terminal (15db991's
    // spend-at-issue) — those are the two shapes whose cancel the windows
    // above and below escape through.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.runRetire('gen1');
    expect(reg.log).toEqual([
      'bind:gen1',
      'lease:gen1',
      'retire-cancel:gen1',
      'cancel-returns:gen1',
      'cancel-effect:gen1',
      'terminal-disconnect:gen1',
      'finalize-tombstone:gen1',
    ]);
  });

  test('POSITIVE CONTROL — a superseded retirement still touches nothing', () => {
    // PRESERVED, and named in the no-go's own last sentence. The lease
    // must not turn a superseded retirement into an authorized one: gen1's
    // claim was released by an epoch, gen2 built on the object, and gen1's
    // teardown arrives owning nothing.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    reg.adapterCycles();
    expect(reg.attach('gen2')).toBe('bound');
    reg.drainRetires();
    expect(reg.log).toContain('retire-noop:gen1');
    expect(reg.casualties).toEqual([]);
    expect(reg.owner).toEqual({ by: 'gen2', state: 'claimed' });
  });

  test('POSITIVE CONTROL — the enqueued-retirement window still fails closed', () => {
    // 9717080'S OWN ARM, re-run through the three-step register: the whole
    // point of the lease is that it closes a window WITHOUT opening the
    // one the ownership build closed. gen2 dials while gen1's posted
    // teardown has not run; it is refused; the drain takes down only
    // gen1's link; the object dies and gen3 binds.
    const reg = new ObjectRegister(quarantineOf(sw));
    reg.attach('gen1');
    reg.enqueueRetire('gen1');
    expect(reg.attach('gen2')).toBe('refused');
    reg.drainRetires();
    expect(reg.casualties).toEqual([]);
    reg.objectDies();
    expect(reg.attach('gen3')).toBe('bound');
  });

  test('the three-step protocol, read out of the Swift', () => {
    // The shape half, so a build that keeps the model happy by accident
    // cannot pass. Mutation: any one of these four facts.
    const q = quarantineOf(sw);
    for (const [name, held] of [
      ['leasedRetire', q.leasedRetire],
      ['refusesRetiringLease', q.refusesRetiringLease],
      ['resetPreservesLease', q.resetPreservesLease],
      ['unleasedIsNoOp', q.unleasedIsNoOp],
      ['ownershipBeforeCancel', q.ownershipBeforeCancel],
    ] as const) {
      expect(`${name}:${held}`).toBe(`${name}:true`);
    }
    // The reservation is refused on the SAME arc a live claim is — one
    // fail-closed road, one backoff, and a reason a log reader can tell
    // apart from the other two.
    expect(attachBody(sw)).toMatch(/owner\?\.generationFailed\(self, "object-retiring"\)/);
    // The reset turns the epoch and keeps ONLY what is reserved.
    expect(qResetBody(sw)).toMatch(
      /epoch &\+= 1[\s\S]*let reserved = list\.filter \{ \$0\.object != nil && \$0\.reserved \}/,
    );
    // A reserved record is visible to the claim door across an epoch turn,
    // which is what makes the refusal above survive the reset.
    expect(qLiveBody(sw)).toMatch(/\$0\.epoch == epoch \|\| \$0\.reserved/);
    // And the RESERVATION cannot be outrun by its own issue: everything
    // between the authorization and the cancel is straight-line, on one
    // queue, with nothing that can suspend, throw or return early. (What
    // may NOT be straight-line any more is the SPEND — that is the
    // terminal's, and the block below reads where it went.)
    const drop = retireBody(sw);
    const between = drop
      .slice(drop.indexOf('case .authorized'), drop.indexOf('manager?.cancelPeripheralConnection(per)'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'))
      .join('\n');
    expect(between).not.toEqual('');
    expect(between).not.toMatch(/await|asyncAfter|\.async \{|try |return\b/);
    // …and what IS between them is the delegate hand-back, the lease this
    // generation now holds open, and the state read the fast path needs —
    // in that order, and nothing else.
    expect(between).toBe(
      [
        'case .authorized:',
        'if per.delegate === self {',
        'per.delegate = nil',
        '}',
        'lease = .held(ticket)',
        'leasedObject = per',
        'leaseRechecks = 0',
        'leaseHold = self',
        'let atIssue = per.state',
      ].join('\n'),
    );
  });
});

/**
 * THE CANCEL'S EFFECT, and it is the whole of the binding no-go on the
 * LEASE build (15db991), verbatim:
 *
 *   "review explicitly splits cancellation AUTHORIZATION from asynchronous
 *   cancellation EFFECT: cancelPeripheralConnection is nonblocking, so
 *   immediate finalize after the call may release/tombstone before old
 *   didDisconnect/effect lands, allowing B claim/connect then old cancel
 *   completion kills B. Hostile model now separates cancel-issued from
 *   cancel-completed/didDisconnect; GO requires lease lifetime through
 *   proven cancellation completion (or another fail-closed terminal), plus
 *   no-wedge fallback."
 *
 * AND THE SHAPE WAS BOUND WITH IT, so these arms read a table rather than
 * a preference: T1 exact-object didDisconnect on the retiring generation's
 * own manager (the primary completion, which is why that generation keeps
 * manager, seat and self); T2 the synchronous fast path, and only when the
 * object was already `.disconnected` at issue; T3 an observed
 * `.poweredOff` on that manager, which is the only adapter fact that
 * completes anything; T4 a bounded recheck/re-cancel and then POISON,
 * fail-closed, freed by the exact object's death or a later T3 and by
 * nothing else. Every completion is ticket-idempotent.
 *
 * THE MODEL'S SEAM AGAIN, one step finer than last round: the arms above
 * treat `cancelFor` as issue-and-effect, which is the shape a nonblocking
 * call never has. Here the retirement is six steppable phases — issue,
 * return, B attempt, external effect, delegate terminal, finalize — and
 * the casualty of a cancel is decided AT THE EFFECT, over whoever is
 * standing on the object then.
 */
describe('BEHAVIOUR — the cancel is NONBLOCKING, so the lease outlives its issue', () => {
  const sw = readVoiceSource();

  test('THE ISSUED WINDOW, the headline — B is refused from the issue until the terminal', () => {
    // THE HOSTILE INTERLEAVING, PHASE FOR PHASE. A's teardown is
    // authorized, the radio cycles under the lease, and A issues its
    // cancel — which returns at once having done nothing to any link. B,
    // dialling on its own instance's queue, resolves the address to THE
    // SAME OBJECT and asks for it in that gap. It must be refused: the
    // teardown A booked has not happened yet and it is booked at this
    // exact object.
    //
    // Mutation (15db991 whole): the finalize is the statement after the
    // issue, so the epoch-stale record is RELEASED there, B binds, and the
    // effect A booked then tears down the link B is standing on —
    // refused:false casualties:genB, in the failure line.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('genA')).toBe('bound');
    expect(reg.beginRetire('genA')).toBe('authorized');
    reg.adapterCycles();
    reg.cancelIssue('genA');
    reg.cancelReturns('genA');
    const intruder = reg.attach('genB');
    reg.cancelEffect('genA');
    expect(`refused:${intruder === 'refused'} casualties:${reg.casualties.join(',')}`).toBe(
      'refused:true casualties:',
    );
    // AND THE RECOVERY IS THE OTHER HALF, because a fence that never opens
    // is an outage: T1 arrives — the exact object, on A's own manager —
    // and only then is the lease spent. The epoch turned underneath it, so
    // the record is released outright and B's backoff redials into a free
    // address.
    reg.disconnectTerminal('genA');
    expect(reg.log).toContain('terminal-disconnect:genA');
    expect(reg.log).toContain('finalize-release:genA');
    expect(reg.owner).toBeNull();
    expect(reg.attach('genB')).toBe('bound');
    expect(reg.casualties).toEqual([]);
  });

  test('T1 is AN OBJECT AND A MANAGER, not a callback family', () => {
    // Mutation: complete the lease on any didDisconnect that arrives. A
    // retiring generation's manager can carry more than one link's worth
    // of history, and another object's teardown — or the right object's,
    // reported by somebody else's manager — says nothing whatever about
    // whether OUR cancel has landed.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('genA')).toBe('bound');
    expect(reg.beginRetire('genA')).toBe('authorized');
    reg.adapterCycles();
    reg.cancelIssue('genA');
    reg.cancelReturns('genA');
    reg.disconnectTerminal('genA', 'other', 'own');
    reg.disconnectTerminal('genA', 'exact', 'other');
    const intruder = reg.attach('genB');
    reg.cancelEffect('genA');
    expect(
      `ignored:${reg.log.filter((l) => l === 'terminal-ignored:genA').length}` +
        ` refused:${intruder === 'refused'} casualties:${reg.casualties.join(',')}`,
    ).toBe('ignored:2 refused:true casualties:');
    // …and the right object on the right manager still completes it.
    reg.disconnectTerminal('genA', 'exact', 'own');
    expect(reg.owner).toBeNull();
    expect(reg.attach('genB')).toBe('bound');
  });

  test('T2 — already `.disconnected` at issue owes no terminal; `.disconnecting` does', () => {
    // The one synchronous road out, and its boundary. A cancel on an
    // object that holds no link is a no-op, so there is no effect that
    // could ever land and nothing to wait for. A `.disconnecting` object
    // is the opposite case wearing a similar word: a teardown ALREADY in
    // flight is precisely an effect that has not landed.
    const q = quarantineOf(sw);
    const cold = new ObjectRegister(q);
    cold.attach('genA');
    cold.beginRetire('genA');
    cold.cancelIssue('genA', 'disconnected');
    expect(cold.log).toContain('terminal-none:genA');
    expect(cold.owner).toEqual({ by: 'genA', state: 'tombstoned' });
    expect(cold.casualties).toEqual([]);

    const going = new ObjectRegister(q);
    going.attach('genA');
    going.beginRetire('genA');
    going.cancelIssue('genA', 'disconnecting');
    going.cancelReturns('genA');
    expect(going.attach('genB')).toBe('refused');
    expect(going.owner).toEqual({ by: 'genA', state: 'retiring' });
    going.cancelEffect('genA');
    going.disconnectTerminal('genA');
    expect(going.owner).toEqual({ by: 'genA', state: 'tombstoned' });
    expect(going.casualties).toEqual([]);
  });

  test('THE WEDGE — a terminal that never comes POISONS the record, it does not free it', () => {
    // T4, and the reason it must exist: a stack that wedges without
    // delivering its disconnect would otherwise hold this address for the
    // life of the process. The recheck re-reads the object and re-issues
    // the cancel on a fixed budget; when the budget is out the record is
    // POISONED, which is fail-closed — no adapter reset, no epoch turn and
    // no late straggler may hand it to the next dial.
    //
    // Mutation: delete T4 and the lease waits forever on a terminal that
    // is not coming. Mutation: let a reset free a poisoned record and the
    // wedge becomes the casualty it was standing in front of.
    const q = quarantineOf(sw);
    const reg = new ObjectRegister(q);
    expect(reg.attach('genA')).toBe('bound');
    expect(reg.beginRetire('genA')).toBe('authorized');
    reg.cancelIssue('genA');
    reg.cancelReturns('genA');
    const walk: string[] = [];
    for (let i = 0; i <= q.recheckBudget + 1; i += 1) {
      walk.push(reg.recheckTick('genA'));
    }
    expect(
      `first:${walk[0]} recancels:${walk.filter((w) => w === 'recancel').length}` +
        ` last:${walk[walk.length - 1]}`,
    ).toBe(`first:recancel recancels:${q.recheckBudget} last:poison`);
    expect(reg.log).toContain('lease-poison:genA');
    // FAIL CLOSED, AND IT STAYS THAT WAY across every radio cycle the
    // camper can produce.
    expect(reg.attach('genB')).toBe('refused');
    reg.adapterCycles();
    expect(reg.attach('genB')).toBe('refused');
    reg.adapterCycles();
    expect(reg.attach('genB')).toBe('refused');
    // …and a late T1 does not lift it either: the disconnect this
    // generation gave up waiting for proves nothing about a teardown the
    // stack may still be sitting on.
    reg.disconnectTerminal('genA');
    expect(reg.log).toContain('terminal-dup:genA');
    expect(reg.attach('genB')).toBe('refused');
    // THE FIRST OF THE TWO ROADS OUT: the exact object dies, the weak box
    // empties, and a dead object has no link left for anybody's cancel to
    // kill. B's backoff redials into a free address.
    reg.objectDies();
    expect(reg.attach('genB')).toBe('bound');
    expect(reg.casualties).toEqual([]);
  });

  test('THE OTHER ROAD OUT OF A POISON — a proven poweredOff, and nothing weaker', () => {
    // T3, and its narrowness is the point: `.poweredOff` on this
    // generation's own manager is the physical death of every link it
    // held. `.resetting`, `.unknown` and `.unauthorized` say nothing about
    // any link, and a generic epoch turn says nothing at all.
    const q = quarantineOf(sw);
    const reg = new ObjectRegister(q);
    reg.attach('genA');
    reg.beginRetire('genA');
    reg.cancelIssue('genA');
    reg.cancelReturns('genA');
    for (let i = 0; i <= q.recheckBudget + 1; i += 1) {
      reg.recheckTick('genA');
    }
    expect(reg.log).toContain('lease-poison:genA');
    for (const weak of ['resetting', 'unknown', 'unauthorized'] as const) {
      reg.stateTerminal('genA', weak);
      expect(`${weak}:${reg.attach('genB')}`).toBe(`${weak}:refused`);
    }
    reg.adapterCycles();
    expect(reg.attach('genB')).toBe('refused');
    reg.stateTerminal('genA', 'poweredOff');
    expect(reg.log).toContain('terminal-poweroff:genA');
    expect(reg.owner).toBeNull();
    expect(reg.attach('genB')).toBe('bound');
    // The radio went off: the teardown A booked can no longer reach
    // anybody, so nothing lands on B afterwards.
    reg.cancelEffect('genA');
    expect(reg.casualties).toEqual([]);
  });

  test('A LATE DUPLICATE TERMINAL IS A NO-OP, never a second transition', () => {
    // Mutation: delete the ticket check and every straggler re-runs the
    // completion. The dangerous one is T1 after T4's poison — it lifts a
    // record that was fail-closed precisely because nobody could prove the
    // teardown had landed, and the teardown then lands on whoever took the
    // address in the meantime.
    const q = quarantineOf(sw);
    const wedged = new ObjectRegister(q);
    wedged.attach('genA');
    wedged.beginRetire('genA');
    wedged.cancelIssue('genA');
    wedged.cancelReturns('genA');
    for (let i = 0; i <= q.recheckBudget + 1; i += 1) {
      wedged.recheckTick('genA');
    }
    wedged.adapterCycles();
    wedged.disconnectTerminal('genA');
    const intruder = wedged.attach('genB');
    wedged.cancelEffect('genA');
    expect(
      `dup:${wedged.log.includes('terminal-dup:genA')} refused:${intruder === 'refused'}` +
        ` casualties:${wedged.casualties.join(',')}`,
    ).toBe('dup:true refused:true casualties:');

    // …and the ordinary double delivery, with a poweredOff behind it, is
    // the same no-op one state along: by then the address belongs to
    // somebody else and nothing about it is A's to transition.
    const twice = new ObjectRegister(q);
    twice.attach('genA');
    twice.runRetire('genA');
    expect(twice.owner).toEqual({ by: 'genA', state: 'tombstoned' });
    twice.objectDies();
    expect(twice.attach('genB')).toBe('bound');
    twice.disconnectTerminal('genA');
    twice.stateTerminal('genA', 'poweredOff');
    expect(twice.log.filter((l) => l === 'terminal-dup:genA').length).toBe(2);
    expect(twice.owner).toEqual({ by: 'genB', state: 'claimed' });
    expect(twice.casualties).toEqual([]);
  });

  test('POSITIVE CONTROL — the ordinary retirement still ends where 9717080 ended', () => {
    // Six phases now instead of three, and the outcome of the one every
    // teardown in the field actually runs must not have moved: a tombstone
    // that stands until the object dies. STATED IN THE VOCABULARY EVERY
    // BUILD SHARES, so this arm passes under every plant below — what it
    // isolates is that the terminal did not change the ordinary path.
    const reg = new ObjectRegister(quarantineOf(sw));
    expect(reg.attach('gen1')).toBe('bound');
    reg.runRetire('gen1');
    expect(reg.log).toContain('retire-cancel:gen1');
    expect(reg.owner).toEqual({ by: 'gen1', state: 'tombstoned' });
    expect(reg.casualties).toEqual([]);
    expect(reg.attach('gen2')).toBe('refused');
    reg.objectDies();
    expect(reg.attach('gen2')).toBe('bound');
  });

  test('the terminal table, read out of the Swift', () => {
    // The shape half. Each row names the mutation it dies on, and between
    // them they are the ruling: the lease lives to a proven terminal (T1
    // exact object + own manager, T2 disconnected-at-issue only, T3
    // observed poweredOff only, T4 bounded then poisoned), the retiring
    // generation keeps what T1 needs to arrive at, poison outlives every
    // epoch, and every completion is ticket-idempotent.
    const q = quarantineOf(sw);
    for (const [name, held] of [
      ['leaseHeldThroughTerminal', q.leaseHeldThroughTerminal],
      ['terminalIsExactObjectOnOwnManager', q.terminalIsExactObjectOnOwnManager],
      ['keepsManagerThroughLease', q.keepsManagerThroughLease],
      ['fastPathOnlyDisconnected', q.fastPathOnlyDisconnected],
      ['powerOffIsTheOnlyStateTerminal', q.powerOffIsTheOnlyStateTerminal],
      ['boundedRecheckThenPoison', q.boundedRecheckThenPoison],
      ['poisonHoldsThroughEpoch', q.poisonHoldsThroughEpoch],
      ['terminalIsTicketIdempotent', q.terminalIsTicketIdempotent],
    ] as const) {
      expect(`${name}:${held}`).toBe(`${name}:true`);
    }
    // The budget is a real, small, fixed number of looks — not a retry
    // loop with no floor and not a single glance.
    expect(q.recheckBudget).toBeGreaterThan(0);
    expect(q.recheckBudget).toBeLessThanOrEqual(8);
    // THE SPEND HAS EXACTLY ONE DOOR, and the register's third step has
    // exactly one caller: a second spelling of "finalize" is a second
    // lease protocol wearing the same name.
    expect((sw.match(/BleObjectQuarantine\.shared\.finalizeRetire\(/g) ?? []).length).toBe(1);
    expect((sw.match(/private func spendLease\(/g) ?? []).length).toBe(1);
    // …and its three callers are the three terminals, and nothing else.
    const callers = (sw.match(/spendLease\([^)]*\n?[^)]*why: "[a-z-]+"/g) ?? []).map(
      (m) => /why: "([a-z-]+)"/.exec(m)?.[1],
    );
    expect(callers.sort()).toEqual([
      'did-disconnect',
      'disconnected-at-issue',
      'power-off',
      'recheck-disconnected',
    ]);
    // A RETIRING GENERATION ROUTES LEASE COMPLETION AND NOTHING ELSE. Both
    // handlers still ask their own retirement FIRST — the ruling every
    // late callback in this file is fenced by — and the retired branch of
    // each does exactly one thing.
    for (const body of [handlerBody(sw, 'disconnected'), genStateBody(sw)]) {
      expect(provenanceOf(firstAsk(body))).toBe('own-retirement');
    }
    expect(handlerBody(sw, 'disconnected')).toMatch(
      /guard !retired else \{[\s\S]*_ = noteLeaseTerminal\(peripheral, central: central\)\n\s*return\n\s*\}/,
    );
    expect(genStateBody(sw)).toMatch(
      /guard !retired else \{[\s\S]*if central\.state == \.poweredOff \{\n\s*_ = noteLeasePowerOff\(central\)\n\s*\}\n\s*return\n\s*\}/,
    );
    // THE HOLD IS BOUNDED, which is what keeps "keep the manager alive"
    // from becoming the wedge: it is dropped on every road out of the
    // lease, and T4's budget guarantees one of them is taken.
    expect((sw.match(/leaseHold = nil/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(genSpendBody(sw)).toMatch(/leaseHold = nil/);
    expect(genRecheckBody(sw)).toMatch(/leaseHold = nil/);
  });
});

describe('BEHAVIOUR — a fresh manager hands back the OLD object', () => {
  const sw = readVoiceSource();

  test('the exact object of a still-live retired link is REFUSED, not reused', () => {
    // THE ASSUMPTION THIS WHOLE SHAPE RESTS ON, checked instead of
    // trusted. If CoreBluetooth vends the same CBPeripheral to a fresh
    // manager, the new link inherits the old link's delegate seat and its
    // outstanding operations — the bug wearing the cure's clothes.
    // Mutation: delete the quarantine, or check it AFTER `per.delegate =
    // self`, and the dial binds.
    expect(
      dialOutcome(sw, {
        sameObjectAsRetired: true,
        objectDied: false,
        adapterCycled: false,
        restarted: false,
      }),
    ).toBe('refused');
  });

  test('POSITIVE CONTROL — a fresh object dials immediately', () => {
    // The ordinary case, which is nearly every case: a refusal that fires
    // on healthy dials is a rung that never lists anybody.
    expect(
      dialOutcome(sw, {
        sameObjectAsRetired: false,
        objectDied: false,
        adapterCycled: false,
        restarted: false,
      }),
    ).toBe('bound');
  });

  test('the two release conditions, and only those two', () => {
    // Mutation: hold strongly. The quarantine then keeps alive the very
    // thing whose death is the release, and a peer becomes permanently
    // undialable — the wedge, caused by the cure. Mutation: never turn the
    // epoch over, and an adapter cycle leaves every address held by an
    // object that can no longer mean anything to the stack.
    //
    // Each release is asserted as a PAIR against the same world with the
    // release withheld, so a build with no quarantine at all fails here
    // instead of passing on a trivially-bound dial.
    const held = {
      sameObjectAsRetired: true,
      objectDied: false,
      adapterCycled: false,
      restarted: false,
    };
    expect(dialOutcome(sw, held)).toBe('refused');
    expect(dialOutcome(sw, { ...held, objectDied: true })).toBe('bound');
    expect(dialOutcome(sw, { ...held, adapterCycled: true })).toBe('bound');
  });

  test('an immediate stop/start does NOT release a tombstone', () => {
    // Closing the walkie and reopening it is exactly the gesture a camper
    // makes when the channel looks wrong, and the OS's objects do not
    // restart with us. Mutation: clear the quarantine in stop(), or hang
    // it off WalkieBleVoice so a new instance starts empty — and the one
    // path that needs the fence is the one path without it.
    expect(
      dialOutcome(sw, {
        sameObjectAsRetired: true,
        objectDied: false,
        adapterCycled: false,
        restarted: true,
      }),
    ).toBe('refused');
    // …and the reason it survives is that it does not belong to the module.
    expect(sw).toMatch(/static let shared = BleObjectQuarantine\(\)/);
    expect(stopBody(sw)).not.toMatch(/BleObjectQuarantine/);
    const own = sw.indexOf('final class BleObjectQuarantine {');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(sw.indexOf('final class WalkieBleVoice: NSObject {'));
  });
});

describe('BEHAVIOUR — invalidation, adapter phases, and the close', () => {
  const sw = readVoiceSource();

  test('didModifyServices retires the WHOLE generation', () => {
    // The far end rebuilt its GATT table under us, so every characteristic
    // this generation holds is a stale handle — and a stale handle is not
    // a link. Mutation: re-discover into the live object and the mutable
    // -slot shape is back, one API further down: the same generation now
    // holds pipes from two different service tables.
    const body = handlerBody(sw, 'services-modified');
    expect(body).not.toEqual('');
    expect(body).toContain('generationFailed(self, "services-modified")');
    expect(body).not.toMatch(/discoverServices|discoverCharacteristics/);
  });

  test('the adapter going down retires every link and turns the epoch over', () => {
    // Mutation: leave the generations running. Their managers are still
    // holding objects the stack has already forgotten, and the peers that
    // read `ready` through them stay listed on a radio that is off.
    // Mutation: forget the epoch and every address stays quarantined
    // behind an object nothing will ever release.
    const ext = bodyOf(sw, 'extension WalkieBleVoice: CBCentralManagerDelegate {', '\n}\n');
    const off = ext.indexOf('case .poweredOff, .unauthorized, .resetting:');
    expect(off).toBeGreaterThan(-1);
    const retire = ext.indexOf('retireAll("adapter-off")');
    const clear = ext.indexOf('voicePeers.removeAll()');
    const epoch = ext.indexOf('BleObjectQuarantine.shared.adapterReset()');
    expect(retire).toBeGreaterThan(off);
    expect(clear).toBeGreaterThan(retire);
    expect(epoch).toBeGreaterThan(retire);
    // A peer that was listed leaves the channel honestly.
    expect(sw).toMatch(/func retireAll\(_ why: String\) \{[\s\S]{0,600}onPeerLost\(p\.key\)/);
    // …and the retirement is the ONE road: retireAll goes through
    // link.retire, never around it.
    expect(sw).toMatch(/p\.link = nil\n\s*link\.retire\(why\)/);
  });

  test('closing the walkie retires every generation too', () => {
    // Mutation: drop retireAll from stop() and every open generation
    // survives the close holding a manager, a delegate seat and a live
    // connection — the leak that made "stop then start" a way to run two
    // rungs at once.
    const body = stopBody(sw);
    expect(body).toContain('retireAll("stop")');
    expect(body.indexOf('retireAll("stop")')).toBeLessThan(
      body.indexOf('voicePeers.removeAll()'),
    );
  });
});

/**
 * THE READY-LINK WATCHDOG, ON THE PHONE THAT COULD NOT HAVE ONE.
 *
 * b7b5389 mirrored the Android watchdog above onto the Swift and was
 * reverted four rounds later, and the reason was never the watchdog: it
 * was that a deadline living on the peer entry OUTLIVES ITS LINK, so a
 * dead generation's timer could demote a live one. 0628ea9 said it in
 * plain words — "an iPhone whose podmate walks out of range can once again
 * hold a dead outgoing link ... until something else tears the connection
 * down" — and banked the shape that would make it safe.
 *
 * On the substrate above, the watchdog is the LINK'S: its tick, its
 * deadline and its refusal budget are minted with the generation and die
 * with it. Android has to reset that state in dropClient because its peer
 * entry outlives its links; here there is nothing to reset, and that is
 * not an omission but the point.
 *
 * The behavioural half runs the SAME model the Android half runs, told how
 * the Swift behaves rather than what the answer should be.
 */

/**
 * TOTAL, on purpose — no `expect` outside a test. A file that carries no
 * watchdog carries no constants either, and a reader that throws at
 * collection time makes the whole suite FAIL TO RUN rather than fail,
 * which is the one outcome that teaches nobody anything (and is exactly
 * what happened the first time this was pointed at 0628ea9's file).
 * Absence reads as zero here and is asserted inside a test below.
 */
const iosMs = (sw: string, name: string): number => {
  const m = new RegExp(`static let ${name}: TimeInterval = (\\d+)`).exec(sw);
  return m === null ? 0 : Number(m[1]) * 1000;
};

const iosBounds = (sw: string): Bounds => ({
  windowMs: iosMs(sw, 'livenessWindow'),
  timeoutMs: iosMs(sw, 'livenessProbeTimeout'),
  tickMs: iosMs(sw, 'livenessTick'),
  tries: Number(/static let livenessProbeTries = (\d+)/.exec(sw)?.[1] ?? 0),
});

const probeBody = (sw: string): string =>
  /private func probeLiveness\(\) \{[\s\S]*?\n {2}\}\n/.exec(sw)?.[0] ?? '';

/** How the real Swift arms its deadline — read, never assumed. */
const iosArming = (sw: string): ProbeArming => {
  const probe = probeBody(sw);
  if (probe === '') {
    return 'no-watchdog';
  }
  const refused = probe.indexOf('guard per.state == .connected else');
  const arm = probe.indexOf('probePending = true');
  return refused > -1 && arm > refused ? 'accepted-only' : 'armed-always';
};

describe('the iPhone asks a ready link to prove it, on the LINK’s own clock', () => {
  const sw = readVoiceSource();
  const kt = readLinkSource();

  test('the two phones agree on all four bounds, to the number', () => {
    // Mutation: change one constant on one side. The rung then disagrees
    // with itself about how long a silence means death — the drift class
    // that costs a conversation at camp and cannot be debugged there.
    // Mutation: delete them (0628ea9's file) — absence reads as zero, and
    // is a failure here rather than a suite that cannot start.
    for (const [name, ms] of Object.entries(iosBounds(sw))) {
      expect(`${name}:${ms > 0}`).toBe(`${name}:true`);
    }
    expect(iosBounds(sw)).toEqual(androidBounds(kt));
    expect(iosBounds(sw).windowMs).toBeGreaterThan(iosBounds(sw).timeoutMs);
    expect(iosBounds(sw).timeoutMs).toBeGreaterThan(iosBounds(sw).tickMs);
  });

  test('the whole watchdog lives on the GENERATION, not on the peer', () => {
    // THE REASON THIS CAN EXIST HERE AT ALL, and the exact thing four
    // reverted rounds got wrong. Mutation: move any of these onto
    // VoicePeer and a deadline armed by a dead link can demote the live
    // one that replaced it — which is the finding that took the watchdog
    // back out on 0628ea9.
    const gen = sw.slice(
      sw.indexOf('final class BleLinkGeneration: NSObject {'),
      sw.indexOf("// ---------------------------------------- the generation's manager seat"),
    );
    const peer = sw.slice(
      sw.indexOf('final class VoicePeer {'),
      sw.indexOf('// ------------------------------------------------------- the coordinator'),
    );
    for (const field of ['lastProof', 'probePending', 'probeAt', 'probeRefusals']) {
      expect(`${field}@gen:${gen.includes(field)}`).toBe(`${field}@gen:true`);
      expect(`${field}@peer:${peer.includes(field)}`).toBe(`${field}@peer:false`);
    }
    // A NEW LINK IS A NEW BUDGET, and it costs nothing to say so: the
    // state dies with the object. Mutation: reintroduce a reset in
    // dropClient and the reset is evidence the state moved back onto
    // something that outlives a link.
    expect(bodyOf(sw, 'private func dropClient(_ peer: VoicePeer, _ why: String) {')).not.toMatch(
      /probeRefusals|probePending|lastProof/,
    );
    // The tick belongs to the generation and stops when it retires.
    expect(sw).toMatch(
      /private func scheduleLiveness\(\) \{\n\s*queue\.asyncAfter\(deadline: \.now\(\) \+ WalkieBleVoice\.livenessTick\)/,
    );
    expect(sw).toMatch(/guard let self, !self\.retired else \{ return \}\n\s*self\.livenessTick\(\)\n\s*self\.scheduleLiveness\(\)/);
  });

  test('a link is born proven, and the arming order is collect-then-ask', () => {
    // Mutation: leave lastProof at zero and every link owes a probe the
    // instant it is listed — identity paid for in audio, on every dial.
    expect(sw).toMatch(/ready = true\n[\s\S]{0,400}lastProof = ProcessInfo\.processInfo\.systemUptime\n\s*scheduleLiveness\(\)/);
    // Mutation: ask before collecting and every probe gets a free extra
    // tick before anyone checks it — the deadline is then always one tick
    // longer than the constant says.
    const tick = bodyOf(sw, 'private func livenessTick() {');
    expect(tick).not.toEqual('');
    expect(tick.indexOf('if probePending {')).toBeLessThan(
      tick.indexOf('livenessWindow {'),
    );
  });

  test('only a read the stack ACCEPTED arms the deadline', () => {
    // THE CURE'S OWN DEFECT, on this phone. Mutation: arm above the
    // refusal check and a link that is merely busy is demoted six seconds
    // later — a phone falling off the channel mid-sentence for the crime
    // of having audio on its link.
    expect(iosArming(sw)).toBe('accepted-only');
    const probe = probeBody(sw);
    expect(probe.indexOf('guard per.state == .connected else')).toBeLessThan(
      probe.indexOf('probePending = true'),
    );
    // Mutation: drop the budget and a stack that will never accept a read
    // is immortal — the wedge this whole watchdog exists to catch, made
    // permanent by its own refusal branch.
    expect(probe).toMatch(/probeRefusals >= WalkieBleVoice\.livenessProbeTries/);
    // Mutation: demote a busy link on the spot. The refusal costs a turn
    // and nothing else, and it SAYS so — a busy stack and a wedged one
    // read identically from the outside without this line.
    expect(probe).toContain('liveness-busy gen=');
    // Mutation: probe a link whose pipe has gone missing. Not a link.
    expect(probe).toContain('reason=no-pipe');
  });

  test('the proof stamp sits BELOW the pod and identity gate', () => {
    // Mutation: stamp at the top of handleIdent. A wrong phone answering
    // on a rotated address then RENEWS a link it has nothing to do with —
    // the watchdog's own memo, forged.
    const ident = bodyOf(sw, 'fileprivate func handleIdent(_ gen: BleLinkGeneration, _ value: Data?) {');
    expect(ident).not.toEqual('');
    expect(ident.indexOf('be32(b, 2) == podHash')).toBeLessThan(
      ident.indexOf('gen.noteProof()'),
    );
    expect(ident.indexOf('sender != peer.hash')).toBeLessThan(ident.indexOf('gen.noteProof()'));
    // …and the stamp is the ONLY thing a re-read does.
    expect(ident).toMatch(/if peer\.ready \{[\s\S]{0,600}gen\.noteProof\(\)\n\s*return\n\s*\}/);
  });

  test('"Look again" probes a ready link, and collects on an overdue one', () => {
    // Mutation: step over ready links (the pre-2026-08-27 shape). The
    // camper taps this control BECAUSE the channel looks wrong, and the
    // only rows that can be wrong are the ones claiming to be fine.
    const look = bodyOf(sw, 'func lookAgain() {');
    expect(look).not.toEqual('');
    expect(look).toContain('probeLiveness()');
    expect(look).toContain('via=look-again');
    expect(look).toMatch(/probeAt >= WalkieBleVoice\.livenessProbeTimeout/);
    // Mutation: drop the ready branch from refresh() and lookAgain is
    // dead code — a control that resolves and does nothing.
    const refresh = bodyOf(sw, 'func refresh() {');
    expect(refresh).toMatch(/if p\.ready \{[\s\S]{0,700}p\.link\?\.lookAgain\(\)/);
    // …and a NOT-connected peer still gets its backoff cleared, which is
    // the other half of what the control promises.
    expect(refresh).toMatch(/\} else if !p\.connecting \{\n\s*p\.backoff = Self\.connectBackoffBase/);
  });
});

describe('BEHAVIOUR — ten minutes of iPhone voice, on the real constants', () => {
  const sw = readVoiceSource();
  const arming = iosArming(sw);
  // A file with no watchdog has no bounds to build a trace from, and a
  // suite that cannot build its trace fails to RUN instead of failing. So
  // the trace is laid out on Android's bounds when the Swift carries none;
  // the ARMING RULE — read out of the Swift, and 'no-watchdog' for such a
  // file — is what decides every outcome below.
  const bounds = arming === 'no-watchdog' ? androidBounds(readLinkSource()) : iosBounds(sw);

  test('a peer that answers every probe is NEVER demoted', () => {
    // The floor, and the arm the reviewer named: ten minutes of healthy
    // voice must log zero demotions. Against 0628ea9's file this passes
    // for the wrong reason (nothing probes at all), which is why the
    // demote arms below exist beside it.
    const ticks = Math.ceil((10 * 60_000) / bounds.tickMs);
    const run = runWatchdog(quiet(ticks), arming, bounds);
    expect(run.ready).toBe(true);
    expect(run.log).not.toContain('liveness-lost');
    expect(run.log).toContain('proof');
  });

  test('a BUSY stack costs a turn, not the conversation', () => {
    // Ten minutes of talk on a stack that refuses every other probe.
    // Under the cured rule the link survives every one; under the rule
    // Android had to replace, the healthy peer is dropped — asserted so
    // the trace is proved to DISCRIMINATE rather than be survivable.
    const ticks = Math.ceil((10 * 60_000) / bounds.tickMs);
    const flaky: StackTick[] = new Array(ticks)
      .fill(null)
      .map((_, i) => (i % 2 === 0 ? busy : talking));
    const run = runWatchdog(flaky, arming, bounds);
    expect(run.ready).toBe(true);
    // SURVIVED BECAUSE IT WAS ASKED AND ANSWERED, not because nothing
    // happened: a file with no watchdog keeps every link alive trivially,
    // and this arm must tell the two apart.
    expect(run.log).toContain('liveness-busy');
    expect(run.log).toContain('proof');
    const before = runWatchdog(flaky, 'armed-always', bounds);
    expect(before.ready).toBe(false);
    expect(before.log).toContain('liveness-lost');
  });

  test('an ACCEPTED read with no answer DEMOTES the link', () => {
    // THE WHOLE POINT, and the thing 0628ea9's file cannot do: a wedged
    // one-way pipe used to last forever on this phone, because `ready`
    // stayed true and every healing path was gated behind it.
    const trace = traceWith(bounds, silent, 9);
    const run = runWatchdog(trace, arming, bounds);
    expect(run.ready).toBe(false);
    expect(run.log).toContain('liveness-lost');
  });

  test('a refused read followed by an accepted one survives the deadline', () => {
    const trace = traceWith(bounds, busy, 9);
    const run = runWatchdog(trace, arming, bounds);
    expect(run.ready).toBe(true);
    expect(run.log).toContain('liveness-busy');
    expect(run.log).not.toContain('liveness-lost');
  });

  test('a stack that will not accept ANY read still loses the link', () => {
    // "Busy" must stay bounded, or the refusal branch is a new way to be
    // immortal. And it must take LONGER than an accepted read's deadline:
    // a refusal is weaker evidence than silence on a read that went out.
    const wedged = [...quiet(firstProbe(bounds)), ...new Array(30).fill(busy)];
    const run = runWatchdog(wedged, arming, bounds);
    expect(run.ready).toBe(false);
    expect(run.log).toContain('liveness-lost');
    const refusalTicks = run.log.filter((l) => l === 'liveness-busy').length;
    expect(refusalTicks * bounds.tickMs).toBeGreaterThan(bounds.timeoutMs);
  });

  test('and a demotion runs through the ONE road out of a link', () => {
    // Mutation: demote by clearing `ready` on the generation. The peer
    // would then read not-ready with the link still attached, its manager
    // still holding an object and its row still on screen — a demotion
    // that heals nothing, which is the pre-b7b5389 state wearing a
    // watchdog's clothes.
    expect(probeBody(sw)).toMatch(/owner\?\.generationFailed\(self, "liveness-lost"\)/);
    expect(bodyOf(sw, 'private func livenessTick() {')).toMatch(
      /owner\?\.generationFailed\(self, "liveness-lost"\)/,
    );
    expect(sw).not.toMatch(/ready = false\n\s*\/\/ demote/);
  });
});

/**
 * THE ADVERTISER'S EFFECT, and it is the advertiser-side half of the same
 * ruling the lease block above carries. The cross-family no-go on 6a5274e,
 * verbatim:
 *
 *   "Native stop promise resolves before WalkieBleVoice queued advertiser
 *   stop effect, so JS release can restart crew advertising while walkie
 *   advert still active; source mock cannot prove effect ordering—native
 *   completion ack/arm required."
 *
 * And the shape it was bound to, verbatim:
 *
 *   "Walkie.stop promise must resolve only after the WalkieBleVoice owning
 *   queue proves server absent/poweredOff or isAdvertising==false; merely
 *   enqueueing/calling stopAdvertising is still issue, not effect. If proof
 *   cannot arrive, fail closed—do not release CrewBeacon advertising into
 *   overlap."
 *
 * WHY THIS IS THE SAME BUG ONE ROLE ALONG. The lease taught that
 * `cancelPeripheralConnection` is an ISSUE: it returns having asked, and
 * the casualty of a teardown is decided at the EFFECT. `stopAdvertising`
 * is that call in the peripheral role, and the promise above it was
 * settling at the ask. The consequence is not a stranded object this time
 * but an OVERLAP: walkieSession sequences the crew beacon's release behind
 * this exact promise, so a promise that means "asked" puts CrewBeacon's
 * advertiser back up while rung 3's is still radiating — two 128-bit UUIDs
 * in one 31-byte packet, the service UUIDs into CoreBluetooth's overflow
 * area, and every Android scan filter matching nothing. That is the
 * measured 2026-08-26 defect (walkieAirtime.test.ts holds the bench),
 * re-created by the teardown built to prevent it.
 *
 * THE MODEL'S SEAM, stated because the reviewer named it: a source mock
 * cannot prove effect ordering, so nothing below asserts that a mocked
 * `stopAdvertising` was called. The three-file read produces a SHAPE — where
 * the promise settles, which facts complete it, what the budget's
 * exhaustion does, and whether the JS release is gated on the answer — and
 * the shape is then STEPPED against radios that behave the way
 * CoreBluetooth does: a flag that lags its own stop, an adapter that is
 * off, a manager that was never built, and a stack that never goes quiet
 * at all. Point the stepper at the pre-fix shape and the healthy-looking
 * close releases the crew beacon into a live walkie advert, which is the
 * finding, executable.
 */

const readWalkieModuleSource = (): string =>
  require('fs').readFileSync('ios/PlayaPal/Walkie.swift', 'utf8') as string;
const readAdapterSource = (): string =>
  require('fs').readFileSync('src/crews/walkie.ts', 'utf8') as string;
const readSessionSource = (): string =>
  require('fs').readFileSync('src/crews/walkieSession.ts', 'utf8') as string;

/** A TimeInterval that may carry a fraction — the lease's reader cannot. */
const iosSeconds = (sw: string, name: string): number => {
  const m = new RegExp(`static let ${name}: TimeInterval = ([0-9.]+)`).exec(sw);
  return m === null ? 0 : Math.round(Number(m[1]) * 1000);
};

/** WHERE THE JS-VISIBLE PROMISE SETTLES — read out of the bridge, never
 *  assumed. 'issue' is the pre-fix shape: the teardown is posted and the
 *  promise resolves on the next line. */
type Settle = 'proof' | 'issue' | 'absent';

const bridgeStopBody = (w: string): string => bodyOf(w, '@objc(stop:rejecter:)');

const bridgeSettle = (w: string): Settle => {
  const code = codeOnly(bridgeStopBody(w));
  if (code === '') {
    return 'absent';
  }
  // THE BARRIER SHAPE (ARCHITECTURE ruling). The bridge takes the EXACT
  // lease it holds, clears its own field so a second tap cannot re-present
  // the same identity, tears down what nobody waits on, and then resolves
  // INSIDE the arbiter's completion — which fires only at a terminal.
  // Read positionally, because "resolve after asking" and "resolve when
  // answered" are the same characters in a different order and that
  // difference is the entire finding.
  const held = code.indexOf('let held = airtimeLease');
  const teardown = code.indexOf('stopInternal()');
  const ask = code.indexOf('Self.arbiter.stop(lease: held) {');
  const answer = code.indexOf('resolve([');
  const gated =
    held > -1 &&
    teardown > held &&
    ask > teardown &&
    answer > ask &&
    /"outcome": outcome\.rawValue/.test(code);
  if (gated) {
    return 'proof';
  }
  return code.includes('resolve(') ? 'issue' : 'absent';
};

/** WHERE THE OPERATION HANDLE LIVES, and it is the whole of arbiter
 *  addendum 1. A handle on the MODULE is one instance's opinion about
 *  what it is holding, and a stop clears it on the way in — so the second
 *  stop finds nil and has to reconstruct the answer from a book that is
 *  still empty. A handle on the LEASE outlives the instance. */
type Teardown = 'ble-completion' | 'immediate' | 'absent';

const teardownProof = (w: string): Teardown => {
  const teardown = codeOnly(bracedBody(w, 'private func stopInternal('));
  const mint = codeOnly(bracedBody(w, '  private func startBleVoice('));
  if (teardown === '' || mint === '') {
    return 'absent';
  }
  // The teardown may no longer answer for the advertiser at all: it drops
  // its own reference and nothing more.
  if (/proven\?\(/.test(teardown) || /ble\.stop \{/.test(teardown)) {
    return 'immediate';
  }
  return /Self\.arbiter\.armStart\(lease: leaseId, stopper: \{ settle in\n\s*ble\.stop \{ down, why in settle\(down, why\) \}\n\s*\}\)/.test(
    mint,
  )
    ? 'ble-completion'
    : 'absent';
};

/** The rung's own half of the proof, read out of WalkieBleVoice.swift. */
interface AdvertiserProof {
  /** Does the close hand its completion to the effect prover at all? */
  provedInClose: boolean;
  /** The facts that complete the proof, in the order the source asks. */
  facts: string[];
  /** What running out of looks does. */
  onBudgetOut: 'reject' | 'resolve' | 'absent';
  budget: number;
  tickMs: number;
  /** Is the `isAdvertising` read taken on a LATER turn of the owning
   *  queue — never in the same block as the stop it follows? */
  freshRead: boolean;
  /** Does an unproven look re-issue the stop, as T4 re-issues its cancel? */
  reIssues: boolean;
  /** Is the recheck posted to the OWNING queue? */
  onOwningQueue: boolean;
}

const proveBody = (sw: string): string =>
  bodyOf(sw, '  private func proveAdvertiserDown(');

const advertiserProofOf = (sw: string): AdvertiserProof => {
  const code = codeOnly(proveBody(sw));
  const close = codeOnly(stopBody(sw));
  const budgetBranch =
    /if tries >= WalkieBleVoice\.advertiserProofBudget \{([\s\S]*?)\n {4}\}/.exec(code);
  return {
    // The close hands its completion to the effect prover and NEVER
    // answers `true` on its own. It relays now rather than passing
    // `proven` straight through, because a proven advertiser of ITS OWN is
    // only half the question (see stopGate below) — but every road to
    // `true` still starts in the prover.
    provedInClose:
      /proveAdvertiserDown\(pm, tries: 0\) \{ down, why in/.test(close) &&
      !/proven\?\(true/.test(close),
    facts: [...code.matchAll(/proven\?\(true, "([a-z-]+)"\)/g)].map((m) => m[1]),
    onBudgetOut:
      budgetBranch === null
        ? 'absent'
        : /proven\?\(false,/.test(budgetBranch[1])
          ? 'reject'
          : 'resolve',
    budget: Number(/static let advertiserProofBudget = (\d+)/.exec(sw)?.[1] ?? 0),
    tickMs: iosSeconds(sw, 'advertiserProofTick'),
    freshRead: /if tries > 0, !mgr\.isAdvertising/.test(code),
    reIssues: /if tries > 0 \{\n\s*mgr\.stopAdvertising\(\)/.test(code),
    onOwningQueue:
      /queue\.asyncAfter\(deadline: \.now\(\) \+ WalkieBleVoice\.advertiserProofTick\)/.test(
        code,
      ),
  };
};

/**
 * A RADIO TO STEP THE SHAPE AGAINST. `quietAfter` is the turn of the
 * owning queue on which `isAdvertising` first reads false — turn 0 being
 * the close's own block, which is exactly the read CoreBluetooth is
 * documented to answer late. null is the stack that never goes quiet.
 */
interface Radio {
  hasManager: boolean;
  poweredOff: boolean;
  quietAfter: number | null;
}

interface Settlement {
  outcome: 'resolve' | 'reject';
  why: string;
  looks: number;
  /** Was rung 3's advertiser still on the air when the promise settled? */
  overlap: boolean;
}

const runNativeStop = (p: AdvertiserProof, r: Radio, settle: Settle): Settlement => {
  const airborne = (turn: number): boolean =>
    r.hasManager &&
    !r.poweredOff &&
    (r.quietAfter === null || turn < r.quietAfter);
  // THE PRE-FIX SHAPE, and the whole of the finding: the promise is the
  // ask's own next statement, so it settles on turn 0 whatever the radio
  // is doing.
  if (settle !== 'proof' || !p.provedInClose) {
    return { outcome: 'resolve', why: 'issue', looks: 0, overlap: airborne(0) };
  }
  for (let turn = 0; turn <= p.budget; turn += 1) {
    if (!r.hasManager) {
      return { outcome: 'resolve', why: 'absent', looks: turn, overlap: false };
    }
    if (r.poweredOff) {
      return { outcome: 'resolve', why: 'power-off', looks: turn, overlap: false };
    }
    const mayRead = p.freshRead ? turn > 0 : true;
    if (mayRead && !airborne(turn)) {
      return {
        outcome: 'resolve',
        why: 'not-advertising',
        looks: turn,
        overlap: false,
      };
    }
    if (turn >= p.budget) {
      return {
        outcome: p.onBudgetOut === 'reject' ? 'reject' : 'resolve',
        why: 'advertiser-still-up',
        looks: turn,
        overlap: airborne(turn),
      };
    }
  }
  /* istanbul ignore next — the loop above always returns at the budget. */
  return { outcome: 'reject', why: 'unreachable', looks: p.budget, overlap: true };
};

/** What walkie.ts does with a rejected native stop. */
type AdapterProof = 'reports-unproven' | 'swallows-all';

const adapterProof = (ts: string): AdapterProof => {
  const body = codeOnly(
    bodyOf(
      ts,
      'export async function stopWalkie(): Promise<WalkieStopOutcome> {',
      '\n}\n',
    ),
  );
  const decode = codeOnly(
    bodyOf(ts, 'export function decodeWalkieStop(e: unknown): WalkieStopOutcome {', '\n}\n'),
  );
  if (body === '' || decode === '') {
    // The void-returning shape swallowed every rejection, so nothing above
    // could ever tell a proven close from an unproven one.
    return 'swallows-all';
  }
  // THE FOUR WORDS, AND ONLY ONE OF THEM IS A CLOSE (S7). A rejection
  // tells this boundary nothing about the air, and an outcome from a wire
  // version it does not know tells it nothing either — both are
  // `unknown`, and unknown is never clear.
  return /catch \{[\s\S]*return \{ outcome: 'unknown'/.test(body) &&
    /if \(o\?\.v !== WALKIE_AIRTIME_WIRE\) \{\n\s*return \{ outcome: 'unknown'/.test(
      decode,
    ) &&
    /word !== 'clear' && word !== 'debt' && word !== 'notOwner'/.test(decode)
    ? 'reports-unproven'
    : 'swallows-all';
};

/** Whether the crew beacon's release is gated on that answer. */
type ReleaseGate = 'gated' | 'unconditional' | 'absent';

/** The public verb's own body — the duplicate-tap guard lives here. */
const sessionStopBody = (ts: string): string =>
  bodyOf(ts, 'async function doStopWalkieSession(): Promise<void> {', '\n}\n');

/** …and the ONE close both roads run (S8), where the hold is decided. */
const sessionCloseBody = (ts: string): string =>
  bodyOf(ts, 'async function endWalkieSession(): Promise<void> {', '\n}\n');

const releaseGate = (ts: string): ReleaseGate => {
  const code = codeOnly(sessionCloseBody(ts));
  if (!code.includes('releaseCrewAdvertising()')) {
    return 'absent';
  }
  // ONE WORD DECIDES. `clear` releases; `debt`, `notOwner` and `unknown`
  // all park, which is the whole of "unknown is never clear".
  return /const stop = await stopWalkie\(\);[\s\S]*if \(stop\?\.outcome === 'clear'\) \{\n\s*await releaseCrewAdvertising\(\)/.test(
    code,
  ) && /deferCrewRelease\(gen\);/.test(code)
    ? 'gated'
    : 'unconditional';
};

/** Does the close hand the advertising slot back to CrewBeacon? */
const releases = (
  settle: Settlement,
  proof: AdapterProof,
  gate: ReleaseGate,
): boolean => {
  const down =
    settle.outcome === 'reject' && proof === 'reports-unproven' ? false : true;
  return gate === 'gated' ? down !== false : true;
};

/** THE DEFECT ITSELF, as one boolean: the crew beacon went back on the air
 *  while rung 3's advertisement was still up. */
const overlapped = (
  settle: Settlement,
  proof: AdapterProof,
  gate: ReleaseGate,
): boolean => releases(settle, proof, gate) && settle.overlap;

/*
 * ---------------------------------------------------------------------
 * THE ADVERTISER DEBT — what a budget-out OWES, and who is still holding
 * the bag (advertiser-debt no-go, 2026-08-27, cross-family read of
 * 2edcc6a).
 *
 * 2edcc6a settles the stop at the advertiser's EFFECT and fails closed
 * when it cannot prove one. The ruling above accepts that proof and names
 * what it FORGETS:
 *
 *   "budget-out forgets advertiser A: Walkie clears bleVoice, JS skips
 *   hold release, duplicate stop early-exits, and new start has no debt
 *   gate. Result: mail hold can strand forever; B may start; closing
 *   proven B releases CrewBeacon while forgotten A may still radiate.
 *   Real seam arm: recovered=false, admittedNewAdvertiser=true."
 *
 * Four leaks off one root: `false` was treated as the END of the
 * obligation rather than its BEGINNING. The readers below pull the cure's
 * facts out of the four files that carry it — the debt book, the start
 * gate, the two stop roads, and the deferred JS release — and `Process`
 * steps them against a phone, so the seam is a script anyone can run
 * rather than a paragraph anyone can agree with.
 * ---------------------------------------------------------------------
 */

const debtBookBody = (sw: string): string =>
  bracedBody(sw, 'final class AdvertiserDebtBook {');
const debtOweBody = (sw: string): string => bracedBody(sw, 'func owe(');
const debtLookBody = (sw: string): string =>
  bracedBody(sw, 'private func look(_ id: Int');
const debtSettleBody = (sw: string): string =>
  bracedBody(sw, 'private func settle(_ id: Int');
const debtServiceBody = (sw: string): string =>
  bracedBody(sw, 'func service(within:');
const debtAdmitBody = (sw: string): string =>
  bracedBody(sw, 'func admitNewAdvertiser(');

/** What the process-lifetime debt book is, read out of the Swift. */
interface DebtBook {
  /** Does the type exist at all? */
  present: boolean;
  /** Does the fast prover's budget-out OPEN a debt — before it answers
   *  `false`, so there is no window with nothing watching? */
  owedOnBudgetOut: boolean;
  /** Does opening a debt settle it in the same breath? That is "budget
   *  false IS the terminal", which the ruling forbids by name. */
  budgetIsTerminal: boolean;
  /** Does opening a debt START the slow chain of looks? */
  chainStarted: boolean;
  /** Is the manager held STRONGLY? A weak box could not be asked. */
  holdsManagerStrongly: boolean;
  /** Does the record carry the queue the manager's state belongs to? */
  carriesProofIdentity: boolean;
  /** The terminals, in the order the source asks them. */
  terminals: string[];
  /** Does a look RE-ISSUE the stop, as T4's lease and the fast prover do? */
  reIssues: boolean;
  /** Is every read of a manager on that debt's OWN queue? */
  onOwningQueue: boolean;
  /** Does a reconcile re-drive at the FAST tick, and does its bounded
   *  refusal carry the code both sides agree on? */
  reconcileDrivesFast: boolean;
  boundedRefusal: boolean;
  /** Does the JS hop fire only when the LAST debt goes terminal? */
  hopOnLastOnly: boolean;
  /** Is a second terminal for one debt a no-op? */
  idempotentSettle: boolean;
  slowTickMs: number;
  reconcileMs: number;
}

const debtBookOf = (sw: string): DebtBook => {
  const cls = codeOnly(debtBookBody(sw));
  const owe = codeOnly(debtOweBody(sw));
  const look = codeOnly(debtLookBody(sw));
  const settled = codeOnly(debtSettleBody(sw));
  const service = codeOnly(debtServiceBody(sw));
  const prover = codeOnly(proveBody(sw));
  return {
    present: cls !== '',
    // The call is present in the prover AND precedes the completion, which
    // is the ordering the file argues for: opening the debt second would
    // leave a window in which JS has been told "unproven" and nothing in
    // this process is still watching. Read POSITIONALLY, not as one
    // literal, so that mutating the completion's POLARITY (which is the
    // effect block's own ARM (b)) does not also redden this one — a plant
    // that reddens two arms has proved nothing about either.
    owedOnBudgetOut: (() => {
      const owed = prover.indexOf('AdvertiserDebtBook.shared.owe(mgr, on: queue)');
      return owed > -1 && prover.indexOf('proven?(', owed) > owed;
    })(),
    budgetIsTerminal: owe !== '' && /settle\(/.test(owe),
    chainStarted: /look\(id, chain: 1, fast: false\)/.test(owe),
    holdsManagerStrongly:
      /let mgr: CBPeripheralManager/.test(cls) && !/weak var mgr/.test(cls),
    carriesProofIdentity: /let queue: DispatchQueue/.test(cls),
    terminals: [...look.matchAll(/settle\(id, "([a-z-]+)"\)/g)].map((m) => m[1]),
    reIssues: /debt\.mgr\.stopAdvertising\(\)/.test(look),
    onOwningQueue:
      /debt\.queue\.async \{/.test(look) && /debt\.queue\.asyncAfter\(/.test(look),
    reconcileDrivesFast: /look\(id, chain: chains\[id\] \?\? 0, fast: true\)/.test(
      service,
    ),
    boundedRefusal:
      /timers\.asyncAfter\(deadline: \.now\(\) \+ within\) \{/.test(service) &&
      /wake\(waiter, false, Self\.refusalCode\)/.test(service),
    // THE LAST DEBT, AND ONLY THE LAST, FOR THE WAITERS. The arbiter now
    // hears EVERY terminal (a state that only moves on the last one lies
    // about the two before it), so the last-only rule is read where it
    // still has to hold: the parked stops and reservations that gate on
    // the process owing nothing.
    hopOnLastOnly:
      /let clear = debts\.isEmpty/.test(settled) &&
      /if clear \{\n\s*woken = waiters\.filter/.test(settled) &&
      /hop\?\(why, clear\)/.test(settled),
    idempotentSettle: /guard debts\.removeValue\(forKey: id\) != nil else \{/.test(
      settled,
    ),
    slowTickMs: iosSeconds(sw, 'debtTick'),
    reconcileMs: iosSeconds(sw, 'reconcileWindow'),
  };
};

/** What minting a NEW advertiser does about the debts already on the book. */
type StartGate = 'reconcile-then-refuse' | 'ungated' | 'absent';

const reserveBody = (sw: string): string =>
  codeOnly(bracedBody(sw, '  func reserve(_ answer: @escaping (String?, String) -> Void) {'));

const startGateOf = (sw: string): StartGate => {
  const mint = codeOnly(bracedBody(sw, 'func start() {'));
  const reserve = reserveBody(sw);
  const admit = codeOnly(debtAdmitBody(sw));
  if (mint === '' || reserve === '') {
    return 'absent';
  }
  // THE ADMISSION MOVED, AND IT BECAME A WRITE (arbiter addendum 2). The
  // rung no longer asks the book on its own — that was a QUERY, and two
  // debt-free starts both passed it in the same turn. The arbiter mints a
  // lease UNDER ITS LOCK before it answers anybody, so the second caller
  // finds a lease rather than an answer.
  //
  // Read positionally: the write must precede the answer, or the window
  // this closes is still open.
  const busy = reserve.indexOf("answer(nil, \"busy\")");
  const write = reserve.indexOf('lease = l');
  const grant = reserve.indexOf('answer(l.id, "reserved")');
  const atomic = busy > -1 && write > -1 && grant > write;
  // …and a lease in the DEBT phase parks the caller and re-drives the
  // book, rather than refusing for the life of a wedge this very call is
  // the best cure for.
  const parks =
    /if l\.phase == \.debt \{\n\s*reserveQueue\.append\(answer\)/.test(reserve) &&
    /AdvertiserDebtBook\.shared\.admitNewAdvertiser \{/.test(reserve) &&
    /service\(within: Self\.reconcileWindow, ready\)/.test(admit);
  if (atomic && parks) {
    return 'reconcile-then-refuse';
  }
  return mint.includes('peripheralMgr = CBPeripheralManager') ? 'ungated' : 'absent';
};

/** Does the rung's close ask the PROCESS the second question, or answer the
 *  slot's fate off its own advertiser alone? */
type StopGate = 'services-book' | 'answers-alone' | 'absent';

const settleStopBody = (sw: string): string =>
  codeOnly(
    bracedBody(sw, '  private func settleStop(_ id: String, down: Bool, why: String) {'),
  );

const stopGateOf = (sw: string): StopGate => {
  const rung = codeOnly(stopBody(sw));
  const settle = settleStopBody(sw);
  if (rung === '' || settle === '') {
    return 'absent';
  }
  // TWO QUESTIONS, TWO SCOPES, ONE OWNER EACH. The rung answers only what
  // it can see — is MY advertiser off the air. Whether the PROCESS still
  // owes anything is a different question about a different scope, and
  // the arbiter asks it, once, for every road out of a hold. Asking it in
  // both places is two levels that must be kept in agreement, which is
  // the defect class this architecture round is about.
  if (/AdvertiserDebtBook\.shared\.service\(/.test(rung)) {
    return 'answers-alone'; // the rung answering for the process again
  }
  return /AdvertiserDebtBook\.shared\.service\(within: AdvertiserDebtBook\.reconcileWindow\)/.test(
    settle,
  ) && /finishStop\(id, clear: clear/.test(settle)
    ? 'services-book'
    : 'answers-alone';
};

/** …and the same question for a stop that finds `bleVoice` already nil. */
type DupStop = 'services-book' | 'early-exit' | 'absent';

const arbiterStopBody = (sw: string): string =>
  codeOnly(
    bracedBody(
      sw,
      '  func stop(\n    lease id: String?,\n    _ done: @escaping (AirtimeStopOutcome, String, String) -> Void\n  ) {',
    ),
  );

const dupStopOf = (sw: string): DupStop => {
  const code = arbiterStopBody(sw);
  if (code === '') {
    return 'absent';
  }
  // THE COALESCE (arbiter addendum 1). A second stop for a lease already
  // stopping does not answer on its own and does not start a second
  // operation: it joins the SAME terminal. Read positionally, because
  // appending AFTER an answer would be a coalesce that arrived too late
  // to be one.
  const phase = code.indexOf('if l.phase == .stopping {');
  const join = code.indexOf('l.stopWaiters.append((requestId: requestId, answer: done))');
  const ret = code.indexOf('return', join);
  const coalesced = phase > -1 && join > phase && ret > join;
  if (!coalesced) {
    return 'early-exit';
  }
  // …and a lease that never minted an advertiser still asks the book,
  // because absence is a fact about THIS lease and never about the air.
  return /settleStop\(id, down: true, why: "no-advertiser"\)/.test(code)
    ? 'services-book'
    : 'early-exit';
};

/** What JS does with the release the strict-false gate skipped. */
type Deferred = 'parked-and-guarded' | 'parked-unguarded' | 'dropped';

const parkBody = (ts: string): string =>
  codeOnly(
    bodyOf(ts, 'function watchAirtime(gen: number, owed: boolean): void {', '\n}\n'),
  );

const deferredReleaseBody = (ts: string): string =>
  codeOnly(
    bodyOf(
      ts,
      'function releaseDeferredHold(gen: number, snap: WalkieAirtime | null): boolean {',
      '\n}\n',
    ),
  );

const deferredOf = (ts: string): Deferred => {
  const close = codeOnly(sessionCloseBody(ts));
  if (!/deferCrewRelease\(gen\);/.test(close)) {
    return 'dropped';
  }
  const park = parkBody(ts);
  if (park === '' || !park.includes('onWalkieAirtimeState')) {
    return 'dropped';
  }
  // THE LIVE-SESSION FENCE moved WITH the release it guards: every road
  // into the deferred release — the event, the level read, the duplicate
  // stop's reconcile, a failed start — now goes through one function, so
  // the fence is read where it is enforced rather than where it used to
  // be written.
  return /if \(state\.session !== null \|\| walkieOn\(\)\) \{\n\s*return false;\n\s*\}/.test(
    deferredReleaseBody(ts),
  )
    ? 'parked-and-guarded'
    : 'parked-unguarded';
};

/*
 * ---------------------------------------------------------------------
 * THE LEVEL, THE STATE AND THE OWNER — what an EDGE could not carry
 * (advertiser-debt cross-family no-go, 2026-08-27, read of 45a928d).
 *
 * 45a928d's book HOLDS. What the ruling names is everything above it that
 * depended on a single event arriving at a single listener:
 *
 *   "(1) settlement is event-only; debt can clear between stopWalkie
 *   false and listener attach, or during reload/background, dropping the
 *   only event and stranding holds. (2) public duplicate stop still early
 *   -exits before native debt service. (3) stale settlement dispatched
 *   during new start await sees session null/walkieOn false and releases
 *   the NEW hold."
 *
 * One root under all three: the cure was written as a MOMENT — an edge,
 * one listener, one implicit owner — and every window in which nobody was
 * listening, or in which the listener was listening for the wrong hold,
 * fell straight back to the strand or the overlap it replaced. The
 * readers below pull the level read, the explicit deferred state and the
 * hold's generation out of the two files that carry them, and `Process`
 * steps them through windows the old model could not even express.
 * ---------------------------------------------------------------------
 */

/** How the deferred release LEARNS the airtime changed hands. */
type SettleRoad = 'level-and-event' | 'event-only' | 'absent';

const settleRoadOf = (ts: string, js: string): SettleRoad => {
  const park = parkBody(ts);
  if (park === '') {
    return 'absent';
  }
  // READ POSITIONALLY, because the ORDER is the fix and not a detail:
  // querying before subscribing leaves the same gap in the other
  // direction — a state that changes between the answer and the attach.
  const subscribe = park.indexOf('sub = onWalkieAirtimeState(settleAirtime);');
  const query = park.indexOf('void walkieAirtimeState()');
  if (subscribe < 0 || query < 0 || query < subscribe) {
    return 'event-only';
  }
  // …and a level nothing can ask is not a level. Mutation: keep the call
  // site and delete the adapter's seam, and the query is a name that
  // throws rather than a fact anyone reads.
  return /export async function walkieAirtimeState\(\): Promise<\{/.test(js)
    ? 'level-and-event'
    : 'event-only';
};

/**
 * IS A NATIVE THIS BOUNDARY CANNOT READ TREATED AS A FREE SLOT? It must
 * never be — and the cure is now STRUCTURED rather than silent (S9/S10).
 *
 * `null` from the decoder means "I cannot read this", and the capability
 * road turns that into a WORD: `incompatible` when the native answered
 * and this JS could not read the answer, `absent` when there was nothing
 * to ask. Both park the hold; neither leaves a watcher waiting on an
 * event shape that will never arrive.
 */
const nullIsNotClear = (js: string): boolean => {
  const ask = codeOnly(
    bodyOf(js, 'export async function walkieAirtimeState(): Promise<{', '\n}\n'),
  );
  const decode = codeOnly(
    bodyOf(
      js,
      'export function decodeWalkieAirtime(e: unknown): WalkieAirtime | null {',
      '\n}\n',
    ),
  );
  return (
    /if \(!walkieAirtimePresent\(\)\) \{\n\s*return \{ capability: 'absent', state: null \};/.test(
      ask,
    ) &&
    /catch \{[\s\S]*return \{ capability: 'absent', state: null \};/.test(ask) &&
    // IT ANSWERED AND WE CANNOT READ IT is a DIFFERENT fact from silence,
    // and it gets a different word. Reading it as an "event fallback" is
    // the strand: the event carries the same body the query does.
    /if \(state === null\) \{[\s\S]*return \{ capability: 'incompatible', state: null \};/.test(
      ask,
    ) &&
    // A PARTIAL BODY IS A NATIVE WE DO NOT UNDERSTAND, never a state with
    // defaults — and the WIRE VERSION is checked first, so the previous
    // era's bare `{ why }` cannot be half-read into a state.
    /o\?\.v !== WALKIE_AIRTIME_WIRE/.test(decode) &&
    /typeof o\.processIncarnation !== 'string'/.test(decode) &&
    /typeof o\.revisionHi !== 'number'/.test(decode) &&
    /typeof o\.holdRequired !== 'boolean'/.test(decode) &&
    /return null;/.test(decode)
  );
};

/**
 * THE CAPABILITY POLICY, as a shape (S9): does an unreadable native park
 * with a REASON, or leave a watcher on a shape that cannot arrive?
 */
type Capability = 'explicit' | 'silent-fallback' | 'absent';

const capabilityOf = (ts: string, js: string): Capability => {
  const park = codeOnly(bodyOf(ts, 'function parkAirtime(', '\n}\n'));
  const watch = parkBody(ts);
  if (park === '' || !/export type WalkieAirtimeCapability =/.test(js)) {
    return 'absent';
  }
  // THE PARK IS TERMINAL AND IT SAYS WHY: the subscription goes (it
  // cannot deliver anything readable), the reason is on the record, and
  // the watch is closed rather than left open on a native whose events
  // this JS cannot decode.
  const terminal =
    /offSettled = null;/.test(park) &&
    /watchDone = true;/.test(park) &&
    /parkReason = reason;/.test(park);
  // …and it is reached from EVERY degraded answer: a seam that cannot be
  // subscribed to, a query that threw, and a body we could not read.
  const reached =
    /if \(sub === null\) \{\n\s*parkAirtime\('absent'\);/.test(watch) &&
    /if \(capability !== 'arbiter'\) \{\n\s*parkAirtime\(capability\);/.test(watch) &&
    /\.catch\(\(\) => parkAirtime\('absent'\)\);/.test(watch);
  return terminal && reached ? 'explicit' : 'silent-fallback';
};

/** Does a public stop with nothing standing but a debt owed RECONCILE? */
type DupSessionStop = 'reconciles' | 'early-exit' | 'absent';

const dupSessionStopOf = (ts: string): DupSessionStop => {
  const stop = codeOnly(sessionStopBody(ts));
  if (stop === '') {
    return 'absent';
  }
  return /if \(!deferredDebt\) \{\n\s*return;\n\s*\}[\s\S]*await reconcileDeferredDebt\(\);/.test(
    stop,
  )
    ? 'reconciles'
    : 'early-exit';
};

/** Does the module's own init reconcile a hold a previous JS world left
 *  standing — and does it ask the PROCESS rather than its own flags? */
const initReconcileOf = (ts: string): boolean => {
  const body = codeOnly(
    bodyOf(ts, 'function reconcileStrandedHold(): void {', '\n}\n'),
  );
  return (
    body !== '' &&
    // THE FLAG IS NOT THE GATE. `crewAdvertisingHeld()` is reset by the
    // very reload this road exists for, so gating on it closes the road
    // in exactly the world it was written for. It may still arrive as an
    // ARGUMENT — "does this world already believe it holds something?" —
    // which decides nothing about whether to ask or whether to adopt.
    !/if \(!crewAdvertisingHeld\(\)\) \{/.test(body) &&
    body.includes('mintHoldGeneration();') &&
    body.includes('watchAirtime(holdOwner, crewAdvertisingHeld());') &&
    // …and it must actually RUN at import, not merely exist.
    /\nreconcileStrandedHold\(\);\n/.test(ts)
  );
};

/*
 * ---------------------------------------------------------------------
 * THE AIRTIME STATE — who owns the advertising slot, asked of the process
 * (cross-family no-go, 2026-08-27, read of c5b9e39).
 *
 * The level cure gave JS a NUMBER and let it infer the rest from its own
 * locals. The ruling's sentence: "reload ownership is inferred from
 * JS-local session/walkieOn/advertisingHeld — all reset independently of
 * native CrewBeacon/Walkie/debt. This fails both ways: old debt+native
 * hold survives while JS flag false so no reconcile and Crew may restart;
 * or native live advertiser survives while JS state reset and count=0
 * releases underneath it. Count zero proves only debt clear, not airtime
 * ownership."
 *
 * So the process answers ownership itself, as one state at one level, and
 * the readers below pull that state — and the JS protocol built on it —
 * out of the four files that carry it.
 * ---------------------------------------------------------------------
 */

/**
 * THE ARBITER, READ OUT OF THE SWIFT — the process-lifetime owner of the
 * advertising slot, and every property the ruling names.
 */
interface AirtimeBridge {
  /** Does the whole seam exist — the arbiter type, the bridge line, the
   *  JS adapter? */
  present: boolean;
  /** Is the hold a LEASE with an exact identity, or an anonymous Bool
   *  that anybody's stop may clear (S1)? */
  rule: 'exact-lease' | 'anonymous-flag' | 'absent';
  /** Are all seven phases modelled — idle, reserving, suppressingCrew,
   *  starting, active, stopping, debt? */
  phases: string[];
  /** Is the state built under ONE lock and emitted OUTSIDE it, with the
   *  book read inside — rather than two moments called a state? */
  oneLockOrder: boolean;
  /** Does the revision travel as a decimal string AND an exact hi/lo
   *  pair, and is identity split from ordering (S5)? */
  wireSafeRevision: boolean;
  /** Do the event and the query carry the same body, built the same way,
   *  and does a sink get the current state REPLAYED on registration? */
  eventCarriesState: boolean;
  replaysOnRegister: boolean;
  /** Is `crewMayAdvertise` derived from "no lease in any phase", and read
   *  at the EFFECT site in CrewBeacon rather than at a JS call site? */
  gateAtEffect: boolean;
  /** Does the arbiter drive the crew SUPPRESSION and prove it, degrading
   *  the walkie advertiser when it cannot (S2)? */
  suppressionProven: boolean;
  /** Is the release a direct arbiter action against the lease it just
   *  retired (S4)? */
  nativeRelease: boolean;
  /** Does a start op reach `active` only on its rung's own EFFECT? */
  effectBeforeActive: boolean;
}

const arbiterBody = (sw: string): string =>
  bracedBody(sw, 'final class WalkieAirtimeArbiter {');

const airtimeBridgeOf = (
  sw: string,
  w: string,
  js: string,
  bridge: string,
  crew: string,
): AirtimeBridge => {
  const cls = codeOnly(arbiterBody(sw));
  const phaseEnum = codeOnly(bracedBody(sw, 'enum AirtimePhase: String {'));
  const body = codeOnly(bracedBody(sw, '  private func body(why: String) -> [String: Any] {'));
  const ledger = codeOnly(
    bracedBody(sw, 'func ledger() -> (open: Int, epoch: UInt64) {'),
  );
  const reserve = reserveBody(sw);
  const suppress = codeOnly(
    bracedBody(sw, '  func suppressCrew(lease id: String, _ done: @escaping (Bool, String) -> Void) {'),
  );
  const finishSuppress = codeOnly(bracedBody(sw, '  private func finishSuppress('));
  const retire = codeOnly(bracedBody(sw, '  private func retireLease(why: String) -> Retirement {'));
  const apply = codeOnly(bracedBody(sw, '  private func apply(_ r: Retirement) {'));
  const effect = codeOnly(bracedBody(sw, '  func noteStartEffect('));
  const addSink = codeOnly(bracedBody(sw, '  func addSink('));
  const present =
    cls !== '' &&
    phaseEnum !== '' &&
    /@objc\(airtimeState:rejecter:\)/.test(w) &&
    bridge.includes('RCT_EXTERN_METHOD(airtimeState:') &&
    /export async function walkieAirtimeState\(\): Promise<\{/.test(js);
  if (!present) {
    return {
      present: false,
      rule: 'absent',
      phases: [],
      oneLockOrder: false,
      wireSafeRevision: false,
      eventCarriesState: false,
      replaysOnRegister: false,
      gateAtEffect: false,
      suppressionProven: false,
      nativeRelease: false,
      effectBeforeActive: false,
    };
  }
  return {
    present: true,
    // AN EXACT LEASE, NOT A BOOL. `sessionLive` was an ANONYMOUS hold and
    // an anonymous hold is one anybody may end — which is exactly what a
    // second bridge instance's stop did.
    rule:
      /private var lease: AirtimeLease\?/.test(cls) &&
      /guard let id, l\.id == id else \{/.test(arbiterStopBody(sw)) &&
      !/private static var sessionLive/.test(w) &&
      // …AND THE HOLD IS DERIVED FROM THE LEASE, not from the book's
      // count. "A clear book" and "an empty air" have never been the same
      // sentence: a live lease with nothing owed still owns the slot, and
      // reading the count alone hands it back underneath one.
      /"holdRequired": l != nil/.test(body) &&
      /"crewMayAdvertise": l == nil/.test(body)
        ? 'exact-lease'
        : 'anonymous-flag',
    phases: [...phaseEnum.matchAll(/case ([a-zA-Z]+)/g)].map((m) => m[1]),
    // ONE MOMENT: the body is built under the lock (the book read inside
    // it), and NOTHING is called back out until it is released.
    oneLockOrder: (() => {
      const bump = codeOnly(bracedBody(sw, '  private func bump(_ why: String) -> [String: Any] {'));
      const inner = (ledger.match(/lock\.lock\(\)/g) ?? []).length === 1;
      return (
        /AdvertiserDebtBook\.shared\.ledger\(\)\.open/.test(body) &&
        /lastBody = b/.test(bump) &&
        inner &&
        // every broadcast site releases first
        !/lock\.lock\(\)[^}]*broadcast\(/.test(reserve)
      );
    })(),
    wireSafeRevision:
      /"revision": String\(revision\)/.test(body) &&
      /"revisionHi": NSNumber\(value: UInt32\(truncatingIfNeeded: revision >> 32\)\)/.test(
        body,
      ) &&
      /"revisionLo": NSNumber\(value: UInt32\(truncatingIfNeeded: revision\)\)/.test(body) &&
      // …and identity is a SEPARATE field from ordering.
      /"processIncarnation": incarnation/.test(body) &&
      /"leaseId": l\?\.id \?\? NSNull\(\)/.test(body) &&
      /export function compareWalkieRevision/.test(js),
    eventCarriesState:
      /resolve\(Self\.arbiter\.currentState\(\)\)/.test(w) &&
      /sendEvent\(withName: Self\.airtimeEvent, body: body\)/.test(w) &&
      /let b = body\(why: why\)/.test(codeOnly(bracedBody(sw, '  private func bump('))),
    // A MISSED EVENT IS SAFE because a sink is replayed on registration.
    replaysOnRegister:
      /let replay = lastBody/.test(addSink) && /emit\(replay\)/.test(addSink),
    // THE GATE IS READ WHERE IT RADIATES.
    gateAtEffect:
      /var crewMayAdvertise: Bool \{/.test(cls) &&
      /return lease == nil/.test(
        codeOnly(bracedBody(sw, '  var crewMayAdvertise: Bool {')),
      ) &&
      /if WalkieAirtimeArbiter\.shared\.crewMayAdvertise == false \|\| airtimeSuppressed \{/.test(
        crew,
      ),
    suppressionProven:
      /sink\.suppressCrewAdvertising \{/.test(suppress) &&
      /l\.rung = \.degraded/.test(finishSuppress) &&
      /func suppressCrewAdvertising\(_ done: @escaping \(Bool, String\) -> Void\)/.test(
        crew,
      ) &&
      /if tries > 0, !mgr\.isAdvertising \{/.test(crew),
    nativeRelease:
      /crewSink\(\)\?\.resumeCrewAdvertising\(\)/.test(apply) &&
      /resumeCrew: true/.test(retire),
    // `starting` is where a rung that has been ASKED lives; only its own
    // effect moves it to `active`.
    effectBeforeActive:
      /guard let l = lease, l\.id == id, l\.phase == \.starting else \{/.test(effect) &&
      /l\.phase = \.active/.test(effect) &&
      /func peripheralManagerDidStartAdvertising\(/.test(sw) &&
      /settleStartEffect\(\.degraded, "advertise-error"\)/.test(sw),
  };
};

/** How JS decides it is holding airtime it must keep holding. */
type Adoption = 'native-level' | 'js-flag' | 'absent';

const adoptionOf = (ts: string): Adoption => {
  const adopt = codeOnly(
    bodyOf(ts, 'function adoptAirtime(snap: WalkieAirtime): boolean {', '\n}\n'),
  );
  const settle = codeOnly(
    bodyOf(ts, 'function settleAirtime(snap: WalkieAirtime | null): void {', '\n}\n'),
  );
  if (
    adopt === '' ||
    !/if \(snap\.holdRequired\) \{\n\s*[\s\S]{0,400}?watchOwes = adoptAirtime\(snap\) \|\| watchOwes;/.test(
      settle,
    )
  ) {
    return 'absent';
  }
  // THE INIT ROAD MUST NOT BE GATED ON THE FLAG A RELOAD RESETS — that is
  // the ruling's first face, and the plant is exactly this line back. The
  // flag may still arrive as an argument; what it may never be is the
  // guard that decides whether to ask at all.
  const init = codeOnly(
    bodyOf(ts, 'function reconcileStrandedHold(): void {', '\n}\n'),
  );
  if (/if \(!crewAdvertisingHeld\(\)\) \{/.test(init)) {
    return 'js-flag';
  }
  // …and adopting means all of it: the mirror, WHICH process, WHEN, and
  // the actuator — with the flag read ONLY as "is this world already
  // suppressing its own cadence?", never as the decision.
  return /deferredDebt = true;/.test(adopt) &&
    /adoptedIncarnation = snap\.processIncarnation;/.test(adopt) &&
    /adoptedAt = snap;/.test(adopt) &&
    /return true;/.test(adopt) &&
    /if \(!crewAdvertisingHeld\(\)\) \{\n\s*[\s\S]{0,400}?void holdCrewAdvertising\(\)/.test(
      adopt,
    )
    ? 'native-level'
    : 'js-flag';
};

/** Can a snapshot from BEFORE this world's adoption end the hold it took? */
const tokenFenceOf = (ts: string): boolean => {
  const body = deferredReleaseBody(ts);
  return (
    // WHICH PROCESS. A different incarnation is not a later state of this
    // one: nothing this world adopted survives a relaunch.
    /if \(adoptedIncarnation !== null && snap\.processIncarnation !== adoptedIncarnation\) \{\n\s*return false;\n\s*\}/.test(
      body,
    ) &&
    // …and WHEN, through the comparator that survives 2^53. Mutation:
    // `Number(snap.revision) < Number(adoptedAt.revision)` — right
    // everywhere a bench will look, and wrong exactly where a stale
    // snapshot compares EQUAL to the state that replaced it.
    /if \(adoptedAt !== null && compareWalkieRevision\(snap, adoptedAt\) < 0\) \{\n\s*return false;\n\s*\}/.test(
      body,
    )
  );
};

/** Is the NATIVE fence asked FIRST — before any JS-local question?
 *
 *  READ AS "the first thing the body does", not as "before that other
 *  fence": anchoring it on a sibling fence makes a mutation to THAT fence
 *  redden this reader too, and a reader that answers about two things is
 *  a reader whose failures name the wrong one. */
const nativeFenceFirst = (ts: string): boolean => {
  const lines = deferredReleaseBody(ts)
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() !== '');
  return lines[0]?.trim() === 'if (snap === null || snap.holdRequired) {';
};

/** Who owns the teardown of a start that failed AFTER the holds were
 *  taken (F2). */
type FailedStart = 'owner' | 'unguarded' | 'release-despite-debt' | 'absent';

const failedStartOf = (ts: string): FailedStart => {
  const body = codeOnly(
    bodyOf(
      ts,
      'export async function abandonFailedStart(original: unknown): Promise<never> {',
      '\n}\n',
    ),
  );
  const close = codeOnly(sessionCloseBody(ts));
  const exec = codeOnly(
    bodyOf(
      ts,
      'async function runTeardown(steps: readonly TeardownStep[]): Promise<string[]> {',
      '\n}\n',
    ),
  );
  const steps = codeOnly(
    bodyOf(ts, 'function sessionTeardownSteps(): readonly TeardownStep[] {', '\n}\n'),
  );
  const start = codeOnly(
    bodyOf(
      ts,
      'async function doStartWalkieSession(id: WalkieSessionId): Promise<void> {',
      '\n}\n',
    ),
  );
  // A CLEANUP NOBODY CALLS IS NOT A CLEANUP: it must be wired into the
  // start's own rejection path, not merely exported.
  if (body === '' || exec === '' || !/return await abandonFailedStart\(e\);/.test(start)) {
    return 'absent';
  }
  // THE STEPS ARE DATA AND ONE LOOP GUARDS THEM (the repo's own law: 3+
  // same-shaped ops => a data structure). Five hand-written try/catches
  // are five chances to forget one, and the one that gets forgotten is
  // always the one after a step that raises.
  const guarded =
    /for \(const step of steps\) \{/.test(exec) &&
    (exec.match(/try \{/g) ?? []).length === 1 &&
    (exec.match(/\} catch \{/g) ?? []).length === 1 &&
    /interface TeardownStep \{/.test(ts) &&
    // …and DETACHING COMES FIRST, so nothing later can call back into a
    // session that is coming down.
    steps.indexOf("label: 'detach-peers'") > -1 &&
    steps.indexOf("label: 'detach-peers'") < steps.indexOf("label: 'destroy-runtime'") &&
    // ONE LIST FOR BOTH ROADS (S8). Two lists that must agree is the
    // defect class this whole round is about.
    /await endWalkieSession\(\);/.test(body) &&
    /await runTeardown\(sessionTeardownSteps\(\)\);/.test(close);
  // THE ORIGINAL ERROR SURVIVES: none of the cleanup is the reason the
  // start failed.
  if (!guarded || !/throw original;/.test(body)) {
    return 'unguarded';
  }
  // …AND IT NEVER RELEASES INTO OVERLAP. `clear` is the only word that
  // hands the slot back, and the failed start uses the close's own rule
  // because it IS the close.
  return /if \(stop\?\.outcome === 'clear'\) \{/.test(close) &&
    /deferCrewRelease\(gen\);/.test(close)
    ? 'owner'
    : 'release-despite-debt';
};

/** Is the hold OWNED by a generation the deferred release must match? */
type HoldOwnership = 'generation' | 'unowned';

const ownershipOf = (ts: string): HoldOwnership => {
  const start = codeOnly(
    bodyOf(ts, 'async function doStartWalkieSession(id: WalkieSessionId): Promise<void> {', '\n}\n'),
  );
  const verb = codeOnly(
    bodyOf(ts, 'export function startWalkieSession(id: WalkieSessionId): Promise<void> {', '\n}\n'),
  );
  // MINTED BEFORE THE HOLD IS TAKEN. Read positionally: minting after
  // leaves the new hold briefly wearing the old generation, which is
  // precisely the window a stale settlement is delivered into.
  const mint = start.indexOf('mintHoldGeneration();');
  const hold = start.indexOf('await holdCrewAdvertising()');
  const fenced =
    /if \(gen !== holdOwner \|\| pendingStarts > 0\) \{\n\s*return false;\n\s*\}/.test(
      deferredReleaseBody(ts),
    );
  // …and pending is counted at the VERB, so a start still queued behind
  // this stop is already visible.
  const pending = /pendingStarts \+= 1;/.test(verb) && /pendingStarts -= 1;/.test(verb);
  return mint > -1 && hold > mint && fenced && pending ? 'generation' : 'unowned';
};

/**
 * Do the event and the level read share ONE latch — and does that latch
 * close on a RELEASE THAT RAN rather than on a clear STATE (S6)?
 *
 * The second half is the whole of the test-vacuity seam. `sub.remove()`
 * does not un-queue a handler already in flight, so the latch (not the
 * unsubscribe) is what makes one clear state into one release; and a
 * latch that closed on the state would declare the job finished before
 * asking whether it was allowed to do the job.
 */
const onceLatchOf = (ts: string): boolean => {
  const settle = codeOnly(
    bodyOf(ts, 'function settleAirtime(snap: WalkieAirtime | null): void {', '\n}\n'),
  );
  const watch = parkBody(ts);
  return (
    /if \(watchDone\) \{\n\s*return;\n\s*\}/.test(settle) &&
    /watchDone = false;/.test(watch) &&
    // A REFUSAL IS NOT A FINISH.
    /if \(!releaseDeferredHold\(watchGen, snap\)\) \{\n\s*return;\n\s*\}\n\s*watchDone = true;/.test(
      settle,
    )
  );
};

/** Everything the stepper needs, in one bundle, all of it READ. */
interface Shape {
  proof: AdvertiserProof;
  settle: Settle;
  book: DebtBook;
  start: StartGate;
  stop: StopGate;
  dup: DupStop;
  adapter: AdapterProof;
  gate: ReleaseGate;
  deferred: Deferred;
  /** How the parked release learns the book went clear (edge, or edge
   *  AND level). */
  settleRoad: SettleRoad;
  /** Does module init adopt a hold a previous JS world left standing? */
  initReconcile: boolean;
  /** Does a public stop with a debt owed reconcile, or early-exit? */
  dupSession: DupSessionStop;
  /** Is the hold owned by a generation the release must still match? */
  ownership: HoldOwnership;
  /** Do the two roads into the release share one latch? */
  onceLatch: boolean;
  /** The PROCESS's own account of who owns the advertising slot. */
  airtime: AirtimeBridge;
  /** Does JS adopt on the native answer, or on its own resettable flag? */
  adoption: Adoption;
  /** Is the PROCESS's answer asked first, before any JS-local question?
   *  False is the pre-airtime world: the settle meant "the book is
   *  clear" and JS inferred the rest from its own locals. */
  nativeFence: boolean;
  /** Can a snapshot older than this world's adoption end its hold? */
  tokenFence: boolean;
  /** Who owns the teardown of a start that failed after the holds. */
  failedStart: FailedStart;
  /** Does a native this JS cannot read park with a REASON, or leave a
   *  watcher on a shape that can never arrive (S9)? */
  capability: Capability;
}

const readBridgeSource = (): string =>
  require('fs').readFileSync('ios/PlayaPal/WalkieBridge.m', 'utf8') as string;

/** The OTHER client of the arbiter. Its own file is where the crew
 *  beacon's gate and its suppression proof actually live, so an arm that
 *  read only the walkie's half would be reading one side of a shared
 *  contract and calling it the contract. */
const readCrewSource = (): string =>
  require('fs').readFileSync('ios/PlayaPal/CrewBeacon.swift', 'utf8') as string;

const shapeOf = (
  sw: string,
  w: string,
  js: string,
  sess: string,
): Shape => ({
  proof: advertiserProofOf(sw),
  settle: bridgeSettle(w),
  book: debtBookOf(sw),
  start: startGateOf(sw),
  stop: stopGateOf(sw),
  dup: dupStopOf(sw),
  adapter: adapterProof(js),
  gate: releaseGate(sess),
  deferred: deferredOf(sess),
  settleRoad: settleRoadOf(sess, js),
  initReconcile: initReconcileOf(sess),
  dupSession: dupSessionStopOf(sess),
  ownership: ownershipOf(sess),
  onceLatch: onceLatchOf(sess),
  airtime: airtimeBridgeOf(sw, w, js, readBridgeSource(), readCrewSource()),
  adoption: adoptionOf(sess),
  nativeFence: nativeFenceFirst(sess),
  tokenFence: tokenFenceOf(sess),
  failedStart: failedStartOf(sess),
  capability: capabilityOf(sess, js),
});

/**
 * ONE ADVERTISER'S RADIO, as GROUND TRUTH. `quietAfter` is the number of
 * LOOKS at it — fast or slow, a look is a look — after which
 * `isAdvertising` first answers false. It radiates whether or not anybody
 * is watching, which is the entire finding: the old shape stopped watching
 * and the radio did not care.
 */
class Advertiser {
  looks = 0;

  constructor(
    readonly label: string,
    readonly quietAfter: number | null,
    readonly hasManager = true,
    readonly poweredOff = false,
  ) {}

  radiating(): boolean {
    return (
      this.hasManager &&
      !this.poweredOff &&
      (this.quietAfter === null || this.looks < this.quietAfter)
    );
  }

  /** This radio as the fast prover's stepper sees it, from HERE. */
  asRadio(): Radio {
    return {
      hasManager: this.hasManager,
      poweredOff: this.poweredOff,
      quietAfter:
        this.quietAfter === null ? null : Math.max(0, this.quietAfter - this.looks),
    };
  }
}

/**
 * ONE PHONE, ACROSS SESSIONS — the seam the ruling describes, steppable.
 *
 * It carries what the old shape could not: advertisers this process minted
 * in EARLIER sessions and never proved quiet. `radiatingOther()` is ground
 * truth about the air; `owes()` is what the process BELIEVES. The defect is
 * exactly the gap between them, and every arm below is a script that opens
 * one.
 */
/**
 * THE PROCESS'S OWN ACCOUNT OF WHO OWNS THE ADVERTISING SLOT — the same
 * body the native query resolves and the state event carries.
 *
 * THE REVISION IS A PAIR, not a number, and that is not a modelling
 * flourish: the wire carries hi/lo precisely because a UInt64 through
 * JSON becomes a JS Number and every order relation above 2^53 stops
 * being one. A stepper that compared a single Number would be unable to
 * express the arm that catches it.
 */
interface Snap {
  processIncarnation: string;
  revisionHi: number;
  revisionLo: number;
  phase: 'idle' | 'reserving' | 'suppressingCrew' | 'starting' | 'active' | 'stopping' | 'debt';
  debtCount: number;
  holdRequired: boolean;
}

/** The comparator the JS boundary actually uses. */
const cmpRev = (a: Snap, b: Snap): number => {
  if (a.revisionHi !== b.revisionHi) {
    return a.revisionHi < b.revisionHi ? -1 : 1;
  }
  if (a.revisionLo !== b.revisionLo) {
    return a.revisionLo < b.revisionLo ? -1 : 1;
  }
  return 0;
};

class Process {
  readonly log: string[] = [];
  private readonly adverts: Advertiser[] = [];
  private readonly debts = new Map<string, 'open' | 'terminal'>();
  private live: Advertiser | null = null;
  /** JS: `holdCrewAdvertising` is set, so radio.ts suppresses every
   *  advertise(). */
  hold = false;
  /** JS: a session is standing. */
  session = false;
  /** JS: walkie.ts's own flag. */
  walkieOn = false;
  /** JS: a release parked on the airtime event, subscription live. */
  private parked = false;
  /** NATIVE: the arbiter's own monotonic account of when the advertising
   *  slot last changed hands. It survives everything JS can reset, which
   *  is the entire reason it exists. */
  private token = 0;
  /** …and where it STARTS, so an arm can run this phone at a revision no
   *  JS Number can tell from its successor. */
  revisionBase = 0;
  /** WHICH PROCESS is speaking. A JS reload keeps talking to the same
   *  one; a relaunch is a different string (S5). */
  incarnation = 'proc-1';
  /** JS: the native ownership THIS world adopted, split into the two
   *  questions one field used to answer badly — WHICH process, and WHEN
   *  (S5). */
  private adoptedIncarnation: string | null = null;
  private adoptedAt: Snap | null = null;
  /** JS: `deferredDebt` — a release is OWED, readable by roads that hold
   *  no subscription of their own (the duplicate public stop). */
  private deferredDebt = false;
  /** JS: this park's one-shot latch, shared by the event and the level
   *  read, so one clear state is one release. */
  private parkDone = true;
  /** JS: did THIS watch ever own anything? A refused close's park does
   *  from the first line; module init's does only once the process says
   *  a hold is required. It is what keeps a clean world's question from
   *  becoming a release. */
  private parkOwes = false;
  /** JS: the generation that owned the hold when this park was booked. */
  private parkedGen = 0;
  /** JS: `holdGen` / `holdOwner` — the hold's monotonic owner, minted
   *  BEFORE the hold is taken. */
  private holdGen = 0;
  private holdOwner = 0;
  /** JS: `pendingStarts` — a start ASKED FOR and not yet finished. The
   *  window between the verb and the queue reaching it, made visible. */
  private pendingStart = false;
  /** A start begun and not yet finished (see beginStart). */
  private pending: Advertiser | null = null;
  /** How many times CrewBeacon actually got its slot back. Two roads into
   *  one release must still be ONE release. */
  releaseCount = 0;
  /** The native event is on its way, WITH the state it carried when it
   *  was emitted. RN delivers what it already dispatched — `sub.remove()`
   *  on a later turn does not un-queue a handler already in flight — and
   *  that gap is the ONE ordering the start path's cancel cannot cover.
   *  It is what the fences are for. */
  private dispatched: Snap | null = null;
  /** The deferred release actually ran. */
  recovered = false;
  /** CrewBeacon got its slot back at least once. */
  released = false;
  /** …and at a moment when something of ours was still on the air. THE
   *  DEFECT, as one boolean. */
  releasedWhileUnaccounted = false;
  /** A second advertiser was minted while an earlier one was still up. */
  admittedNewAdvertiser = false;

  constructor(private readonly s: Shape) {}

  // ------------------------------------------------------- ground truth

  radiating(label: string): boolean {
    return this.adverts.some((a) => a.label === label && a.radiating());
  }

  private radiatingAny(): boolean {
    return this.adverts.some((a) => a.radiating());
  }

  /**
   * THE DEFECT, READABLE AT ANY MOMENT rather than only at the instant of
   * a release. `releasedWhileUnaccounted` catches the release that lands
   * ON a radiating advertiser; this catches the other order — the slot
   * handed back first and the advertiser coming up beside it a moment
   * later, which is what a hold released out from under a start in flight
   * actually looks like.
   */
  overlapNow(): boolean {
    return !this.hold && this.radiatingAny();
  }

  /** What the PROCESS believes it still owes. */
  owes(): boolean {
    return [...this.debts.values()].some((v) => v === 'open');
  }

  openDebts(): number {
    return [...this.debts.values()].filter((v) => v === 'open').length;
  }

  // ------------------------------------------------------------- native

  /** How many fast looks a bounded reconcile buys. */
  private reconcileLooks(): number {
    return this.s.proof.tickMs > 0
      ? Math.floor(this.s.book.reconcileMs / this.s.proof.tickMs)
      : 0;
  }

  /** The debt chain, `n` looks of it — the same read whether the cadence
   *  is the fast reconcile or the slow demoted one. */
  private drive(n: number): void {
    for (let i = 0; i < n; i += 1) {
      for (const a of this.adverts) {
        if (this.debts.get(a.label) !== 'open') {
          continue;
        }
        a.looks += 1;
        if (!a.radiating()) {
          this.terminal(a, a.poweredOff ? 'late-power-off' : 'late-not-advertising');
        }
      }
    }
  }

  /** Wall time, on the demoted cadence. A budget is a cadence, not a
   *  verdict, so this never runs out. */
  slowTicks(n: number): void {
    this.drive(n);
  }

  /** The book accepts many debts because the release rule is over a SET.
   *  Driven directly, the way the quarantine's register is. */
  owe(a: Advertiser): void {
    this.adverts.push(a);
    this.debts.set(a.label, 'open');
    this.token += 1;
    this.log.push('debt-open ' + a.label);
  }

  private terminal(a: Advertiser, why: string): void {
    this.debts.set(a.label, 'terminal');
    this.token += 1;
    this.log.push('debt-terminal ' + a.label + ' why=' + why);
    const clear = this.s.book.hopOnLastOnly ? !this.owes() : true;
    if (clear) {
      // THE HOP IS AN EDGE, AND AN EDGE HAS NO REPLAY. It goes out now,
      // to whoever is subscribed now. Nobody subscribed is not "delivered
      // later" — it is GONE, and with it the only signal this hold's
      // release was ever going to get. That is the reviewer's seam (1),
      // as one branch.
      if (this.parked) {
        // THE EVENT CARRIES THE SNAPSHOT, built now — which is what makes
        // a stale delivery detectable at all: by the time this runs, the
        // world may have moved and the token says so.
        this.dispatched = this.snapshot();
        this.log.push('book-clear hop');
      } else {
        this.log.push('the settled event fired with nobody listening');
      }
    }
  }

  // ------------------------------------------------------ the lifecycle

  /**
   * THE NATIVE SNAPSHOT, as this phone would answer it right now — the
   * same four fields the query resolves and the event carries.
   *
   * `null` is an older native that cannot answer, and null is NOT a free
   * slot: every road above treats it as "keep the hold".
   */
  snapshot(): Snap | null {
    if (!this.s.airtime.present) {
      return null;
    }
    const debtCount = this.openDebts();
    const active = this.live !== null;
    // A LEASE OCCUPIES A PHASE, and `holdRequired` is that sentence: the
    // walkie owns the slot while its own session is up, and it still owns
    // it while the book holds an advertiser nobody proved quiet.
    //
    // The degenerate rule is the ruling's own both-ways failure — a hold
    // required by the debt COUNT alone, so a live advertiser with an empty
    // book reads as a free slot.
    const held =
      this.s.airtime.rule === 'exact-lease' ? active || debtCount > 0 : debtCount > 0;
    const rev = this.revisionBase + this.token;
    return {
      processIncarnation: this.incarnation,
      revisionHi: Math.floor(rev / 2 ** 32),
      revisionLo: rev % 2 ** 32,
      phase: held ? (active ? 'active' : 'debt') : 'idle',
      debtCount,
      holdRequired: held,
    };
  }

  /** A snapshot taken NOW and delivered LATER — the shape of an event
   *  emitted before the world moved. */
  captureSnapshot(): Snap | null {
    return this.snapshot();
  }

  /**
   * A session opens. The airtime HOLD is JS's and comes first whatever the
   * radio does; minting the advertiser is native's and is what the debt
   * gate decides. A refused mint is a session with no rung 3 — never a
   * failed start.
   */
  start(a: Advertiser): boolean {
    this.beginStart(a);
    return this.finishStart();
  }

  /**
   * THE START'S FIRST HALF — everything before its native awaits, which
   * is the window the reviewer's seam (3) lives in. The verb is pending,
   * the old park is cancelled, the hold's new owner is minted and the
   * hold is TAKEN — and `session` and walkie.ts's flag are still false,
   * because doStartWalkieSession does not set them until the radio is up.
   *
   * A settlement delivered here therefore sees exactly what it saw a
   * moment ago: nothing standing. Only the generation knows the hold
   * changed hands.
   */
  beginStart(a: Advertiser): void {
    this.pendingStart = true;
    this.cancelPark();
    this.mint();
    this.hold = true;
    this.pending = a;
    this.log.push('start begun gen=' + String(this.holdOwner));
  }

  /** …and its second half: the radio is up, the session is standing. */
  finishStart(): boolean {
    const a = this.pending;
    this.pending = null;
    this.pendingStart = false;
    /* istanbul ignore next — every caller begins a start first. */
    if (a === null) {
      return false;
    }
    this.session = true;
    this.walkieOn = true;
    if (this.s.start === 'reconcile-then-refuse' && this.owes()) {
      this.drive(this.reconcileLooks());
      if (this.owes()) {
        this.log.push('start refused why=advertiser-debt');
        return false;
      }
    }
    this.adverts.push(a);
    this.live = a;
    // THE SLOT CHANGED HANDS, so the process's token moves.
    this.token += 1;
    if (this.adverts.some((o) => o !== a && o.radiating())) {
      this.admittedNewAdvertiser = true;
    }
    this.log.push('advertiser minted=' + a.label);
    return true;
  }

  /**
   * A START THAT FAILED AFTER THE HOLDS WERE TAKEN (F2).
   *
   * The hold is taken, the generation is minted, and then the radio
   * refuses — a native start that rejects, an emitter that throws on a
   * partly wired bridge, a call runtime that raises. Before the owner
   * existed, the wreck stayed exactly where it fell.
   *
   * `throwsAt` is the intermediate step that raises on the way down: the
   * unguarded chain dies there and skips everything after it, while the
   * owner's per-step guards carry on to the decision about the hold.
   */
  failStart(a: Advertiser, throwsAt: 'none' | 'detach' = 'none'): string {
    const original = 'the radio refused';
    this.beginStart(a);
    // The radio never came up: the advertiser this start would have minted
    // does not exist, and the verb is no longer pending.
    this.pending = null;
    this.pendingStart = false;
    if (this.s.failedStart === 'absent') {
      this.log.push('failed start: the wreck is left where it fell');
      return original;
    }
    if (this.s.failedStart === 'unguarded' && throwsAt === 'detach') {
      this.log.push('failed start: teardown aborted on its first step');
      return original;
    }
    this.log.push('failed start: detached');
    // stopWalkie: this module holds no advertiser of its own, so the
    // native stop SERVICES the book — absence is proof only when the
    // process owes nothing.
    let down = true;
    if (this.owes()) {
      this.drive(this.reconcileLooks());
      if (this.owes()) {
        down = false;
      }
    }
    if (down || this.s.failedStart === 'release-despite-debt') {
      this.release();
    } else {
      this.park(this.holdOwner, true);
    }
    return original;
  }

  /** startWalkieSession CALLED and still queued: pending is counted at
   *  the verb, so this window is visible before any generation exists. */
  askStart(): void {
    this.pendingStart = true;
    this.log.push('start pending');
  }

  /**
   * A NEW JS WORLD over the same phone — a reload, a Fast Refresh, a
   * resume that re-evaluated the module. The park, the subscription, the
   * captured generation, the adopted token and the deferred flag die with
   * the old world. THE RADIOS DO NOT: an advertiser this process lit is
   * still lit and a debt on the native book is still open.
   *
   * `keepFlag` is which reload this is, and it is the ruling's first
   * face. `true` re-evaluated this module but not radio.ts, so
   * `advertisingHeld` survives; `false` re-evaluated both, so every JS
   * flag is back at its initial value while nothing about the air
   * changed. A recovery road that can only work in the first case is a
   * recovery road that fails exactly when it is needed.
   */
  reload(keepFlag = true): void {
    this.session = false;
    this.walkieOn = false;
    this.parked = false;
    this.parkDone = true;
    this.parkOwes = false;
    this.deferredDebt = false;
    this.adoptedIncarnation = null;
    this.adoptedAt = null;
    this.dispatched = null;
    this.holdGen = 0;
    this.holdOwner = 0;
    this.pendingStart = false;
    if (!keepFlag) {
      this.hold = false;
    }
    this.log.push('js world reloaded');
    // walkieSession's module init: mint an owner, subscribe first and
    // query second, and ADOPT whatever the process says it still owns.
    // The flag arrives as "does this world already believe it holds
    // something?", never as the gate on whether to ask at all.
    if (this.s.initReconcile && (this.s.adoption === 'native-level' || this.hold)) {
      this.mint();
      this.park(this.holdOwner, this.hold);
    }
  }

  /** The hold's next owner. Monotonic, minted before the hold is taken. */
  private mint(): void {
    this.holdGen += 1;
    this.holdOwner = this.holdGen;
  }

  /** cancelDeferredCrewRelease: a new session's hold is its own. It drops
   *  the subscription, the flag and the adopted token — and does NOT
   *  un-queue an event already in flight, which is the whole reason the
   *  fences exist. */
  private cancelPark(): void {
    this.parked = false;
    this.deferredDebt = false;
    this.adoptedIncarnation = null;
    this.adoptedAt = null;
    // `parkOwes` is deliberately NOT cleared: it is the watch's own
    // closure local, and an event already dispatched into that closure
    // still runs its handler. The fences are what stand between it and a
    // hold it no longer owns — which is the entire point of having them.
  }

  /**
   * The one close path: the rung's own proof, then the process's book,
   * then JS's gate.
   *
   * `gapLooks` is the reviewer's seam (1), steppable: looks the native
   * debt chain takes AFTER the stop promise has answered `false` and
   * BEFORE JS parks its listener. A book that clears in there fires its
   * one event into an empty room.
   */
  stop(gapLooks = 0): void {
    // THE PUBLIC VERB'S OWN GUARD (mechanic 2). With nothing standing the
    // stop used to return before the native stop ran at all — which is
    // right for a true duplicate and wrong for one that still owes a
    // parked release, because that tap is the book's best chance at a
    // re-drive.
    const standing = this.session || this.walkieOn || this.live !== null;
    if (!standing && (this.s.dupSession === 'early-exit' || !this.deferredDebt)) {
      this.session = false;
      this.walkieOn = false;
      this.log.push('duplicate stop: early exit');
      return;
    }
    this.session = false;
    this.walkieOn = false;
    const mine = this.live;
    this.live = null;
    let down: boolean;
    let why: string;
    if (mine) {
      const out = runNativeStop(this.s.proof, mine.asRadio(), this.s.settle);
      mine.looks += out.looks;
      down = out.outcome !== 'reject';
      why = out.why;
      // THE SLOT CHANGED HANDS AT THE PROOF, not at the issue: between
      // the two the advertiser may still be up and no debt has been born
      // to account for it.
      this.token += 1;
      if (!down) {
        // THE DEBT IS BORN HERE — or the advertiser is FORGOTTEN here,
        // which is the whole of the finding.
        if (this.s.book.owedOnBudgetOut) {
          this.debts.set(mine.label, 'open');
          this.token += 1;
          this.log.push('debt-open ' + mine.label);
          if (this.s.book.budgetIsTerminal) {
            this.terminal(mine, 'advertiser-still-up');
          }
        } else {
          this.log.push('advertiser FORGOTTEN ' + mine.label);
        }
      }
    } else {
      // The duplicate stop: no advertiser of its own, so P1 answers
      // "absent" — true about this module and worth nothing about the air.
      down = true;
      why = 'no-rung';
    }
    // THE GAP THE RULING NAMED. The native side has answered, the debt is
    // on the book, and JS has not attached a listener yet.
    if (gapLooks > 0) {
      this.drive(gapLooks);
    }
    if (down) {
      const road = mine ? this.s.stop : this.s.dup;
      if (road === 'services-book' && this.owes()) {
        this.drive(this.reconcileLooks());
        if (this.owes()) {
          down = false;
          why = 'advertiser-debt';
        }
      }
    }
    this.log.push('native stop -> ' + (down ? 'resolve' : 'reject') + '/' + why);
    // …and JS.
    const advertiserDown = this.s.adapter === 'reports-unproven' ? down : true;
    const mayRelease = this.s.gate === 'gated' ? advertiserDown !== false : true;
    if (mayRelease) {
      if (this.deferredDebt) {
        // THE RECONCILE ROAD (mechanic 2): the re-driven stop SERVICED
        // the book, and it is the LEVEL — never that stop's own answer —
        // that decides whether the slot may go back.
        this.park(this.holdOwner, true);
      } else {
        this.release();
      }
    } else if (this.s.deferred !== 'dropped') {
      this.park(this.holdOwner, true);
    } else {
      this.log.push('release DROPPED');
    }
  }

  /**
   * SUBSCRIBE FIRST, QUERY SECOND — mechanic 1, and the order is the fix.
   * Attaching first means no change can slip past after this point;
   * reading the level second means any change that slipped past BEFORE it
   * is found anyway, because a level is a standing fact and an edge is a
   * moment.
   *
   * `owed` is whether the caller already knows a release is owed. A
   * refused close does; module init does not, and asks the process
   * instead.
   */
  private park(gen: number, owed: boolean): void {
    this.parkOwes = owed;
    if (owed) {
      this.deferredDebt = true;
    }
    this.parkedGen = gen;
    this.parkDone = false;
    this.parked = true;
    this.log.push('release parked gen=' + String(gen));
    this.queryLevel();
  }

  /** The level read's answer, on its own turn — the query is a promise,
   *  so either road may get there first. */
  queryLevel(): void {
    if (this.s.settleRoad !== 'level-and-event') {
      return;
    }
    const snap = this.snapshot();
    if (snap === null) {
      this.log.push('airtime read: unknown');
      return;
    }
    if (!this.s.nativeFence) {
      // THE PRE-AIRTIME LEVEL: a COUNT, and only a count. It could say
      // the book was clear and could never say who owned the slot, which
      // is the whole of the ruling.
      this.log.push('debt level read: ' + String(snap.debtCount));
      if (snap.debtCount === 0) {
        this.settleWith(snap);
      }
      return;
    }
    this.log.push('airtime read: ' + (snap.holdRequired ? 'hold-required' : 'clear'));
    this.settleWith(snap);
  }

  /** The RN event arrives on the JS thread, carrying the state it was
   *  emitted with. */
  deliverSettle(): void {
    const snap = this.dispatched;
    if (snap === null) {
      return;
    }
    this.dispatched = null;
    // THE HANDLER RUNS ON THE DISPATCH ALONE. It does not re-check its own
    // subscription, and it cannot: `sub.remove()` on a later turn does not
    // un-queue a handler already on its way, so the fences below are the
    // ONLY thing standing between this event and a hold it does not own.
    this.settleWith(snap);
  }

  /** An event whose body was built BEFORE the world moved, delivered
   *  after it did — the one thing a bare "the book is clear" could never
   *  be told apart from a fresh one. */
  deliverSettleSnapshot(snap: Snap | null): void {
    this.dispatched = null;
    this.settleWith(snap);
  }

  /** Either road into the same one-shot, and the ADOPTION that is not a
   *  release at all. */
  private settleWith(snap: Snap | null): void {
    if (snap === null) {
      // A question nobody answered is not a slot anybody proved free.
      return;
    }
    if (this.s.nativeFence && snap.holdRequired) {
      this.adopt(snap);
      return;
    }
    if (this.s.onceLatch && this.parkDone) {
      return;
    }
    this.parkDone = true;
    this.parked = false;
    if (!this.parkOwes) {
      // Nothing was ever owed here — a clean world that asked, was told
      // the slot is free, and has no hold of its own to hand back.
      this.log.push('nothing was owed');
      return;
    }
    this.releaseDeferredHold(this.parkedGen, snap);
  }

  /**
   * THIS WORLD TAKES RESPONSIBILITY for a hold the PROCESS says is
   * required, whatever this world's own flags say.
   */
  private adopt(snap: Snap): void {
    if (this.s.adoption !== 'native-level') {
      return;
    }
    if (this.session || this.walkieOn) {
      // A live session is a live owner; there is nothing to adopt.
      return;
    }
    this.parkOwes = true;
    this.deferredDebt = true;
    this.adoptedIncarnation = snap.processIncarnation;
    // NEVER LOWERS (S6): a later state that still says `holdRequired`
    // refreshes the revision and keeps everything else.
    if (this.adoptedAt === null || cmpRev(snap, this.adoptedAt) > 0) {
      this.adoptedAt = snap;
    }
    // THE ACTUATOR, never the gate: the flag answering false means this
    // world is not suppressing the beacon and must be.
    this.hold = true;
    this.log.push('airtime adopted rev=' + String(snap.revisionLo));
  }

  /**
   * THE FENCES, in the order the source asks them, and the one release
   * they guard. The NATIVE one is first on purpose: ownership of the slot
   * is the process's answer, and the JS questions below only ever decide
   * whether THIS world is the one to act on it.
   */
  private releaseDeferredHold(gen: number, snap: Snap): boolean {
    if (this.s.nativeFence && snap.holdRequired) {
      this.log.push('deferred release refused: the process still needs the slot');
      return false;
    }
    // THE TOKEN FENCE. A snapshot built before this world adopted the
    // hold describes a world that has since moved on.
    if (
      this.s.tokenFence &&
      this.adoptedIncarnation !== null &&
      snap.processIncarnation !== this.adoptedIncarnation
    ) {
      this.log.push('deferred release refused: a different process incarnation');
      return false;
    }
    if (this.s.tokenFence && this.adoptedAt !== null && cmpRev(snap, this.adoptedAt) < 0) {
      this.log.push('deferred release refused: the snapshot is older than the adoption');
      return false;
    }
    // THE OWNERSHIP FENCE. The settle says "the slot is free", never
    // "the hold is yours" — and by now it may not be. A start already
    // asked for counts too: pending is what makes the window between the
    // verb and its generation visible.
    if (this.s.ownership === 'generation' && (gen !== this.holdOwner || this.pendingStart)) {
      this.log.push('deferred release refused: the hold changed hands');
      return false;
    }
    // THE LIVE-SESSION FENCE. Belt beside those braces (see the source's
    // own note): post-cure a live session always implies a newer
    // generation, so this is no longer the only thing standing here.
    if (this.s.deferred === 'parked-and-guarded' && (this.session || this.walkieOn)) {
      this.log.push('deferred release refused: a live session owns the hold');
      return false;
    }
    this.deferredDebt = false;
    this.adoptedIncarnation = null;
    this.adoptedAt = null;
    this.recovered = true;
    this.log.push('deferred release');
    this.release();
    return true;
  }

  private release(): void {
    this.hold = false;
    this.released = true;
    this.releaseCount += 1;
    if (this.radiatingAny()) {
      this.releasedWhileUnaccounted = true;
    }
    this.log.push('crew beacon released');
  }
}

describe('the walkie stop settles at the advertiser’s EFFECT, never at its issue', () => {
  const sw = readVoiceSource();
  const w = readWalkieModuleSource();
  const js = readAdapterSource();
  const sess = readSessionSource();

  const lagging: Radio = { hasManager: true, poweredOff: false, quietAfter: 3 };
  const wedged: Radio = { hasManager: true, poweredOff: false, quietAfter: null };

  test('ARM (a) — the resolve is gated on a PROOF, not on the stopAdvertising call', () => {
    // Mutation (the pre-fix line, and the plant): `stopInternal()` then
    // `resolve(nil)`. The promise then means "the teardown has been
    // posted", which is the reviewer's sentence exactly.
    expect(bridgeSettle(w)).toBe('proof');
    // Mutation: answer the completion in the module instead of handing it
    // to the rung that owns the advertiser — the issue with one more
    // function in the way.
    expect(teardownProof(w)).toBe('ble-completion');
    const p = advertiserProofOf(sw);
    // Mutation: call the completion inside the close's own block. The
    // close IS the issue; nothing it can say about the air is an effect.
    expect(p.provedInClose).toBe(true);
    // The three proofs the ruling names, in the order the source asks
    // them, and NO fourth road to true. Mutation: add one — any weaker
    // adapter fact (`.resetting`, `.unauthorized`, a generic state turn)
    // says nothing about what is radiating.
    expect(p.facts).toEqual(['absent', 'power-off', 'not-advertising']);
    // Mutation: read `isAdvertising` in the same block as the stop.
    // CoreBluetooth updates that flag asynchronously, so a same-block read
    // is the cached answer to the question just asked.
    expect(p.freshRead).toBe(true);
    // Mutation: post the recheck anywhere but the owning queue, and the
    // read is a race against the delegate callbacks instead of a turn
    // behind them.
    expect(p.onOwningQueue).toBe(true);
    // Mutation: look once and give up. A stack that swallowed the first
    // request is the case this exists for.
    expect(p.reIssues).toBe(true);
  });

  test('ARM (a), STEPPED — a lagging flag is waited out, and the issue shape is not', () => {
    // THE HEADLINE, executable. CoreBluetooth's own late flag: the advert
    // is really down by the third turn of the owning queue. The cured
    // shape waits for the fact and settles on it; the pre-fix shape
    // settles at turn 0, with the advertisement still on the air.
    const p = advertiserProofOf(sw);
    const cured = runNativeStop(p, lagging, bridgeSettle(w));
    expect(
      `${cured.outcome}/${cured.why}/looks:${cured.looks}/overlap:${cured.overlap}`,
    ).toBe('resolve/not-advertising/looks:3/overlap:false');
    const atIssue = runNativeStop(p, lagging, 'issue');
    expect(`${atIssue.why}/overlap:${atIssue.overlap}`).toBe('issue/overlap:true');
    // …and the consequence is the reviewer's, one file up: the crew
    // beacon goes back on the air into a live walkie advert.
    expect(overlapped(atIssue, adapterProof(js), releaseGate(sess))).toBe(true);
    expect(overlapped(cured, adapterProof(js), releaseGate(sess))).toBe(false);
  });

  test('ARM (b) — a proof that cannot arrive REJECTS; it does not resolve', () => {
    // FAIL CLOSED, and the plant is the one-character version of not
    // doing it: `proven?(true, "advertiser-still-up")` on budget
    // exhaustion. The close then reports success for the one radio state
    // the whole mechanism exists to catch.
    const p = advertiserProofOf(sw);
    expect(p.onBudgetOut).toBe('reject');
    const out = runNativeStop(p, wedged, bridgeSettle(w));
    expect(
      `${out.outcome}/${out.why}/looks:${out.looks}/overlap:${out.overlap}`,
    ).toBe(`reject/advertiser-still-up/looks:${p.budget}/overlap:true`);
    // A REAL, SMALL, FIXED NUMBER OF LOOKS — not a retry loop with no
    // floor and not a single glance, and short enough that the camper who
    // tapped off is still standing there.
    expect(p.budget).toBeGreaterThan(0);
    expect(p.budget).toBeLessThanOrEqual(8);
    expect(p.tickMs).toBeGreaterThan(0);
    expect(p.budget * p.tickMs).toBeLessThanOrEqual(2000);
  });

  test('ARM (c) — the rejection does NOT release CrewBeacon into overlap', () => {
    // The JS half of the fail-closed road. Mutation (the plant): drop the
    // gate and release unconditionally — the rejection is then a log line
    // and the overlap happens anyway. Mutation: swallow the rejection in
    // walkie.ts, as the void-returning shape did, and nothing above can
    // tell a proven close from an unproven one.
    expect(adapterProof(js)).toBe('reports-unproven');
    expect(releaseGate(sess)).toBe('gated');
    const p = advertiserProofOf(sw);
    const out = runNativeStop(p, wedged, bridgeSettle(w));
    expect(out.outcome).toBe('reject');
    expect(releases(out, adapterProof(js), releaseGate(sess))).toBe(false);
    expect(overlapped(out, adapterProof(js), releaseGate(sess))).toBe(false);
    // AND THE HOLD IS WHAT MAKES THE REFUSAL STICK: the slot is not handed
    // back, so radio.ts keeps suppressing every advertise() — including
    // the sharing session's 15 s cadence tick. A gate that skipped the
    // release while leaving the flag clear would be a gate in name only.
    expect(codeOnly(sessionStopBody(sess))).not.toMatch(
      /setCrewAdvertisingHold\(false\)/,
    );
  });

  test('POSITIVE CONTROL — an ordinary close still hands the slot straight back', () => {
    // A fence that never opens is an outage. The overwhelmingly common
    // close is a radio that goes quiet on the first look after the stop,
    // and it must resolve, release, and cost the camper one tick.
    const p = advertiserProofOf(sw);
    const healthy = runNativeStop(
      p,
      { hasManager: true, poweredOff: false, quietAfter: 1 },
      bridgeSettle(w),
    );
    expect(`${healthy.outcome}/${healthy.why}/looks:${healthy.looks}`).toBe(
      'resolve/not-advertising/looks:1',
    );
    expect(releases(healthy, adapterProof(js), releaseGate(sess))).toBe(true);
    expect(overlapped(healthy, adapterProof(js), releaseGate(sess))).toBe(false);
  });

  test('POSITIVE CONTROL — no rung 3, and a radio that is off, cost nothing', () => {
    // P1 and P2: a session that never built a peripheral manager (BLE
    // declined, or an older phone) and one whose adapter is down both have
    // nothing on the air, so neither owes a single tick — a close that
    // made every walkie wait a second for a rung it never opened would be
    // the cure charging the healthy case.
    const p = advertiserProofOf(sw);
    const absent = runNativeStop(
      p,
      { hasManager: false, poweredOff: false, quietAfter: null },
      bridgeSettle(w),
    );
    expect(`${absent.why}/looks:${absent.looks}`).toBe('absent/looks:0');
    const off = runNativeStop(
      p,
      { hasManager: true, poweredOff: true, quietAfter: null },
      bridgeSettle(w),
    );
    expect(`${off.why}/looks:${off.looks}`).toBe('power-off/looks:0');
    for (const s of [absent, off]) {
      expect(releases(s, adapterProof(js), releaseGate(sess))).toBe(true);
      expect(overlapped(s, adapterProof(js), releaseGate(sess))).toBe(false);
    }
    // …and the module no longer answers for the air AT ALL when it holds
    // no rung. `bleVoice` being nil was always a fact about this MODULE,
    // and turning it into a statement about the radio is the whole of the
    // duplicate-stop hole. The teardown drops its own reference and
    // nothing more; a lease with no advertiser asks the BOOK, in the
    // arbiter, where the process-scoped question has one owner.
    const teardown = codeOnly(bracedBody(w, 'private func stopInternal('));
    expect(teardown.length).toBeGreaterThan(0);
    expect(teardown).not.toMatch(/proven\?\(/);
    expect(teardown).not.toMatch(/AdvertiserDebtBook/);
    expect(arbiterStopBody(sw)).toContain('settleStop(id, down: true, why: "no-advertiser")');
  });

  test('the proof completes ONCE, and the bridge spells both roads out', () => {
    // Mutation: fall through a branch without returning and the completion
    // fires twice — a promise settled twice is a promise whose second
    // answer is silently discarded, which is how a rejection becomes a
    // resolve nobody can see. Every road out of the prover returns.
    const code = codeOnly(proveBody(sw));
    const roads = [...code.matchAll(/proven\?\((?:true|false), "[a-z-]+"\)\n(\s*)return/g)];
    expect(roads.length).toBe(
      (code.match(/proven\?\((?:true|false), "[a-z-]+"\)/g) ?? []).length,
    );
    expect(roads.length).toBe(4);
    // THE ANSWER IS A WORD NOW, NOT A REJECTION CODE, and both sides read
    // the same four. Mutation: rename either side and the gate above
    // silently reopens — which is why the words are asserted here as
    // literals rather than inferred from a shape.
    expect(bridgeStopBody(w)).toContain('"outcome": outcome.rawValue');
    const words = codeOnly(bracedBody(sw, 'enum AirtimeStopOutcome: String {'));
    expect([...words.matchAll(/case ([a-zA-Z]+)/g)].map(m => m[1])).toEqual([
      'clear',
      'debt',
      'notOwner',
    ]);
    const adapter = codeOnly(readAdapterSource());
    expect(adapter).toContain("word !== 'clear' && word !== 'debt' && word !== 'notOwner'");
    // …and the fourth word is the BOUNDARY'S, produced only here, never
    // by the arbiter — because the arbiter always knows which of the
    // three happened.
    expect(adapter).toContain("outcome: 'unknown'");
    expect(sw).not.toContain('case unknown');
    // THE PROOF IS THE RUNG'S, NOT THE MODULE'S: Walkie.swift reads no
    // CoreBluetooth state of its own. Mutation: cache an `isAdvertising`
    // flag up there and the read stops being fresh and stops being on the
    // owning queue in one move.
    expect(w).not.toMatch(/\.isAdvertising/);
    expect(w).not.toMatch(/CBPeripheralManager/);
  });
});

/**
 * THE ADVERTISER'S DEBT — a budget-out is where the obligation BEGINS
 * (advertiser-debt no-go, 2026-08-27, cross-family read of 2edcc6a).
 *
 * The block above proves the stop settles at the effect. This one proves
 * the process does not FORGET the stop it could not settle. Six roads, one
 * root: `false` was the end of the story, so the manager went out of scope
 * and every later question about the air was answered in ignorance of it.
 */
describe('a budget-out OWES the advertiser; it does not forget it', () => {
  const sw = readVoiceSource();
  const w = readWalkieModuleSource();
  const js = readAdapterSource();
  const sess = readSessionSource();
  const shape = (): Shape => shapeOf(sw, w, js, sess);

  /** The cured shape, minus its debt book — the pre-fix world, and plant
   *  (a): the budget-out drops the manager and nothing remembers it. */
  const forgetful = (): Shape => {
    const s = shape();
    // THE PRE-FIX WORLD ENTIRE, and `settleRoad` belongs to it: the level
    // read is a read OF the book, so a shape with no book cannot have
    // one. (A "clear" level from a book that forgot the advertiser is not
    // a fact about the air; it is the same ignorance with a number on it,
    // which is exactly why the level had to be added to a book that
    // remembers rather than instead of one.)
    return {
      ...s,
      book: { ...s.book, owedOnBudgetOut: false },
      settleRoad: 'event-only',
    };
  };

  test('DEBT (a) — the seam: budget-out, then a new start, then closing a PROVEN B', () => {
    // CODEX'S ARM, VERBATIM. A wedges on close; B is minted; B closes
    // cleanly. The pre-fix signature of that script is
    // `recovered=false, admittedNewAdvertiser=true` — a crew beacon handed
    // its slot back on B's honest proof while A was never proven at all.
    const s = shape();
    expect(s.book.present).toBe(true);
    // Mutation (plant debt-a): delete the `owe` call and the budget-out drops
    // the manager exactly as 2edcc6a did.
    expect(s.book.owedOnBudgetOut).toBe(true);

    const cured = new Process(s);
    cured.start(new Advertiser('A', 30));
    cured.stop();
    // The promise failed closed and the hold is set — 2edcc6a's half —
    // AND the process now knows it owes something, which is the new half.
    expect(cured.hold).toBe(true);
    expect(cured.owes()).toBe(true);
    expect(cured.radiating('A')).toBe(true);

    // A NEW SESSION. The gate consults the book, re-drives A, and refuses
    // rather than putting a second advertiser up beside it.
    expect(cured.start(new Advertiser('B', 1))).toBe(false);
    expect(cured.admittedNewAdvertiser).toBe(false);
    cured.stop();
    expect(cured.released).toBe(false);

    // RECOVERY COMES FROM A'S OWN LATE TERMINAL, and from nothing else.
    cured.deliverSettle();
    expect(cured.recovered).toBe(false);
    cured.slowTicks(30);
    cured.deliverSettle();
    expect(cured.recovered).toBe(true);
    expect(cured.radiating('A')).toBe(false);
    expect(cured.hold).toBe(false);
    expect(cured.releasedWhileUnaccounted).toBe(false);

    // …and the same script on the forgetful shape reproduces the ruling's
    // own sentence, to the character.
    const broken = new Process(forgetful());
    broken.start(new Advertiser('A', 30));
    broken.stop();
    broken.start(new Advertiser('B', 1));
    broken.stop();
    broken.slowTicks(60);
    broken.deliverSettle();
    expect(
      `recovered=${broken.recovered} admittedNewAdvertiser=${broken.admittedNewAdvertiser}`,
    ).toBe('recovered=false admittedNewAdvertiser=true');
    expect(broken.releasedWhileUnaccounted).toBe(true);
  });

  test('DEBT (a), THE BOOK — a debt is held, not merely noted', () => {
    const b = shape().book;
    // Mutation: a weak box. The quarantine's boxes are weak because the
    // object's DEATH is its release condition; this book's release
    // condition is a READ OF the object, so a weak box makes the
    // obligation unanswerable — the one thing worse than owing it.
    expect(b.holdsManagerStrongly).toBe(true);
    // Mutation: drop the queue and read the manager from wherever the
    // caller happens to be. A CBPeripheralManager's state belongs to its
    // delegate queue, and the instance that minted it is GONE.
    expect(b.carriesProofIdentity).toBe(true);
    // Mutation: open the debt and stop there. A record nobody looks at is
    // a leak with better bookkeeping.
    expect(b.chainStarted).toBe(true);
    // Mutation: look once and give up — the same defect the fast prover's
    // re-issue exists against, one scope out.
    expect(b.reIssues).toBe(true);
    expect(b.onOwningQueue).toBe(true);
    // Mutation: reconcile on the SLOW tick and the bounded window buys one
    // look instead of six — a gate that refuses everything it was built to
    // admit.
    expect(b.reconcileDrivesFast).toBe(true);
    // Mutation: park the caller with no timeout. The book is allowed to owe
    // forever; a CALLER waiting on it is not, or a wedged radio hangs the
    // camper's next start instead of refusing it.
    expect(b.boundedRefusal).toBe(true);
    // A REAL, SLOWER CADENCE. Nobody is waiting on this one, so it must
    // cost the phone less than the fast prover — and it must still be a
    // clock, not a spin.
    expect(b.slowTickMs).toBeGreaterThan(shape().proof.tickMs);
    expect(b.slowTickMs).toBeLessThanOrEqual(10000);
    // The bounded window a caller may wait: longer than the fast budget it
    // re-drives, short enough to refuse while the camper is standing there.
    expect(b.reconcileMs).toBeGreaterThan(
      shape().proof.budget * shape().proof.tickMs,
    );
    expect(b.reconcileMs).toBeLessThanOrEqual(3000);
  });

  test('DEBT (b) — a LATE proof settles the debt, and budget-false never does', () => {
    // THE RULING'S OWN LINE: "Do not treat budget false as terminal."
    // Mutation (plant debt-b): settle the debt inside `owe`, so the moment the
    // obligation is created it is discharged — the book then reports
    // CLEAR while the advertiser it was opened for is still radiating,
    // and every question after that is answered wrong.
    const s = shape();
    expect(s.book.budgetIsTerminal).toBe(false);
    // TWO TERMINALS, AND ONLY THOSE TWO. Mutation: add a third — a
    // `.resetting` or `.unauthorized` turn says nothing about what is on
    // the air, which is the same rule the fast prover keeps.
    expect(s.book.terminals).toEqual(['late-power-off', 'late-not-advertising']);

    const p = new Process(s);
    p.start(new Advertiser('A', 20));
    p.stop();
    // The budget is out. A is up, the debt is open, and the release is
    // PARKED rather than skipped-and-forgotten.
    expect(p.owes()).toBe(true);
    expect(p.radiating('A')).toBe(true);
    expect(p.hold).toBe(true);
    p.deliverSettle();
    expect(p.recovered).toBe(false);

    // …and the LATE proof, arriving long after the promise already failed
    // closed, is what ends it — and what finally lets the crew beacon back
    // on the air.
    p.slowTicks(16);
    expect(p.owes()).toBe(false);
    p.deliverSettle();
    expect(p.recovered).toBe(true);
    expect(p.hold).toBe(false);
    expect(p.releasedWhileUnaccounted).toBe(false);
  });

  test('DEBT (b), THE OTHER TERMINAL — an exact poweredOff settles it too', () => {
    // P2's late twin. The radio is physically down, so nothing of ours can
    // be on the air, and the debt ends without ever reading the flag.
    const s = shape();
    const p = new Process(s);
    p.start(new Advertiser('A', null));
    p.stop();
    expect(p.owes()).toBe(true);
    // The adapter goes off under the debt.
    p.owe(new Advertiser('off', null, true, true));
    p.slowTicks(1);
    expect(p.openDebts()).toBe(1);
    expect(p.log).toContain('debt-terminal off why=late-power-off');
  });

  test('DEBT (c) — a duplicate stop SERVICES the debt, it does not early-exit', () => {
    // THE SECOND TAP. `bleVoice` is nil by now, and the pre-fix road read
    // that as "this module has no advertiser on the air" — a true sentence
    // about the MODULE and a false one about the phone. Mutation (plant
    // debt-c): put `proven?(true, "no-rung")` back and the second tap releases
    // CrewBeacon on the strength of an advertiser nobody ever proved.
    const s = shape();
    expect(s.dup).toBe('services-book');

    const p = new Process(s);
    p.start(new Advertiser('A', 40));
    p.stop();
    expect(p.owes()).toBe(true);
    const looksBefore = p.openDebts();
    // The duplicate — no session, no advertiser, and it must still refuse.
    p.stop();
    expect(looksBefore).toBe(1);
    expect(p.released).toBe(false);
    expect(p.hold).toBe(true);

    // …and it is a SERVICE, not a refusal: the second tap re-drove the
    // stop, so a radio that was merely busy is closer to quiet than it was.
    // `dupSession` is PINNED, because this arm is about the NATIVE
    // duplicate road (Walkie.swift's cleared `bleVoice`) and not about
    // the JS verb's own early exit — which is a separate road with a
    // separate arm below. Isolating it keeps each plant's red set honest:
    // a mutation to the JS verb must not be able to redden this arm.
    //
    // THE CONSEQUENCE MOVED, and saying so is the honest version of this
    // arm (airtime cure, 2026-08-27). The JS reconcile road no longer
    // trusts the native stop's own answer at all — it re-drives and then
    // asks the PROCESS — so this defect can no longer reach a release
    // from up there. What it still owns is its own half: a stop that
    // early-exits on a cleared `bleVoice` re-drives NOTHING, so the
    // advertiser stays exactly as unproven as it was, and the phone's
    // best chance at ending the wedge is spent on a no-op.
    const a = new Advertiser('A', 40);
    const early = new Process({ ...s, dup: 'early-exit', dupSession: 'reconciles' });
    early.start(a);
    early.stop();
    const looked = a.looks;
    early.stop();
    expect(early.log).toContain('native stop -> resolve/no-rung');
    expect(a.looks).toBe(looked);
    // …while the cured road drives the book at the fast tick on that very
    // tap, which is what "a second tap is a second chance at the radio"
    // has to MEAN to be worth saying.
    // …and `dupSession` is PINNED here for the same reason it is pinned
    // above: this arm owns the NATIVE duplicate road, and a mutation to
    // the JS verb's own early exit must not be scoreable against it.
    const b = new Advertiser('A', 40);
    const driven = new Process({ ...s, dupSession: 'reconciles' });
    driven.start(b);
    driven.stop();
    const before = b.looks;
    driven.stop();
    expect(b.looks).toBeGreaterThan(before);
    // AND THE OUTER FENCE HOLDS EITHER WAY: "absent" is a fact about the
    // module, the process still needs the slot, and nothing is released.
    expect(early.released).toBe(false);
    expect(early.hold).toBe(true);
  });

  test('DEBT (d) — a new advertiser is not minted beside an unproven one', () => {
    // Mutation (plant debt-d): mint the peripheral manager without consulting
    // the book. Two 128-bit UUIDs do not fit one advertising packet, and
    // "the old WalkieBleVoice was released" is not the same fact as "the
    // old advert is off the air".
    const s = shape();
    expect(s.start).toBe('reconcile-then-refuse');

    const refused = new Process(s);
    refused.start(new Advertiser('A', 40));
    refused.stop();
    expect(refused.start(new Advertiser('B', 1))).toBe(false);
    expect(refused.admittedNewAdvertiser).toBe(false);

    // RECONCILE, NOT BLOCK — and this is the half a flat block would cost
    // the camper. A radio that answers the re-driven stop inside the window
    // clears the book, and rung 3 comes straight back up.
    const admitted = new Process(s);
    admitted.start(new Advertiser('A', 6));
    admitted.stop();
    expect(admitted.owes()).toBe(true);
    expect(admitted.start(new Advertiser('B', 1))).toBe(true);
    expect(admitted.owes()).toBe(false);
    expect(admitted.admittedNewAdvertiser).toBe(false);
    admitted.stop();
    expect(admitted.releasedWhileUnaccounted).toBe(false);

    const ungated = new Process({ ...s, start: 'ungated' });
    ungated.start(new Advertiser('A', 40));
    ungated.stop();
    expect(ungated.start(new Advertiser('B', 1))).toBe(true);
    expect(ungated.admittedNewAdvertiser).toBe(true);
  });

  test('DEBT (e) — the release waits for ALL debts, never the first', () => {
    // Mutation (plant debt-e): fire the hop on any terminal instead of on the
    // last one. The book is a MAP because the rule is over a SET, and a
    // release that follows the first terminal is a release that follows
    // the wrong fact.
    const s = shape();
    expect(s.book.hopOnLastOnly).toBe(true);
    // Mutation: let a second terminal for one debt transition again — the
    // book then "clears" twice and the second clear is a release nobody
    // gated.
    expect(s.book.idempotentSettle).toBe(true);

    const p = new Process(s);
    p.start(new Advertiser('A', 30));
    p.stop();
    p.owe(new Advertiser('C', 8));
    expect(p.openDebts()).toBe(2);
    // C goes quiet first. The book is NOT clear, so nothing is released.
    p.slowTicks(8);
    expect(p.openDebts()).toBe(1);
    p.deliverSettle();
    expect(p.released).toBe(false);
    expect(p.hold).toBe(true);
    // …and A's terminal is what ends it.
    p.slowTicks(30);
    expect(p.openDebts()).toBe(0);
    p.deliverSettle();
    expect(p.recovered).toBe(true);
    expect(p.releasedWhileUnaccounted).toBe(false);

    // BOTH FENCES DOWN (see DEBT (c)): the airtime state would refuse a
    // release while the book still holds A, so the hop-on-first defect is
    // double-covered now — and the world where its consequence is legible
    // is the one before the state existed.
    const first = new Process({
      ...s,
      book: { ...s.book, hopOnLastOnly: false },
      nativeFence: false,
    });
    first.start(new Advertiser('A', 30));
    first.stop();
    first.owe(new Advertiser('C', 8));
    first.slowTicks(8);
    first.deliverSettle();
    expect(first.released).toBe(true);
    expect(first.releasedWhileUnaccounted).toBe(true);
  });

  test('DEBT (f) — the settle cannot release a hold a NEW session owns', () => {
    // THE EVENT CARRIES NO SESSION. It says "the book is clear", which is
    // a fact about the process and never a claim on the airtime hold — and
    // by the time it lands the camper may have reopened the walkie, whose
    // start took that hold for itself. Releasing on the event would hand
    // CrewBeacon the slot out from under a LIVE walkie: the same overlap,
    // arriving by the back door.
    //
    // The start path also cancels the parked release, and that covers the
    // ordinary ordering. It does not cover this one: RN delivers what it
    // already dispatched, so an event emitted before the cancel still runs
    // its handler after it. Mutation (plant debt-f): drop the guard.
    const s = shape();
    expect(s.deferred).toBe('parked-and-guarded');

    const p = new Process(s);
    p.start(new Advertiser('A', 8));
    p.stop();
    expect(p.hold).toBe(true);
    // A goes quiet — the hop is dispatched with the park still live.
    p.slowTicks(4);
    expect(p.owes()).toBe(false);
    // …and the camper reopens the walkie before the handler runs.
    expect(p.start(new Advertiser('B', 1))).toBe(true);
    expect(p.hold).toBe(true);
    p.deliverSettle();
    expect(p.recovered).toBe(false);
    // THE NEW SESSION'S HOLD SURVIVES, and its own close is what releases.
    expect(p.hold).toBe(true);
    p.stop();
    expect(p.hold).toBe(false);
    expect(p.releasedWhileUnaccounted).toBe(false);

    // BOTH FENCES DOWN, because that is the world this arm describes.
    // Post-cure the two overlap by construction — a live session always
    // implies a newer generation — so the ownership fence alone would
    // refuse this script and the contrast would prove nothing. The
    // live-session fence's own discriminating read is the source
    // assertion at the top of this arm; this is the consequence of losing
    // the pair, which is the pre-cure world exactly.
    const unguarded = new Process({
      ...s,
      deferred: 'parked-unguarded',
      ownership: 'unowned',
      nativeFence: false,
    });
    unguarded.start(new Advertiser('A', 8));
    unguarded.stop();
    unguarded.slowTicks(4);
    unguarded.start(new Advertiser('B', 1));
    unguarded.deliverSettle();
    // The live walkie's own advertiser is up, and CrewBeacon just joined
    // it — the overflow overlap, re-created by the cure.
    expect(unguarded.hold).toBe(false);
    expect(unguarded.releasedWhileUnaccounted).toBe(true);
  });

  test('POSITIVE CONTROL — an ordinary close still owes nothing at all', () => {
    // A book that is never clear is an outage. The overwhelmingly common
    // close proves its advertiser on the first look after the stop, opens
    // no debt, and hands the slot straight back.
    const s = shape();
    const p = new Process(s);
    p.start(new Advertiser('A', 1));
    p.stop();
    expect(p.owes()).toBe(false);
    expect(p.released).toBe(true);
    expect(p.hold).toBe(false);
    expect(p.recovered).toBe(false);
    expect(p.releasedWhileUnaccounted).toBe(false);
    // …and the next session comes straight up: the gate costs a clean
    // phone nothing.
    expect(p.start(new Advertiser('B', 1))).toBe(true);
    expect(p.admittedNewAdvertiser).toBe(false);
  });

  test('the wiring is spelled the same on both sides of the bridge', () => {
    // Mutation: rename the event on one side. The deferred release then
    // subscribes to a name nothing emits, the hold strands exactly as it
    // did before the cure, and no test above would notice.
    // A DELIBERATELY NEW NAME. The previous era's `WalkieAdvertiserSettled`
    // carried an edge wearing four fields; renaming is what makes the two
    // eras impossible to confuse, so nothing can decode half of one as
    // the other (S9).
    expect(w).toContain('private static let airtimeEvent = "WalkieAirtimeState"');
    expect(js).toContain("addListener('WalkieAirtimeState'");
    expect(codeOnly(bracedBody(w, 'override func supportedEvents()'))).toContain(
      'Self.airtimeEvent',
    );
    // …and the previous era's name survives NOWHERE, on either side. A
    // build that still emitted it would emit a body this decoder answers
    // `null` for, and the capability policy turns that into an explicit
    // park rather than a subscription that waits forever.
    // …as a LIVE NAME, which is the thing that matters: the prose on both
    // sides names the old event on purpose, because a rename nobody
    // explains is a rename the next reader undoes.
    expect(js).not.toContain("addListener('WalkieAdvertiserSettled'");
    expect(w).not.toContain('"WalkieAdvertiserSettled"');
    // ARMED BY THE ARBITER'S OWN INIT, AND BY NOTHING ELSE. Mutation: arm
    // it in a session's start (where it used to live) and the hop is
    // missing for the FIRST debt — which is the one that matters — because
    // a debt can only be born after a walkie has opened once. Mutation:
    // tear it down in a teardown, and the settle that lands long after
    // the session that owed it lands nowhere.
    expect(codeOnly(bracedBody(w, 'private func stopInternal('))).not.toContain(
      'armBookChange',
    );
    expect(w).not.toContain('AdvertiserDebtBook');
    expect(
      codeOnly(bracedBody(sw, '  private init() {')),
    ).toContain('AdvertiserDebtBook.shared.armBookChange {');
    // …AND IT FIRES ON EVERY CHANGE, not only the clear edge. A published
    // state that moves only on the LAST terminal lies about the two
    // before it, and `debtCount` is part of that state.
    expect(codeOnly(debtOweBody(sw))).toContain('hop?("debt-born", false)');
    expect(codeOnly(debtSettleBody(sw))).toContain('hop?(why, clear)');
    // THE STRICT-FALSE GATE FROM 2edcc6a STAYS. The deferred release is an
    // addition to the fail-closed road, never a softening of it.
    expect(releaseGate(sess)).toBe('gated');
    expect(adapterProof(js)).toBe('reports-unproven');
    // …and the module still reads no CoreBluetooth state of its own: the
    // book does, on the manager's own queue.
    expect(w).not.toMatch(/\.isAdvertising/);
    expect(w).not.toMatch(/CBPeripheralManager/);
  });
});

/**
 * THE SETTLEMENT IS LEVEL-TRIGGERED, AND THE HOLD HAS AN OWNER
 * (advertiser-debt cross-family no-go, 2026-08-27, read of 45a928d).
 *
 * The block above proves the process does not forget the advertiser it
 * could not settle. This one proves the RELEASE cannot be lost, taken by
 * the wrong hand, or paid twice. Three windows, one root: the cure was
 * written as a moment.
 *
 *   (1) an EDGE with nobody listening — between the stop's `false` and
 *       the listener attaching, across a reload, across a background;
 *   (2) a public duplicate stop that returned before the native debt
 *       service, because "nothing standing" was read as "nothing owed";
 *   (3) a stale settlement delivered DURING a new start's awaits, where
 *       the live-session fence's honest answer is "nothing is standing"
 *       and the hold has nonetheless already changed hands.
 */
describe('the settlement is LEVEL-TRIGGERED, and the hold has an owner', () => {
  const sw = readVoiceSource();
  const w = readWalkieModuleSource();
  const js = readAdapterSource();
  const sess = readSessionSource();
  const shape = (): Shape => shapeOf(sw, w, js, sess);

  test('LEVEL (a) — the book clears in the gap before the listener attaches', () => {
    // CODEX'S SEAM (1), VERBATIM: "debt can clear between stopWalkie
    // false and listener attach … dropping the only event".
    const s = shape();
    // Mutation (plant level-a): delete the query and park on the event
    // alone, which is 45a928d's shape.
    expect(s.settleRoad).toBe('level-and-event');
    // …and the query must be able to say "I cannot answer" without that
    // being read as "the book is clear".
    expect(nullIsNotClear(js)).toBe(true);

    const cured = new Process(s);
    cured.start(new Advertiser('A', 6));
    // The native stop answers `false`, the debt goes on the book, and the
    // debt chain's own look lands BEFORE JS parks. The hop fires into an
    // empty room and is gone — RN has no replay.
    cured.stop(2);
    expect(cured.log).toContain('the settled event fired with nobody listening');
    // THE LEVEL IS WHAT SAVES IT. Subscribe first (nothing more can slip
    // past), query second (what already slipped past is still readable,
    // because a level is a standing fact and an edge is a moment).
    expect(cured.log).toContain('airtime read: clear');
    expect(cured.recovered).toBe(true);
    expect(cured.hold).toBe(false);
    expect(cured.releaseCount).toBe(1);
    expect(cured.releasedWhileUnaccounted).toBe(false);
    expect(cured.overlapNow()).toBe(false);

    // …and the same script on the event-only shape strands the hold for
    // the life of the process, which is the outage the event itself was
    // added to end — re-created by the gap it could not cover.
    const eventOnly = new Process({ ...s, settleRoad: 'event-only' });
    eventOnly.start(new Advertiser('A', 6));
    eventOnly.stop(2);
    expect(eventOnly.owes()).toBe(false);
    eventOnly.deliverSettle();
    eventOnly.slowTicks(50);
    eventOnly.deliverSettle();
    expect(eventOnly.recovered).toBe(false);
    expect(eventOnly.releaseCount).toBe(0);
    expect(eventOnly.hold).toBe(true);
  });

  test('LEVEL (b) — a fresh JS world reconciles a hold the old one left set', () => {
    // CODEX'S SEAM (1), ITS OTHER FACE: "or during reload/background".
    // Mutation (plant level-b): drop the init reconcile.
    const s = shape();
    expect(s.initReconcile).toBe(true);

    const cured = new Process(s);
    cured.start(new Advertiser('A', 6));
    cured.stop();
    expect(cured.hold).toBe(true);
    // The debt goes terminal while the app is down there, and the JS
    // world is then torn down and rebuilt. The park, the subscription and
    // the captured generation die with it. The HOLD does not: radio.ts's
    // suppression was set on the way down and nothing in the new world
    // clears it, so the crew beacon is off the air for a debt nobody is
    // watching any more.
    cured.slowTicks(6);
    cured.reload();
    expect(cured.log).toContain('js world reloaded');
    expect(cured.recovered).toBe(true);
    expect(cured.hold).toBe(false);
    expect(cured.releaseCount).toBe(1);
    expect(cured.releasedWhileUnaccounted).toBe(false);

    const noInit = new Process({ ...s, initReconcile: false });
    noInit.start(new Advertiser('A', 6));
    noInit.stop();
    noInit.slowTicks(6);
    noInit.reload();
    expect(noInit.recovered).toBe(false);
    expect(noInit.hold).toBe(true);

    // A CLEAN START COSTS ONE QUESTION. The road is no longer gated on a
    // JS flag (that gate is the airtime ruling's first face, and it shut
    // this road in exactly the world it was written for), so an ordinary
    // launch does ask — and is told the slot is free, owes nothing, and
    // touches no radio. A recovery road that charged every cold start
    // would be the cure billing the healthy case; one question is what
    // that costs.
    const clean = new Process(s);
    clean.reload();
    expect(clean.log).toContain('airtime read: clear');
    expect(clean.log).toContain('nothing was owed');
    expect(clean.releaseCount).toBe(0);
    expect(clean.hold).toBe(false);
  });

  test('LEVEL (c) — a duplicate PUBLIC stop reconciles instead of early-exiting', () => {
    // CODEX'S SEAM (2), VERBATIM: "public duplicate stop still early
    // -exits before native debt service; explicit deferred-debt JS
    // state/query makes duplicate stop reconcile."
    const s = shape();
    // Mutation (plant level-c): make the early exit unconditional again.
    expect(s.dupSession).toBe('reconciles');
    // …and `dup` is PINNED for the steps below, the mirror of the pin in
    // DEBT (c): that arm owns the NATIVE duplicate road, this one owns
    // the JS verb's. A reconcile that reaches a native stop which then
    // refuses to service the book proves nothing about the verb, and a
    // mutation to one road must not be scoreable as a failure of the
    // other.
    const s2: Shape = { ...s, dup: 'services-book' };

    const cured = new Process(s2);
    cured.start(new Advertiser('A', 8));
    cured.stop();
    expect(cured.hold).toBe(true);
    expect(cured.owes()).toBe(true);
    // THE SECOND TAP. No session, no runtime, no listeners, walkie.ts's
    // flag already false — everything the old guard looked at says
    // "nothing to do", and a debt is sitting on the native book whose one
    // event may already have gone past. It re-drives the native stop
    // (which SERVICES the book at the fast tick) and re-runs
    // subscribe-first-query-second against the answer.
    cured.stop();
    expect(cured.owes()).toBe(false);
    expect(cured.recovered).toBe(true);
    expect(cured.hold).toBe(false);
    expect(cured.releaseCount).toBe(1);
    expect(cured.releasedWhileUnaccounted).toBe(false);

    const early = new Process({ ...s2, dupSession: 'early-exit' });
    early.start(new Advertiser('A', 8));
    early.stop();
    early.stop();
    expect(early.log).toContain('duplicate stop: early exit');
    expect(early.owes()).toBe(true);
    expect(early.hold).toBe(true);

    // …AND A TRUE DUPLICATE STILL COSTS NOTHING. One stop is one stop:
    // with nothing standing and nothing owed the verb returns, exactly as
    // it did. A reconcile that fired on every stray stop would be a
    // native round-trip charged to the common case.
    const quiet = new Process(s2);
    quiet.start(new Advertiser('A', 1));
    quiet.stop();
    expect(quiet.releaseCount).toBe(1);
    quiet.stop();
    expect(quiet.log).toContain('duplicate stop: early exit');
    expect(quiet.releaseCount).toBe(1);
  });

  test('LEVEL (d) — a settlement in a new start’s await cannot take the NEW hold', () => {
    // CODEX'S SEAM (3), VERBATIM: "stale settlement dispatched during new
    // start await sees session null/walkieOn false and releases the NEW
    // hold; guard with explicit hold ownership generation minted before
    // hold, captured by debt close, release only if same generation still
    // owns and no live/pending start."
    const s = shape();
    // Mutation (plant level-d): drop the ownership fence.
    expect(s.ownership).toBe('generation');

    const cured = new Process(s);
    cured.start(new Advertiser('A', 8));
    cured.stop();
    expect(cured.hold).toBe(true);
    cured.slowTicks(4);
    expect(cured.owes()).toBe(false);
    // THE AWAIT WINDOW. holdCrewAdvertising has already run, so the NEW
    // hold is taken and owned by generation 2 — and neither the session
    // nor walkie.ts's flag is true yet, because doStartWalkieSession sets
    // them at the END. The live-session fence therefore sees exactly what
    // it saw a moment ago: nothing standing.
    cured.beginStart(new Advertiser('B', 1));
    cured.deliverSettle();
    expect(cured.log).toContain('deferred release refused: the hold changed hands');
    expect(cured.recovered).toBe(false);
    expect(cured.releaseCount).toBe(0);
    expect(cured.hold).toBe(true);
    // …AND THE NEW SESSION IS UNDISTURBED. It comes up on the hold it
    // took, and its own clean close is what hands the slot back.
    expect(cured.finishStart()).toBe(true);
    expect(cured.hold).toBe(true);
    expect(cured.overlapNow()).toBe(false);
    cured.stop();
    expect(cured.hold).toBe(false);
    expect(cured.releaseCount).toBe(1);
    expect(cured.releasedWhileUnaccounted).toBe(false);
    expect(cured.overlapNow()).toBe(false);

    // THE OTHER HALF OF OWNERSHIP: a start ASKED FOR and still queued
    // behind this very stop has minted no generation yet, so the
    // generation still matches and nothing is standing — and the hold it
    // is about to want would be handed back underneath it. Pending is
    // what makes that window visible.
    const queued = new Process(s);
    queued.start(new Advertiser('A', 8));
    queued.stop();
    queued.slowTicks(4);
    queued.askStart();
    queued.deliverSettle();
    expect(queued.hold).toBe(true);
    expect(queued.releaseCount).toBe(0);

    // …and without the fence the stale settlement takes the new hold.
    const unowned = new Process({ ...s, ownership: 'unowned' });
    unowned.start(new Advertiser('A', 8));
    unowned.stop();
    unowned.slowTicks(4);
    unowned.beginStart(new Advertiser('B', 1));
    unowned.deliverSettle();
    expect(unowned.hold).toBe(false);
    expect(unowned.finishStart()).toBe(true);
    // THE DEFECT, and it needs overlapNow() rather than the release-time
    // flag: the slot went back FIRST and rung 3's advertiser came up
    // beside it a moment later. Same overflow overlap, opposite order.
    expect(unowned.overlapNow()).toBe(true);
  });

  test('LEVEL (e) — the event and the level read pay the hold off exactly ONCE', () => {
    // TWO ROADS, ONE FACT. They overlap on purpose — that is what closes
    // the gap — so a book that clears on the turn between them must not
    // release twice. Mutation (plant level-e): drop the shared latch.
    const s = shape();
    expect(s.onceLatch).toBe(true);

    const p = new Process(s);
    p.start(new Advertiser('A', 5));
    p.stop();
    expect(p.hold).toBe(true);
    expect(p.releaseCount).toBe(0);
    // The debt goes terminal with the park LIVE, so the event road is the
    // one that pays.
    p.slowTicks(1);
    p.deliverSettle();
    expect(p.releaseCount).toBe(1);
    expect(p.hold).toBe(false);
    // …and the level read, arriving on its own later turn against the
    // same now-clear book, finds the work already done.
    p.queryLevel();
    p.deliverSettle();
    expect(p.releaseCount).toBe(1);
    expect(p.recovered).toBe(true);
    expect(p.releasedWhileUnaccounted).toBe(false);

    const noLatch = new Process({ ...s, onceLatch: false });
    noLatch.start(new Advertiser('A', 5));
    noLatch.stop();
    noLatch.slowTicks(1);
    noLatch.deliverSettle();
    noLatch.queryLevel();
    expect(noLatch.releaseCount).toBeGreaterThan(1);
  });

  test('the level is spelled the same on both sides of the bridge', () => {
    // Mutation: rename the method on one side. The query then asks a
    // native that has no such thing, walkieAirtimePresent answers false,
    // and the watch silently falls back to the event alone — the strand
    // restored, with every arm above still green.
    expect(w).toContain('@objc(airtimeState:rejecter:)');
    expect(codeOnly(bracedBody(w, 'func airtimeState('))).toContain(
      'resolve(Self.arbiter.currentState())',
    );
    const bridge = readBridgeSource();
    // ABSENT FROM THE BRIDGE IS ABSENT TO JS no matter how correct the
    // Swift is — the same rule logPulse and refreshDiscovery carry.
    expect(bridge).toContain('RCT_EXTERN_METHOD(airtimeState:');
    expect(js).toContain("typeof native.airtimeState === 'function'");
    // THE STATE IS A READ, NEVER A PROOF. The module still reads no
    // CoreBluetooth state of its own; the book does, on the manager's own
    // queue, and this only asks the book what it is still holding.
    expect(w).not.toMatch(/\.isAdvertising/);
    expect(w).not.toMatch(/CBPeripheralManager/);
    expect(
      codeOnly(bracedBody(sw, 'func ledger() -> (open: Int, epoch: UInt64) {')),
    ).toContain('lock.lock()');
  });
});

/**
 * WHO OWNS THE AIRTIME — the state a count could not carry
 * (cross-family no-go, 2026-08-27, read of c5b9e39).
 *
 * The block above proves the settlement is a level and the hold has an
 * owner. This one proves the level is about the right THING. The ruling:
 *
 *   "reload ownership is inferred from JS-local session/walkieOn/
 *   advertisingHeld — all reset independently of native CrewBeacon/
 *   Walkie/debt. This fails both ways: old debt+native hold survives
 *   while JS flag false so no reconcile and Crew may restart; or native
 *   live advertiser survives while JS state reset and count=0 releases
 *   underneath it. Count zero proves only debt clear, not airtime
 *   ownership."
 *
 * One root under both: the process's radios outlive the JS world that lit
 * them, and every fact JS held about them was a fact JS could reset. So
 * ownership is asked of the process, as one snapshot at one level, and
 * this world ADOPTS whatever that snapshot says it still owes.
 */
/*
 * ---------------------------------------------------------------------
 * THE ARBITER, AS A STEPPER — one radio, one lock, seven phases, and a
 * script anyone can run (cross-family ARCHITECTURE ruling, 2026-08-27).
 *
 * WHY A SECOND STEPPER AND NOT A BIGGER FIRST ONE. `Process` above models
 * the JS WORLD: reloads, parked releases, the fences a settlement has to
 * clear. This one models the NATIVE STATE MACHINE: leases, phases,
 * coalesced stops, the reservation queue, the crew suppression effect.
 * They are different scopes with different failure modes, and a stepper
 * that tried to be both would be a stepper whose failures name the wrong
 * one.
 *
 * AND IT IS DELIBERATELY NOT A MIRROR OF THE SWIFT'S ORDERING. The
 * test-vacuity finding was exactly that — a model that cleared the flag
 * the production fence reads, one line before it would have been read, so
 * the race was unrepresentable and every arm above it passed vacuously.
 * The rule this file now keeps: every property that can be checked
 * against the real code is checked against the real code (the readers
 * above), and this stepper only ever explores ORDERINGS the shape says
 * are reachable.
 * ---------------------------------------------------------------------
 */

/** What the arbiter answers a stop with. `unknown` is the JS boundary's
 *  word for an answer it could not read, and never one of these. */
type StopWord = 'clear' | 'debt' | 'notOwner';

type Phase =
  | 'idle'
  | 'reserving'
  | 'suppressingCrew'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'debt';

type Rung = 'none' | 'advertising' | 'degraded';

/** One published state, exactly the fields the wire carries. */
interface ArbState {
  v: number;
  processIncarnation: string;
  revisionHi: number;
  revisionLo: number;
  phase: Phase;
  leaseId: string | null;
  opId: string | null;
  rung: Rung;
  debtCount: number;
  crewMayAdvertise: boolean;
  holdRequired: boolean;
  why: string;
}

/** The knobs a plant turns, each one a property the ruling names. */
interface ArbShape {
  /** Does `reserve` WRITE the lease under the lock before answering, or
   *  merely QUERY the book (arbiter addendum 2)? */
  admission: 'reserve-atomically' | 'debt-query-only';
  /** Does a duplicate stop join the standing operation's terminal, or
   *  answer on its own (arbiter addendum 1)? */
  duplicateStop: 'coalesce' | 'answer-alone';
  /** Does a retirement wake at most ONE parked reservation? */
  wake: 'one' | 'all';
  /** Is the crew suppression proven by EFFECT, or believed on the ask
   *  (S2)? */
  suppression: 'effect-proven' | 'ask-is-proof';
  /** Does a start op reach `active` only on its rung's own effect
   *  (arbiter addendum 3)? */
  startAck: 'effect' | 'issue';
  /** Does an exact lease own the hold, or an anonymous flag (S1)? */
  owner: 'exact-lease' | 'anonymous-flag';
}

/**
 * THE SHAPE, READ OUT OF THE SOURCE — and this is not a convenience.
 *
 * A stepper whose "cured" constants are written HERE proves only that the
 * stepper agrees with itself: plant the defect in the Swift and every arm
 * stays green, because nothing the arm looks at moved. That is the
 * test-vacuity finding wearing a different hat, and the plant harness
 * catches it as "reddened NOTHING — the plant proves no arm
 * discriminates".
 *
 * So every knob below is a READ. A plant that mutates the arbiter flips
 * exactly the knob it mutated, and the arm that names that property is
 * the arm that goes red.
 */
const arbShapeOf = (sw: string, w: string, crew: string): ArbShape => {
  const reserve = reserveBody(sw);
  const retire = codeOnly(
    bracedBody(sw, '  private func retireLease(why: String) -> Retirement {'),
  );
  const arm = codeOnly(bracedBody(sw, '  func armStart('));
  const prove = codeOnly(bracedBody(crew, '  private func proveCrewDown('));
  const bridgeStop = codeOnly(bridgeStopBody(w));
  const arbStop = arbiterStopBody(sw);
  return {
    // THE WRITE PRECEDES THE ANSWER, and a lease in ANY live phase is a
    // refusal. Mutation: narrow the guard so an active lease falls
    // through to the mint, and two starts both pass.
    admission:
      /if let l = lease \{\n\s*if l\.phase == \.debt \{/.test(reserve) &&
      reserve.indexOf('lease = l') > -1 &&
      reserve.indexOf('lease = l') < reserve.indexOf('answer(l.id, "reserved")')
        ? 'reserve-atomically'
        : 'debt-query-only',
    // THE SECOND TAP JOINS THE TERMINAL — and it can only do that if it
    // still carries the lease's name when it arrives.
    duplicateStop:
      /l\.stopWaiters\.append\(\(requestId: requestId, answer: done\)\)/.test(arbStop) &&
      // THE NAME SURVIVES THE ISSUE. Clearing it on the way IN is what
      // made the second tap anonymous — it arrived holding nothing, so it
      // could not be coalesced onto the terminal the first tap is waiting
      // for. It is cleared at the terminal instead, and only on `clear`.
      /let held = airtimeLease\n\s*stopInternal\(\)/.test(bridgeStop) &&
      /if outcome == \.clear \{/.test(bridgeStop)
        ? 'coalesce'
        : 'answer-alone',
    // AT MOST ONE. Mutation: iterate the queue and hand every waiter an
    // id, and several starts each believe the one free slot is theirs.
    wake:
      /let next = reserveQueue\.removeFirst\(\)/.test(retire) &&
      !/for other in reserveQueue/.test(retire)
        ? 'one'
        : 'all',
    // P3, READ FRESH ON A LATER TURN, and a budget that fails CLOSED.
    // Mutation: answer `true` on the ask and the effect is never read.
    // …AND THE TERMINALS ARE READ AS A SET, not as one matching line. A
    // plant that inserts an unconditional `done(true, …)` leaves every
    // effect read exactly where it was and simply never reaches them —
    // which a reader looking for "is P3 present?" cannot see. There are
    // exactly four roads out and each one names the fact it settled on.
    suppression: (() => {
      const trues = [...prove.matchAll(/done\(true, "([a-z-]+)"\)/g)].map((m) => m[1]);
      const falses = [...prove.matchAll(/done\(false, "([a-z-]+)"\)/g)].map((m) => m[1]);
      return trues.join('|') === 'absent|power-off|not-advertising' &&
        falses.join('|') === 'crew-still-advertising' &&
        // P3 IS READ ON A LATER TURN, never in the block that asked.
        /if tries > 0, !mgr\.isAdvertising \{/.test(prove)
        ? 'effect-proven'
        : 'ask-is-proof';
    })(),
    // ARMING IS NOT EFFECTING. Mutation: move the lease to `active` here
    // and a snapshot calls the rung advertising on the turn it was asked.
    startAck:
      /l\.stopper = stopper/.test(arm) && !/l\.phase = \.active/.test(arm)
        ? 'effect'
        : 'issue',
    // AN EXACT LEASE, not an anonymous flag.
    owner: /guard let id, l\.id == id else \{/.test(arbStop)
      ? 'exact-lease'
      : 'anonymous-flag',
  };
};

/** One advertiser's radio, as GROUND TRUTH — it radiates whether or not
 *  anybody is watching, which is the whole point. */
class Radiator {
  looks = 0;
  up = false;

  constructor(
    readonly label: string,
    /** Looks after which `isAdvertising` first answers false. null never
     *  goes quiet. */
    readonly quietAfter: number | null,
  ) {}

  radiating(): boolean {
    return this.up && (this.quietAfter === null || this.looks < this.quietAfter);
  }
}

interface Lease {
  id: string;
  phase: Phase;
  rung: Rung;
  opId: string;
  /** THE RETAINED OPERATION HANDLE — on the lease, never on a client, so
   *  a client that cleared its own field cannot make the operation
   *  unfindable. */
  advertiser: Radiator | null;
  waiters: string[];
}

/** One bridge instance — a JS reload builds a second one over the same
 *  radios, which is the whole of S1. */
class Client {
  lease: string | null = null;
  sink: string | null = null;
  constructor(readonly name: string) {}
}

class Arbiter {
  readonly log: string[] = [];
  /** Every state ever published, in order. */
  readonly published: ArbState[] = [];
  private lease: Lease | null = null;
  /** THE REVISION IS A PAIR HERE TOO, and it has to be: a stepper that
   *  kept it in one JS number could not represent 2^53 and 2^53+1 as
   *  different values, which is the exact fact the arm below exists to
   *  catch. A model that cannot express the defect cannot test for it —
   *  that is the test-vacuity finding, applied to itself. */
  private revHi: number;
  private revLo: number;
  private nextLease = 1;
  private nextOp = 1;
  private nextReq = 1;
  private nextSink = 1;
  private readonly sinks = new Map<string, ArbState[]>();
  private readonly reserveQueue: ((id: string | null, why: string) => void)[] = [];
  /** Every bridge instance the arbiter has answered — a JS reload builds a
   *  second one over the same radios. */
  private readonly clients: Client[] = [];
  private readonly debts = new Map<string, Radiator>();
  private readonly radiators: Radiator[] = [];
  /** THE CREW BEACON'S OWN RADIO, and the one the gate protects. */
  crewUp = true;
  crewSuppressed = false;
  /** How many looks the crew's suppression needs before it goes quiet.
   *  null is a beacon that will not go quiet inside the budget. */
  crewQuietAfter: number | null = 0;
  crewResumes = 0;
  /** THE DEFECT, as one boolean: two of ours on the air at once. */
  overlapEver = false;

  constructor(
    private readonly s: ArbShape,
    readonly incarnation = 'proc-1',
    revisionBase = 0,
  ) {
    this.revHi = Math.floor(revisionBase / 2 ** 32);
    this.revLo = revisionBase % 2 ** 32;
  }

  // ------------------------------------------------------ ground truth

  private radiatingAny(): boolean {
    return this.radiators.some((r) => r.radiating());
  }

  radiating(label: string): boolean {
    return this.radiators.some((r) => r.label === label && r.radiating());
  }

  crewRadiating(): boolean {
    return this.crewUp && !this.crewSuppressed;
  }

  private checkOverlap(): void {
    if (this.crewRadiating() && this.radiatingAny()) {
      this.overlapEver = true;
    }
  }

  phase(): Phase {
    return this.lease?.phase ?? 'idle';
  }

  openDebts(): number {
    return this.debts.size;
  }

  // ------------------------------------------------------------ state

  private state(why: string): ArbState {
    const l = this.lease;
    return {
      v: 2,
      processIncarnation: this.incarnation,
      revisionHi: this.revHi,
      revisionLo: this.revLo,
      phase: l?.phase ?? 'idle',
      leaseId: l?.id ?? null,
      opId: l?.opId ?? null,
      rung: l?.rung ?? 'none',
      debtCount: this.debts.size,
      crewMayAdvertise: l === null,
      holdRequired: l !== null,
      why,
    };
  }

  private bump(why: string): void {
    this.revLo += 1;
    if (this.revLo >= 2 ** 32) {
      this.revLo = 0;
      this.revHi += 1;
    }
    const st = this.state(why);
    this.published.push(st);
    for (const box of this.sinks.values()) {
      box.push(st);
    }
    this.log.push(
      'rev ' + String(this.revHi) + ':' + String(this.revLo) + ' ' + st.phase + ' why=' + why,
    );
  }

  /** A state sink, by exact token — and the current state is REPLAYED on
   *  registration, which is what makes a missed event safe. */
  addSink(c: Client): string {
    const token = 's' + String(this.nextSink);
    this.nextSink += 1;
    this.sinks.set(token, [this.state('replay')]);
    c.sink = token;
    return token;
  }

  /** A bridge invalidate removes exactly its OWN sink and touches no
   *  lease — in every phase. */
  invalidate(c: Client): void {
    if (c.sink !== null) {
      this.sinks.delete(c.sink);
      c.sink = null;
    }
    this.log.push(c.name + ' invalidated');
  }

  seen(c: Client): ArbState[] {
    return c.sink === null ? [] : (this.sinks.get(c.sink) ?? []);
  }

  sinkCount(): number {
    return this.sinks.size;
  }

  // ------------------------------------------------------ reservation

  /**
   * RESERVE. The cured road WRITES first — the lease is minted before
   * anybody is answered, so the second caller in the same turn finds a
   * lease rather than an answer. The degenerate road is the pre-ruling
   * shape: a debt QUERY, which two debt-free starts both pass.
   */
  reserve(c: Client, onParked?: (id: string | null, why: string) => void): boolean {
    if (this.s.admission === 'debt-query-only') {
      if (this.debts.size > 0) {
        this.log.push(c.name + ' reserve refused why=advertiser-debt');
        return false;
      }
      // NOTHING WAS WRITTEN DOWN, so the next caller asks the same
      // question and gets the same true answer.
      c.lease = 'shared';
      this.log.push(c.name + ' admitted by query');
      if (this.lease === null) {
        this.lease = {
          id: 'shared',
          phase: 'reserving',
          rung: 'none',
          opId: 'O0',
          advertiser: null,
          waiters: [],
        };
        this.bump('reserve');
      }
      return true;
    }
    if (this.lease !== null) {
      if (this.lease.phase === 'debt') {
        if (onParked) {
          this.reserveQueue.push(onParked);
          this.log.push(c.name + ' reserve parked behind debt');
        }
        return false;
      }
      this.log.push(c.name + ' reserve refused phase=' + this.lease.phase);
      return false;
    }
    const id = this.incarnation + '/L' + String(this.nextLease);
    this.nextLease += 1;
    this.lease = {
      id,
      phase: 'reserving',
      rung: 'none',
      opId: 'O' + String(this.nextOp),
      advertiser: null,
      waiters: [],
    };
    this.nextOp += 1;
    c.lease = id;
    if (!this.clients.includes(c)) {
      this.clients.push(c);
    }
    this.bump('reserve');
    return true;
  }

  // --------------------------------------------------- crew suppression

  /** THE EFFECT, not the ask. `false` is a beacon that would not go quiet
   *  inside the budget, and the lease then DEGRADES rather than minting a
   *  second advertiser beside it. */
  suppressCrew(c: Client, budget = 4): boolean {
    const l = this.lease;
    if (l === null || c.lease !== l.id) {
      return false;
    }
    l.phase = 'suppressingCrew';
    this.bump('suppressing-crew');
    if (this.s.suppression === 'ask-is-proof') {
      // THE ISSUE WEARING THE EFFECT'S CLOTHES: the beacon was ASKED and
      // the answer is taken as the fact.
      this.crewSuppressed = true;
      l.phase = 'starting';
      this.bump('crew-suppressed');
      return true;
    }
    const proven = this.crewQuietAfter !== null && this.crewQuietAfter <= budget;
    if (proven) {
      this.crewSuppressed = true;
      l.phase = 'starting';
      this.bump('crew-suppressed');
      return true;
    }
    // DEGRADE, NEVER OVERLAP: the lease keeps the slot and mints nothing.
    l.phase = 'active';
    l.rung = 'degraded';
    this.bump('degraded-no-suppression-proof');
    this.log.push('crew suppression unproven: rung 3 refused');
    return false;
  }

  // ---------------------------------------------------------- the start

  /** Mint the advertiser and RETAIN its stop handle on the lease. */
  arm(c: Client, a: Radiator): void {
    const l = this.lease;
    if (l === null || c.lease !== l.id || l.phase !== 'starting') {
      this.log.push('arm refused: not this lease’s to start');
      return;
    }
    l.advertiser = a;
    this.radiators.push(a);
    if (this.s.startAck === 'issue') {
      // THE PRE-RULING SHAPE: the radio was ASKED and the state says
      // active. A snapshot may now call it advertising before its effect.
      a.up = true;
      l.phase = 'active';
      l.rung = 'advertising';
      this.bump('active');
      this.checkOverlap();
    }
  }

  /** `didStartAdvertising` — success or error, and either way a TERMINAL.
   *  Before this existed the lease sat in `starting` with no settlement
   *  at all. */
  startEffect(c: Client, ok: boolean, why = ok ? 'advertising' : 'advertise-error'): void {
    const l = this.lease;
    if (l === null || c.lease !== l.id || l.phase !== 'starting') {
      return; // one terminal only
    }
    if (ok && l.advertiser) {
      l.advertiser.up = true;
    }
    l.phase = 'active';
    l.rung = ok ? 'advertising' : 'degraded';
    this.bump(ok ? 'active' : 'degraded');
    this.log.push('start-effect ' + l.rung + ' why=' + why);
    this.checkOverlap();
  }

  /** What a reader would see RIGHT NOW. */
  current(): ArbState {
    return this.state('query');
  }

  // ----------------------------------------------------------- the stop

  /**
   * THE BARRIER. Duplicates coalesce onto the SAME terminal; a client
   * that never held this lease gets `notOwner` and nothing moves.
   *
   * `proofLooks` is how many looks the advertiser gets before the budget
   * runs out — the fast prover's own bound, stepped.
   */
  stop(c: Client, budget = 4): { word: StopWord | 'pending'; req: string } {
    const req = 'R' + String(this.nextReq);
    this.nextReq += 1;
    const l = this.lease;
    if (l === null) {
      // Nothing owns the air: there is nothing to hand back and nothing
      // to hold. `clear` is exact here; `notOwner` would park a hold that
      // was never taken.
      return { word: 'clear', req };
    }
    if (this.s.owner === 'exact-lease' && c.lease !== l.id) {
      this.log.push(c.name + ' stop -> notOwner');
      return { word: 'notOwner', req };
    }
    if (l.phase === 'debt') {
      return { word: 'debt', req };
    }
    if (l.phase === 'stopping') {
      if (this.s.duplicateStop === 'coalesce') {
        l.waiters.push(req);
        this.log.push(c.name + ' stop coalesced req=' + req);
        return { word: 'pending', req };
      }
      // THE HOLE THE ADDENDUM NAMES: the second stop finds the client's
      // own field cleared, the book still empty because the first proof
      // has not failed yet, and answers `clear` while the first
      // advertiser may still be radiating.
      c.lease = null;
      this.log.push(c.name + ' stop answered ALONE while a stop was in flight');
      return { word: 'clear', req };
    }
    l.phase = 'stopping';
    l.opId = 'O' + String(this.nextOp);
    this.nextOp += 1;
    l.waiters = [req];
    this.bump('stopping');
    // The retained handle — reachable even though the client just cleared
    // its own field, which is the entire point of retaining it here.
    const a = l.advertiser;
    if (a === null) {
      this.finishStop(this.debts.size === 0, 'no-advertiser');
      return { word: 'pending', req };
    }
    for (let i = 0; i < budget; i += 1) {
      a.looks += 1;
      if (!a.radiating()) {
        a.up = false;
        this.finishStop(this.debts.size === 0, 'not-advertising');
        return { word: 'pending', req };
      }
    }
    // BUDGET OUT: the advertiser moves onto the book BEFORE the answer,
    // so there is no window in which anyone was told "unproven" and
    // nothing is watching.
    this.debts.set(a.label, a);
    this.log.push('debt-open ' + a.label);
    this.finishStop(false, 'advertiser-still-up');
    return { word: 'pending', req };
  }

  /** How each coalesced request was answered — every one of them, and
   *  with the SAME word, because there was one terminal. */
  readonly answers = new Map<string, StopWord>();

  private finishStop(clear: boolean, why: string): void {
    const l = this.lease;
    if (l === null || l.phase !== 'stopping') {
      return;
    }
    const id = l.id;
    const waiters = l.waiters;
    l.waiters = [];
    l.advertiser = null;
    if (clear) {
      this.retire('stop-clear');
    } else {
      l.phase = 'debt';
      l.rung = 'none';
      this.bump('debt-transfer');
    }
    for (const w of waiters) {
      this.answers.set(w, clear ? 'clear' : 'debt');
    }
    if (clear) {
      // The lease is retired; the id is dead. A debt keeps its name.
      for (const c of this.clients) {
        if (c.lease === id) {
          c.lease = null;
        }
      }
    }
    this.log.push('stop terminal ' + (clear ? 'clear' : 'debt') + ' why=' + why);
  }

  /** The debt chain's own looks, on the demoted cadence. */
  slowTicks(n: number): void {
    for (let i = 0; i < n; i += 1) {
      for (const [label, a] of [...this.debts]) {
        a.looks += 1;
        if (!a.radiating()) {
          a.up = false;
          this.debts.delete(label);
          this.log.push('debt-terminal ' + label);
          this.bump('debt-settled-book');
          if (this.debts.size === 0 && this.lease?.phase === 'debt') {
            this.retire('debt-settled');
          }
        }
      }
    }
  }

  /** BOTH ROADS OUT OF A HOLD end here — and at most ONE parked
   *  reservation takes the slot, so a final settlement cannot wake every
   *  waiter into one free slot. */
  private retire(why: string): void {
    if (this.debts.size > 0) {
      // The invariant, enforced: a book that owes demotes instead.
      if (this.lease) {
        this.lease.phase = 'debt';
        this.lease.rung = 'none';
      }
      this.bump('debt-transfer');
      return;
    }
    this.lease = null;
    const woken = this.s.wake === 'one' ? this.reserveQueue.splice(0, 1) : this.reserveQueue.splice(0);
    if (woken.length === 0) {
      this.bump(why);
      this.crewSuppressed = false;
      this.crewResumes += 1;
      this.checkOverlap();
      return;
    }
    for (const w of woken) {
      const id = this.incarnation + '/L' + String(this.nextLease);
      this.nextLease += 1;
      if (this.lease === null) {
        this.lease = {
          id,
          phase: 'reserving',
          rung: 'none',
          opId: 'O' + String(this.nextOp),
          advertiser: null,
          waiters: [],
        };
        this.nextOp += 1;
        this.bump(why + '-handoff');
      }
      w(id, 'reserved');
    }
  }
}

/**
 * ONE ARBITER, ONE RADIO — the architecture round (cross-family ruling,
 * 2026-08-27, read of a24b1e2).
 *
 *   "The minimal coherent root is ONE process-lifetime native
 *   Airtime/Radio Arbiter shared by CrewBeacon + Walkie, with exact
 *   leaseId/opId/requestId, one serialized native state machine, retained
 *   operation handles, process incarnation + wire-safe revision string,
 *   and bridge modules as stateless clients/sinks. JS epochs remain
 *   stale-write guards/UX ordering only; snapshots/events are
 *   observability, never authority to release a radio hold."
 *
 * FOUR ROUNDS PUT THE DECISION IN FOUR DIFFERENT PLACES and wrote a fence
 * for each: an event, a level, a count, four fields and a token. Every
 * fence was correct about the fact it guarded. None of them changed WHO
 * DECIDES, so all of them could be beaten by a snapshot that was true
 * when it was built and false when it was read. This family is the round
 * that moves the decision instead of adding a fifth fence.
 */
describe('one arbiter owns the airtime, and a snapshot is not a decision', () => {
  const sw = readVoiceSource();
  const w = readWalkieModuleSource();
  const js = readAdapterSource();
  const sess = readSessionSource();
  const crew = readCrewSource();
  const shape = (): Shape => shapeOf(sw, w, js, sess);
  /** THE STEPPER'S KNOBS, ALL OF THEM READ. See arbShapeOf. */
  const cured = (): ArbShape => arbShapeOf(sw, w, crew);

  test('THE MACHINE — seven phases, one lock, and a lease that has a NAME', () => {
    const a = shape().airtime;
    // Mutation: delete any reachable half (the arbiter type, the bridge
    // line, the JS adapter) and the seam is a name that answers nothing.
    expect(a.present).toBe(true);
    // S1, and the sentence a24 could not say: the hold is an EXACT lease,
    // not a static Bool. An anonymous hold is one anybody may end, which
    // is precisely what a second bridge instance's stop did.
    expect(a.rule).toBe('exact-lease');
    // …and all seven states the ruling enumerates exist. Mutation: fold
    // `reserving` into `starting` and the window two simultaneous starts
    // race in becomes unrepresentable — which is how it survived four
    // rounds of fences.
    expect(a.phases).toEqual([
      'idle',
      'reserving',
      'suppressingCrew',
      'starting',
      'active',
      'stopping',
      'debt',
    ]);
    // ONE MOMENT, not a composite: the body is built under the lock with
    // the book read inside it, and nothing is called back out until it is
    // released.
    expect(a.oneLockOrder).toBe(true);
    // S5: identity and ordering are different questions and one field
    // cannot answer both. A lease reserved, suppressed, started and
    // stopped is ONE owner across FIVE revisions.
    expect(a.wireSafeRevision).toBe(true);
    // ONE SHAPE, TWO ROADS — and a sink is replayed on registration, so a
    // missed event is safe. An edge has no replay; a level does.
    expect(a.eventCarriesState).toBe(true);
    expect(a.replaysOnRegister).toBe(true);
    // THE RULING'S OWN SENTENCE, compiled: CrewBeacon may advertise iff
    // no lease occupies any phase — read at the line that radiates, not
    // at a JS call site.
    expect(a.gateAtEffect).toBe(true);
    // S2: the arbiter owns the suppression EFFECT, and an unproven
    // suppression degrades the walkie advertiser instead of overlapping.
    expect(a.suppressionProven).toBe(true);
    // S4: the release is a direct arbiter action against the lease it
    // just retired — never a JS action from a stale snapshot.
    expect(a.nativeRelease).toBe(true);
    // Arbiter addendum 3: a rung is `active` only on its own effect.
    expect(a.effectBeforeActive).toBe(true);
    // …and JS keeps its generation and pending count as ORDERING guards.
    expect(shape().ownership).toBe('generation');

    // EVERY KNOB THE STEPPER TURNS IS ALSO A CLAIM ABOUT THE SOURCE, and
    // asserting them here is what makes them falsifiable. A stepper knob
    // that is only ever READ into a model can be mutated in the Swift
    // without any arm noticing — the plant harness reports that as
    // "reddened NOTHING", and a plant that proves no arm discriminates is
    // the vacuity finding in its purest form.
    expect(cured()).toEqual({
      admission: 'reserve-atomically',
      duplicateStop: 'coalesce',
      wake: 'one',
      suppression: 'effect-proven',
      startAck: 'effect',
      owner: 'exact-lease',
    });
  });

  test('S1 — a second bridge instance cannot overlap, and its stop cannot clear the first', () => {
    // THE SPEC'S OWN SENTENCE: "second bridge start cannot overlap and
    // instance B stop cannot clear A."
    const arb = new Arbiter(cured());
    const a = new Client('A');
    const b = new Client('B');
    expect(arb.reserve(a)).toBe(true);
    arb.suppressCrew(a);
    arb.arm(a, new Radiator('A-adv', 2));
    arb.startEffect(a, true);
    expect(arb.phase()).toBe('active');

    // B is the JS reload's new instance over the same radios. It holds no
    // lease, so it cannot take the slot…
    expect(arb.reserve(b)).toBe(false);
    expect(arb.log).toContain('B reserve refused phase=active');
    // …and its STOP cannot end A's hold either. Mutation (plant
    // arbiter-a): make the owner an anonymous flag and B's stop clears
    // A's, which is a24's `sessionLive` exactly.
    expect(arb.stop(b).word).toBe('notOwner');
    expect(arb.phase()).toBe('active');
    expect(arb.radiating('A-adv')).toBe(true);
    expect(arb.crewRadiating()).toBe(false);
    expect(arb.overlapEver).toBe(false);

    const loose = new Arbiter({ ...cured(), owner: 'anonymous-flag' });
    const la = new Client('A');
    const lb = new Client('B');
    loose.reserve(la);
    loose.suppressCrew(la);
    loose.arm(la, new Radiator('A-adv', null)); // a wedged stack
    loose.startEffect(la, true);
    loose.stop(lb);
    // B's stop drove A's advertiser to a debt and, worse, was allowed to
    // drive it at all.
    expect(loose.log).not.toContain('B stop -> notOwner');
  });

  test('S2 — a suppression that cannot be PROVEN degrades the rung, it never overlaps', () => {
    // "if suppression cannot be effect-proven, degrade/refuse Walkie
    // peripheral advertiser, never overlap."
    const arb = new Arbiter(cured());
    arb.crewQuietAfter = null; // a beacon that will not go quiet
    const c = new Client('A');
    expect(arb.reserve(c)).toBe(true);
    expect(arb.suppressCrew(c)).toBe(false);
    expect(arb.phase()).toBe('active');
    expect(arb.current().rung).toBe('degraded');
    // The lease still HOLDS — the crew beacon is still gated — and no
    // walkie advertiser was minted, so there is nothing to overlap with.
    expect(arb.current().holdRequired).toBe(true);
    expect(arb.current().crewMayAdvertise).toBe(false);
    expect(arb.overlapEver).toBe(false);

    // …and believing the ASK (plant arbiter-b) puts the walkie's
    // advertiser up beside a beacon nobody proved quiet: two 128-bit
    // UUIDs in one packet, which is the measured defect.
    const asked = new Arbiter({ ...cured(), suppression: 'ask-is-proof' });
    asked.crewQuietAfter = null;
    const ac = new Client('A');
    asked.reserve(ac);
    expect(asked.suppressCrew(ac)).toBe(true);
    asked.arm(ac, new Radiator('A-adv', 2));
    asked.startEffect(ac, true);
    // The model's own ground truth: the beacon never actually stopped.
    expect(asked.crewQuietAfter).toBeNull();
  });

  test('ADMISSION — two debt-free starts in one turn, and only ONE gets the slot', () => {
    // ARBITER ADDENDUM 2, verbatim: "current admit is debt query only;
    // two debt-free starts both pass". A query is a question about the
    // PAST. Both callers ask it in the same turn, both get the same true
    // answer, and nothing in between wrote anything down.
    const arb = new Arbiter(cured());
    const a = new Client('A');
    const b = new Client('B');
    expect(arb.reserve(a)).toBe(true);
    expect(arb.reserve(b)).toBe(false);
    expect(arb.log).toContain('B reserve refused phase=reserving');
    // The write is what makes the second caller find a LEASE rather than
    // an answer — and it happened before anybody was told anything.
    expect(arb.current().phase).toBe('reserving');

    const queried = new Arbiter({ ...cured(), admission: 'debt-query-only' });
    const qa = new Client('A');
    const qb = new Client('B');
    expect(queried.reserve(qa)).toBe(true);
    // Mutation (plant arbiter-c): both pass, because the book was clean
    // when each of them looked and neither of them wrote.
    expect(queried.reserve(qb)).toBe(true);
    queried.suppressCrew(qa);
    queried.arm(qa, new Radiator('A-adv', 5));
    queried.startEffect(qa, true);
    queried.suppressCrew(qb);
    queried.arm(qb, new Radiator('B-adv', 5));
    queried.startEffect(qb, true);
    expect(queried.radiating('A-adv') && queried.radiating('B-adv')).toBe(true);
  });

  test('ADMISSION — the last debt wakes at most ONE waiter, not all of them', () => {
    // "…and final debt settlement wakes all waiters together. […]
    // queue/wake at most one next start after clear."
    const arb = new Arbiter(cured());
    const a = new Client('A');
    arb.reserve(a);
    arb.suppressCrew(a);
    arb.arm(a, new Radiator('A-adv', 8));
    arb.startEffect(a, true);
    arb.stop(a); // budget 4 < 8 looks: the debt is born
    expect(arb.phase()).toBe('debt');
    expect(arb.openDebts()).toBe(1);

    const woken: string[] = [];
    const b = new Client('B');
    const c = new Client('C');
    expect(arb.reserve(b, id => woken.push('B:' + String(id !== null)))).toBe(false);
    expect(arb.reserve(c, id => woken.push('C:' + String(id !== null)))).toBe(false);
    arb.slowTicks(8);
    // ONE start takes the slot; the other stays queued rather than
    // believing it has a slot somebody else is standing in.
    expect(woken).toEqual(['B:true']);
    expect(arb.phase()).toBe('reserving');

    // Mutation (plant arbiter-d): wake them all, and two starts each
    // believe the one free slot is theirs.
    const all = new Arbiter({ ...cured(), wake: 'all' });
    const aa = new Client('A');
    all.reserve(aa);
    all.suppressCrew(aa);
    all.arm(aa, new Radiator('A-adv', 8));
    all.startEffect(aa, true);
    all.stop(aa);
    const got: string[] = [];
    all.reserve(new Client('B'), id => got.push('B:' + String(id !== null)));
    all.reserve(new Client('C'), id => got.push('C:' + String(id !== null)));
    all.slowTicks(8);
    expect(got).toEqual(['B:true', 'C:true']);
  });

  test('DUPLICATE STOP — the second tap joins the terminal; it does not answer over it', () => {
    // ARBITER ADDENDUM 1, verbatim: "stop1 nils instance bleVoice before
    // async proof; stop2 sees nil, debt book still empty, answers clear
    // and releases while stop1 advertiser may radiate."
    const arb = new Arbiter(cured());
    const a = new Client('A');
    arb.reserve(a);
    arb.suppressCrew(a);
    const adv = new Radiator('A-adv', 8); // wedged past the budget
    arb.arm(a, adv);
    arb.startEffect(a, true);

    // THE OLD SHAPE CLEARED THE CLIENT'S OWN FIELD ON THE WAY IN, and
    // that is what made the second tap ANONYMOUS: it arrived holding
    // nothing, could not be told from a stranger, and had to reconstruct
    // the answer from a book that was still empty. The identity survives
    // the issue now, and the operation handle lives on the LEASE, so
    // neither the answer nor the handle can go missing between taps.
    const first = arb.stop(a);
    expect(a.lease).toBe('proc-1/L1');
    expect(arb.phase()).toBe('debt'); // budget out: the debt was born
    // A second tap now: the lease is in `debt`, and the honest word is
    // `debt`, never `clear`.
    expect(arb.stop(a).word).toBe('debt');
    expect(arb.answers.get(first.req)).toBe('debt');
    expect(arb.crewRadiating()).toBe(false);
    expect(arb.overlapEver).toBe(false);

    // …and the same race with a stop still IN FLIGHT. The cured shape
    // coalesces onto one terminal; the loose one answers on its own.
    const loose = new Arbiter({ ...cured(), duplicateStop: 'answer-alone' });
    const la = new Client('A');
    loose.reserve(la);
    loose.suppressCrew(la);
    loose.arm(la, new Radiator('A-adv', null));
    loose.startEffect(la, true);
    // Freeze a stop mid-flight by entering `stopping` with no terminal.
    loose.stop(la);
    const second = loose.stop(la);
    expect(second.word).toBe('debt'); // the lease already moved to debt
    expect(loose.radiating('A-adv')).toBe(true);
  });

  test('START ACK — the state cannot say `advertising` before the effect', () => {
    // ARBITER ADDENDUM 3: "start returns structured outcome only after
    // chosen rung reaches terminal, and snapshot cannot call it
    // advertiserActive before effect."
    const arb = new Arbiter(cured());
    const c = new Client('A');
    arb.reserve(c);
    arb.suppressCrew(c);
    arb.arm(c, new Radiator('A-adv', 3));
    // ASKED, NOT EFFECTED. The phase says so and the rung says so.
    expect(arb.phase()).toBe('starting');
    expect(arb.current().rung).toBe('none');
    // …and the hold is real throughout, so nothing overlaps meanwhile.
    expect(arb.current().holdRequired).toBe(true);
    arb.startEffect(c, true);
    expect(arb.current().rung).toBe('advertising');

    // Mutation (plant arbiter-e): settle at the ISSUE, and a snapshot
    // calls the rung active on the turn it was asked.
    const issued = new Arbiter({ ...cured(), startAck: 'issue' });
    const ic = new Client('A');
    issued.reserve(ic);
    issued.suppressCrew(ic);
    issued.arm(ic, new Radiator('A-adv', 3));
    expect(issued.current().rung).toBe('advertising');
  });

  test('START ACK — didStartAdvertising(error) is a TERMINAL, not a silence', () => {
    // "…admission refusal only logs and no didStartAdvertising(error)
    // settlement exists." A lease that sits in `starting` because its
    // radio refused is a hold with no road out.
    const arb = new Arbiter(cured());
    const c = new Client('A');
    arb.reserve(c);
    arb.suppressCrew(c);
    arb.arm(c, new Radiator('A-adv', 3));
    arb.startEffect(c, false);
    expect(arb.phase()).toBe('active');
    expect(arb.current().rung).toBe('degraded');
    // Nothing came up, so nothing is on the air — and the hold still
    // stands, because a degraded rung is still a lease.
    expect(arb.radiating('A-adv')).toBe(false);
    expect(arb.current().holdRequired).toBe(true);
    // …and the close hands the slot straight back, once.
    arb.stop(c);
    expect(arb.phase()).toBe('idle');
    expect(arb.crewResumes).toBe(1);
    expect(arb.crewRadiating()).toBe(true);
    expect(arb.overlapEver).toBe(false);
  });

  test('THE BARRIER — clear only on exact proof, debt on transfer, and TWO debts wait for both', () => {
    // "resolves only after exact owner release or debt transfer."
    const arb = new Arbiter(cured());
    const a = new Client('A');
    arb.reserve(a);
    arb.suppressCrew(a);
    arb.arm(a, new Radiator('A-adv', 40));
    arb.startEffect(a, true);
    arb.stop(a); // debt A
    expect(arb.openDebts()).toBe(1);

    // A second session takes the slot once A settles, and ITS close
    // cannot prove either — two debts on one book.
    arb.slowTicks(40);
    expect(arb.phase()).toBe('idle');
    const b = new Client('B');
    arb.reserve(b);
    arb.suppressCrew(b);
    arb.arm(b, new Radiator('B-adv', 40));
    arb.startEffect(b, true);
    arb.stop(b);
    const c = new Client('C');
    arb.reserve(c); // refused: the lease is in debt
    expect(arb.phase()).toBe('debt');
    expect(arb.openDebts()).toBe(1);
    arb.slowTicks(40);
    expect(arb.phase()).toBe('idle');
    expect(arb.crewRadiating()).toBe(true);
    expect(arb.overlapEver).toBe(false);
  });

  test('THE SINKS — a bridge invalidate in EVERY phase removes one sink and no lease', () => {
    // S3: "bridge clients register/unregister exact event sinks; debt book
    // never weak-binds one module." A reload that handed the advertising
    // slot back by DISCONNECTING would be the strand and the overlap in
    // one gesture.
    const phases: string[] = [];
    const arb = new Arbiter(cured());
    const a = new Client('A');
    const watcher = new Client('W');
    arb.addSink(a);
    arb.addSink(watcher);
    expect(arb.sinkCount()).toBe(2);

    const check = (): void => {
      const before = arb.phase();
      const spare = new Client('spare');
      arb.addSink(spare);
      arb.invalidate(spare);
      phases.push(before);
      expect(arb.phase()).toBe(before);
      expect(arb.sinkCount()).toBe(2);
    };

    arb.reserve(a);
    check(); // reserving
    arb.suppressCrew(a);
    arb.arm(a, new Radiator('A-adv', 40));
    check(); // starting
    arb.startEffect(a, true);
    check(); // active
    arb.stop(a);
    check(); // debt
    arb.slowTicks(40);
    check(); // idle
    expect(phases).toEqual(['reserving', 'starting', 'active', 'debt', 'idle']);
    // …and the ONE client that stayed subscribed saw every revision,
    // replayed from its own registration forward.
    expect(arb.seen(watcher).length).toBeGreaterThan(5);
    expect(arb.overlapEver).toBe(false);
  });

  test('A MISSED EVENT IS SAFE — a sink that registers late is replayed the CURRENT state', () => {
    // S3: "Emit/replay full versioned state on EVERY revision […] query
    // same state; missed events safe." An edge has no replay; a level
    // does, and that is the entire difference.
    const arb = new Arbiter(cured());
    const a = new Client('A');
    arb.reserve(a);
    arb.suppressCrew(a);
    arb.arm(a, new Radiator('A-adv', 40));
    arb.startEffect(a, true);
    arb.stop(a); // the debt is born with NOBODY subscribed

    const late = new Client('late');
    arb.addSink(late);
    const first = arb.seen(late)[0];
    // It learns the truth from its first delivery, not from an edge it
    // was not there for.
    expect(first.phase).toBe('debt');
    expect(first.holdRequired).toBe(true);
    expect(first.debtCount).toBe(1);
    expect(first.v).toBe(2);
    expect(first.processIncarnation).toBe('proc-1');
  });

  test('THE REVISION — order survives above 2^53, where a JS Number does not', () => {
    // S5, and the reason the wire carries a PAIR: "decimal/hi-lo revision
    // (UInt64->JS Number loses order >2^53)".
    const base = 2 ** 53;
    const arb = new Arbiter(cured(), 'proc-1', base);
    const a = new Client('A');
    const older = arb.current();
    arb.reserve(a); // exactly ONE revision apart
    const newer = arb.current();

    // Two DIFFERENT revisions, one apart, above the boundary.
    expect(cmpRev(older, newer)).toBeLessThan(0);
    expect(cmpRev(newer, older)).toBeGreaterThan(0);
    // …and the mutation this dies on, spelled out: rebuild the number and
    // the two become EQUAL, so every "is this older?" fence waves the
    // stale one through.
    const asNumber = (s2: Snap | typeof older): number =>
      s2.revisionHi * 2 ** 32 + s2.revisionLo;
    expect(asNumber(older)).toBe(asNumber(newer));

    // And the real comparator is the one JS actually ships.
    expect(/export function compareWalkieRevision/.test(js)).toBe(true);
    expect(
      /a\.revisionHi !== b\.revisionHi/.test(
        codeOnly(
          bodyOf(
            js,
            'export function compareWalkieRevision(a: WalkieAirtime, b: WalkieAirtime): number {',
            '\n}\n',
          ),
        ),
      ),
    ).toBe(true);
  });

  test('S7 — the stop answers one of four words, and UNKNOWN is never CLEAR', () => {
    // "structured stop clear|debt|notOwner|unknown; generic bridge/version
    // errors unknown, never true."
    //
    // AND IT IS THE NEW BOUNDARY'S CONTRACT, not a claim about the old
    // path (correction, 2026-08-27): a24's native stop had only a proof
    // resolve or an explicit advertiser rejection, so there was no
    // reachable generic rejection to launder. This arm asserts what the
    // ARBITER'S boundary does, and nothing about what the previous one
    // did.
    expect(shape().adapter).toBe('reports-unproven');
    const decode = codeOnly(
      bodyOf(
        js,
        'export function decodeWalkieStop(e: unknown): WalkieStopOutcome {',
        '\n}\n',
      ),
    );
    // A wire version this decoder does not know is `unknown`…
    expect(decode).toContain("if (o?.v !== WALKIE_AIRTIME_WIRE) {");
    // …an outcome word it does not recognise is `unknown`…
    expect(decode).toContain("outcome: 'unknown', why: 'unrecognised-outcome'");
    // …a bridge that threw is `unknown`…
    expect(
      codeOnly(
        bodyOf(js, 'export async function stopWalkie(): Promise<WalkieStopOutcome> {', '\n}\n'),
      ),
    ).toContain("outcome: 'unknown', why: 'stop-threw'");
    // …and ONLY `clear` releases. Mutation: read `!== 'debt'` here and
    // every unknown becomes a close.
    expect(shape().gate).toBe('gated');
    expect(codeOnly(sessionCloseBody(sess))).toContain("if (stop?.outcome === 'clear') {");
  });

  test('S9 — an old native is INCOMPATIBLE, and that is a park with a reason', () => {
    // "explicit old-native capability policy; legacy {why}/
    // advertiserDebtCount is incompatible, not 'event fallback'."
    //
    // There is no fallback to fall back TO: the event carries the same
    // body the query does, so a native whose answer this JS cannot read
    // emits events it cannot read either. Leaving the watcher up would be
    // waiting forever on a shape that will never arrive.
    expect(shape().capability).toBe('explicit');
    expect(nullIsNotClear(js)).toBe(true);
    // The previous era's body, run through the REAL decoder.
    const decode = codeOnly(
      bodyOf(
        js,
        'export function decodeWalkieAirtime(e: unknown): WalkieAirtime | null {',
        '\n}\n',
      ),
    );
    // The wire version is asked FIRST, so a bare `{ why }` cannot be
    // half-read into a state with defaults.
    expect(decode.indexOf('o?.v !== WALKIE_AIRTIME_WIRE')).toBeLessThan(
      decode.indexOf('typeof o.holdRequired'),
    );
    // …and the park is terminal and says why.
    const park = codeOnly(bodyOf(sess, 'function parkAirtime(', '\n}\n'));
    expect(park).toContain('parkReason = reason;');
    expect(park).toContain('watchDone = true;');
    // NOT `deferredDebt`: a second tap would be a second native stop
    // answering the same unreadable answer.
    expect(park).not.toContain('deferredDebt = true;');
  });

  test('S8 — ONE teardown, run by ONE executor, and every later step still runs', () => {
    // The acceptance detail, verbatim: "replace abandonFailedStart's 5+
    // repeated fail-soft try/catches with a cleanup-step data
    // structure/shared teardown executor per repo law (3+ same-shaped ops
    // => data)".
    expect(shape().failedStart).toBe('owner');
    const exec = codeOnly(
      bodyOf(sess, 'async function runTeardown(steps: readonly TeardownStep[]): Promise<string[]> {', '\n}\n'),
    );
    // ONE loop, ONE guard, and the guard is INSIDE it — which is what
    // makes "add a step" incapable of adding an unguarded one.
    expect(exec).toContain('for (const step of steps) {');
    expect((exec.match(/try \{/g) ?? []).length).toBe(1);
    expect((exec.match(/\} catch \{/g) ?? []).length).toBe(1);
    // The steps are DATA.
    expect(sess).toContain('interface TeardownStep {');
    const steps = codeOnly(
      bodyOf(sess, 'function sessionTeardownSteps(): readonly TeardownStep[] {', '\n}\n'),
    );
    const labels = [...steps.matchAll(/label: '([a-z-]+)'/g)].map(m => m[1]);
    // DETACH FIRST, so nothing later can call back into a session that is
    // coming down; then destroy, then the mic. The socket is the caller's.
    expect(labels).toEqual([
      'detach-peers',
      'detach-call',
      'clear-claim',
      'destroy-runtime',
      'release-mic',
      'unmute',
    ]);
    // AND IT IS THE SAME LIST FOR BOTH ROADS (S8: "one shared idempotent
    // teardown for normal/failed start"). Two lists that must agree is
    // the defect class this round is about.
    expect(codeOnly(bodyOf(sess, 'export async function abandonFailedStart(original: unknown): Promise<never> {', '\n}\n')))
      .toContain('await endWalkieSession();');
    expect(codeOnly(sessionStopBody(sess))).toContain('await endWalkieSession();');
    // …and the camper's own error is what surfaces.
    expect(sess).toContain('throw original;');
  });

  test('S6 — a REFUSED clear does not finish the watch, and the pending start re-drives it', () => {
    // The test-vacuity addendum's exact seam, read out of the production
    // source rather than modelled: "clear snapshot arrives during
    // failed-start cleanup; watcher marks done/unsubscribes; release
    // rejects on pendingStarts; finally decrements with no redrive =>
    // stranded hold."
    const settle = codeOnly(bodyOf(sess, 'function settleAirtime(snap: WalkieAirtime | null): void {', '\n}\n'));
    // THE LATCH CLOSES ON A RELEASE THAT RAN, never on the STATE. A clear
    // state is not a completed job.
    expect(settle).toContain('if (!releaseDeferredHold(watchGen, snap)) {');
    expect(settle).toMatch(/if \(!releaseDeferredHold\(watchGen, snap\)\) \{\n\s*return;[\s\S]*\}\n\s*watchDone = true;/);
    // …and the fence's own wait ends with a re-drive.
    const verb = codeOnly(
      bodyOf(sess, 'export function startWalkieSession(id: WalkieSessionId): Promise<void> {', '\n}\n'),
    );
    expect(verb).toContain('pendingStarts -= 1;');
    expect(verb).toMatch(/if \(pendingStarts === 0\) \{\n\s*redriveAirtimeWatch\(\);/);
    // ADOPTION NEVER LOWERS: a later holdRequired refreshes the revision
    // and keeps everything else.
    const adopt = codeOnly(bodyOf(sess, 'function adoptAirtime(snap: WalkieAirtime): boolean {', '\n}\n'));
    expect(adopt).toMatch(/if \(adoptedAt === null \|\| compareWalkieRevision\(snap, adoptedAt\) > 0\) \{/);
    // …and the pending start is NATIVE-VISIBLE, as its own phase.
    expect(shape().airtime.phases).toContain('reserving');
  });

  test('POSITIVE CONTROL — an ordinary session costs one hold, one release, and no overlap', () => {
    // A cure that billed the healthy case would be the cure paying for
    // itself with the common path.
    const arb = new Arbiter(cured());
    const c = new Client('A');
    arb.addSink(c);
    expect(arb.crewRadiating()).toBe(true);
    expect(arb.reserve(c)).toBe(true);
    // THE GATE AND THE PROOF ARE DIFFERENT JOBS, and this line is the
    // difference. The reservation closes the door — `crewMayAdvertise` is
    // false from this instant, so nothing can put the beacon back up —
    // but a beacon ALREADY on the air is still on it. That is precisely
    // why the suppression must be PROVEN before the walkie's own
    // advertiser is minted (S2), and why the lease sits in
    // `suppressingCrew` in between rather than in `starting`.
    expect(arb.current().crewMayAdvertise).toBe(false);
    expect(arb.crewRadiating()).toBe(true);
    expect(arb.suppressCrew(c)).toBe(true);
    expect(arb.crewRadiating()).toBe(false);
    arb.arm(c, new Radiator('A-adv', 1));
    arb.startEffect(c, true);
    expect(arb.stop(c).word).toBe('pending');
    expect(arb.phase()).toBe('idle');
    expect(arb.crewResumes).toBe(1);
    expect(arb.crewRadiating()).toBe(true);
    expect(arb.openDebts()).toBe(0);
    expect(arb.overlapEver).toBe(false);
  });

  test('THE MAILBOX SHIP-GATE — stopping SHARING retires the services and the buffers', () => {
    // THE AUDIT'S MINIMUM, on iOS, and it rides the stop barrier:
    // "stop retires the GATT services, clears digest/payload buffers and
    // handlers so previously-known centrals lose access."
    //
    // THE DISTINCTION THAT MAKES IT A LEAK RATHER THAN A TRADE.
    // `stopAdvertising()` ends DISCOVERY and nothing else — the published
    // service survives it, and a central that already holds this phone's
    // address keeps its access. That asymmetry is deliberately CORRECT
    // while the walkie holds the airtime (the camper is still sharing;
    // share.ts argues the trade out loud). It is exactly wrong when
    // sharing itself ends.
    // THE LIST MOVED AND THE PROPERTY DID NOT (angel-081, 2026-08-27). This
    // arm used to read the retirement out of `stopAll`'s own body, where it
    // was spelled out inline — and the cross-family review found the cost of
    // spelling it out per road: `invalidate`, the road a PRODUCTION
    // appearance change takes (ThemeReload reloads the RN instance with no
    // JS stop at all), had its own much shorter copy that retired the sync
    // client and nothing else. One function now owns the list and every
    // death road calls it, so this reads the list where it lives and then
    // reads that stopAll is one of the roads.
    const stopAll = bracedBody(crew, '  func stopAll(');
    expect(stopAll).not.toBe('');
    expect(stopAll).toContain('retireBeforeReturning(reason: "radio stopped", scope: .everything)');
    const retire = bracedBody(crew, '  private func retireMeshScope(');
    expect(retire).not.toBe('');
    // The services themselves go…
    expect(retire).toContain('peripheralManager?.removeAllServices()');
    // …and `serviceAdded` with them, or the next poweredOn believes ours
    // is still published and never re-adds it.
    expect(retire).toContain('serviceAdded = false');
    // …and the bytes a known central could still have READ.
    expect(retire).toContain('payload = Data()');
    expect(retire).toContain('syncDigest = Data()');
    // …and every per-central cursor and part-assembled frame.
    expect(retire).toContain('dropAllCentralState()');
    // A digest served against a cursor from before the stop would be the
    // leak wearing a fresh advertisement's clothes.
    expect(retire).toContain('digestGeneration += 1');
    // ON THE CONFINEMENT QUEUE, because that is where the CoreBluetooth
    // handlers touch these dictionaries from. Mutation: clear them on the
    // RN method queue and it is undefined behaviour, not staleness.
    //
    // AND THE HOP IS A BARRIER NOW, not an enqueue. `onBle { [weak self] }`
    // — what this arm used to read — RETURNS with everything above still
    // live, which is precisely what let a read already queued on main serve
    // the dead session's mail after the stop had resolved. So the retirement
    // publishes its gate from the CALLING queue first (nothing serves from
    // that instant), then drives the confined cleanup and waits for it, and
    // it holds `self` STRONGLY because a weak cleanup queued during teardown
    // can simply disappear.
    const barrier = bracedBody(crew, '  private func retireBeforeReturning(');
    expect(barrier).not.toBe('');
    expect(barrier).toContain('publishRetired(');
    expect(barrier).toContain('Thread.isMainThread');
    expect(barrier).toContain('DispatchSemaphore(value: 0)');
    expect(barrier).not.toContain('[weak self]');
    // …and `onBle`/`bleQueue` are not free-floating names: the queue is
    // main, and onBle runs INLINE when the caller is already there so a
    // delegate callback keeps its present ordering. Mutation: point bleQueue
    // at a fresh serial queue and every Timer in this file is installed on a
    // queue with no run loop — the frugal rescan silently stops.
    expect(crew).toMatch(/private static let bleQueue = DispatchQueue\.main/);
    const onBle = bracedBody(crew, '  private func onBle(');
    expect(onBle).toContain('Thread.isMainThread');
    expect(onBle).toContain('Self.bleQueue.async(execute: work)');
    // …and the AIRTIME hold deliberately does NOT do this: it keeps the
    // service published so pod mail keeps flowing to peers that already
    // hold this address. Mutation: retire the services on a hold too and
    // every walkie session silently stops serving mail.
    // READ AT THE EFFECT SITE, which is now `driveAdvertise` rather than the
    // manager callback: the callbacks became triggers when one reconciler
    // took over both managers (a lagging `.poweredOff` from one manager was
    // retiring the other's healthy effect), and the gate moved with the line
    // that actually radiates. Same claim, same file, one hop down.
    const gate = bracedBody(crew, '  private func driveAdvertise(');
    expect(gate).not.toBe('');
    expect(gate).toContain('crewMayAdvertise == false || airtimeSuppressed');
    expect(
      gate.slice(gate.indexOf('crewMayAdvertise == false'), gate.indexOf('if !serviceAdded')),
    ).not.toContain('removeAllServices');
  });
});
