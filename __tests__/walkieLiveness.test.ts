/**
 * §5 ENFORCED CONTINUOUSLY — "availability is PROVEN, never announced"
 * (docs/WALKIE-LADDER.md §5, §5b).
 *
 * THE BUG THIS SUITE EXISTS FOR, measured on two Pixels on a ship build
 * (2026-08-25 night): P7's row for P9 wore a plain name and a Call button
 * while its Aware datapath was DEAD. The datapath re-logged
 * aware//datapath-up minutes later, so it had been down that whole time
 * with no onLost, no onUnavailable, no onCapabilitiesChanged — an Android
 * Aware flap can simply go quiet. The callee's call-ACK and a reverse
 * INVITE each resolved that lying row for all eight retransmits, UDP into
 * the downed interface erred nowhere, and the caller ended honest-but-
 * wrong: "No answer". Framework callbacks are not proof. Inbound frames
 * are — counted per ROW, because P9 → P7 kept working the whole time on a
 * different row for the same person.
 *
 * FOUR MUTATIONS, one describe each, because they fail in four different
 * directions: a stale row that keeps its claims, a live row demoted by an
 * over-eager rule, a recovered row that never comes back, and a probe that
 * turns into a dial storm or a battery leak.
 *
 * The JS halves are behaviour-tested. Kotlin and Swift cannot be unit-run
 * here (no gradle, no Mac — fab and EAS are their compilers), so those
 * assertions read the real sources in the walkieLadder.test.ts idiom and
 * each one names the mutation it dies on.
 */
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const AWARE = 'android/app/src/main/java/com/playapal/WalkieAwareLink.kt';
const SWIFT = 'ios/PlayaPal/Walkie.swift';

import { decodeWalkiePeers, formatChannelNames } from '../src/crews/walkie';
import { memberLinkTier, rungsByName } from '../src/crews/podStatus';

