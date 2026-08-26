import AVFoundation
import Foundation
import Network
import React

/**
 Walkie — live PTT voice for Camp Mesh (docs/CREW-DESIGN.md §6d), iOS half.

 Mirrors the Android module: Bonjour discovery (`_playapal-walkie._udp`) +
 UDP UNICAST of 20 ms PCM16 frames on any shared Wi-Fi — the only
 entitlement-free cross-platform lane (iOS multicast needs Apple approval;
 Multipeer is Apple-only). Frame: 'PW'(2) + version|codec(1) + podHash(4 BE)
 + senderHash(4 BE) + seq(2 BE) + payload (PCM16LE @16 kHz mono at codec 1). Receivers play only their pod's
 frames, drop stale seqs on the mod-65536 ring, never retransmit (late
 audio is worse than lost audio).

 On iOS 26 the OWN-LINK rung (WalkieAwareLink in WifiAware.swift, mirror of
 WalkieAwareLink.kt) feeds this same peer table with Wi-Fi Aware peers under
 "aware|" keys: no shared network needed, same PW frames, same cap, same
 events. Every aware failure contributes no peers — this file's LAN lane is
 untouched by it.

 RUNG 3 (docs/WALKIE-LADDER.md §2, §6) feeds the same table too:
 WalkieBleVoice.swift proves per-peer GATT voice pipes (mirror of
 WalkieBleLink.kt) and hands them up under "ble|" keys; voice to those
 peers leaves as one 60 ms IMA-ADPCM frame (codec 0x5) per write instead
 of 20 ms PCM — the rung changes the CODEC and the socket, never the
 frame. Same fencing: every BLE failure contributes no peers.

 CONSENT: the mic runs ONLY between startTalking/stopTalking — the held
 button is the consent surface; the OS mic ask fires on the first
 startTalking (NSMicrophoneUsageDescription, already in the plist for
 voice notes).

 Events (same names as Android):
   WalkiePeers    { count, talkingTo, names, rungs, peers }
                  (rungs aligned with names: "lan" | "aware" | "ble" —
                   the panel's lo-fi badge)
   WalkieSpeaking { name, podHash }   (throttled ~1/s)
 */
@objc(Walkie)
final class Walkie: RCTEventEmitter {
  private static let serviceType = "_playapal-walkie._udp"
  private static let sampleRate = 16_000.0
  private static let frameSamples = 320 // 20 ms
  private static let header = 13

  /**
   Byte 2 of every PW frame: (version << 4) | codec. One protocol over N
   transports means the RUNG changes the codec and the socket, never the
   frame — so the frame must say which codec it carries
   (docs/WALKIE-LADDER.md §3). An unknown version or codec is DROPPED, the
   posture decodeBeacon already takes: silence from one sender beats garbage
   played into a whole pod's ear. Must match WalkieModule.kt.
   */
  private static let frameVersion: UInt8 = 1
  private static let codecPcm16_16k: UInt8 = 0x1

  /// The ladder's rung-negotiation frame (§5 step 3): zero payload, and
  /// now also the keep-alive that makes silence mean death rather than
  /// idleness. Must match WalkieModule.kt CODEC_PROBE.
  private static let codecProbe: UInt8 = 0x0

  /// Call-control payload (docs/VIDEO-CALLS.md): chunked 1:1 video-call
  /// signaling, opaque bytes to this module. 0x2-0x4 stay reserved for the
  /// ladder's audio codecs. Must match WalkieModule.kt CODEC_CALL and
  /// walkie.ts WALKIE_CODEC_CALL; a test reads all three files.
  private static let codecCall: UInt8 = 0x6
  private static let frameHead: UInt8 = (frameVersion << 4) | codecPcm16_16k

  /// Rung 3's codec (docs/WALKIE-LADDER.md §6): IMA ADPCM over 8 kHz —
  /// see AdpcmCodec.swift (and Adpcm.kt, its bit-compatible twin) for why
  /// this and not the table's Opus/Codec2. Must match WalkieModule.kt
  /// CODEC_ADPCM8K; a test reads both files.
  private static let codecAdpcm8k: UInt8 = 0x5

  /// Rung 3 sends every third 20 ms capture as ONE 60 ms ADPCM frame:
  /// ~17 GATT writes/s instead of 50, each 257 bytes — under the write
  /// budget and gentle on the GATT bandwidth the answering machine shares
  /// (§6, §2a). Must equal WalkieModule.BLE_BATCH; a test reads both files.
  private static let bleBatch = 3

  /**
   Live-talk channel ceiling, PEERS (channel = this + me = 10). Owner ruling
   2026-08-24. SOFT by nature: mDNS + UDP has no admission control, so anyone
   with the pod code can join and no phone can stop them — what this bounds is
   what THIS phone TRANSMITS to, which is also the fan-out cure (live voice is
   unicast per peer per 20 ms frame: 9 peers ~290 KB/s, 59 would be 1.9 MB/s).
   Must equal WalkieModule.MAX_PEERS and walkie.ts WALKIE_MAX_PEERS; a test
   reads all three files.
   */
  private static let maxPeers = 9

  /**
   SIGNAL BREADTH CEILING, the mirror of WalkieModule.MAX_SIGNAL_FANOUT
   (docs/VIDEO-CALLS.md §2a). One call-signal payload may ride at most this
   many of ONE podmate's datagram rows, best-proven first; the JS signaler
   asks for two while retransmitting and one otherwise, and this clamps it.
   Bounded on the native side, like maxPeers, because a JS-side-only cap is
   a cap only while the JS side is right.

   SIGNALING ONLY. Live voice picks ONE row per person in recomputeTargets
   and stays there — a hedged voice frame would double the audio thread's
   packet rate for a codec that already tolerates loss.
   */
  private static let maxSignalFanout = 2

  /**
   §5'S CLOCK, the mirror of WalkieModule.STALE_MS / PROBE_MS / SWEEP_MS
   (10 s / 4.5 s / 2 s; a test reads both files, because a phone that
   demotes on a different clock than its podmate is two ladders, not one).

   A datagram row that has delivered nothing for `staleSeconds` is DEMOTED:
   no hi-fi claim, no Call button, ranked below every proven row. The
   keep-alive is what earns that rule the right to exist — every phone puts
   one 13-byte probe on each datagram row every `probeSeconds` while the
   walkie session is open, so a healthy link always has recent inbound.
   Measured on Android (two Pixels, 2026-08-25): an Aware datapath died
   silently for minutes with no framework callback at all, while the row
   kept its plain name and its Call button.
   */
  private static let staleSeconds: TimeInterval = 10
  private static let probeSeconds: TimeInterval = 4.5
  private static let sweepSeconds: TimeInterval = 2
  private static let peersEvent = "WalkiePeers"
  private static let speakingEvent = "WalkieSpeaking"
  private static let signalEvent = "WalkieSignal"

