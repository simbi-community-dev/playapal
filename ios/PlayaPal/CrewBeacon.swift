import CoreBluetooth
import Foundation
import React

/**
 CrewBeacon — the iOS radio half of Crew (docs/CREW-DESIGN.md Phase B/C)
 plus the answering machine's message-exchange pipe (§6b Phase D).

 THE PLATFORM ASYMMETRY THIS FILE ENCODES. CoreBluetooth peripherals cannot
 put data in an advertisement — only service UUIDs and a local name — so an
 iPhone can never broadcast the crew payload inline the way Android does.
 Both halves of the answer live here:
  - As a PERIPHERAL we advertise the service UUID and serve the current
    payload from a read-only GATT characteristic; peers connect and read.
  - As a CENTRAL we scan for the service UUID. An Android peer's payload
    arrives inline as manufacturer data (company id 0xFFFF, little-endian
    prefix, then the protocol bytes) and costs nothing; an iOS peer has no
    inline data, so we connect, read the characteristic, disconnect —
    rate-limited and capped so a dusty crowd never becomes a connect storm.

 MESSAGE SYNC (Phase D) mirrors the Android module: three more
 characteristics on the same service move opaque byte streams as
 [seq u16 BE][total u16 BE][chunk] frames — GATT values cap at 512 bytes,
 so a stream is pulled by REPEATED reads with a per-central cursor on the
 serving side; total=0 means "not ready, retry". One iOS-specific
 correctness detail: a central's long read arrives as offset-sliced
 didReceiveRead requests, so the server caches the CURRENT frame per
 central and advances the cursor only on offset==0 — continuation offsets
 slice the SAME frame. The write direction is symmetric and was NOT: a
 central's long write arrives as offset-sliced didReceiveWrite requests
 too, so those are assembled by offset before anything reads a frame
 header out of them. A digest that changes mid-stream bumps a GENERATION
 rather than clearing state, so a read already in flight finishes from its
 own snapshot and only the central's next fresh read rewinds. The payload
 bytes are opaque here; codec and policy live in src/crews/syncLink.ts /
 messages.ts.

 WHAT A STRANGER CAN MAKE US HOLD. Every per-central buffer here is
 created by whoever connects — there is no pairing and no crew check at
 this layer — and CBPeripheralManager never tells a peripheral that a
 central went away. So the roster is capped (maxTrackedCentrals, oldest
 evicted), a want assembly is capped (maxWantBytes), and an assembled long
 write is capped (maxPreparedBytes). At a 70k-person festival the
 alternative is a memory-exhaustion surface with no authentication in
 front of it.

 Backgrounded (Phase C, bluetooth background modes): iOS moves our service
 UUID to the proprietary "overflow area", which ONLY other iPhones
 scanning explicitly for this UUID can see — a pocketed iPhone is findable
 by iPhones, not by Androids, and the UI says so honestly.

 Events mirror Android exactly:
   CrewBeaconSighting { payload: base64, rssi: int, via: 'adv'|'gatt',
                        peerId: string }
   CrewBeaconState    { advertising: bool, scanning: bool,
                        adapterEnabled?: bool, error?: string }
   CrewSyncWant       { peerId: string, payload: base64 }
   CrewSyncServed     { peerId: string }

 ADAPTER BOUNCE. The CBManager state callbacks already carry power-off and
 power-on, and wantAdvertising/wantScanning make the restart automatic here
 (Android has no equivalent and needs a broadcast receiver for it). What was
 missing on BOTH platforms was telling JS: a session whose radio dies has to
 stop claiming the pod can see you. adapterEnabled rides every state event
 for exactly that.
 */
