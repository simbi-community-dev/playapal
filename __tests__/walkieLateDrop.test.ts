/**
 * LIVE-NOT-LATE, pinned across both native halves.
 *
 * FIELD MEASUREMENT (2026-08-26, three phones, BLE lo-fi rung): P7 pressed
 * the button; an iPhone lit "someone is talking" immediately and then played
 * the AUDIO TEN SECONDS LATE. The transport was fine. The receiver was the
 * bug — when the pipe cannot hold real-time pace, a receiver that schedules
 * every frame it is handed walks its own playback monotonically into the
 * past. Nothing in a stream of 20 ms frames ever arrives early, so it never
 * catches up.
 *
 * The policy is one sentence on both platforms: a voice frame that would
 * land more than the bound ahead of what has actually PLAYED means the
 * queue is full, and a full queue is EMPTIED FROM THE FRONT so the newest
 * frame is what plays. A walkie ten seconds behind is worse than silence
 * on the playa.
 *
 * WHICH END GOES — the 2026-08-27 correction (codex cross-family read on
 * d61fecc), and the reason half this suite was rewritten. The first
 * version of the guard refused the frame it was HANDED and kept everything
 * already queued: it dropped the NEWEST audio and preserved the STALE
 * TAIL. Two consequences, both wrong in the same direction, and neither
 * visible to the guard's own counter:
 *
 *   - a new PTT burst arriving into a full queue loses its START, so the
 *     sentence a camper actually keyed reaches the speaker with its first
 *     words missing, behind audio nobody is waiting for;
 *   - under sustained overload the queue never drains below the bound, so
 *     the channel sits ~400 ms behind FOREVER. The bound stopped being a
 *     ceiling the channel touches and became a floor it rests on.
 *
 * A live channel has to sound like NOW, so the tail is what goes. Neither
 * player offers partial eviction — AudioTrack needs pause/flush/play and
 * AVAudioPlayerNode needs stop/play — so a flush costs up to one whole
 * bound of audio nobody could have answered anyway, and buys a lead of
 * zero. That is the sender's drop-on-busy trade, made at the other end of
 * the same pipe.
 *
 * This suite reads the real files, in the walkieCap.test.ts style, because
 * nothing type-checks a Kotlin constant against a Swift one and the failure
 * here is silent and asymmetric: the platform that lost its guard sounds
 * fine for the first sentence and then drifts, and only the dust would ever
 * find out. There is no third home in TypeScript on purpose — no JS code
 * schedules audio, so a TS constant would be decoration, not a seam.
 *
 * Each assertion is written to die on a specific mutation, named beside it.
 * Every one of them was PLANTED as a failing mutation before this file was
 * committed.
 */
export {}; // module scope: top-level consts must not collide with other suites

const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

/** The slice of a native source between two anchors — how these pins read
 * ONE routine of a file jest cannot compile. Both anchors must be found,
 * in order, or the pin fails loudly rather than passing over an empty
 * string (a renamed routine is a finding, not a green test). */
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

/** One Kotlin routine, from a signature that ENDS IN `{` to the closing
 * brace at member indent. Returns undefined when the signature is absent —
 * which is itself a finding, and every caller asserts on it. */
const ktBody = (src: string, sig: string): string | undefined => {
  const a = src.indexOf(sig);
  if (a < 0) {
    return undefined;
  }
  const b = src.indexOf('\n  }\n', a);
  return b > a ? src.slice(a, b) : undefined;
};

const KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const SWIFT = 'ios/PlayaPal/Walkie.swift';
const BLE_KT = 'android/app/src/main/java/com/playapal/WalkieBleLink.kt';
const BLE_SWIFT = 'ios/PlayaPal/WalkieBleVoice.swift';

/** The owner-facing number, written here once so a drift on either platform
 * has something outside both of them to disagree with. */
const MAX_LEAD_MS = 400;

describe('the lateness bound is one number in two languages', () => {
  test('Kotlin and Swift agree on how far behind live is still live', () => {
    // Mutation: change either one. The two phones then hold different
    // amounts of backlog, one of them drifts and the other does not, and
    // the pod concludes the SENDER is broken.
    const kt = /const val MAX_LEAD_MS = (\d+)/.exec(readSource(KT))?.[1];
    const swift = /private static let maxLeadMs = (\d+)/.exec(readSource(SWIFT))?.[1];
    expect(kt).toBeDefined();
    expect(swift).toBeDefined();
    expect(Number(kt)).toBe(MAX_LEAD_MS);
    expect(Number(swift)).toBe(MAX_LEAD_MS);
  });

  test('a beat behind, not a conversation behind', () => {
    // Mutation: raise it to a "generous" 2-3 s and the guard technically
    // exists while the walkie is still out of turn-taking — which is the
    // whole complaint. Below ~100 ms it would fight ordinary Wi-Fi jitter
    // and chew a healthy channel.
    expect(MAX_LEAD_MS).toBeLessThanOrEqual(500);
    expect(MAX_LEAD_MS).toBeGreaterThanOrEqual(100);
  });

  test('each platform DERIVES its frame bound from those milliseconds', () => {
    // Mutation: hardcode 6400 beside the 400 and the bound is two numbers
    // that can disagree — the next person to tune the milliseconds changes
    // nothing at all and believes they did.
    expect(readSource(KT)).toMatch(
      /const val MAX_LEAD_FRAMES = SAMPLE_RATE \* MAX_LEAD_MS \/ 1000/,
    );
    expect(readSource(SWIFT)).toMatch(
      /private static let maxLeadFrames = Int\(sampleRate\) \* maxLeadMs \/ 1000/,
    );
  });
});