  private struct Peer {
    /// Bonjour peers carry an endpoint to dial lazily; Aware peers arrive
    /// with a live link instead (endpoint == nil) — an aware datapath is
    /// not dialable by address from here.
    let endpoint: NWEndpoint?
    let name: String
    let senderHash: UInt32
    var connection: NWConnection? = nil
    /// The own-link lane: a type-erased send onto this peer's Wi-Fi Aware
    /// connection (WalkieAwareLink owns the connection and its lifetime).
    var awareSend: ((Data) -> Void)? = nil
    /// Rung 3's lane: one PW frame onto this peer's GATT voice pipe
    /// (WalkieBleVoice owns the link and its lifetime). Non-nil exactly
    /// when rung == "ble".
    var bleSend: ((Data) -> Void)? = nil
    /// Which rung carries this peer — "lan" | "aware" | "ble". The
    /// panel's lo-fi badge and the per-person dedupe both read it
    /// (mirror of WalkieModule's Peer.rung).
    var rung: String = "lan"
    /// When THIS ROW last delivered a frame — §5's proof, per row and never
    /// per person, so a live LAN row cannot vouch for the same podmate's
    /// dead aware row (mirror of WalkieModule's Peer.lastInbound). Born
    /// stamped: a row is minted from a browse result or a live link.
    var lastInbound: Date = Date()
  }

  private var listener: NWListener?
  private var browser: NWBrowser?
  /// The own-link rung. Typed Any because WalkieAwareLink only exists
  /// under SDKs that carry the WiFiAware framework (iOS 26+); every touch
  /// is behind #if canImport(WiFiAware) + #available.
  private var awareLink: Any?
  /// Rung 3 (WalkieBleVoice). CoreBluetooth exists on every iOS, so no
  /// availability dance; the link fails soft internally.
  private var bleVoice: WalkieBleVoice?
  private var peers: [String: Peer] = [:] // key = bonjour name, or "aware|<hex>|<name>"
  private var podHash: UInt32 = 0
  private var senderHash: UInt32 = 0
  private var seq: UInt16 = 0
  /// Two threads stamp frames — the audio tap (sendFrames) and main
  /// (sendSignal) — the same pair WalkieModule.kt made its seqCounter
  /// atomic for: a lost update is two frames sharing one seq, and the
  /// receiver's freshness gate eats one of them as a duplicate.
  private let seqLock = NSLock()
  private var lastSeq: [UInt32: UInt16] = [:]
  private var lastSpeakEmit = Date.distantPast
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  /**
   THE TWO PLAYBACK GATES, AND WHY THEY ARE LOCKED.

   `callActive`: a 1:1 call is connecting or live (set from JS,
   setCallActive). Walkie PLAYBACK is muted so pod voice cannot ride this
   loudspeaker into the call's open mic — WebRTC's AEC cancels only its own
   far-end audio, not a separate app-owned player node.

   `talking`: this phone is keying, so the channel is muted like every radio
   ever made. Two phones a foot apart fed played-back pod voice back into
   the still-open mic and the loop went over unity (field-measured
   2026-08-25 on Android; the same speaker and the same mic are here).

   NEITHER IS MAIN-CONFINED, whatever the old `callActive` comment claimed.
   `handleFrame` reads them from the NWConnection's own queue on the LAN
   rung (receiveLoop) and from main on the Aware rung, and `talking` is
   written on main by startTalking, off main by stopTalking, and read on the
   audio tap thread. So they are exactly the shape `targets` above already
   is — written on one thread, read on another — and they get the same
   answer the file already chose for that shape: a lock held just long
   enough to copy, never an atomic-per-field or a queue hop on the audio
   path. Their own lock, not `targetsLock`, so the render thread's
   currentTargets() never contends with a network thread reading a flag.
   */
  private var talking = false
  /// Rung 3's accumulator: bleBatch 20 ms captures become one 60 ms
  /// ADPCM frame for the BLE-carried targets. Touched ONLY on the audio
  /// tap thread (sendFrames) — the mirror of the walkie-tx locals in
  /// WalkieModule.startTalking.
  private var bleSamples = [Int16](repeating: 0, count: Walkie.frameSamples * Walkie.bleBatch)
  private var bleFill = 0
  private var callActive = false
  private let flagsLock = NSLock()
  private var myName = ""