@objc(CrewBeacon)
final class CrewBeacon: RCTEventEmitter {
  private static let sightingEvent = "CrewBeaconSighting"
  private static let stateEvent = "CrewBeaconState"
  private static let syncWantEvent = "CrewSyncWant"
  /** A central finished reading our digest: the reciprocity cue the JS fast
   path dials back on (meshSync.ts). Address only, never content. Mirrors
   CrewBeaconModule.SYNC_SERVED_EVENT. */
  private static let syncServedEvent = "CrewSyncServed"
  private static let serviceUUID = CBUUID(string: "6B75A1F4-8E2A-4B0B-9F21-706C61796170")
  private static let payloadChar = CBUUID(string: "6B75A1F5-8E2A-4B0B-9F21-706C61796170")
  private static let digestChar = CBUUID(string: "6B75A1F6-8E2A-4B0B-9F21-706C61796170")
  private static let wantChar = CBUUID(string: "6B75A1F7-8E2A-4B0B-9F21-706C61796170")
  private static let msgChar = CBUUID(string: "6B75A1F8-8E2A-4B0B-9F21-706C61796170")
  private static let manufacturerId: UInt16 = 0xFFFF
  /** The re-read floor for a peer whose payload rides a characteristic —
   * on this platform every peer, since CoreBluetooth cannot inline data.
   * The Android module now runs this at 5 s while the app is foreground
   * (CrewBeaconModule.GATT_COOLDOWN_FOREGROUND_MS: a JS nudge can only dial
   * an address it has SEEN, so this floor is the delivery clock), and it
   * takes the posture from JS's setScanMode — a method this module does not
   * have yet, because it has no scan-duty-cycle knob to hang it on. Stated
   * as a KNOWN GAP rather than a matched number: an iPhone in a pod is
   * sighted twice a minute at best, which is exactly what meshSync's
   * freshness gate refuses to condemn an address for. */
  private static let gattCooldown: TimeInterval = 30
  private static let gattTimeout: TimeInterval = 8
  private static let frameChunk = 480
  private static let syncTimeout: TimeInterval = 60
  private static let notReadyRetry: TimeInterval = 0.4
  /** How many centrals we keep per-connection state for at once. Every
   per-central buffer below is created by WHOEVER CONNECTS — no pairing, no
   crew membership, nothing authenticated — and CBPeripheralManager gives a
   peripheral no disconnect callback for a central, so on this platform the
   roster cap is the ONLY bound. Oldest goes first. */
  private static let maxTrackedCentrals = 8
  /** A want list carries message IDS, never bodies; `total` is a
   peer-supplied u16, so 65535 frames of 480 bytes is 31MB of our memory on
   their say-so. Past this the assembly is dropped, not grown. */
  private static let maxWantBytes = 64 * 1024
  /** GATT attribute values cap at 512 bytes, so no honest long write
   assembles to more; ours are at most one 484-byte frame. */
  private static let maxPreparedBytes = 512
  /**
   THE FRUGAL SCAN'S HEARTBEAT — and the reason this platform needs one at
   all. Android's SCAN_MODE_BALANCED still reports a peer it has already
   seen, just less often. CoreBluetooth's duplicates-off does not: a
   peripheral is reported ONCE per scan session and then never again, so
   mapping "frugal" straight onto `allowDuplicates: false` would freeze
   every peer's last-seen stamp while the radio is demonstrably still
   hearing them. Presence liveness is MEMBERSHIP (docs/WALKIE-LADDER.md §1:
   a posture change may cost fidelity, never a seat in the pod), so the
   frugal posture restarts the scan on this interval instead — each peer is
   re-reported about twice a minute rather than on every advertisement.
   Comfortably inside presence's 3-minute live window and meshSync's 90 s
   freshness ceiling, and roughly an order of magnitude fewer wakeups than
   the low-latency posture.
   */
  private static let frugalRescanInterval: TimeInterval = 30

  private var peripheralManager: CBPeripheralManager?
  private var centralManager: CBCentralManager?
  private var payload = Data()
  private var wantAdvertising = false
  private var wantScanning = false
  private var advertising = false
  private var scanning = false
  /** Scan duty cycle asked for by JS (setScanMode): false = frugal (the
   battery-honest default this module ships with, and the posture a stopped
   session is handed back), true = LOW_LATENCY while the app is foreground.
   Mirrors CrewBeaconModule.scanLowLatency. */
  private var scanLowLatency = false
  /** Armed only while the frugal posture is scanning; see
   frugalRescanInterval. */
  private var rescanTimer: Timer?
  private var serviceAdded = false
  /** Strong refs while connecting — CoreBluetooth drops unreferenced peripherals. */
  private var inFlight: [UUID: CBPeripheral] = [:]
  private var lastTried: [UUID: Date] = [:]
  private var lastRssi: [UUID: NSNumber] = [:]
  private var startAdvertisePromise: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?
  private var startScanPromise: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?

  // ---- sync server state (peripheral side) ----
  private var syncDigest = Data()
  private var digestCursor: [UUID: Int] = [:]
  private var digestFrame: [UUID: Data] = [:]
  private var msgCursor: [UUID: Int] = [:]
  private var msgFrame: [UUID: Data] = [:]
  private var msgBuffers: [UUID: Data] = [:]
  private var wantAssembly: [UUID: Data] = [:]
  /** DIGEST GENERATION. setSyncDigest fires on EVERY message-store change —
   which is to say while peers are reading — and it used to clear the
   cursors and the cached frames outright. That invalidated centrals mid
   long-read (the continuation lost the frame it was slicing) and mid
   stream (the cursor rewound, so the next frame the central appended was a
   frame 0 of a DIFFERENT digest). The invalidation is still real and still
   enforced — a fresh digest must never be continued as if it were the old
   one — but it is now a generation rather than a deletion: cached frames
   are snapshots that any in-flight continuation can finish from, and each
   central rewinds to seq 0 at ITS next offset-0 read. */
  private var digestGeneration = 0
  private var digestStreamGen: [UUID: Int] = [:]
  /** The tracked-central roster, oldest first. See maxTrackedCentrals. */
  private var centralSeen: [UUID] = []

  // ---- sync client state (central side) ----
  private var syncOp: SyncOp?

