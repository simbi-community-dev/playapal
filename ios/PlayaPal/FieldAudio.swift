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

  /**
   Walk the top-level MPEG-4 boxes looking for `moov`, the table that says
   where the audio frames are. A player needs it; a take that never finished
   writing does not have it. Structural only — this says a player will find
   something to open, never that the audio sounds right.
   */
  private func hasIndex(_ data: Data) -> Bool {
    var off = 0
    var boxes = 0
    while off + 8 <= data.count && boxes < 64 {
      var size = 0
      for i in 0..<4 {
        size = (size << 8) | Int(data[off + i])
      }
      let type = String(bytes: data[(off + 4)..<(off + 8)], encoding: .ascii) ?? ""
      if type == "moov" {
        return true
      }
      if size == 1 {
        guard off + 16 <= data.count else { return false }
        size = 0
        for i in 8..<16 {
          size = (size << 8) | Int(data[off + i])
        }
      }
      // size 0 means "to the end of the file" — exactly an unfinalised mdat,
      // and nothing can follow it.
      if size < 8 {
        return false
      }
      off += size
      boxes += 1
    }
    return false
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
      reject("empty", "Nothing recorded — hold the button a moment longer.", nil)
      return
    }
    // A take with no INDEX is not a short take, it is a dead one: AAC in
    // MPEG-4 streams into `mdat` while recording and only gets its `moov`
    // table at stop(), so a take that failed to finalise is non-empty,
    // plausible-looking and unplayable forever. Sending it costs every relay
    // in camp its bytes and hands the recipient 'prepare failed status=0x1'
    // (the Android field report, 2026-08-25). Same check as the Android half
    // and as src/crews/voiceClip.ts.
    guard hasIndex(data) else {
      reject(
        "damaged",
        "That take didn't finish recording — hold the button a moment longer and try again.",
        nil
      )
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
    guard let data = Data(base64Encoded: b64), !data.isEmpty else {
      // Never the framework's words: these bytes came off someone else's
      // phone over a gossip mesh, so the only true action is the social one.
      reject("damaged", "That voice note arrived scrambled — ask them to send it again.", nil)
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
      reject(
        "damaged",
        hasIndex(data)
          ? "This phone couldn't play that voice note — ask them to send it again."
          : "This voice note never finished recording on their phone — ask them to send it again.",
        error
      )
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