  @objc
  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [Self.peersEvent, Self.speakingEvent, Self.signalEvent]
  }

  /**
   WHO WE TRANSMIT TO, AS AN IMMUTABLE SNAPSHOT — the iOS mirror of
   WalkieModule.kt's `targets`, and for the same three reasons.

   The previous shape read AND WROTE the `peers` dictionary from
   AVAudioEngine's render thread while the Bonjour handler replaced that same
   dictionary wholesale on main. A Swift Dictionary is not thread-safe, so
   that is undefined behaviour on a real-time audio thread, not staleness —
   and the lazy `peers[name] = peer` write in the send loop was also a
   deterministic lost write, leaking one NWConnection per frame whenever the
   browser fired in the same window.

   It also allocated three times per 20 ms frame (sorted + prefix + map) on
   the thread that must never allocate.

   So: main owns `peers` and builds this array; the audio thread only ever
   READS it, holding the lock just long enough to copy a reference. Ordered by
   senderHash so every phone that discovered the same people picks the same
   subset — not a quorum protocol, just determinism making the common case
   agree for free.
   */
  private struct Target {
    /// One frame out to one peer. For Bonjour peers this wraps the
    /// NWConnection built below; for Aware and BLE peers it is the
    /// link's own send closure — the audio thread cannot tell them
    /// apart, which is the point (one protocol, N transports).
    let send: (Data) -> Void
    /// Rung 3 cannot carry the 20 ms PCM frame — sendFrames routes these
    /// targets to its 60 ms ADPCM lane instead.
    let isBle: Bool
  }

  /// Written on MAIN only, read on the audio thread under `targetsLock`.
  private var targets: [Target] = []
  private let targetsLock = NSLock()

  /// The keep-alive + staleness sweep, alive exactly while the walkie
  /// session is (see `sweep()`). A dispatch source rather than a Timer:
  /// `start` does not run on a thread with a run loop.
  private var sweepTimer: DispatchSourceTimer?
  private var lastProbe = Date.distantPast
  /// Which rows were demoted at the last sweep — kept so the peers event
  /// fires on a CHANGE of proof, not on every tick.
  private var unprovenRows = Set<String>()

  /// A pointer copy under a lock — no allocation, no dictionary, bounded.
  private func currentTargets() -> [Target] {
    targetsLock.lock()
    let t = targets
    targetsLock.unlock()
    return t
  }

  private func nextSeq() -> UInt16 {
    seqLock.lock()
    seq &+= 1
    let s = seq
    seqLock.unlock()
    return s
  }

  /// Hi-fi first — mirror of WalkieModule.rungRank: a podmate reachable
  /// on both a datagram rung and the BLE pipe is carried on the better
  /// one, and the other copy is dropped before it can waste a transmit
  /// slot or list one human twice.
  private func rungRank(_ rung: String) -> Int {
    rung == "lan" ? 0 : rung == "aware" ? 1 : 2
  }

  /// §5, asked continuously: has this row PROVEN it is alive? A datagram
  /// row proves itself with inbound frames and nothing else — the
  /// keep-alive below guarantees a healthy one always has some. A BLE row
  /// is exempt because rung 3 is proven by its GATT connection, which the
  /// link drops the row with (mirror of WalkieModule.proven).
  private func proven(_ p: Peer, _ now: Date) -> Bool {
    p.bleSend != nil || now.timeIntervalSince(p.lastInbound) < Self.staleSeconds
  }

  /// Rung rank AFTER the proof: an unproven datagram row ranks below every
  /// proven row — below BLE — so a demoted row falls to the lo-fi pipe or
  /// to a live datagram row instead of holding the person's best slot
  /// (mirror of WalkieModule.rank).
  private func rank(_ p: Peer, _ now: Date) -> Int {
    proven(p, now) ? rungRank(p.rung) : 3
  }

  /// One row per PERSON, deduped from the transports: what the panel
  /// lists. MAIN owns it, like `peers`. Uncapped — the cap bounds
  /// transmission, never sight (WalkieModule.roster, mirrored).
  private var roster: [(key: String, peer: Peer)] = []

  /// MAIN. ONE ROW PER PERSON: the same podmate on several rungs
  /// collapses to their best rung by senderHash — without this a phone
  /// near a LAN peer that is ALSO in BLE range listed them twice and
  /// unicast every frame twice.
  private func rebuildRoster() {
    // RANKED BY PROOF, not by rung word (§5): a dead aware row used to beat
    // a live BLE row for the same person purely because "aware" outranks
    // "ble" on paper, and then every targeted send resolved the dead one.
    let now = Date()
    var best: [UInt32: (key: String, peer: Peer)] = [:]
    for (key, p) in peers {
      if let cur = best[p.senderHash], rank(cur.peer, now) <= rank(p, now) {
        continue
      }
      best[p.senderHash] = (key, p)
    }
    roster = best.values.sorted { $0.peer.senderHash < $1.peer.senderHash }
  }

  /// Mirrors WalkieModule.kt's `if (callActive || talking)` playback gate —
  /// ONE question asked once, so the two flags cannot be read a microsecond
  /// apart and disagree. A test reads both files for this predicate.
  private func playbackMuted() -> Bool {
    flagsLock.lock()
    let muted = callActive || talking
    flagsLock.unlock()
    return muted
  }

  private func isTalking() -> Bool {
    flagsLock.lock()
    let t = talking
    flagsLock.unlock()
    return t
  }

  private func setTalking(_ value: Bool) {
    flagsLock.lock()
    talking = value
    flagsLock.unlock()
  }

  private func setCallActiveFlag(_ value: Bool) {
    flagsLock.lock()
    callActive = value
    flagsLock.unlock()
  }

  /**
   Recompute the snapshot. MAIN THREAD ONLY. Connections are created HERE, as
   a peer ENTERS the target set — never lazily on the audio thread, which is
   what made the old code write to a dictionary it was also iterating.
   */
  private func recomputeTargets() {
    rebuildRoster()
    var next: [Target] = []
    next.reserveCapacity(min(roster.count, Self.maxPeers))
    for (name, _) in roster.prefix(Self.maxPeers) {
      guard var peer = peers[name] else { continue }
      if let ble = peer.bleSend {
        // Rung 3 rides its own 60 ms ADPCM lane in sendFrames — the
        // 20 ms PCM frame does not fit a GATT write.
        next.append(Target(send: ble, isBle: true))
        continue
      }
      if let aware = peer.awareSend {
        // Aware peers arrive with their link already up — nothing to dial.
        next.append(Target(send: aware, isBle: false))
        continue
      }
      if peer.connection == nil, let endpoint = peer.endpoint {
        let c = NWConnection(to: endpoint, using: .udp)
        c.start(queue: .main)
        peer.connection = c
        peers[name] = peer // safe: main owns `peers`
      }
      if let c = peer.connection {
        // The closure is built HERE on main, once per recompute — the
        // audio thread only invokes it.
        next.append(Target(
          send: { c.send(content: $0, completion: .contentProcessed { _ in }) },
          isBle: false
        ))
      }
    }
    targetsLock.lock()
    targets = next
    targetsLock.unlock()
  }

  /// CALLABLE identities only — one row per hash, datagram rungs only
  /// (mirror of WalkieModule.emitPeers): a "ble" row is a voice pipe,
  /// not an address sendSignal can dial, so a BLE-only podmate stays on
  /// the channel list WITHOUT a call button instead of wearing one that
  /// can never ring them.
  /// ...and PROVEN rows only. A row that cannot prove it is alive is not an
  /// address: offering its Call button is announcing availability, the one
  /// thing §5 forbids. The button returns by itself the moment a frame —
  /// a keep-alive answer, a probe, an INVITE — re-stamps the row.
  private func callablePeers() -> [Peer] {
    let now = Date()
    var best: [UInt32: Peer] = [:]
    for p in peers.values where p.bleSend == nil && proven(p, now) {
      if let cur = best[p.senderHash], rungRank(cur.rung) <= rungRank(p.rung) {
        continue
      }
      best[p.senderHash] = p
    }
    return best.values.sorted { $0.senderHash < $1.senderHash }
  }

  private func emitPeers() {
    recomputeTargets()
    let now = Date()
    sendEvent(withName: Self.peersEvent, body: [
      "count": roster.count,
      // What we will actually reach. The panel needs BOTH: "12 people are
      // here but you are talking to 9" cannot be derived from count by a JS
      // side that does not know the cap.
      "talkingTo": min(roster.count, Self.maxPeers),
      "names": roster.map { $0.peer.name },
      // Aligned with names: which rung carries each row, so the panel can
      // wear the lo-fi badge on exactly the peers that SOUND lo-fi — the
      // one badge, nothing louder (docs/WALKIE-LADDER.md §5a).
      //
      // A DEMOTED row says "stale" and wears that same badge: it is at the
      // floor, which is all a demoted row knows and all §5a lets us say.
      // What it must never keep is the plain name a hi-fi rung earns.
      "rungs": roster.map { proven($0.peer, now) ? $0.peer.rung : "stale" },
      // Identity rows for targeted verbs (the 1:1 call button).
      "peers": callablePeers().map {
        ["name": $0.name, "hash": String($0.senderHash, radix: 16)]
      },
    ])
  }

  // ------------------------------------------------------------ lifecycle

  @objc(start:senderHash:displayName:resolver:rejecter:)
  func start(
    _ podHashD: NSNumber,
    senderHash senderHashD: NSNumber,
    displayName: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard listener == nil else {
      resolve(nil)
      return
    }
    podHash = UInt32(truncating: podHashD)
    senderHash = UInt32(truncating: senderHashD)
    let clean = displayName.replacingOccurrences(of: "|", with: "/").prefix(24)
    myName = "pp|\(String(senderHash, radix: 16))|\(clean.isEmpty ? "someone" : String(clean))"
    do {
      let l = try NWListener(using: .udp)
      l.service = NWListener.Service(name: myName, type: Self.serviceType)
      l.newConnectionHandler = { [weak self] conn in
        // Inbound voice: receive loop per remote sender.
        conn.start(queue: .main)
        self?.receiveLoop(conn)
      }
      l.start(queue: .main)
      listener = l

      let b = NWBrowser(
        for: .bonjour(type: Self.serviceType, domain: nil),
        using: NWParameters()
      )
      b.browseResultsChangedHandler = { [weak self] results, _ in
        guard let self else { return }
        var next: [String: Peer] = [:]
        for r in results {
          guard case let .service(name, _, _, _) = r.endpoint, name != self.myName,
                name.hasPrefix("pp|") else { continue }
          let bits = name.split(separator: "|", maxSplits: 2).map(String.init)
          let hash = UInt32(bits.count > 1 ? bits[1] : "", radix: 16) ?? 0
          // Self by IDENTITY, not by name — Bonjour renames on collision,
          // and a phone sharing its hotspot rediscovers its own service on
          // the second interface under the renamed instance. Measured on
          // Android in the field; the seam is identical here.
          guard hash != self.senderHash else { continue }
          let label = bits.count > 2 ? bits[2] : "someone"
          if let existing = self.peers[name] {
            next[name] = existing
          } else {
            next[name] = Peer(endpoint: r.endpoint, name: label, senderHash: hash, connection: nil)
          }
        }
        // Aware peers live in this same table under "aware|" keys but are
        // NOT Bonjour results — carry them across the rebuild, or every
        // browse callback would silently drop the own-link rung.
        for (name, peer) in self.peers where name.hasPrefix("aware|") {
          next[name] = peer
        }
        // Connections for dropped peers close with their entries.
        for (name, peer) in self.peers where next[name] == nil {
          peer.connection?.cancel()
        }
        self.peers = next
        self.emitPeers()
      }
      b.start(queue: .main)
      browser = b

      // THE OWN-LINK RUNG (docs/WALKIE-LADDER.md §9): phones with the
      // Aware radio also discover each other with NO shared network and
      // feed the SAME peer table. Failure at any point simply contributes
      // no peers — the LAN rung above is already running. Compiled only
      // against SDKs that have the framework; older iOS never enters.
      #if canImport(WiFiAware)
        if #available(iOS 26.0, *) {
          let link = WalkieAwareLink(
            podHash: podHash,
            senderHash: senderHash,
            displayName: displayName,
            onPeer: { [weak self] key, name, hash, send in
              DispatchQueue.main.async {
                guard let self, self.listener != nil else { return }
                // Same key = replacement in place (the link's dedup can
                // swap the underlying connection without a peer-flap).
                self.peers[key] = Peer(
                  endpoint: nil, name: name, senderHash: hash, awareSend: send, rung: "aware"
                )
                self.emitPeers()
              }
            },
            onPeerLost: { [weak self] key in
              DispatchQueue.main.async {
                guard let self else { return }
                if self.peers.removeValue(forKey: key) != nil {
                  self.emitPeers()
                }
              }
            },
            onFrame: { [weak self] d in
              // Byte-identical PW frames; handleFrame's pod/sender/seq
              // gates apply unchanged — the rung changes the socket,
              // never the frame.
              DispatchQueue.main.async { self?.handleFrame(d, lane: "aware") }
            }
          )
          awareLink = link
          link.start()
        }
      #endif

      // RUNG 3 — LIVE LO-FI OVER BLE (docs/WALKIE-LADDER.md §2, §6): the
      // ladder's floor for LIVE talk, the mirror of WalkieModule.kt's
      // WalkieBleLink wiring. Two phones with no Wi-Fi of any kind still
      // carry choppy voice over a GATT pipe; peers arrive under "ble|"
      // keys and the roster dedupe keeps a podmate who is also on a
      // hi-fi rung on that rung instead. Every closure hops to main —
      // this file's "main owns peers" discipline — and every BLE failure
      // contributes no peers; the rungs above are already running.
      let ble = WalkieBleVoice(
        podHash: podHash,
        senderHash: senderHash,
        displayName: displayName,
        onPeer: { [weak self] key, name, hash, send in
          DispatchQueue.main.async {
            guard let self, self.listener != nil else { return }
            self.peers[key] = Peer(
              endpoint: nil, name: name, senderHash: hash, bleSend: send, rung: "ble"
            )
            self.emitPeers()
          }
        },
        onPeerLost: { [weak self] key in
          DispatchQueue.main.async {
            guard let self else { return }
            if self.peers.removeValue(forKey: key) != nil {
              self.emitPeers()
            }
          }
        },
        onFrame: { [weak self] d in
          DispatchQueue.main.async {
            // The walkie may have closed while this frame hopped queues;
            // playing it would resurrect the audio engine after stop.
            guard let self, self.listener != nil else { return }
            self.handleFrame(d, lane: "ble")
          }
        }
      )
      bleVoice = ble
      ble.start()

      // Last, because it probes whatever the rungs above discovered: the
      // keep-alive that turns §5's "availability is PROVEN" from a rule the
      // ladder states into one the walkie enforces every few seconds.
      unprovenRows = []
      lastProbe = .distantPast
      let t = DispatchSource.makeTimerSource(queue: .main)
      t.schedule(deadline: .now() + Self.sweepSeconds, repeating: Self.sweepSeconds)
      t.setEventHandler { [weak self] in self?.sweep() }
      t.resume()
      sweepTimer = t

      resolve(nil)
    } catch {
      stopInternal()
      reject("walkie", error.localizedDescription, error)
    }
  }

  @objc(stop:rejecter:)
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    stopInternal()
    resolve(nil)
  }

  private func stopInternal() {
    setTalking(false)
    // A walkie restart must never inherit a stale mute; the JS unmute arc
    // rides the panel's call effect, and unmount tears down through here.
    setCallActiveFlag(false)
    // A walkie that is off probes nothing.
    sweepTimer?.cancel()
    sweepTimer = nil
    unprovenRows = []
    listener?.cancel()
    listener = nil
    browser?.cancel()
    browser = nil
    #if canImport(WiFiAware)
      if #available(iOS 26.0, *), let link = awareLink as? WalkieAwareLink {
        link.stop()
      }
    #endif
    awareLink = nil
    bleVoice?.stop()
    bleVoice = nil
    for (_, p) in peers {
      p.connection?.cancel()
    }
    peers.removeAll()
    targetsLock.lock()
    targets = []
    targetsLock.unlock()
    lastSeq.removeAll()
    discardEngine()
  }

  /// Drops the cached engine/player pair so the NEXT use rebuilds from
  /// scratch — fresh session shape, input element re-enabled. The rebuild
  /// is what heals a corpse another audio client left behind (see
  /// ensureEngine's liveness check); this is the one sanctioned way to
  /// force it. Safe from any queue: engineLock serializes against
  /// ensureEngine and stopInternal.
  private func discardEngine() {
    engineLock.lock()
    engine?.stop()
    engine = nil
    playerNode = nil
    engineLock.unlock()
  }

  /// Serializes engine/player creation, revival and teardown: ensureEngine
  /// is reached from the MAIN thread (talk path) and the receive queue
  /// (playback path), while stopInternal tears down from the bridge queue
  /// (codex 2026-08-26) — without this lock a teardown can null the pair
  /// mid-ensure and the loser dereferences a corpse.
  private let engineLock = NSLock()

  // ------------------------------------------------------------ audio engine

  /** One engine serves both directions: input tap while talking, player
   * node for received frames. 16 kHz mono float bus converted to/from the
   * wire's PCM16. */
  private func ensureEngine() throws -> AVAudioEngine {
    engineLock.lock()
    defer { engineLock.unlock() }
    if let e = engine {
      // An interruption (a call, Siri) can stop a cached engine; a stopped
      // engine installs taps that never fire. Restart is idempotent.
      if !e.isRunning {
        try? e.start()
      }
      // RUNNING IS NOT ENOUGH (the mini, TF8, 2026-08-26): the syslog
      // showed react-native-webrtc rebuilding the SHARED session around a
      // cached engine (mode flipped to VoiceChat, Bluetooth recording on,
      // a deactivate we never call) — after which isRunning read true,
      // start() kept succeeding, the OS recording light came ON at PTT,
      // and the tap still saw zero buffers forever, while the SAME
      // ordering on a FRESH engine read OK in the mic probe. The corpse's
      // tell is the input hardware format: a dead input element reads
      // 0 Hz. Check it on every reuse; the read itself is an AVFAudio
      // precondition site, so a raise counts as dead, not as a crash.
      var hwRate: Double = 0
      var inputAlive = false
      if e.isRunning {
        let exc = ObjCTry.run { hwRate = e.inputNode.inputFormat(forBus: 0).sampleRate }
        inputAlive = exc == nil && hwRate > 0
      }
      if e.isRunning && inputAlive {
        // A restart can succeed while the PLAYER stays paused: p.play()
        // only ever ran on the create path, so after an interruption's
        // stop every received frame scheduled into a paused node in
        // silence (TF7 field report, 2026-08-26: roster proven at lo-fi,
        // frames arriving, no sound). Reviving it here is idempotent.
        if let p = playerNode, !p.isPlaying {
          p.play()
        }
        // Re-assert the session shape on every reuse: a WebRTC call can
        // move category/mode under a cached engine unnoticed (research
        // 2026-08-26). setActive too — a category set on a session
        // someone else DEACTIVATED (measured in the same syslog) only
        // takes effect at activation. Failing softly is right here — the
        // engine IS running; a refused re-assert must not kill working
        // audio.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
          .playAndRecord, mode: .default, options: [.defaultToSpeaker]
        )
        try? session.setActive(true)
        return e
      }
      // The cached engine is a CORPSE, not paused: either the restart
      // failed outright (measured on the mini 2026-08-25 — a WebRTC
      // call's interruption leaves an engine start() will never revive),
      // or it runs with a dead input element (measured 2026-08-26, the
      // 0 Hz tell above). Returning it anyway is how PTT read "no-audio"
      // while received frames played nothing. Discard and rebuild from
      // scratch below; a rebuild failure THROWS, which the talk path
      // turns into an honest reject.
      NSLog(e.isRunning ? "walkie//input-dead rebuilding" : "walkie//engine-dead rebuilding")
      e.stop()
      engine = nil
      playerNode = nil
    }
    let session = AVAudioSession.sharedInstance()
    // Mode .default, NOT .voiceChat (research 2026-08-26, two citations):
    // without the voice-processing unit actually attached, .voiceChat is
    // documented to REDUCE processing — and the field triple
    // (.playAndRecord/.voiceChat/[.defaultToSpeaker]) is reported to
    // yield ZERO mic buffers on modern iPhones, our exact symptom
    // (hasEchoCancelledInput=NO in the live session logs = we never had
    // AEC to lose; half-duplex covers the walkie, WebRTC brings its own).
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
    try session.setActive(true)
    let e = AVAudioEngine()
    // FIRST-TOUCH THE INPUT NODE BEFORE start() (research 2026-08-26):
    // inputNode is created on demand, and an engine started with an
    // output-only graph never enables the input ELEMENT — the walkie used
    // to start here and only reach for inputNode at talk time, which is
    // the ordering that leaves every later tap silent.
    _ = e.inputNode
    let p = AVAudioPlayerNode()
    e.attach(p)
    let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Self.sampleRate,
      channels: 1,
      interleaved: true
    )!
    e.connect(p, to: e.mainMixerNode, format: format)
    try e.start()
    p.play()
    engine = e
    playerNode = p
    return e
  }

  // ------------------------------------------------------------ talk

  @objc(startTalking:rejecter:)
  func startTalking(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard listener != nil else {
      reject("idle", "walkie is not on", nil)
      return
    }
    AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
      guard let self else { return }
      guard granted else {
        reject("permission", "microphone", nil)
        return
      }
      DispatchQueue.main.async {
        // A second install on a bus that already has a tap is an ObjC
        // NSException — Swift's catch never sees it, the app just dies.
        // A doubled pressIn (gesture hiccup, lost pressOut) therefore
        // crashed the whole app at the PTT button — the exact TestFlight
        // report "PTT attempt failed" (iPhone 13 mini, build 25). Keying
        // while keyed is a no-op, not a crime and not a crash.
        if self.isTalking() {
          resolve(nil)
          return
        }
        do {
          let wireFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: true
          )!
          self.setTalking(true)
          var settled = false
          // One-shot outcome, MAIN-confined: first buffer settles ok
          // (~50 ms when healthy — the resolve gates the panel's
          // "Talking" announce), the 1 s watchdog settles not-ok (a mic
          // held elsewhere installs a tap that never fires, and silent
          // keying is a lie), an install raise settles not-ok with
          // CoreAudio's own words so a field screenshot diagnoses itself.
          let settle: (Bool, String?) -> Void = { [weak self] ok, why in
            guard let self, !settled else { return }
            settled = true
            if ok {
              resolve(nil)
            } else {
              self.setTalking(false)
              self.engine?.inputNode.removeTap(onBus: 0)
              reject(
                "record",
                "The microphone isn't free right now — try again in a moment."
                  + (why.map { " (" + $0 + ")" } ?? ""),
                nil
              )
            }
          }
          // ONE REBUILD-RETRY before rejecting (the mini, TF8,
          // 2026-08-26): ensureEngine's liveness check catches the
          // 0 Hz corpse, but a cached engine can pass every synchronous
          // probe and STILL deliver nothing — the only proof of a live
          // capture path is a buffer actually arriving. So the first
          // silent second discards the cache and re-arms once against a
          // freshly built engine (fresh session activation, input
          // element re-enabled); only a silent second on the FRESH
          // engine is worth reporting to the camper.
          var attemptsLeft = 1
          func arm() throws {
            let e = try self.ensureEngine()
            let input = e.inputNode
            // FORMAT: nil ON PURPOSE (the mini, builds 25 through TF4:
            // every precondition patch — guards, a session bounce —
            // still ended in a raise or a dead pre-read). nil means "the
            // bus's own native format", which cannot mismatch, and the
            // converter is built LAZILY from the first real buffer — no
            // pre-read of input.outputFormat can lie to us. The question
            // CoreAudio kept raising about no longer gets asked.
            input.removeTap(onBus: 0)
            var converter: AVAudioConverter?
            let tapException = ObjCTry.run {
              input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in
                guard let self, self.isTalking() else { return }
                DispatchQueue.main.async { settle(true, nil) }
                let inFmt = buf.format
                guard inFmt.sampleRate > 0 else { return }
                if converter == nil {
                  converter = AVAudioConverter(from: inFmt, to: wireFormat)
                }
                guard let conv = converter else { return }
                let ratio = Self.sampleRate / inFmt.sampleRate
                let capacity = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 16
                guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
                var done = false
                _ = conv.convert(to: out, error: nil) { _, status in
                  if done {
                    status.pointee = .noDataNow
                    return nil
                  }
                  done = true
                  status.pointee = .haveData
                  return buf
                }
                self.sendFrames(out)
              }
            }
            if let tapException {
              settle(false, tapException.reason ?? tapException.name.rawValue)
              return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
              guard !settled else { return }
              if attemptsLeft > 0, self.isTalking() {
                attemptsLeft -= 1
                NSLog("walkie//no-audio rebuild-retry")
                input.removeTap(onBus: 0)
                self.discardEngine()
                do {
                  try arm()
                } catch {
                  settle(false, error.localizedDescription)
                }
                return
              }
              settle(false, "no-audio")
            }
          }
          try arm()
        } catch {
          // ONE catch, carrying the reject. A collided edit left a bare
          // `catch {}` in front of this one (Swift stacks catch clauses
          // with only a warning), so every ensureEngine throw was
          // swallowed and the PTT promise neither resolved nor rejected —
          // found by the 2026-08-26 research pass, fixed for TF8.
          reject("record", error.localizedDescription, error)
        }
      }
    }
  }

  @objc(stopTalking:rejecter:)
  func stopTalking(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // Off the main queue (RN's native-modules queue), which is the whole
    // reason this flag is locked: the tap closure reading it runs on the
    // audio thread and startTalking writes it on main.
    setTalking(false)
    engine?.inputNode.removeTap(onBus: 0)
    resolve(nil)
  }

  /// The call's grip on the walkie SPEAKER (docs/VIDEO-CALLS.md §5): JS
  /// sets true while a call is connecting/live and false on every call-end
  /// arc; handleFrame drops playback while it holds. The walkie stays ON —
  /// peers, signaling and the seq gates all keep running. Mirrors
  /// WalkieModule.kt setCallActive; a test reads both files.
  @objc(setCallActive:resolver:rejecter:)
  func setCallActive(
    _ active: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      setCallActiveFlag(active)
      // Mirror of the Android route (owner field report: call audio
      // whisper-quiet while the walkie is loud): WebRTC re-activates the
      // session in voice-chat mode without defaultToSpeaker, so the call
      // is pushed to the loudspeaker for its duration and released after.
      let session = AVAudioSession.sharedInstance()
      try? session.overrideOutputAudioPort(active ? .speaker : .none)
      if !active {
        // The call's WebRTC stack rebuilt the shared session around us —
        // measured on the mini 2026-08-26: mode flipped to VoiceChat +
        // Bluetooth recording, then a deactivate we never call — and a
        // cached engine that lived through that keeps a dead input
        // element while isRunning reads true. Drop the cache at call end
        // so the next PTT or received frame rebuilds against the session
        // as it actually is, instead of inheriting the corpse.
        discardEngine()
      }
      resolve(nil)
    }
  }

  // ------------------------------------------------------------ diagnosis

  /**
   Our own IPv4 + CIDR prefix on the Wi-Fi interface (en0; bridge* when
   this phone hosts a Personal Hotspot), or nil when neither carries one —
   the walkie panel's cross-subnet diagnosis (field test #8: two routers
   behind one network name). Mirrors Android's netInfo. getifaddrs needs
   no entitlement. Rejects on failure — "can't tell" must never masquerade
   as "no Wi-Fi".
   */
  @objc(netInfo:rejecter:)
  func netInfo(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0 else {
      reject("walkie", "could not read the network", nil)
      return
    }
    defer { freeifaddrs(ifaddr) }
    var best: (rank: Int, ip: String, prefix: Int)?
    var cursor = ifaddr
    while let entry = cursor {
      let ifa = entry.pointee
      cursor = ifa.ifa_next
      guard let sa = ifa.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET),
            ifa.ifa_flags & UInt32(IFF_UP) != 0,
            ifa.ifa_flags & UInt32(IFF_LOOPBACK) == 0
      else { continue }
      let name = String(cString: ifa.ifa_name)
      // en0 is the Wi-Fi client interface on every iPhone; bridge* is this
      // phone hosting a Personal Hotspot. Cellular (pdp_ip*), VPN (utun*)
      // and AWDL are not LANs the walkie can ride.
      let rank = name == "en0" ? 0 : name.hasPrefix("bridge") ? 1 : -1
      guard rank >= 0, rank < (best?.rank ?? Int.max) else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(
        sa, socklen_t(sa.pointee.sa_len),
        &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST
      ) == 0 else { continue }
      var prefix = 0
      if let mask = ifa.ifa_netmask, mask.pointee.sa_family == sa_family_t(AF_INET) {
        var sin = sockaddr_in()
        memcpy(&sin, mask, MemoryLayout<sockaddr_in>.size)
        // A contiguous netmask's popcount IS the prefix, byte order aside.
        prefix = sin.sin_addr.s_addr.nonzeroBitCount
      }
      best = (rank, String(cString: host), prefix)
    }
    guard let found = best else {
      resolve(nil)
      return
    }
    resolve(["ip": found.ip, "prefix": found.prefix])
  }

  /**
   Unicast one call-signal payload (a codecCall frame) to the peer with
   this senderHash, over whatever path already reaches them — their
   Bonjour connection or their Aware link, exactly like voice. Loss is the
   JS reliable layer's job; this only refuses what can never work.

   `fanout` is BREADTH: how many of that podmate's datagram rows this one
   payload may ride, best-proven first, clamped to maxSignalFanout
   (docs/VIDEO-CALLS.md §2a). The JS signaler sends first tries as singles
   and retransmissions as twos, because a retransmission means the road we
   picked is not delivering — and the measured failure was a road, not a
   moment: eight retransmits into one silently dead interface, none of them
   erroring. The receiver dedupes by message id, so the extra copy costs
   one datagram and nothing else.
   */
  @objc(sendSignal:payload:fanout:resolver:rejecter:)
  func sendSignal(
    _ toHashD: NSNumber,
    payload payloadB64: String,
    fanout fanoutD: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // Main owns `peers` (see recomputeTargets) — signaling joins the same
    // discipline rather than adding a second thread to the dictionary.
    DispatchQueue.main.async { [self] in
      guard listener != nil else {
        reject("idle", "walkie is not on", nil)
        return
      }
      let to = UInt32(truncating: toHashD)
      // DATAGRAM-CAPABLE ONLY, best rung first — the same rungRank rule
      // the roster lives by (mirror of WalkieModule.sendSignal): a
      // podmate on Wi-Fi AND in BLE range holds both rows for one hash,
      // and the "ble" row is a voice pipe, not an address this can dial.
      // A BLE-only hash finds nothing here ON PURPOSE: emitPeers never
      // offered it as a callable identity, so this is the stale-roster
      // case, not a path.
      let now = Date()
      // BY PROOF FIRST (§5): rank() puts every unproven row below every
      // proven one, so a podmate whose aware datapath went quiet is dialed
      // on their live LAN row instead. The rank used to trust the row's
      // rung word alone, and the row was the thing that was lying.
      let rows = peers
        .filter({ $0.value.senderHash == to && $0.value.bleSend == nil })
        .sorted(by: { rank($0.value, now) < rank($1.value, now) })
      guard !rows.isEmpty else {
        reject("gone", "that podmate is not on the channel", nil)
        return
      }
      // Only PROVEN rows carry a signal, and only as many as asked for.
      // The seen-set is the mirror of Kotlin's distinctBy on host:port —
      // two rows for one person can resolve to one address (a rename mints
      // a new key on the same endpoint), and the same datagram twice down
      // one road is a hedge's cost with none of its benefit.
      let breadth = max(1, min(fanoutD.intValue, Self.maxSignalFanout))
      var seen = Set<String>()
      var chosen: [(key: String, value: Peer)] = []
      for row in rows where proven(row.value, now) {
        let road = row.value.awareSend != nil
          ? "aware"
          : String(describing: row.value.endpoint)
        if seen.insert(road).inserted {
          chosen.append(row)
        }
        if chosen.count >= breadth {
          break
        }
      }
      guard !chosen.isEmpty else {
        // NO PROVEN PATH. Sending here is what the field measured on
        // Android: eight retransmits into a downed interface, every one of
        // them "sent" without an error, and a caller told "No answer" about
        // a phone that never heard a thing. A reject is the same loss to
        // the reliable layer above and the truth to everyone else — and the
        // JS side reads THIS code to widen its next sends instead of
        // retrying the same dead row.
        reject("stale", "that podmate's link went quiet", nil)
        return
      }
      guard let data = Data(base64Encoded: payloadB64),
            data.count <= Self.frameSamples * 2 else {
        // Android's receive buffer is HEADER + FRAME_BYTES; a longer
        // payload would arrive there TRUNCATED, not rejected — refuse it
        // here so the failure is loud and local.
        reject("size", "bad signal payload", nil)
        return
      }
      // ONE FRAME, ONE SEQ, N ROADS. The copies are the SAME message; the
      // signal path skips the audio seq gate anyway (§2) and the receiver
      // dedupes by the message id the payload already carries.
      var frame = Data(capacity: Self.header + data.count)
      frame.append(contentsOf: [0x50, 0x57]) // 'PW'
      frame.append((Self.frameVersion << 4) | Self.codecCall)
      frame.append(contentsOf: be32(podHash))
      frame.append(contentsOf: be32(senderHash))
      let seq = nextSeq()
      frame.append(contentsOf: [UInt8(seq >> 8), UInt8(seq & 0xFF)])
      frame.append(data)
      var sent = 0
      for row in chosen {
        var peer = row.value
        if let aware = peer.awareSend {
          aware(frame)
          sent += 1
          continue
        }
        if peer.connection == nil, let endpoint = peer.endpoint {
          // A peer beyond the voice cap has no dialed connection yet — a
          // targeted signal dials one, on main, recomputeTargets' rule.
          let c = NWConnection(to: endpoint, using: .udp)
          c.start(queue: .main)
          peer.connection = c
          peers[row.key] = peer
        }
        // A hedge exists because one road can be bad: an undialable row
        // must not cost the other row its copy.
        guard let c = peer.connection else { continue }
        c.send(content: frame, completion: .contentProcessed { _ in })
        sent += 1
      }
      guard sent > 0 else {
        reject("gone", "no path to that podmate", nil)
        return
      }
      resolve(nil)
    }
  }

  /**
   THE KEEP-ALIVE + STALENESS SWEEP (docs/WALKIE-LADDER.md §5b), mirror of
   WalkieModule.probeLoop — what makes silence mean death instead of
   idleness. Without it, "no inbound for 10 s" is the normal state of a
   walkie nobody is talking on. MAIN, like everything that touches `peers`.

   One fixed cadence, no dial storms: the sweep ticks faster than the probe
   so a demotion reaches the badge promptly, while probing stays
   clock-driven and bounded by the peer count.
   */
  private func sweep() {
    guard listener != nil else { return }
    let now = Date()
    let probing = now.timeIntervalSince(lastProbe) >= Self.probeSeconds
    if probing {
      lastProbe = now
    }
    var unproven = Set<String>()
    for (key, p) in peers where p.bleSend == nil {
      if probing {
        sendProbe(key)
      }
      if !proven(p, now) {
        unproven.insert(key)
      }
    }
    // EMIT ON CHANGE ONLY: a demotion and a re-promotion are both events
    // the panel must see; a 2 s heartbeat of identical peer events is not.
    if unproven != unprovenRows {
      unprovenRows = unproven
      emitPeers()
    }
  }

  /// One zero-payload PW frame to one row — §5 step 3's probe, now also the
  /// keep-alive. Dials the peer's connection if the roster never did (a
  /// podmate past the voice cap), exactly as sendSignal does. MAIN.
  private func sendProbe(_ key: String) {
    guard var p = peers[key] else { return }
    var frame = Data(capacity: Self.header)
    frame.append(contentsOf: [0x50, 0x57]) // 'PW'
    frame.append((Self.frameVersion << 4) | Self.codecProbe)
    frame.append(contentsOf: be32(podHash))
    frame.append(contentsOf: be32(senderHash))
    let seq = nextSeq()
    frame.append(contentsOf: [UInt8(seq >> 8), UInt8(seq & 0xFF)])
    if let aware = p.awareSend {
      aware(frame)
      return
    }
    if p.connection == nil, let endpoint = p.endpoint {
      let c = NWConnection(to: endpoint, using: .udp)
      c.start(queue: .main)
      p.connection = c
      peers[key] = p
    }
    p.connection?.send(content: frame, completion: .contentProcessed { _ in })
  }

  private func sendFrames(_ buf: AVAudioPCMBuffer) {
    guard let data = buf.int16ChannelData?[0] else { return }
    let total = Int(buf.frameLength)
    var offset = 0
    while offset < total {
      let n = min(Self.frameSamples, total - offset)
      var frame = Data(capacity: Self.header + n * 2)
      frame.append(contentsOf: [0x50, 0x57]) // 'PW'
      frame.append(Self.frameHead)
      frame.append(contentsOf: be32(podHash))
      frame.append(contentsOf: be32(senderHash))
      let seq = nextSeq()
      frame.append(contentsOf: [UInt8(seq >> 8), UInt8(seq & 0xFF)])
      data.advanced(by: offset).withMemoryRebound(to: UInt8.self, capacity: n * 2) { p in
        frame.append(p, count: n * 2)
      }
      // BOUNDED FAN-OUT (see maxPeers): enforced HERE, on the hot path, not
      // in the UI — a JS-side-only cap would still let a 60-person pod melt
      // the radio the moment the panel was wrong.
      //
      // This loop touches NO dictionary and allocates nothing beyond the
      // frame itself. The snapshot was built on main (recomputeTargets)
      // with its send paths already open — Bonjour connection, Aware link
      // or BLE pipe alike — so the render thread does one locked pointer
      // copy and then sends. That is the whole fix for the data race.
      var anyBle = false
      for t in currentTargets() {
        if t.isBle {
          // Rung 3 rides the 60 ms lane below — a 653-byte PCM frame does
          // not fit a GATT write, and the whole rung exists because the
          // codec changes, not the frame (WalkieModule.kt, mirrored).
          anyBle = true
          continue
        }
        t.send(frame)
      }
      if anyBle {
        var i = 0
        while i < n, bleFill < bleSamples.count {
          bleSamples[bleFill] = data[offset + i]
          bleFill += 1
          i += 1
        }
        if bleFill >= bleSamples.count {
          // Same seq as the PCM lane ON PURPOSE: a podmate hearing this
          // phone on two rungs at once plays whichever copy lands first
          // and the per-sender seq gate drops the other — dedupe for
          // free, no negotiation (WalkieModule.kt, mirrored).
          let payload = AdpcmCodec.encode(downsample(bleSamples))
          var f = Data(capacity: Self.header + payload.count)
          f.append(contentsOf: [0x50, 0x57]) // 'PW'
          f.append((Self.frameVersion << 4) | Self.codecAdpcm8k)
          f.append(contentsOf: be32(podHash))
          f.append(contentsOf: be32(senderHash))
          f.append(contentsOf: [UInt8(seq >> 8), UInt8(seq & 0xFF)])
          f.append(payload)
          for t in currentTargets() where t.isBle {
            t.send(f)
          }
          bleFill = 0
        }
      } else {
        bleFill = 0
      }
      offset += n
    }
  }

  private func be32(_ v: UInt32) -> [UInt8] {
    [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  /// 16 -> 8 kHz by pair-averaging: the cheapest anti-alias there is, and
  /// the right cost for the audio tap thread — rung 3 is lo-fi by
  /// contract (WalkieModule.downsample, mirrored).
  private func downsample(_ pcm: [Int16]) -> [Int16] {
    var out = [Int16](repeating: 0, count: pcm.count / 2)
    for i in 0 ..< out.count {
      out[i] = Int16((Int(pcm[2 * i]) + Int(pcm[2 * i + 1])) / 2)
    }
    return out
  }

  /// 8 -> 16 kHz: each source sample emits itself and the midpoint to its
  /// successor, PCM16LE, so rung 3 rides the same 16 kHz player as rung 4
  /// — one player, one volume story. WalkieModule.upsampleWithGain minus
  /// the gain: RX_GAIN cures an Android AudioTrack routing problem this
  /// player never had, and rung 3 must match rung 4's volume on THIS
  /// platform, not Android's.
  private func upsample(_ pcm: [Int16]) -> Data {
    var out = Data(capacity: pcm.count * 4)
    for i in 0 ..< pcm.count {
      let cur = Int(pcm[i])
      let nxt = Int(pcm[i + 1 < pcm.count ? i + 1 : i])
      let mid = (cur + nxt) / 2
      out.append(UInt8(cur & 0xFF))
      out.append(UInt8((cur >> 8) & 0xFF))
      out.append(UInt8(mid & 0xFF))
      out.append(UInt8((mid >> 8) & 0xFF))
    }
    return out
  }

  // ------------------------------------------------------------ receive

  private func receiveLoop(_ conn: NWConnection) {
    conn.receiveMessage { [weak self] data, _, _, error in
      guard let self else { return }
      // `>=`, not `>`: the ladder's probe (§5 step 3, and now the
      // keep-alive) is a frame with a ZERO-LENGTH payload, so a full header
      // IS a whole valid frame. Rejecting it here is what left the probe
      // unreachable on this platform after Android made it real.
      if let data, data.count >= Self.header {
        self.handleFrame(data, lane: "lan")
      }
      if error == nil, self.listener != nil {
        self.receiveLoop(conn)
      }
    }
  }

  /// `lane` is which rung delivered this frame — the iOS spelling of
  /// WalkieModule's source-socket rule. It picks the ROW to stamp, so a
  /// podmate's live LAN row can never vouch for their dead aware row.
  private func handleFrame(_ d: Data, lane: String) {
    let b = [UInt8](d)
    // A full header with no payload is a valid frame (the probe); shorter
    // than that cannot be indexed safely.
    guard b.count >= Self.header, b[0] == 0x50, b[1] == 0x57 else { return }
    guard (b[2] >> 4) == Self.frameVersion else { return }
    let pod = (UInt32(b[3]) << 24) | (UInt32(b[4]) << 16) | (UInt32(b[5]) << 8) | UInt32(b[6])
    guard pod == podHash else { return }
    let from = (UInt32(b[7]) << 24) | (UInt32(b[8]) << 16) | (UInt32(b[9]) << 8) | UInt32(b[10])
    guard from != senderHash else { return }
    // §5's PROOF, taken on every rung's every frame — voice, probe, signal
    // alike, and before any gate below can drop it: a probe dies at the
    // unknown-codec gate and a stale seq dies at the freshness gate, and
    // BOTH still prove the row is alive. Value semantics mean the loop
    // iterates a copy, so writing back into `peers` here is safe; main owns
    // it either way (mirror of WalkieModule.stampInbound).
    let stamped = Date()
    for (key, p) in peers where p.senderHash == from && p.rung == lane {
      var row = p
      row.lastInbound = stamped
      peers[key] = row
    }
    // Call signaling (docs/VIDEO-CALLS.md): opaque bytes up to JS. No seq
    // gate on purpose — freshness gating is for audio; the signal layer
    // dedupes by its own message ids, and a dropped ack RELIES on the
    // retransmit arriving.
    if (b[2] & 0x0F) == Self.codecCall {
      sendEvent(withName: Self.signalEvent, body: [
        "from": String(from, radix: 16),
        "payload": d.subdata(in: Self.header ..< d.count).base64EncodedString(),
      ])
      return
    }
    // Unknown codec = DROP, never play. An unrecognised payload fed to a
    // PCM16 track is not degraded audio, it is noise at whatever volume
    // the pod is holding to its ear. Two codecs are known now: rung 4's
    // PCM16 and rung 3's ADPCM.
    guard (b[2] & 0x0F) == Self.codecPcm16_16k || (b[2] & 0x0F) == Self.codecAdpcm8k else {
      return
    }
    // An audio codec with no payload is malformed, not a probe: it has
    // already done its liveness work above, and there is nothing to play.
    guard b.count > Self.header else { return }
    let sq = (UInt16(b[11]) << 8) | UInt16(b[12])
    if let last = lastSeq[from] {
      let diff = sq &- last
      if diff == 0 || diff > 0x8000 {
        return
      }
    }
    lastSeq[from] = sq
    if playbackMuted() {
      // Mute walkie PLAYBACK while a call is connecting/live: this
      // loudspeaker feeds the call's open mic, so pod voice played here
      // is relayed to the person on the call. Seq bookkeeping above still
      // ran, so playback resumes cleanly at hang-up.
      //
      // ...and while THIS phone is keying (half-duplex, like every radio
      // ever made): with two phones a foot apart, played-back pod voice
      // re-entered the still-open mic and the loop went over unity — the
      // owner heard the howl from another room. Not hearing the channel
      // while you hold the button is what a walkie IS; releasing resumes
      // playback on the same clean-seq terms as hang-up.
      return
    }
    guard let e = try? ensureEngine(), let p = playerNode else { return }
    _ = e // engine held alive by the property
    let pcm: Data
    if (b[2] & 0x0F) == Self.codecAdpcm8k {
      // Rung 3: decode, upsample 8 -> 16 kHz, same player node — a lo-fi
      // speaker sounds rougher, never different in kind.
      let lofi = AdpcmCodec.decode(b, at: Self.header, count: b.count - Self.header)
      guard !lofi.isEmpty else { return }
      pcm = upsample(lofi)
    } else {
      pcm = d.subdata(in: Self.header ..< d.count)
    }
    let frames = AVAudioFrameCount(pcm.count / 2)
    let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Self.sampleRate,
      channels: 1,
      interleaved: true
    )!
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
    buf.frameLength = frames
    pcm.withUnsafeBytes { raw in
      if let base = raw.baseAddress, let dst = buf.int16ChannelData?[0] {
        memcpy(dst, base, pcm.count)
      }
    }
    // A stop can detach this node between ensureEngine and here (receive
    // thread vs bridge thread), and scheduling on a detached node RAISES —
    // a crash reachable from NETWORK INPUT, the exact class the ObjCTry
    // law exists for. A caught raise costs one frame.
    _ = ObjCTry.run {
      p.scheduleBuffer(buf, completionHandler: nil)
    }
    if Date().timeIntervalSince(lastSpeakEmit) > 1 {
      lastSpeakEmit = Date()
      let name = peers.values.first { $0.senderHash == from }?.name ?? "someone"
      sendEvent(withName: Self.speakingEvent, body: ["name": name, "podHash": Double(podHash)])
    }
  }
}
