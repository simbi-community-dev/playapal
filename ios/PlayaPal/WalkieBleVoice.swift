import CoreBluetooth
import Foundation

/**
 The walkie's RUNG 3 — live lo-fi voice over BLE GATT (docs/WALKIE-LADDER.md
 §2, §6), iOS half. Mirrors WalkieBleLink.kt — read that file for the full
 design; this comment records the contract and the places CoreBluetooth
 forces a different shape.

 THE CONTRACT (identical to Android): every phone with the walkie OPEN
 advertises one connectable service and runs one GATT server with two
 characteristics:
   IDENT (read):  'PV' + podHash(4 BE) + senderHash(4 BE) + utf8 name
   VOICE (write-no-response): one PW frame per write
 and scans for the same service, connecting as a CENTRAL to every pod peer
 it sights. Voice is asymmetric on purpose: MY voice rides MY central
 connection to THEIR server; theirs rides theirs to mine — no role
 negotiation, each direction owns its pipe. MEMBERSHIP IS THE CONNECTION
 (§5: availability is PROVEN, never announced): a peer is listed only after
 the identity read came back with the right pod on a link whose write
 budget fits a voice frame. Every failure path ends in "this rung
 contributes no peers" — the LAN and Aware rungs are untouched.

 WHERE iOS DIFFERS, AND WHY:

 - THE IDENTITY RIDES THE LOCAL NAME, NOT MANUFACTURER DATA. A CoreBluetooth
   peripheral can advertise ONLY service UUIDs and a local name — the same
   asymmetry CrewBeacon.swift already encodes — so the 10 PV bytes Android
   puts in manufacturer data are spelled here as the advertised name:
   "PV" + podHash(8 hex) + senderHash(8 hex). Both scanners read BOTH
   carriers (WalkieBleLink.kt's pvFromName is the Android half). Either
   carrier is a pre-connect FILTER only — the identity read stays the
   proof. Backgrounded, iOS drops the local name from the advertisement,
   so an Android central cannot identify a pocketed iPhone and THAT
   direction contributes no peers until the app is foreground again; the
   walkie is an open-panel surface, so the honest cost is small — and
   the iPhone-as-central half keeps dialling Androids regardless.

 - THE WRITE BUDGET IS ASKED, NOT NEGOTIATED. Android requests MTU 517 and
   gates on the answer; CoreBluetooth exchanges MTU on its own, and
   maximumWriteValueLength(for: .withoutResponse) is the question this
   side can ask. Same rule either way: a 60 ms frame is 257 bytes, and a
   link whose budget came back smaller is dropped before it was ever
   listed (Android's MIN_VOICE_MTU 260 is this number plus the 3-byte ATT
   header its API counts).

 - THE SCAN STREAM IS THE RETRY ENGINE only with duplicates ON.
   CBCentralManager reports each peripheral once per scan by default;
   CBCentralManagerScanOptionAllowDuplicatesKey keeps the sightings coming
   so the per-peer backoff has its trigger, exactly like Android's
   scanner. (iOS ignores the option in background — the same foreground
   story as the local name, the same honest cost.)

 THREADING: one serial queue owns both managers, every peer record and the
 whole teardown — the stop() serialization WalkieBleLink.kt earned the
 hard way arrives here for free: stop() enqueues the teardown, a dial
 already enqueued completes first and is closed BY it, anything enqueued
 after sees `stopped`. Callbacks out (onPeer/onPeerLost/onFrame) fire on
 this queue; Walkie.swift hops them to main, its own discipline.
 */
