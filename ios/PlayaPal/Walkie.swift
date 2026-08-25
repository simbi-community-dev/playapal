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

 CONSENT: the mic runs ONLY between startTalking/stopTalking — the held
 button is the consent surface; the OS mic ask fires on the first
 startTalking (NSMicrophoneUsageDescription, already in the plist for
 voice notes).

 Events (same names as Android):
   WalkiePeers    { count, names }
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
  private static let frameHead: UInt8 = (frameVersion << 4) | codecPcm16_16k

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
  private static let peersEvent = "WalkiePeers"
  private static let speakingEvent = "WalkieSpeaking"

  private struct Peer {
    let endpoint: NWEndpoint
    let name: String
    let senderHash: UInt32
    var connection: NWConnection?
  }

  private var listener: NWListener?
  private var browser: NWBrowser?
  private var peers: [String: Peer] = [:] // key = bonjour instance name
  private var podHash: UInt32 = 0
  private var senderHash: UInt32 = 0
  private var seq: UInt16 = 0
  private var lastSeq: [UInt32: UInt16] = [:]
  private var lastSpeakEmit = Date.distantPast
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var talking = false
  private var myName = ""

  @objc
  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [Self.peersEvent, Self.speakingEvent]
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
    let connection: NWConnection
  }

  /// Written on MAIN only, read on the audio thread under `targetsLock`.
  private var targets: [Target] = []
  private let targetsLock = NSLock()

  /// A pointer copy under a lock — no allocation, no dictionary, bounded.
  private func currentTargets() -> [Target] {
    targetsLock.lock()
    let t = targets
    targetsLock.unlock()
    return t
  }

  /**
   Recompute the snapshot. MAIN THREAD ONLY. Connections are created HERE, as
   a peer ENTERS the target set — never lazily on the audio thread, which is
   what made the old code write to a dictionary it was also iterating.
   */
  private func recomputeTargets() {
    let chosen = peers.keys
      .sorted { (peers[$0]?.senderHash ?? 0) < (peers[$1]?.senderHash ?? 0) }
      .prefix(Self.maxPeers)
    var next: [Target] = []
    next.reserveCapacity(chosen.count)
    for name in chosen {
      guard var peer = peers[name] else { continue }
      if peer.connection == nil {
        let c = NWConnection(to: peer.endpoint, using: .udp)
        c.start(queue: .main)
        peer.connection = c
        peers[name] = peer // safe: main owns `peers`
      }
      if let c = peer.connection {
        next.append(Target(connection: c))
      }
    }
    targetsLock.lock()
    targets = next
    targetsLock.unlock()
  }

  private func emitPeers() {
    recomputeTargets()
    sendEvent(withName: Self.peersEvent, body: [
      "count": peers.count,
      // What we will actually reach. The panel needs BOTH: "12 people are
      // here but you are talking to 9" cannot be derived from count by a JS
      // side that does not know the cap.
      "talkingTo": min(peers.count, Self.maxPeers),
      "names": peers.values.map { $0.name },
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
          let label = bits.count > 2 ? bits[2] : "someone"
          if let existing = self.peers[name] {
            next[name] = existing
          } else {
            next[name] = Peer(endpoint: r.endpoint, name: label, senderHash: hash, connection: nil)
          }
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
    talking = false
    listener?.cancel()
    listener = nil
    browser?.cancel()
    browser = nil
    for (_, p) in peers {
      p.connection?.cancel()
    }
    peers.removeAll()
    targetsLock.lock()
    targets = []
    targetsLock.unlock()
    lastSeq.removeAll()
    engine?.stop()
    engine = nil
    playerNode = nil
  }

  // ------------------------------------------------------------ audio engine

  /** One engine serves both directions: input tap while talking, player
   * node for received frames. 16 kHz mono float bus converted to/from the
   * wire's PCM16. */
  private func ensureEngine() throws -> AVAudioEngine {
    if let e = engine { return e }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
    try session.setActive(true)
    let e = AVAudioEngine()
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
        do {
          let e = try self.ensureEngine()
          let input = e.inputNode
          let inFormat = input.outputFormat(forBus: 0)
          let wireFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: true
          )!
          let converter = AVAudioConverter(from: inFormat, to: wireFormat)!
          self.talking = true
          input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buf, _ in
            guard let self, self.talking else { return }
            let ratio = Self.sampleRate / inFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 16
            guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
            var done = false
            _ = converter.convert(to: out, error: nil) { _, status in
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
          resolve(nil)
        } catch {
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
    talking = false
    engine?.inputNode.removeTap(onBus: 0)
    resolve(nil)
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
      seq = seq &+ 1
      frame.append(contentsOf: [UInt8(seq >> 8), UInt8(seq & 0xFF)])
      data.advanced(by: offset).withMemoryRebound(to: UInt8.self, capacity: n * 2) { p in
        frame.append(p, count: n * 2)
      }
      // BOUNDED FAN-OUT (see maxPeers): enforced HERE, on the hot path, not
      // in the UI — a JS-side-only cap would still let a 60-person pod melt
      // the radio the moment the panel was wrong.
      // BOUNDED FAN-OUT (see maxPeers): enforced HERE, on the hot path, not
      // in the UI — a JS-side-only cap would still let a 60-person pod melt
      // the radio the moment the panel was wrong.
      //
      // This loop touches NO dictionary and allocates NOTHING. The snapshot
      // was built on main (recomputeTargets) with its connections already
      // open, so the render thread does one locked pointer copy and then
      // sends. That is the whole fix for the data race.
      for t in currentTargets() {
        t.connection.send(content: frame, completion: .contentProcessed { _ in })
      }
      offset += n
    }
  }

  private func be32(_ v: UInt32) -> [UInt8] {
    [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  // ------------------------------------------------------------ receive

  private func receiveLoop(_ conn: NWConnection) {
    conn.receiveMessage { [weak self] data, _, _, error in
      guard let self else { return }
      if let data, data.count > Self.header {
        self.handleFrame(data)
      }
      if error == nil, self.listener != nil {
        self.receiveLoop(conn)
      }
    }
  }

  private func handleFrame(_ d: Data) {
    let b = [UInt8](d)
    guard b[0] == 0x50, b[1] == 0x57 else { return }
    // Version and codec, before anything is trusted or played. An unknown
    // codec fed to a PCM16 track is not degraded audio, it is noise at
    // whatever volume the pod is holding to its ear.
    guard (b[2] >> 4) == Self.frameVersion else { return }
    guard (b[2] & 0x0F) == Self.codecPcm16_16k else { return }
    let pod = (UInt32(b[3]) << 24) | (UInt32(b[4]) << 16) | (UInt32(b[5]) << 8) | UInt32(b[6])
    guard pod == podHash else { return }
    let from = (UInt32(b[7]) << 24) | (UInt32(b[8]) << 16) | (UInt32(b[9]) << 8) | UInt32(b[10])
    guard from != senderHash else { return }
    let sq = (UInt16(b[11]) << 8) | UInt16(b[12])
    if let last = lastSeq[from] {
      let diff = sq &- last
      if diff == 0 || diff > 0x8000 {
        return
      }
    }
    lastSeq[from] = sq
    guard let e = try? ensureEngine(), let p = playerNode else { return }
    _ = e // engine held alive by the property
    let pcm = d.subdata(in: Self.header ..< d.count)
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
    p.scheduleBuffer(buf, completionHandler: nil)
    if Date().timeIntervalSince(lastSpeakEmit) > 1 {
      lastSpeakEmit = Date()
      let name = peers.values.first { $0.senderHash == from }?.name ?? "someone"
      sendEvent(withName: Self.speakingEvent, body: ["name": name, "podHash": Double(podHash)])
    }
  }
}