  @objc
  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [Self.sightingEvent, Self.stateEvent, Self.syncWantEvent, Self.syncServedEvent]
  }

  /** True when EITHER manager reports the radio powered on. Nil before any
   manager exists — "unknown", never "off", so JS reads it as unchanged
   rather than raising a false interruption before the first radio use. */
  private var adapterEnabled: Bool? {
    let states = [peripheralManager?.state, centralManager?.state].compactMap { $0 }
    guard !states.isEmpty else { return nil }
    return states.contains(.poweredOn)
  }

  private func emitState(_ error: String? = nil) {
    var body: [String: Any] = ["advertising": advertising, "scanning": scanning]
    // Mirrors Android's adapterEnabled: the JS honesty/recovery state
    // machine (src/crews/session.ts) tells "the radio refused" from "there
    // is no radio right now" by this field, and treats its return as the
    // cue to re-arm. iOS ALSO self-restarts below (wantAdvertising /
    // wantScanning survive a power cycle), so on this platform the JS
    // resume is a belt on top of a brace — both are idempotent.
    if let adapterEnabled { body["adapterEnabled"] = adapterEnabled }
    if let error { body["error"] = error }
    sendEvent(withName: Self.stateEvent, body: body)
  }

  private func emitSighting(_ bytes: Data, rssi: NSNumber, via: String, peerId: String) {
    sendEvent(withName: Self.sightingEvent, body: [
      "payload": bytes.base64EncodedString(),
      "rssi": rssi.intValue,
      "via": via,
      "peerId": peerId,
    ])
  }

  /** Frame a stream for one central: [seq][total][chunk]; total=0 = retry. */
  private static func frame(of buf: Data?, cursor: Int) -> Data {
    guard let buf else { return Data([0, 0, 0, 0]) }
    let total = buf.isEmpty ? 1 : (buf.count + frameChunk - 1) / frameChunk
    let seq = min(max(cursor, 0), total - 1)
    let from = seq * frameChunk
    let to = min(from + frameChunk, buf.count)
    var out = Data([
      UInt8((seq >> 8) & 0xFF), UInt8(seq & 0xFF),
      UInt8((total >> 8) & 0xFF), UInt8(total & 0xFF),
    ])
    out.append(buf.subdata(in: from ..< to))
    return out
  }

  private static func frameTotal(_ f: Data) -> Int {
    guard f.count >= 4 else { return 0 }
    return (Int(f[f.startIndex + 2]) << 8) | Int(f[f.startIndex + 3])
  }

  // -------------------------------------------------- per-central lifetime

  /** Remember this central and keep the roster small. Called at every point
   that CREATES per-central state; the touched central moves to the newest
   end first, so it can never evict itself. */
  private func trackCentral(_ central: UUID) {
    centralSeen.removeAll { $0 == central }
    centralSeen.append(central)
    while centralSeen.count > Self.maxTrackedCentrals {
      dropCentralState(centralSeen[0]) // removes it, so this terminates
    }
  }

  /** Free EVERY buffer one central made. */
  private func dropCentralState(_ central: UUID) {
    centralSeen.removeAll { $0 == central }
    digestCursor.removeValue(forKey: central)
    digestStreamGen.removeValue(forKey: central)
    digestFrame.removeValue(forKey: central)
    msgCursor.removeValue(forKey: central)
    msgFrame.removeValue(forKey: central)
    msgBuffers.removeValue(forKey: central)
    wantAssembly.removeValue(forKey: central)
  }

  /** Every central at once — the radio powered off or sharing stopped, so
   nothing we hold for any of them can still be in flight. */
  private func dropAllCentralState() {
    centralSeen.removeAll()
    digestCursor.removeAll()
    digestStreamGen.removeAll()
    digestFrame.removeAll()
    msgCursor.removeAll()
    msgFrame.removeAll()
    msgBuffers.removeAll()
    wantAssembly.removeAll()
  }

  /** One WANT frame, however it reached us — a short write that fits the
   MTU, or a long write assembled from its offset slices (see
   didReceiveWrite). Mirrors the Android server's handleWantFrame. */
  private func handleWantFrame(central: UUID, value: Data) {
    guard value.count >= 4 else { return }
    let seq = (Int(value[value.startIndex]) << 8) | Int(value[value.startIndex + 1])
    let total = (Int(value[value.startIndex + 2]) << 8) | Int(value[value.startIndex + 3])
    let chunk = value.subdata(in: (value.startIndex + 4) ..< value.endIndex)
    if seq == 0 {
      trackCentral(central)
      wantAssembly[central] = chunk
    } else {
      guard var buf = wantAssembly[central] else { return }
      guard buf.count + chunk.count <= Self.maxWantBytes else {
        wantAssembly.removeValue(forKey: central)
        return
      }
      buf.append(chunk)
      wantAssembly[central] = buf
    }
    guard seq + 1 >= total, let full = wantAssembly.removeValue(forKey: central) else { return }
    // fresh want = fresh response stream; JS assembles it
    msgBuffers.removeValue(forKey: central)
    msgCursor.removeValue(forKey: central)
    msgFrame.removeValue(forKey: central)
    sendEvent(withName: Self.syncWantEvent, body: [
      "peerId": central.uuidString,
      "payload": full.base64EncodedString(),
    ])
  }

  // ------------------------------------------------------------ payload

  @objc(setPayload:resolver:rejecter:)
  func setPayload(
    _ payloadB64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = Data(base64Encoded: payloadB64) else {
      reject("payload", "payload is not base64", nil)
      return
    }
    payload = data
    // Unlike Android, the advertisement itself carries no payload here — the
    // GATT characteristic serves the field directly, so no restart is needed.
    resolve(nil)
  }

  @objc(setSyncDigest:resolver:rejecter:)
  func setSyncDigest(
    _ b64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = Data(base64Encoded: b64) else {
      reject("payload", "digest is not base64", nil)
      return
    }
    // Onto the CoreBluetooth queue, which is where every read of this state
    // happens: this method arrives on React Native's own method queue, and
    // the roster cap below means one queue can now evict a central the
    // other is actively serving.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.syncDigest = data
      self.digestGeneration += 1
    }
    resolve(nil)
  }

  @objc(provideSyncMessages:payload:resolver:rejecter:)
  func provideSyncMessages(
    _ peerId: String,
    payload b64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let id = UUID(uuidString: peerId), let data = Data(base64Encoded: b64) else {
      reject("payload", "bad peer id or base64", nil)
      return
    }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.trackCentral(id)
      self.msgBuffers[id] = data
      self.msgCursor[id] = 0
      self.msgFrame.removeValue(forKey: id)
    }
    resolve(nil)
  }

  // ------------------------------------------------------------ advertise

  @objc(startAdvertising:rejecter:)
  func startAdvertising(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard !payload.isEmpty else {
      reject("payload", "setPayload first", nil)
      return
    }
    wantAdvertising = true
    startAdvertisePromise = (resolve, reject)
    if peripheralManager == nil {
      // Creating the manager IS the OS permission ask (NSBluetooth string);
      // the state callback carries the verdict and finishes the promise.
      peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    } else {
      peripheralManagerDidUpdateState(peripheralManager!)
    }
  }

  @objc(stopAdvertising:rejecter:)
  func stopAdvertising(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    wantAdvertising = false
    peripheralManager?.stopAdvertising()
    advertising = false
    emitState()
    resolve(nil)
  }

  // ------------------------------------------------------------ scan

  @objc(startScan:rejecter:)
  func startScan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    wantScanning = true
    startScanPromise = (resolve, reject)
    if centralManager == nil {
      centralManager = CBCentralManager(delegate: self, queue: nil)
    } else {
      centralManagerDidUpdateState(centralManager!)
    }
  }

  @objc(stopScan:rejecter:)
  func stopScan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    wantScanning = false
    centralManager?.stopScan()
    cancelRescan()
    scanning = false
    emitState()
    resolve(nil)
  }

  /**
   FOREGROUND FAST PATH (field report 2026-08-25), the iOS half. While the
   app is on screen JS asks for the low-latency posture — the human is
   watching the pod and seconds matter — and hands back the frugal one when
   the app backgrounds or the session stops. On this platform the knob is
   CBCentralManagerScanOptionAllowDuplicatesKey plus the frugal rescan tick
   (see frugalRescanInterval); a scan restart, unlike an advertise restart,
   has no identity cost, because scanning owns no address. The ADVERTISE
   interval deliberately has no such knob on either platform: restarting the
   advertisement mints a fresh random address and re-opens the rotation
   wound the AdvertisingSet path closed.

   Two iOS truths this cannot paper over, and does not try to: backgrounded,
   the OS ignores allowDuplicates and coalesces scans on its own, and a
   suspended app's rescan tick does not fire. So the posture is stored
   regardless and applied wherever it still means something — which also
   keeps the reverse arc real, because the next foreground start reads the
   posture this call left behind.
   */
  @objc(setScanMode:resolver:rejecter:)
  func setScanMode(
    _ lowLatency: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // Onto the CoreBluetooth queue: this arrives on React Native's own
    // method queue, and every read of scanning/scanLowLatency below happens
    // on main.
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      guard self.scanLowLatency != lowLatency else {
        resolve(nil)
        return
      }
      self.scanLowLatency = lowLatency
      guard self.scanning, let central = self.centralManager,
            central.state == .poweredOn else {
        // Stored posture only; the next startScan reads it.
        resolve(nil)
        return
      }
      // No emitState around this: `scanning` is true before and after, and
      // a momentary false would read to the JS honesty machine (session.ts)
      // as a radio interruption over a radio that never stopped.
      central.stopScan()
      self.beginScan(central)
      resolve(nil)
    }
  }

  /** Bring the scan up under the CURRENT posture — the one place that
   decides a duty cycle, shared by the startScan path and the posture flip
   so the two can never drift. */
  private func beginScan(_ central: CBCentralManager) {
    central.scanForPeripherals(
      withServices: [Self.serviceUUID],
      // Duplicates ON in the low-latency posture: each repeat sighting
      // refreshes presence liveness, and the JS presence store is the
      // dedupe layer, not the radio. OFF is the frugal posture, which the
      // rescan tick below keeps from becoming silence.
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: scanLowLatency]
    )
    scanning = true
    armRescan()
  }

  /** The frugal posture's re-report tick. Only a stop/start makes
   CoreBluetooth report an already-discovered peripheral again with
   duplicates off, so that is what this does. It does not re-arm itself
   from inside beginScan, so a posture flip is the only thing that
   reschedules it. */
  private func armRescan() {
    cancelRescan()
    guard !scanLowLatency else { return }
    rescanTimer = Timer.scheduledTimer(
      withTimeInterval: Self.frugalRescanInterval,
      repeats: true
    ) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      guard !self.scanLowLatency, self.scanning, self.wantScanning,
            let central = self.centralManager, central.state == .poweredOn else { return }
      central.stopScan()
      central.scanForPeripherals(
        withServices: [Self.serviceUUID],
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
      )
    }
  }

  /**
   A Timer must be invalidated from the thread that installed it, and this
   one is installed on main (beginScan runs there, on the CoreBluetooth
   queue). stopScan and stopAll arrive on React Native's own method queue,
   so those calls have to hop — while armRescan, already on main, must NOT,
   because it cancels and immediately reschedules and a deferred cancel
   would kill the timer it just installed.
   */
  private func cancelRescan() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.rescanTimer?.invalidate()
        self?.rescanTimer = nil
      }
      return
    }
    rescanTimer?.invalidate()
    rescanTimer = nil
  }

  @objc(stopAll:rejecter:)
  func stopAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    wantAdvertising = false
    wantScanning = false
    peripheralManager?.stopAdvertising()
    centralManager?.stopScan()
    cancelRescan()
    for (_, p) in inFlight {
      centralManager?.cancelPeripheralConnection(p)
    }
    inFlight.removeAll()
    syncOp?.fail("stopped")
    // Sharing stopped: the peripheral serves nobody, so it holds nobody's
    // buffers either (Android's stopGattServer does the same on its way
    // out). On the CoreBluetooth queue, because that is where the read and
    // write handlers touch these dictionaries and a Swift Dictionary
    // written from two queues at once is undefined, not merely stale.
    DispatchQueue.main.async { [weak self] in self?.dropAllCentralState() }
    advertising = false
    scanning = false
    emitState()
    resolve(nil)
  }

  @objc(isSupported:rejecter:)
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(true) // every supported iPhone has BLE; state events carry denial
  }

  // Phase C is Android's foreground service; iOS rides its declared
  // background modes. These exist so JS can call them unconditionally.
  @objc(startForegroundSession:rejecter:)
  func startForegroundSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  @objc(stopForegroundSession:rejecter:)
  func stopForegroundSession(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  // ------------------------------------------------------------ sync client

  @objc(syncWithPeer:want:resolver:rejecter:)
  func syncWithPeer(
    _ peerId: String,
    want wantB64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard syncOp == nil else {
      reject("busy", "another sync is running", nil)
      return
    }
    guard let id = UUID(uuidString: peerId) else {
      reject("peer", "unknown peer id", nil)
      return
    }
    guard let central = centralManager, central.state == .poweredOn else {
      reject("bluetooth-off", "Bluetooth is off", nil)
      return
    }
    let want = wantB64.isEmpty ? Data() : (Data(base64Encoded: wantB64) ?? Data())
    guard let peripheral = central.retrievePeripherals(withIdentifiers: [id]).first else {
      reject("peer", "peer not seen recently", nil)
      return
    }
    let op = SyncOp(module: self, peripheral: peripheral, want: want, resolve: resolve, reject: reject)
    syncOp = op
    op.start()
  }

  fileprivate func syncFinished() {
    syncOp = nil
  }

  /** The connected sync state machine — mirrors the Android SyncClient. */
  fileprivate final class SyncOp: NSObject, CBPeripheralDelegate {
    private weak var module: CrewBeacon?
    private let peripheral: CBPeripheral
    private let want: Data
    private let resolve: RCTPromiseResolveBlock
    private let reject: RCTPromiseRejectBlock
    private var digestOut = Data()
    private var msgOut = Data()
    private var phase = "digest"
    private var wantSeq = 0
    /** The seq this side expects next. A peer whose digest changed between
     our reads restarts its stream at seq 0 (see the serving side's
     generation logic); appending its frame 0 onto our half-read old stream
     would build a digest that never existed on either phone. */
    private var expectSeq = 0
    private var done = false
    private var chars: [CBUUID: CBCharacteristic] = [:]

    init(
      module: CrewBeacon,
      peripheral: CBPeripheral,
      want: Data,
      resolve: @escaping RCTPromiseResolveBlock,
      reject: @escaping RCTPromiseRejectBlock
    ) {
      self.module = module
      self.peripheral = peripheral
      self.want = want
      self.resolve = resolve
      self.reject = reject
      super.init()
    }

    var peerIdentifier: UUID { peripheral.identifier }

    func start() {
      peripheral.delegate = self
      module?.inFlight[peripheral.identifier] = peripheral
      module?.centralManager?.connect(peripheral, options: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + CrewBeacon.syncTimeout) { [weak self] in
        self?.fail("sync timed out")
      }
    }

    func connected() {
      peripheral.discoverServices([CrewBeacon.serviceUUID])
    }

    func fail(_ why: String) {
      guard !done else { return }
      done = true
      cleanup()
      reject("sync", why, nil)
    }

    private func finishOk() {
      guard !done else { return }
      done = true
      cleanup()
      resolve([
        "digest": digestOut.base64EncodedString(),
        "messages": msgOut.base64EncodedString(),
      ])
    }

    private func cleanup() {
      module?.centralManager?.cancelPeripheralConnection(peripheral)
      module?.inFlight.removeValue(forKey: peripheral.identifier)
      module?.syncFinished()
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
      guard error == nil,
            let service = p.services?.first(where: { $0.uuid == CrewBeacon.serviceUUID }) else {
        fail("peer has no crew service")
        return
      }
      p.discoverCharacteristics(
        [CrewBeacon.digestChar, CrewBeacon.wantChar, CrewBeacon.msgChar],
        for: service
      )
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
      guard error == nil else {
        fail("discover failed")
        return
      }
      for ch in service.characteristics ?? [] {
        chars[ch.uuid] = ch
      }
      guard chars[CrewBeacon.digestChar] != nil else {
        fail("peer has no crew service")
        return
      }
      readStream()
    }

    private func readStream() {
      let uuid = phase == "digest" ? CrewBeacon.digestChar : CrewBeacon.msgChar
      guard let ch = chars[uuid] else {
        fail("peer has no crew service")
        return
      }
      peripheral.readValue(for: ch)
    }

    private func writeWantFrame() {
      guard let ch = chars[CrewBeacon.wantChar] else {
        fail("peer has no crew service")
        return
      }
      let total = want.isEmpty ? 1 : (want.count + CrewBeacon.frameChunk - 1) / CrewBeacon.frameChunk
      let from = wantSeq * CrewBeacon.frameChunk
      let to = min(from + CrewBeacon.frameChunk, want.count)
      var frame = Data([
        UInt8((wantSeq >> 8) & 0xFF), UInt8(wantSeq & 0xFF),
        UInt8((total >> 8) & 0xFF), UInt8(total & 0xFF),
      ])
      frame.append(want.subdata(in: from ..< to))
      peripheral.writeValue(frame, for: ch, type: .withResponse)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
      guard error == nil else {
        fail("want write failed")
        return
      }
      let total = want.isEmpty ? 1 : (want.count + CrewBeacon.frameChunk - 1) / CrewBeacon.frameChunk
      wantSeq += 1
      if wantSeq < total {
        writeWantFrame()
      } else {
        phase = "messages"
        expectSeq = 0
        readStream()
      }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
      guard !done else { return }
      guard error == nil, let value = characteristic.value, value.count >= 4 else {
        fail("read failed")
        return
      }
      let seq = (Int(value[value.startIndex]) << 8) | Int(value[value.startIndex + 1])
      let total = (Int(value[value.startIndex + 2]) << 8) | Int(value[value.startIndex + 3])
      if total == 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + CrewBeacon.notReadyRetry) { [weak self] in
          guard let self, !self.done else { return }
          self.readStream()
        }
        return
      }
      if seq != expectSeq {
        // The peer restarted this stream under us — its store changed and
        // its digest moved to a new generation. Two generations must never
        // be concatenated: take a seq 0 as a clean restart, refuse anything
        // else rather than assemble a frame sequence that means nothing.
        guard seq == 0 else {
          fail("stream restarted out of order")
          return
        }
        if phase == "digest" {
          digestOut = Data()
        } else {
          msgOut = Data()
        }
      }
      let chunk = value.subdata(in: (value.startIndex + 4) ..< value.endIndex)
      if phase == "digest" {
        digestOut.append(chunk)
      } else {
        msgOut.append(chunk)
      }
      expectSeq = seq + 1
      if seq + 1 < total {
        readStream()
        return
      }
      if phase == "digest" {
        if want.isEmpty {
          finishOk()
        } else {
          phase = "want"
          wantSeq = 0
          writeWantFrame()
        }
      } else {
        finishOk()
      }
    }
  }
}

