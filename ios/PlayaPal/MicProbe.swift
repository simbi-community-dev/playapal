import AVFoundation
import Foundation
import React

/**
 The controlled smoke test the mini's mic saga earned (2026-08-25/26,
 builds 25 through TF5: every strategy shipped blind cost a TestFlight
 cycle). One tap runs EVERY candidate capture strategy on the actual
 device and reports each outcome — RAISE with CoreAudio's words, OK with
 the format that flowed, NO-AUDIO, or a session error — so the next fix
 ships knowing, not guessing. The prime suspect it separates: voice notes
 record fine in .spokenAudio while the walkie taps in .voiceChat, the
 mode that engages the voice-processing unit.
 */
@objc(MicProbe)
class MicProbe: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  private struct Variant {
    let name: String
    let mode: AVAudioSession.Mode
    let useInputFormat: Bool
  }

  @objc(run:rejecter:)
  func run(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      var lines: [String] = []
      let variants: [Variant] = [
        Variant(name: "voiceChat + nil (walkie today)", mode: .voiceChat, useInputFormat: false),
        Variant(name: "default + nil", mode: .default, useInputFormat: false),
        Variant(name: "spokenAudio + nil (voice notes' mode)", mode: .spokenAudio, useInputFormat: false),
        Variant(name: "measurement + nil", mode: .measurement, useInputFormat: false),
        Variant(name: "default + inputFormat", mode: .default, useInputFormat: true),
      ]
      for v in variants {
        lines.append(v.name + " -> " + Self.probe(v))
      }
      lines.append("recorder control -> " + Self.recorderProbe())
      resolve(lines.joined(separator: "\n"))
    }
  }

  private static func probe(_ v: Variant) -> String {
    let session = AVAudioSession.sharedInstance()
    do {
      try? session.setActive(false)
      try session.setCategory(.playAndRecord, mode: v.mode, options: [.defaultToSpeaker])
      try session.setActive(true)
    } catch {
      return "session-fail " + error.localizedDescription
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let sem = DispatchSemaphore(value: 0)
    var got: AVAudioFormat?
    var fmt: AVAudioFormat?
    if v.useInputFormat {
      fmt = input.inputFormat(forBus: 0)
    }
    let exc = ObjCTry.run {
      input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in
        if got == nil {
          got = buf.format
          sem.signal()
        }
      }
    }
    if let exc {
      return "RAISE " + (exc.reason ?? exc.name.rawValue)
    }
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      return "engine-fail " + error.localizedDescription
    }
    let r = sem.wait(timeout: .now() + 1.2)
    input.removeTap(onBus: 0)
    engine.stop()
    guard r != .timedOut, let f = got else {
      return "NO-AUDIO (tap installed, no buffers)"
    }
    return "OK " + String(Int(f.sampleRate)) + "Hz/" + String(f.channelCount) + "ch"
  }

  private static func recorderProbe() -> String {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("micprobe.m4a")
    let session = AVAudioSession.sharedInstance()
    do {
      try? session.setActive(false)
      try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
      try session.setActive(true)
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 16000,
        AVNumberOfChannelsKey: 1,
      ]
      let r = try AVAudioRecorder(url: url, settings: settings)
      r.record()
      Thread.sleep(forTimeInterval: 0.6)
      let ran = r.isRecording
      r.stop()
      try? FileManager.default.removeItem(at: url)
      return ran ? "OK (recording ran)" : "NOT-RECORDING"
    } catch {
      return "fail " + error.localizedDescription
    }
  }
}
