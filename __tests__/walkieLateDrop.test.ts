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
 * land more than the bound ahead of what has actually PLAYED is DROPPED and
 * counted, never queued. Dropping is the rung being honest about its
 * bandwidth, exactly like the lo-fi badge. A walkie ten seconds behind is
 * worse than silence on the playa.
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

describe('the drop happens on the playback path, not in a comment', () => {
  test('Android gates BOTH codec branches before writing to the track', () => {
    // THE LOAD-BEARING ONE for this platform. Mutation: restore either
    // `ensureTrack().write(...)` and that codec keeps queueing without
    // bound — rung 3, the lo-fi lane where this was measured, is exactly
    // the branch a partial fix would leave behind.
    const kt = readSource(KT);
    expect(kt).not.toMatch(/ensureTrack\(\)\.write\(/);
    expect((kt.match(/if \(!tooLate\(t, frames\)\) \{/g) ?? []).length).toBe(2);
    expect(kt).toMatch(/private fun tooLate\(t: AudioTrack, frames: Int\): Boolean/);
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
    expect((kt.match(/framesWritten\.addAndGet\(wrote \/ 2\)/g) ?? []).length).toBe(2);
    expect((kt.match(/if \(wrote > 0\) \{/g) ?? []).length).toBe(2);
    expect(kt).not.toMatch(/framesWritten\.addAndGet\(frames\)/);
  });

  test('Android zeroes the written count with the track', () => {
    // Mutation: drop either reset. The next session's playback head starts
    // at zero while the count remembers the last one, so the guard reads a
    // vast backlog and drops EVERY frame — a walkie that is silent rather
    // than late, which is the same bug wearing the opposite face.
    const kt = readSource(KT);
    expect((kt.match(/framesWritten\.set\(0\)/g) ?? []).length).toBe(2);
  });

  test('iOS admits a frame before scheduling it, and only then', () => {
    // THE LOAD-BEARING ONE for this platform. Mutation: restore the bare
    // `scheduleBuffer(buf, completionHandler: nil)` and the iPhone — the
    // phone that was actually ten seconds late in the field — queues
    // without bound again.
    const swift = readSource(SWIFT);
    expect(swift).not.toMatch(/scheduleBuffer\(buf, completionHandler: nil\)/);
    expect(swift).toMatch(/if admitFrames\(claimed\) \{/);
    expect(swift).toMatch(/private func admitFrames\(_ n: Int\) -> Bool/);
    expect(swift).toMatch(/if pendingFrames \+ n > Self\.maxLeadFrames/);
  });

  test('iOS counts its queue down as well as up', () => {
    // AVAudioPlayerNode has no queue-depth getter, so the depth is only as
    // honest as its two ends. Mutation: schedule with a nil completion
    // handler again and pendingFrames only ever RISES — the guard drops
    // everything after the first 400 ms and the walkie goes deaf.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/completionHandler: \{ \[weak self\] in\s*\n\s*self\?\.releaseFrames\(claimed\)/);
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
    expect(swift).toMatch(/if exc != nil \{\s*\n\s*releaseFrames\(claimed\)/);
  });

  test('iOS zeroes the depth wherever the player node is dropped', () => {
    // Mutation: drop either resetPending() — discardEngine or the
    // corpse-rebuild inside ensureEngine — and the dead player's backlog
    // is charged to the fresh one.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/private func resetPending\(\)/);
    expect((swift.match(/\n\s*resetPending\(\)\n/g) ?? []).length).toBe(2);
  });

  test('the drop is bounded by depth, and the counter is separate from it', () => {
    // Mutation: reuse pendingFrames as the drop counter (or reset the drop
    // counter with the engine) and the bench loses the one number it came
    // for — how often this rung is at its ceiling.
    expect(readSource(SWIFT)).toMatch(/private var lateDrops = 0/);
    expect(readSource(KT)).toMatch(/private val lateDrops = java\.util\.concurrent\.atomic\.AtomicInteger\(0\)/);
  });
});

describe('a drop says so, at a rate a human can read', () => {
  test('both platforms log the counter under one name', () => {
    // Mutation: rename either line and the next bench cannot grep one
    // string across two phones — which is the entire point of naming it
    // the same thing on both.
    expect(readSource(KT)).toMatch(/"walkie\/\/late-drop count="/);
    expect(readSource(SWIFT)).toMatch(/"walkie\/\/late-drop count=%d/);
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

  test('a dropped frame still lights the speaking chip', () => {
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
