import Foundation
import React

#if canImport(WiFiAware)
import Network
import WiFiAware
#endif

/**
 Wi-Fi Aware — rung 4 of the connectivity ladder (docs/WALKIE-LADDER.md §9),
 iOS half. Mirrors `WifiAwareModule.kt` (the probe) and `WalkieAwareLink.kt`
 (the transport) — this file now carries BOTH.

 THE PROBE (this class) ANSWERS EXACTLY ONE QUESTION AND TOUCHES NO RADIO:

     Does this phone have Wi-Fi Aware at all?

 No publish, no subscribe, no data path, no permission ask, nothing started.
 The transport lives in `WalkieAwareLink` below and starts only when the
 walkie itself starts (Walkie.swift owns its lifecycle) — the probe stays
 inert.

 THE THREE FALSES, kept apart on purpose (same reasoning as the Android half,
 where the split is hardware-vs-runtime):
   - `reason: "os-too-old"` — Apple opened Wi-Fi Aware to third-party apps in
     iOS 26. Every earlier iPhone is BLE-only FOREVER, which is precisely why
     the BLE floor is permanent and never a legacy path to retire.
   - `reason: "no-framework"` — built against an SDK that predates the
     framework. A build fact, not a device fact.
   - `reason: "unsupported"` — iOS 26 and the framework are both here and the
     device still says no.
 One boolean would collapse a permanent limitation and a stale build into the
 same sentence, and only one of them is worth telling a user about.

 DECLARED NOW: the probe's earlier revision refused to add the
 `WiFiAwareServices` Info.plist key because declaring a service this build
 did not implement would be a lie shipped in a plist. This build implements
 the data path, so the key is in Info.plist (with the
 `com.apple.developer.wifi-aware` entitlement beside it) — exactly the
 moment that comment promised.

 AVAILABILITY IS NOT CAPABILITY (ladder §5): even `true` here says nothing
 about reaching a given peer in the next thirty seconds. Nothing may promote a
 peer's rung on the strength of this call — promotion needs a round trip.

 UNVERIFIED ON THIS BOX: there is no macOS or Xcode 26 in this environment, so
 everything under `canImport(WiFiAware)` is written from Apple's iOS 26
 documentation ("Building peer-to-peer apps") and has NOT been compiled. The
 `canImport` guard means a wrong symbol cannot break a build that lacks the
 framework, but it CAN break the first build that has it — the EAS compile is
 where this gets confirmed, and every uncertain call sits in the marked
 adapter section of `WalkieAwareLink` with an `EAS-VERIFY` comment naming what
 to check.
 */
/**
 One greppable prefix for the whole rung, `aware//`, deliberately the same
 one `WalkieAwareLink.kt` writes to Logcat — a field report from either
 platform is read with the same eye and the same search string.

 THE GAP THIS CLOSES (2026-08-26 research sweep): this file shipped with
 no logging at all, so five different diagnoses arrived wearing one
 symptom — no peers. Framework absent, iOS older than 26, the entitlement
 missing from the profile, the `WiFiAwareServices` plist name not matching
 the service string, the listener or browser failing to start, and the
 honest answer today (nobody is paired, because the app ships no pairing
 UI) were indistinguishable from each other and from a working rung with
 nobody nearby. Every one of them now says its own sentence.

 `NSLog("%@", …)` and never `NSLog(msg)`: peer names arrive off the wire
 and a name containing a percent sign would otherwise be read as a format
 string.

 INTERNAL, not private, since 2026-08-26: `WifiAwarePairing.swift` writes the
 pairing ceremony's arc with this same prefix. One prefix, one writer, one
 search string — a second copy would be a second place for the prefix to
 drift.
 */
func awareLog(_ line: String) {
  NSLog("%@", "aware//" + line)
}

@objc(WifiAware)
final class WifiAware: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /**
   The probe. Never rejects: "this phone cannot" is an ANSWER, not an error.
   A rejection would read to JS as "the probe is broken", which is the one
   reading that sends someone hunting a bug instead of recording a
   measurement.
   */
  @objc(describe:rejecter:)
  func describe(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    var out: [String: Any] = [
      "platform": "ios",
      "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
      "hardware": false,
      "available": false,
      "reason": "unsupported",
    ]

    #if canImport(WiFiAware)
      if #available(iOS 26.0, *) {
        let supported = WACapabilities.supportedFeatures.contains(.wifiAware)
        out["hardware"] = supported
        // The framework exposes device support, not a live radio state the
        // way Android's isAvailable() does. Reporting `available` equal to
        // `hardware` would be inventing a signal; the honest position is that
        // on iOS the only thing that proves reachability is a round trip, and
        // §5 already requires one.
        out["available"] = supported
        out["reason"] = supported ? "ok" : "unsupported"
      } else {
        out["reason"] = "os-too-old"
      }
    #else
      out["reason"] = "no-framework"
    #endif

    // The probe's answer is the FIRST fork of every later diagnosis, so it
    // is on the record before anything touches a radio: a rung that
    // contributes no peers because the silicon says no is a different
    // report from one that contributes none because nobody is paired.
    awareLog(
      "probe hardware=" + String(describing: out["hardware"] ?? false)
        + " available=" + String(describing: out["available"] ?? false)
        + " reason=" + String(describing: out["reason"] ?? "")
    )
    resolve(out)
  }
}