final class WalkieBleVoice: NSObject {
  /// Must equal WalkieBleLink.kt's SERVICE/VOICE/IDENT UUIDs byte for
  /// byte — a test reads both files.
  static let serviceUUID = CBUUID(string: "6b75a1fa-8e2a-4b0b-9f21-706c61796170")
  static let voiceChar = CBUUID(string: "6b75a1fb-8e2a-4b0b-9f21-706c61796170")
  static let identChar = CBUUID(string: "6b75a1fc-8e2a-4b0b-9f21-706c61796170")
  /// Same test company id the crew beacon uses — READ from Android
  /// advertisements only; this side cannot advertise it (see header).
  static let manufacturerId: UInt16 = 0xFFFF
  /// 'P''V' + podHash(4 BE) + senderHash(4 BE).
  static let pvHeader = 10
  /// A 60 ms rung-3 frame is 13 + 4 + 240 = 257 bytes.
  /// maximumWriteValueLength already excludes the 3-byte ATT header, so
  /// this is Android's MIN_VOICE_MTU (260) in this API's units. §5: a
  /// rung that cannot carry is never offered.
  static let minVoiceWrite = 257
  /// Inbound writes above this are a stranger or a bug, not a frame.
  static let maxVoiceFrame = 600
  /// Redial pacing per peer: base doubles per failed setup to the cap,
  /// resets on a proven link. Scan sightings are the retry trigger, so a
  /// peer who reappears is redialled within one backoff window.
  static let connectBackoffBase: TimeInterval = 3
  static let connectBackoffCap: TimeInterval = 30
  /// A setup (connect->discover->budget->ident) that stalls past this is
  /// torn down; BLE stacks wedge silently and the walkie must not hold a
  /// half-open pipe it will never probe again.
  static let setupTimeout: TimeInterval = 12
  /// Mirror of WalkieBleLink.MAX_VOICE_LINKS: four live voice links is a
  /// six-phone huddle with no Wi-Fi anywhere, already past what this
  /// rung's bandwidth story promises.
  static let maxVoiceLinks = 4

  private let podHash: UInt32
  private let senderHash: UInt32
  private let myName: String
  /// A peer's voice pipe became WRITABLE. Key follows the
  /// "ble|<senderHash hex>|<name>" shape the roster dedupe reads; `send`
  /// writes one PW frame (drop-on-busy — the walkie never retransmits).
  private let onPeer: (String, String, UInt32, @escaping (Data) -> Void) -> Void
  private let onPeerLost: (String) -> Void
  /// An inbound PW frame from a peer's write; the module's one receive
  /// path gates and plays it.
  private let onFrame: (Data) -> Void

  /// Everything below is owned by this queue — both managers are
  /// constructed on it, so every delegate callback already arrives here.
  private let queue = DispatchQueue(label: "walkie-ble")
  private var stopped = false
  private var central: CBCentralManager?
  private var peripheralMgr: CBPeripheralManager?
  private var serviceAdded = false

  /// One entry per pod peer BY HASH, kept across disconnects — the entry
  /// carries the backoff that paces redials; the next scan sighting is
  /// what actually redials (WalkieBleLink.VoicePeer, mirrored).
  private final class VoicePeer {
    let hash: UInt32
    /// Strong ref while connecting/connected — CoreBluetooth drops
    /// unreferenced peripherals (the CrewBeacon lesson).
    var peripheral: CBPeripheral?
    var voiceChar: CBCharacteristic?
    var name = "someone"
    var key = ""
    var ready = false
    var connecting = false
    var lastAttempt: TimeInterval = 0
    var backoff: TimeInterval = WalkieBleVoice.connectBackoffBase
    /// Dial generation — only THIS dial's 12 s timer may kill this dial
    /// (WalkieBleLink's attempt-epoch guard, mirrored: a stale timer from
    /// a failed dial 1 must not abort the healthy dial 2 that started
    /// meanwhile and thrash the backoff toward the cap).
    var attempt = 0
    init(hash: UInt32) { self.hash = hash }
  }