// ------------------------------------------------------------ peripheral side

extension CrewBeacon: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      guard wantAdvertising, !advertising else {
        // Already up: SETTLE the asker. A re-arm after a power cycle (the
        // JS bounce recovery) calls startAdvertising again, and an
        // unsettled promise there would leave the session awaiting forever
        // — and therefore reading "interrupted" over a working radio.
        // Android's equivalent already resolves on skip=already-advertising.
        startAdvertisePromise?.resolve(nil)
        startAdvertisePromise = nil
        return
      }
      if !serviceAdded {
        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        let mk = { (uuid: CBUUID, props: CBCharacteristicProperties, perms: CBAttributePermissions) in
          CBMutableCharacteristic(type: uuid, properties: props, value: nil, permissions: perms)
        }
        service.characteristics = [
          mk(Self.payloadChar, [.read], [.readable]),
          mk(Self.digestChar, [.read], [.readable]),
          mk(Self.wantChar, [.write], [.writeable]),
          mk(Self.msgChar, [.read], [.readable]),
        ]
        peripheral.add(service)
        serviceAdded = true
      }
      peripheral.startAdvertising([
        CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
      ])
    case .unauthorized:
      startAdvertisePromise?.reject("permission", "Bluetooth permission denied", nil)
      startAdvertisePromise = nil
      emitState("Bluetooth permission denied")
    case .poweredOff:
      startAdvertisePromise?.reject("bluetooth-off", "Bluetooth is off", nil)
      startAdvertisePromise = nil
      advertising = false
      // CoreBluetooth drops published services when the radio powers off,
      // so the next poweredOn must re-add ours or the advertisement comes
      // back with nothing to read behind it — the iOS shape of Android's
      // "close the GATT server on adapter-off".
      serviceAdded = false
      // Same reason the Android server frees on close: no central's stream
      // survives the radio, so nothing we hold for one can be in flight.
      dropAllCentralState()
      emitState("Bluetooth is off")
    default:
      break // resetting/unknown resolve on the next state callback
    }
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      advertising = false
      startAdvertisePromise?.reject("advertise", error.localizedDescription, error)
      startAdvertisePromise = nil
      emitState(error.localizedDescription)
      return
    }
    advertising = true
    startAdvertisePromise?.resolve(nil)
    startAdvertisePromise = nil
    emitState()
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    let central = request.central.identifier
    var value: Data
    // Set when this read hands over the LAST digest frame — the moment the
    // central provably holds our whole offer. Emitted below, after the
    // response, so a bridge hop never delays the read itself.
    var digestServed = false
    switch request.characteristic.uuid {
    case Self.payloadChar:
      value = payload
    case Self.digestChar:
      // Advance the cursor only on a FRESH read; continuation offsets slice
      // the same cached frame (iOS long-read semantics — see file header).
      // A digest that changed since this central's last fresh read rewinds
      // it to seq 0 HERE, at a boundary it chose, instead of under its feet
      // mid-read — see digestGeneration.
      if request.offset == 0 {
        let stale = digestStreamGen[central] != digestGeneration
        trackCentral(central)
        digestStreamGen[central] = digestGeneration
        let cur = stale ? 0 : (digestCursor[central] ?? 0)
        let f = Self.frame(of: syncDigest, cursor: cur)
        digestFrame[central] = f
        let total = Self.frameTotal(f)
        digestCursor[central] = (cur + 1 >= total) ? 0 : cur + 1
        // Building the final frame = this central is completing a digest
        // pull. One event per completed pull (offset-0 build only, so the
        // MTU continuations of this same frame never double-fire it).
        digestServed = cur + 1 >= total
      }
      value = digestFrame[central] ?? Data([0, 0, 0, 0])
    case Self.msgChar:
      if request.offset == 0 {
        let buf = msgBuffers[central]
        let cur = msgCursor[central] ?? 0
        let f = Self.frame(of: buf, cursor: cur)
        trackCentral(central)
        msgFrame[central] = f
        let total = Self.frameTotal(f)
        if buf != nil, cur + 1 >= total {
          msgBuffers.removeValue(forKey: central)
          msgCursor.removeValue(forKey: central)
        } else if buf != nil {
          msgCursor[central] = cur + 1
        }
      }
      value = msgFrame[central] ?? Data([0, 0, 0, 0])
    default:
      peripheral.respond(to: request, withResult: .attributeNotFound)
      return
    }
    guard request.offset <= value.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = value.subdata(in: request.offset ..< value.count)
    peripheral.respond(to: request, withResult: .success)
    if digestServed {
      // The peer that just pulled our digest is alive and in range RIGHT
      // NOW; JS dials back on this instead of waiting out a cooldown (the
      // delivery-latency fix, 2026-08-25). The id is this central's
      // peripheral-side identity, which is NOT the identifier we scan them
      // by — meshSync treats the event as "somebody pulled", not as an
      // address, and nudges everyone it can currently hear.
      sendEvent(withName: Self.syncServedEvent, body: ["peerId": central.uuidString])
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    // A LONG WRITE ARRIVES AS SEVERAL OFFSET-SLICED REQUESTS, NOT SEVERAL
    // FRAMES — the write-side mirror of the long-READ rule this file
    // already documents. CoreBluetooth splits a central's oversized
    // writeValue automatically, and this loop used to read each slice's
    // first four bytes as a [seq][total] header, so every want list longer
    // than one ATT payload was mis-parsed. Assemble by offset first, then
    // hand ONE value per central to the frame handler.
    var assembled: [UUID: Data] = [:]
    var result: CBATTError.Code = .success
    var ok = true
    for request in requests {
      guard request.characteristic.uuid == Self.wantChar, let value = request.value else { continue }
      let central = request.central.identifier
      var buf = assembled[central] ?? Data()
      guard request.offset == buf.count else {
        result = .invalidOffset
        ok = false
        break
      }
      guard buf.count + value.count <= Self.maxPreparedBytes else {
        result = .invalidAttributeValueLength
        ok = false
        break
      }
      buf.append(value)
      assembled[central] = buf
    }
    // One response settles the whole batch, per CoreBluetooth's contract.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: result)
    }
    guard ok else { return }
    for (central, value) in assembled {
      handleWantFrame(central: central, value: value)
    }
  }
}

