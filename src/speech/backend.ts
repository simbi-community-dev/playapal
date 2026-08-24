/**
 * Spoken-replies backend seam. The platform-TTS implementation
 * (platformBackend.ts) is tier 1 and the default; a neural on-device backend
 * (Kokoro via sherpa-onnx, "Angel voice") is tier 2 and plugs in behind this
 * SAME interface — register it and Settings can grow a backend picker without
 * touching the chat wiring.
 *
 * Pure module: no native imports here, so tests and the transform layer can
 * import it freely.
 */

/** Can this voice synthesize with the radios off? (On playa there is no
 * network — 'network' voices are a trap.) */
export type VoiceNetwork = 'offline' | 'network' | 'unknown';

export interface SpeechVoice {
  /** Backend-specific identifier passed back to speak(). */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  /** BCP-47 tag, e.g. "en-US". */
  language: string;
  quality: 'default' | 'enhanced';
  network: VoiceNetwork;
}

export interface SpeakOpts {
  /** Voice id from voices(); null/undefined = engine default. */
  voiceId?: string | null;
  /** Speech rate multiplier, 0.8–1.2 (1.0 = normal). */
  rate?: number;
  /** Fired when the utterance finishes, is stopped, or errors. */
  onDone?: () => void;
  /** Fired on synthesis error (onDone still fires). */
  onError?: (message: string) => void;
}

export interface SpeechReadiness {
  ok: boolean;
  /**
   * Why not ok:
   *  - 'needs-network'  — selected voice likely requires internet
   *  - 'voice-missing'  — stored voice id no longer on the device
   *  - 'unknown-voice'  — cannot tell whether the voice is offline-capable
   *  - 'no-voices'      — the engine reported no voices at all
   *  - 'model-missing'  — neural backend's model files not installed on
   *                       device (kokoro: see kokoroBackend.ts dev path)
   */
  reason?:
    | 'needs-network'
    | 'voice-missing'
    | 'unknown-voice'
    | 'no-voices'
    | 'model-missing';
  /** True when openVoiceDataInstaller() is a meaningful fix surface. */
  canInstallVoiceData?: boolean;
}

export interface SpeechBackend {
  readonly id: string;
  /** Picker label, e.g. "Device voice" / "Angel voice". */
  readonly label: string;
  voices(): Promise<SpeechVoice[]>;
  /** Offline-readiness of the given (or default) voice. */
  readiness(voiceId?: string | null): Promise<SpeechReadiness>;
  /** Speak one utterance; implicitly stops anything already speaking. */
  speak(text: string, opts?: SpeakOpts): Promise<void>;
  stop(): Promise<void>;
  /** Android: open the system TTS voice-data installer, when supported. */
  openVoiceDataInstaller?(): Promise<void>;
}

const registry = new Map<string, SpeechBackend>();

export function registerSpeechBackend(backend: SpeechBackend): void {
  registry.set(backend.id, backend);
}

export function listSpeechBackends(): SpeechBackend[] {
  return [...registry.values()];
}

/** Resolve a backend by id, falling back to 'platform', then to any. */
export function getSpeechBackend(id?: string | null): SpeechBackend {
  const backend =
    (id ? registry.get(id) : undefined) ?? registry.get('platform');
  if (backend) {
    return backend;
  }
  const first = registry.values().next();
  if (first.done) {
    throw new Error('No speech backend registered');
  }
  return first.value;
}

/**
 * Classify a platform voice's network need from its NAME. The Android Voice
 * API has isNetworkConnectionRequired, but our TTS lib does not surface it
 * (upstream PR candidate); Google's engine — the Pixel default — encodes it
 * in the voice name instead: `en-us-x-iob-local` vs `en-us-x-iob-network`.
 * Anything else honestly stays 'unknown'.
 */
export function classifyVoiceNetwork(voiceName: string): VoiceNetwork {
  const name = voiceName.toLowerCase();
  if (name.includes('network')) {
    return 'network';
  }
  if (name.includes('local') || name.includes('embedded')) {
    return 'offline';
  }
  return 'unknown';
}

/**
 * Picker order: offline first (the ones that work on playa), then unknown,
 * then network; enhanced before default within a group; name as tiebreak.
 */
export function sortVoicesForPicker(voices: SpeechVoice[]): SpeechVoice[] {
  const netRank: Record<VoiceNetwork, number> = {
    offline: 0,
    unknown: 1,
    network: 2,
  };
  return [...voices].sort(
    (a, b) =>
      netRank[a.network] - netRank[b.network] ||
      (a.quality === 'enhanced' ? 0 : 1) - (b.quality === 'enhanced' ? 0 : 1) ||
      a.label.localeCompare(b.label),
  );
}
