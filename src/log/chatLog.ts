/**
 * Persistent on-device conversation log — the field-forensics instrument.
 *
 * Every chat turn (user + assistant + tool traffic), conversation reset, pack
 * install, and failure lands as a row in the `chat_log` table of the app's
 * one SQLite db (pocket-hippo.db, DDL in src/events/schema.ts), so real playa
 * conversations can be pulled over adb (`adb shell run-as com.playapal ...`
 * against the app's private files dir) or exported session-grouped from
 * Settings via the share
 * sheet. LOCAL-ONLY: nothing here touches the network — this app carries
 * private camp data, and the log leaves the device only when the owner
 * explicitly shares it.
 *
 * Design rules:
 *   - NEVER throw. A logging failure must not take the chat pipeline down:
 *     every db touch is guarded; failures warn once and drop the row.
 *   - Lazy db require: react-native-quick-sqlite throws at IMPORT time when
 *     not on-device (jest), so ../events/db is required inside the guard.
 *   - Thinking TEXT is never logged — only its size (thinking_chars).
 *     llama.rn reports no thinking-token count; the reasoning_content length
 *     is what is actually available (don't invent fields).
 *   - session_id groups exactly one conversation. Every conversation boundary
 *     rotates the id before subsequent rows are written.
 *   - Retention: pruneChatLog() at app start caps the table at 90 days /
 *     20 MB — both absurdly generous for text, so the log can never matter.
 */

import { foldQueries, summarize, type QueryLogRow } from './queryLog';

export type ChatLogRole =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'system_note';

export interface ChatLogEntry {
  role: ChatLogRole;
  persona: string;
  /** Full content. Tool rows carry JSON: {name, args} / {name, row_ids, json}. */
  text: string;
  model_file?: string | null;
  /** The SAMPLER const + thinking budgets at write time (assistant rows). */
  sampler_json?: string | null;
  /** Wall-clock ms from send to the first VISIBLE (post-ThinkFilter) text. */
  ttft_ms?: number | null;
  /** Wall-clock ms for the whole turn (all tool rounds included). */
  total_ms?: number | null;
  /** Sum of llama.rn timings.prompt_n across the turn's completions. */
  prompt_tokens?: number | null;
  /** Sum of llama.rn timings.predicted_n across the turn's completions. */
  completion_tokens?: number | null;
  /** Total reasoning_content length across rounds — size, never the text. */
  thinking_chars?: number | null;
  /** Raw per-round llama.rn timings (prompt_ms etc.) — the latency payload. */
  timings_json?: string | null;
}

export const CHAT_LOG_MAX_AGE_DAYS = 90;
export const CHAT_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** Approximate stored size of one row (fixed-column overhead flat-rated). */
const ROW_BYTES_SQL =
  "LENGTH(text) + LENGTH(COALESCE(sampler_json,'')) + LENGTH(COALESCE(timings_json,'')) + LENGTH(COALESCE(model_file,'')) + 120";

let sessionId: string | null = null;
let warnedOnce = false;

const newSessionId = (): string =>
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function currentChatSessionId(): string {
  if (!sessionId) {
    sessionId = newSessionId();
  }
  return sessionId;
}

/** Rotate whenever the current transcript becomes a new conversation. */
export function rotateChatSession(): string {
  sessionId = newSessionId();
  return sessionId;
}

interface ExecResult {
  rows?: { _array?: unknown[]; length: number; item: (i: number) => unknown };
}

interface Conn {
  execute: (sql: string, params?: unknown[]) => ExecResult;
}

function tryDb(): Conn | null {
  try {
    // Lazy require — see module header. jest.mock('../src/events/db')
    // intercepts this the same as a static import.
    return (require('../events/db') as { getDb: () => Conn }).getDb();
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[chatlog] logging unavailable:', e);
    }
    return null;
  }
}

const guarded = (op: () => void): void => {
  try {
    op();
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[chatlog] write failed:', e);
    }
  }
};