#if canImport(WiFiAware)

/**
 CANCELLATION IS NOT A FAILURE (2026-08-26 review). Every long-running half
 of this rung — publisher, browser, paired-watch, and each link's intro
 sender — is stopped the only way Apple provides: by cancelling the Task
 that wraps it (there is no stop() on a NetworkListener). So the two most
 ORDINARY events in the rung's life both arrive as a thrown error in the
 same catch as a real fault:

   - the walkie going off (`stop()`), and
   - a camper pairing a phone (`rearm()`, which cancels and relaunches both
     halves on the happy path, by design).

 Logged as `publish-failed` / `subscribe-failed`, a successful pairing
 prints this rung's failure sentence — twice — and a field bench reading
 `aware//` and nothing else has been told the radio broke at the exact
 moment it did what it was asked. One word separates them, and this is it.

 TWO TELLS, because a cancelled `await` may throw Swift's own
 `CancellationError` OR the framework's own cancelled-operation error:
 EAS-VERIFY: which one a cancelled NetworkListener/NetworkBrowser `run`
 actually throws on iOS 26. `Task.isCancelled` is the belt that covers the
 case where it is not `CancellationError`, and it also covers the half that
 RETURNS rather than throwing after a cancel.
 */
private func awareStopped(_ half: String, _ error: Error? = nil) -> Bool {
  let byUs = Task.isCancelled || (error.map { $0 is CancellationError } ?? false)
  guard byUs else { return false }
  awareLog(half + "-stopped — cancelled by stop or rearm; not a failure")
  return true
}

/**
 The walkie's OWN-LINK rung (docs/WALKIE-LADDER.md §9, rung 4's second
 radio), iOS 26 half. Mirrors
 `android/app/src/main/java/com/playapal/WalkieAwareLink.kt` — read that
 file for the full design; this comment records the contract and the places
 Apple's model forces a different shape.

 THE CONTRACT (identical to Android): every phone both PUBLISHES and
 SUBSCRIBES one service ("playapal-walkie"); matches are scoped by podHash;
 each discovered pair keeps exactly ONE deterministic link (the LOWER
 senderHash RESPONDS — both phones agree without a message); PW voice frames
 flow over UDP byte-identically — the rung changes the socket, never the
 frame; and every failure path ends in "this rung contributes no peers" —
 the LAN and BLE rungs are untouched.

 WHERE iOS DIFFERS, AND WHY:

 - PAIRING, NOT PSK. Android derives a datapath PSK from the pod code.
   Apple exposes no app-supplied credential: Wi-Fi Aware links form ONLY
   between OS-paired devices (DeviceDiscoveryUI / AccessorySetupKit), and
   the OS owns the link crypto. The admission story becomes two gates in
   series — OS pairing gates the RADIO, the podHash gates the POD — and
   either alone admits nothing. Until two phones are paired this rung
   simply contributes no peers, which is the invariant, not a failure. The
   pairing surface (DevicePairingView / DevicePicker) is NOT smuggled into
   this transport class — it lives in `WifiAwarePairing.swift`, and since
   2026-08-26 it EXISTS. What this class owes it is the seam below:
   `runPairedWatch`, which turns "a pair was made" into a restarted
   publisher and browser, because Apple never activates a listener with an
   empty device set and nothing else would ever restart one.

 - INTRO, NOT SSI. Android's discovery carries a service-specific-info
   blob; Apple's carries no app payload. The same bytes ('PA' + podHash(4
   BE) + senderHash(4 BE) + utf8 name — Android's ssi(), byte for byte)
   ride as the FIRST datagram on each established connection instead,
   retried against UDP loss. Pod scoping therefore happens post-connect —
   the earliest point the API allows — and a wrong-pod link is torn down
   before any peer is handed up.

 - A SEND CLOSURE, NOT (ADDRESS, PORT, SOCKET). Android hands address
   triples to one shared UDP fabric; Apple's aware datapath is reachable
   only through its own NetworkConnection. So the peer table receives a
   per-peer type-erased send closure, and inbound datagrams are forwarded
   to the same handleFrame the LAN socket feeds. The PW frame is untouched.

 - DEDUP BY ROLE, POST-HOC. Symmetric publish+subscribe can form two links
   per pair (my browser dials them, theirs dials me). Android prevents the
   twin a priori because it knows the peer hash at discovery; here the hash
   arrives with the intro, so both phones apply the same rule after the
   fact: the canonical link is the one whose LISTENER side is the lower
   hash ("lower senderHash RESPONDS"), and the redundant twin is torn down
   on both ends independently. A link that dies mid-race just re-forms —
   the browser keeps reporting endpoints and a dead link re-arms its dial.

 - SAME-OS LANE. The security divergence (OS pairing vs pod PSK) means an
   iPhone's aware link speaks to iPhones and Android's to Androids — the
   radios share a standard, the admission layers do not. Cross-OS hi-fi
   rides the shared-LAN rung; BLE remains the everything-floor. No code
   here pretends otherwise.

 THREADING: main owns every registry (links, canonical, dialed), exactly
 Walkie.swift's "main owns peers" discipline. The async listener/browser/
 connection machinery hops to main before touching state; callbacks into
 Walkie fire on main in FIFO order. `onFrame` may fire on any thread — the
 caller hops (and Walkie does).
 */