  private var voicePeers: [UInt32: VoicePeer] = [:]

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
    super.init()
  }

  // ------------------------------------------------------------ lifecycle

  func start() {
    queue.async { [self] in
      guard !stopped, central == nil else { return }
      // Creating the managers IS the one-time OS Bluetooth ask
      // (NSBluetoothAlwaysUsageDescription, already in the plist for the
      // crew beacon); opening the walkie is the in-context moment. A
      // denial surfaces as .unauthorized in the state callbacks below —
      // this rung contributes no peers, no dialog storm, the module's
      // fencing law.
      central = CBCentralManager(delegate: self, queue: queue)
      peripheralMgr = CBPeripheralManager(delegate: self, queue: queue)
    }
  }

  /// Serialized ON the link queue — the WalkieBleLink.stop() rule: a dial
  /// already enqueued completes before this block and its peripheral is
  /// in voicePeers by the time the teardown cancels them all; anything
  /// enqueued after sees `stopped`. Closing the walkie stops the
  /// advertisement and the server, which drops every inbound connection —
  /// the peer LEAVES the other phones' lists on the disconnect
  /// (MEMBERSHIP IS THE CONNECTION, both halves).
  func stop() {
    queue.async { [self] in
      stopped = true
      central?.stopScan()
      peripheralMgr?.stopAdvertising()
      peripheralMgr?.removeAllServices()
      for p in voicePeers.values {
        if let per = p.peripheral {
          central?.cancelPeripheralConnection(per)
        }
        p.peripheral = nil
        p.voiceChar = nil
        p.ready = false
        p.connecting = false
      }
      voicePeers.removeAll()
      central = nil
      peripheralMgr = nil
    }
  }

  // ------------------------------------------------------------ identity

  /// The advertised-name carrier: "PV" + podHash + senderHash, lowercase
  /// hex, fixed width — the 10 manufacturer-data bytes spelled for the
  /// one advertisement field a CoreBluetooth peripheral can fill. Must
  /// stay parseable by WalkieBleLink.kt's pvFromName.
  private func pvName() -> String {
    String(format: "PV%08x%08x", podHash, senderHash)
  }

  private func identBytes() -> Data {
    var d = Data(capacity: Self.pvHeader + myName.utf8.count)
    d.append(contentsOf: [0x50, 0x56]) // 'PV'
    d.append(contentsOf: be32(podHash))
    d.append(contentsOf: be32(senderHash))
    d.append(contentsOf: Array(myName.utf8))
    return d
  }

  /// (podHash, senderHash) from either advertisement carrier, or nil for
  /// a stranger's advertisement under our UUID.
  private func decodePv(_ advertisementData: [String: Any]) -> (UInt32, UInt32)? {
    if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
       mfg.count >= 2 + Self.pvHeader {
      // Android's carrier: a 2-byte little-endian company id, then the
      // PV bytes (CrewBeacon reads its sightings the same way).
      let company = UInt16(mfg[mfg.startIndex]) | (UInt16(mfg[mfg.startIndex + 1]) << 8)
      let b = [UInt8](mfg.dropFirst(2))
      if company == Self.manufacturerId, b[0] == 0x50, b[1] == 0x56 {
        return (be32(b, 2), be32(b, 6))
      }
    }
    if let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
       name.count == 2 + 16, name.hasPrefix("PV"),
       let pod = UInt32(name.dropFirst(2).prefix(8), radix: 16),
       let sender = UInt32(name.dropFirst(10), radix: 16) {
      // Another iPhone's carrier — see the header.
      return (pod, sender)
    }
    return nil
  }

  // ------------------------------------------------------------ client side

  /// Queue. The scan stream is the retry engine: every sighting of a
  /// not-connected pod peer lands here, and the backoff decides whether
  /// this one dials.
  private func maybeConnect(_ hash: UInt32, _ peripheral: CBPeripheral) {
    guard !stopped, let central else { return }
    let peer: VoicePeer
    if let existing = voicePeers[hash] {
      peer = existing
    } else {
      peer = VoicePeer(hash: hash)
      voicePeers[hash] = peer
    }
    if peer.ready || peer.connecting {
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    if now - peer.lastAttempt < peer.backoff {
      return
    }
    if voicePeers.values.filter({ $0.ready || $0.connecting }).count >= Self.maxVoiceLinks {
      return
    }
    peer.connecting = true
    peer.lastAttempt = now
    peer.attempt += 1
    let epoch = peer.attempt
    peer.peripheral = peripheral
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    queue.asyncAfter(deadline: .now() + Self.setupTimeout) { [weak self, weak peer] in
      // Only THIS dial's timer may kill this dial: a later attempt bumped
      // peer.attempt past our epoch, and its own timer owns it.
      guard let self, let peer, !peer.ready, peer.connecting, peer.attempt == epoch else {
        return
      }
      self.dropClient(peer)
    }
  }

  /// Queue only. The entry SURVIVES the drop — its backoff paces the
  /// redial the next scan sighting triggers, which is the re-enter half
  /// of the membership arc (WalkieBleLink.dropClient, mirrored).
  private func dropClient(_ peer: VoicePeer) {
    let wasReady = peer.ready
    peer.ready = false
    peer.connecting = false
    peer.voiceChar = nil
    if let per = peer.peripheral {
      central?.cancelPeripheralConnection(per)
    }
    peer.peripheral = nil
    if wasReady {
      // A proven link that died gets a fresh dialling record; a setup
      // that failed gets a longer wait before the next one.
      peer.backoff = Self.connectBackoffBase
      if !peer.key.isEmpty {
        onPeerLost(peer.key)
      }
    } else {
      peer.backoff = min(peer.backoff * 2, Self.connectBackoffCap)
    }
  }

  private func peerFor(_ peripheral: CBPeripheral) -> VoicePeer? {
    voicePeers.values.first { $0.peripheral?.identifier == peripheral.identifier }
  }

  /// The PROOF gate (§5): the peer is listed only after this read said
  /// "same pod, same phone the advertisement named". A mismatch is a
  /// stranger, a stale advertisement, or another pod — never a peer.
  private func handleIdent(_ peer: VoicePeer, _ value: Data?) {
    let b = [UInt8](value ?? Data())
    guard b.count >= Self.pvHeader, b[0] == 0x50, b[1] == 0x56,
          be32(b, 2) == podHash, be32(b, 6) == peer.hash else {
      dropClient(peer)
      return
    }
    guard !stopped, !peer.ready else {
      return
    }
    let raw = String(decoding: b[Self.pvHeader...], as: UTF8.self)
    peer.name = raw.isEmpty ? "someone" : raw
    peer.key = "ble|" + String(peer.hash, radix: 16) + "|" + peer.name
    peer.ready = true
    peer.connecting = false
    peer.backoff = Self.connectBackoffBase
    onPeer(peer.key, peer.name, peer.hash) { [weak self, weak peer] frame in
      // Called from the walkie's audio thread — hop to the link queue so
      // ONE queue owns the peripheral. Drop-on-busy either way: a stack
      // still chewing the last write loses this frame, which is the
      // walkie's own late-audio-is-worse-than-lost-audio law on GATT.
      guard let self else { return }
      self.queue.async {
        guard let peer, peer.ready, !self.stopped,
              let per = peer.peripheral, let ch = peer.voiceChar else {
          return
        }
        // EAS-VERIFY: canSendWriteWithoutResponse is the drop-on-busy
        // gate (CBPeripheral, iOS 11+); if the builder disagrees, write
        // unconditionally — the stack drops instead of us.
        guard per.canSendWriteWithoutResponse else {
          return // dropped frame — never retransmitted
        }
        per.writeValue(frame, for: ch, type: .withoutResponse)
      }
    }
  }

  private func be32(_ v: UInt32) -> [UInt8] {
    [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
  }

  private func be32(_ b: [UInt8], _ at: Int) -> UInt32 {
    (UInt32(b[at]) << 24) | (UInt32(b[at + 1]) << 16) | (UInt32(b[at + 2]) << 8) | UInt32(b[at + 3])
  }
}

// ------------------------------------------------------------ central side

extension WalkieBleVoice: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard !stopped else { return }
    switch central.state {
    case .poweredOn:
      // Duplicates ON: repeat sightings ARE the redial trigger (header).
      central.scanForPeripherals(
        withServices: [Self.serviceUUID],
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
      )
    case .poweredOff, .unauthorized, .resetting:
      // Bluetooth off mid-walkie (or denied): the OS already dropped
      // every connection — empty the rung honestly; poweredOn re-enters
      // above and the next sightings redial (WalkieBleLink.onAdapterOff,
      // mirrored; here the state callback IS the adapter receiver).
      for p in voicePeers.values {
        if p.ready, !p.key.isEmpty {
          onPeerLost(p.key)
        }
        p.peripheral = nil
        p.voiceChar = nil
        p.ready = false
        p.connecting = false
      }
      voicePeers.removeAll()
    default:
      break // unknown/unsupported settle on the next state callback
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    guard !stopped, let (pod, hash) = decodePv(advertisementData) else { return }
    guard pod == podHash else { return } // another pod's walkie
    guard hash != senderHash else { return } // our own reflection
    maybeConnect(hash, peripheral)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard !stopped, let peer = peerFor(peripheral), peer.connecting else {
      central.cancelPeripheralConnection(peripheral)
      return
    }
    _ = peer
    peripheral.discoverServices([Self.serviceUUID])
  }

  func centralManager(
    _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
  ) {
    if let peer = peerFor(peripheral) {
      dropClient(peer)
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    if let peer = peerFor(peripheral) {
      dropClient(peer)
    }
  }
}

extension WalkieBleVoice: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let peer = peerFor(peripheral) else { return }
    guard error == nil,
          let svc = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
      dropClient(peer)
      return
    }
    peripheral.discoverCharacteristics([Self.voiceChar, Self.identChar], for: svc)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    guard let peer = peerFor(peripheral) else { return }
    // By now the ATT MTU exchange is done, so the budget question has its
    // real answer. A pipe the frame does not fit is not a rung (§5): drop
    // before it was ever listed — Android's onMtuChanged gate in this
    // API's shape. EAS-VERIFY: maximumWriteValueLength(for:
    // .withoutResponse) reflects the negotiated MTU at this point (a
    // 257-byte 60 ms frame must fit).
    guard error == nil,
          peripheral.maximumWriteValueLength(for: .withoutResponse) >= Self.minVoiceWrite,
          let voice = service.characteristics?.first(where: { $0.uuid == Self.voiceChar }),
          let ident = service.characteristics?.first(where: { $0.uuid == Self.identChar }) else {
      dropClient(peer)
      return
    }
    peer.voiceChar = voice
    peripheral.readValue(for: ident)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard let peer = peerFor(peripheral), characteristic.uuid == Self.identChar else { return }
    guard error == nil else {
      dropClient(peer)
      return
    }
    handleIdent(peer, characteristic.value)
  }
}