describe('MUTATION 1 — a stale datagram row is DEMOTED', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('the badge tells the truth: a demoted row loses its plain name', () => {
    // Mutation: emit p.rung unconditionally — the exact screen the owner
    // watched, a dead datapath wearing a hi-fi name.
    expect(kt).toMatch(
      /rungs\.pushString\(if \(proven\(p, now\)\) p\.rung else "stale"\)/,
    );
    expect(swift).toMatch(
      /"rungs": roster\.map \{ proven\(\$0\.peer, now\) \? \$0\.peer\.rung : "stale" \}/,
    );
    // ...and the JS half gives the demotion its OWN quieter badge (§5a as
    // amended 2026-08-25): the dedupe means a 'stale' row reaches JS only
    // when that person has no lo-fi pipe at all, so (lo-fi) over it
    // promised live audio over nothing. Mutation: fold 'stale' back into
    // (lo-fi) — the lying badge returns; print mechanism ("stale",
    // "reconnecting…") — §5a is gone.
    const line = formatChannelNames([
      { name: 'Dusty', rung: 'stale' },
      { name: 'Marisol', rung: 'aware' },
    ]);
    expect(line).toBe('Dusty (quiet), Marisol');
    expect(line).not.toMatch(/stale|reconnect|connecting|aware|wi-?fi|lan/i);
  });

  test('a demoted row is not a callable identity — the Call button goes', () => {
    // Mutation: drop the proven() gate from `callable` and the button
    // survives the death of its own socket. That button is what the
    // reverse INVITE and the call-ACK both resolved.
    const emit = kt.slice(kt.indexOf('val callable = HashMap<String, Peer>()'));
    expect(emit.slice(0, emit.indexOf('val rows ='))).toContain(
      'if (!proven(p, now)) {',
    );
    expect(swift).toMatch(
      /for p in peers\.values where p\.bleSend == nil && proven\(p, now\)/,
    );
  });

  test('a demoted row ranks BELOW every proven row, BLE included', () => {
    // Mutation: rank by the rung word alone (rungRank) — a dead "aware"
    // row keeps beating a live "ble" row for the same human, which is how
    // the lying row won every targeted send in the first place.
    expect(kt).toMatch(
      /private fun rank\(p: Peer, now: Long\): Int =\s*\n\s*if \(proven\(p, now\)\) rungRank\(p\.rung\) else 3/,
    );
    expect(kt).toMatch(/if \(cur == null \|\| rank\(p, now\) < rank\(cur\.second, now\)\)/);
    expect(swift).toMatch(/proven\(p, now\) \? rungRank\(p\.rung\) : 3/);
    expect(swift).toMatch(/rank\(cur\.peer, now\) <= rank\(p, now\)/);
  });

  test('sendSignal ranks by proof and refuses when nothing is proven', () => {
    // Mutation: keep minByOrNull { rungRank(...) } — the rank trusted the
    // row, and the row was the thing that was lying. Mutation 2: send
    // anyway when nothing is proven — eight retransmits into a downed
    // interface, every one of them erroring nowhere.
    // sortedBy since the hedge lane (docs/VIDEO-CALLS.md §2a) — the fanout
    // takes the first N of this order, so ranking by proof now has to hold
    // down the whole list rather than only at its head.
    const send = kt.slice(kt.indexOf('fun sendSignal('));
    expect(send).toContain('.sortedBy { rank(it.value, now) }');
    expect(send).toContain('promise.reject("stale"');
    const swiftSend = swift.slice(swift.indexOf('func sendSignal('));
    expect(swiftSend).toContain('rank($0.value, now) < rank($1.value, now)');
    expect(swiftSend).toContain('reject("stale"');
  });

  test('the pod card claims no voice for a demoted row', () => {
    // Mutation: let 'stale' fall into the voice tiers — the roster row
    // says "you can talk now" about a socket nobody has proven. Evidence
    // may only move the tier DOWN when it goes missing.
    expect(memberLinkTier({ walkieRung: 'stale', presence: null })).toBe(
      'quiet',
    );
    expect(
      memberLinkTier({
        walkieRung: 'stale',
        presence: { atMs: 1, live: true },
      }),
    ).toBe('near');
  });

  test('a demoted row never outranks a proven one on a name collision', () => {
    // Mutation: keep the two-case rule (held === 'ble' && next !== 'ble') —
    // 'stale' reads as an upgrade over a proven lo-fi row and the roster
    // claims MORE than the radio proved.
    expect(
      rungsByName([
        { name: 'Dusty', rung: 'ble' },
        { name: 'dusty', rung: 'stale' },
      ]).get('dusty'),
    ).toBe('ble');
    expect(
      rungsByName([
        { name: 'Dusty', rung: 'stale' },
        { name: 'dusty', rung: 'lan' },
      ]).get('dusty'),
    ).toBe('lan');
  });
});