@available(iOS 26.0, *)
final class WalkieAwareLink: @unchecked Sendable {
  /// Android advertises the bare "playapal-walkie"; Apple requires the
  /// fully qualified RFC 6763 form, and the bare name is exactly 15
  /// characters — the RFC 6335 cap, nothing to spare. Must match the
  /// WiFiAwareServices entry in Info.plist (a mismatch means the
  /// allServices lookups return nil and the rung contributes no peers).
  static let serviceName = "_playapal-walkie._udp"

  /// ONE value for the listener and every dialled connection: Apple
  /// documents mismatched performance modes as undefined behaviour.
  /// realtime because the cargo is 20 ms voice frames — Apple's stated
  /// low-latency case. The battery cost is bounded by the link existing
  /// only while the walkie is on.
  private static let performanceMode: WAPerformanceMode = .realtime

  /// 'PA'(2) + podHash(4 BE) + senderHash(4 BE); utf8 name follows.
  /// Byte-identical to WalkieAwareLink.kt's SSI_HEADER.
  private static let introHeader = 10

  private typealias AwareConnection = NetworkConnection<UDP>

  private let podHash: UInt32
  private let senderHash: UInt32
  private let myName: String
  /// Hand a peer to Walkie's table: (key, name, senderHash, send).
  /// Key follows Android's "aware|<senderHash hex>|<name>" shape.
  private let onPeer: (String, String, UInt32, @escaping (Data) -> Void) -> Void
  private let onPeerLost: (String) -> Void
  /// A PW datagram from the aware radio — Walkie's handleFrame seam.
  private let onFrame: (Data) -> Void

  /// One live (or forming) connection. Registries are keyed by `id`
  /// because the peer's hash is unknown until its intro arrives.
  private final class Link: @unchecked Sendable {
    let id = UUID()
    let listenerSide: Bool
    /// The paired device we dialled (subscriber side only) — releasing it
    /// from `dialed` on death is what makes a lost peer re-dialable.
    let device: WAPairedDevice?
    var hash: UInt32?
    var name = "someone"
    var sendTask: Task<Void, Never>?
    var receiveTask: Task<Void, Never>?
    var yield: ((Data) -> Void)?
    var finish: (() -> Void)?
    init(listenerSide: Bool, device: WAPairedDevice?) {
      self.listenerSide = listenerSide
      self.device = device
    }
  }

  // MAIN-owned state.
  private var links: [UUID: Link] = [:]
  /// senderHash → the one link the peer table rides.
  private var canonical: [UInt32: UUID] = [:]
  private var dialed: Set<WAPairedDevice> = []
  private var stopped = false
  private var publishTask: Task<Void, Never>?
  private var subscribeTask: Task<Void, Never>?
  /// The OS's paired set, watched for the whole life of the rung.
  private var pairedTask: Task<Void, Never>?
  private var pairedDevices: Set<WAPairedDevice> = []
  /// The sequence's FIRST emission is the set as it already stands, which
  /// looks like an arrival and is not one. Only later additions re-arm.
  private var pairedSeeded = false

