/**
 * Spoken-replies settings, persisted in the existing SQLite key/value
 * settings table (no new storage dependency). One JSON blob under one key;
 * sanitizeSpeechSettings() is the single tolerant parser, so a corrupt or
 * stale blob can never crash speech — it degrades to defaults.
 */

import { getSetting, setSetting } from '../events/db';

export const SPEECH_SETTINGS_KEY = 'speech_settings';

export const RATE_MIN = 0.8;
export const RATE_MAX = 1.2;
export const RATE_STEP = 0.05;

export interface SpeechSettings {
  /** Master toggle — default OFF. */
  enabled: boolean;
  /** Speech backend id ('platform' now; 'kokoro' when tier 2 lands). */
  backendId: string;
  /** Selected voice id, or null for the engine default. */
  voiceId: string | null;
  /** Rate multiplier, clamped to 0.8–1.2 and snapped to 0.05 steps. */
  rate: number;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: false,
  backendId: 'platform',
  voiceId: null,
  rate: 1.0,
};

/** Clamp to [0.8, 1.2], snap to 0.05 steps, and default junk to 1.0. */
export function clampRate(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_SPEECH_SETTINGS.rate;
  }
  const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, n));
  // Snap to the step grid, then kill float dust (1.1500000000000001 -> 1.15).
  return Math.round((Math.round(clamped / RATE_STEP) * RATE_STEP) * 100) / 100;
}

/** Tolerant normalizer: any shape in, valid SpeechSettings out. */
export function sanitizeSpeechSettings(raw: unknown): SpeechSettings {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_SPEECH_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    backendId:
      typeof obj.backendId === 'string' && obj.backendId.length > 0
        ? obj.backendId
        : DEFAULT_SPEECH_SETTINGS.backendId,
    voiceId:
      typeof obj.voiceId === 'string' && obj.voiceId.length > 0
        ? obj.voiceId
        : null,
    rate: clampRate(obj.rate),
  };
}

export function loadSpeechSettings(): SpeechSettings {
  const stored = getSetting(SPEECH_SETTINGS_KEY);
  if (stored === null) {
    return { ...DEFAULT_SPEECH_SETTINGS };
  }
  try {
    return sanitizeSpeechSettings(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_SPEECH_SETTINGS };
  }
}

export function saveSpeechSettings(settings: SpeechSettings): void {
  setSetting(
    SPEECH_SETTINGS_KEY,
    JSON.stringify(sanitizeSpeechSettings(settings)),
  );
}
