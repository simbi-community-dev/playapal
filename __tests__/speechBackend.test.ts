/**
 * Backend seam units: voice network classification (the offline-readiness
 * heuristic), picker ordering, and registry fallback.
 */

import {
  classifyVoiceNetwork,
  getSpeechBackend,
  registerSpeechBackend,
  sortVoicesForPicker,
  type SpeechBackend,
  type SpeechVoice,
} from '../src/speech/backend';

describe('classifyVoiceNetwork', () => {
  it('classifies Google TTS voice names by their -local/-network suffix', () => {
    expect(classifyVoiceNetwork('en-us-x-iob-local')).toBe('offline');
    expect(classifyVoiceNetwork('en-us-x-iob-network')).toBe('network');
    expect(classifyVoiceNetwork('en-US-language')).toBe('unknown');
  });

  it('treats embedded voices as offline and is case-insensitive', () => {
    expect(classifyVoiceNetwork('EN-GB-X-GBB-LOCAL')).toBe('offline');
    expect(classifyVoiceNetwork('samsung-embedded-en')).toBe('offline');
  });
});

const voice = (over: Partial<SpeechVoice>): SpeechVoice => ({
  id: 'v',
  label: 'v',
  language: 'en-US',
  quality: 'default',
  network: 'unknown',
  ...over,
});

describe('sortVoicesForPicker', () => {
  it('orders offline first, then unknown, then network; enhanced first within a group', () => {
    const sorted = sortVoicesForPicker([
      voice({ id: 'net', network: 'network' }),
      voice({ id: 'unk', network: 'unknown' }),
      voice({ id: 'off-default', network: 'offline' }),
      voice({ id: 'off-enhanced', network: 'offline', quality: 'enhanced' }),
    ]);
    expect(sorted.map(v => v.id)).toEqual([
      'off-enhanced',
      'off-default',
      'unk',
      'net',
    ]);
  });
});

describe('backend registry', () => {
  const fake = (id: string): SpeechBackend => ({
    id,
    label: id,
    voices: async () => [],
    readiness: async () => ({ ok: true }),
    speak: async () => {},
    stop: async () => {},
  });

  it('falls back to platform for unknown ids', () => {
    registerSpeechBackend(fake('platform'));
    registerSpeechBackend(fake('kokoro'));
    expect(getSpeechBackend('kokoro').id).toBe('kokoro');
    expect(getSpeechBackend('nope').id).toBe('platform');
    expect(getSpeechBackend(null).id).toBe('platform');
  });
});
