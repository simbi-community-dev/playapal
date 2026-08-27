import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICES,
  clampSpeechRate,
  drainMsRemaining,
  kokoroVoiceForId,
} from '../src/speech/kokoroVoices';

describe('kokoro voice roster', () => {
  it('exposes exactly the three English voices of kokoro-multi-lang-v1_1', () => {
    expect(KOKORO_VOICES.map(v => [v.id, v.sid])).toEqual([
      ['kokoro:af_maple', 0],
      ['kokoro:af_sol', 1],
      ['kokoro:bf_vale', 2],
    ]);
  });

  it('defaults to Maple (the Angel) when no voice is given', () => {
    expect(kokoroVoiceForId()).toBe(DEFAULT_KOKORO_VOICE);
    expect(kokoroVoiceForId(null)).toBe(DEFAULT_KOKORO_VOICE);
    expect(kokoroVoiceForId('')).toBe(DEFAULT_KOKORO_VOICE);
    expect(DEFAULT_KOKORO_VOICE.id).toBe('kokoro:af_maple');
  });

  it('returns undefined for unknown ids (readiness: voice-missing)', () => {
    expect(kokoroVoiceForId('kokoro:af_heart')).toBeUndefined();
    expect(kokoroVoiceForId('platform:en-us-x-iob-local')).toBeUndefined();
  });
});

describe('clampSpeechRate', () => {
  it('passes normal rates and clamps extremes', () => {
    expect(clampSpeechRate(1.0)).toBe(1.0);
    expect(clampSpeechRate(0.8)).toBe(0.8);
    expect(clampSpeechRate(0.1)).toBe(0.5);
    expect(clampSpeechRate(9)).toBe(2.0);
  });

  it('falls back to 1.0 on junk', () => {
    expect(clampSpeechRate(undefined)).toBe(1.0);
    expect(clampSpeechRate(NaN)).toBe(1.0);
    expect(clampSpeechRate(0)).toBe(1.0);
    expect(clampSpeechRate(-2)).toBe(1.0);
  });
});

describe('drainMsRemaining', () => {
  it('is the queued duration minus elapsed playback', () => {
    // 48000 samples at 24 kHz = 2 s of audio; 500 ms already played.
    expect(drainMsRemaining(48000, 24000, 1000, 1500)).toBe(1500);
  });

  it('never goes negative and zeroes on empty/unstarted playback', () => {
    expect(drainMsRemaining(48000, 24000, 1000, 10000)).toBe(0);
    expect(drainMsRemaining(0, 24000, 1000, 1200)).toBe(0);
    expect(drainMsRemaining(48000, 24000, 0, 1200)).toBe(0);
  });
});
