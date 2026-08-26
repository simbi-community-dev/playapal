import AVFoundation
import Foundation
import React

/**
 The controlled smoke test the mini's mic saga earned (2026-08-25/26,
 builds 25 through TF5: every strategy shipped blind cost a TestFlight
 cycle). One tap runs EVERY candidate capture strategy on the actual
 device and reports each outcome — RAISE with CoreAudio's words, OK with
 the format that flowed, ZEROED, NO-AUDIO, or a session error — so the
 next fix ships knowing, not guessing.

 THE DISTINCTION THIS PROBE EXISTS TO MAKE, added 2026-08-26 after the
 research sweep, because the first revision could not make it: "the
 walkie is silent" is TWO bugs wearing one symptom.

   - NO BUFFERS AT ALL — the tap object exists, the engine says it is
     running, and the input element's render callback never fires. That
     is an ENABLEMENT/ORDERING failure: nothing is asking the microphone
     for samples.
   - BUFFERS, EVERY SAMPLE ZERO — the callbacks fire on cadence and carry
     silence. That is a MUTE (voice-processing input mute, or iOS 17's
     app-wide AVAudioApplication mute, which zeroes samples and does not
     stop callbacks).

 They have completely different fixes and they used to print the same
 word here, so every arm now reports BUFFER COUNT and PEAK MAGNITUDE
 measured over the window, plus the four cheap facts that name the rest
 of the suspect list: the engine's isRunning at BOTH ends of the window
 (an engine that stops itself on a configuration change is invisible
 otherwise), the input node's own format (Apple names a nonzero
 sampleRate/channelCount as THE test for "is input enabled"), how many
 inputs the route carries and which port when it is not the built-in mic
 (a Bluetooth earpiece forgotten in a pocket is a live hypothesis for a
 field-only failure), and the app-wide input mute where the OS has one.

 ARMS 7 AND 8 ARE THE ORDERING A/B, and they are the reason the matrix
 grew. Arms 1-5 all build the graph and install the tap BEFORE start();
 the walkie historically could not — it started an OUTPUT-ONLY graph and
 first touched inputNode at talk time, growing an input element on an
 engine that was already rendering. So arms 1-5 never reproduced
 production, and an arm labelled "walkie today" was the one thing a
 diagnostic must never be: confidently mislabelled. Arm 7 runs both
 orderings back to back with everything else held constant; arm 8
 repeats the pair at the end of the sweep.

 TWO GATES STAND IN FRONT OF THE SWEEP (2026-08-26 review), because a
 diagnostic that reports confidently about a run it did not actually get to
 make is worse than no diagnostic:

   - PERMISSION, FIRST. Nothing here asks for the microphone before using
     it, so on a fresh install (undetermined) or a phone where someone once
     said no, every engine arm installs a tap on a mic that renders nothing
     and the report is nine NO-AUDIO/ZEROED lines and a NOT-RECORDING
     control — which is, letter for letter, the fingerprint of the
     enablement bug this probe exists to find. The one thing a diagnostic
     must never be is confidently mislabelled.
   - ONE AT A TIME. Every arm drives the SAME AVAudioSession singleton and
     the control writes ONE fixed file; two sweeps in flight do not run
     twice, they run into each other — arm N of one deactivates the session
     arm M of the other is measuring, and both reports describe a session
     neither of them owned. The row promises eight seconds, which is exactly
     long enough for a second tap.
 */