// ------------------------------------------------------------ server side

extension WalkieBleVoice: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard !stopped else { return }
    switch peripheral.state {
    case .poweredOn:
      if !serviceAdded {
        let svc = CBMutableService(type: Self.serviceUUID, primary: true)
        svc.characteristics = [
          CBMutableCharacteristic(
            type: Self.voiceChar,
            properties: [.writeWithoutResponse, .write],
            value: nil,
            permissions: [.writeable]
          ),
          CBMutableCharacteristic(
            type: Self.identChar,
            properties: [.read],
            value: nil,
            permissions: [.readable]
          ),
        ]
        peripheral.add(svc)
        serviceAdded = true
      }
      peripheral.startAdvertising([
        CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
        // The identity carrier (header): the one advertisement field an
        // app can fill. It rides the scan response beside the 128-bit
        // UUID — the same budget split Android's manufacturer data uses.
        CBAdvertisementDataLocalNameKey: pvName(),
      ])
    case .poweredOff:
      // CoreBluetooth drops published services on power-off; the next
      // poweredOn must re-add ours or the advertisement comes back with
      // nothing to read behind it (the CrewBeacon lesson).
      serviceAdded = false
    default:
      break
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard request.characteristic.uuid == Self.identChar else {
      peripheral.respond(to: request, withResult: .attributeNotFound)
      return
    }
    // Honor offset continuations: a pre-MTU-exchange central reads this
    // in slices and must reassemble one value, not several (the same
    // long-read rule CrewBeacon documents).
    let b = identBytes()
    guard request.offset <= b.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = b.subdata(in: request.offset ..< b.count)
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    // One response settles the whole batch, per CoreBluetooth's contract.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: .success)
    }
    guard !stopped else { return }
    for request in requests {
      // Voice never rides a prepared (long) write — frames fit the write
      // budget by contract (the minVoiceWrite gate on the writer), so a
      // nonzero offset is a stranger or a bug, like an oversized value.
      guard request.characteristic.uuid == Self.voiceChar, request.offset == 0,
            let v = request.value, v.count <= Self.maxVoiceFrame else {
        continue
      }
      // The frame self-identifies (pod, sender, seq, codec) — the
      // module's one receive path gates it exactly like a datagram.
      onFrame(v)
    }
  }
}
