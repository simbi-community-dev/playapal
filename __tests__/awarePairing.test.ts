/**
 * THE PAIRING CEREMONY — rung 4's door (docs/WALKIE-LADDER.md §9a).
 *
 * WHAT THIS LANE CHANGED, AND WHY IT NEEDS PINS AT ALL. The iOS Wi-Fi Aware
 * rung was fully written, compiled into the build, entitled, and logging —
 * and structurally guaranteed to contribute ZERO peers, because both halves
 * scope to `.allPairedDevices` and the app shipped no pairing surface. Two
 * iPhones side by side got nothing. The surface now exists, and three
 * separate things have to stay true for it to mean anything:
 *
 *   - THE CEREMONY HAS TWO ROLES. One phone advertises
 *     (`DevicePairingView`), the other browses (`DevicePicker`), and their
 *     `connecting(to:from:)` arguments are MIRRORED. Both controls on one
 *     sheet, or the argument order swapped, is two phones pairing with
 *     nobody.
 *   - A PAIRING MADE LATER MUST REACH THE RUNNING RUNG. Apple does not
 *     activate a listener whose device set is empty, so a walkie opened
 *     before anyone paired has two DEAD halves, and pairing afterwards
 *     cannot revive them on its own. The `allDevices` watcher is that
 *     revival, and without it this whole lane ships a door onto nothing.
 *   - THE ROW MUST BE GATED AND HONEST. It is iOS-26-only, it is unproven
 *     on device, and it says nothing about Android — which cannot use this
 *     at all.
 *
 * Swift cannot be unit-run here, so the native pins read the real sources in
 * the micProbe/walkieLadder idiom: each assertion names the mutation it dies
 * on. The JS seam is behaviour-tested directly.
 */
import { NativeModules, Platform } from 'react-native';

const read = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const PAIRING = 'ios/PlayaPal/WifiAwarePairing.swift';
const BRIDGE = 'ios/PlayaPal/WifiAwarePairingBridge.m';
const AWARE = 'ios/PlayaPal/WifiAware.swift';
const PBX = 'ios/PlayaPal.xcodeproj/project.pbxproj';
const ROW = 'src/crews/AwarePairRow.tsx';
const PANEL = 'src/crews/WalkiePanel.tsx';
const SEAM = 'src/crews/awarePairing.ts';

type Seam = typeof import('../src/crews/awarePairing');

/** Fresh module per case: the seam reads NativeModules at import time, the
 * way every other native cover in this tree does. */
const loadSeam = (): Seam => {
  let mod: Seam | null = null;
  jest.isolateModules(() => {
    mod = require('../src/crews/awarePairing') as Seam;
  });
  return mod as unknown as Seam;
};

const setOS = (os: string): void => {
  (Platform as unknown as { OS: string }).OS = os;
};

