/**
 * THE QUERY LOG — the instrument this project never had, derived from the
 * conversation log we already keep.
 *
 * WHY DERIVED AND NOT NEW LOGGING. chatLog.ts already records every user
 * turn, every tool call {name, args}, and every tool result {name,
 * card_kinds, json:{count,...}}, with retention and a Settings export. What
 * was missing was not storage but a READ that answers the questions a query
 * log exists for: what did people actually ask, how often, what got routed
 * to which tool, what came back empty, what got refused. Building a second
 * table for that would be a parallel system beside a proven primitive; a
 * view over the rows we have is the composition.
 *
 * WHY IT MATTERS BEYOND CURIOSITY. The v4.0 registry re-tier had to use the
 * Ranger heuristic ("would a Ranger know it cold?") because there was NO
 * frequency data -- nobody had ever seen what real burners ask this app.
 * After the burn, this export IS that data: the next datagen can drill what
 * was asked and starve what wasn't. That is the loop closing.
 *
 * Pure functions over rows, so the whole thing is testable without a device.
 */

export interface QueryLogRow {
  id: number;
  ts: string;
  session_id: string;
  persona: string;
  role: string;
  text: string;
  ttft_ms?: number | null;
  total_ms?: number | null;
}

/** One asked question and what the app did with it. */
export interface QueryRecord {
  ts: string;
  session_id: string;
  persona: string;
  question: string;
  /** Tools called, in order, with the argument that named the search. */
  tools: { name: string; arg: string }[];
  /** True when at least one tool returned rows. */
  retrieved: boolean;
  /** True when a tool was called and EVERY call came back empty. */
  empty: boolean;
  /** True when the model produced a final answer with no tool at all. */
  untooled: boolean;
  /** The visible answer's first sentence, for reading the log by eye. */
  answer_head: string;
  ttft_ms: number | null;
  total_ms: number | null;
}

/** Aggregates the post-burn reader actually wants. */
export interface QueryLogSummary {
  questions: number;
  sessions: number;
  untooled: number;
  retrieved: number;
  empty: number;
  by_tool: Record<string, number>;
  /** Questions whose every tool call came back empty -- the honest gaps. */
  empty_questions: string[];
  /** Most-asked questions, exact-text collapsed, for the next datagen. */
  top_questions: { question: string; n: number }[];
}

function argOf(args: unknown): string {
  // tool_call rows carry args as either an object or a JSON string; name the
  // one field a human would search on.
  let a: any = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return a.slice(0, 80);
    }
  }
  if (!a || typeof a !== 'object') {
    return '';
  }
  return String(a.topic ?? a.query ?? a.person ?? a.q ?? Object.values(a)[0] ?? '').slice(0, 80);
}

function countOf(json: unknown): number {
  let j: any = json;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch {
      return 0;
    }
  }
  if (!j || typeof j !== 'object') {
    return 0;
  }
  if (typeof j.count === 'number') {
    return j.count;
  }
  if (Array.isArray(j.passages)) {
    return j.passages.length;
  }
  if (Array.isArray(j.events)) {
    return j.events.length;
  }
  return 0;
}

function firstSentence(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim();
  const m = s.match(/^.*?[.!?](?:\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 160);
}

/**
 * Fold a chronological row list into one record per user question. Rows
 * between one user turn and the next belong to that question: tool calls,
 * tool results, and the assistant's final answer.
 */
export function foldQueries(rows: QueryLogRow[]): QueryRecord[] {
  const out: QueryRecord[] = [];
  let cur: QueryRecord | null = null;
  let sawRows = false;
  let toolCalls = 0;
  const flush = () => {
    if (cur) {
      cur.retrieved = sawRows;
      cur.empty = toolCalls > 0 && !sawRows;
      cur.untooled = toolCalls === 0;
      out.push(cur);
    }
    cur = null;
    sawRows = false;
    toolCalls = 0;
  };
  for (const r of rows) {
    if (r.role === 'user') {
      flush();
      cur = {
        ts: r.ts,
        session_id: r.session_id,
        persona: r.persona,
        question: r.text.trim(),
        tools: [],
        retrieved: false,
        empty: false,
        untooled: true,
        answer_head: '',
        ttft_ms: null,
        total_ms: null,
      };
      continue;
    }
    if (!cur) {
      continue; // pre-question chatter (persona switch notes, etc.)
    }
    if (r.role === 'tool_call') {
      toolCalls++;
      try {
        const p = JSON.parse(r.text);
        cur.tools.push({ name: String(p.name ?? '?'), arg: argOf(p.args) });
      } catch {
        cur.tools.push({ name: '?', arg: '' });
      }
    } else if (r.role === 'tool_result') {
      try {
        const p = JSON.parse(r.text);
        if (countOf(p.json) > 0 || (Array.isArray(p.card_kinds) && p.card_kinds.length > 0)) {
          sawRows = true;
        }
      } catch {
        /* unreadable result: treated as empty */
      }
    } else if (r.role === 'assistant') {
      cur.answer_head = firstSentence(r.text);
      cur.ttft_ms = r.ttft_ms ?? cur.ttft_ms;
      cur.total_ms = r.total_ms ?? cur.total_ms;
    }
  }
  flush();
  return out;
}

export function summarize(records: QueryRecord[], top = 25): QueryLogSummary {
  const by_tool: Record<string, number> = {};
  const counts = new Map<string, number>();
  const empty_questions: string[] = [];
  const sessions = new Set<string>();
  let untooled = 0, retrieved = 0, empty = 0;
  for (const q of records) {
    sessions.add(q.session_id);
    if (q.untooled) untooled++;
    if (q.retrieved) retrieved++;
    if (q.empty) {
      empty++;
      empty_questions.push(q.question);
    }
    for (const t of q.tools) {
      by_tool[t.name] = (by_tool[t.name] ?? 0) + 1;
    }
    const k = q.question.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    if (k) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const top_questions = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([question, n]) => ({ question, n }));
  return {
    questions: records.length,
    sessions: sessions.size,
    untooled,
    retrieved,
    empty,
    by_tool,
    empty_questions,
    top_questions,
  };
}
