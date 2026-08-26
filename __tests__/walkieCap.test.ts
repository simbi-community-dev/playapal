/**
 * The walkie channel cap is THREE FILES AGREEING on one number
 * (docs/WALKIE-LADDER.md §6a; owner ruling 2026-08-24: "a soft guard that
 * limits the number of joiners in a walkie channel to 10 or even less").
 *
 * Nothing type-checks a Kotlin constant against a Swift constant against a
 * TypeScript one, and the failure is silent and asymmetric: if Android caps
 * at 9 and iOS does not, an iPhone in a big pod quietly sprays 1.9 MB/s at a
 * channel where every Android is talking to nine people. Nobody sees an
 * error — some people just are not heard, on one platform, at camp scale,
 * where nobody can debug it.
 *
 * So this suite reads the real files and asserts the seams line up. Each
 * assertion is written to die on a specific mutation, named beside it.
 */
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const SWIFT = 'ios/PlayaPal/Walkie.swift';

import {
  WALKIE_MAX_PARTICIPANTS,
  WALKIE_MAX_PEERS,
  walkieCapCopy,
  walkieChannelFull,
  walkieTransmitCount,
} from '../src/crews/walkie';

describe('the cap is one number in three languages', () => {
  test('Kotlin, Swift and TypeScript agree on the peer ceiling', () => {
    // Mutation: change any one of the three — the platforms disagree about
    // who is on the channel and only one of them is wrong out loud.
    const kt = /const val MAX_PEERS = (\d+)/.exec(readSource(KT))?.[1];
    const swift = /private static let maxPeers = (\d+)/.exec(readSource(SWIFT))?.[1];
    expect(kt).toBeDefined();
    expect(swift).toBeDefined();
    expect(Number(kt)).toBe(WALKIE_MAX_PEERS);
    expect(Number(swift)).toBe(WALKIE_MAX_PEERS);
  });

  test('the ceiling is the owner’s: ten people on the channel, me included', () => {
    // Mutation: drift the participant count and the copy starts promising a
    // channel size the radio does not serve.
    expect(WALKIE_MAX_PARTICIPANTS).toBe(10);
    expect(WALKIE_MAX_PEERS).toBe(WALKIE_MAX_PARTICIPANTS - 1);
    expect(WALKIE_MAX_PARTICIPANTS).toBeLessThanOrEqual(10);
  });
});

