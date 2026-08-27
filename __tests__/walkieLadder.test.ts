/**
 * THE CONNECTIVITY LADDER, held to its own law (docs/WALKIE-LADDER.md).
 *
 * Two families of behaviour landed together and each one owes its guards:
 *
 *  - RUNG 4 RELIABILITY. The Aware link connected once and then never
 *    again: a one-shot 'requested' latch, a peer FORGOTTEN on datapath
 *    loss, no recovery when Aware availability bounced, stale PeerHandles
 *    after a session terminated. Every hole was a face of the owner's
 *    "doesn't connect reliably".
 *  - RUNG 3 EXISTS. Live lo-fi voice over BLE GATT (codec 0x5, IMA ADPCM
 *    @ 8 kHz) — the ladder's designed floor, previously implemented
 *    nowhere (old §11 said so out loud).
 *
 * Kotlin cannot be unit-run here, so this suite reads the real sources in
 * the walkieCap.test.ts idiom: each assertion names the mutation it dies
 * on. The JS halves are behaviour-tested directly.
 */
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const KT = 'android/app/src/main/java/com/playapal/WalkieModule.kt';
const AWARE = 'android/app/src/main/java/com/playapal/WalkieAwareLink.kt';
const BLE = 'android/app/src/main/java/com/playapal/WalkieBleLink.kt';
const ADPCM = 'android/app/src/main/java/com/playapal/Adpcm.kt';

import {
  decodeWalkiePeers,
  formatChannelNames,
  walkieDiagnosisCopy,
} from '../src/crews/walkie';

