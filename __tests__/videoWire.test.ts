/**
 * THE CALL WIRE IS ONE LAYOUT IN THREE LANGUAGES — the walkieCap.test.ts
 * discipline applied to codec 0x6. Nothing type-checks a Kotlin constant
 * against a Swift one against TypeScript, and a mismatch does not error:
 * it drops every signal frame on one platform, so calls simply never ring
 * across an Android/iPhone pair, at camp, where nobody can debug it.
 * These assertions read the real files; each names its mutation.
 */
const fs2 = require('fs');
const read = (p: string): string => fs2.readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const SWIFT = 'ios/PlayaPal/Walkie.swift';
const BRIDGE = 'ios/PlayaPal/WalkieBridge.m';
const TS = 'src/crews/walkie.ts';

import { WALKIE_CODEC_CALL } from '../src/crews/walkie';
import { WALKIE_SIGNAL_MAX_PAYLOAD } from '../src/crews/callSignal';

describe('codec 0x6 is one number in three languages', () => {
  test('Kotlin, Swift and TypeScript agree on the call codec id', () => {
    // Mutation: change any one — signal frames from that platform are
    // dropped as "unknown codec" by the other two, silently.
    const kt = /const val CODEC_CALL = 0x([0-9a-fA-F])/.exec(read(KT))?.[1];
    const swift = /codecCall: UInt8 = 0x([0-9a-fA-F])/.exec(read(SWIFT))?.[1];
    expect(parseInt(kt ?? '', 16)).toBe(WALKIE_CODEC_CALL);
    expect(parseInt(swift ?? '', 16)).toBe(WALKIE_CODEC_CALL);
    expect(WALKIE_CODEC_CALL).toBe(0x6);
  });

  test('0x6 collides with no reserved or audio ladder codec', () => {
    // WALKIE-LADDER §6 reserves 0x0 probe, 0x1 PCM16, 0x2/0x3 Opus, 0x4
    // Codec2. Mutation: reuse one of those and a future audio rung's
    // frames get parsed as call chunks.
    expect([0x0, 0x1, 0x2, 0x3, 0x4, 0x5]).not.toContain(WALKIE_CODEC_CALL);
  });
});

