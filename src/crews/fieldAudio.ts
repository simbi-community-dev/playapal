/**
 * fieldAudio — the thin typed seam over NativeModules.FieldAudio (the
 * answering machine's microphone and speaker; Camp Mesh, docs/CREW-DESIGN.md
 * §6b). The native module (android FieldAudioModule.kt) owns every platform
 * concern — MediaRecorder tuning (AAC mono 16 kHz 24 kbps ≈ 3 KB/s, so the
 * 30 s hard stop lands well under the 256 KiB voice cap), cache-file
 * lifecycle, the RECORD_AUDIO check. This file only:
 *
 *  - gives the two capabilities the exact object shapes PodMessages injects
 *    for tests (recorder/player seams), so the UI never touches
 *    NativeModules and tests never need a native build;
 *  - guards the module's ABSENCE (an older binary running newer JS over
 *    Metro, or a platform whose module isn't written yet) with a
 *    human-actionable reject instead of a TypeError on undefined.
 *
 * Permission is deliberately NOT asked here: the native side rejects with
 * code 'permission' and the UI asks in context with the payoff named — the
 * same discipline as camera, location and Bluetooth (radio.ts header).
 */
import { NativeModules } from 'react-native';

/** What one finished take hands back — the recorder's whole product. */
export interface FieldClip {
  /** The compressed audio, base64 — goes straight into composeVoice. */
  base64: string;
  /** Codec hint ('audio/mp4' from the Android recorder) — rides the wire
   * so a future iOS player knows what it's holding. */
  mime: string;
  /** Wall-clock length of the take, for UI feedback only (the store keeps
   * bodies, not durations — receivers estimate from byte size). */
  durationMs: number;
}

/** The native surface this wrapper narrows to. stopRecording also reports
 * `bytes`; dropped here because base64.length already carries the size and
 * a second source of truth would only drift. */
interface FieldAudioNative {
  startRecording(): Promise<null>;
  stopRecording(): Promise<FieldClip & { bytes: number }>;
  play(b64: string): Promise<number>;
  stopPlayback(): Promise<null>;
}

// null, not undefined-crash-later: the module either linked into this build
// or it didn't (the crewRadioPresent posture, radio.ts).
const native: FieldAudioNative | null = NativeModules.FieldAudio ?? null;

/** The one absence message — actionable ("get the newer build"), never a
 * stack trace about undefined.startRecording. */
const needNewerBuild = (): Error => new Error('Voice notes need a newer build.');

/** Hold-to-record. start() arms the mic; stop() finalizes and hands back
 * the clip. Native rejects ride through untouched so the UI can branch on
 * their codes ('permission', 'empty', 'busy', 'idle', 'damaged').
 *
 * 'damaged' is the take the native side REFUSED because its container has no
 * index — an unplayable recording, caught before it can enter the mesh (see
 * FieldAudioModule.hasIndex and src/crews/voiceClip.ts). Its message is
 * already written for a human; the UI shows it verbatim. */
export const fieldRecorder = {
  async start(): Promise<void> {
    if (native == null) {
      throw needNewerBuild();
    }
    await native.startRecording();
  },
  async stop(): Promise<FieldClip> {
    if (native == null) {
      throw needNewerBuild();
    }
    const clip = await native.stopRecording();
    // Re-shape rather than pass through: the native map is a peer contract,
    // and narrowing here is what keeps a Kotlin-side field addition from
    // silently widening what the JS layer hands around.
    return { base64: clip.base64, mime: clip.mime, durationMs: clip.durationMs };
  },
};

/** One-at-a-time playback (the native side stops any current clip before
 * starting the next). play resolves the clip's real duration in ms. */
export const fieldPlayer = {
  async play(b64: string): Promise<number> {
    if (native == null) {
      throw needNewerBuild();
    }
    return native.play(b64);
  },
  async stop(): Promise<void> {
    if (native == null) {
      return; // nothing could be playing — the goal state is already true
    }
    await native.stopPlayback();
  },
};