describe('rung 4 recovers instead of giving up', () => {
  const aware = readSource(AWARE);

  test('a datapath request times out into a retry, never into forever-silence', () => {
    // Mutation: revert to the 3-arg requestNetwork — a request that never
    // completes never FAILS either, the 'requested' latch stays latched,
    // and the peer is unreachable until app restart. That latch was the
    // measured shape of "connected once, never again".
    expect(aware).toMatch(
      /cm\.requestNetwork\(request, callback, handler, REQUEST_TIMEOUT_MS\)/,
    );
    const unavail = aware.slice(aware.indexOf('override fun onUnavailable'));
    expect(unavail).toContain('peer.requested = false');
    expect(unavail).toContain('scheduleRetry(peer, peer.backoffMs)');
  });

  test('retry backoff doubles to a cap and resets on a proven datapath', () => {
    // Mutation: drop the reset — one bad minute early on and the peer is
    // punished with 60 s probes for the rest of the night.
    expect(aware).toMatch(/RETRY_BASE_MS = 5_000L/);
    expect(aware).toMatch(/RETRY_CAP_MS = 60_000L/);
    expect(aware).toMatch(/\.coerceAtMost\(RETRY_CAP_MS\)/);
    expect(aware).toMatch(/peer\.backoffMs = RETRY_BASE_MS/);
  });

  test('a lost datapath keeps the peer DISCOVERED and re-probes on the 30 s floor', () => {
    // Mutation: put `discovered.remove(peer.hash)` back into onLost — NAN
    // discovery does not re-introduce a peer it already matched, so one
    // datapath blip meant no walkie to that peer until app restart. The
    // row still LEAVES the channel list immediately (§1/§5: a listed peer
    // you cannot reach is the lie), but the link keeps probing.
    const onLost = aware.slice(aware.indexOf('override fun onLost'));
    const body = onLost.slice(0, onLost.indexOf('override fun onUnavailable'));
    expect(body).not.toMatch(/discovered\.remove/);
    expect(body).toContain('onPeerLost(key)');
    expect(body).toContain('scheduleRetry(peer, RELOST_FLOOR_MS)');
    // §5 rule 5: re-probe no sooner than 30 s — flapping radio, not
    // flapping walkie.
    expect(aware).toMatch(/RELOST_FLOOR_MS = 30_000L/);
  });

  test('aware availability changes re-attach the whole rung', () => {
    // Mutation: drop the receiver — a Wi-Fi/Location toggle mid-walkie
    // kills the rung silently until app restart. Availability is the ONE
    // signal the framework gives for "everything you had is gone".
    expect(aware).toMatch(/ACTION_WIFI_AWARE_STATE_CHANGED/);
    expect(aware).toMatch(/private fun onAwareDown\(\)/);
    // Down empties the rung's channel rows (§5: never claim a dead link)...
    const down = aware.slice(aware.indexOf('private fun onAwareDown'));
    expect(down.slice(0, 1500)).toContain('onPeerLost(keyFor(peer))');
    // ...and up re-attaches.
    expect(aware).toMatch(/if \(awareSession == null\) \{\s*\n\s*attach\(\)/);
  });

  test('a terminated discovery session nulls its handles and re-arms', () => {
    // Mutation: keep the stale handles — measured on two Pixels: a handle
    // used with the wrong (dead) session requests a datapath that
    // silently never forms. Backgrounding is how sessions die.
    expect(aware).toMatch(
      /pubSession = null\s*\n\s*for \(p in discovered\.values\) \{\s*\n\s*p\.publishHandle = null/,
    );
    expect(aware).toMatch(
      /subSession = null\s*\n\s*for \(p in discovered\.values\) \{\s*\n\s*p\.subscribeHandle = null/,
    );
    // Both terminations schedule a re-arm.
    expect(aware.split('SESSION_REARM_MS').length - 1).toBeGreaterThanOrEqual(3);
  });

  test('a discovery-level goodbye forgets an idle peer, never a connected one', () => {
    // Mutation: drop onServiceLost — a peer who closed their walkie keeps
    // being probed forever; or forget an UP peer — their live datapath is
    // orphaned from its bookkeeping.
    const lost = aware.slice(aware.indexOf('override fun onServiceLost'));
    const body = lost.slice(0, lost.indexOf('override fun onSessionTerminated'));
    expect(body).toContain('if (!p.up)');
    expect(body).toContain('discovered.remove(p.hash)');
  });
});

/**
 * THE CROSS-PLATFORM QUESTION, asked on-device (docs/WALKIE-LADDER.md §9a,
 * from the 2026-08-26 sweep in `research-aware-interop.md`).
 *
 * An iPhone and an Android phone do not complete an Aware datapath today —
 * two open Apple radars, roughly a year old, and Apple simply never answers
 * an Android NDP request. The designed bridge is Aware Pairing (NAN v4.0,
 * Android 14+), and it is DEVICE-dependent: confirmed on a Galaxy S25,
 * reported broken on a Pixel 9. Our Pixels have never been asked.
 *
 * Apple's half we cannot move. This half is ours, it costs one log line on
 * a path that has already proven the radio is alive, and it decides whether
 * the pairing work could ever pay off on our hardware at all.
 */
describe('the attach path answers whether these phones could ever pair with an iPhone', () => {
  const aware = readSource(AWARE);

  test('a successful attach logs this phone’s Aware Pairing capability', () => {
    // Mutation: drop the line — the capability question goes dark again and
    // "likely no, inferred from someone's Pixel 9 report" stays inferred
    // forever, on the one path where the answer is free to take.
    const attached = aware.slice(aware.indexOf('override fun onAttached'));
    const body = attached.slice(0, attached.indexOf('override fun onAttachFailed'));
    expect(body).toContain('mgr.characteristics?.isAwarePairingSupported');
    // Same greppable prefix as every other line of this rung, on both
    // platforms — one search string reads a field report from either phone.
    expect(body).toContain('Log.i(TAG, "aware//pairing-supported=$pairing")');
  });

  test('the capability read is API-guarded and says "unknown" rather than guessing', () => {
    // Mutation: drop the SDK_INT guard — isAwarePairingSupported() arrived
    // in API 34, so every phone below it takes a NoSuchMethodError on the
    // attach path the whole rung hangs off. Mutation: drop the ?: — a null
    // Characteristics prints "null", which reads like a measured false.
    const attached = aware.slice(aware.indexOf('override fun onAttached'));
    const body = attached.slice(0, attached.indexOf('override fun onAttachFailed'));
    expect(body).toContain('Build.VERSION.SDK_INT >= 34');
    // A null Characteristics is a question nobody answered, not a false.
    expect(body).toContain('?.toString() ?: "unknown"');
    // And so is a phone below API 34, where the method does not exist.
    expect(body).toMatch(/\} else \{\s*\n\s*"unknown"\s*\n\s*\}/);
  });
});

/**
 * THE LADDER DOC'S §9a HOLDS ITS OWN CLAIMS (docs/WALKIE-LADDER.md).
 *
 * §9a states range brackets, a cross-platform verdict and an admission that
 * the iOS rung is inert. The admission is the load-bearing one: without it
 * the doc reads as if rung 4 works on iPhones, which is what §9 read like
 * for a day and is exactly the shape of bug §9a was written to end.
 */
// The public tree ships without docs/ (manifest law), so this block guards on
// presence like its siblings in walkieLiveness/videoWire do. It did not, and
// because the read sits at DESCRIBE scope rather than inside a test, the whole
// suite failed to RUN on a public clone -- jest reports that in the Suites
// line, not the tests line, and CONTRIBUTING.md makes a green suite the bar
// for a PR. So the one file that forgot the convention was the one that made
// the contributor's gate unmeetable.
const LADDER_DOC = 'docs/WALKIE-LADDER.md';
const HAS_LADDER_DOC = require('fs').existsSync(LADDER_DOC);
(HAS_LADDER_DOC ? describe : describe.skip)('the ladder doc tells the truth about the Aware rung [needs docs/WALKIE-LADDER.md, private tree only]', () => {
  // describe.skip still EVALUATES this callback to collect test names, so the
  // read has to be lazy as well as the block being skipped.
  const doc = HAS_LADDER_DOC ? readSource(LADDER_DOC) : '';
  const awareSrc = readSource(AWARE);
  /** Prose wraps; a sentence pin must not die of a line break. */
  const flat = doc.replace(/\s+/g, ' ');

  test('§9a admits what the rung could not do before the door, in past tense', () => {
    // Mutation: delete the admission — a reader budgets against a rung
    // whose browse set was empty on every phone until the pairing door.
    // (Evolved 2026-08-26: the pairing lane landed §9b and rewrote the
    // state from "structurally inert" to the door-and-its-history truth.)
    expect(doc).toContain('### 9a.');
    expect(flat).toContain('had no door');
    expect(flat).toContain('.allPairedDevices');
    expect(flat).toContain('two iPhones running Playa Pal side by side');
    expect(flat).toContain('browse-empty');
  });

  test('§9b dates the door, and never promises what no device has proven', () => {
    // Mutation: promote "being field-tested" into "works" — the copy would
    // promise a ceremony no device has run; or drop the EAS-VERIFY marks —
    // uncompiled Apple symbols lose their compile-gate breadcrumbs. The
    // cross-platform bridge stays post-BRC and Apple-blocked regardless.
    expect(doc).toContain('### 9b.');
    expect(flat).toContain('Landed 2026-08-26');
    expect(flat).toContain('being field-tested');
    expect(flat).toContain('EAS-VERIFY');
    expect(flat).toMatch(/post-BRC|Post-BRC/);
  });

  test('§9a cites the two reports it is derived from, by filename', () => {
    // Mutation: drop the citations — the brackets and the verdict become
    // assertions with no provenance, which is how INFERRED gets re-read as
    // MEASURED one sprint later.
    expect(doc).toContain('research-aware-interop.md');
    expect(doc).toContain('research-voicechat-zero-buffers.md');
  });

  test('the range is stated in brackets against BLE, never as one number', () => {
    // Mutation: replace with a single figure — nobody publishes a measured
    // phone-to-phone Aware range curve; a bare number would be fiction with
    // a decimal point.
    expect(flat).toContain('~150–250 m');
    expect(flat).toContain('~10–50 m');
    expect(flat).toContain('3–5× BLE');
  });

  test('the service names the doc calls mismatched are still the ones in the sources', () => {
    // Mutation: rename either side — that is a flag day (an old Android
    // build and a new one stop seeing each other) bought for a link Apple
    // does not answer anyway, and it would silently make §9a false.
    expect(awareSrc).toContain('const val SERVICE_NAME = "playapal-walkie"');
    expect(readSource('ios/PlayaPal/WifiAware.swift')).toContain(
      'static let serviceName = "_playapal-walkie._udp"',
    );
    expect(doc).toContain('`playapal-walkie`');
    expect(doc).toContain('`_playapal-walkie._udp`');
  });
});

/**
 * CALL SYMMETRY — the responder half of rung 4 (docs/WALKIE-LADDER.md §4).
 *
 * Field-confirmed twice on two adjacent Pixels: the INITIATOR reached
 * datapath-up in ~600 ms and listed the peer hi-fi with a Call button,
 * while the RESPONDER logged requesting-datapath / datapath-unavailable
 * forever and stayed "(lo-fi)" with no Call button — even though voice
 * flowed BOTH ways, because its pre-bound socket was receiving fine.
 *
 * The roles are not mirror images in the framework and the code had
 * treated them as if they were. These pins hold the three facts that make
 * the responder's shape different, each naming what dies without it.
 */
describe('the responder reaches a callable row, and stops thrashing', () => {
  const aware = readSource(AWARE);
  const kt = readSource(KT);

  test('the responder files ONE any-peer request, not a per-peer one', () => {
    // Mutation: build the responder's specifier from
    // Builder(session, handle) again. The framework then caches that
    // peer's discovery MAC and, on every incoming NDP, requires "the peer
    // MAC address (if specified - i.e. non-null) must match" — and NAN
    // ROTATES that MAC. After the first rotation every arriving datapath
    // request falls through to "can't find a request", the initiator is
    // refused, and this phone waits on a request nothing can ever satisfy.
    // Builder(PublishDiscoverySession) leaves the MAC null, which the same
    // loop documents as "accept ... requests from any peer MAC".
    const ensure = aware.slice(aware.indexOf('private fun ensureResponderRequest'));
    const body = ensure.slice(0, ensure.indexOf('private fun releaseResponderRequest'));
    expect(body).toMatch(/WifiAwareNetworkSpecifier\.Builder\(session\)\s*\n\s*\.setPskPassphrase/);
    // No peer handle anywhere in the responder's specifier.
    expect(body).not.toMatch(/Builder\(session, handle\)/);
    // The port still travels — it is what the framework puts in the NDP
    // response TLV, and it is the only thing the initiator can read.
    expect(body).toContain('.setPort(s.localPort)');
    expect(body).toContain('.setTransportProtocol(17)');
    // API 31 is where the any-peer constructor exists; below it the
    // per-peer responder is all there is, so the gate must be real.
    expect(body).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.S');
  });

  test('a responder request carries NO deadline; the initiator keeps its', () => {
    // Mutation: give the responder the timeout overload. needNetworkFor
    // parks a responder in STATE_RESPONDER_WAIT_FOR_REQUEST and does
    // nothing else — waiting IS the request working — so a 30 s deadline
    // manufactures onUnavailable out of correct behaviour, and the re-file
    // that follows unregisters the callback whose datapath was carrying
    // voice. That loop IS the measured thrash.
    const ensure = aware.slice(aware.indexOf('private fun ensureResponderRequest'));
    const body = ensure.slice(0, ensure.indexOf('private fun releaseResponderRequest'));
    expect(body).toMatch(/cm\.requestNetwork\(request, callback, handler\)/);
    expect(body).not.toContain('REQUEST_TIMEOUT_MS');
    // The pre-S per-peer responder gets the same treatment, by role...
    expect(aware).toMatch(
      /if \(respond\) \{[\s\S]{0,600}?cm\.requestNetwork\(request, callback, handler\)\s*\n\s*\} else \{\s*\n\s*cm\.requestNetwork\(request, callback, handler, REQUEST_TIMEOUT_MS\)/,
    );
  });

  test('a refused responder request is TERMINAL, never re-filed on a ladder', () => {
    // Mutation: call ensureResponderRequest() or scheduleRetry from
    // onUnavailable. A responder has no deadline, so onUnavailable means
    // the framework REFUSED this specifier; an identical re-file earns an
    // identical refusal, forever. Only a fresh publish session or a
    // re-attach can change the answer, and only those clear the flag.
    const refused = aware.slice(aware.indexOf('override fun onUnavailable', aware.indexOf('private fun ensureResponderRequest')));
    const body = refused.slice(0, refused.indexOf('}\n    }'));
    expect(body).toContain('responderRefused = true');
    expect(body).not.toContain('scheduleRetry');
    expect(body).not.toContain('ensureResponderRequest()');
    // Forgiven at exactly the two events that CAN change the answer — a
    // fresh publish session and a re-attach — and nowhere else. (The third
    // match is the declaration's initialiser.)
    expect(aware.match(/responderRefused = false/g) ?? []).toHaveLength(3);
    const started = aware.slice(aware.indexOf('override fun onPublishStarted'));
    expect(started.slice(0, 900)).toContain('responderRefused = false');
    const down = aware.slice(aware.indexOf('private fun onAwareDown'));
    expect(down.slice(0, 900)).toContain('responderRefused = false');
    // And the per-peer (pre-S) responder returns instead of climbing.
    const perPeer = aware.slice(aware.indexOf('aware//datapath-unavailable'));
    expect(perPeer.slice(0, 1200)).toMatch(/if \(respond\) \{[\s\S]*?return/);
  });

  test('the responder learns WHERE to send from the frame, since caps cannot say', () => {
    // The framework parses a peer's port out of the NDP TLV "only relevant
    // for the initiator", so a responder's WifiAwareNetworkInfo reports
    // port 0 forever. Mutation: try to mint the responder's row from
    // capabilities — there is no port there, so the row is either absent
    // or undialable, and the Call button never appears.
    expect(aware).toMatch(/fun noteReturnPath\(/);
    expect(kt).toMatch(/aware\?\.noteReturnPath\(from, pkt\.address, pkt\.port, srcSocket\)/);
    // ONE OWNER. Mutation: mint the row in WalkieModule again. Both sides
    // computed the SAME key from the same discovered name, so the link's
    // peer cleanup deleted a working return path it had never created —
    // the field symptom exactly (voice both ways, no Call button).
    expect(kt).not.toMatch(/peers\["\$key\|\$label"\]/);
    const note = aware.slice(aware.indexOf('fun noteReturnPath'));
    expect(note.slice(0, 2600)).toContain('onPeer(keyFor(peer), host, port, peer.name, socket)');
    // Role, not liveness: the pre-S responder DOES set `up`, so gating on
    // `up` here would block the very row this method exists to mint.
    expect(note.slice(0, 2600)).toContain('senderHash > peer.hash');
  });

  test('the row goes when the responder datapath does (§5: never claim a dead link)', () => {
    // Mutation: leave the rows up. One any-peer agent carries every
    // responder NDP, so its onLost means every peer we were answering is
    // unreachable at once — and a listed peer we cannot reach is the lie
    // §1 exists to prevent.
    const ensure = aware.slice(aware.indexOf('private fun ensureResponderRequest'));
    const onLost = ensure.slice(ensure.indexOf('override fun onLost'));
    expect(onLost.slice(0, 700)).toContain('clearReturnPaths()');
    // A discovery-level goodbye takes its own row too, BEFORE the name the
    // key is built from leaves `discovered`.
    const goodbye = aware.slice(aware.indexOf('override fun onServiceLost'));
    expect(goodbye.slice(0, 1600)).toContain('p.returnPathUp = false');
  });

  test('the any-peer callback is unregistered by stop(), like every other', () => {
    // Mutation: rely on the `callbacks` loop. The responder callback
    // belongs to no single peer so it is not in that map, and a request
    // leaked past stop() counts against the framework's near-100 cap —
    // after which the rung is dead for the life of the process.
    const stop = aware.slice(aware.indexOf('fun stop() {'));
    const body = stop.slice(0, stop.indexOf('for (cb in callbacks.values)'));
    expect(body).toContain('responderCallback?.let');
    expect(body).toContain('cm.unregisterNetworkCallback(it)');
  });

  test('the initiator opens the rung with the probe the ladder always specified', () => {
    // §5 step 3: "The opener sends a PW frame with codec 0x0 (probe,
    // zero-length payload) on the new rung." CODEC_PROBE was declared and
    // had NO CALLER — so the responder's row could not exist until somebody
    // keyed a mic, which is why voice worked and the Call button did not.
    //
    // Mutation 1: drop the send — back to "audible but not dialable".
    const onPeerArm = kt.slice(kt.indexOf('onPeer = { key, host, port, name, sock ->'));
    expect(onPeerArm.slice(0, 1400)).toContain('sendProbe(peer)');
    expect(kt).toMatch(/private fun sendProbe\(peer: Peer\)/);
    const probe = kt.slice(kt.indexOf('private fun sendProbe'));
    expect(probe.slice(0, 1600)).toMatch(
      /buf\[2\] = \(\(FRAME_VERSION shl 4\) or CODEC_PROBE\)\.toByte\(\)/,
    );
    // Zero payload: the frame IS the header.
    expect(probe.slice(0, 1600)).toContain('ByteArray(HEADER)');
    // On the PEER's socket — the LAN socket would put it on the wrong radio.
    expect(probe.slice(0, 1600)).toContain('peer.socket ?: socket');

    // Mutation 2: restore `n <= HEADER` in handleFrame. A zero-payload
    // frame is a whole valid frame; rejecting it made CODEC_PROBE
    // unreachable no matter who sent one.
    expect(kt).toMatch(/if \(n < HEADER \|\| buf\[0\] != 'P'\.code\.toByte\(\)/);
    expect(kt).not.toMatch(/if \(n <= HEADER \|\|/);
  });

  test('the probe cannot reach playback, and terminates in two frames', () => {
    // Mutation: let CODEC_PROBE past the codec gate — a zero-length
    // "sample" run is harmless, but the gate is what stops the NEXT
    // unknown codec becoming noise at whatever volume the pod is holding
    // to its ear. The gate must sit before either write arm.
    const frame = kt.slice(kt.indexOf('private fun handleFrame'));
    const gate = frame.indexOf(
      'if ((head and 0x0F) != CODEC_PCM16_16K && (head and 0x0F) != CODEC_ADPCM8K)',
    );
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(frame.indexOf('Adpcm.decode'));
    // The playback path now begins at the hoisted track fetch — one
    // ensureTrack() above both codec arms, because the lateness guard reads
    // that track's playback head. Existence FIRST for each, same reason as
    // the return-path check below: -1 is before everything.
    const track = frame.indexOf('val t = ensureTrack()');
    expect(track).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(track);
    const write = frame.indexOf('t.write(');
    expect(write).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(write);
    // ...and the return path is registered BEFORE that gate, or a probe
    // would be dropped without ever doing its one job. Existence FIRST:
    // a missing call has index -1, which satisfies any "is before" test —
    // the ordering assertion alone passed the delete-it mutation.
    const reg = frame.indexOf('noteReturnPath');
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(gate);
    // Termination: the link refuses a second row for a peer it initiates
    // to, so the initiator never answers the responder's answer.
    const note = aware.slice(aware.indexOf('fun noteReturnPath'));
    expect(note.slice(0, 2800)).toMatch(/peer\.returnPathUp/);
  });
});

describe('rung 3 exists: live lo-fi voice over BLE GATT', () => {
  const kt = readSource(KT);
  const ble = readSource(BLE);
  const adpcm = readSource(ADPCM);

  test('the rung changes the CODEC and the socket, never the frame (§3)', () => {
    // Mutation: mint a different layout for BLE frames — two protocols,
    // and every guard in walkieCap.test.ts about "one layout" is void.
    expect(kt).toMatch(/const val CODEC_ADPCM8K = 0x5/);
    expect(kt).toMatch(/f\[2\] = \(\(FRAME_VERSION shl 4\) or CODEC_ADPCM8K\)\.toByte\(\)/);
    expect(kt).toMatch(/writeU32\(f, 3, podHash\)/);
    expect(kt).toMatch(/writeU32\(f, 7, senderHash\)/);
  });

  test('the receive path accepts BOTH known codecs and still drops unknowns', () => {
    // Mutation 1: accept anything — a future codec plays as noise.
    // Mutation 2: forget ADPCM — rung 3 peers are listed and SILENT,
    // which is exactly the "negotiated but broken" state §1 calls the
    // worst one.
    expect(kt).toMatch(
      /\(head and 0x0F\) != CODEC_PCM16_16K && \(head and 0x0F\) != CODEC_ADPCM8K/,
    );
    expect(kt).toMatch(/== CODEC_ADPCM8K\)[\s\S]{0,400}Adpcm\.decode/);
  });

  test('one receive path serves every rung — BLE frames run the same gates', () => {
    // Mutation: give BLE its own parser — the pod/self/seq gates fork and
    // drift, and the cross-rung seq dedupe dies with them.
    expect(kt).toMatch(/onFrame = \{ bytes -> handleFrame\(bytes, bytes\.size, null, null\) \}/);
    expect(kt).toMatch(/private fun handleFrame\(/);
  });

  test('a peer is listed only after PROOF: connect + MTU + identity read (§5)', () => {
    // Mutation: call onPeer at connect — a listed peer whose pipe cannot
    // carry a frame is §1's "mute AND the UI believes they are fine".
    expect(ble).toMatch(/MIN_VOICE_MTU = 260/);
    const ident = ble.slice(ble.indexOf('private fun handleIdent'));
    expect(ident.slice(0, 900)).toContain('readU32(value, 2) != podHash');
    expect(ident).toMatch(/peer\.ready = true[\s\S]{0,500}onPeer\(/);
    // The ONLY invocation of the callback is the proven one.
    expect(ble.match(/onPeer\(peer\.key, name\)/g)?.length).toBe(1);
  });

  test('membership survives the round trip: a drop keeps the entry, a sighting redials', () => {
    // Mutation: voicePeers.remove on disconnect — a peer who backgrounds
    // and returns can never re-enter without an app restart, the owner's
    // report replayed on the new rung.
    const drop = ble.slice(ble.indexOf('private fun dropClient'));
    expect(drop.slice(0, 1400)).not.toMatch(/voicePeers\.remove/);
    expect(drop.slice(0, 1400)).toContain('onPeerLost(peer.key)');
    // The scan stream is the retry engine, paced per-peer by backoff.
    expect(ble).toMatch(/handler\.post \{ maybeConnect\(hash, device\) \}/);
    expect(ble).toMatch(/CONNECT_BACKOFF_BASE_MS = 3_000L/);
  });

  test('voice writes are NO_RESPONSE — drop-on-busy, never queued or retried', () => {
    // Mutation: switch to acknowledged writes — one slow ACK stalls the
    // pipe and voice arrives seconds late, which the walkie's own law
    // (late audio is worse than lost audio) forbids.
    expect(ble).toMatch(/WRITE_TYPE_NO_RESPONSE/);
  });

  test('rung 3 sends batched 60 ms frames to BLE targets only', () => {
    // Mutation: send the 653-byte PCM frame to a BLE peer — it exceeds
    // the write budget and the peer hears nothing while listed.
    expect(kt).toMatch(/const val BLE_BATCH = 3/);
    expect(kt).toMatch(/if \(p\.sendBle != null\) \{[\s\S]{0,500}continue/);
    expect(kt).toMatch(/p\.sendBle\?\.invoke\(f, f\.size\)/);
  });

  test('the codec is symmetric and every frame is self-contained', () => {
    // Mutation: change either table or the vpdiff halvings on one side —
    // the two predictors drift and voice decodes as rising sand. The
    // 4-byte state header means a lost frame costs its own 60 ms only.
    expect(adpcm).toMatch(/7, 8, 9, 10, 11, 12, 13, 14, 16/);
    expect(adpcm).toMatch(/-1, -1, -1, -1, 2, 4, 6, 8/);
    expect(adpcm).toMatch(/STATE_BYTES = 4/);
    // encode and decode both clamp the predictor and the index
    expect(adpcm.split('coerceIn(-32768, 32767)').length - 1).toBeGreaterThanOrEqual(2);
  });

  test('closing the walkie tears the rung down with it', () => {
    // Mutation: leak the link — a closed walkie keeps advertising a
    // connectable voice service and holding GATT links.
    expect(kt).toMatch(/bleLink\?\.stop\(\)/);
    expect(ble).toMatch(/fun stop\(\) \{\s*\n\s*stopped = true/);
  });
});

describe('the roster tells one truth per person', () => {
  const kt = readSource(KT);

  test('the same podmate on two rungs is ONE row, carried on the better rung', () => {
    // Mutation: emit peers.values again — an Aware+BLE podmate lists
    // twice and burns two of the nine transmit slots on one human.
    expect(kt).toMatch(/private fun rungRank/);
    expect(kt).toMatch(/for \(p in roster\)/);
    expect(kt).not.toMatch(/for \(p in peers\.values\) \{\s*\n\s*arr\.pushString/);
  });

  test('rungs ride the peers event aligned with names', () => {
    // Mutation: drop the array — the panel cannot place the lo-fi badge
    // and either lies by silence or badges everyone.
    expect(kt).toMatch(/m\.putArray\("rungs", rungs\)/);
  });
});

describe('the JS half decodes rungs honestly', () => {
  test('an older native without rungs reads as hi-fi, never as lo-fi', () => {
    // Mutation: default the rung to 'ble' — every peer of a pre-ladder
    // native wears a lo-fi badge that is a lie about what they sound like.
    const d = decodeWalkiePeers({ count: 2, names: ['A', 'B'], talkingTo: 2 });
    expect(d.entries).toEqual([
      { name: 'A', rung: 'lan' },
      { name: 'B', rung: 'lan' },
    ]);
  });

  test('rungs align by index and unknown words fold to hi-fi', () => {
    // Mutation: index-shift the zip — the badge lands on the wrong human.
    const d = decodeWalkiePeers({
      names: ['A', 'B', 'C'],
      rungs: ['ble', 'aware', 'quantum'],
    });
    expect(d.entries.map(e => e.rung)).toEqual(['ble', 'aware', 'lan']);
  });

  test('talkingTo still falls back to the JS cap for an older native', () => {
    expect(decodeWalkiePeers({ names: ['A'] }).talkingTo).toBe(1);
    expect(decodeWalkiePeers({ names: [], count: 0 }).talkingTo).toBe(0);
  });

  test('the channel line wears the lo-fi badge and nothing louder (§5a)', () => {
    // Mutation: print transports — a user who can see the rung will try
    // to manage it, and there is nothing for them to do but superstition.
    const line = formatChannelNames([
      { name: 'Dusty', rung: 'aware' },
      { name: 'Marisol', rung: 'ble' },
    ]);
    expect(line).toBe('Dusty, Marisol (lo-fi)');
    expect(line).not.toMatch(/aware|wi-?fi|bluetooth|gatt|lan/i);
  });

  test('playback is half-duplex: a keyed mic mutes the channel (field howl)', () => {
    // Mutation: drop `|| talking` from the playback gate — two phones in
    // one room howl again (speaker -> still-open mic -> RX pre-amp closes
    // the acoustic loop; the owner heard it from another room, 2026-08-25).
    expect(readSource(KT)).toMatch(/if \(callActive \|\| talking\) \{/);
    // iOS asks the SAME question through one locked accessor (the flags
    // are cross-thread there): the gate calls playbackMuted(), whose body
    // is the shared predicate under flagsLock.
    const swift = readSource('ios/PlayaPal/Walkie.swift');
    expect(swift).toMatch(/if playbackMuted\(\) \{/);
    expect(swift).toMatch(/let muted = callActive \|\| talking/);
    // Same physics on the iPhone's speaker/mic pair — the gate travels
    // with the rung-3 mirror rather than staying an Android field patch.
    expect(readSource('ios/PlayaPal/Walkie.swift')).toMatch(/if playbackMuted\(\) \{/);
  });

  test('the no-wifi diagnosis names the lo-fi mechanism without promising a peer', () => {
    // Rung 3 changed this state's meaning: no Wi-Fi no longer means no
    // live talk. Mutation: keep the old "needs a shared network" absolute
    // — the copy claims less than the app now does, and a camper walks
    // off to find a router they no longer need.
    const copy = walkieDiagnosisCopy({ kind: 'no-wifi' });
    expect(copy).toMatch(/Bluetooth range/);
    expect(copy).toMatch(/live/);
    // ...and the actionable full-quality route stays.
    expect(copy).toContain('join the same Wi-Fi');
  });
});

/**
 * RUNG 3 ON iOS (2026-08-25, owner un-deferral): WalkieBleVoice.swift +
 * AdpcmCodec.swift mirror WalkieBleLink.kt + Adpcm.kt, wired through
 * Walkie.swift the way WalkieAwareLink wires. Swift cannot be unit-run
 * here either — EAS is its first compiler — so these assertions read both
 * languages and die where a seam drifts. The failure mode they guard is
 * the worst one this app has: nothing errors, one platform just plays
 * noise or stays silent, at camp, where nobody can debug it.
 */
describe('rung 3 on iOS mirrors the Kotlin spec', () => {
  const SWIFT = 'ios/PlayaPal/Walkie.swift';
  const BLE_SWIFT = 'ios/PlayaPal/WalkieBleVoice.swift';
  const ADPCM_SWIFT = 'ios/PlayaPal/AdpcmCodec.swift';
  // Read through the const, not a second copy of the same literal — the
  // duplicate left SWIFT unused, which is a lint error the suite carried.
  const swift = readSource(SWIFT);
  const bleSwift = readSource(BLE_SWIFT);
  const adpcmSwift = readSource(ADPCM_SWIFT);

  test('both BLE links speak the same service — UUIDs verbatim in both languages', () => {
    // Mutation: typo one hex digit on either side — the two platforms
    // advertise disjoint services and simply never sight each other.
    const kt = readSource(BLE);
    for (const uuid of [
      '6b75a1fa-8e2a-4b0b-9f21-706c61796170', // service
      '6b75a1fb-8e2a-4b0b-9f21-706c61796170', // voice
      '6b75a1fc-8e2a-4b0b-9f21-706c61796170', // ident
    ]) {
      expect(kt).toContain(uuid);
      expect(bleSwift).toContain(uuid);
    }
  });

  test('the ADPCM ports share the tables, the state header and the clamps', () => {
    // Mutation: change either table, or the predictor clamp, on one side
    // only — the two predictors diverge and cross-platform voice decodes
    // as rising sand. (Bit-compat is finally proven only by the device
    // pair; this pins everything provable from source.)
    for (const src of [readSource(ADPCM), adpcmSwift]) {
      expect(src).toMatch(/7, 8, 9, 10, 11, 12, 13, 14, 16/);
      expect(src).toMatch(/18500, 20350, 22385, 24623, 27086, 29794, 32767/);
      expect(src).toMatch(/-1, -1, -1, -1, 2, 4, 6, 8/);
    }
    expect(adpcmSwift).toMatch(/static let stateBytes = 4/);
    // encode and decode both clamp the predictor
    expect(
      adpcmSwift.split('min(max(predictor, -32768), 32767)').length - 1,
    ).toBe(2);
    // low nibble first, both directions
    expect(adpcmSwift).toMatch(/\(code & 0x0F\) << 4/);
    expect(adpcmSwift).toMatch(/\(b >> 4\) & 0x0F/);
  });

  test('iOS voice frames are codec 0x5 in the same PW layout, batched 60 ms', () => {
    // Mutation: mint a different codec id or batch on one side — an
    // Android receiver drops the frames (unknown id), or the frame
    // outgrows the GATT write budget and the peer hears nothing.
    expect(swift).toMatch(/codecAdpcm8k: UInt8 = 0x5/);
    expect(swift).toMatch(/bleBatch = 3/);
    expect(readSource(KT)).toMatch(/const val BLE_BATCH = 3/);
    expect(swift).toMatch(/f\.append\(\(Self\.frameVersion << 4\) \| Self\.codecAdpcm8k\)/);
    expect(swift).toMatch(/f\.append\(contentsOf: be32\(podHash\)\)/);
    expect(swift).toMatch(/f\.append\(contentsOf: be32\(senderHash\)\)/);
  });

  test('the iOS receive path accepts BOTH known codecs and still drops unknowns', () => {
    // Mutation 1: forget ADPCM — rung 3 peers are listed and SILENT,
    // §1's "negotiated but broken". Mutation 2: accept anything — a
    // future codec plays as noise.
    expect(swift).toMatch(
      /\(b\[2\] & 0x0F\) == Self\.codecPcm16_16k \|\| \(b\[2\] & 0x0F\) == Self\.codecAdpcm8k/,
    );
    expect(swift).toMatch(/== Self\.codecAdpcm8k \{[\s\S]{0,400}AdpcmCodec\.decode/);
  });

  test('a peer is listed only after PROOF: connect + write budget + identity read (§5)', () => {
    // Mutation: hand the peer up at connect — a listed peer whose pipe
    // cannot carry a frame is §1's "mute AND the UI believes they are
    // fine". 257 = Android's MIN_VOICE_MTU 260 minus the 3-byte ATT
    // header maximumWriteValueLength already excludes.
    expect(bleSwift).toMatch(/minVoiceWrite = 257/);
    expect(bleSwift).toMatch(
      /maximumWriteValueLength\(for: \.withoutResponse\) >= Self\.minVoiceWrite/,
    );
    const ident = bleSwift.slice(bleSwift.indexOf('private func handleIdent'));
    expect(ident.slice(0, 700)).toContain('be32(b, 2) == podHash');
    expect(ident).toMatch(/peer\.ready = true[\s\S]{0,300}onPeer\(/);
    // The ONLY invocation of the callback is the proven one.
    expect(bleSwift.match(/onPeer\(peer\.key, peer\.name, peer\.hash\)/g)?.length).toBe(1);
  });

  test('iOS membership survives the round trip and writes are drop-on-busy', () => {
    // Mutation: remove the peer record on disconnect — a backgrounded
    // podmate can never re-enter without an app restart; or switch to
    // acknowledged writes — one slow ACK stalls the pipe into late audio.
    const drop = bleSwift.slice(bleSwift.indexOf('private func dropClient'));
    expect(drop.slice(0, 1200)).not.toMatch(/voicePeers\.removeValue/);
    expect(drop.slice(0, 1200)).toContain('onPeerLost(peer.key)');
    expect(bleSwift).toMatch(/connectBackoffBase: TimeInterval = 3/);
    expect(bleSwift).toMatch(/canSendWriteWithoutResponse/);
    expect(bleSwift).toMatch(/type: \.withoutResponse/);
    // The scan stream is the retry engine — duplicates must stay ON.
    expect(bleSwift).toMatch(/CBCentralManagerScanOptionAllowDuplicatesKey: true/);
  });

  test('the identity crosses the platform gap: mfg data AND the local-name carrier', () => {
    // THE ASYMMETRY PIN. A CoreBluetooth peripheral cannot advertise
    // manufacturer data, so the iPhone spells PV as its local name and
    // BOTH scanners read BOTH carriers. Mutation: drop either side's
    // second branch — rung 3 quietly becomes same-OS-only, at camp,
    // undebuggable.
    // 10-char pod-only form since 2026-08-26: the field bench measured iOS
    // truncating the 18-char pair to 8 chars in the delivered packet, so
    // the sender half moved wholly to the ident proof (walkieCap pins the
    // Android acceptor's truncated-prefix branch and the re-key).
    expect(bleSwift).toMatch(/String\(format: "PV%08x", podHash\)/);
    expect(bleSwift).toMatch(/CBAdvertisementDataLocalNameKey: pvName\(\)/);
    expect(bleSwift).toMatch(/CBAdvertisementDataManufacturerDataKey/);
    const kt = readSource(BLE);
    expect(kt).toMatch(/private fun pvFromName/);
    // The scan callback reads the advertised name and falls back to it
    // when there is no manufacturer data. Written against the LOCAL that
    // now holds the name rather than the expression that used to be
    // inlined there (2026-08-26: the scan-drop diagnostic hoisted
    // `r.scanRecord` and its `deviceName` into two locals so both the
    // fallback and the log line read one thing) — the pin is that the
    // fallback branch EXISTS and is fed the advertised name, never how
    // many characters it takes to say so.
    expect(kt).toMatch(/val name = rec\?\.deviceName/);
    expect(kt).toMatch(/\?: pvFromName\(name\)/);
  });

  test('iOS peers events carry rungs, and BLE rows are never callable', () => {
    // Mutation: drop the rungs array — the lo-fi badge cannot land on an
    // iPhone; or emit callable rows from the raw map — a BLE-only
    // podmate wears a call button that can never ring them.
    // The rung word now carries the liveness lane's demotion ("stale" for
    // a datagram row that stopped proving itself, 2026-08-25) — the array
    // and the mutation it guards are the same; only the word can differ.
    expect(swift).toMatch(
      /"rungs": roster\.map \{ proven\(\$0\.peer, now\) \? \$0\.peer\.rung : "stale" \}/,
    );
    expect(swift).toMatch(/rung: "ble"/);
    // ...and callable rows are datagram AND proven: an unproven row is not
    // an address either (docs/WALKIE-LADDER.md §5).
    expect(swift).toMatch(
      /for p in peers\.values where p\.bleSend == nil && proven\(p, now\)/,
    );
  });

  test('one receive path on iOS too — BLE frames run the same gates', () => {
    // Mutation: give BLE its own parser — the pod/self/seq gates fork
    // and drift, and the cross-rung seq dedupe dies with them.
    const wiring = swift.slice(swift.indexOf('let ble = WalkieBleVoice('));
    // One parser, and the lane it arrived on rides ALONG — the liveness
    // lane stamps the row that delivered the frame, so the argument names
    // the rung without forking a second receive path.
    expect(wiring.slice(0, 1800)).toMatch(/self\.handleFrame\(d, lane: "ble"\)/);
    // ...and closing the walkie tears the rung down with it.
    expect(swift).toMatch(/bleVoice\?\.stop\(\)/);
    expect(bleSwift).toMatch(
      /func stop\(\) \{\s*\n\s*queue\.async \{ \[self\] in\s*\n\s*stopped = true/,
    );
  });

  test('the new sources are registered with the Xcode target', () => {
    // Mutation: add the files but not the pbxproj rows — EAS compiles a
    // walkie without its rung 3 and nothing errors; the module is simply
    // absent on every iPhone. Scoped to the SOURCES BUILD PHASE, not the
    // whole file: the first cut of this test matched the PBXBuildFile
    // section's row and survived exactly the mutation it exists to catch
    // (planted 2026-08-25 — the row that compiles is the phase's).
    const pbx = readSource('ios/PlayaPal.xcodeproj/project.pbxproj');
    const phase = pbx.slice(pbx.indexOf('PBXSourcesBuildPhase section'));
    expect(phase).toMatch(/WalkieBleVoice\.swift in Sources/);
    expect(phase).toMatch(/AdpcmCodec\.swift in Sources/);
  });
});

describe('the redial HEALS: return paths re-stamp, the responder rotates off a corpse', () => {
  // The dust-mode 30 s flap, measured 2026-08-25 on two Pixels with no AP:
  // datapath-up -> row-proven (+1.5 s, exactly ONE inbound) -> deaf ->
  // row-demoted (+10 s) -> redial (+30 s), forever. Two causes, two pins.
  const aware = readSource(AWARE);

  test('the return path re-stamps on CHANGE, never latches once', () => {
    // Mutation: restore `|| peer.returnPathUp` to the role gate — the
    // responder answers the initiator's FIRST-ever port for the rest of
    // the session, so every redial after the first is deaf in exactly one
    // direction and the pair re-proves for exactly one frame per cycle.
    expect(aware).not.toMatch(/senderHash > peer\.hash \|\| peer\.returnPathUp/);
    expect(aware).toMatch(
      /port == peer\.returnPort &&\s*\n\s*socket === peer\.returnSocket/,
    );
    expect(aware).toMatch(/peer\.returnPort = port/);
    expect(aware).toMatch(/peer\.returnSocket = socket/);
    // ...atomically: frames arrive on more than one receive thread
    // (codex 2026-08-26). Mutation: drop @Synchronized — a port flap can
    // tear the endpoint triple and storm onPeer.
    expect(aware).toMatch(/@Synchronized\s*\n\s*fun noteReturnPath/);
    expect(aware).toMatch(/peer\.returnStampMs = System\.currentTimeMillis\(\)/);
  });

  test('a responder bound only to DEAD networks rotates: fresh socket, fresh specifier', () => {
    // Mutation: keep the bare responder early-return in noteSilent — the
    // one responder socket stays bound to the first NDP's corpse (a later
    // bindSocket EPERMs and the framework often never says onLost), its
    // sends route into a torn-down netid, and the specifier keeps
    // advertising a port that cannot answer.
    const silent = aware.slice(aware.indexOf('fun noteSilent'));
    expect(silent.slice(0, 1400)).toContain('maybeRotateResponder()');
    const rotate = aware.slice(aware.indexOf('private fun maybeRotateResponder'));
    // Skip while ANY bound network is alive — another podmate may ride it.
    expect(rotate).toMatch(/cm\.getNetworkCapabilities\(n\) != null/);
    expect(rotate).toMatch(/if \(anyAlive\) \{\s*\n\s*return/);
    // The rotation composes the one teardown path and the one refile path.
    expect(rotate).toContain('releaseResponderRequest()');
    expect(rotate).toContain('responderSocket?.close()');
    expect(rotate).toContain('ensureResponderRequest()');
    // ...and rides the same 30 s floor as every silence response (§5 r5).
    expect(rotate).toContain('lastResponderRotate < RELOST_FLOOR_MS');
    // ...and NEVER rotates over fresh inbound proof: capabilities can
    // transiently answer null for a live network (codex 2026-08-26), and
    // rotating on that lie breaks every healthy responder path at once.
    // Mutation: drop the returnStampMs guard — one instrument lie churns
    // the whole rung.
    expect(rotate).toContain('returnStampMs');
    expect(rotate).toMatch(/now - freshestStamp < 15_000L/);
    // The teardown cannot interleave with a request being filed.
    expect(aware).toMatch(/@Synchronized\s*\n\s*fun stop\(\)/);
  });
});