describe('both natives dispatch signal frames the same way', () => {
  test('signal dispatch happens BEFORE the PCM codec guard on both platforms', () => {
    // Mutation: leave the pcm guard first — every signal frame is dropped
    // as "unknown codec" and calls never ring. The pinned pcm guard from
    // walkieCap.test.ts still stands right after.
    const rxKt = read(KT).slice(read(KT).indexOf('private fun receiveLoop'));
    expect(rxKt.indexOf('== CODEC_CALL')).toBeGreaterThan(-1);
    expect(rxKt.indexOf('== CODEC_CALL')).toBeLessThan(
      rxKt.indexOf('!= CODEC_PCM16_16K'),
    );
    const hfSwift = read(SWIFT).slice(
      read(SWIFT).indexOf('private func handleFrame'),
    );
    expect(hfSwift.indexOf('Self.codecCall')).toBeGreaterThan(-1);
    expect(hfSwift.indexOf('Self.codecCall')).toBeLessThan(
      hfSwift.indexOf('Self.codecPcm16_16k'),
    );
  });

  test('the signal path never touches the audio seq gate', () => {
    // Mutation: run signals through lastSeq — a retransmitted chunk (the
    // reliability mechanism itself) is dropped as "stale", so exactly the
    // lossy channels that need retransmits cannot signal.
    const kt = read(KT);
    const dispatch = kt.slice(
      kt.indexOf('== CODEC_CALL'),
      kt.indexOf('!= CODEC_PCM16_16K'),
    );
    expect(dispatch).not.toMatch(/lastSeq/);
    const swift = read(SWIFT);
    const sDispatch = swift.slice(
      swift.indexOf('== Self.codecCall'),
      swift.indexOf('== Self.codecPcm16_16k'),
    );
    expect(sDispatch).not.toMatch(/lastSeq/);
  });

  test('both natives emit the same event name JS listens for', () => {
    expect(read(KT)).toMatch(/const val SIGNAL_EVENT = "WalkieSignal"/);
    expect(read(SWIFT)).toMatch(/signalEvent = "WalkieSignal"/);
    expect(read(SWIFT)).toMatch(/Self\.signalEvent[,\]]/); // in supportedEvents, any position
    expect(read(TS)).toMatch(/'WalkieSignal'/);
  });

  test('both natives expose sendSignal, and iOS declares it to the bridge', () => {
    // Mutation: forget the RCT_EXTERN_METHOD — iOS builds, walkieSignalPresent()
    // returns false, and iPhones silently have no call button.
    expect(read(KT)).toMatch(/fun sendSignal\(/);
    // The selector carries `fanout:` since the hedge lane (§2a). The
    // ObjC selector, the Swift signature and the RCT_EXTERN_METHOD must
    // agree letter for letter or the method is simply not there at
    // runtime — which reads to JS as an older native with no call button.
    expect(read(SWIFT)).toMatch(
      /@objc\(sendSignal:payload:fanout:resolver:rejecter:\)/,
    );
    expect(read(BRIDGE)).toMatch(/RCT_EXTERN_METHOD\(sendSignal:/);
  });

  test('both natives refuse a payload the shared buffer would truncate', () => {
    // Mutation: drop the size guard — a long payload ARRIVES truncated on
    // Android (one reused HEADER+640 buffer), corrupting instead of failing.
    expect(read(KT)).toMatch(/data\.size > FRAME_BYTES/);
    expect(read(SWIFT)).toMatch(/data\.count <= Self\.frameSamples \* 2/);
  });

  test('the JS chunk budget fits the native receive buffer', () => {
    const frameSamples = Number(
      /const val FRAME_SAMPLES = (\d+)/.exec(read(KT))?.[1],
    );
    expect(frameSamples).toBeGreaterThan(0);
    expect(WALKIE_SIGNAL_MAX_PAYLOAD).toBeLessThanOrEqual(frameSamples * 2);
  });

  test('both natives hand JS per-peer identity for the call button', () => {
    // Mutation: drop the rows — callable peers have names but no address,
    // and the call button cannot exist.
    expect(read(KT)).toMatch(/m\.putArray\("peers", rows\)/);
    // callablePeers(), not the raw map, since rung 3 reached iOS: a
    // "ble" row is a voice pipe with no dialable address.
    expect(read(SWIFT)).toMatch(/"peers": callablePeers\(\)\.map/);
  });
});

describe('call identities are datagram-capable rows only', () => {
  test('sendSignal picks the best datagram rung, never a BLE row', () => {
    // Mutation: restore firstOrNull-over-any-entry — a podmate on Wi-Fi
    // AND in BLE range coin-flips into the "ble|" row (host=null),
    // DatagramSocket.send throws, all 8 retries fail the same way, and
    // the callee's phone never rings while the caller reads "no answer".
    const kt = read(KT);
    const send = kt.slice(kt.indexOf('fun sendSignal'));
    expect(send).toMatch(/it\.value\.host != null/);
    // rank(), not rungRank(): the ladder's liveness lane (2026-08-25,
    // __tests__/walkieLiveness.test.ts) put PROOF ahead of the rung word
    // here, because ranking by the word alone is how a dead-but-hi-fi row
    // kept beating a live one. The mutation this line guards is unchanged
    // — a BLE row must never win a dial — and rank() still ranks it last.
    //
    // sortedBy, not minByOrNull, since the hedge lane (§2a): the ORDER is
    // what the fanout takes its first N from, so the ranking rule now has
    // to hold for the whole list, not only for its head. Same rule, wider
    // consequence.
    expect(send).toMatch(/\.sortedBy \{ rank\(it\.value, now\) \}/);
    // The iOS mirror, since rung 3 landed there too: first(where:) over
    // a Dictionary was the same coin-flip firstOrNull was on Android.
    const swift = read(SWIFT);
    const sSend = swift.slice(swift.indexOf('func sendSignal'));
    expect(sSend).toMatch(/\$0\.value\.bleSend == nil/);
    expect(sSend).toMatch(
      /\.sorted\(by: \{ rank\(\$0\.value, now\) < rank\(\$1\.value, now\) \}\)/,
    );
  });

  test('the identity rows the call buttons build from exclude BLE-only peers', () => {
    // Mutation: emit rows from the raw peer map — a BLE-only podmate
    // wears a "Call" button that can never ring them, and the duplicate
    // rows defeat the JS dedupe's first-row-wins.
    const kt = read(KT);
    const emit = kt.slice(
      kt.indexOf('private fun emitPeers'),
      kt.indexOf('fun start('),
    );
    expect(emit).toMatch(/if \(p\.host == null\) \{\s*\n\s*continue/);
    expect(emit).toMatch(/m\.putArray\("peers", rows\)/);
    // iOS: the callable rows are built from the non-BLE peers only.
    expect(read(SWIFT)).toMatch(/for p in peers\.values where p\.bleSend == nil/);
  });
});

describe('walkie playback yields to the call on both platforms', () => {
  test('both natives expose setCallActive, and iOS declares it to the bridge', () => {
    // Mutation: drop any of the three — the mute silently never engages
    // on that platform and the pod is relayed into every call.
    expect(read(KT)).toMatch(/fun setCallActive\(/);
    expect(read(SWIFT)).toMatch(/@objc\(setCallActive:resolver:rejecter:\)/);
    expect(read(BRIDGE)).toMatch(/RCT_EXTERN_METHOD\(setCallActive:/);
  });

  test('handleFrame drops playback while the call holds — before BOTH write arms', () => {
    // Mutation: guard only the PCM arm — rung-3 ADPCM voice keeps
    // playing out of the loudspeaker into the call's open mic. The one
    // gate sits after seq bookkeeping (clean resume at hang-up) and
    // before either codec's track write.
    const kt = read(KT);
    const afterSeq = kt.slice(kt.indexOf('lastSeq[from] = sq'));
    const gate = afterSeq.indexOf('if (callActive || talking)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(afterSeq.indexOf('Adpcm.decode'));
    // The track fetch is hoisted above both codec arms now (the lateness
    // guard reads its playback head), so the playback path begins there.
    // Existence first: -1 is before everything.
    const write = afterSeq.indexOf('t.write(');
    expect(write).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(write);
    const swift = read(SWIFT);
    const sAfterSeq = swift.slice(swift.indexOf('lastSeq[from] = sq'));
    const sGate = sAfterSeq.indexOf('if playbackMuted()');
    expect(sGate).toBeGreaterThan(-1);
    expect(sGate).toBeLessThan(sAfterSeq.indexOf('scheduleBuffer'));
  });

  test('the half-duplex half of the gate is on BOTH platforms, not just Android', () => {
    // Mutation: revert iOS to `if callActive` — an iPhone keying next to
    // any podmate howls exactly the way the Pixels did before 2026-08-25,
    // and the field fix that closed it ships to one platform of two. The
    // Swift side says it through playbackMuted(); the predicate itself is
    // what must contain both flags.
    expect(read(KT)).toMatch(/if \(callActive \|\| talking\)/);
    const swift = read(SWIFT);
    const muted = swift.slice(swift.indexOf('private func playbackMuted()'));
    expect(muted.slice(0, 200)).toMatch(/callActive \|\| talking/);
  });

  test('the iOS gate reads its flags under a lock, not across threads raw', () => {
    // handleFrame runs on the NWConnection's queue for the LAN rung and on
    // main for the Aware rung, and `talking` is written on main by
    // startTalking and OFF main by stopTalking. Mutation: read the stored
    // properties directly (the pre-2026-08-25 shape, whose comment claimed
    // "main-thread only" while the LAN receive path disproved it) — a torn
    // read re-opens the howl for exactly as long as it lasts, and Swift
    // gives no guarantee at all about what a racing Bool read returns.
    const swift = read(SWIFT);
    expect(swift).toMatch(/private let flagsLock = NSLock\(\)/);
    // Every touch of either flag goes through the lock. Each accessor is
    // read to ITS OWN closing brace: a fixed-width window bled into the
    // next accessor, so unlocking one of them still found a neighbour's
    // flagsLock.lock() and the mutation survived.
    for (const fn of [
      'private func playbackMuted()',
      'private func isTalking()',
      'private func setTalking(',
      'private func setCallActiveFlag(',
    ]) {
      const at = swift.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const rest = swift.slice(at);
      const body = rest.slice(0, rest.indexOf('\n  }'));
      expect(body).toContain('flagsLock.lock()');
      expect(body).toContain('flagsLock.unlock()');
    }
    // stopTalking is the off-main writer that made this necessary.
    const stop = swift.slice(swift.indexOf('func stopTalking'));
    expect(stop.slice(0, 700)).toContain('setTalking(false)');
  });

  test('the JS seam drives the mute from the suppression state', () => {
    // Mutation: never call it — the native flag exists with no caller,
    // the exact capability-with-no-caller class this repo guards.
    //
    // The CALLER MOVED (lane ring-anywhere, 2026-08-25) and the pin moved
    // with it: walkie playback now plays with the stage closed, so the echo
    // path (call loudspeaker into the walkie's open mic) exists whether or
    // not WalkiePanel is mounted. Driving the mute from the panel would
    // have left every call answered from the camp board echoing. It is
    // driven from the session's call-snapshot handler instead.
    expect(read(TS)).toMatch(/setCallActive/);
    expect(read('src/crews/walkieSession.ts')).toMatch(
      /setWalkieCallMuted\(walkiePttSuppressed\(snap\.model\.phase\)\)/,
    );
  });
});

/**
 * THE HEDGE, IN THE TWO LANGUAGES THAT ACTUALLY CARRY IT
 * (docs/VIDEO-CALLS.md §2a). The JS half is behaviour-tested in
 * callSignal.test.ts; Kotlin and Swift have no runner here (fab and EAS are
 * their compilers), so these read the real sources and each names its
 * mutation.
 */
describe('a signal may take the two best proven roads, and never a third', () => {
  test('both natives take a bounded N of the ranked rows, not just the head', () => {
    // Mutation: go back to minByOrNull / .min(by:) and ignore the fanout —
    // the JS side asks for breadth, the natives silently deliver one road,
    // and every retransmit lands on the same dead row again. The failure is
    // invisible: the send still resolves.
    const kt = read(KT);
    const send = kt.slice(kt.indexOf('fun sendSignal('));
    expect(send).toMatch(/fun sendSignal\(toHashD: Double, payloadB64: String, fanoutD: Double, promise: Promise\)/);
    expect(send).toMatch(/\.take\(breadth\)/);
    expect(send).toMatch(/for \(p in live\) \{/);
    const swift = read(SWIFT);
    const sSend = swift.slice(swift.indexOf('func sendSignal('));
    expect(sSend).toMatch(/fanout fanoutD: NSNumber/);
    expect(sSend).toMatch(/if chosen\.count >= breadth \{/);
    expect(sSend).toMatch(/for row in chosen \{/);
    // ...and the iOS bridge declares the new arity, or iPhones lose calls
    // entirely (the classic bridge checks argument counts).
    expect(read(BRIDGE)).toMatch(
      /RCT_EXTERN_METHOD\(sendSignal:\(nonnull NSNumber \*\)toHash\s*\n\s*payload:\(NSString \*\)payload\s*\n\s*fanout:\(nonnull NSNumber \*\)fanout/,
    );
    // The JS seam passes it through; a wrapper that dropped the argument
    // would leave the whole mechanism inert with every test still green.
    expect(read(TS)).toMatch(/native\.sendSignal\(toHash, payloadB64, fanout\)/);
  });

  test('MUTATION fanout-unbounded: the ceiling is enforced in the NATIVES', () => {
    // Mutation: trust the caller's number — a JS bug (or a future caller
    // that means "all of them") sprays a call's control channel over every
    // row a podmate has, including the ones the ladder ranked last. A cap
    // that lives only on one side of a bridge is a cap only while that side
    // is right, which is the same argument MAX_PEERS was decided by.
    const kt = read(KT);
    expect(kt).toMatch(/const val MAX_SIGNAL_FANOUT = 2/);
    expect(kt.slice(kt.indexOf('fun sendSignal('))).toMatch(
      /fanoutD\.toInt\(\)\.coerceIn\(1, MAX_SIGNAL_FANOUT\)/,
    );
    const swift = read(SWIFT);
    expect(swift).toMatch(/private static let maxSignalFanout = 2/);
    expect(swift.slice(swift.indexOf('func sendSignal('))).toMatch(
      /max\(1, min\(fanoutD\.intValue, Self\.maxSignalFanout\)\)/,
    );
  });

  test('the hedge is PROVEN rows only — a stale row is never the second road', () => {
    // Mutation: take the best N of ALL datagram rows instead of the proven
    // ones — the hedge would hand the dead row a copy of every message,
    // which is the bug wearing the fix's clothes. The `stale` reject must
    // still be what happens when NOTHING is proven.
    const kt = read(KT);
    const send = kt.slice(kt.indexOf('fun sendSignal('));
    expect(send).toMatch(/\.filter \{ proven\(it, now\) \}/);
    expect(send).toMatch(/if \(live\.isEmpty\(\)\) \{/);
    expect(send).toContain('promise.reject("stale"');
    const swift = read(SWIFT);
    const sSend = swift.slice(swift.indexOf('func sendSignal('));
    expect(sSend).toMatch(/for row in rows where proven\(row\.value, now\)/);
    expect(sSend).toMatch(/guard !chosen\.isEmpty else \{/);
    expect(sSend).toContain('reject("stale"');
  });

  test('one bad road does not cost the other its copy', () => {
    // Mutation: keep the single try/catch around the whole send — the first
    // row throwing (a downed interface DOES sometimes throw) skips the
    // second row entirely, so the hedge evaporates in exactly the case it
    // was built for. Only ALL roads failing is a failed send.
    const kt = read(KT);
    const send = kt.slice(kt.indexOf('fun sendSignal('));
    expect(send).toMatch(/if \(sent > 0\) \{\s*\n\s*promise\.resolve\(null\)/);
    const swift = read(SWIFT);
    const sSend = swift.slice(swift.indexOf('func sendSignal('));
    expect(sSend).toMatch(/guard let c = peer\.connection else \{ continue \}/);
    expect(sSend).toMatch(/guard sent > 0 else \{/);
  });

  test('MUTATION voice-path-untouched: walkie PCM never fans out', () => {
    // THE BOUND THAT MATTERS MOST. Signaling is a few dozen ≤606-byte
    // control messages per call; live voice is 50 unicast frames a second
    // PER PEER, and MAX_PEERS exists because that arithmetic is already at
    // the edge. Mutation: reuse the ranked-rows helper on the audio thread
    // "for symmetry" — the hot path's packet rate doubles for a codec that
    // already tolerates loss, and the walkie's own cap stops meaning what
    // it says.
    const kt = read(KT);
    const talk = kt.slice(
      kt.indexOf('fun startTalking(promise: Promise)'),
      kt.indexOf('fun stopTalking(promise: Promise)'),
    );
    expect(talk).toContain('for (p in targets) {'); // still one row per person
    expect(talk).not.toMatch(/fanout|MAX_SIGNAL_FANOUT|breadth/i);
    const swift = read(SWIFT);
    const frames = swift.slice(
      swift.indexOf('private func sendFrames('),
      swift.indexOf('private func be32('),
    );
    expect(frames).toContain('currentTargets()');
    expect(frames).not.toMatch(/fanout|maxSignalFanout|breadth/i);
  });

  test('the runtime feeds a stale reject back as a MISS, not as a death', () => {
    // Mutation: swallow the rejection like every other one — the signaler
    // never learns the best row is dead, so it keeps sending first tries
    // down it and the whole lane is inert. Mutation 2: dispatch
    // signal-dead from here — the call ends inside the ~12 s demotion
    // window it exists to survive.
    const rt = read('src/crews/callRuntime.ts');
    expect(rt).toMatch(/\(b64, fanout\) => \{/);
    expect(rt).toMatch(/sendWalkieSignal\(hash, b64, fanout\)/);
    expect(rt).toMatch(
      /if \(code === 'stale'\) \{\s*\n\s*this\.signalers\.get\(hash\)\?\.noteSendMiss\(\);/,
    );
    // The catch handler reports a miss and nothing else — no teardown.
    // CODE ONLY: the comment inside it explains signal-dead at length, and
    // a match over prose would have passed for the wrong reason (it did,
    // on the first run of this test).
    const catcher = rt.slice(rt.indexOf('.catch((e: unknown)'));
    const code = catcher
      .slice(0, catcher.indexOf('});'))
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).toMatch(/noteSendMiss\(\)/);
    expect(code).not.toMatch(/signal-dead|onDead|dispatch/);
  });

  // The public tree ships without docs/ (manifest law), so the doc pins
  // guard on presence — the private CI is where they bind.
  (fs2.existsSync('docs/VIDEO-CALLS.md') ? test : test.skip)('the contract doc states the rule, its bounds, and its bench', () => {
    // Mutation: ship the behaviour and leave §2 saying retransmission is
    // 8 tries down one road — the next reader closes the hedge as dead
    // weight, or widens it past two because nothing wrote down why two.
    const doc = read('docs/VIDEO-CALLS.md');
    expect(doc).toMatch(/### 2a\. Retransmission diversity/);
    expect(doc).toMatch(/\*\*Fanout ≤ 2\*\*/);
    expect(doc).toMatch(/\*\*First tries are singles\.\*\*/);
    expect(doc).toMatch(/\*\*Voice never hedges\.\*\*/);
    expect(doc).toMatch(/BLE rows stay excluded/);
    expect(doc).toMatch(/10b\. \*\*A call placed INTO the demotion window/);
  });
});

describe('signal death carries its peer and resets that signaler', () => {
  test('the runtime names WHO died and drops their queue', () => {
    // Mutation 1: strip `from` — a stale bye dying toward a phone that
    // left reads as the ACTIVE call's transport failing (the reducer can
    // no longer tell). Mutation 2: drop the reset() — the dead peer's
    // queue keeps flogging and re-fires signal-dead into the next call;
    // reset() also loses its only caller again.
    const rt = read('src/crews/callRuntime.ts');
    expect(rt).toMatch(
      /this\.signalers\.get\(hash\)\?\.reset\(\);\s*\n\s*this\.dispatch\(\{ type: 'signal-dead', from: hash \}\)/,
    );
  });
});

describe('the contract docs name the shipped codec', () => {
  (fs2.existsSync('docs/VIDEO-CALLS.md') ? test : test.skip)('VIDEO-CALLS.md and CHANGELOG.md say 0x6, never "codec 0x5"', () => {
    // Mutation: the renumber landed in three sources and this test but
    // not the docs — 0x5 is the ladder's ADPCM, and rung-3 iOS written
    // from the doc would feed voice frames to the signal layer.
    const doc = read('docs/VIDEO-CALLS.md');
    expect(doc).toMatch(/codec `0x6`/);
    expect(doc).toMatch(/`CODEC_CALL`/);
    expect(doc).not.toMatch(/codec `0x5`/);
    expect(doc).not.toMatch(/know `0x5`/);
    expect(read('CHANGELOG.md')).toMatch(/codec 0x6/);
    expect(read('CHANGELOG.md')).not.toMatch(/codec 0x5/);
  });
});

describe('the call’s host-side wiring is declared where it must be', () => {
  test('the Android manifest carries webrtc’s two install-time grants', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/android\.permission\.ACCESS_NETWORK_STATE/);
    expect(manifest).toMatch(/android\.permission\.MODIFY_AUDIO_SETTINGS/);
  });

  test('the iOS camera string now covers calls, not only art photos', () => {
    // Apple rejects (and users distrust) a camera ask whose stated purpose
    // does not cover the feature using it.
    expect(read('ios/PlayaPal/Info.plist')).toMatch(
      /NSCameraUsageDescription<\/key>\s*<string>[^<]*video call/,
    );
  });

  test('react-native-webrtc is a real, locked dependency', () => {
    // Mutation: hand-edit package.json without the lockfile — npm ci
    // fails on the build host, which is the only place this compiles.
    expect(read('package.json')).toMatch(/"react-native-webrtc"/);
    expect(read('package-lock.json')).toMatch(
      /node_modules\/react-native-webrtc/,
    );
  });

  test('the peer connection is offline by construction: no ICE servers', () => {
    // THE LAW. Mutation: someone "helpfully" adds a STUN server — the call
    // stack now wants the internet in a place that has none, and leaks
    // call metadata when it briefly does.
    expect(read('src/crews/callRuntime.ts')).toMatch(/iceServers:\s*\[\]/);
  });

  test('the panel actually suppresses PTT and gates the call rows', () => {
    // Mutation: render the machine's state but never wire the guard — the
    // suppression predicate passes its own tests while the button still
    // opens a second recorder.
    const panel = read('src/crews/WalkiePanel.tsx');
    expect(panel).toMatch(/disabled=\{pttSuppressed\}/);
    expect(panel).toMatch(/ON A CALL/);
    expect(panel).toMatch(/model\.phase === 'idle'/); // call rows only when idle
  });

  test('the roster feeds peer-loss detection from the SESSION, not the stage', () => {
    // Same contract, moved with the runtime (lane ring-anywhere): a call
    // answered from the camp board has no panel subscribed to WalkiePeers,
    // so leaving notePeers on the panel meant a podmate who walked away
    // during that call never tore it down — the frozen tile this exists to
    // prevent. Mutation: put notePeers back on the panel.
    expect(read('src/crews/walkieSession.ts')).toMatch(
      /runtime\?\.notePeers\(new Set\(peerRows\.map\(r => r\.hash\)\)\)/,
    );
  });

  test('the ring surface is mounted by the app shell, not by a tab', () => {
    // A feature nobody can reach is not shipped, and this one is only
    // reachable because App.tsx mounts the deck at all. Mutation: delete
    // the <WalkieDeck mount — every arc in walkieRingAnywhere stays green
    // (they drive the session directly) while the shipped app never rings.
    //
    // WHAT THIS PIN DOES NOT PROVE: that the mount sits outside the tab
    // branches. That is a rendering claim and it is proved by rendering —
    // walkieRingAnywhere mounts the deck with no WalkiePanel anywhere in
    // the tree and no stage open.
    expect(read('App.tsx')).toMatch(/<WalkieDeck\b/);
    expect(read('src/crews/WalkieDeck.tsx')).toMatch(/VideoCallPanel/);
  });
});


test('the deck wires the mic toggle to the runtime (a control with no caller is a lie)', () => {
  // Mutation: unwire onToggleMic from WalkieDeck — the button renders and does nothing.
  const deck = read('src/crews/WalkieDeck.tsx');
  expect(deck).toMatch(/onToggleMic=\{\(\) => walkieCallRuntime\(\)\?\.toggleMic\(\)\}/);
  const panel = read('src/crews/VideoCallPanel.tsx');
  // The control is a glyph now, so its ACCESSIBILITY LABEL is the contract
  // — and the label names the verb the press performs, never the state it
  // is in ("Mute microphone" mutes; "Unmute microphone" unmutes).
  expect(panel).toMatch(
    /label=\{m\.micMuted \? 'Unmute microphone' : 'Mute microphone'\}/
  );
});


test('call audio rides the LOUDSPEAKER on both platforms (field: whisper-quiet calls)', () => {
  // Mutation: drop either route — the call goes back to the earpiece and
  // a video call becomes a hearing test at a foot of distance.
  const kt = read(KT);
  expect(kt).toMatch(/isSpeakerphoneOn = true/);
  expect(kt).toMatch(/MODE_IN_COMMUNICATION/);
  expect(kt).toMatch(/isSpeakerphoneOn = false/);
  const swift = read(SWIFT);
  expect(swift).toMatch(/overrideOutputAudioPort\(active \? \.speaker : \.none\)/);
});
