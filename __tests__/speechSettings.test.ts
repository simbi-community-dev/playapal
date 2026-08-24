/**
 * Spoken-replies settings: persistence round-trip through the REAL settings
 * table DDL (node:sqlite), plus the tolerant sanitizer/clamper.
 */

import { BASE_TABLES_SQL } from '../src/events/schema';

const { DatabaseSync } = require('node:sqlite');

const mockDb = new DatabaseSync(':memory:');

jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => {
    const row = mockDb
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  },
  setSetting: (key: string, value: string) => {
    mockDb.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  },
}));

import {
  clampRate,
  DEFAULT_SPEECH_SETTINGS,
  loadSpeechSettings,
  sanitizeSpeechSettings,
  saveSpeechSettings,
  SPEECH_SETTINGS_KEY,
} from '../src/speech/settings';

beforeAll(() => {
  for (const sql of BASE_TABLES_SQL) {
    mockDb.exec(sql);
  }
});

beforeEach(() => {
  mockDb.prepare('DELETE FROM settings').run();
});

describe('speech settings persistence', () => {
  it('defaults with nothing stored — and the master toggle defaults OFF', () => {
    expect(loadSpeechSettings()).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(DEFAULT_SPEECH_SETTINGS.enabled).toBe(false);
  });

  it('round-trips a full settings object', () => {
    const settings = {
      enabled: true,
      backendId: 'platform',
      voiceId: 'en-us-x-iob-local',
      rate: 1.15,
    };
    saveSpeechSettings(settings);
    expect(loadSpeechSettings()).toEqual(settings);
  });

  it('persists across separate loads (real table, not module state)', () => {
    saveSpeechSettings({ ...DEFAULT_SPEECH_SETTINGS, enabled: true });
    expect(loadSpeechSettings().enabled).toBe(true);
    expect(loadSpeechSettings().enabled).toBe(true);
  });

  it('sanitizes on save: out-of-range rate is clamped before storing', () => {
    saveSpeechSettings({ ...DEFAULT_SPEECH_SETTINGS, rate: 99 });
    expect(loadSpeechSettings().rate).toBe(1.2);
  });

  it('survives a corrupt stored blob', () => {
    mockDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SPEECH_SETTINGS_KEY,
      '{not json',
    );
    expect(loadSpeechSettings()).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('survives a stale blob with wrong shapes', () => {
    mockDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SPEECH_SETTINGS_KEY,
      JSON.stringify({ enabled: 'yes', voiceId: 42, rate: 'fast', backendId: '' }),
    );
    expect(loadSpeechSettings()).toEqual(DEFAULT_SPEECH_SETTINGS);
  });
});

describe('sanitizeSpeechSettings / clampRate', () => {
  it('clamps and snaps the rate', () => {
    expect(clampRate(0.5)).toBe(0.8);
    expect(clampRate(2)).toBe(1.2);
    expect(clampRate(1.03)).toBe(1.05);
    expect(clampRate(1.0)).toBe(1.0);
    expect(clampRate(NaN)).toBe(1.0);
    expect(clampRate('fast')).toBe(1.0);
  });

  it('normalizes junk to defaults', () => {
    expect(sanitizeSpeechSettings(null)).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(sanitizeSpeechSettings('x')).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(sanitizeSpeechSettings({})).toEqual(DEFAULT_SPEECH_SETTINGS);
  });

  it('keeps a valid voice and empty->null voice', () => {
    expect(
      sanitizeSpeechSettings({ voiceId: 'en-us-x-sfg-local' }).voiceId,
    ).toBe('en-us-x-sfg-local');
    expect(sanitizeSpeechSettings({ voiceId: '' }).voiceId).toBeNull();
  });
});