describe('MUTATION 2 — a live row is untouched', () => {
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('recent inbound keeps every claim: hi-fi name, Call button, best rank', () => {
    // Mutation: flip the comparison to `>` (or drop the window) and every
    // healthy row is demoted the moment the pod stops talking — a walkie
    // that lies in the other direction is not an improvement.
    expect(kt).toMatch(/\(now - p\.lastInbound\.get\(\)\) < STALE_MS/);
    expect(swift).toMatch(
      /now\.timeIntervalSince\(p\.lastInbound\) < Self\.staleSeconds/,
    );
    // The JS half leaves a proven row bare — no badge, no ceremony.
    const d = decodeWalkiePeers({
      names: ['A', 'B'],
      rungs: ['lan', 'aware'],
      peers: [{ name: 'A', hash: '2a' }],
    });
    expect(d.entries.map(e => e.rung)).toEqual(['lan', 'aware']);
    expect(formatChannelNames(d.entries)).toBe('A, B');
    expect(d.peers).toEqual([{ name: 'A', hash: 0x2a }]);
  });

  test('a BLE row is exempt: rung 3 is proven by its GATT connection', () => {
    // Mutation: drop the sendBle exemption — rung 3 carries no keep-alive
    // (its budget is shared with the answering machine, §2a) so a silent
    // BLE row would be demoted below itself and the ladder's own floor
    // would stop counting as a floor.
    expect(kt).toMatch(/p\.sendBle != null \|\|/);
    expect(swift).toMatch(/p\.bleSend != nil \|\|/);
    // ...and the sweep never probes one.
    expect(kt).toMatch(
      /if \(p\.host == null\) \{\s*\n\s*continue \/\/ rung 3 is proven by its GATT connection/,
    );
    expect(swift).toMatch(/for \(key, p\) in peers where p\.bleSend == nil/);
  });

  test('an older native without rungs still reads as hi-fi, not as stale', () => {
    // Mutation: default the missing rung to 'stale' — every peer of a
    // pre-liveness native loses its Call button for a reason that is about
    // OUR build, not their radio.
    const d = decodeWalkiePeers({ count: 2, names: ['A', 'B'] });
    expect(d.entries.map(e => e.rung)).toEqual(['lan', 'lan']);
    // An unknown word from a NEWER native still folds to hi-fi, for the
    // same reason it always did.
    expect(
      decodeWalkiePeers({ names: ['A'], rungs: ['quantum'] }).entries[0].rung,
    ).toBe('lan');
  });

  test('per SOURCE ROW: a live row cannot vouch for the dead one beside it', () => {
    // THE measured shape — one podmate, two rows, one of them dead.
    // Mutation: stamp by sender hash alone and P7's live LAN row revives
    // P9's dead aware row on every frame, which is the bug with an extra
    // step. The socket a frame lands on names exactly one row; on iOS the
    // delivering lane does.
    const stamp = kt.slice(kt.indexOf('private fun stampInbound'));
    expect(stamp).toContain('(p.socket ?: socket) === srcSocket');
    expect(stamp).toContain('p.sendBle != null');
    expect(swift).toMatch(
      /for \(key, p\) in peers where p\.senderHash == from && p\.rung == lane/,
    );
    // ...and every iOS receive lane says which one it is.
    expect(swift).toContain('self.handleFrame(data, lane: "lan")');
    expect(swift).toContain('handleFrame(d, lane: "aware")');
    expect(swift).toContain('handleFrame(d, lane: "ble")');
  });
});

describe('MUTATION 3 — a recovered row re-promotes', () => {
  const kt = readSource(KT);
  const aware = readSource(AWARE);
  const swift = readSource(SWIFT);

  test('the stamp happens before every gate that can drop the frame', () => {
    // Mutation: stamp after the codec dispatch — a probe dies at the
    // unknown-codec gate and a duplicate dies at the freshness gate, so
    // the two frame kinds most likely to arrive on a recovering link
    // would prove nothing and the row could never come back.
    const body = kt.slice(kt.indexOf('private fun handleFrame('));
    const stampAt = body.indexOf('stampInbound(from, srcSocket)');
    expect(stampAt).toBeGreaterThan(0);
    expect(stampAt).toBeLessThan(body.indexOf('== CODEC_CALL'));
    expect(stampAt).toBeLessThan(body.indexOf('!= CODEC_PCM16_16K'));
    expect(stampAt).toBeLessThan(body.indexOf('val last = lastSeq[from]'));
    const swiftBody = swift.slice(swift.indexOf('private func handleFrame('));
    const swiftStamp = swiftBody.indexOf('row.lastInbound = stamped');
    expect(swiftStamp).toBeGreaterThan(0);
    expect(swiftStamp).toBeLessThan(swiftBody.indexOf('== Self.codecCall'));
    expect(swiftStamp).toBeLessThan(swiftBody.indexOf('let sq ='));
  });

  test('the probe frame is RECEIVABLE on both platforms', () => {
    // Mutation: restore iOS's `count > header` — the keep-alive is a
    // zero-payload frame, so a `>` there means iPhones demote every peer
    // on a schedule and nothing they receive can ever re-promote it.
    expect(swift).toMatch(/if let data, data\.count >= Self\.header/);
    expect(swift).toMatch(/guard b\.count >= Self\.header, b\[0\] == 0x50/);
    expect(kt).toMatch(/if \(n < HEADER \|\| buf\[0\] != 'P'\.code\.toByte\(\)/);
  });

  test('demotion nudges the aware link WITHOUT dropping the row', () => {
    // Mutation: call onPeerLost from noteSilent — the person vanishes from
    // the channel instead of falling to the floor, and there is no row
    // left for an inbound frame to re-promote. Mutation 2: forget the
    // dead socket and the re-formed datapath inherits it (getOrPut).
    const note = aware.slice(aware.indexOf('fun noteSilent('));
    const body = note.slice(0, note.indexOf('/** Every responder-side row'));
    expect(body).not.toMatch(/onPeerLost/);
    expect(body).not.toMatch(/discovered\.remove/);
    expect(body).toContain('sockets.remove(hash)?.close()');
    expect(body).toContain('peer.up = false');
    expect(body).toContain('maybeRequestDatapath(peer)');
    // The module is the only thing that can see the silence, so it is the
    // thing that raises it — through the link's OWN machinery.
    expect(kt).toMatch(/if \(key\.startsWith\("aware\|"\)\) \{\s*\n\s*nudgeAware\(key\)/);
    expect(kt).toMatch(/aware\?\.noteSilent\(hash\)/);
  });

  test('a re-minted or re-answering row starts proven, and says so once', () => {
    // Mutation: drop the birth stamp and a freshly minted row is demoted
    // for its first sweep — the Call button flickers on every discovery.
    expect(kt).toMatch(
      /val lastInbound: java\.util\.concurrent\.atomic\.AtomicLong =\s*\n\s*java\.util\.concurrent\.atomic\.AtomicLong\(System\.currentTimeMillis\(\)\)/,
    );
    expect(swift).toMatch(/var lastInbound: Date = Date\(\)/);
    // Mutation: emit every sweep instead of on change — a 2 s heartbeat of
    // identical peer events, forever, on the JS side's render path.
    expect(kt).toMatch(/if \(unproven != unprovenRows\) \{/);
    expect(swift).toMatch(/if unproven != unprovenRows \{/);
    // Mutation: drop the transition logs — the two-Pixel bench has no way
    // to tell "demoted honestly" from "never noticed", and the failure
    // being fixed here was silent by definition.
    expect(kt).toContain('"walkie//row-demoted key="');
    expect(kt).toContain('"walkie//row-proven key="');
  });

  test('a closed socket ends its receive loop instead of spinning on it', () => {
    // Found in this pass and fixed in it: the link closes aware sockets on
    // every datapath loss — and now on every silence re-dial — and
    // DatagramSocket.receive on a closed socket throws instantly and
    // forever. Mutation: swallow and continue, and each recovery leaves a
    // thread burning a core for the life of the walkie.
    expect(kt).toMatch(/if \(s\.isClosed\) \{\s*\n\s*return\s*\n\s*\}/);
  });
});

describe('MUTATION 4 — the probe cadence is bounded', () => {
  const kt = readSource(KT);
  const aware = readSource(AWARE);
  const swift = readSource(SWIFT);

  test('probing is clock-driven, and sweeping faster does not dial faster', () => {
    // Mutation: probe every sweep tick — the cadence more than doubles for
    // no gain, and "the sweep is cheap" quietly becomes "the radio is
    // busy". The two clocks are separate on purpose.
    expect(kt).toMatch(/val probing = now - lastProbe >= PROBE_MS/);
    expect(kt).toMatch(/if \(probing\) \{\s*\n\s*sendProbe\(p\)\s*\n\s*\}/);
    expect(swift).toMatch(
      /let probing = now\.timeIntervalSince\(lastProbe\) >= Self\.probeSeconds/,
    );
    expect(swift).toMatch(/if probing \{\s*\n\s*sendProbe\(key\)\s*\n\s*\}/);
  });

  test('the demotion nudge adds no request loop beyond the 30 s floor', () => {
    // Mutation: drop the floor — a peer whose radio is flapping gets a
    // fresh requestNetwork every sweep, which is §5 rule 5 inverted: a
    // flapping radio becoming a flapping walkie, with the callback churn
    // that once walked this rung into ConnectivityManager's ~100 cap.
    const note = aware.slice(aware.indexOf('fun noteSilent('));
    expect(note).toContain('if (now - peer.lastNudge < RELOST_FLOOR_MS) {');
    expect(note).toContain('peer.lastNudge = now');
    expect(aware).toMatch(/RELOST_FLOOR_MS = 30_000L/);
    // The responder has no per-peer request to re-file; nudging it would
    // be a re-file of somebody else's any-peer agent.
    expect(note).toContain('senderHash < peer.hash');
  });

  test('the keep-alive lives and dies with the walkie SESSION', () => {
    // Mutation: start the loop at app launch, or leave it running after
    // stop() — a radio kept warm by a screen nobody opened is exactly the
    // battery cost the ladder promised not to spend.
    // Scoped to probeLoop's OWN body: `while (receiving)` also appears in
    // the receive loop, so a file-wide match would have passed while the
    // keep-alive spun on forever — the mutation this test exists for.
    const loop = kt.slice(kt.indexOf('private fun probeLoop()'));
    expect(loop.slice(0, loop.indexOf('private fun nudgeAware'))).toMatch(
      /while \(receiving\) \{/,
    );
    expect(kt).toMatch(/probeThread = Thread\(\{ probeLoop\(\) \}, "walkie-probe"\)/);
    const stop = kt.slice(kt.indexOf('private fun stopInternal()'));
    expect(stop).toContain('probeThread?.interrupt()');
    expect(stop).toContain('probeThread = null');
    expect(swift).toMatch(/sweepTimer = t/);
    const swiftStop = swift.slice(swift.indexOf('private func stopInternal()'));
    expect(swiftStop).toContain('sweepTimer?.cancel()');
    expect(swiftStop).toContain('sweepTimer = nil');
    // The sweep also refuses to run for a walkie that is off (a timer that
    // outlives its cancel by one tick must not resurrect the peer event).
    expect(swift).toMatch(/private func sweep\(\) \{\s*\n\s*guard listener != nil else \{ return \}/);
  });

  test('the probe is the ladder’s own frame, not a new message kind', () => {
    // Mutation: invent a keep-alive codec — a build that does not know it
    // plays it as audio (0x0 is the one id every build has always dropped
    // at the unknown-codec gate), and the wire grows a second liveness
    // vocabulary nobody can reason about (§3).
    expect(kt).toMatch(/CODEC_PROBE = 0x0/);
    expect(kt).toMatch(/buf\[2\] = \(\(FRAME_VERSION shl 4\) or CODEC_PROBE\)\.toByte\(\)/);
    expect(swift).toMatch(/private static let codecProbe: UInt8 = 0x0/);
    expect(swift).toMatch(
      /frame\.append\(\(Self\.frameVersion << 4\) \| Self\.codecProbe\)/,
    );
  });
});

describe('one liveness clock in every language that has one', () => {
  test('Kotlin and Swift agree on stale / probe / sweep', () => {
    // Mutation: change one side only — two phones demote each other on
    // different clocks, which is two ladders wearing one name. The doc is
    // the third copy and carries the same numbers.
    const kt = readSource(KT);
    const swift = readSource(SWIFT);
    expect(kt).toMatch(/const val STALE_MS = 10_000L/);
    expect(kt).toMatch(/const val PROBE_MS = 4_500L/);
    expect(kt).toMatch(/const val SWEEP_MS = 2_000L/);
    expect(swift).toMatch(/staleSeconds: TimeInterval = 10\b/);
    expect(swift).toMatch(/probeSeconds: TimeInterval = 4\.5\b/);
    expect(swift).toMatch(/sweepSeconds: TimeInterval = 2\b/);
  });

  // The public tree ships without docs/ (manifest law) — guard, don't fail.
  (require('fs').existsSync('docs/WALKIE-LADDER.md') ? test : test.skip)('the ladder doc states the rule the code enforces', () => {
    // Mutation: ship the behaviour and leave §5 saying demotion rides the
    // transport's loss signal only — the doc becomes the reason the next
    // reader trusts a callback that does not fire.
    const doc = readSource('docs/WALKIE-LADDER.md');
    expect(doc).toMatch(/### 5b\. The keep-alive/);
    expect(doc).toMatch(/STALE_MS` \(10 s\)/);
    expect(doc).toMatch(/PROBE_MS` \(4\.5 s\)/);
    expect(doc).toMatch(/no `onLost`, no\s*\n?`?onUnavailable`?/);
    // The battery cost is written down where the rule is.
    expect(doc).toMatch(/26 B\/s/);
  });
});