@objc(MicProbe)
class MicProbe: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// How long each arm listens. Long enough that a healthy tap delivers
  /// dozens of buffers — "how many" and "how loud" only mean something
  /// over a window — and short enough that nine engine arms plus the
  /// recorder control still finish inside the ~8 s the Settings row
  /// promises, which is the budget this probe has to live in.
  private static let window: TimeInterval = 0.8

  /// WHERE THE INPUT NODE IS CREATED, RELATIVE TO start(). The input node
  /// is a singleton the engine builds ON DEMAND at first access, and
  /// Apple documents its enabled-ness as a property of the session
  /// category and the route AT THAT MOMENT. So "when did you first touch
  /// it" is not a style question, it is the experiment.
  private enum Order {
    /// Arms 1-5: create the engine, touch inputNode, install the tap,
    /// THEN start. Everything is decided before a sample renders.
    case tapBeforeStart
    /// Arms 7a/8a: attach an output-only player graph, START, and only
    /// then first-touch inputNode and install the tap — the ordering the
    /// walkie had until 2026-08-26. The IO unit is initialised with no
    /// input element and is then asked to grow one while rendering.
    case startThenInput
    /// Arms 7b/8b: the same output-only graph, but inputNode is first
    /// touched BEFORE start (so the input element exists when the unit is
    /// initialised) and the tap still goes on afterwards — Walkie.swift's
    /// ensureEngine() as it ships today, replicated exactly.
    case inputThenStartThenTap
  }

  private struct Variant {
    let name: String
    let mode: AVAudioSession.Mode
    var useInputFormat = false
    var order: Order = .tapBeforeStart
  }

  /// PROCESS-WIDE, not per-instance: React Native holds one MicProbe, but
  /// the thing being protected is the AVAudioSession singleton and one fixed
  /// file path, both of which belong to the process. Static is what the
  /// resource actually is.
  private static let gate = NSLock()
  private static var running = false

  /// The single honest line for a phone that has said no. It names the
  /// place the answer can be changed, because "denied" without a door is a
  /// dead end for the one camper in a hundred who reads it.
  private static let deniedLine =
    "microphone permission denied — enable in Settings > Playa Pal"

  @objc(run:rejecter:)
  func run(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // THE CLAIM IS SYNCHRONOUS AND FIRST — before the permission ask, before
    // anything is dispatched. Claiming inside the async block would leave a
    // window exactly as wide as the dispatch, which is the window a double
    // tap lands in.
    guard Self.claim() else {
      // A refusal, not an answer: the camper asked for a measurement and got
      // none, so it travels the reject channel (the row's .catch shows the
      // message). "Denied" below is the opposite — a fact about the phone,
      // which is a measurement and resolves.
      reject("busy", "busy — a check is already running", nil)
      return
    }
    // PERMISSION BEFORE ARMS. .undetermined asks once and continues on a
    // grant, so the ordinary first tap still runs the sweep — with the
    // dialog answered, which is the state every arm's result assumes.
    Self.withRecordPermission { granted in
      guard granted else {
        Self.relinquish()
        resolve(Self.deniedLine)
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        defer { Self.relinquish() }
        resolve(Self.sweep())
      }
    }
  }

  /// TRUE for the one caller that takes the sweep; FALSE for everyone who
  /// arrives while it runs. `relinquish()` is owed on every path out of a
  /// successful claim — including the denied one, which runs no arm.
  private static func claim() -> Bool {
    gate.lock()
    defer { gate.unlock() }
    if running {
      return false
    }
    running = true
    return true
  }

  private static func relinquish() {
    gate.lock()
    running = false
    gate.unlock()
  }

  /// The permission STATE first, the ask only for the state that has no
  /// answer yet. Asking unconditionally would be a second dialog for a
  /// camper who already answered, and reading the state alone would never
  /// let a fresh install run the sweep at all.
  ///
  /// EAS-VERIFY: `AVAudioSession.recordPermission` and the instance
  /// `requestRecordPermission` — both are deprecated in iOS 17 in favour of
  /// `AVAudioApplication`, so expect a deprecation WARNING and no error.
  /// Walkie.swift and FieldAudio.swift already ship the same request call;
  /// if the builder ever turns those warnings into errors, all three move to
  /// `AVAudioApplication` together, not this one alone.
  private static func withRecordPermission(_ then: @escaping (Bool) -> Void) {
    let session = AVAudioSession.sharedInstance()
    switch session.recordPermission {
    case .granted:
      then(true)
    case .denied:
      then(false)
    default:
      // .undetermined (and anything a later OS adds): ask exactly once. The
      // callback can arrive on any queue — everything downstream of it
      // either dispatches or is already queue-agnostic.
      session.requestRecordPermission { then($0) }
    }
  }

  // ---------------------------------------------------------- the sweep

  private static func sweep() -> String {
    var lines: [String] = []
    let variants: [Variant] = [
      Variant(name: "voiceChat + nil", mode: .voiceChat),
      Variant(name: "default + nil (the walkie's mode)", mode: .default),
      Variant(name: "spokenAudio + nil (voice notes' mode)", mode: .spokenAudio),
      Variant(name: "measurement + nil", mode: .measurement),
      Variant(name: "default + inputFormat", mode: .default, useInputFormat: true),
      // ARM 7 — the ordering A/B, one variable. Both halves run the
      // walkie's mode and the walkie's output-only player graph, so the
      // ONLY difference between them is when inputNode is first
      // touched. 7a failing while 7b passes is on-device proof that the
      // ordering fix is the fix; both passing moves the suspicion off
      // ordering entirely, which is worth just as much.
      Variant(
        name: "7a start THEN inputNode (walkie before 08-26)",
        mode: .default,
        order: .startThenInput
      ),
      Variant(
        name: "7b inputNode THEN start (walkie today)",
        mode: .default,
        order: .inputThenStartThenTap
      ),
      // ARM 8 — arm 7 again, last in the sweep. It was meant to answer
      // "does an earlier WebRTC call poison capture?", and the honest
      // statement is that THIS PROCESS CANNOT TELL whether a call ran:
      // the WebRTC session lives inside the RN pod, MicProbe has no
      // seam to it, and the linked-framework check that looks like a
      // detector answers a build question, not a runtime one. So the
      // arm does not claim it. Run the probe once cold and once after
      // placing and ending a video call, and compare the two 8-lines —
      // the operator supplies the fact the code cannot. Re-running the
      // pair last also earns its keep on any single run: if 7 passes
      // and 8 fails, an earlier arm poisoned the session, which is a
      // finding about this probe's own hygiene.
      Variant(
        name: "8a = 7a, run last (post-call only if YOU made one)",
        mode: .default,
        order: .startThenInput
      ),
      Variant(
        name: "8b = 7b, run last (post-call only if YOU made one)",
        mode: .default,
        order: .inputThenStartThenTap
      ),
    ]
    for v in variants {
      lines.append(v.name + " -> " + Self.probe(v))
    }
    lines.append("recorder control -> " + Self.recorderProbe())
    // The run gives the microphone back. Printed because a session that
    // will NOT release is itself the diagnosis for whatever the camper
    // tries next.
    let last = Self.release()
    lines.append("session released -> " + (last.isEmpty ? "ok" : last))
    return lines.joined(separator: "\n")
  }

  // ------------------------------------------------------------ one arm

  private static func probe(_ v: Variant) -> String {
    let session = AVAudioSession.sharedInstance()
    // Arm N must not run on arm N-1's residue.
    var notes = release()
    do {
      try session.setCategory(.playAndRecord, mode: v.mode, options: [.defaultToSpeaker])
      try session.setActive(true)
    } catch {
      return "session-fail " + error.localizedDescription + notes
    }

    let engine = AVAudioEngine()
    let meter = Meter()
    var startFail: String?
    var startedRunning = false
    var fmt: AVAudioFormat?

    // THE WHOLE ARM RUNS UNDER THE CATCHER, not just the tap install.
    // Attach, connect, the first inputNode access and the format read are
    // all AVFAudio precondition sites, and a raise from any of them
    // aborts the app on the exact device this probe exists to diagnose.
    let exc = ObjCTry.run {
      // Nested so start() is written once: every arm starts the engine,
      // only the POSITION of the call differs, and that position IS the
      // experiment. One site also means one thing for a mutation to move.
      func start() {
        do {
          try engine.start()
        } catch {
          startFail = error.localizedDescription
        }
        startedRunning = engine.isRunning
      }
      if v.order != .tapBeforeStart {
        // The walkie starts with a PLAYBACK graph and no input element.
        // Reproducing that is the entire point of these arms, so the
        // player node and its wire format are ensureEngine()'s own, not
        // a stand-in that might render differently.
        let player = AVAudioPlayerNode()
        engine.attach(player)
        if let wire = AVAudioFormat(
          commonFormat: .pcmFormatInt16,
          sampleRate: 16000,
          channels: 1,
          interleaved: true
        ) {
          engine.connect(player, to: engine.mainMixerNode, format: wire)
        }
      }
      if v.order == .startThenInput {
        start()
        // ABORT ARM SETUP ON A FAILED START (codex 2/2): continuing into
        // the input touch and tap can RAISE, and the raise verdict would
        // then hide the actionable start error underneath it.
        if startFail != nil { return }
      }
      // FIRST TOUCH of the input-node singleton.
      let input = engine.inputNode
      fmt = format(of: input)
      if v.order == .inputThenStartThenTap {
        start()
        if startFail != nil { return }
      }
      input.installTap(
        onBus: 0,
        bufferSize: 1024,
        format: v.useInputFormat ? fmt : nil
      ) { buf, _ in
        meter.add(buf)
      }
      if v.order == .tapBeforeStart {
        start()
      }
    }

    // startFail BEFORE exc (codex 2/2): when both exist the start error is
    // the actionable one, and the raise is usually its downstream echo.
    if let startFail {
      cleanUp(engine)
      notes += release()
      return "engine-fail " + startFail + notes
    }
    if let exc {
      cleanUp(engine)
      notes += release()
      return "RAISE " + (exc.reason ?? exc.name.rawValue) + notes
    }

    Thread.sleep(forTimeInterval: window)

    // Read the live facts while the session is still active — a route and
    // a mute flag read after deactivation describe a session nobody used.
    let stillRunning = engine.isRunning
    let route = routeLine(session)
    let mute = muteLine()
    cleanUp(engine)
    notes += release()

    let (count, peak, got, unread) = meter.read()
    let vitals = " [run=" + yn(startedRunning) + ">" + yn(stillRunning)
      + " fmt=" + describe(fmt)
      + " " + route
      + " mute=" + mute
      + " bufs=" + String(count)
      + " peak=" + String(format: "%.4f", peak) + "]"

    if count == 0 {
      return "NO-AUDIO (tap installed, no buffers)" + vitals + notes
    }
    if peak == 0 && unread > 0 {
      // Codex 2/2: a Float64/Int32 buffer has neither channel pointer
      // peak() reads, so its samples were never inspected — reporting
      // ZEROED here would be the confident mislabel this probe exists
      // to prevent.
      return "UNINSPECTED (" + String(unread) + "/" + String(count) + " buffers in a format the meter cannot read)" + vitals + notes
    }
    if peak == 0 {
      return "ZEROED (buffers flowed, every sample 0)" + vitals + notes
    }
    let f = got ?? fmt
    let hz = f.map { String(Int($0.sampleRate)) } ?? "?"
    let ch = f.map { String($0.channelCount) } ?? "?"
    return "OK " + hz + "Hz/" + ch + "ch" + vitals + notes
  }

  // ------------------------------------------------------------ hygiene

  /// EVERY arm ends here, and so does the run. Two hygiene bugs the first
  /// revision carried: the deactivation named no
  /// `.notifyOthersOnDeactivation`, so every other audio client on the
  /// phone was left believing this app still held the microphone; and the
  /// run never deactivated at the end at all, so the walkie inherited
  /// whatever the last arm left behind. A failure is REPORTED rather than
  /// `try?`-ed into silence — a session that refuses to release is a
  /// finding, and it explains every arm after it.
  private static func release() -> String {
    do {
      try AVAudioSession.sharedInstance().setActive(
        false, options: [.notifyOthersOnDeactivation]
      )
      return ""
    } catch {
      return " release-fail(" + error.localizedDescription + ")"
    }
  }

  /// removeTap and stop can both raise on a graph that never came up, and
  /// a probe that aborts during its own cleanup reports nothing at all.
  private static func cleanUp(_ engine: AVAudioEngine) {
    _ = ObjCTry.run {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
  }

  // ------------------------------------------------------- instruments

  /// Apple names a NONZERO sampleRate/channelCount here as the way to
  /// know whether input is enabled at all — the single most diagnostic
  /// number in the line. Reading it has raised on this device before, so
  /// it gets its own catcher instead of taking the whole arm down: "the
  /// format read raised" is data, and losing the arm is not.
  private static func format(of input: AVAudioInputNode) -> AVAudioFormat? {
    var f: AVAudioFormat?
    _ = ObjCTry.run { f = input.inputFormat(forBus: 0) }
    return f
  }

  private static func describe(_ f: AVAudioFormat?) -> String {
    guard let f else { return "raise" }
    return String(Int(f.sampleRate)) + "/" + String(f.channelCount)
  }

  private static func routeLine(_ session: AVAudioSession) -> String {
    let ins = session.currentRoute.inputs
    var s = "in=" + String(ins.count)
    if let p = ins.first, p.portType != .builtInMic {
      // `.voiceChat` implicitly allows Bluetooth HFP, so a paired earpiece
      // in someone's pocket can quietly become the input. Named only when
      // it is NOT the built-in mic, so the healthy line stays short enough
      // to read on a phone.
      s += "/" + p.portType.rawValue
    }
    return s
  }

  private static func muteLine() -> String {
    if #available(iOS 17.0, *) {
      // iOS 17 gives every app an OS-owned input mute that ZEROES samples
      // without stopping callbacks — the other half of the discriminator
      // this probe's whole result line is built around.
      return AVAudioApplication.shared.isInputMuted ? "Y" : "N"
    }
    return "?"
  }

  private static func yn(_ b: Bool) -> String {
    return b ? "Y" : "N"
  }

  /// Buffer COUNT and PEAK are the discriminator, so they are measured
  /// rather than inferred from the first callback. The lock is
  /// deliberate: the tap closure runs on the render thread while the
  /// probe thread reads after removeTap, and in a once-a-saga diagnostic
  /// a possible hitch beats a data race that would make the numbers a
  /// lie.
  private final class Meter {
    private let lock = NSLock()
    private var buffers = 0
    private var loudest: Float = 0
    private var first: AVAudioFormat?
    /// Buffers whose format peak() has no reader for (neither float32 nor
    /// int16 channel pointers) — counted so silence over them is reported
    /// as UNINSPECTED, never as ZEROED.
    private var uninspected = 0

    func add(_ buf: AVAudioPCMBuffer) {
      let p = Meter.peak(buf)
      lock.lock()
      buffers += 1
      if p > loudest {
        loudest = p
      }
      if first == nil {
        first = buf.format
      }
      // A format peak() cannot read (no float32/int16 channel pointer —
      // Float64/Int32 buffers) must never masquerade as silence: a peak
      // of 0 over samples nobody inspected is the false-ZEROED codex 2/2
      // named. Record the fact so the verdict can say so.
      if buf.floatChannelData == nil && buf.int16ChannelData == nil {
        uninspected += 1
      }
      lock.unlock()
    }

    func read() -> (Int, Float, AVAudioFormat?, Int) {
      lock.lock()
      defer { lock.unlock() }
      return (buffers, loudest, first, uninspected)
    }

    /// Interleaved and deinterleaved buffers lay their samples out
    /// differently and only one of them has a second channel POINTER —
    /// walking channels on an interleaved buffer reads off the end of the
    /// allocation, which is a crash, not a wrong number.
    private static func peak(_ buf: AVAudioPCMBuffer) -> Float {
      let frames = Int(buf.frameLength)
      guard frames > 0 else { return 0 }
      let channels = Int(buf.format.channelCount)
      let interleaved = buf.format.isInterleaved
      let planes = interleaved ? 1 : channels
      let perPlane = interleaved ? frames * channels : frames
      var m: Float = 0
      if let data = buf.floatChannelData {
        for c in 0..<planes {
          let ch = data[c]
          for i in 0..<perPlane {
            let v = abs(ch[i])
            if v > m {
              m = v
            }
          }
        }
      } else if let data = buf.int16ChannelData {
        for c in 0..<planes {
          let ch = data[c]
          for i in 0..<perPlane {
            let v = abs(Float(ch[i])) / 32768
            if v > m {
              m = v
            }
          }
        }
      }
      return m
    }
  }

  // ------------------------------------------------------------ control

  private static func recorderProbe() -> String {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("micprobe.m4a")
    let session = AVAudioSession.sharedInstance()
    var notes = release()
    do {
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
      notes += release()
      return (ran ? "OK (recording ran)" : "NOT-RECORDING") + notes
    } catch {
      notes += release()
      return "fail " + error.localizedDescription + notes
    }
  }
}
