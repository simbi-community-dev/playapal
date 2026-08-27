/**
 * Field conversation log: write/read round-trip, tool-row serialization,
 * session grouping, oldest-first retention (age + size caps), the
 * session-grouped share export, and the never-throw guarantee — all against
 * the REAL chat_log DDL (node:sqlite executes the same BASE_TABLES_SQL the
 * device runs).
 */

import { BASE_TABLES_SQL } from '../src/events/schema';

const { DatabaseSync } = require('node:sqlite');

const mockDb = new DatabaseSync(':memory:');
let mockDbBroken = false;

jest.mock('../src/events/db', () => ({
  getDb: () => {
    if (mockDbBroken) {
      throw new Error('db exploded');
    }
    return {
      // quick-sqlite execute() shim over node:sqlite.
      execute: (sql: string, params: unknown[] = []) => {
        const stmt = mockDb.prepare(sql);
        if (/^\s*SELECT/i.test(sql)) {
          const rows = stmt.all(...(params as never[]));
          return {
            rows: {
              _array: rows,
              length: rows.length,
              item: (i: number) => rows[i],
            },
          };
        }
        stmt.run(...(params as never[]));
        return {};
      },
    };
  },
}));

import {
  CHAT_LOG_MAX_AGE_DAYS,
  CHAT_LOG_MAX_BYTES,
  chatLogStats,
  currentChatSessionId,
  exportChatLogJson,
  logChat,
  logSystemNote,
  pruneChatLog,
  rotateChatSession,
} from '../src/log/chatLog';

const allRows = (): any[] =>
  mockDb.prepare('SELECT * FROM chat_log ORDER BY id').all();

const insertRaw = (ts: string, text: string, session = 's-raw'): void => {
  mockDb
    .prepare(
      `INSERT INTO chat_log (ts, session_id, persona, role, text)
       VALUES (?, ?, 'angel', 'user', ?)`,
    )
    .run(ts, session, text);
};

beforeAll(() => {
  for (const sql of BASE_TABLES_SQL) {
    mockDb.exec(sql);
  }
});

beforeEach(() => {
  mockDb.prepare('DELETE FROM chat_log').run();
  mockDbBroken = false;
});

describe('chat_log writes', () => {
  it('round-trips a full assistant row, ISO timestamped, in the current session', () => {
    logChat({
      role: 'assistant',
      persona: 'angel',
      text: 'Bring 1.5 gallons of water per person per day.',
      model_file: 'playa-angel-v1.1.gguf',
      sampler_json: '{"temperature":0.1}',
      ttft_ms: 20900,
      total_ms: 31000,
      prompt_tokens: 1300,
      completion_tokens: 220,
      thinking_chars: 480,
      timings_json: '[{"round":0}]',
    });
    const rows = allRows();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.role).toBe('assistant');
    expect(r.persona).toBe('angel');
    expect(r.text).toBe('Bring 1.5 gallons of water per person per day.');
    expect(r.model_file).toBe('playa-angel-v1.1.gguf');
    expect(r.sampler_json).toBe('{"temperature":0.1}');
    expect(r.ttft_ms).toBe(20900);
    expect(r.total_ms).toBe(31000);
    expect(r.prompt_tokens).toBe(1300);
    expect(r.completion_tokens).toBe(220);
    expect(r.thinking_chars).toBe(480);
    expect(r.timings_json).toBe('[{"round":0}]');
    expect(r.session_id).toBe(currentChatSessionId());
    // ISO ts, parseable, recent.
    expect(Math.abs(Date.now() - Date.parse(r.ts))).toBeLessThan(5000);
  });

  it('serializes tool rows as JSON: {name,args} / {name,row_ids,json}', () => {
    logChat({
      role: 'tool_call',
      persona: 'angel',
      text: JSON.stringify({ name: 'search_events', args: '{"query":"yoga"}' }),
    });
    logChat({
      role: 'tool_result',
      persona: 'angel',
      text: JSON.stringify({
        name: 'search_events',
        row_ids: [4606, 1924],
        json: '{"count":2}',
      }),
    });
    const [call, result] = allRows();
    expect(JSON.parse(call.text)).toEqual({
      name: 'search_events',
      args: '{"query":"yoga"}',
    });
    expect(JSON.parse(result.text)).toEqual({
      name: 'search_events',
      row_ids: [4606, 1924],
      json: '{"count":2}',
    });
    // Metrics stay NULL on tool rows.
    expect(call.ttft_ms).toBeNull();
    expect(call.total_ms).toBeNull();
  });

  it('writes system notes', () => {
    logSystemNote('historian', 'persona switch: angel -> historian');
    const [r] = allRows();
    expect(r.role).toBe('system_note');
    expect(r.persona).toBe('historian');
    expect(r.text).toBe('persona switch: angel -> historian');
  });

  it('groups rows by session and rotates on demand', () => {
    logChat({ role: 'user', persona: 'angel', text: 'first chat' });
    const before = currentChatSessionId();
    const after = rotateChatSession();
    expect(after).not.toBe(before);
    logChat({ role: 'user', persona: 'teller', text: 'second chat' });
    const rows = allRows();
    expect(rows[0].session_id).toBe(before);
    expect(rows[1].session_id).toBe(after);
    expect(currentChatSessionId()).toBe(after);
  });
});