export function logChat(entry: ChatLogEntry): void {
  const db = tryDb();
  if (!db) {
    return;
  }
  guarded(() =>
    db.execute(
      `INSERT INTO chat_log (
         ts, session_id, persona, role, text, model_file, sampler_json,
         ttft_ms, total_ms, prompt_tokens, completion_tokens, thinking_chars,
         timings_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        currentChatSessionId(),
        entry.persona,
        entry.role,
        entry.text,
        entry.model_file ?? null,
        entry.sampler_json ?? null,
        entry.ttft_ms ?? null,
        entry.total_ms ?? null,
        entry.prompt_tokens ?? null,
        entry.completion_tokens ?? null,
        entry.thinking_chars ?? null,
        entry.timings_json ?? null,
      ],
    ),
  );
}

export const logSystemNote = (persona: string, note: string): void =>
  logChat({ role: 'system_note', persona, text: note });

/**
 * Oldest-first retention, run at app start: rows older than 90 days go, then
 * if the table still exceeds 20 MB the newest rows whose cumulative size fits
 * the cap are kept and everything older is dropped (single window-function
 * statement — SQLite >= 3.25, well below both the bundled quick-sqlite and
 * node:sqlite builds).
 */
export function pruneChatLog(now: Date = new Date()): void {
  const db = tryDb();
  if (!db) {
    return;
  }
  guarded(() => {
    const cutoff = new Date(
      now.getTime() - CHAT_LOG_MAX_AGE_DAYS * 86400_000,
    ).toISOString();
    db.execute('DELETE FROM chat_log WHERE ts < ?', [cutoff]);
    const res = db.execute(
      `SELECT COALESCE(SUM(${ROW_BYTES_SQL}), 0) AS bytes FROM chat_log`,
    );
    const bytes =
      res.rows && res.rows.length > 0
        ? Number((res.rows.item(0) as { bytes: number }).bytes)
        : 0;
    if (bytes > CHAT_LOG_MAX_BYTES) {
      db.execute(
        `DELETE FROM chat_log WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, SUM(${ROW_BYTES_SQL}) OVER (ORDER BY id DESC) AS cum
             FROM chat_log
           ) WHERE cum <= ?
         )`,
        [CHAT_LOG_MAX_BYTES],
      );
    }
  });
}

export interface ChatLogStats {
  rows: number;
  sessions: number;
  bytes: number;
}

export function chatLogStats(): ChatLogStats | null {
  const db = tryDb();
  if (!db) {
    return null;
  }
  try {
    const res = db.execute(
      `SELECT COUNT(*) AS rows_n, COUNT(DISTINCT session_id) AS sessions_n,
              COALESCE(SUM(${ROW_BYTES_SQL}), 0) AS bytes_n
       FROM chat_log`,
    );
    if (!res.rows || res.rows.length === 0) {
      return null;
    }
    // Read through the row collection's OWN accessor first and fall back to
    // the array: on-device this returned "Nothing logged yet" over a table
    // with 5 rows (Pixel 7, 2026-08-17) while the same SQL against a pulled
    // copy of that db returned (5, 1, 3789). Aggregate columns can also come
    // back as STRINGS from the native driver, so coerce -- a "5" that fails
    // `> 0` in one place and passes in another is exactly the kind of bug
    // that reads as "the log is empty" to a human.
    const r = (typeof res.rows.item === 'function'
      ? res.rows.item(0)
      : (res.rows as any)._array?.[0]) as
      | { rows_n: unknown; sessions_n: unknown; bytes_n: unknown }
      | undefined;
    if (!r) {
      return null;
    }
    return {
      rows: Number(r.rows_n) || 0,
      sessions: Number(r.sessions_n) || 0,
      bytes: Number(r.bytes_n) || 0,
    };
  } catch (e) {
    // Do not swallow silently: the caller renders "Nothing logged yet" on
    // null, which is a claim about the DATA. A failed read is not empty data.
    console.warn('[chatlog] stats read failed:', e);
    return null;
  }
}

interface ExportRow {
  id: number;
  ts: string;
  persona: string;
  role: string;
  text: string;
  model_file: string | null;
  sampler_json: string | null;
  ttft_ms: number | null;
  total_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  thinking_chars: number | null;
  timings_json: string | null;
}

/**
 * Session-grouped JSON for the Settings share row. Newest sessions first;
 * stops adding sessions once ~budgetBytes is reached (Android share intents
 * die near the 1 MB binder limit — TransactionTooLargeException) and flags
 * `truncated`. The adb pull path has no such limit and is the primary
 * instrument; this is the no-cable convenience path.
 */
export function exportChatLogJson(budgetBytes = 400_000): string {
  const db = tryDb();
  const header = {
    app: 'playa-pal',
    kind: 'conversation-log',
    exported_at: new Date().toISOString(),
  };
  if (!db) {
    return JSON.stringify({ ...header, error: 'log unavailable', sessions: [] });
  }
  try {
    const sessRes = db.execute(
      `SELECT session_id, MIN(ts) AS started, COUNT(*) AS n
       FROM chat_log GROUP BY session_id ORDER BY MAX(id) DESC`,
    );
    const sessRows = (sessRes.rows?._array ?? []) as {
      session_id: string;
      started: string;
      n: number;
    }[];
    const sessions: object[] = [];
    let used = 0;
    let truncated = false;
    for (const s of sessRows) {
      const rowsRes = db.execute(
        `SELECT id, ts, persona, role, text, model_file, sampler_json, ttft_ms,
                total_ms, prompt_tokens, completion_tokens, thinking_chars,
                timings_json
         FROM chat_log WHERE session_id = ? ORDER BY id`,
        [s.session_id],
      );
      const rows = (rowsRes.rows?._array ?? []) as ExportRow[];
      const session = {
        session_id: s.session_id,
        started: s.started,
        rows: rows.map(r => {
          const out: Record<string, unknown> = {
            ts: r.ts,
            persona: r.persona,
            role: r.role,
            text: r.text,
          };
          // Nullable columns appear only when set — keeps the export tight.
          for (const k of [
            'model_file',
            'sampler_json',
            'ttft_ms',
            'total_ms',
            'prompt_tokens',
            'completion_tokens',
            'thinking_chars',
            'timings_json',
          ] as const) {
            if (r[k] !== null && r[k] !== undefined) {
              out[k] = r[k];
            }
          }
          return out;
        }),
      };
      const size = JSON.stringify(session).length;
      if (sessions.length > 0 && used + size > budgetBytes) {
        truncated = true;
        break;
      }
      used += size;
      sessions.push(session);
    }
    return JSON.stringify({ ...header, truncated, sessions }, null, 1);
  } catch (e) {
    return JSON.stringify({
      ...header,
      error: `export failed: ${e instanceof Error ? e.message : String(e)}`,
      sessions: [],
    });
  }
}

// ---------------------------------------------------------------------------
// The query log: a READ over chat_log, exported as the compact thing you pull
// off the phone after the burn. See src/log/queryLog.ts for why it is derived
// rather than stored.
// ---------------------------------------------------------------------------


/**
 * Every question asked on this phone, with what the app did about it, plus
 * the aggregates. Small by construction (one record per question, first
 * sentence of the answer only) so it fits a share sheet without a budget.
 */
export function exportQueryLogJson(): string {
  const db = tryDb();
  const header = {
    app: 'playa-pal',
    kind: 'query-log',
    exported_at: new Date().toISOString(),
  };
  if (!db) {
    return JSON.stringify({ ...header, error: 'log unavailable' });
  }
  try {
    const res = db.execute(
      `SELECT id, ts, session_id, persona, role, text, ttft_ms, total_ms
       FROM chat_log ORDER BY id`,
    );
    const rows = (res.rows?._array ?? []) as QueryLogRow[];
    const records = foldQueries(rows);
    return JSON.stringify({ ...header, summary: summarize(records), questions: records });
  } catch (e) {
    return JSON.stringify({ ...header, error: String(e) });
  }
}