  init(
    podHash: UInt32,
    senderHash: UInt32,
    displayName: String,
    onPeer: @escaping (String, String, UInt32, @escaping (Data) -> Void) -> Void,
    onPeerLost: @escaping (String) -> Void,
    onFrame: @escaping (Data) -> Void
  ) {
    self.podHash = podHash
    self.senderHash = senderHash
    let clean = displayName.replacingOccurrences(of: "|", with: "/").prefix(24)
    myName = clean.isEmpty ? "someone" : String(clean)
    self.onPeer = onPeer
    self.onPeerLost = onPeerLost
    self.onFrame = onFrame
  }

  func start() {
    // The silicon gate, mirroring Android's FEATURE_WIFI_AWARE check at
    // construction: a phone without the radio never runs a task.
    guard WACapabilities.supportedFeatures.contains(.wifiAware) else {
      awareLog("no-radio — WACapabilities has no .wifiAware; rung contributes no peers")
      return
    }
    awareLog(
      "starting service=" + Self.serviceName
        + " pod=" + String(podHash, radix: 16)
        + " me=" + String(senderHash, radix: 16)
    )
    publishTask = Task { [weak self] in await self?.runPublisher() }
    subscribeTask = Task { [weak self] in await self?.runSubscriber() }
    pairedTask = Task { [weak self] in await self?.runPairedWatch() }
  }

  func stop() {
    DispatchQueue.main.async {
      awareLog(
        "stopping links=" + String(self.links.count)
          + " peers=" + String(self.canonical.count)
      )
      self.stopped = true
      // Cancelling the wrapping Task is Apple's documented way to stop a
      // running NetworkListener / NetworkBrowser (there is no stop()).
      self.publishTask?.cancel()
      self.publishTask = nil
      self.subscribeTask?.cancel()
      self.subscribeTask = nil
      self.pairedTask?.cancel()
      self.pairedTask = nil
      self.pairedDevices.removeAll()
      self.pairedSeeded = false
      for link in self.links.values {
        self.tearDown(link)
      }
      self.links.removeAll()
      self.canonical.removeAll()
      self.dialed.removeAll()
    }
  }

  // -------------------------------------------------------- pairing arc

  /**
   THE PAIRING SEAM (docs/WALKIE-LADDER.md §9a). Both halves of this rung
   are scoped to `.allPairedDevices`, and Apple does not activate a listener
   whose device set is empty — Apple's own `connecting(to:from:)` note:
   "The NetworkListener isn't activated if the system doesn't specify any
   devices." So the sequence that was BROKEN before the pairing UI existed,
   and is still broken without this watcher, is the ordinary one:

     walkie on (nobody paired) -> publisher and browser start and END
       -> camper pairs two iPhones -> nothing restarts them -> no peers,
       and the log says `publish-ended` from a minute ago.

   Pairing is not an event the listener or the browser can observe. It is an
   event the OS reports HERE, and this is the only place that can act on it.

   Watching `allDevices` rather than the pairing sheet's completion is
   deliberate: the pair may have been made by the OTHER phone, or in
   Settings, or before this app was ever opened. The framework's own signal
   covers all of them; a callback from our sheet would cover one.
   */
  private func runPairedWatch() async {
    do {
      // EAS-VERIFY: WAPairedDevice.allDevices — an async sequence of a
      // keyed collection of paired devices. Apple's sample iterates it
      // exactly this way and reads `.values`.
      for try await updated in WAPairedDevice.allDevices {
        let devices = Set(updated.values)
        await MainActor.run { self.pairedChanged(devices) }
      }
      if awareStopped("paired-watch") { return }
      awareLog("paired-watch-ended — no further pairing news; a pairing now needs a walkie restart")
    } catch {
      // stop() cancels this watcher on the way out; that is the walkie
      // closing, not the OS refusing to report pairings.
      if awareStopped("paired-watch", error) { return }
      awareLog("paired-watch-failed " + error.localizedDescription)
    }
  }

  /// MAIN. The paired set moved.
  private func pairedChanged(_ devices: Set<WAPairedDevice>) {
    guard !stopped else { return }
    let added = devices.subtracting(pairedDevices)
    pairedDevices = devices
    awareLog(
      "paired-devices n=" + String(devices.count)
        + " added=" + String(added.count)
        + " seeded=" + String(pairedSeeded)
    )
    guard pairedSeeded else {
      // The opening snapshot. If it is empty, THAT is the sentence that
      // explains every `browse-empty` line that follows.
      pairedSeeded = true
      if devices.isEmpty {
        awareLog("paired-none — nothing is paired yet; use the walkie's Link iPhones directly row")
      }
      return
    }
    guard !added.isEmpty else { return }
    // Only an ADDITION can unblock a half that refused to start. A removal
    // cannot, and re-arming on one would punish a normal unpair with a
    // teardown.
    rearm("a device was paired")
  }