describe('the cap is enforced on the hot path, not in the UI', () => {
  test('both native send loops iterate the BOUNDED set, never the peer map', () => {
    // THE LOAD-BEARING ONE. Mutation: revert either loop to `for (p in
    // peers.values)` / `for (name, var peer) in peers` and the cap becomes
    // decorative — the panel says "talking to 9" while the radio sprays all
    // sixty, which is the exact failure the guard exists to prevent, now
    // wearing a reassuring label.
    const kt = readSource(KT);
    expect(kt).toMatch(/for \(p in targets\)/);
    expect(kt).not.toMatch(/for \(p in peers\.values\)\s*\{\s*try\s*\{\s*s\.send/);
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/for t in currentTargets\(\)/);
  });

  test('the bounded set is recomputed on peer change, never per frame', () => {
    // Mutation: sort inside the 20 ms send loop — 50 sorts a second over the
    // peer map, on the audio path, on a phone in the dust.
    const kt = readSource(KT);
    expect(kt).toMatch(/private fun recomputeTargets\(\)/);
    expect(kt).toMatch(/\.take\(MAX_PEERS\)/);
    // recomputeTargets is called from emitPeers, which fires on add/remove.
    expect(kt).toMatch(/private fun emitPeers\(\)\s*\{\s*\n\s*recomputeTargets\(\)/);
  });

  test('selection is deterministic, so phones tend to pick the same people', () => {
    // Mutation: take an arbitrary subset (map iteration order) and two phones
    // choose different nines — the pod fragments into overlapping channels
    // and nobody can tell why. Determinism is not a quorum protocol and the
    // comments say so; it just makes the common case agree for free.
    expect(readSource(KT)).toMatch(/sortedBy/);
    expect(readSource(SWIFT)).toMatch(/sorted\s*\{[^}]*senderHash/);
  });

  test('the native side reports what it will ACTUALLY reach', () => {
    // Mutation: drop talkingTo and the panel can only report `count`, so a
    // 12-person channel reads as if all 12 hear you.
    expect(readSource(KT)).toMatch(/m\.putInt\("talkingTo", targets\.size\)/);
    // roster, not the raw peer map: since the per-person dedupe landed
    // with rung 3, one human on two rungs is one row — counting the map
    // would re-inflate talkingTo with duplicates the radio never sends.
    expect(readSource(SWIFT)).toMatch(/"talkingTo": min\(roster\.count, Self\.maxPeers\)/);
  });
});

describe('the JS half clamps and tells the truth', () => {
  test('the transmit count never exceeds the cap and never goes negative', () => {
    // Mutation: drop either clamp — a bad count becomes a bad loop bound.
    expect(walkieTransmitCount(0)).toBe(0);
    expect(walkieTransmitCount(-5)).toBe(0);
    expect(walkieTransmitCount(NaN)).toBe(0);
    expect(walkieTransmitCount(3)).toBe(3);
    expect(walkieTransmitCount(WALKIE_MAX_PEERS)).toBe(WALKIE_MAX_PEERS);
    expect(walkieTransmitCount(60)).toBe(WALKIE_MAX_PEERS);
  });

  test('the channel is full AT the ceiling, not one past it', () => {
    // Mutation: use > instead of >= and the tenth person is silently the
    // first one nobody hears.
    expect(walkieChannelFull(WALKIE_MAX_PEERS - 1)).toBe(false);
    expect(walkieChannelFull(WALKIE_MAX_PEERS)).toBe(true);
    expect(walkieChannelFull(WALKIE_MAX_PEERS + 1)).toBe(true);
  });

  test('a channel under the ceiling says nothing at all', () => {
    // Mutation: always return copy — a two-person pod reads a warning about
    // a limit it will never meet.
    expect(walkieCapCopy(0)).toBeNull();
    expect(walkieCapCopy(WALKIE_MAX_PEERS - 1)).toBeNull();
  });

  test('the full-channel sentence names the limit and routes to the voice note', () => {
    // Async keeps EQUAL BILLING with live talk (owner ruling 16:20), so the
    // overflow path is the answering machine stated as the better tool —
    // never as a consolation prize, and never as an error.
    // Mutation: drop the voice note and a full channel becomes a dead end.
    const copy = walkieCapCopy(WALKIE_MAX_PEERS) as string;
    expect(copy).toContain(String(WALKIE_MAX_PARTICIPANTS));
    expect(copy).toContain(String(WALKIE_MAX_PEERS));
    expect(copy).toMatch(/voice note/);
    expect(copy).toMatch(/reaches everyone/);
    // and it must not apologise or call live talk the real one
    expect(copy).not.toMatch(/sorry|unfortunately|instead of talking|fall ?back/i);
  });
});

/**
 * THE FRAME HEADER, pinned across both native halves (docs/WALKIE-LADDER.md
 * §3). The ladder's whole complexity control is "one protocol, N transports":
 * the rung changes the CODEC and the socket, never the frame. That only works
 * if the frame says which codec it carries — hence byte 2, (version << 4) |
 * codec, and HEADER 12 -> 13.
 *
 * An offset that disagrees between platforms is the worst failure this app
 * can have: it does not error, it PLAYS. A frame read one byte off is noise
 * at whatever volume a person is holding to their ear, and it would only ever
 * be discovered by two phones of different kinds meeting in the dust.
 */
describe('the PW frame is one layout in two languages', () => {
  test('both halves reserve 13 bytes of header', () => {
    // Mutation: leave either at 12 — every field after byte 2 shifts by one
    // on that platform only.
    expect(Number(/const val HEADER = (\d+)/.exec(readSource(KT))?.[1])).toBe(13);
    expect(Number(/private static let header = (\d+)/.exec(readSource(SWIFT))?.[1])).toBe(13);
  });

  test('both halves agree on version and codec id', () => {
    const kt = readSource(KT);
    const swift = readSource(SWIFT);
    expect(Number(/const val FRAME_VERSION = (\d+)/.exec(kt)?.[1])).toBe(1);
    expect(Number(/private static let frameVersion: UInt8 = (\d+)/.exec(swift)?.[1])).toBe(1);
    expect(/const val CODEC_PCM16_16K = 0x(\d+)/.exec(kt)?.[1]).toBe('1');
    expect(/private static let codecPcm16_16k: UInt8 = 0x(\d+)/.exec(swift)?.[1]).toBe('1');
  });

  test('both halves pack the head byte the same way', () => {
    // Mutation: swap the nibbles on one side and every frame that platform
    // sends is dropped by the other as "a protocol we do not speak" — a
    // one-way walkie, which is exactly the field bug this pod already spent
    // an evening on.
    expect(readSource(KT)).toMatch(/\(FRAME_VERSION shl 4\) or CODEC_PCM16_16K/);
    expect(readSource(SWIFT)).toMatch(/\(frameVersion << 4\) \| codecPcm16_16k/);
  });

  test('both halves read the fields from the SHIFTED offsets', () => {
    // THE LOAD-BEARING ONE. Inserting a byte without moving every reader is
    // the mutation that ships: the sender is right, the receiver is one byte
    // off, and the result is played rather than rejected.
    const kt = readSource(KT);
    expect(kt).toMatch(/writeU32\(buf, 3, podHash\)/);
    expect(kt).toMatch(/writeU32\(buf, 7, senderHash\)/);
    expect(kt).toMatch(/readU32\(buf, 3\) != podHash/);
    expect(kt).toMatch(/val from = readU32\(buf, 7\)/);
    expect(kt).toMatch(/buf\[11\] = \(\(seq shr 8\)/);
    expect(kt).toMatch(/buf\[12\] = \(seq and 0xFF\)/);
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/let pod = \(UInt32\(b\[3\]\) << 24\)/);
    expect(swift).toMatch(/let from = \(UInt32\(b\[7\]\) << 24\)/);
    expect(swift).toMatch(/let sq = \(UInt16\(b\[11\]\) << 8\) \| UInt16\(b\[12\]\)/);
  });

  test('an unknown version or codec is DROPPED, never played', () => {
    // Mutation: accept anything and a future lo-fi rung's frames get fed to a
    // PCM16 track as noise. Silence from one sender beats garbage in a pod's
    // ear — the decodeBeacon posture, applied to audio.
    const kt = readSource(KT);
    expect(kt).toMatch(/\(head shr 4\) != FRAME_VERSION/);
    expect(kt).toMatch(/\(head and 0x0F\) != CODEC_PCM16_16K/);
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/\(b\[2\] >> 4\) == Self\.frameVersion/);
    expect(swift).toMatch(/\(b\[2\] & 0x0F\) == Self\.codecPcm16_16k/);
  });

  test('a probe codec id is reserved for rung negotiation', () => {
    // §5 step 3: promotion needs a zero-length round trip on the new rung.
    // Mutation: reuse 0x0 for audio and the negotiation frame becomes a
    // playable frame.
    expect(readSource(KT)).toMatch(/const val CODEC_PROBE = 0x0/);
  });
});

/**
 * DOUBLE-TALK (PUNCHLIST #12). Two people holding the button write into one
 * AudioTrack and their PCM interleaves — not two voices, neither voice. The
 * speaker hears themselves perfectly and has no other way to learn that
 * nobody else did, which is what makes silence here a product bug rather
 * than a known limitation.
 */
import {
  WALKIE_DOUBLETALK_MS,
  distinctSpeakers,
  doubleTalkCopy,
} from '../src/crews/walkie';

describe('the panel says when two people are stepping on each other', () => {
  const T = 1_000_000;

  test('one speaker says nothing at all', () => {
    // Mutation: fire on a single speaker and every normal transmission wears
    // a warning about a problem that is not happening.
    expect(doubleTalkCopy([{ name: 'Dusty', atMs: T }], T)).toBeNull();
    expect(
      doubleTalkCopy(
        [
          { name: 'Dusty', atMs: T - 500 },
          { name: 'Dusty', atMs: T },
        ],
        T,
      ),
    ).toBeNull();
  });

  test('two speakers inside the window are named', () => {
    const copy = doubleTalkCopy(
      [
        { name: 'Dusty', atMs: T - 900 },
        { name: 'Marisol', atMs: T },
      ],
      T,
    ) as string;
    expect(copy).toContain('Dusty');
    expect(copy).toContain('Marisol');
    // Names the physics, and tells them what to do about it.
    expect(copy).toMatch(/one voice/);
    expect(copy).toMatch(/take turns/);
  });

  test('speakers OUTSIDE the window are not double-talk', () => {
    // Mutation: never expire samples and a channel where people take proper
    // turns eventually accuses everyone of talking over each other.
    expect(
      doubleTalkCopy(
        [
          { name: 'Dusty', atMs: T - WALKIE_DOUBLETALK_MS - 1 },
          { name: 'Marisol', atMs: T },
        ],
        T,
      ),
    ).toBeNull();
  });

  test("the 'someone' fallback never counts as a second person", () => {
    // THE FALSE-ALARM GUARD. Native emits 'someone' when it cannot resolve a
    // senderHash to a name, so ONE peer flickering between 'someone' and
    // their real name would read as two people — a false alarm about the one
    // thing this sentence exists to make trustworthy.
    expect(
      doubleTalkCopy(
        [
          { name: 'someone', atMs: T - 500 },
          { name: 'Dusty', atMs: T },
        ],
        T,
      ),
    ).toBeNull();
    expect(distinctSpeakers([{ name: 'someone', atMs: T }], T)).toEqual([]);
    expect(distinctSpeakers([{ name: '  ', atMs: T }], T)).toEqual([]);
  });

  test('three or more collapses to a count rather than a list', () => {
    const copy = doubleTalkCopy(
      [
        { name: 'A', atMs: T },
        { name: 'B', atMs: T },
        { name: 'C', atMs: T },
      ],
      T,
    ) as string;
    expect(copy).toContain('3 people');
  });
});


/**
 * THE iOS SEND PATH RUNS ON AVAudioEngine's RENDER THREAD, and what it is
 * allowed to touch there is not a style question.
 *
 * The first version read AND WROTE the `peers` dictionary from that thread
 * while the Bonjour handler replaced the same dictionary wholesale on main.
 * A Swift Dictionary is not thread-safe: that is UNDEFINED BEHAVIOUR, not
 * staleness — and the lazy `peers[name] = peer` write was also a
 * deterministic lost write, leaking one NWConnection per frame whenever the
 * browser fired in the same window. It allocated three times per 20 ms frame
 * on top.
 *
 * Android had already solved this deliberately (WalkieModule.kt's cached
 * `targets`), so these assertions pin the SAME design on both platforms
 * rather than two shapes that happen to work.
 */
describe('the iOS audio thread touches no shared mutable state', () => {
  const swift = readSource(SWIFT);

  test('the send loop reads an immutable snapshot, never the dictionary', () => {
    // THE LOAD-BEARING ONE. Mutation: go back to indexing `peers` in the send
    // loop and the race returns — silently, because it corrupts rather than
    // crashes, and only under discovery churn.
    expect(swift).toMatch(/for t in currentTargets\(\)/);
    const send = swift.slice(swift.indexOf('for t in currentTargets()'));
    const body = send.slice(0, send.indexOf('offset += n'));
    expect(body).not.toMatch(/peers\[/);
    expect(body).not.toMatch(/peers\./);
  });

  test('connections are opened on MAIN, as a peer enters the target set', () => {
    // Mutation: create the NWConnection lazily in the send loop again — that
    // is the write that got lost and leaked a connection per frame.
    expect(swift).toMatch(/private func recomputeTargets\(\)/);
    const recompute = swift.slice(swift.indexOf('private func recomputeTargets()'));
    // The BEHAVIOUR is what this guards — the connection is constructed
    // inside recomputeTargets, on main, as the peer enters the set — not
    // one byte-exact spelling. The Aware rung legitimately moved the
    // endpoint into a local (`guard let endpoint = peer.endpoint`) because
    // an Aware peer arrives with its link already up and dials nothing.
    // The mutation this dies on is unchanged: build the connection lazily
    // in the send loop and it leaks one per frame.
    expect(recompute.slice(0, 1200)).toMatch(/NWConnection\(to: (?:peer\.)?endpoint/);
  });

  test('the snapshot is swapped under a lock, and read under the same one', () => {
    // A reference swap is not atomic in Swift by contract. The critical
    // section is a pointer copy, which is what keeps it safe to take from a
    // real-time thread at all.
    expect(swift).toMatch(/private let targetsLock = NSLock\(\)/);
    expect(swift).toMatch(/private func currentTargets\(\)[\s\S]{0,200}targetsLock\.lock\(\)/);
  });

  test('the snapshot is recomputed where the peer set changes', () => {
    // emitPeers fires from the browser handler on main — the one place the
    // peer set can change — so the snapshot cannot drift from `peers`.
    expect(swift).toMatch(/private func emitPeers\(\)\s*\{\s*\n\s*recomputeTargets\(\)/);
  });

  test('both platforms name the same design, so neither drifts alone', () => {
    // Android's cached targets and iOS's snapshot are the SAME idea. If one
    // side is rewritten, this fails and the other side gets looked at.
    expect(readSource(KT)).toMatch(/private fun recomputeTargets\(\)/);
    expect(swift).toMatch(/private func recomputeTargets\(\)/);
  });
});

describe('a phone never walks into its own channel list', () => {
  // FIELD-MEASURED on the shipped 0.8.0 build, on the exact posture the
  // design recommends: the phone hosting the pod's hotspot (the camp
  // base station) showed ITSELF among its peers ("Sweeper, Pug" on
  // Sweeper's own screen). Both platforms skipped self BY SERVICE NAME,
  // and the name check has two holes — discovery can fire before the
  // registered name is recorded, and mDNS on the hotspot's second
  // interface re-offers our own service under a collision-RENAMED
  // instance. The senderHash inside the wire name (pp|<hash>|<label>)
  // is the canonical identity the instance name is not.
  const kt = readSource(KT);
  const swift = readSource(SWIFT);

  test('Android skips self by senderHash, not only by name', () => {
    // Mutation: drop the hash guard and the hotspot host re-enters its
    // own list the next time mDNS renames across interfaces — visible
    // only at a camp, never in a same-router test.
    expect(kt).toMatch(
      /serviceName\.split\("\|"\)\.getOrNull\(1\) ==\s*\n?\s*java\.lang\.Long\.toHexString\(senderHash\)/,
    );
    // ...and the name check stays as the cheap first-line filter.
    expect(kt).toMatch(/i\.serviceName == myServiceName/);
  });

  test('iOS skips self by senderHash, not only by name', () => {
    expect(swift).toMatch(/guard hash != self\.senderHash else \{ continue \}/);
    expect(swift).toMatch(/name != self\.myName/);
  });

  test('both platforms parse the hash from the same wire field', () => {
    // The field is index 1 of the pipe-split name on both sides; if either
    // ever moves it, this fails and the other side gets looked at.
    expect(kt).toMatch(/split\("\|"\)\.getOrNull\(1\)/);
    expect(swift).toMatch(/bits\[1\]/);
  });
});

describe('iOS PTT cannot crash the app (TestFlight, mini, build 25)', () => {
  test('keying while keyed is a no-op, never a second tap install', () => {
    // Mutation: drop the `if self.isTalking()` short-circuit — a doubled
    // pressIn installs a second tap on bus 0, an ObjC NSException no
    // Swift catch sees, and the app dies at the button.
    const swift = readSource(SWIFT);
    const beforeInstall = swift.slice(0, swift.indexOf('input.installTap'));
    expect(beforeInstall).toMatch(/if self\.isTalking\(\) \{\s*\n\s*resolve\(nil\)\s*\n\s*return/);
  });

  test('the tap asks NO format question — nil format, converter from the first buffer', () => {
    // Mutation: pass a concrete format to installTap (or pre-build the
    // converter from a pre-read) — the mini's whole failure family
    // (builds 25 through TF4) returns: pre-reads lie and raises follow.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/installTap\(onBus: 0, bufferSize: 1024, format: nil\)/);
    expect(swift).toMatch(/if converter == nil \{\s*\n\s*converter = AVAudioConverter\(from: inFmt, to: wireFormat\)/);
    expect(swift).not.toMatch(/AVAudioConverter\(from: inFormat/);
  });

  test('silent keying is impossible: the first buffer resolves, the 1s watchdog rejects', () => {
    // Mutation: drop the watchdog — a mic held elsewhere keys forever in
    // silence; or drop the first-buffer settle — every healthy key waits
    // a full second.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/DispatchQueue\.main\.async \{ settle\(true, nil\) \}/);
    expect(swift).toMatch(/asyncAfter\(deadline: \.now\(\) \+ 1\.0\) \{\s*\n\s*settle\(false, "no-audio"\)/);
    // the not-ok arc un-keys and removes the tap (the reverse arc).
    expect(swift).toMatch(/settled = true[\s\S]{0,240}setTalking\(false\)[\s\S]{0,80}removeTap\(onBus: 0\)/);
  });

  test('a dead cached engine is rebuilt, never returned', () => {
    // Mutation: return the cached engine unconditionally after try? start()
    // — the mini's post-call state comes back: a WebRTC interruption leaves
    // an engine start() never revives, PTT reads "no-audio" and received
    // frames schedule onto a dead engine in silence (measured 2026-08-25,
    // notification shown / no sound). The cure discards the corpse so the
    // create path below rebuilds session + engine, and ITS failure throws.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(
      /if e\.isRunning \{[\s\S]{0,1400}return e\s*\n\s*\}[\s\S]{0,600}e\.stop\(\)\s*\n\s*engine = nil\s*\n\s*playerNode = nil/
    );
    // ...and a SUCCESSFUL restart revives the paused player: p.play() ran
    // only on the create path, so post-interruption frames scheduled into
    // a paused node in silence (TF7 field report). Mutation: drop the
    // revival — RX goes silent after every call again.
    expect(swift).toMatch(
      /if let p = playerNode, !p\.isPlaying \{\s*\n\s*p\.play\(\)/
    );
    // No unconditional `return e` may survive between the restart attempt
    // and the isRunning check — that ordering IS the bug.
    expect(swift).not.toMatch(/try\? e\.start\(\)\s*\n\s*\}\s*\n\s*return e/);
    // Engine lifecycle is SERIALIZED (codex 2026-08-26): ensureEngine is
    // reached from main + receive threads while stopInternal tears down
    // from the bridge queue. Mutation: drop the lock — a teardown nulls
    // the pair mid-ensure and the loser dereferences a corpse.
    expect(swift).toMatch(/engineLock\.lock\(\)\s*\n\s*defer \{ engineLock\.unlock\(\) \}/);
    expect(swift).toMatch(/engineLock\.lock\(\)\s*\n\s*engine\?\.stop\(\)/);
    // And the playback schedule runs under the ObjC catcher: scheduling
    // on a concurrently-detached node raises, reachable from network
    // input. Mutation: unwrap it — a mid-stop frame aborts the app.
    expect(swift).toMatch(/ObjCTry\.run \{\s*\n\s*p\.scheduleBuffer/);
  });

  test('the engine is born hearing: input element before start, mode .default, one catch', () => {
    // Three mutations, each a measured field failure (2026-08-26):
    // (1) drop the pre-start inputNode touch — an output-only engine
    // never enables the input element and every later tap is silent;
    // (2) restore mode .voiceChat — the documented reduced-processing
    // cell that yielded ZERO mic buffers on the mini;
    // (3) re-split the catch — a bare catch swallows every ensureEngine
    // throw and the PTT promise never settles.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/_ = e\.inputNode[\s\S]{0,500}try e\.start\(\)/);
    expect(swift).toMatch(
      /mode: \.default, options: \[\.defaultToSpeaker\]\)\s*\n\s*try session\.setActive/
    );
    expect(swift).not.toMatch(/mode: \.voiceChat/);
    expect(swift).not.toMatch(/\} catch \{\s*\} catch \{/);
    // The reuse path re-asserts the session softly on every return.
    expect(swift).toMatch(
      /try\? AVAudioSession\.sharedInstance\(\)\.setCategory\(\s*\n\s*\.playAndRecord, mode: \.default/
    );
  });

  test('the tap install runs under the ObjC catcher — a raise rejects, never aborts', () => {
    // Mutation: call installTap outside ObjCTry.run — the next AVFAudio
    // precondition (three .ips on the mini said CreateRecordingTap) aborts
    // the whole app at the button again.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/ObjCTry\.run \{\s*\n\s*input\.installTap/);
    // The failure arc un-keys (half-duplex playback must resume) and the
    // guard also refuses a 0 Hz format before the converter.
    expect(swift).toMatch(/if let tapException \{[\s\S]{0,120}settle\(false, tapException\.reason/);
    expect(swift).toMatch(/guard inFmt\.sampleRate > 0 else \{ return \}/);
    // The catcher itself is in the build: bridging header + pbxproj Sources.
    const fs = require('fs');
    expect(fs.readFileSync('ios/PlayaPal/PlayaPal-Bridging-Header.h','utf8')).toMatch(/ObjCTry\.h/);
    const pbx = fs.readFileSync('ios/PlayaPal.xcodeproj/project.pbxproj','utf8');
    expect(pbx).toMatch(/ObjCTry\.m in Sources/);
    expect(pbx.match(/SWIFT_OBJC_BRIDGING_HEADER/g)?.length).toBe(2);
  });

  test('a leaked tap is cleared before install (interrupted takes)', () => {
    const swift = readSource(SWIFT);
    const guardToInstall = swift.slice(
      swift.indexOf('if self.isTalking()'),
      swift.indexOf('input.installTap'),
    );
    expect(guardToInstall).toMatch(/input\.removeTap\(onBus: 0\)/);
  });
});