describe('the ceremony carries both of its roles', () => {
  const swift = read(PAIRING);

  test('the advertiser and the browser are BOTH on the sheet', () => {
    // Mutation: delete either control — Apple's own sample says "Tap + on
    // BOTH devices", one advertising and one browsing. A sheet with only
    // DevicePairingView is two phones showing themselves to nobody; a
    // sheet with only DevicePicker is two phones searching for nobody.
    // Neither ever pairs, and neither ever says why.
    expect(swift).toContain('DevicePairingView(');
    expect(swift).toContain('DevicePicker(');
  });

  test('the two controls take MIRRORED connecting(to:from:) arguments', () => {
    // Mutation: give both the same argument order — this is the single
    // easiest thing to get wrong in this API (the publisher takes
    // to: SERVICE, from: DEVICES and the browser takes the swap), it
    // compiles either way on a glance, and it fails as silence.
    expect(swift).toContain(
      '.wifiAware(.connecting(to: publishable, from: .userSpecifiedDevices))',
    );
    expect(swift).toContain(
      '.wifiAware(.connecting(to: .userSpecifiedDevices, from: subscribable))',
    );
  });

  test('the sheet pairs for the SAME service the transport publishes', () => {
    // Mutation: hard-code a service string here — a pairing done against a
    // different service name pairs the devices and leaves the walkie's
    // publisher looking at a set that does not include them. One constant,
    // one place.
    expect(swift).toContain('WAPublishableService.allServices[WalkieAwareLink.serviceName]');
    expect(swift).toContain('WASubscribableService.allServices[WalkieAwareLink.serviceName]');
    expect(swift).not.toMatch(/allServices\["/);
  });

  test('the endpoint the picker hands back is deliberately dropped', () => {
    // Mutation: connect from the picker's callback — a second link minted
    // outside the one class that owns links, with no place in `links`, no
    // intro, no dedup, and no teardown. The browser in WalkieAwareLink
    // picks the peer up on its own once the pair is remembered.
    const at = swift.indexOf('DevicePicker(');
    expect(at).toBeGreaterThan(-1);
    const body = swift.slice(at, swift.indexOf('} label:', at));
    expect(body).not.toContain('NetworkConnection');
    expect(body).toContain('_ = endpoint');
  });

  test('both gates are present: the BUILD fact and the RUN fact', () => {
    // Mutation: drop `canImport(DeviceDiscoveryUI)` and the app fails to
    // build on an SDK without it; drop `#available` and an iPhone below
    // iOS 26 reaches a symbol its OS does not have. Deployment target is
    // 15.1, so both halves of the gate are load-bearing.
    expect(swift).toContain('#if canImport(WiFiAware) && canImport(DeviceDiscoveryUI)');
    expect(swift).toContain('if #available(iOS 26.0, *)');
  });

  test('presenting runs under the ObjC catcher (project law)', () => {
    // Mutation: present outside ObjCTry.run — UIKit RAISES for
    // presentation preconditions (presenting on a controller that is
    // already presenting is the everyday one), and an ObjC raise is
    // UNCATCHABLE by Swift do/catch: it aborts the app, from a user
    // gesture, in the dust. CLAUDE.md's iOS native-exception law.
    const at = swift.indexOf('ObjCTry.run {');
    expect(at).toBeGreaterThan(-1);
    expect(swift.slice(at, swift.indexOf('}', swift.indexOf('present(sheet', at)))).toContain(
      'host.present(sheet, animated: true)',
    );
    expect(swift).toContain('awareLog("pairing-raise "');
  });

  test('the door never rejects — every refusal is a named reason', () => {
    // Mutation: reject on any path — a rejecting door reads to JS as "the
    // door is broken", which sends someone hunting a bug instead of
    // reading a sentence about their phone. Same posture as the probe.
    expect(swift).not.toMatch(/reject\(/);
    for (const reason of [
      '"unsupported"',
      '"no-service"',
      '"no-window"',
      '"os-too-old"',
      '"no-framework"',
      '"error"',
      '"ok"',
    ]) {
      expect(swift).toContain(reason);
    }
  });
});

describe('the pairing arc is readable from syslog alone', () => {
  const swift = read(PAIRING);
  const aware = read(AWARE);

  test('started, paired, dismissed and failed each say their own word', () => {
    // Mutation: drop any one of these — a field bench with no screenshots
    // reads this rung through `aware//` and nothing else, and the four
    // moments of a pairing have four different follow-ups. A ceremony that
    // started and never paired is a different bug from one that was
    // dismissed, and both used to print nothing.
    expect(swift).toContain('awareLog("pairing-started');
    expect(swift).toContain('awareLog("pairing-paired');
    expect(swift).toContain('awareLog("pairing-dismissed")');
    expect(swift).toContain('awareLog("pairing-present presented="');
    expect(swift).toContain('awareLog("pairing-sheet-shown")');
    expect(swift).toContain('awareLog("pairing-watch-failed "');
  });

  test('one prefix, one writer — the pairing file shares awareLog', () => {
    // Mutation: give this file its own log function — two places for the
    // `aware//` prefix to drift, and a field report that only finds half
    // the story with one search string.
    expect(aware).toMatch(/^func awareLog\(_ line: String\) \{$/m);
    expect(aware).not.toMatch(/^private func awareLog/m);
    expect(swift).not.toContain('func awareLog');
    expect(swift).toContain('awareLog(');
  });

  test('the paired-device COUNT is logged — it is what makes browse-empty readable', () => {
    // Mutation: drop the count — `browse-empty` collapses back into one
    // word for two entirely different states: "nobody has ever paired on
    // this phone" and "a paired podmate is out of range". The first is a
    // missing gesture, the second is physics.
    expect(aware).toContain('awareLog(\n      "paired-devices n="');
    expect(aware).toContain('paired-none');
    expect(aware).not.toContain('this app has no pairing UI');
  });
});

describe('a pairing made later reaches a walkie already running', () => {
  const aware = read(AWARE);

  test('the paired set is watched for the whole life of the rung', () => {
    // Mutation: delete the watcher — Apple does not activate a listener
    // whose device set is empty ("The NetworkListener isn't activated if
    // the system doesn't specify any devices"), so a walkie opened before
    // anyone paired has two DEAD halves. Pairing afterwards changes
    // nothing: neither the listener nor the browser can observe a pairing.
    // This watcher is the only thing that can, and without it the whole
    // lane ships a door onto nothing.
    expect(aware).toContain('private func runPairedWatch() async');
    expect(aware).toContain('for try await updated in WAPairedDevice.allDevices');
    expect(aware).toMatch(/pairedTask = Task \{ \[weak self\] in await self\?\.runPairedWatch\(\) \}/);
  });

  test('an ADDED device re-arms both halves; a removed one does not', () => {
    // Mutation: re-arm on any change — a normal unpair then tears down a
    // publisher that was working. Only an addition can unblock a half that
    // refused to start.
    const at = aware.indexOf('private func pairedChanged(');
    expect(at).toBeGreaterThan(-1);
    const body = aware.slice(at, aware.indexOf('private func rearm(', at));
    expect(body).toContain('let added = devices.subtracting(pairedDevices)');
    expect(body).toContain('guard !added.isEmpty else { return }');
    expect(body).toContain('rearm("a device was paired")');
  });

  test('the sequence’s FIRST emission seeds and never re-arms', () => {
    // Mutation: drop the seed guard — `allDevices` opens by reporting the
    // set as it already stands, which looks exactly like an arrival. Every
    // walkie start would then cancel and restart the publisher and browser
    // it had just launched, for no reason, on every phone.
    const at = aware.indexOf('private func pairedChanged(');
    const body = aware.slice(at, aware.indexOf('private func rearm(', at));
    expect(body).toContain('guard pairedSeeded else {');
    expect(body.indexOf('guard pairedSeeded else {')).toBeLessThan(
      body.indexOf('guard !added.isEmpty else { return }'),
    );
  });

  test('the re-arm restarts the halves and keeps established links alive', () => {
    // Mutation: tear down `links`/`canonical`/`dialed` in rearm — a
    // NetworkConnection outlives the listener that accepted it, so a
    // podmate mid-sentence would be cut off by someone ELSE pairing their
    // phone. And clearing `dialed` would re-dial devices this phone
    // already holds a link to.
    const at = aware.indexOf('private func rearm(');
    expect(at).toBeGreaterThan(-1);
    const body = aware.slice(at, aware.indexOf('\n  }', aware.indexOf('subscribeTask = Task', at)));
    expect(body).toContain('publishTask?.cancel()');
    expect(body).toContain('subscribeTask?.cancel()');
    expect(body).toContain('await self?.runPublisher()');
    expect(body).toContain('await self?.runSubscriber()');
    expect(body).not.toContain('links.removeAll');
    expect(body).not.toContain('dialed.removeAll');
  });

  test('stop() takes the watcher down with everything else', () => {
    // Mutation: leave pairedTask running — a stopped walkie keeps a live
    // async sequence, and the next pairing re-arms a rung nobody asked for.
    const at = read(AWARE).indexOf('func stop() {');
    const body = read(AWARE).slice(at, read(AWARE).indexOf('// ---', at));
    expect(body).toContain('self.pairedTask?.cancel()');
    expect(body).toContain('self.pairedSeeded = false');
  });
});

describe('stopping the rung is not the rung failing', () => {
  const aware = read(AWARE);

  /** One runner's body, up to the next declaration. */
  const runner = (from: string, to: string): string => {
    const at = aware.indexOf(from);
    expect(at).toBeGreaterThan(-1);
    const end = aware.indexOf(to, at);
    expect(end).toBeGreaterThan(at);
    return aware.slice(at, end);
  };

  test('cancellation has its own word, and it knows both tells', () => {
    // Mutation: delete the helper (or check only CancellationError) — every
    // long-running half of this rung is stopped the only way Apple provides,
    // by cancelling its Task, so "the walkie went off" and "a camper paired
    // a phone" both arrive as a thrown error in the same catch as a real
    // fault. A cancelled await may throw Swift's CancellationError OR the
    // framework's own cancelled error; one tell catches half of them.
    expect(aware).toContain('private func awareStopped(');
    expect(aware).toContain('Task.isCancelled || (error.map { $0 is CancellationError } ?? false)');
    expect(aware).toMatch(/awareLog\(half \+ "-stopped/);
  });

  for (const half of [
    { fn: 'private func runPublisher() async {', end: 'private func runSubscriber()', name: 'publisher', failed: 'publish-failed', ended: 'publish-ended' },
    { fn: 'private func runSubscriber() async {', end: 'private func dial(', name: 'subscriber', failed: 'subscribe-failed', ended: 'subscribe-ended' },
    { fn: 'private func runPairedWatch() async {', end: 'private func pairedChanged(', name: 'paired-watch', failed: 'paired-watch-failed', ended: 'paired-watch-ended' },
  ]) {
    test(`a cancelled ${half.name} says stopped, never ${half.failed}`, () => {
      // Mutation: collapse the branch into the failure arm — `rearm()`
      // cancels this half EVERY time a device is paired, by design, so the
      // happy path prints the rung's failure sentence at the exact moment
      // someone is watching the log to see whether their pairing worked.
      // False field failures come straight back.
      const body = runner(half.fn, half.end);
      const caught = body.indexOf(`if awareStopped("${half.name}", error) { return }`);
      expect(caught).toBeGreaterThan(-1);
      expect(caught).toBeLessThan(body.indexOf(half.failed));
      // And the half that RETURNS after a cancel rather than throwing does
      // not get to claim "the rung contributes no peers" either.
      const calm = body.indexOf(`if awareStopped("${half.name}") { return }`);
      expect(calm).toBeGreaterThan(-1);
      expect(calm).toBeLessThan(body.indexOf(half.ended));
    });
  }

  test('every intro attempt is send -> wait -> check, the last one included', () => {
    // Mutation: put the send after the check again — the loop then fires its
    // FINAL datagram and reaches the verdict in the same breath, with no
    // second for the answer to arrive. A reply is a round trip away by
    // definition, so `intro-unanswered` was being printed about links whose
    // peer was mid-sentence.
    const loop = runner('link.sendTask = Task {', 'link.receiveTask = Task {');
    const send = loop.indexOf('await self.sendIntro(over: connection)');
    const wait = loop.indexOf('Task.sleep(nanoseconds:');
    const check = loop.indexOf('link.hash != nil');
    // The CALL, not the prose: the comment above the loop names the log line
    // it exists to stop printing early.
    const verdict = loop.indexOf('awareLog("intro-unanswered');
    expect(send).toBeGreaterThan(-1);
    expect(send).toBeLessThan(wait);
    expect(wait).toBeLessThan(check);
    expect(check).toBeLessThan(verdict);
    // The bound is a break taken AFTER a check, not a loop condition that
    // ends the attempt before one.
    expect(loop).not.toContain('while tries < 5');
    expect(loop.indexOf('if tries >= 5')).toBeGreaterThan(check);
  });

  test('a send that never left the phone says so on its own line', () => {
    // Mutation: restore `try?` — a link whose every send throws and a link
    // whose peer never answers both end at `intro-unanswered`, and those
    // have OPPOSITE fixes: one is our socket, the other is theirs.
    const send = runner('private func sendIntro(', 'private func runPublisher()');
    expect(send).toContain('try await connection.send(intro())');
    expect(send).toContain('awareLog("intro-send-failed "');
    expect(send).not.toContain('try?');
    // Cancelling mid-retry is the walkie going off, not a failed send.
    expect(send).toContain('if awareStopped("intro-send", error) { return }');
    const loop = runner('link.sendTask = Task {', 'link.receiveTask = Task {');
    expect(loop).not.toMatch(/try\? await connection\.send\(self\.intro\(\)\)/);
  });
});

describe('the row is gated, reachable, and honest', () => {
  const row = read(ROW);

  test('the row is gated on the SHIPPED probe, not a second opinion', () => {
    // Mutation: gate on Platform.OS alone, or invent a new probe — an
    // iPhone below iOS 26 or without the radio has a PERMANENT no, and a
    // row that opens onto "your phone cannot" is a row that should not
    // have been drawn. `describeWifiAware` is the one native answer.
    expect(row).toContain("import { describeWifiAware } from './wifiAware'");
    expect(row).toContain("r.reason === 'ok'");
    expect(row).toContain('awarePairingPresent()');
    expect(row).toMatch(/if \(ok !== true\) \{\s*\n\s*return null;/);
  });

  test('the entry point is reachable — the row calls the native door', () => {
    // Mutation: unwire onPress — the whole lane becomes a paragraph.
    expect(row).toContain('presentAwarePairing()');
    expect(row).toMatch(/onPress=\{open\}/);
    expect(row).toContain('accessibilityRole="button"');
  });

  test('a refusal names its cause instead of saying "error"', () => {
    // Mutation: Alert the raw reason — 'no-window' means try again,
    // 'os-too-old' means never, and a camper can act on one of them.
    expect(row).toContain('awarePairFailureCopy(r.reason)');
  });

  test('the row is mounted in the walkie stage', () => {
    // Mutation: mount it in Settings instead — the row exists to make the
    // WALKIE reach further, and the camper who needs it is looking at
    // "Nobody else on the channel yet", not at a settings list.
    const panel = read(PANEL);
    expect(panel).toContain("import { AwarePairRow } from './AwarePairRow'");
    expect(panel).toContain('<AwarePairRow />');
    // Below the live controls: a setup gesture must never sit above
    // hold-to-talk.
    expect(panel.indexOf('<AwarePairRow />')).toBeGreaterThan(panel.indexOf('HOLD TO TALK'));
  });

  test('the copy offers and does not promise, and never implies Android', () => {
    // Mutation: drop "field-tested", or write a cross-platform sentence —
    // this has never run between two iPhones in the field, and an iPhone
    // and an Android phone cannot complete a Wi-Fi Aware datapath at all
    // (§9a: two open Apple radars, roughly a year old). Either edit is the
    // app's first overclaim.
    const seam = loadSeam();
    expect(seam.AWARE_PAIR_TITLE).toBe('Link iPhones directly');
    expect(seam.AWARE_PAIR_LINE).toContain('field-tested');
    expect(seam.AWARE_PAIR_LINE).toContain('no Wi-Fi at all');
    expect(seam.AWARE_PAIR_INFO).toContain('iPhone-to-iPhone only');
    expect(seam.AWARE_PAIR_INFO).toContain('cannot use it at all');
    // The InfoTap paragraph carries the way OUT as well as the way in:
    // Apple exposes no unpair API, so Settings is the only door and the
    // app has to say where it is.
    expect(seam.AWARE_PAIR_INFO).toContain('Paired Devices');
    for (const copy of [seam.AWARE_PAIR_TITLE, seam.AWARE_PAIR_LINE, seam.AWARE_PAIR_INFO]) {
      expect(copy).not.toMatch(/Wi-Fi Aware|NAN|pairing ceremony|datapath/);
    }
  });
});

describe('the seam answers instead of throwing', () => {
  const original = Platform.OS;
  afterEach(() => {
    delete (NativeModules as unknown as Record<string, unknown>).WifiAwarePairing;
    setOS(original);
  });

  test('no native module: absent, and the row never draws', async () => {
    // Mutation: throw on a missing module — jest, Android and every build
    // predating the native pair take this path, and it is not an error.
    const seam = loadSeam();
    expect(seam.awarePairingPresent()).toBe(false);
    await expect(seam.presentAwarePairing()).resolves.toEqual({
      presented: false,
      reason: 'absent',
    });
  });

  test('Android never opens the door even if a module answers to the name', () => {
    // Mutation: drop the Platform check — Android's Aware rung admits
    // peers with a pod-derived key and has no ceremony; offering one would
    // be a button onto a concept that does not exist on that phone.
    (NativeModules as unknown as Record<string, unknown>).WifiAwarePairing = {
      present: async () => ({ presented: true, reason: 'ok' }),
    };
    setOS('android');
    expect(loadSeam().awarePairingPresent()).toBe(false);
  });

  test('a native answer passes through with its reason', async () => {
    const answers = [
      { in: { presented: true, reason: 'ok' }, out: { presented: true, reason: 'ok' } },
      {
        in: { presented: false, reason: 'no-service' },
        out: { presented: false, reason: 'no-service' },
      },
      // Mutation: trust the native string — an unknown reason must NOT
      // leak into copy that switches on it, or a future native adds a word
      // and the app renders nothing for it.
      { in: { presented: false, reason: 'kablooie' }, out: { presented: false, reason: 'error' } },
      { in: null, out: { presented: false, reason: 'error' } },
    ];
    for (const a of answers) {
      (NativeModules as unknown as Record<string, unknown>).WifiAwarePairing = {
        present: async () => a.in,
      };
      setOS('ios');
      await expect(loadSeam().presentAwarePairing()).resolves.toEqual(a.out);
    }
  });

  test('a throwing bridge becomes a reason, never a rejection', async () => {
    // Mutation: let it propagate — the row's .then never runs, no alert
    // ever shows, and the tap is silent. Silence is the one outcome this
    // whole lane exists to end.
    (NativeModules as unknown as Record<string, unknown>).WifiAwarePairing = {
      present: async () => {
        throw new Error('bridge is gone');
      },
    };
    setOS('ios');
    await expect(loadSeam().presentAwarePairing()).resolves.toEqual({
      presented: false,
      reason: 'error',
    });
  });

  test('every reason the native can send has copy, and none of it says "error occurred"', () => {
    setOS('ios');
    const seam = loadSeam();
    const reasons = read(SEAM)
      .slice(read(SEAM).indexOf('const REASONS'), read(SEAM).indexOf('function isReason'))
      .match(/'([a-z-]+)'/g);
    expect(reasons).not.toBeNull();
    for (const quoted of reasons as string[]) {
      const reason = quoted.slice(1, -1) as Parameters<typeof seam.awarePairFailureCopy>[0];
      const copy = seam.awarePairFailureCopy(reason);
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).not.toMatch(/error|failed|Wi-Fi Aware/i);
    }
  });
});

describe('the build carries the new pair, and the project file is sane', () => {
  test('bridge selector + four pbxproj entries per file', () => {
    // Mutation: drop a pbxproj row — EAS builds GREEN and the module is
    // silently absent, which reads to JS as an older native. This project
    // has been burned by exactly that before.
    const bridge = read(BRIDGE);
    expect(bridge).toMatch(/RCT_EXTERN_MODULE\(WifiAwarePairing, NSObject\)/);
    expect(bridge).toMatch(/RCT_EXTERN_METHOD\(present:\(RCTPromiseResolveBlock\)resolve/);
    const pbx = read(PBX);
    for (const file of ['WifiAwarePairing.swift', 'WifiAwarePairingBridge.m']) {
      expect(pbx).toContain(file + ' in Sources */ = {isa = PBXBuildFile');
      expect(pbx).toContain(file + ' */ = {isa = PBXFileReference');
      expect(pbx).toContain(file + ' in Sources */,');
      // The group child row — four entries, the MicProbe shape exactly.
      expect((pbx.match(new RegExp('/\\* ' + file.replace('.', '\\.') + ' \\*/', 'g')) ?? []).length)
        .toBeGreaterThanOrEqual(3);
    }
  });

  test('no two pbxproj objects share an id', () => {
    // Mutation: reuse an id (this is not hypothetical — WalkieBleVoice.swift
    // and AdpcmCodec.swift shipped sharing PocketAlerts' four ids, so one
    // of those two module pairs was silently dropped from every build).
    // A pbxproj is a plist: a repeated key means one object, last one wins,
    // and the loser compiles nowhere while the project file still LOOKS
    // like it lists both.
    const ids = [...read(PBX).matchAll(/^\t\t([0-9A-F]{24}) \/\* .+? \*\/ = \{isa = PBX/gm)].map(
      m => m[1],
    );
    const seen = new Set<string>();
    const dupes = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes).toEqual([]);
    expect(ids.length).toBeGreaterThan(20);
  });

  // Guarded like every doc pin (the public tree ships without docs/): the
  // literal lives in BOTH the gate and the read so the manifest scan can
  // SEE the guard — a const-indirected path was exactly the shape that
  // slipped past it and failed the public clone (flip-verify, 2026-08-26).
  (require('fs').existsSync('docs/WALKIE-LADDER.md') ? test : test.skip)('the ladder doc no longer says the rung has no door', () => {
    // Mutation: leave §9a's "no pairing UI" standing — anyone reading it
    // would plan around a gap that is closed, and the doc's own §9a is
    // where this lane's honest state is recorded.
    const ladder = read('docs/WALKIE-LADDER.md');
    expect(ladder).not.toContain('the app ships no pairing\nsurface');
    expect(ladder).toContain('WifiAwarePairing.swift');
    expect(ladder).toMatch(/field-test/i);
  });
});