  /// MAIN. Restart the publisher and the browser against the new paired
  /// set. Established links are deliberately NOT torn down: a
  /// NetworkConnection outlives the listener that accepted it, so a podmate
  /// already talking keeps talking through this. `dialed` is kept for the
  /// same reason — it is the browser's dedup against re-dialling a device
  /// this phone already holds a link to.
  private func rearm(_ why: String) {
    guard !stopped else { return }
    awareLog("rearm " + why + " — restarting publish + subscribe against the new paired set")
    publishTask?.cancel()
    subscribeTask?.cancel()
    publishTask = Task { [weak self] in await self?.runPublisher() }
    subscribeTask = Task { [weak self] in await self?.runSubscriber() }
  }

  // ------------------------------------------------------------ links

  /// MAIN. Cancel a link's machinery. Registry bookkeeping is unlink's.
  private func tearDown(_ link: Link) {
    link.sendTask?.cancel()
    link.receiveTask?.cancel()
    link.finish?()
    link.sendTask = nil
    link.receiveTask = nil
    link.yield = nil
    link.finish = nil
    // EAS-VERIFY: NetworkConnection teardown. Per Apple's model the
    // connection ends when its tasks are cancelled and the last reference
    // drops (there is no cancel()/invalidate() on NetworkConnection). If
    // the shipped API DOES expose an explicit cancel, call it here.
  }

  /// MAIN. A link died (connection failed/ended, wrong pod, or lost the
  /// dedup race). Announces the peer loss only if the peer table was
  /// riding this link; a replaced link is naturally quiet because
  /// `canonical` was repointed before the old link is unlinked.
  private func unlink(_ link: Link) {
    guard links.removeValue(forKey: link.id) != nil else { return }
    tearDown(link)
    if let device = link.device {
      dialed.remove(device)
    }
    if let hash = link.hash, canonical[hash] == link.id {
      canonical[hash] = nil
      awareLog("peer-lost hash=" + String(hash, radix: 16) + " name=" + link.name)
      onPeerLost(key(hash, link.name))
    } else {
      // Either the twin the dedup rule discarded, or a link that died
      // before its peer ever introduced itself. Both are quiet by design
      // and both used to be invisible.
      awareLog(
        "link-down listener=" + String(link.listenerSide)
          + " introduced=" + String(link.hash != nil)
      )
    }
  }

  /// Any thread (receive task). Route one inbound datagram.
  private func ingest(_ data: Data, link: Link) {
    guard data.count >= 2 else { return }
    let b0 = data[data.startIndex]
    let b1 = data[data.startIndex + 1]
    if b0 == 0x50, b1 == 0x57 { // 'PW' — voice, the wire format, untouched
      onFrame(data)
      return
    }
    if b0 == 0x50, b1 == 0x41 { // 'PA' — the intro
      DispatchQueue.main.async { self.handleIntro(data, link: link) }
    }
    // Anything else is not ours: dropped, contributes nothing.
  }

  /// MAIN. The peer introduced itself on this link.
  private func handleIntro(_ d: Data, link: Link) {
    guard !stopped, links[link.id] != nil else { return }
    let b = [UInt8](d)
    guard b.count >= Self.introHeader else {
      awareLog("intro-short bytes=" + String(b.count))
      return
    }
    let pod = be32(b, 2)
    let hash = be32(b, 6)
    guard pod == podHash, hash != senderHash, hash != 0 else {
      awareLog(
        "intro-rejected pod=" + String(pod, radix: 16)
          + " mine=" + String(podHash, radix: 16)
          + " hash=" + String(hash, radix: 16)
      )
      // Another pod's phone (OS-paired with ours, but not OUR pod), or our
      // own reflection. Pod scoping happens HERE because Apple's discovery
      // carries no service-specific info — the earliest the API allows.
      unlink(link)
      return
    }
    let firstIntro = link.hash == nil
    link.hash = hash
    let raw = String(decoding: b[Self.introHeader...], as: UTF8.self)
    let name = raw.replacingOccurrences(of: "|", with: "/").prefix(24)
    link.name = name.isEmpty ? "someone" : String(name)
    awareLog(
      "intro hash=" + String(hash, radix: 16)
        + " name=" + link.name
        + " listener=" + String(link.listenerSide)
        + " first=" + String(firstIntro)
    )
    if firstIntro {
      // Close the loop the way Android's subscribe side sendMessage does:
      // our first intro may have been the dropped datagram; theirs proves
      // the path works, so answer on it once.
      link.yield?(intro())
    }
    resolveCanonical(link)
  }

