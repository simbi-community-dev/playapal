import AVFoundation
import Foundation
import React

/**
 FieldAudio — voice notes for the pod's answering machine (docs/
 CREW-DESIGN.md §6b), iOS half. Mirrors the Android module exactly: record
 a short clip tuned for tiny-but-intelligible speech (AAC mono 16 kHz
 24 kbps ≈ 3 KB/s; 30 s hard stop ≈ 90 KB — under the 256 KiB message cap
 with base64 overhead), hand back base64, play a clip on arrival. The
 SQLite message store owns the bytes; temp files are deleted the moment
 they are read or playback ends.

 The FIRST record on iOS triggers the OS microphone ask
 (NSMicrophoneUsageDescription) — in context at the record button, the same
 discipline as every other permission in this app. A denial rejects with
 code 'permission' and the UI shows recoverable copy.
 */
@objc(FieldAudio)
final class FieldAudio: NSObject {
  private static let maxSeconds: TimeInterval = 30

  private var recorder: AVAudioRecorder?
  private var recordURL: URL?
  private var recordStartedAt = Date()
  private var player: AVAudioPlayer?
  private var playURL: URL?

  @objc
  static func requiresMainQueueSetup() -> Bool { false }

  private func tempURL(_ prefix: String) -> URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("voice-notes", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(prefix)-\(UUID().uuidString).m4a")
  }

  // ------------------------------------------------------------ record

  @objc(startRecording:rejecter:)
  func startRecording(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard recorder == nil else {
      reject("busy", "already recording", nil)
      return
    }
    let session = AVAudioSession.sharedInstance()
    session.requestRecordPermission { [weak self] granted in
      guard let self else { return }
      guard granted else {
        reject("permission", "microphone", nil)
        return
      }
      do {
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
        try session.setActive(true)
        let url = self.tempURL("rec")
        let settings: [String: Any] = [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: 16_000,
          AVNumberOfChannelsKey: 1,
          AVEncoderBitRateKey: 24_000,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        r.record(forDuration: Self.maxSeconds)
        self.recorder = r
        self.recordURL = url
        self.recordStartedAt = Date()
        resolve(nil)
      } catch {
        reject("record", error.localizedDescription, error)
      }
    }
  }

  @objc(stopRecording:rejecter:)
  func stopRecording(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let r = recorder, let url = recordURL else {
      reject("idle", "not recording", nil)
      return
    }
    recorder = nil
    recordURL = nil
    let durationMs = Int(Date().timeIntervalSince(recordStartedAt) * 1000)
    r.stop()
    defer { try? FileManager.default.removeItem(at: url) }
    guard let data = try? Data(contentsOf: url), !data.isEmpty else {
      reject("empty", "nothing recorded — hold the button a moment longer", nil)
      return
    }
    resolve([
      "base64": data.base64EncodedString(),
      "mime": "audio/mp4",
      "bytes": data.count,
      "durationMs": durationMs,
    ])
  }

  // ------------------------------------------------------------ play

  @objc(play:resolver:rejecter:)
  func play(
    _ b64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    stopPlaybackInternal()
    guard let data = Data(base64Encoded: b64) else {
      reject("payload", "clip is not base64", nil)
      return
    }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
      try AVAudioSession.sharedInstance().setActive(true)
      let p = try AVAudioPlayer(data: data)
      p.play()
      player = p
      resolve(Int(p.duration * 1000))
    } catch {
      reject("play", error.localizedDescription, error)
    }
  }

  @objc(stopPlayback:rejecter:)
  func stopPlayback(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    stopPlaybackInternal()
    resolve(nil)
  }

  private func stopPlaybackInternal() {
    player?.stop()
    player = nil
    if let url = playURL {
      try? FileManager.default.removeItem(at: url)
      playURL = nil
    }
  }
}
