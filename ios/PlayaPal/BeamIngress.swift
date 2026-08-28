import Foundation
import React
import UniformTypeIdentifiers

@objc(BeamIngress)
final class BeamIngress: RCTEventEmitter {
  private static let eventName = "PlayaPalBeamIngress"
  private static let maxBytes = 4 * 1024 * 1024 + 4 * 1024
  private static let copyQueue = DispatchQueue(
    label: "com.playapal.beam-ingress.copy",
    qos: .utility
  )

  // RN 0.87 creates the module after didFinishLaunching on a cold document open.
  // The payload queue stays on main; listener state is locked because React calls
  // start/stopObserving on the module queue.
  private static var pending: [[String: Any]] = []
  private static weak var emitter: BeamIngress?
  private let observationLock = NSLock()
  private var observing = false

  override init() {
    super.init()
    Self.emitter = self
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    [Self.eventName]
  }

  override func startObserving() {
    observationLock.lock()
    observing = true
    observationLock.unlock()
  }

  override func stopObserving() {
    observationLock.lock()
    observing = false
    observationLock.unlock()
  }

  private var hasListener: Bool {
    observationLock.lock()
    defer { observationLock.unlock() }
    return observing
  }

  @objc(drain:rejecter:)
  func drain(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let items = Self.pending
      Self.pending.removeAll()
      resolve(items)
    }
  }

  static func receive(_ url: URL) {
    dispatchPrecondition(condition: .onQueue(.main))
    let ingressId = UUID().uuidString
    let scoped = url.startAccessingSecurityScopedResource()
    copyQueue.async {
      defer {
        if scoped {
          url.stopAccessingSecurityScopedResource()
        }
      }
      let payload = copy(url, ingressId: ingressId)
      DispatchQueue.main.async {
        pending.append(payload)
        if let emitter, emitter.hasListener {
          emitter.sendEvent(withName: eventName, body: payload)
        }
      }
    }
  }

  private static func copy(_ url: URL, ingressId: String) -> [String: Any] {
    let values = try? url.resourceValues(forKeys: [.contentTypeKey, .nameKey])
    let displayName = values?.name ?? url.lastPathComponent
    let mime = values?.contentType?.preferredMIMEType ?? ""
    var payload: [String: Any] = [
      "ingressId": ingressId,
      "displayName": displayName,
      "mime": mime,
      "bytes": 0,
      "source": "ios-document",
    ]

    let fileManager = FileManager.default
    let directory = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("beam-ingress", isDirectory: true)
    let destination = directory.appendingPathComponent("\(ingressId).playapal")

    var bytes = 0
    do {
      try fileManager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: nil
      )
      guard fileManager.createFile(atPath: destination.path, contents: nil) else {
        throw CopyError.couldNotCreateDestination
      }

      let input = try FileHandle(forReadingFrom: url)
      defer { try? input.close() }
      let output = try FileHandle(forWritingTo: destination)
      defer { try? output.close() }

      while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
        bytes += chunk.count
        guard bytes <= maxBytes else {
          throw CopyError.tooLarge
        }
        try output.write(contentsOf: chunk)
      }

      payload["localPath"] = destination.path
      payload["bytes"] = bytes

      // AirDrop deposits app-owned imports in OUR Documents/Inbox. Once the
      // cache copy is complete, that original is redundant; cleanup is
      // best-effort. The guard is anchored to the app's own container, NOT a
      // substring: with LSSupportsOpeningDocumentsInPlace a Files-picker URL
      // points into the USER'S storage while the security scope is still
      // held, and a camper's iCloud folder named "Documents/Inbox" would
      // have matched a substring and been deleted (xrev pug-opus, cc9bbb4).
      // standardizedFileURL on both sides resolves the /private symlink that
      // would otherwise make the prefix silently never match on device.
      let inbox = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Inbox", isDirectory: true)
      if url.standardizedFileURL.path.hasPrefix(inbox.standardizedFileURL.path + "/") {
        try? fileManager.removeItem(at: url)
      }
    } catch CopyError.tooLarge {
      try? fileManager.removeItem(at: destination)
      payload["bytes"] = bytes
      payload["error"] = "too large"
    } catch {
      try? fileManager.removeItem(at: destination)
      payload["bytes"] = bytes
      payload["error"] = error.localizedDescription
    }

    return payload
  }
}

private enum CopyError: Error {
  case couldNotCreateDestination
  case tooLarge
}