  /// MAIN. Deterministic pairwise link — the Android rule verbatim: the
  /// LOWER senderHash RESPONDS. "Responds" here = is the LISTENER side of
  /// the connection, so of the (up to) two symmetric connections a pair
  /// can form, both phones independently keep the same one and tear down
  /// the same twin — no message needed.
  private func resolveCanonical(_ link: Link) {
    guard let hash = link.hash else { return }
    let canonicalHere = (senderHash < hash) == link.listenerSide
    if let currentId = canonical[hash], currentId != link.id {
      guard let current = links[currentId] else {
        canonical[hash] = nil
        resolveCanonical(link)
        return
      }
      let currentCanonical = (senderHash < hash) == current.listenerSide
      if canonicalHere, !currentCanonical {
        // This link is the pair's ONE deterministic link; the earlier
        // registration was the twin that happened to finish first. The
        // peer table entry is overwritten in place (same key), then the
        // twin dies quietly. The peer computes the same replacement.
        canonical[hash] = link.id
        register(link, hash: hash)
        unlink(current)
      } else {
        unlink(link)
      }
      return
    }
    if canonical[hash] == nil {
      canonical[hash] = link.id
      register(link, hash: hash)
    }
    // canonical already == this link: a repeat intro, nothing to do.
  }

  /// MAIN. Hand the link to Walkie's peer table.
  private func register(_ link: Link, hash: UInt32) {
    guard let yield = link.yield else {
      awareLog("register-skipped hash=" + String(hash, radix: 16) + " — link has no send stream")
      return
    }
    awareLog(
      "peer hash=" + String(hash, radix: 16)
        + " name=" + link.name
        + " listener=" + String(link.listenerSide)
    )
    onPeer(key(hash, link.name), link.name, hash, yield)
  }

  private func key(_ hash: UInt32, _ name: String) -> String {
    "aware|" + String(hash, radix: 16) + "|" + name
  }

  /// Byte-identical to Android's ssi(): 'PA' + podHash + senderHash + name.
  private func intro() -> Data {
    var d = Data(capacity: Self.introHeader + myName.utf8.count)
    d.append(contentsOf: [0x50, 0x41]) // 'PA'
    d.append(contentsOf: be32(podHash))
    d.append(contentsOf: be32(senderHash))
    d.append(contentsOf: Array(myName.utf8))
    return d
  }