// ------------------------------------------------------------ central side

extension CrewBeacon: CBCentralManagerDelegate, CBPeripheralDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      guard wantScanning, !scanning else {
        // Same reason as the peripheral side: an already-scanning central
        // must still settle a fresh startScan, or the bounce recovery
        // hangs on its own success.
        startScanPromise?.resolve(nil)
        startScanPromise = nil
        return
      }
      beginScan(central)
      startScanPromise?.resolve(nil)
      startScanPromise = nil
      emitState()
    case .unauthorized:
      startScanPromise?.reject("permission", "Bluetooth permission denied", nil)
      startScanPromise = nil
      cancelRescan()
      emitState("Bluetooth permission denied")
    case .poweredOff:
      startScanPromise?.reject("bluetooth-off", "Bluetooth is off", nil)
      startScanPromise = nil
      scanning = false
      // Nothing to re-report while the radio is down, and the tick would
      // otherwise poke a powered-off central twice a minute until it comes
      // back. The poweredOn branch above re-arms it under the posture JS
      // last asked for — which is the point of storing the posture.
      cancelRescan()
      emitState("Bluetooth is off")
    default:
      break
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let peerId = peripheral.identifier.uuidString
    if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
       mfg.count > 2 {
      // Manufacturer data arrives with its 2-byte little-endian company id
      // prefix; 0xFFFF is ours (the Android side's id). Anything else under
      // our service UUID is a stranger's coincidence — ignore.
      let company = UInt16(mfg[mfg.startIndex]) | (UInt16(mfg[mfg.startIndex + 1]) << 8)
      if company == Self.manufacturerId {
        emitSighting(mfg.dropFirst(2), rssi: RSSI, via: "adv", peerId: peerId)
        return
      }
    }
    // No inline payload: an iOS peer. Connect and read, rate-limited — and
    // globally capped (cross-family review): a dense crowd of first
    // sightings must not open N parallel connects on one radio.
    let id = peripheral.identifier
    if inFlight.count >= 2 { return }
    if inFlight[id] != nil { return }
    if let last = lastTried[id], Date().timeIntervalSince(last) < Self.gattCooldown { return }
    lastTried[id] = Date()
    lastRssi[id] = RSSI
    inFlight[id] = peripheral
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.gattTimeout) { [weak self] in
      guard let self, self.inFlight[id] != nil, self.syncOp == nil else { return }
      self.finish(peripheral)
    }
  }

  private func finish(_ peripheral: CBPeripheral) {
    centralManager?.cancelPeripheralConnection(peripheral)
    inFlight.removeValue(forKey: peripheral.identifier)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    if let op = syncOp, peripheral.identifier == op.peerIdentifier {
      op.connected()
      return
    }
    peripheral.discoverServices([Self.serviceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    if let op = syncOp, peripheral.identifier == op.peerIdentifier {
      op.fail("could not connect")
      return
    }
    inFlight.removeValue(forKey: peripheral.identifier)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    inFlight.removeValue(forKey: peripheral.identifier)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil,
          let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
      finish(peripheral)
      return
    }
    peripheral.discoverCharacteristics([Self.payloadChar], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard error == nil,
          let ch = service.characteristics?.first(where: { $0.uuid == Self.payloadChar }) else {
      finish(peripheral)
      return
    }
    peripheral.readValue(for: ch)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if error == nil, characteristic.uuid == Self.payloadChar,
       let value = characteristic.value, !value.isEmpty {
      emitSighting(
        value,
        rssi: lastRssi[peripheral.identifier] ?? 0,
        via: "gatt",
        peerId: peripheral.identifier.uuidString
      )
    }
    finish(peripheral)
  }
}
