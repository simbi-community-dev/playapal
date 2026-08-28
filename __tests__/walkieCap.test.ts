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
    // The watchdog first tries the rebuild-retry (see the corpse test
    // below); its FINAL arc still rejects with "no-audio", and a settled
    // press is left alone.
    expect(swift).toMatch(/asyncAfter\(deadline: \.now\(\) \+ 1\.0\) \{\s*\n\s*guard !settled else \{ return \}/);
    expect(swift).toMatch(/settle\(false, "no-audio"\)/);
    // the not-ok arc un-keys and removes the tap (the reverse arc) — for
    // the CURRENT press only, and under the catcher (build-36 crash class).
    expect(swift).toMatch(/settled = true[\s\S]{0,700}setTalking\(false\)\s*\n\s*_ = ObjCTry\.run \{ self\.engine\?\.inputNode\.removeTap\(onBus: 0\) \}/);
  });

  test('a dead cached engine is rebuilt, never returned', () => {
    // Mutation: return the cached engine unconditionally after try? start()
    // — the mini's post-call state comes back: a WebRTC interruption leaves
    // an engine start() never revives, PTT reads "no-audio" and received
    // frames schedule onto a dead engine in silence (measured 2026-08-25,
    // notification shown / no sound). The cure discards the corpse so the
    // create path below rebuilds session + engine, and ITS failure throws.
    const swift = readSource(SWIFT);
    // The healthy return is DOUBLY gated — running AND input alive — and
    // the corpse arc (either gate failing) discards the pair for the
    // create path below.
    expect(swift).toMatch(
      /if e\.isRunning && inputAlive \{[\s\S]{0,4200}return e\s*\n\s*\}[\s\S]{0,900}e\.stop\(\)\s*\n\s*engine = nil\s*\n\s*playerNode = nil/
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
    // The reuse path re-asserts the session softly (throttled to 1/s —
    // it is an audio-server XPC round trip per received frame) — and
    // ACTIVATES it too: a category set on a session someone else
    // deactivated (WebRTC's teardown, syslog 2026-08-26) only takes
    // effect at activation.
    // The reuse-path re-assert reads ALL THREE readable wrongs (codex
    // review: options too — lost defaultToSpeaker = earpiece playback),
    // retries after its own failures (healthy only on BOTH calls
    // succeeding), and never asserts on a healthy shape (the ducking bug).
    expect(swift).toMatch(/!session\.categoryOptions\.contains\(\.defaultToSpeaker\)/);
    expect(swift).toMatch(/if shapeWrong \|\| !sessionAssertHealthy \{/);
    expect(swift).toMatch(
      /try session\.setCategory\(\s*\n\s*\.playAndRecord, mode: \.default[\s\S]{0,140}try session\.setActive\(true\)\s*\n\s*sessionAssertHealthy = true/
    );
    expect(swift).toMatch(/catch \{\s*\n\s*sessionAssertHealthy = false/);
  });

  test('a cached engine must PROVE its input is alive, and the walkie heals itself', () => {
    // The TF8 morning finding (the mini, 2026-08-26): the mic probe read
    // OK on a FRESH engine in our exact shipped ordering while real PTT
    // stayed silent — because react-native-webrtc rebuilt the shared
    // session (VoiceChat + Bluetooth, then a deactivate we never call)
    // under the CACHED engine, whose input element died while isRunning
    // kept reading true. Three seams, one bug class, each a mutation:
    const swift = readSource(SWIFT);
    // (1) reuse-time liveness — a dead input element reads 0 Hz, and the
    // read itself runs under the ObjC catcher (it can raise).
    expect(swift).toMatch(
      /ObjCTry\.run \{ hwRate = e\.inputNode\.inputFormat\(forBus: 0\)\.sampleRate \}/
    );
    expect(swift).toMatch(/inputAlive = exc == nil && hwRate > 0/);
    expect(swift).toMatch(/walkie\/\/input-dead rebuilding/);
    // (2) the 1s watchdog spends its first silence on a rebuild-retry —
    // discard the cache, re-arm once against a freshly built engine —
    // and only a silent second on the FRESH engine reaches the camper.
    expect(swift).toMatch(
      /if attemptsLeft > 0, self\.isTalking\(\) \{[\s\S]{0,220}self\.discardEngine\(\)\s*\n\s*do \{\s*\n\s*try arm\(\)/
    );
    // (3) call end drops the cache outright, so the next PTT or received
    // frame rebuilds against the session as WebRTC actually left it.
    expect(swift).toMatch(/if !active \{[\s\S]{0,900}discardEngine\(\)\s*\n\s*\}\s*\n\s*resolve\(nil\)/);
    // The discard helper is the ONE sanctioned teardown shared with
    // stopInternal — serialized under the same lock as ensureEngine.
    expect(swift).toMatch(/private func discardEngine\(\) \{\s*\n\s*engineLock\.lock\(\)/);
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

describe('the build-36 crash class is closed (repeated PTT, .ips 2026-08-26)', () => {
  test('every removeTap runs under the ObjC catcher — a bare one is the crash', () => {
    // The .ips names it exactly: SIGABRT from an uncaught NSException in
    // -[AVAudioNode removeTapOnBus:] on the main queue. removeTap on a
    // node whose engine was discarded RAISES, and Swift cannot catch it.
    // Mutation: unwrap any one of the four sites — this list goes non-empty.
    const swift = readSource(SWIFT);
    const bare = swift
      .split('\n')
      .filter(l => l.includes('.removeTap(onBus') && !l.includes('ObjCTry.run'));
    expect(bare).toEqual([]);
  });

  test('a press captures its generation, and every deferred arc checks it first', () => {
    // Rapid re-keying let press N's 1s watchdog fire while press N+1 owned
    // the mic: it discarded the LIVE engine and removeTapped a dead node.
    // Mutations: drop the capture, the settle guard, the watchdog guard, or
    // the release bump — each reopens one road back to the crash.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/self\.pressGen &\+= 1\s*\n\s*let gen = self\.pressGen/);
    expect(swift).toMatch(/if self\.pressGen == gen \{\s*\n\s*self\.setTalking\(false\)/);
    expect(swift).toMatch(/guard self\.pressGen == gen else \{\s*\n\s*settle\(true, nil\)/);
    expect(swift).toMatch(/self\?\.pressGen &\+= 1/);
    // The scold is earned by a HELD press only (the mini, build 40: fresh
    // rebuilds made first buffers slower than a dab, and every dab earned
    // a "(no-audio)" notification for a press that was already over).
    // Mutations: scold the released tap again; or quiet the held press.
    expect(swift).toMatch(/if self\.isTalking\(\) \{[\s\S]{0,220}settle\(false, "no-audio"\)[\s\S]{0,900}walkie\/\/tap-outran-engine[\s\S]{0,80}settle\(true, nil\)/);
  });
});

describe('a truncated iPhone advertisement still finds the pod (field, 2026-08-26)', () => {
  // The first live cross-OS bench: iOS cut "PV"+16hex to "PVb6ef1b" in the
  // packet Android received; the strict length check rejected every real
  // iPhone as reason=no-carrier. The name was only ever a pre-connect
  // filter — the GATT ident read is the proof — so a pod-hash prefix is
  // enough to spend a dial on.
  const KT_BLE = 'android/app/src/main/java/com/playapal/WalkieBleLink.kt';
  const SWIFT_BLE = 'ios/PlayaPal/WalkieBleVoice.swift';

  test('Android accepts a pod-prefix name and dials with the sender unknown', () => {
    const kt = readSource(KT_BLE);
    expect(kt).toMatch(/name\.length < 2 \+ 6/);
    expect(kt).toMatch(/if \(!podHex\.regionMatches\(0, hex, 0, n, ignoreCase = true\)\)/);
    expect(kt).toMatch(/writeU32\(b, 6, UNKNOWN_SENDER\)/);
  });

  test('the ident proof re-keys an unknown-sender peer to its real identity', () => {
    const kt = readSource(KT_BLE);
    expect(kt).toMatch(
      /if \(peer\.hash == UNKNOWN_SENDER\) sender == senderHash else sender != peer\.hash/
    );
    expect(kt).toMatch(/voicePeers\.remove\(UNKNOWN_SENDER\)\s*\n\s*peer\.hash = sender\s*\n\s*voicePeers\[sender\] = peer/);
  });

  test('a proven address is not redialled while its peer is still REACHED', () => {
    // Measured minutes after the acceptor landed: every sighting of the
    // truncated advert re-minted a fresh unknown-sender entry and dialled
    // the already-connected iPhone forever, ~every 30s, each dial waking
    // its Bluetooth stack. Mutations: drop the memo write, the liveness
    // re-check, or the skip — the churn returns.
    //
    // READY, not `ready || connecting` (2026-08-27, the second bench). The
    // damper's whole warrant is "that phone is on the far end of a working
    // link"; a dial in flight has proved nothing, and the scan stream is
    // this rung's only retry engine, so damping on it suppressed the
    // sighting that would have healed a stalled setup. Refusing a second
    // CONCURRENT dial stays maybeConnect's job on the same entry, and
    // __tests__/walkieIdentProof.test.ts holds both halves.
    const kt = readSource(KT_BLE);
    expect(kt).toMatch(/provenAddr = android\.util\.LruCache<String, Long>\(16\)/);
    expect(kt).toMatch(/peer\.gatt\?\.device\?\.address\?\.let \{ provenAddr\.put\(it, sender\) \}/);
    expect(kt).toMatch(/if \(p != null && p\.ready\) \{\s*\n\s*noteScanDrop\("already-reached", r, name\)\s*\n\s*return/);
  });

  test('iOS advertises the surviving 10-char pod form, never the 18-char pair', () => {
    const ble = readSource(SWIFT_BLE);
    expect(ble).toMatch(/String\(format: "PV%08x", podHash\)/);
    expect(ble).not.toMatch(/PV%08x%08x/);
  });

  test('the iOS DECODER accepts what iOS now advertises — both sides moved together', () => {
    // The asymmetry this closes was shipped and then measured the same
    // afternoon: pvName() moved to the 10-char form while decodePv still
    // demanded exactly 18, so a build-38 iPhone was invisible to every
    // OTHER iPhone (both iPhones still reached Androids, whose mfg-data
    // carrier decodePv reads separately — the exact one-direction shape
    // of the morning's Android bug, replayed between iPhones).
    // Mutations: restore the exact-length check; drop the unknown-sender
    // ternary; drop the re-key; drop the damper lookup.
    const ble = readSource(SWIFT_BLE);
    expect(ble).toMatch(/name\.hasPrefix\("PV"\), name\.count >= 2 \+ 6/);
    expect(ble).toMatch(/return \(podHash, Self\.unknownSender\)/);
    expect(ble).toMatch(
      /\(peer\.hash == Self\.unknownSender \? sender == senderHash : sender != peer\.hash\)/
    );
    expect(ble).toMatch(/voicePeers\.removeValue\(forKey: Self\.unknownSender\)\s*\n\s*peer\.hash = sender\s*\n\s*voicePeers\[sender\] = peer/);
    // The damper's lookup, written against the LOCAL that now holds the
    // sighting's address (2026-08-27, the generation substrate): the scan
    // callback passes an ADDRESS and the advertisement's facts onward and
    // keeps its CBPeripheral object to itself, so the identifier is read
    // once at the top. Both halves are asserted so the memo cannot quietly
    // start being keyed by something other than the sighted address.
    expect(ble).toMatch(/let id = peripheral\.identifier/);
    expect(ble).toMatch(/let known = provenIdentity\[id\]/);
  });
});


describe('the call surface after the first real call (owner, 2026-08-26)', () => {
  const PANEL = 'src/crews/VideoCallPanel.tsx';
  const REDUCER = 'src/crews/videoCall.ts';

  test('the SELF-VIEW is the only mirrored view, and only while the front lens is live', () => {
    // THE REPORTED BUG, pinned. "the front camera is flipped so when you
    // pan right it goes left": the panel hardcoded `mirror` on the
    // self-view, so Flip switched the lens and left the REAR camera
    // mirrored — a window rendered as a mirror, panning backwards.
    //
    // Mutations, each of which this kills: put `mirror` back as a bare
    // prop (the count and the callSelfMirrored match both fail); move it
    // onto the remote view (the remote block match fails, and the other
    // person's lettering renders backwards); invert the rule in the
    // reducer (the last match fails).
    const panel = readSource(PANEL);
    expect(panel.match(/mirror=/g) ?? []).toHaveLength(1);
    const localView = /streamURL=\{snap\.localStreamUrl\}[\s\S]*?\/>/.exec(panel);
    expect(localView?.[0]).toMatch(/mirror=\{callSelfMirrored\(m\)\}/);
    const remoteView = /streamURL=\{snap\.remoteStreamUrl\}[\s\S]*?\/>/.exec(panel);
    expect(remoteView).not.toBeNull();
    expect(remoteView?.[0]).not.toMatch(/mirror/);
    expect(readSource(REDUCER)).toMatch(
      /export function callSelfMirrored\(m: CallModel\): boolean \{\n\s*return m\.frontCamera;/
    );
  });

  test('mute is a STANDING pill, not a shade on a button', () => {
    // The owner's words: "a visual indicator for mic on and off should be
    // better, it's confusing as is with the simple buttons". Mutation:
    // delete the pill and keep only the button's colour change — mute
    // becomes something you infer from shading, at arm's length, in the
    // sun, which is exactly the report.
    const panel = readSource(PANEL);
    expect(panel).toMatch(/<Text style=\{styles\.mutedPillText\}>Muted<\/Text>/);
    // ...and the pill only exists while the mic is actually muted.
    expect(panel).toMatch(/\{m\.micMuted \? \(\s*\n\s*<View style=\{styles\.mutedPill\}>/);
  });

  test('the call surface reaches the house Text, never react-native’s', () => {
    // Same bug class as a hardcoded colour: a raw Text ignores the
    // camper's size dial. themeGuard/textSize walk the whole tree; this
    // names the two newest files so the failure points at them.
    for (const f of [PANEL, 'src/crews/CallIcons.tsx']) {
      const src = readSource(f);
      const rnImport = /import \{([\s\S]*?)\} from 'react-native';/.exec(src);
      expect(rnImport?.[1] ?? '').not.toMatch(/\bText\b/);
    }
    expect(readSource(PANEL)).toMatch(
      /import \{ Text \} from '\.\.\/components\/Text';/
    );
  });

  test('the controls fade on idle but hold still for reduced motion and screen readers', () => {
    // Mutation: drop the keepControls gate — chrome that hides itself is
    // chrome a screen reader user has to hunt for, and motion nobody asked
    // for on a phone that asked for none.
    const panel = readSource(PANEL);
    expect(panel).toMatch(/const CONTROLS_IDLE_MS = 4000;/);
    expect(panel).toMatch(/isReduceMotionEnabled\?\.\(\)/);
    expect(panel).toMatch(/isScreenReaderEnabled\?\.\(\)/);
    expect(panel).toMatch(/if \(!live \|\| keepControls \|\| !controlsUp\) \{/);
  });
});

describe('the hang-diagnosis pulse (two force-quit freezes, 2026-08-26)', () => {
  test('ONE call prints TWO lines from TWO threads', () => {
    // THE LOAD-BEARING ONE. The whole diagnostic is the PAIR: `js` alone
    // repeating means main is wedged, neither means JS is. Mutation: drop
    // the main-queue line (or hop the whole method onto main first) and
    // the two failures become one indistinguishable silence again — which
    // is the state that left both freezes with no evidence.
    const swift = readSource(SWIFT);
    expect(swift).toMatch(/@objc\(logPulse:\)\n\s*func logPulse\(_ tag: String\) \{\n\s*NSLog\("walkie\/\/hb %@", tag\)/);
    expect(swift).toMatch(/DispatchQueue\.main\.async \{\n\s*NSLog\("walkie\/\/hb main"\)/);
    // A method missing from the bridge is a method JS cannot see, however
    // correct the Swift is.
    expect(readSource('ios/PlayaPal/WalkieBridge.m')).toMatch(
      /RCT_EXTERN_METHOD\(logPulse:\(NSString \*\)tag\)/
    );
  });

  test('it costs nothing when nothing is happening, and stops on teardown', () => {
    // Mutations: drop the clearInterval and a closed call keeps pulsing
    // forever; drop the platform or presence gate and every Android and
    // every older native takes a bridge call every two seconds for a
    // method that is not there.
    const hp = readSource('src/crews/hangPulse.ts');
    expect(hp).toMatch(/export const HANG_PULSE_MS = 2000;/);
    expect(hp).toMatch(/if \(!active \|\| Platform\.OS !== 'ios' \|\| !walkiePulsePresent\(\)\) \{/);
    expect(hp).toMatch(/return \(\) => clearInterval\(id\);/);
    expect(readSource('src/crews/walkie.ts')).toMatch(
      /typeof native\.logPulse === 'function'/
    );
  });

  test('it beats in BOTH windows a freeze has been seen in', () => {
    // Mutation: mount it only on the call — the pairing-sheet freeze stays
    // evidence-free, which is half the reason this exists.
    expect(readSource('src/crews/WalkieDeck.tsx')).toMatch(
      /useHangPulse\(phase !== 'idle' && phase !== 'ended'\);/
    );
    expect(readSource('src/crews/AwarePairRow.tsx')).toMatch(
      /useHangPulse\(pairing\);/
    );
  });
});

describe('the AudioTrack write and its release share one monitor (P7 SIGSEGV, 2026-08-26 13:20)', () => {
  // The crash: SIGSEGV in AudioTrack::releaseBuffer under write() on thread
  // "walkie-rx-aware" — stopInternal released the track while an RX thread
  // was inside write() on a reference it had fetched a moment earlier. No
  // exception exists to catch; the process dies. The cure is one monitor:
  // every write goes through writeTrack (synchronized, and only against
  // the CURRENT track), and the release takes the same monitor.
  const kt = readSource(KT);

  test('every RX write goes through the synchronized writeTrack door', () => {
    // Mutation: call t.write() directly at a write site, or drop the
    // @Synchronized from writeTrack — the crash window reopens.
    expect(kt).toMatch(/@Synchronized\n\s*private fun writeTrack\(/);
    // Only against the CURRENT track, and a track that is no longer ours
    // takes nothing and says so with -1. The SHAPE moved from a one-line
    // expression body to a guarded block on 2026-08-27, when the depth
    // accounting joined the write inside this same monitor (defect E,
    // __tests__/walkieLateDrop.test.ts), and took a `frames` parameter
    // later the same day when the ADMISSION joined them too (defect A's
    // second face, same file); the `track !== t` guard itself did not.
    expect(kt).toMatch(
      /private fun writeTrack\([^)]*\): Int \{\n\s*if \(track !== t\) \{\n\s*return -1/
    );
    const bareWrites = kt.match(/\bt\.write\(/g) ?? [];
    expect(bareWrites).toHaveLength(1); // the one inside writeTrack
    expect(kt).toMatch(/writeTrack\(t, out, 0, out\.size, frames\)/);
    expect(kt).toMatch(/writeTrack\(t, buf, HEADER, n - HEADER, frames\)/);
  });

  test('the release takes the same monitor', () => {
    // Mutation: release outside synchronized(this) — a write in flight on
    // another thread lands on freed native memory.
    expect(kt).toMatch(/synchronized\(this\) \{\n\s*try \{\n\s*track\?\.release\(\)/);
  });
});