  private func be32(_ v: UInt32) -> [UInt8] {
    [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  private func be32(_ b: [UInt8], _ at: Int) -> UInt32 {
    (UInt32(b[at]) << 24) | (UInt32(b[at + 1]) << 16) | (UInt32(b[at + 2]) << 8) | UInt32(b[at + 3])
  }

  // ================================================================
  // iOS 26 API ADAPTER — every call onto Apple's Wi-Fi Aware surface
  // lives below this line. There is no Mac in this build environment:
  // the shapes are transcribed from Apple's shipped iOS 26 sample
  // ("Building peer-to-peer apps", developer.apple.com/documentation/
  // wifiaware) and are compile-verified via EAS, not locally. Each
  // EAS-VERIFY names exactly the thing to check.
  // ================================================================

  /// One intro datagram, and the honest word when it does not leave the
  /// phone. `try?` used to eat exactly this: a link whose every send throws
  /// and a link whose peer never answers both ended at `intro-unanswered`,
  /// and they have OPPOSITE fixes — one is our socket, the other is theirs.
  /// A local send failure now says so on its own line, and the retry loop
  /// still runs, because one throw is not proof the next one throws.
  private func sendIntro(over connection: AwareConnection) async {
    do {
      try await connection.send(intro())
    } catch {
      // A cancel mid-retry is the walkie going off, not a failed send.
      if awareStopped("intro-send", error) { return }
      awareLog("intro-send-failed " + error.localizedDescription)
    }
  }

  private func runPublisher() async {
    // EAS-VERIFY: WAPublishableService.allServices[name] — nil means the
    // WiFiAwareServices plist entry is missing/misnamed (Apple's sample
    // force-unwraps; we refuse to crash — the rung contributes no peers).
    guard let service = WAPublishableService.allServices[Self.serviceName] else {
      awareLog(
        "publish-no-service name=" + Self.serviceName
          + " — the WiFiAwareServices Info.plist entry is absent or spelled differently"
      )
      return
    }
    awareLog("publish-starting scope=allPairedDevices")
    do {
      // EAS-VERIFY: the whole chain below is the sample's publisher shape.
      // Note the argument order: publisher = .connecting(to: SERVICE,
      // from: DEVICES); the browser below takes the SWAPPED order.
      try await NetworkListener(
        for: .wifiAware(.connecting(to: service, from: .allPairedDevices)),
        using: .parameters { UDP() }
          .wifiAware { $0.performanceMode = Self.performanceMode }
          // EAS-VERIFY: .interactiveVoice as a service class here; Apple's
          // sample attests .interactiveVideo — fall back to that if the
          // voice case does not exist on this builder.
          .serviceClass(.interactiveVoice)
      )
      .onStateUpdate { _, state in
        // Failures surface as .failed and end run() — handled below as
        // "this rung contributes no peers". Nothing to DO per-state, but
        // the state is the only place a missing entitlement announces
        // itself before the catch.
        awareLog("publish-state " + String(describing: state))
      }
      .run { [weak self] connection in
        awareLog("publish-accepted (a paired device dialled us)")
        DispatchQueue.main.async {
          self?.adopt(connection, listenerSide: true, device: nil)
        }
      }
      if awareStopped("publisher") { return }
      awareLog("publish-ended — the listener returned; rung contributes no peers")
    } catch {
      // CANCELLED FIRST, and it is not one of the causes below: stop() and
      // rearm() both land here on the ordinary path, and "we stopped it" is
      // a different sentence from "it broke".
      if awareStopped("publisher", error) { return }
      // No entitlement, no paired devices, radio off — one answer for all of
      // them: no peers from this rung. LAN and BLE are already running. One
      // answer, three causes, so the error text is the only thing that
      // separates them in the field.
      awareLog("publish-failed " + error.localizedDescription)
    }
  }

  private func runSubscriber() async {
    guard let service = WASubscribableService.allServices[Self.serviceName] else {
      awareLog(
        "subscribe-no-service name=" + Self.serviceName
          + " — the WiFiAwareServices Info.plist entry is absent or spelled differently"
      )
      return
    }
    // Said out loud once per start, because it is the fork every later
    // diagnosis takes: BOTH halves scope to OS-paired devices, so a phone
    // that has paired nobody browses nobody. The `paired-devices` line
    // from runPairedWatch is the number that makes this sentence readable.
    awareLog("subscribe-starting scope=allPairedDevices (empty until two iPhones pair)")
    do {
      // EAS-VERIFY: NetworkBrowser run overload with a non-returning
      // handler (browse until cancelled). If only the RunResult overload
      // exists, add `return .continue` as the closure's last line.
      try await NetworkBrowser(
        for: .wifiAware(.connecting(to: .allPairedDevices, from: service))
      )
      .onStateUpdate { _, state in
        awareLog("subscribe-state " + String(describing: state))
      }
      .run { [weak self] endpoints in
        let found = Array(endpoints)
        DispatchQueue.main.async { self?.dial(found) }
      }
      if awareStopped("subscriber") { return }
      awareLog("subscribe-ended — the browser returned; rung contributes no peers")
    } catch {
      // Same fork as the publisher, and it matters more here: a rearm
      // cancels this browser mid-browse EVERY time a device is paired, which
      // is precisely when someone is watching the log.
      if awareStopped("subscriber", error) { return }
      // Same posture as the publisher: no peers, nothing else changes.
      awareLog("subscribe-failed " + error.localizedDescription)
    }
  }

  /// MAIN. Dial newly discovered publishers. The browser re-reports the
  /// full endpoint set on every callback, so dials dedup by paired device;
  /// a device becomes dialable again when its link dies (unlink).
  private func dial(_ endpoints: [WAEndpoint]) {
    guard !stopped else {
      awareLog("browse-after-stop endpoints=" + String(endpoints.count))
      return
    }
    if endpoints.isEmpty {
      // An empty browse here is NOT "nobody is nearby". The scope is
      // .allPairedDevices, so this line means one of two very different
      // things, and the `paired-devices n=` line says which: n=0 is
      // "nobody has done the pairing ceremony on this phone", n>0 is the
      // real "nobody paired is in range right now".
      awareLog("browse-empty scope=allPairedDevices — no paired device in range; rung contributes no peers")
      return
    }
    awareLog(
      "browse endpoints=" + String(endpoints.count)
        + " already-dialled=" + String(dialed.count)
    )
    for endpoint in endpoints {
      // EAS-VERIFY: WAEndpoint.device (a Hashable WAPairedDevice).
      let device = endpoint.device
      if dialed.contains(device) { continue }
      dialed.insert(device)
      awareLog("dial (paired device not yet linked)")
      // EAS-VERIFY: NetworkConnection(to: WAEndpoint, using:) with the
      // identical UDP stack. The performanceMode MUST equal the
      // listener's — Apple documents a mismatch as undefined behaviour.
      let connection = AwareConnection(
        to: endpoint,
        using: .parameters { UDP() }
          .wifiAware { $0.performanceMode = Self.performanceMode }
          .serviceClass(.interactiveVoice)
      )
      adopt(connection, listenerSide: false, device: device)
    }
  }

  /// MAIN. Wire one connection — either accepted (listener) or dialled
  /// (browser) — into a Link: intro exchange, send stream, receive loop.
  private func adopt(_ connection: AwareConnection, listenerSide: Bool, device: WAPairedDevice?) {
    if stopped {
      awareLog("adopt-after-stop listener=" + String(listenerSide))
      return // dropping the only reference is the teardown
    }
    let link = Link(listenerSide: listenerSide, device: device)
    links[link.id] = link
    awareLog("link-up listener=" + String(listenerSide) + " links=" + String(links.count))

    // The per-peer send path Walkie's audio thread rides: yield is
    // non-blocking and allocation-light; the consumer task awaits the
    // actual sends. bufferingNewest because late audio is worse than lost
    // audio — when the radio stalls, old frames drop first.
    let (frames, continuation) = AsyncStream.makeStream(
      of: Data.self, bufferingPolicy: .bufferingNewest(8)
    )
    link.yield = { continuation.yield($0) }
    link.finish = { continuation.finish() }

    // EAS-VERIFY: NetworkConnection.onStateUpdate and the .failed /
    // .cancelled state cases (the sample attests .ready and .failed).
    // Missing .cancelled would only delay cleanup — the receive loop's
    // termination below also unlinks.
    connection.onStateUpdate { [weak self] _, state in
      // Every endpoint state, not only the fatal two: a link that reaches
      // .ready and then contributes no peer is a DIFFERENT bug from one
      // that never gets there, and both used to print nothing.
      awareLog("link-state " + String(describing: state) + " listener=" + String(listenerSide))
      switch state {
      case .failed, .cancelled:
        DispatchQueue.main.async { self?.unlink(link) }
      default:
        break
      }
    }

    link.sendTask = Task { [weak self] in
      guard let self else { return }
      // Intro first, voice after. Sends before .ready are queued by the
      // framework, so there is no ready-wait here.
      // EAS-VERIFY: raw Data send over a plain-UDP stack
      // (NetworkConnection<UDP>.send(Data)). If UDP()'s message type is
      // not Data, wrap the stack in a passthrough Framer/Coder and keep
      // the payload bytes identical.
      //
      // EVERY ATTEMPT IS SEND -> WAIT -> CHECK (2026-08-26 review). The loop
      // this replaces ran wait -> check -> send, which meant the LAST
      // datagram it ever sent was never given a second to be answered: the
      // fifth retry left the radio and `intro-unanswered` printed in the
      // same breath, on a link whose peer was about to answer. A reply is a
      // round trip away by definition, so the verdict below is only ever
      // reached after a wait that followed a send.
      var tries = 0
      var introduced = false
      while true {
        await self.sendIntro(over: connection)
        // UDP drops. Android's discovery layer retries the SSI for free;
        // this is that retry made explicit — once a second until the
        // peer's intro proves the pair can hear each other, bounded.
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if Task.isCancelled {
          break
        }
        let known = await MainActor.run { link.hash != nil }
        if known {
          introduced = true
          break
        }
        if tries >= 5 {
          break
        }
        tries += 1
      }
      if !introduced, !Task.isCancelled {
        // The link formed and the far end never said who it was: a live
        // radio carrying nothing, which reads to the peer table exactly
        // like no radio at all.
        awareLog("intro-unanswered retries=" + String(tries))
      }
      for await frame in frames {
        if Task.isCancelled { break }
        try? await connection.send(frame)
      }
    }

    link.receiveTask = Task { [weak self] in
      do {
        // EAS-VERIFY: `messages` yields (Data, metadata) for a UDP stack —
        // the sample attests the tuple shape for Coder stacks; confirm the
        // element type is Data here.
        for try await (data, _) in connection.messages {
          self?.ingest(data, link: link)
        }
      } catch {
        // Includes CancellationError on stop; either way the link is done.
        awareLog("receive-ended " + error.localizedDescription)
      }
      DispatchQueue.main.async { self?.unlink(link) }
    }
  }
}

#endif