describe('never-throw guarantee', () => {
  it('drops rows silently when the db is unavailable', () => {
    mockDbBroken = true;
    expect(() =>
      logChat({ role: 'user', persona: 'angel', text: 'lost' }),
    ).not.toThrow();
    expect(() => pruneChatLog()).not.toThrow();
    expect(chatLogStats()).toBeNull();
    const exported = JSON.parse(exportChatLogJson());
    expect(exported.sessions).toEqual([]);
    expect(exported.error).toBeTruthy();
    mockDbBroken = false;
    expect(allRows()).toHaveLength(0);
  });
});

describe('retention', () => {
  it('prunes rows older than 90 days, keeps the rest', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const old = new Date(
      now.getTime() - (CHAT_LOG_MAX_AGE_DAYS + 1) * 86400_000,
    ).toISOString();
    const recent = new Date(now.getTime() - 86400_000).toISOString();
    insertRaw(old, 'ancient row');
    insertRaw(recent, 'yesterday row');
    pruneChatLog(now);
    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('yesterday row');
  });

  it('prunes oldest-first down to the 20 MB cap', () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      insertRaw(now.toISOString(), megabyte);
    }
    pruneChatLog(now);
    const rows = allRows();
    // Each row ≈ 1 MB text + 120 flat overhead; the newest rows whose
    // cumulative size fits the cap survive.
    const perRow = 1024 * 1024 + 120;
    const expectKept = Math.floor(CHAT_LOG_MAX_BYTES / perRow);
    expect(rows).toHaveLength(expectKept);
    // Oldest-first: the ids that remain are the HIGHEST (newest) ones.
    const ids = rows.map((r: any) => r.id);
    expect(Math.min(...ids)).toBe(30 - expectKept + 1);
    const stats = chatLogStats();
    expect(stats!.bytes).toBeLessThanOrEqual(CHAT_LOG_MAX_BYTES);
  });
});

describe('share export', () => {
  it('exports session-grouped JSON, newest session first, nulls omitted', () => {
    logChat({ role: 'user', persona: 'angel', text: 'q1' });
    logChat({
      role: 'assistant',
      persona: 'angel',
      text: 'a1',
      total_ms: 1234,
    });
    const s1 = currentChatSessionId();
    rotateChatSession();
    logChat({ role: 'user', persona: 'teller', text: 'q2' });
    const s2 = currentChatSessionId();

    const out = JSON.parse(exportChatLogJson());
    expect(out.app).toBe('playa-pal');
    expect(out.truncated).toBe(false);
    expect(out.sessions.map((s: any) => s.session_id)).toEqual([s2, s1]);
    const older = out.sessions[1];
    expect(older.rows.map((r: any) => r.role)).toEqual(['user', 'assistant']);
    expect(older.rows[1].total_ms).toBe(1234);
    // Null columns are omitted, not serialized as null.
    expect('ttft_ms' in older.rows[0]).toBe(false);
    expect('model_file' in older.rows[0]).toBe(false);
  });

  it('truncates to the newest sessions under a byte budget (share-intent limit)', () => {
    logChat({ role: 'user', persona: 'angel', text: 'y'.repeat(3000) });
    rotateChatSession();
    logChat({ role: 'user', persona: 'angel', text: 'z'.repeat(3000) });
    const newest = currentChatSessionId();
    const out = JSON.parse(exportChatLogJson(100));
    // The newest session is always included (never an empty export)…
    expect(out.sessions.map((s: any) => s.session_id)).toEqual([newest]);
    // …and the cut is flagged.
    expect(out.truncated).toBe(true);
  });
});