describe('the guard happens on the playback path, not in a comment', () => {
  test('Android hands BOTH codec branches to the one write transaction', () => {
    // THE LOAD-BEARING ONE for this platform. Mutation: restore either
    // `ensureTrack().write(...)` and that codec keeps queueing without
    // bound — rung 3, the lo-fi lane where this was measured, is exactly
    // the branch a partial fix would leave behind.
    const kt = readSource(KT);
    expect(kt).not.toMatch(/ensureTrack\(\)\.write\(/);
    // Both branches hand the FRAME COUNT to writeTrack instead of spending
    // it on a decision of their own. Mutation: put `if (makeRoom(t,
    // frames))` back around either call and defect A's second face
    // returns — two receive threads read one lead through an open monitor
    // and are BOTH admitted, which ARM A below drives.
    expect(
      (kt.match(/writeTrack\(t, out, 0, out\.size, frames\)/g) ?? []).length,
    ).toBe(1);
    expect(
      (kt.match(/writeTrack\(t, buf, HEADER, n - HEADER, frames\)/g) ?? []).length,
    ).toBe(1);
    const rx = between(kt, 'val t = ensureTrack()', 'The speaking chip fires either way');
    expect(rx).not.toMatch(/makeRoom/);
    expect(kt).toMatch(/private fun makeRoom\(t: AudioTrack, frames: Int\): Boolean/);
    // Mutation: keep the old refuse-the-newest gate under any name. The
    // negation is the tell — `if (!x)` around the guard means the frame in
    // hand is what the branch skips.
    expect(kt).not.toMatch(/tooLate/);
  });

  test('Android empties the track from the FRONT when it is full', () => {
    // THE SEAM ITSELF. Mutation: `return false` from makeRoom's full
    // branch and the pre-2026-08-27 behaviour is back verbatim — the stale
    // tail survives, the newest frame dies, and the counter still ticks so
    // the log looks exactly the same while the walkie sounds 400 ms old.
    const kt = readSource(KT);
    expect(kt).toMatch(/return flushStale\(t\)/);
    const flush = / {2}private fun flushStale\(t: AudioTrack\): Boolean \{[\s\S]*?\n {2}\}\n/.exec(kt)?.[0];
    expect(flush).toBeDefined();
    // pause -> flush -> play, in that order: AudioTrack.flush() is a NO-OP
    // on a playing track, so a "fix" that just calls flush() evicts
    // nothing at all and is invisible except in the dust.
    const order = ['t.pause()', 't.flush()', 't.play()'].map(v => flush!.indexOf(v));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
    // flush() resets the playback head to zero, so the written count must
    // follow it. Mutation: drop this and the very next measurement reads a
    // vast phantom backlog and flushes on every frame forever.
    expect(flush).toMatch(/framesWritten\.set\(0\)/);
  });

  test('the Android flush takes the same monitor as the write and the release', () => {
    // Mutation: drop @Synchronized (or the `track !== t` re-check) and the
    // flush can run against a track stopInternal already released — a
    // SIGSEGV in native memory with no exception to catch, the exact 13:20
    // P7 crash writeTrack was hardened against.
    const kt = readSource(KT);
    expect(kt).toMatch(/@Synchronized\n {2}private fun flushStale\(t: AudioTrack\)/);
    expect(kt).toMatch(/if \(track !== t\) \{\n\s*return false/);
  });

  test('Android measures the backlog against what has actually PLAYED', () => {
    // Mutation: measure against frames written alone, or against wall
    // clock, and the guard is measuring the network instead of the
    // speaker — which never drifts and so never fires.
    const kt = readSource(KT);
    expect(kt).toMatch(/framesWritten\.get\(\) - t\.playbackHeadPosition/);
    expect(kt).toMatch(/lead \+ frames <= MAX_LEAD_FRAMES/);
    // and every written frame must be counted, or the subtraction lies.
    // What the TRACK TOOK, never what we offered: a refused write counted
    // anyway is phantom depth that never drains, and phantom depth silences
    // a walkie that is perfectly on time — the same bug, opposite face.
    expect((kt.match(/framesWritten\.addAndGet\(wrote \/ 2\)/g) ?? []).length).toBe(1);
    expect(kt).not.toMatch(/framesWritten\.addAndGet\(frames\)/);
  });

  test('the Android admission is decided INSIDE the write transaction', () => {
    // DEFECT A, TWICE.
    //
    // First face (codex cross-family read on 0ad0149): makeRoom decided
    // with `lead + frames` and flushStale re-measured with the lead alone,
    // so a queue at exactly the bound admitted every arriving packet
    // through the back door and cycled 400 -> 460 -> 400 ms behind forever
    // without one eviction. 09ab350 gave the re-measurement the frame
    // count and the single-threaded face closed.
    //
    // Second face (codex→opus re-read of 09ab350, and the reason a
    // re-measurement was never the cure): the FIRST measurement was still
    // taken at the call site, with the monitor open between it and the
    // write. Three threads reach handleFrame — "walkie-rx", one
    // "walkie-rx-aware" per datapath, and the BLE GATT callback thread —
    // so two of them read the same lead of 5440, both cleared 5440 + 960,
    // and both wrote: 7360 frames, 460 ms, no eviction. The locked
    // re-check could not see them, because it only ever ran for the
    // callers the stale outer check REJECTED.
    //
    // So there is one measurement and it lives where the write lives.
    // Mutation: move the admission back out to the call sites, or drop
    // either @Synchronized, and ARM A's adversarial scheduler admits twice
    // on one lead.
    const kt = readSource(KT);
    const write = ktBody(kt, '  private fun writeTrack(');
    expect(write).toBeDefined();
    expect(kt).toMatch(/@Synchronized\n {2}private fun writeTrack\(/);
    expect(write).toMatch(/if \(!makeRoom\(t, frames\)\) \{\n\s*return -1/);
    // The measurement, the eviction and the write must be ONE critical
    // section, so makeRoom and flushStale take the same monitor too — and
    // the write comes after the admission, never beside it.
    expect(kt).toMatch(/@Synchronized\n {2}private fun makeRoom\(/);
    expect(kt).toMatch(/@Synchronized\n {2}private fun flushStale\(/);
    expect((write as string).indexOf('makeRoom(')).toBeLessThan(
      (write as string).indexOf('t.write('),
    );
  });

  test('the Android write and its accounting share one monitor', () => {
    // DEFECT E (same read). The write succeeded under the monitor and the
    // depth was added AFTER it was released — one instruction of open
    // window in which a sibling thread's flushStale (or stopInternal) can
    // empty the track and zero the count, only for the late increment to
    // RESURRECT depth the track no longer holds. Phantom depth never
    // drains: the head is at zero, the lead reads permanent, and the guard
    // flushes every frame from then on — silent rather than late.
    //
    // Mutation: move the increment back to either call site and ARM E
    // below finds the interleaving that resurrects it.
    const kt = readSource(KT);
    expect(kt).toMatch(/@Synchronized\n {2}private fun writeTrack\(/);
    const write = ktBody(kt, '  private fun writeTrack(');
    expect(write).toBeDefined();
    expect(write).toMatch(/framesWritten\.addAndGet\(wrote \/ 2\)/);
    // …and the callers must not double-count it back.
    const rx = between(kt, 'val t = ensureTrack()', 'The speaking chip fires either way');
    expect(rx).not.toMatch(/framesWritten\./);
    // The other reset of the count is under that same monitor too: a
    // teardown that zeroes outside it can be overtaken by exactly the same
    // late increment.
    expect(kt).toMatch(/track = null\n\s*\/\/[\s\S]*?framesWritten\.set\(0\)\n {4}\}/);
  });

  test('Android zeroes the written count with the track', () => {
    // Mutation: drop either reset. The next session's playback head starts
    // at zero while the count remembers the last one, so the guard reads a
    // vast backlog and drops EVERY frame — a walkie that is silent rather
    // than late, which is the same bug wearing the opposite face.
    const kt = readSource(KT);
    // Three now: the fresh track, the session reset, and the flush — each
    // one a place the playback head goes back to zero underneath us.
    expect((kt.match(/framesWritten\.set\(0\)/g) ?? []).length).toBe(3);
  });

  test('iOS admits a frame before scheduling it, and only then', () => {
    // THE LOAD-BEARING ONE for this platform. Mutation: restore the bare
    // `scheduleBuffer(buf, completionHandler: nil)` and the iPhone — the
    // phone that was actually ten seconds late in the field — queues
    // without bound again.
    const swift = readSource(SWIFT);
    expect(swift).not.toMatch(/scheduleBuffer\(buf, completionHandler: nil\)/);
    expect(swift).toMatch(/private func admitFrames\(_ n: Int\) -> Int\?/);
    expect(swift).toMatch(/if pendingFrames \+ n > Self\.maxLeadFrames/);
    // …and the claim is asked for TWICE on the full path: once to learn
    // the queue is full, once after the eviction. Mutation: schedule
    // straight after flushStaleTail() without re-admitting, and the depth
    // is a count of buffers nobody claimed — it drifts down, the guard
    // stops firing, and the drift this whole file exists to stop returns.
    expect(swift).toMatch(
      /var admitted = admitFrames\(claimed\)\n\s*if admitted == nil \{\n\s*flushStaleTail\(\)\n\s*admitted = admitFrames\(claimed\)\n\s*\}/,
    );
    expect(swift).toMatch(/guard let gen = admitted else \{ return \}/);
  });

  test('iOS empties the player from the FRONT when it is full', () => {
    // THE SEAM ITSELF, iPhone half. Mutation: make flushStaleTail() a
    // no-op (or delete the call) and the phone that was ten seconds late
    // in the field is back to preserving the stale tail and refusing the
    // newest frame — a PTT burst whose first words never play.
    const swift = readSource(SWIFT);
    const flush = / {2}private func flushStaleTail\(\) \{[\s\S]*?\n {2}\}\n/.exec(swift)?.[0];
    expect(flush).toBeDefined();
    // stop() then play(): stop() is what discards the scheduled buffers,
    // play() is what re-arms the node for the frame about to be scheduled.
    // Mutation: drop the play() and the walkie goes permanently silent the
    // first time it congests — the worst possible face of this bug.
    const stop = flush!.indexOf('p.stop()');
    const play = flush!.indexOf('p.play()');
    expect(stop).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(stop);
    // Reachable from NETWORK INPUT, so it rides ObjCTry (CLAUDE.md's iOS
    // native-exception law) — a detached node RAISES and a raise aborts
    // the app. Mutation: call stop()/play() bare.
    expect(flush).toMatch(/ObjCTry\.run \{\n\s*p\.stop\(\)\n\s*p\.play\(\)/);
    // The depth is zeroed either way — the queue is empty on the happy
    // path, and on a raise the node we were counting is not a node.
    expect(flush).toMatch(/resetPending\(\)/);
  });

  test('iOS counts its queue down as well as up', () => {
    // AVAudioPlayerNode has no queue-depth getter, so the depth is only as
    // honest as its two ends. Mutation: schedule with a nil completion
    // handler again and pendingFrames only ever RISES — the guard drops
    // everything after the first 400 ms and the walkie goes deaf.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/completionHandler: \{ \[weak self\] in\s*\n\s*self\?\.releaseFrames\(claimed, gen: gen\)/);
    expect(swift).toMatch(/pendingFrames = max\(0, pendingFrames - n\)/);
  });

  test('iOS hands the claim back when the framework raises', () => {
    // Mutation: keep `_ = ObjCTry.run { ... }`. A raise means the buffer
    // was never scheduled, so its completion handler never fires and the
    // depth ratchets up one frame per caught raise until a perfectly
    // on-time channel is dropped wholesale. The raise path is reachable
    // from NETWORK INPUT, so it is not hypothetical.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/let exc = ObjCTry\.run \{/);
    expect(swift).toMatch(/if exc != nil \{\s*\n\s*releaseFrames\(claimed, gen: gen\)/);
  });

  test('iOS zeroes the depth wherever the player node is dropped', () => {
    // Mutation: drop either resetPending() — discardEngine or the
    // corpse-rebuild inside ensureEngine — and the dead player's backlog
    // is charged to the fresh one.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/private func resetPending\(\)/);
    // Four call sites now: discardEngine, the corpse-rebuild inside
    // ensureEngine, and both exits of flushStaleTail.
    expect((swift.match(/\n\s*resetPending\(\)\n/g) ?? []).length).toBe(4);
  });

  test('iOS pays a completion only against the queue it was admitted to', () => {
    // DEFECT C (same read). flushStaleTail stops the node, resetPending()s
    // the depth and re-admits the newest frame in the same breath — but
    // stop() FIRES the completion handlers of every buffer it discarded,
    // on whatever thread the render path gets to them, and those handlers
    // carried no generation. Each one landed as a subtraction against the
    // NEW queue's claims. The depth drifts DOWNWARD, reads as room the
    // channel does not have, and the 400 ms guard quietly stops firing —
    // the unbounded drift this whole file exists to stop, arriving through
    // the seam's own cleanup.
    //
    // Mutation: drop the generation from any one of the four places and
    // ARM C below watches an old completion pay off a new claim.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/private var pendingGen = 0/);
    expect(swift).toMatch(/private func releaseFrames\(_ n: Int, gen: Int\) \{/);
    expect(swift).toMatch(
      /if gen == pendingGen \{\n\s*pendingFrames = max\(0, pendingFrames - n\)/,
    );
    // The reset is what RETIRES a generation — without the bump the tag is
    // decoration and every stale completion still matches.
    expect(swift).toMatch(
      /private func resetPending\(\) \{\n\s*pendingLock\.lock\(\)\n\s*pendingFrames = 0\n\s*pendingGen &\+= 1/,
    );
  });

  test('the eviction is bounded by depth, and the counter is separate from it', () => {
    // Mutation: reuse pendingFrames as the counter (or reset the counter
    // with the engine) and the bench loses the one number it came for —
    // how often this rung is at its ceiling.
    expect(readSource(SWIFT)).toMatch(/private var staleFlushes = 0/);
    expect(readSource(KT)).toMatch(/private val staleFlushes = java\.util\.concurrent\.atomic\.AtomicInteger\(0\)/);
  });
});

describe('an eviction says so, at a rate a human can read', () => {
  test('both platforms log the counter under one name', () => {
    // Mutation: rename either line and the next bench cannot grep one
    // string across two phones — which is the entire point of naming it
    // the same thing on both. The name changed with the behaviour: this
    // counts flushes of a stale tail, not frames refused at the door, and
    // a log line that still said late-drop would be describing the bug
    // rather than the fix.
    expect(readSource(KT)).toMatch(/"walkie\/\/stale-flush count="/);
    expect(readSource(SWIFT)).toMatch(/"walkie\/\/stale-flush count=%d/);
    expect(readSource(KT)).not.toMatch(/late-drop/);
    expect(readSource(SWIFT)).not.toMatch(/late-drop/);
  });

  test('the log is rate-limited, not per frame', () => {
    // Mutation: log unconditionally. At 50 frames a second a congested
    // rung floods its own diagnostic buffer and evicts the lines that
    // would explain WHY it is congested.
    const kt = readSource(KT);
    expect(kt).toMatch(/const val LATE_LOG_MS = 3_000L/);
    expect(kt).toMatch(/now - lastLateLog > LATE_LOG_MS/);
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/private static let lateLogSeconds: TimeInterval = 3/);
    expect(swift).toMatch(/Date\(\)\.timeIntervalSince\(lastLateLog\) > Self\.lateLogSeconds/);
  });

  test('an evicting receiver still lights the speaking chip', () => {
    // Someone IS talking. Mutation: return early on the drop and a
    // congested rung reads as an EMPTY channel — the phone hides the one
    // fact it still knows for certain, and the person keying gets no
    // answer and no explanation.
    const kt = readSource(KT);
    expect(kt).toMatch(/The speaking chip fires either way/);
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/The speaking chip fires either way/);
  });
});

/**
 * THE THREE ARMS, EXECUTED — the 2026-08-27 cross-family NO-GO on 0ad0149.
 *
 * Everything above this line is a SHAPE pin: it reads the native sources as
 * text, because jest cannot compile Kotlin and this repo has no Swift
 * compiler outside EAS. Shape is enough for "the seam exists", and it was
 * not enough for these three. All three were shaped correctly and behaved
 * wrongly — a recheck that asks a different question than the one that got
 * it called, an increment one instruction outside its monitor, a completion
 * handler that pays off the wrong queue. A pin asserting `flushStale` is
 * CALLED cannot notice that nothing is ever flushed.
 *
 * So each arm runs. The models below are DERIVED FROM THE SOURCE rather
 * than written beside it, which is the whole trick: it is what makes them
 * fail on the pre-fix files instead of agreeing with whatever is there.
 *
 *   - ARM A lifts the Kotlin predicates out of the file as TEXT,
 *     translates their four identifiers, and EVALUATES them — and reads
 *     out of the same text WHERE the admission is decided relative to the
 *     synchronized write, so it can run three receive threads against an
 *     adversary that interleaves their guards and their writes. The
 *     arithmetic under test is the arithmetic in the file, and so is the
 *     transaction boundary.
 *   - ARM E reads out of the file WHERE the accounting sits — fused with
 *     the write inside the monitor, or a step after it with the monitor
 *     open in between — and enumerates every interleaving that structure
 *     permits.
 *   - ARM C reads out of the file WHETHER a claim carries a generation,
 *     and replays the completion that arrives after the flush.
 *
 * These are models of a few dozen lines, not of a module. They cannot tell
 * anyone the walkie works. They can tell anyone these three defects are
 * gone, and they die the moment one is put back.
 */
describe('the three defects, executed rather than described', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  /** Every number here comes from the sources, so a retune moves the arms
   * with the code instead of leaving them testing last week's bound. */
  const RATE = Number(
    (/const val SAMPLE_RATE = ([\d_]+)/.exec(kt)?.[1] ?? '').replace(/_/g, ''),
  );
  const BOUND = (RATE * MAX_LEAD_MS) / 1000;
  /** One 60 ms packet — the GATT lane's cadence (docs/WALKIE-LADDER.md §3),
   * and the packet size the defect report names. */
  const PACKET = (RATE * 60) / 1000;

  test('the arms are measured in the frames the sources actually use', () => {
    expect(RATE).toBe(16000);
    expect(BOUND).toBe(6400);
    expect(PACKET).toBe(960);
  });

  // ---------------------------------------------------------- ARM A

  /** A Kotlin boolean expression, translated to a callable over the four
   * names it is allowed to mention. Anything else in it is a finding, not
   * a translation — the whitelist is what stops this from quietly
   * evaluating a predicate it did not understand. */
  const asPredicate = (
    expr: string,
  ): ((w: number, h: number, i: number, b: number) => boolean) => {
    const js = expr
      .replace(/framesWritten\.get\(\)/g, 'w')
      .replace(/t\.playbackHeadPosition/g, 'h')
      .replace(/MAX_LEAD_FRAMES/g, 'b')
      .replace(/\bframes\b/g, 'i');
    const names = js.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    expect(names.filter(n => !['w', 'h', 'i', 'b'].includes(n))).toEqual([]);
    expect(js).toMatch(/^[whib\d\s+\-*/()<>=]+$/);
    // eslint-disable-next-line no-new-func
    return new Function('w', 'h', 'i', 'b', `return (${js});`) as unknown as (
      w: number,
      h: number,
      i: number,
      b: number,
    ) => boolean;
  };

  type Track = {written: number; head: number};
  type RxStep = (tr: Track) => void;

  /** makeRoom, flushStale and writeTrack as the source has them: both
   * predicates lifted verbatim, AND the transaction boundary READ OUT OF
   * THE SAME TEXT rather than assumed. The track is (written, head); a
   * flush zeroes both, which is what `t.pause(); t.flush(); t.play();
   * framesWritten.set(0)` does.
   *
   * A receive thread is a list of ATOMIC steps, and a monitor is expressed
   * by fusing the steps it holds across into one — the same convention ARM
   * E uses for the accounting. Where the admission is decided is therefore
   * not a choice this model makes; it is a fact it reads:
   *
   *   - the synchronized writeTrack asks for the admission itself → ONE
   *     step. Measure, evict, write and account, with no instant in which
   *     a lead has been measured and the write it admitted has not landed.
   *   - the call site asks first and then calls writeTrack → TWO steps,
   *     with the monitor open in between, which is the window that let two
   *     receive threads be admitted on one measurement.
   *
   * Both the one-argument and two-argument flushStale are accepted, and a
   * flushStale with no re-measurement at all is accepted too: the arm has
   * to be able to RUN every shape this seam has had, or it proves nothing
   * by passing. */
  const androidGuard = () => {
    const makeRoomBody = ktBody(
      kt,
      '  private fun makeRoom(t: AudioTrack, frames: Int): Boolean {',
    );
    const flushBody =
      ktBody(kt, '  private fun flushStale(t: AudioTrack, frames: Int): Boolean {') ??
      ktBody(kt, '  private fun flushStale(t: AudioTrack): Boolean {');
    const writeBody = ktBody(kt, '  private fun writeTrack(');
    expect(makeRoomBody).toBeDefined();
    expect(flushBody).toBeDefined();
    expect(writeBody).toBeDefined();
    const leadExpr = /val lead = (.+)/.exec(makeRoomBody as string)?.[1];
    const gateExpr = /\n {4}if \((.+)\) \{\n/.exec(makeRoomBody as string)?.[1];
    expect(leadExpr).toBeDefined();
    expect(gateExpr).toBeDefined();
    const gate = asPredicate(
      (gateExpr as string).replace(/\blead\b/g, `(${leadExpr as string})`),
    );
    // The locked re-measurement, IF the file still carries one. It was
    // never the cure and this arm is what shows why: a second look is only
    // ever reached by the callers the first look rejected.
    const recheckExpr = /\n {6}if \((.+)\) \{\n/.exec(flushBody as string)?.[1];
    const recheck = recheckExpr === undefined ? null : asPredicate(recheckExpr);

    // THE TRANSACTION BOUNDARY, DERIVED. The admission belongs to the
    // write's critical section only when the synchronized writeTrack is
    // the thing that asks for it; a `makeRoom` on the receive path is a
    // decision taken with the monitor open until the write.
    const fused =
      /@Synchronized\n {2}private fun writeTrack\(/.test(kt) &&
      /makeRoom\(/.test(writeBody as string);
    const atCallSite = /makeRoom\(/.test(
      between(kt, 'val t = ensureTrack()', 'The speaking chip fires either way'),
    );
    // Somewhere, or nothing is ever admitted and the shape pins above are
    // already red.
    expect(fused || atCallSite).toBe(true);

    const decide = (tr: Track, frames: number, log: string[]): boolean => {
      if (gate(tr.written, tr.head, frames, BOUND)) {
        return true;
      }
      // Full. makeRoom counts the eviction, rate-limits its log line, and
      // hands off to flushStale.
      if (recheck !== null && recheck(tr.written, tr.head, frames, BOUND)) {
        log.push('no-flush');
        return true;
      }
      log.push('flush');
      tr.written = 0;
      tr.head = 0;
      return true;
    };
    const commit = (tr: Track, frames: number, admitted: boolean): void => {
      if (admitted) {
        tr.written += frames;
      }
    };
    const receiver = (frames: number, log: string[]): RxStep[] => {
      if (fused) {
        return [tr => commit(tr, frames, decide(tr, frames, log))];
      }
      let admitted = false;
      return [
        tr => {
          admitted = decide(tr, frames, log);
        },
        tr => commit(tr, frames, admitted),
      ];
    };
    return {fused, receiver};
  };

  /** The adversary: every thread takes its first step, then every thread
   * takes its second, and so on — RX1 guard, RX2 guard, RX1 write, RX2
   * write. Under a fused shape each thread is a single step and this is
   * simply RX1 then RX2, which is the point: the schedule is legal either
   * way and only one of the two shapes survives it. Returns the WORST lead
   * any instant of the schedule left behind. */
  const runInterleaved = (threads: RxStep[][], tr: Track): number => {
    let peak = tr.written - tr.head;
    const deepest = Math.max(...threads.map(t => t.length));
    for (let s = 0; s < deepest; s++) {
      threads.forEach(thread => {
        if (s < thread.length) {
          thread[s](tr);
          peak = Math.max(peak, tr.written - tr.head);
        }
      });
    }
    return peak;
  };

  test('ARM A — a queue at exactly the bound, plus a 60 ms packet, FLUSHES', () => {
    const {receiver} = androidGuard();
    const track: Track = {written: BOUND, head: 0}; // exactly 400 ms unplayed
    const log: string[] = [];
    receiver(PACKET, log).forEach(step => step(track));
    // On 0ad0149 this read ['no-flush']. makeRoom saw 6400 + 960 > 6400
    // and sent the frame to flushStale, which asked only whether 6400
    // itself was over the bound — it is not — and answered "room enough"
    // without touching the track. Same counter, same log line, no
    // eviction. The tail goes, and the newest frame is all that is left.
    expect(log).toEqual(['flush']);
    expect(track.written).toBe(PACKET);
  });

  test('ARM A — …so the channel cannot come to rest on its own ceiling', () => {
    const {receiver} = androidGuard();
    const track: Track = {written: BOUND, head: 0};
    const log: string[] = [];
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      receiver(PACKET, log).forEach(step => step(track));
      worst = Math.max(worst, track.written - track.head);
      // The speaker keeps pace, one packet per packet: what is overloaded
      // is the BACKLOG, not the rate — which is the field measurement
      // this whole file was opened by.
      track.head = Math.min(track.written, track.head + PACKET);
    }
    expect(log).toContain('flush');
    // On 0ad0149 the lead cycled 6400 -> 7360 -> 6400 for all fifty
    // packets: a channel permanently 400-460 ms behind, counting an
    // eviction every single time and performing none.
    expect(worst).toBeLessThanOrEqual(BOUND);
  });

  test('ARM A — two receivers cannot both be admitted on one measurement', () => {
    // THE PRODUCTION CONCURRENCY, verbatim from the codex→opus re-read of
    // 09ab350: an existing lead of 5440, RX1 admits 960 and pauses before
    // its write, RX2 reads the SAME 5440 and is admitted too. RX1's write
    // makes 6400 and RX2's makes 7360 — 460 ms behind, with the guard
    // having found nothing over the bound at either instant it looked.
    const {receiver} = androidGuard();
    const track: Track = {written: BOUND - PACKET, head: 0};
    expect(track.written).toBe(5440);
    const log: string[] = [];
    const peak = runInterleaved(
      [receiver(PACKET, log), receiver(PACKET, log)],
      track,
    );
    // On 09ab350 this reads 7360 and the log is EMPTY: the locked re-check
    // never ran, because it is only reached by callers the outer check
    // rejected and the outer check admitted them both.
    expect(peak).toBeLessThanOrEqual(BOUND);
    expect(log).toEqual(['flush']);
  });

  test('ARM A — three receive threads sustained cannot lift the ceiling', () => {
    // "walkie-rx", one "walkie-rx-aware" per datapath, and the BLE GATT
    // callback thread all call handleFrame (see ensureTrack's note) — so
    // three is the real number, not two, and the channel is 3:1
    // oversubscribed against a speaker draining one packet per round.
    const {receiver} = androidGuard();
    const track: Track = {written: BOUND - PACKET, head: 0};
    const log: string[] = [];
    let peak = track.written - track.head;
    for (let round = 0; round < 20; round++) {
      peak = Math.max(
        peak,
        runInterleaved(
          [receiver(PACKET, log), receiver(PACKET, log), receiver(PACKET, log)],
          track,
        ),
      );
      track.head = Math.min(track.written, track.head + PACKET);
    }
    // On 09ab350 all three guards read one lead and all three writes land
    // on top of it — 8320 frames, 520 ms, on the very first round.
    expect(peak).toBeLessThanOrEqual(BOUND);
    expect(log).toContain('flush');
  });

  // ---------------------------------------------------------- ARM E

  type Deck = {written: number; inTrack: number};
  type Step = (d: Deck) => void;

  /** Every interleaving of two threads' steps, each thread's own order
   * preserved. A step is atomic; a monitor is expressed by FUSING the
   * steps it holds across into one. */
  const interleave = (a: Step[], b: Step[]): Step[][] => {
    if (a.length === 0) {
      return [b];
    }
    if (b.length === 0) {
      return [a];
    }
    return [
      ...interleave(a.slice(1), b).map(rest => [a[0], ...rest]),
      ...interleave(a, b.slice(1)).map(rest => [b[0], ...rest]),
    ];
  };

  /** The receive thread's steps, with the STRUCTURE read out of the file:
   * one fused critical section if the accounting rides writeTrack's own
   * monitor, two steps with the monitor open between them if the callers
   * add the frames after writeTrack returns. */
  const rxSteps = (wrote: number): Step[] => {
    const write = /@Synchronized\n {2}private fun writeTrack\(/.test(kt)
      ? ktBody(kt, '  private fun writeTrack(')
      : undefined;
    const rx = between(
      kt,
      'val t = ensureTrack()',
      'The speaking chip fires either way',
    );
    const underMonitor =
      write !== undefined && /framesWritten\.addAndGet\(wrote \/ 2\)/.test(write);
    const atCallSite = /framesWritten\.addAndGet/.test(rx);
    // Somewhere, or the depth is never counted at all and a different
    // suite above is already red.
    expect(underMonitor || atCallSite).toBe(true);
    if (underMonitor && !atCallSite) {
      return [
        d => {
          d.inTrack += wrote;
          d.written += wrote;
        },
      ];
    }
    return [
      d => {
        d.inTrack += wrote;
      },
      d => {
        d.written += wrote;
      },
    ];
  };

  /** flushStale, or stopInternal: the track is emptied and the count that
   * describes it is zeroed, both under the monitor. */
  const flushStep: Step = d => {
    d.inTrack = 0;
    d.written = 0;
  };

  test('ARM E — no interleaving of a write and a flush can resurrect depth', () => {
    const orders = interleave(rxSteps(PACKET), [flushStep]);
    expect(orders.length).toBeGreaterThan(1);
    const broken: number[] = [];
    orders.forEach((order, n) => {
      const d: Deck = {written: 0, inTrack: 0};
      order.forEach(step => step(d));
      // THE INVARIANT. framesWritten is a claim about the track; the lead
      // is measured by subtracting the playback head from it. Any schedule
      // that leaves the two disagreeing has invented backlog that will
      // never drain — the head is at zero and the guard flushes every
      // frame from then on, a walkie silent rather than late.
      if (d.written !== d.inTrack) {
        broken.push(n);
      }
    });
    // Pre-fix, order 1 is write -> flush -> the late increment: the track
    // holds nothing and the count says 960.
    expect(broken).toEqual([]);
  });

  // ---------------------------------------------------------- ARM C

  /** The iOS depth, with the generation tagging read out of the Swift. All
   * five parts or none: a tag that is minted but never checked, or checked
   * but never retired, is the untagged behaviour with extra words. */
  const iosPlayer = () => {
    const tagged =
      /private func admitFrames\(_ n: Int\) -> Int\?/.test(swift) &&
      /private func releaseFrames\(_ n: Int, gen: Int\) \{/.test(swift) &&
      /if gen == pendingGen \{/.test(swift) &&
      /pendingGen &\+= 1/.test(swift) &&
      /self\?\.releaseFrames\(claimed, gen: gen\)/.test(swift);
    const s = {pending: 0, gen: 0};
    return {
      tagged,
      depth: () => s.pending,
      admit: (n: number): number | null => {
        if (s.pending + n > BOUND) {
          return null;
        }
        s.pending += n;
        return s.gen;
      },
      release: (n: number, gen: number) => {
        if (tagged && gen !== s.gen) {
          return;
        }
        s.pending = Math.max(0, s.pending - n);
      },
      // stop() discards the scheduled buffers and FIRES their completion
      // handlers; resetPending() zeroes the depth behind them.
      flush: () => {
        s.pending = 0;
        if (tagged) {
          s.gen += 1;
        }
      },
    };
  };

  test('ARM C — a completion from the flushed queue cannot pay a new claim', () => {
    const p = iosPlayer();
    const stale = p.admit(PACKET); // scheduled under the queue about to go
    expect(stale).not.toBeNull();
    p.flush(); // flushStaleTail: stop() -> resetPending()
    const fresh = p.admit(PACKET); // the newest frame, re-admitted
    expect(fresh).not.toBeNull();
    p.release(PACKET, stale as number); // …and NOW the old handler fires
    // Pre-fix this reads 0: the discarded buffer's completion paid off the
    // claim of the frame that replaced it, and the depth stopped
    // describing the queue.
    expect(p.depth()).toBe(PACKET);
  });

  test('ARM C — stale completions cannot talk the 400 ms guard out of firing', () => {
    const p = iosPlayer();
    const stale: number[] = [];
    for (;;) {
      const g = p.admit(PACKET);
      if (g === null) {
        break;
      }
      stale.push(g);
    }
    expect(stale.length).toBeGreaterThan(0);
    p.flush();
    // The new queue fills while the retired queue's handlers trickle in.
    let refused = false;
    for (let i = 0; i < 50; i++) {
      if (p.admit(PACKET) === null) {
        refused = true;
        break;
      }
      p.release(PACKET, stale[i % stale.length]);
    }
    // Pre-fix the guard NEVER refuses: every stale completion hands back a
    // packet's worth of room the player does not have, so the depth
    // oscillates around zero and the receiver queues without bound again —
    // the ten-seconds-late field measurement, restored by the fix for it.
    expect(refused).toBe(true);
  });
});

/**
 * THE TX HALF (docs/WALKIE-LADDER.md: the BLE 60 ms lane was designed
 * drop-on-busy). The receive-side guard above is worthless if the sender
 * queues instead — the backlog would simply move one hop upstream and
 * arrive as frames that are already old.
 */
describe('the BLE voice lane drops on busy rather than queueing', () => {
  test('iOS asks the stack whether it can send before it writes', () => {
    // Mutation: drop the canSendWriteWithoutResponse guard and CoreBluetooth
    // buffers the frames instead of refusing them — late audio, produced at
    // the other end of the same pipe.
    const s = readSource(BLE_SWIFT);
    expect(s).toMatch(/guard per\.canSendWriteWithoutResponse else \{/);
    expect(s).toMatch(/return \/\/ dropped frame — never retransmitted/);
  });

  test('Android writes NO_RESPONSE and never retransmits', () => {
    // Mutation: switch to WRITE_TYPE_DEFAULT and every frame becomes an
    // acknowledged write the stack will queue and retry — the 17 Hz frame
    // cadence then arrives as a growing tail of stale voice.
    const k = readSource(BLE_KT);
    expect(k).toMatch(/WRITE_TYPE_NO_RESPONSE/);
    expect(k).not.toMatch(/WRITE_TYPE_DEFAULT/);
    expect(k).toMatch(/\/\/ dropped frame — never retransmitted/);
  });
});
