/**
 * Kokoro voice roster for the on-device neural "Angel voice" backend.
 *
 * Ground truth (sherpa-onnx kokoro-int8-multi-lang-v1_1, 103 speakers):
 * the model's ENGLISH voices are exactly sid 0 af_maple, 1 af_sol,
 * 2 bf_vale; sids 3..102 are Chinese (zf_/zm_) and stay out of the picker.
 * (af_heart/af_bella live only in the fp32-only v1.0/v0.19 models — 2-3x
 * the size, no int8 — so this roster is the whole English cast.)
 *
 * Pure module: no native imports, unit-testable.
 */

export interface KokoroVoiceDef {
  /** Backend voice id as it appears in SpeechVoice.id / SpeakOpts.voiceId. */
  id: string;
  /** Kokoro speaker id passed to sherpa-onnx generation. */
  sid: number;
  label: string;
  /** BCP-47 tag. */
  language: string;
}

export const KOKORO_VOICE_PREFIX = 'kokoro:';

export const KOKORO_VOICES: KokoroVoiceDef[] = [
  {
    id: 'kokoro:af_maple',
    sid: 0,
    label: 'Maple — warm (the Angel)',
    language: 'en-US',
  },
  { id: 'kokoro:af_sol', sid: 1, label: 'Sol — bright', language: 'en-US' },
  {
    id: 'kokoro:bf_vale',
    sid: 2,
    label: 'Vale — calm British',
    language: 'en-GB',
  },
];

export const DEFAULT_KOKORO_VOICE = KOKORO_VOICES[0];

export function kokoroVoiceForId(
  voiceId?: string | null,
): KokoroVoiceDef | undefined {
  if (voiceId == null || voiceId === '') {
    return DEFAULT_KOKORO_VOICE;
  }
  return KOKORO_VOICES.find(v => v.id === voiceId);
}

/** SpeakOpts.rate is 0.8–1.2; clamp junk into a sane synthesis speed. */
export function clampSpeechRate(rate?: number): number {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    return 1.0;
  }
  return Math.min(2.0, Math.max(0.5, rate));
}

/**
 * Milliseconds of queued PCM still unplayed. The native player truncates on
 * stop (AudioTrack flush), so completion must wait this long after the last
 * chunk is queued before releasing the player.
 */
export function drainMsRemaining(
  queuedSamples: number,
  sampleRate: number,
  playStartedAtMs: number,
  nowMs: number,
): number {
  if (queuedSamples <= 0 || sampleRate <= 0 || playStartedAtMs <= 0) {
    return 0;
  }
  const totalMs = (queuedSamples / sampleRate) * 1000;
  return Math.max(0, Math.round(playStartedAtMs + totalMs - nowMs));
}
