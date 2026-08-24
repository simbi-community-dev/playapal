/**
 * Two-turn prompt-assembly regression net (owner field bug 2026-08-13: a
 * clarify follow-up repeated the previous answer and dragged in an unrelated
 * event — is anything DUPLICATED or double-fed on turn 2?).
 *
 * Drives a real LlamaSession over a mocked llama.rn context and asserts the
 * EXACT message assembly each completion receives:
 *   - turn 2 = [system, user1, assistant1-final, user2] — nothing else
 *   - tool-round messages (assistant tool_calls + tool results) never leak
 *     into the next turn's history
 *   - the system prompt appears exactly once, always first
 *   - thinking is UNCAPPED (r8: the graded v1.6 config ran without budgets)
 *   - the ANSWER-FORCING floor: a speechless, uninterrupted round retries
 *     exactly once with thinking suppressed; a turn never ends empty
 *   - the FIELD LOG captures the whole flow: user + tool_call + tool_result +
 *     assistant rows land in chat_log (real DDL via node:sqlite) with sane
 *     metrics aggregated from llama.rn's per-completion timings
 */

import {
  FORCED_FINAL_NUDGE,
  LlamaSession,
  THINK_BUDGET_MESSAGE,
  THINK_BUDGET_TOKENS,
  THINK_BUDGET_TOOL_ROUND_TOKENS,
  TOOL_ROUND_CAP,
  nudgeLastToolMessage,
  toolSchemaHash,
} from '../src/llm/LlamaSession';
import { DEFAULT_PERSONA_ID, getPersona } from '../src/llm/personas';
import { BASE_TABLES_SQL } from '../src/events/schema';
import { initLlama } from 'llama.rn';
import { executeTool } from '../src/llm/toolExecutor';
import { lookupPersonIdentity } from '../src/facts/personIdentity';
import { lookupHistory } from '../src/facts/historyLookup';
import { NOTHING_FOUND, NO_ANSWER } from '../src/llm/factNarration';

const { DatabaseSync } = require('node:sqlite');
const mockLogDb = new DatabaseSync(':memory:');

jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  mkdir: jest.fn(async () => {}),
}));

// The field log writes through the app db; back it with the real DDL.
jest.mock('../src/events/db', () => ({
  identityAffiliationTerms: () => [],
  getDb: () => ({
    execute: (sql: string, params: unknown[] = []) => {
      const stmt = mockLogDb.prepare(sql);
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
  }),
}));

jest.mock('../src/llm/toolExecutor', () => ({
  executeTool: jest.fn(async () => ({
    json: '{"count":1,"events":[{"title":"Sunrise Yoga"}]}',
    cards: [],
    shrink: async () => ({ json: '{}', cards: [] }),
  })),
}));

jest.mock('../src/facts/historyLookup', () => ({
  lookupHistory: jest.fn(() => ({ json: '{"status":"no_match"}', cards: [] })),
}));

jest.mock('../src/facts/personIdentity', () => ({
  lookupPersonIdentity: jest.fn((intent: { topic: string }) => ({
    status: 'not_found',
    query: intent.topic,
    candidates: [],
  })),
}));

// THE GROUNDING FLOOR (2026-08-18): a factual round-0 that produced no tool
// call now DISCARDS its text and forces ONE lookup_facts before the model may
// answer. Tests whose point is downstream machinery feed the floor this empty
// outcome (+1 executeTool outcome, +1 leading model result, toolRounds >= 1)
// so their original scripted rounds land where they always did.
const EMPTY_FLOOR_LOOKUP = {
  json: '{"count":0,"passages":[]}',
  cards: [],
  sources: [],
  emptyLookup: true,
  shrink: async () => ({ json: '{}', cards: [], sources: [] }),
};

describe('LlamaSession two-turn assembly', () => {
  const completions: any[] = [];
  let results: any[] = [];

  // Every test queues its own executeTool outcomes with mockResolvedValueOnce.
  // A test that consumes FEWER than it queued (the dup-call guard now skips an
  // identical repeat, 2026-08-17) leaves the remainder for the NEXT test — an
  // order-dependent failure that looks like a logic bug two tests later.
  // Drain the Once-queue between tests; keep the default implementation.
  const defaultExecuteTool = (executeTool as jest.Mock).getMockImplementation();
  beforeEach(() => {
    (executeTool as jest.Mock).mockReset();
    (executeTool as jest.Mock).mockImplementation(defaultExecuteTool as any);
  });

  const ctx = {
    completion: jest.fn(async (params: any, cb?: (d: any) => void) => {
      // Deep-copy: the session MUTATES its messages array between rounds.
      completions.push(JSON.parse(JSON.stringify(params)));
      const r = results.shift() ?? { content: '' };
      // Replay raw token deltas like the device stream (LFM2.5 starts inside
      // an implicit <think> block, so visible text needs a closing tag first).
      if (cb && r._stream) {
        for (const token of r._stream) {
          cb({ token });
        }
      }
      return r;
    }),
    saveSession: jest.fn(async () => {}),
    loadSession: jest.fn(async () => {}),
    clearCache: jest.fn(async () => {}),
    stopCompletion: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
  };

  beforeAll(async () => {
    (initLlama as jest.Mock).mockResolvedValue(ctx);
    for (const sql of BASE_TABLES_SQL) {
      mockLogDb.exec(sql);
    }
  });

  it('the raw thread: turn 2 replays turn 1 whole — its tool exchange, reasoning, and final (owner design 2026-08-18)', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});

    // Turn 1: a tooled turn (one search_events round, then the final).
    // timings/reasoning_content mirror what llama.rn reports on device —
    // the field log aggregates them into the assistant row's metrics.
    results = [
      {
        content: '',
        reasoning_content: 'user asks about MOOP -> search',
        timings: { prompt_n: 600, prompt_ms: 5000, predicted_n: 40, predicted_ms: 900, cache_n: 0 },
        tool_calls: [
          {
            id: null,
            function: { name: 'search_events', arguments: '{"query":"moop"}' },
          },
        ],
      },
      {
        content: 'MOOP means Matter Out Of Place.',
        reasoning_content: 'answer from results',
        timings: { prompt_n: 700, prompt_ms: 6000, predicted_n: 30, predicted_ms: 800, cache_n: 600 },
        _stream: ['some hidden thought</think>', 'MOOP means Matter Out Of Place.'],
      },
    ];
    const turn1 = await session.chat('what is MOOP');
    expect(turn1.text).toBe('MOOP means Matter Out Of Place.');

    // Turn 2: the clarify follow-up.
    // grounding floor (2026-08-18): the factual follow-up discards its round-0
    // text, forces one lookup_facts (fed empty), and answers post-lookup.
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'It means pack out everything you bring.' },
    ];
    await session.chat('what do you mean by that?');

    // completions: [0]=warm-up, [1]=turn1 round1, [2]=turn1 round2 (post-tool),
    // [3]=turn2 round0, [4]=turn2 post-floor round.
    expect(completions).toHaveLength(5);

    const systemPrompt = getPersona(DEFAULT_PERSONA_ID).systemPrompt;

    // Turn-1 round-2 fed the tool round back WITHIN the turn (expected).
    const round2Roles = completions[2].messages.map((m: any) => m.role);
    expect(round2Roles).toEqual(['system', 'user', 'assistant', 'tool']);

    // THE RAW THREAD: turn 2's assembly replays turn 1 verbatim — user,
    // the tool-call assistant (reasoning intact: byte-identical KV prefix),
    // its tool result, and the final — then the new user message. The model
    // sits in real grounded material, not a drumbeat of its own finals
    // (the curated-pairs design produced both the no-tool momentum and the
    // answer-echo class; one long thread is the root fix).
    const turn2 = completions[3].messages;
    expect(turn2.map((m: any) => m.role)).toEqual([
      'system',
      'user',       // what is MOOP
      'assistant',  // tool call (search_events), reasoning kept
      'tool',       // its result — the passages stay visible next turn
      'assistant',  // MOOP means Matter Out Of Place.
      'user',       // what do you mean by that?
    ]);
    expect(turn2[0].content).toBe(systemPrompt);
    expect(turn2[1].content).toBe('what is MOOP');
    expect(turn2[2].tool_calls?.[0]?.function.name).toBe('search_events');
    expect(turn2[2].reasoning_content).toBe('user asks about MOOP -> search');
    expect(turn2[4].content).toBe('MOOP means Matter Out Of Place.');
    expect(turn2[4].tool_calls).toBeUndefined();
    expect(turn2[5].content).toBe('what do you mean by that?');
    // The system prompt appears exactly once across the whole assembly.
    expect(turn2.filter((m: any) => m.role === 'system')).toHaveLength(1);
    // The floor feeds back WITHIN the turn: the same replayed prefix plus
    // this turn's forced lookup exchange.
    expect(completions[4].messages.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('invalidates warmed sessions when the serialized tool schema changes', () => {
    expect(toolSchemaHash('persona', [])).not.toBe(
      toolSchemaHash('persona', [{ type: 'function', function: { name: 'lookup_history' } }]),
    );
    expect(toolSchemaHash('persona', [])).toBe(toolSchemaHash('persona', []));
  });

  it('sends thinking ON with the SAFETY-NET budget on every round (2026-08-17: r8 uncapped is retired)', () => {
    // r8 ran uncapped because v1.6's thinks were short by construction; the
    // v4.0 GRPO checkpoint thought 3.5K chars per completion on the Pixel 7
    // (282 s turn, two speechless completions). The budget is ~4x the SFT
    // p90, so trained-short thinks never touch it; a runaway is bounded.
    // Tool rounds (tools offered, tool_choice auto) get the tighter budget;
    // forced finals get the full one.
    for (const c of completions.slice(1)) {
      expect(c.thinking_budget_tokens).toBe(
        c.tool_choice === 'none' ? THINK_BUDGET_TOKENS : THINK_BUDGET_TOOL_ROUND_TOKENS,
      );
      expect(c.thinking_budget_message).toBe(THINK_BUDGET_MESSAGE);
      expect(c.enable_thinking).toBe(true);
    }
  });

  it('field log: user + tool_call + tool_result + assistant rows land with sane metrics', () => {
    const rows = mockLogDb
      .prepare('SELECT * FROM chat_log ORDER BY id')
      .all() as any[];
    // grounding floor (2026-08-18): the factual clarify turn logs one forced
    // lookup_facts round (tool_call + tool_result) before its assistant row.
    expect(rows.map(r => r.role)).toEqual([
      'system_note', // model loaded
      'user', 'tool_call', 'tool_result', 'assistant', // turn 1 (tooled)
      'user', 'tool_call', 'tool_result', 'assistant', // turn 2 (clarify, floored)
    ]);
    // One conversation = one session id across the whole run.
    expect(new Set(rows.map(r => r.session_id)).size).toBe(1);
    expect(rows.every(r => r.persona === DEFAULT_PERSONA_ID)).toBe(true);

    const [note, user1, toolCall, toolResult, assistant1, user2, floorCall, floorResult, assistant2] = rows;
    expect(note.text).toBe('model loaded: m.gguf');
    expect(user1.text).toBe('what is MOOP');
    expect(user1.model_file).toBe('m.gguf');

    expect(JSON.parse(toolCall.text)).toEqual({
      name: 'search_events',
      args: '{"query":"moop"}',
    });
    const resultPayload = JSON.parse(toolResult.text);
    expect(resultPayload.name).toBe('search_events');
    expect(resultPayload.row_ids).toEqual([]);
    expect(JSON.parse(resultPayload.json)).toEqual({
      count: 1,
      events: [{ title: 'Sunrise Yoga' }],
    });

    // Assistant row: final text post-ThinkFilter, metrics aggregated across
    // BOTH completions of the tooled turn.
    expect(assistant1.text).toBe('MOOP means Matter Out Of Place.');
    expect(assistant1.prompt_tokens).toBe(600 + 700);
    expect(assistant1.completion_tokens).toBe(40 + 30);
    expect(assistant1.thinking_chars).toBe(
      'user asks about MOOP -> search'.length + 'answer from results'.length,
    );
    expect(assistant1.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(assistant1.total_ms).toBeGreaterThanOrEqual(assistant1.ttft_ms);
    const sampler = JSON.parse(assistant1.sampler_json);
    expect(sampler.temperature).toBe(0.1);
    // The think budgets ride on the row: this row ran the safety-net config.
    expect(sampler.thinking_budget_tokens).toBe(THINK_BUDGET_TOKENS);
    expect(sampler.thinking_budget_tool_turn_tokens).toBe(THINK_BUDGET_TOOL_ROUND_TOKENS);
    const rounds = JSON.parse(assistant1.timings_json);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].tool_calls).toEqual(['search_events']);
    expect(rounds[0].timings.prompt_ms).toBe(5000);
    expect(rounds[1].tool_calls).toEqual([]);

    // The clarify turn streamed nothing and reported no timings: metrics
    // stay NULL rather than inventing numbers.
    expect(user2.text).toBe('what do you mean by that?');
    expect(JSON.parse(floorCall.text).name).toBe('lookup_facts');
    const floorPayload = JSON.parse(floorResult.text);
    expect(floorPayload.name).toBe('lookup_facts');
    expect(floorPayload.row_ids).toEqual([]);
    expect(floorPayload.card_kinds).toEqual([]);
    expect(assistant2.text).toBe('It means pack out everything you bring.');
    expect(assistant2.ttft_ms).toBeNull();
    expect(assistant2.prompt_tokens).toBeNull();
    expect(assistant2.total_ms).toBeGreaterThanOrEqual(0);
    // Two rounds waited through: round 0 (discarded) + the post-floor round.
    expect(JSON.parse(assistant2.timings_json)).toHaveLength(2);
  });

  it('reconciles an absolute event denial before return, log, and next-turn history', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const event = {
      id: 501,
      title: 'Sunrise Yoga',
      desc: 'Gentle movement at dawn.',
      day: 'Wednesday',
      date: '2026-09-02',
      time_start: '07:00',
      time_end: '08:00',
      camp: 'Test Camp',
      location: '7:30 & G',
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"count":1}',
      cards: [
        { kind: 'event', event },
        { kind: 'event', event },
      ], // duplicate tool rows still mean one rendered card
      shrink: async () => ({
        json: '{"count":1}',
        cards: [{ kind: 'event', event }],
      }),
    });
    results = [
      {
        content: '',
        tool_calls: [
          {
            id: null,
            function: { name: 'search_events', arguments: '{"query":"sunrise"}' },
          },
        ],
      },
      { content: "I couldn't find any events matching that specific query." },
    ];
    const turn = await session.chat('sunrise events Wednesday');
    expect(turn.text).toBe('I found 1 event in the offline guide.');
    expect(turn.cards).toEqual([{ kind: 'event', event }]);

    const logged = mockLogDb
      .prepare("SELECT text FROM chat_log WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get() as { text: string };
    expect(logged.text).toBe('I found 1 event in the offline guide.');

    // grounding floor (2026-08-18): the factual follow-up feeds the floor one
    // empty lookup; next-turn history shows on its ROUND-0 assembly (second-to-
    // last completion — the floor adds one more after it).
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'The first one starts at seven.' },
    ];
    await session.chat('when does the first one start?');
    const next = completions[completions.length - 2].messages;
    expect(next[next.length - 2]).toEqual({
      role: 'assistant',
      content: 'I found 1 event in the offline guide.',
    });
  });

  it('replaces generated relational prose with app-owned narration before return, log, and history', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const card = {
      kind: 'attendance' as const,
      person: 'River Moon',
      years: [
        {
          year: 2023,
          pack_id: 'history',
          evidence_ref: 'history.md#river-2023',
        },
      ],
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: JSON.stringify({
        status: 'cards_attached',
        query: 'attendance',
        instruction:
          'Structured cards are attached. Do not restate years, dates, counts, or relationships in prose.',
      }),
      cards: [card],
      shrink: async () => ({ json: '{}', cards: [card] }),
    });
    results = [
      {
        content: '',
        tool_calls: [
          {
            id: null,
            function: {
              name: 'lookup_history',
              arguments: '{"query":"attendance","entity":"River Moon"}',
            },
          },
        ],
      },
      { content: 'River Moon attended in 2023, for a total of one recorded year.' },
    ];

    const turn = await session.chat('when did River Moon attend?');
    expect(turn).toEqual({
      text: 'I found matching camp-history records below.',
      cards: [card],
      // Relational cards carry their own evidence rows; no doc passages ran.
      sources: [],
      answeredFrom: 'packs',
      toolRounds: 1,
    });
    expect(turn.text).not.toMatch(/2023|one recorded year/);

    const toolRow = mockLogDb
      .prepare("SELECT text FROM chat_log WHERE role = 'tool_result' ORDER BY id DESC LIMIT 1")
      .get() as { text: string };
    expect(JSON.parse(toolRow.text)).toMatchObject({
      name: 'lookup_history',
      row_ids: [],
      card_kinds: ['attendance'],
    });
    const assistantRow = mockLogDb
      .prepare("SELECT text FROM chat_log WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get() as { text: string };
    expect(assistantRow.text).toBe('I found matching camp-history records below.');

    // grounding floor (2026-08-18): the factual follow-up feeds the floor one
    // empty lookup; next-turn history shows on its ROUND-0 assembly (second-to-
    // last completion — the floor adds one more after it).
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'The card remains the source of truth.' },
    ];
    await session.chat('what was that result?');
    const next = completions[completions.length - 2].messages;
    expect(next[next.length - 2]).toEqual({
      role: 'assistant',
      content: 'I found matching camp-history records below.',
    });
  });

  it('forces final narration after any successful structured-card call', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const card = {
      kind: 'projects' as const,
      person: 'River Moon',
      projects: [
        {
          name: 'Shade Build',
          year: 2023,
          pack_id: 'history',
          evidence_ref: 'history.md#shade',
        },
      ],
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"status":"cards_attached"}',
      cards: [card],
      shrink: async () => ({ json: '{}', cards: [card] }),
    });
    const base = completions.length;
    results = [
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'lookup_history',
              arguments: '{"query":"projects","entity":"Riv"}',
            },
          },
        ],
      },
      { content: 'The project was Shade Build in 2023.' },
    ];

    await session.chat('Use lookup_history with query projects and entity Riv.');
    expect(completions[base].tool_choice).toBe('auto');
    expect(completions[base + 1].tool_choice).toBe('none');
    // Forced completions KEEP the tool list (KV-cache-stable prefix, 2026-08-17)
    // and forbid calling via tool_choice 'none'.
    expect(completions[base + 1].tools).toBeDefined();
  });

  it('deduplicates identical structured cards from repeated calls in one round', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const card = {
      kind: 'projects' as const,
      person: 'River Moon',
      projects: [
        {
          name: 'Shade Build',
          year: 2023,
          pack_id: 'history',
          evidence_ref: 'history.md#shade',
        },
      ],
    };
    const outcome = {
      json: '{"status":"cards_attached"}',
      cards: [card],
      shrink: async () => ({ json: '{}', cards: [card] }),
    };
    (executeTool as jest.Mock)
      .mockResolvedValueOnce(outcome)
      .mockResolvedValueOnce(outcome);
    const call = {
      function: {
        name: 'lookup_history',
        arguments: '{"query":"projects","entity":"River Moon"}',
      },
    };
    results = [
      { content: '', tool_calls: [call, call] },
      { content: 'The project was Shade Build in 2023.' },
    ];

    const turn = await session.chat('What projects did River Moon work on?');
    expect(turn.cards).toEqual([card]);
    expect(turn.text).toBe('I found matching camp-history records below.');
  });

  it('reconciles a positive structured card over an earlier tool absence', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    const card = {
      kind: 'projects' as const,
      person: 'River Moon',
      projects: [
        {
          name: 'Shade Build',
          year: 2023,
          pack_id: 'history',
          evidence_ref: 'history.md#shade',
        },
      ],
    };
    (executeTool as jest.Mock)
      .mockResolvedValueOnce({
        json: '{"status":"no_match"}',
        cards: [],
        historyAbsence: { query: 'projects', entity: 'River Moon' },
        shrink: async () => ({ json: '{}', cards: [] }),
      })
      .mockResolvedValueOnce({
        json: '{"status":"cards_attached"}',
        cards: [card],
        resolvedPerson: {
          pack_id: 'history',
          id: 'person:river',
          name: 'River Moon',
        },
        shrink: async () => ({ json: '{}', cards: [card] }),
      });
    const calls = [
      {
        function: {
          name: 'lookup_history',
          arguments: '{"query":"projects","entity":"River Moon"}',
        },
      },
      {
        function: {
          name: 'lookup_history',
          arguments: '{"query":"projects","entity":"Riv"}',
        },
      },
    ];
    results = [
      { content: '', tool_calls: calls },
      { content: 'I did not find one call, but the other had a project.' },
    ];

    const turn = await session.chat('Check River Moon projects twice.');
    expect(turn.cards).toEqual([card]);
    expect(turn.text).toBe('I found matching camp-history records below.');
  });

  it('keeps grounded document evidence over a competing no-coverage result', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    const waterSource = {
      id: 'survival-guide:1',
      pack: 'Survival Guide',
      doc: 'Water',
      heading: 'Survival > Water',
      passage: 'Carry water.',
      memorial: false,
    };
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    (executeTool as jest.Mock)
      .mockResolvedValueOnce({
        json: '{"status":"no_coverage"}',
        cards: [],
        sources: [],
        noCoverage: 'Water',
        emptyLookup: true,
        shrink: async () => ({ json: '{}', cards: [], sources: [] }),
      })
      .mockResolvedValueOnce({
        json: '{"count":1}',
        cards: [],
        sources: [waterSource],
        shrink: async () => ({
          json: '{}',
          cards: [],
          sources: [waterSource],
        }),
      });
    results = [
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'lookup_facts',
              arguments: '{"topic":"water"}',
            },
          },
          {
            function: {
              name: 'search_docs',
              arguments: '{"query":"water"}',
            },
          },
        ],
      },
      { content: 'The guide says to carry water.' },
    ];

    const turn = await session.chat('Compare the water references.');
    expect(turn.text).toBe('The guide says to carry water.');
    expect(turn.sources).toEqual([waterSource]);
  });

  it('updates app-owned cards when context-overflow shrinking rebuilds a tool result', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const full = {
      kind: 'attendance' as const,
      person: 'River Moon',
      years: [
        { year: 2022, pack_id: 'history', evidence_ref: 'history.md#2022' },
        { year: 2023, pack_id: 'history', evidence_ref: 'history.md#2023' },
      ],
    };
    const smaller = {
      ...full,
      years: [full.years[0]],
    };
    const shrink = jest.fn(async () => ({
      json: '{"status":"cards_attached"}',
      cards: [smaller],
    }));
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"status":"cards_attached"}',
      cards: [full],
      shrink,
    });
    results = [
      {
        content: '',
        tool_calls: [
          {
            id: null,
            function: {
              name: 'lookup_history',
              arguments: '{"query":"attendance","entity":"River Moon"}',
            },
          },
        ],
      },
      { content: '', context_full: true },
      { content: 'The years are 2022 and 2023.' },
    ];

    const turn = await session.chat('when did River Moon attend?');
    expect(shrink).toHaveBeenCalledWith(2);
    expect(turn.cards).toEqual([smaller]);
    expect(turn.text).toBe('I found matching camp-history records below.');
  });

  it('does not anchor a person whose card was discarded during context shrink', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    const card = {
      kind: 'attendance' as const,
      person: 'River Moon',
      years: [
        { year: 2023, pack_id: 'history', evidence_ref: 'history.md#2023' },
      ],
    };
    const person = {
      pack_id: 'history',
      id: 'person:river',
      name: 'River Moon',
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"status":"cards_attached"}',
      cards: [card],
      resolvedPerson: person,
      shrink: async () => ({ json: '{"status":"no_match"}', cards: [] }),
    });
    results = [
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'lookup_history',
              arguments: '{"query":"attendance","entity":"River Moon"}',
            },
          },
        ],
      },
      { content: '', context_full: true },
      { content: 'I could not fit the records.' },
    ];
    await session.chat('Use the history lookup for River Moon.');

    const executed = (executeTool as jest.Mock).mock.calls.length;
    results = [{ content: '' }, { content: 'Nothing recorded.' }];
    await session.chat('who sponsored her?');
    expect(
      (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
    ).toBe('{"query":"sponsors","entity":"her"}');
    expect((executeTool as jest.Mock).mock.calls[executed][2]).toBeNull();
  });

  // The questions here are deliberately NOT identity-shaped: since the
  // identity floor landed, "who is X" always carries a tool round, so it can
  // never be a no-tool failure (asserted in the identity-floor block below).
  // This test is about the omission rule itself, which is shape-agnostic.
  it('omits consecutive trailing no-tool IDKs from inference but keeps full logs', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const base = completions.length;

    // grounding floor (2026-08-18): the two ANSWERED turns are factual and
    // feed the floor (two completions each); the two IDK turns are reworded to
    // EVENT_REQUEST-shaped questions (floor-exempt) so they stay genuine
    // NO-TOOL failures — the exact shape the omission rule exists for.
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [{ content: '' }, { content: 'Marisol founded the camp.' }];
    await session.chat('who founded the camp?');
    results = [{ content: "I don't know what the vibe was like." }];
    await session.chat('what was the party vibe like in 2019?');
    results = [{ content: "I can't find anything about noise in my guides." }];
    await session.chat('how loud do the parties get?');
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [{ content: '' }, { content: 'MOOP means matter out of place.' }];
    await session.chat('what is MOOP?');

    // raw thread (2026-08-18): turn 1's tool exchange replays in later
    // assemblies; the IDK-omission rule still drops trailing no-tool
    // failures, at turn granularity.
    const secondFailure = completions[base + 3].messages;
    expect(secondFailure.map((m: any) => m.role)).toEqual([
      'system',
      'user',       // who founded the camp?
      'assistant',  // floor's forced lookup_facts
      'tool',       // its (empty) result
      'assistant',  // Marisol founded the camp.
      'user',       // how loud do the parties get?
    ]);
    expect(secondFailure.map((m: any) => m.content)).not.toContain(
      "I don't know what the vibe was like.",
    );

    const newQuestion = completions[base + 4].messages;
    expect(newQuestion.filter((m: any) => m.role !== 'assistant' || !m.tool_calls)
      .filter((m: any) => m.role !== 'tool')
      .map((m: any) => m.content)).toEqual([
      getPersona(DEFAULT_PERSONA_ID).systemPrompt,
      'who founded the camp?',
      'Marisol founded the camp.',
      'what is MOOP?',
    ]);
    // both IDK turns dropped, turn-1's raw exchange retained
    expect(newQuestion.map((m: any) => m.content)).not.toContain(
      "I can't find anything about noise in my guides.",
    );

    const rows = mockLogDb
      .prepare("SELECT role, text FROM chat_log WHERE role IN ('user','assistant') ORDER BY id DESC LIMIT 8")
      .all()
      .reverse() as Array<{ role: string; text: string }>;
    expect(rows.map(r => r.text)).toEqual([
      'who founded the camp?',
      'Marisol founded the camp.',
      'what was the party vibe like in 2019?',
      "I don't know what the vibe was like.",
      'how loud do the parties get?',
      "I can't find anything about noise in my guides.",
      'what is MOOP?',
      'MOOP means matter out of place.',
    ]);
  });

  it('retains a trailing failure when the user explicitly asks about it', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    // grounding floor (2026-08-18): turn 1 reworded to an EVENT_REQUEST-shaped
    // question (floor-exempt) so it stays a genuine NO-TOOL failure; the
    // factual follow-up feeds the floor — its ROUND-0 assembly (completions
    // [base]), the retention check, is unchanged.
    results = [{ content: "I don't know how loud it gets." }];
    await session.chat('how loud do the parties get?');
    const base = completions.length;
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'The answer was not in the context I used.' },
    ];
    await session.chat("why couldn't you find it?");
    expect(completions[base].messages.map((m: any) => m.content)).toEqual([
      getPersona(DEFAULT_PERSONA_ID).systemPrompt,
      'how loud do the parties get?',
      "I don't know how loud it gets.",
      "why couldn't you find it?",
    ]);
  });

  it('retains a tool-backed empty answer even when its prose is an IDK', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"count":0,"passages":[]}',
      cards: [],
      shrink: async () => ({ json: '{"count":0}', cards: [] }),
    });
    results = [
      {
        content: '',
        tool_calls: [
          {
            id: null,
            function: { name: 'lookup_facts', arguments: '{"topic":"Rook"}' },
          },
        ],
      },
      { content: "I don't know what Rook worked on." },
    ];
    await session.chat('what did Rook work on?');
    const base = completions.length;
    results = [{ content: 'Coco helped with the kitchen.' }];
    await session.chat('what did Coco work on?');
    expect(completions[base].messages.map((m: any) => m.content)).toContain(
      "I don't know what Rook worked on.",
    );
  });

  it('turns an immediate day-only event clarification into one forced search', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    results = [
      {
        content:
          "I don't have access to the full weekly schedule. Name a day and I can search.",
      },
    ];
    await session.chat('ok thanks now what about sunrise sets');

    const event = {
      id: 601,
      title: 'Tuesday Sunrise Set',
      desc: 'Music at dawn.',
      day: 'Tuesday',
      date: '2026-09-01',
      time_start: '06:00',
      time_end: '07:00',
      camp: 'Test Camp',
      location: '2:00 & A',
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"count":1}',
      cards: [{ kind: 'event', event }],
      shrink: async () => ({
        json: '{"count":1}',
        cards: [{ kind: 'event', event }],
      }),
    });
    const base = completions.length;
    const calls: string[] = [];
    const done: string[] = [];
    results = [{ content: 'I found a Tuesday sunrise set.' }];
    const turn = await session.chat('Tuesday.', {
      onToolCall: name => calls.push(name),
      onToolDone: name => done.push(name),
    });

    expect(completions.length - base).toBe(1);
    expect(turn).toEqual({
      text: 'I found a Tuesday sunrise set.',
      cards: [{ kind: 'event', event }],
      // Event rows are their own provenance — nothing to cite.
      sources: [],
      answeredFrom: 'packs',
      toolRounds: 1,
    });
    expect(calls).toEqual(['search_events']);
    expect(done).toEqual(['search_events']);
    const synthetic = (executeTool as jest.Mock).mock.calls.at(-1);
    expect(synthetic[1]).toBe('Tuesday.');
    expect(synthetic[0].function.name).toBe('search_events');
    expect(JSON.parse(synthetic[0].function.arguments)).toEqual({
      query: 'sunrise sets',
      day: 'tuesday',
    });

    const forced = completions[base];
    // Forced completions KEEP the tool list (KV-cache-stable prefix, 2026-08-17)
    // and forbid calling via tool_choice 'none'.
    expect(forced.tools).toBeDefined();
    expect(forced.tool_choice).toBe('none');
    expect(forced.messages.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(forced.messages[1].content).toBe('sunrise sets tuesday');
    expect(forced.messages.map((m: any) => m.content)).not.toContain(
      "I don't have access to the full weekly schedule. Name a day and I can search.",
    );

    const rows = mockLogDb
      .prepare('SELECT role, text FROM chat_log ORDER BY id DESC LIMIT 6')
      .all()
      .reverse() as Array<{ role: string; text: string }>;
    expect(rows.map(r => r.role)).toEqual([
      'user',
      'assistant',
      'user',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    expect(rows[2].text).toBe('Tuesday.');
    expect(JSON.parse(rows[3].text).name).toBe('search_events');

    const executed = (executeTool as jest.Mock).mock.calls.length;
    // grounding floor (2026-08-18): a bare 'Wednesday' with the clarification
    // consumed is a factual turn — the floor's lookup_facts fires; what must
    // NOT fire is another forced search_events.
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'Wednesday is a day of the week.' },
    ];
    await session.chat('Wednesday');
    expect((executeTool as jest.Mock).mock.calls).toHaveLength(executed + 1);
    expect(
      (executeTool as jest.Mock).mock.calls[executed][0].function.name,
    ).toBe('lookup_facts');
    const next = completions[completions.length - 1].messages;
    expect(next.map((m: any) => m.content)).not.toContain(
      "I don't have access to the full weekly schedule. Name a day and I can search.",
    );
  });

  it('consumes pending clarification on non-day text and never arms from non-events', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    results = [{ content: 'Which day should I search?' }];
    await session.chat('any sunrise events?');
    const toolCalls = (executeTool as jest.Mock).mock.calls.length;

    // grounding floor (2026-08-18): the consuming turn reworded to smalltalk
    // ('nope', SMALLTALK_RE-exempt) so the count stays floor-free; a bare
    // 'Tuesday' (<8 chars) is floor-exempt by the short-fragment rule.
    results = [{ content: 'Okay.' }];
    await session.chat('nope');
    results = [{ content: 'Tuesday is a day of the week.' }];
    await session.chat('Tuesday');
    expect((executeTool as jest.Mock).mock.calls).toHaveLength(toolCalls);

    const unrelated = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await unrelated.load('/m.gguf', () => {});
    // The factual non-event question feeds the floor: ONE lookup_facts runs —
    // and still never a forced search_events, which is this test's point.
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'Which day should I search?' },
    ];
    await unrelated.chat('what is MOOP?');
    expect(
      (executeTool as jest.Mock).mock.calls[toolCalls][0].function.name,
    ).toBe('lookup_facts');
    results = [{ content: 'Tuesday is a day of the week.' }];
    await unrelated.chat('Tuesday');
    expect((executeTool as jest.Mock).mock.calls).toHaveLength(toolCalls + 1);
  });

  it('repairs drifted history slots for execution and model feedback', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const base = completions.length;
    const executed = (executeTool as jest.Mock).mock.calls.length;

    results = [
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'lookup_history',
              arguments: '{"query":"years attended"}',
            },
          },
        ],
      },
      { content: 'I found the records.' },
    ];
    await session.chat('Which years did Riv attend?');

    const routed = completions[base];
    expect(routed.tool_choice).toBe('auto');
    expect(routed.tools).toHaveLength(1);
    expect(routed.tools[0].function.name).toBe('lookup_history');

    const repaired = (executeTool as jest.Mock).mock.calls[executed][0];
    expect(repaired.function).toEqual({
      name: 'lookup_history',
      arguments: '{"query":"attendance","entity":"Riv"}',
    });

    const final = completions[base + 1];
    expect(final.tool_choice).toBe('none');
    // Forced completions KEEP the tool list (KV-cache-stable prefix, 2026-08-17)
    // and forbid calling via tool_choice 'none'.
    expect(final.tools).toBeDefined();
    const feedback = final.messages.find(
      (message: any) => message.role === 'assistant' && message.tool_calls,
    );
    expect(feedback.tool_calls[0].function).toEqual(repaired.function);
  });

  it('executes parsed history slots when auto tool choice narrates instead', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const base = completions.length;
    const executed = (executeTool as jest.Mock).mock.calls.length;

    results = [
      { content: 'I found matching camp-history records below.' },
      { content: 'I found the records.' },
    ];
    await session.chat('Who did Blair sponsor?');

    expect(completions[base].tools).toHaveLength(1);
    const call = (executeTool as jest.Mock).mock.calls[executed][0];
    expect(call.function).toEqual({
      name: 'lookup_history',
      arguments: '{"query":"sponsees","entity":"Blair"}',
    });
    const final = completions[base + 1];
    expect(final.tool_choice).toBe('none');
    expect(final.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [call],
        }),
      ]),
    );
  });

  describe('authoritative identity pre-route', () => {
    const person = {
      pack_id: 'dusty-star-lore-25y',
      id: 'person:coco',
      name: 'Coco',
    };
    const card = {
      kind: 'person' as const,
      person_ref: person,
      name: 'Coco',
      alsoKnownAs: null,
      aliases: [],
      tenure: { from: 'Mar 2011', to: 'Aug 2019' },
      summary: 'Coco was a Dusty Star camper, on the camp list from Mar 2011 to Aug 2019.',
      memoriam: 'In memoriam. The camp remembers her at the temple every year.',
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#coco',
    };
    const source = {
      id: 'dusty-star-lore-25y:42',
      pack: 'Dusty Star Memory Bank',
      doc: 'Who is Coco?',
      heading: 'Campers > Coco — Dusty Star camper > Who is Coco?',
      passage: card.summary,
      memorial: true,
    };

    const fresh = async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }];
      await session.load('/m.gguf', () => {});
      return session;
    };

    beforeEach(() => {
      (lookupPersonIdentity as jest.Mock).mockImplementation(
        (intent: { topic: string }) => ({
          status: 'not_found',
          query: intent.topic,
          candidates: [],
        }),
      );
    });

    it('resolves and renders before any user completion can stream', async () => {
      const session = await fresh();
      const base = completions.length;
      const executed = (executeTool as jest.Mock).mock.calls.length;
      const events: string[] = [];
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'resolved', person, card, source,
      });

      const turn = await session.chat('Who is Coco', {
        onToolCall: (name, forced) => events.push(`call:${name}:${forced}`),
        onToolDone: name => events.push(`done:${name}`),
        onToken: text => events.push(`token:${text}`),
      });

      expect(completions).toHaveLength(base);
      expect((executeTool as jest.Mock).mock.calls).toHaveLength(executed);
      expect(events).toEqual(['call:lookup_person:true', 'done:lookup_person']);
      expect(turn).toEqual({
        text: "Here's what the camp remembers of Coco.",
        cards: [card],
        sources: [source],
        answeredFrom: 'packs',
        toolRounds: 1,
      });
    });

    it('COMPOUND "who is X and who has she sponsored": person card + relational half, no model round (2026-08-17)', async () => {
      // The owner's phone question. Before: no parser matched, the model
      // called lookup_history(query='pug'), and with the pack absent said
      // "Pug is a dog". Now the identity half resolves the card and the
      // relational half runs deterministically against the resolved person.
      const session = await fresh();
      const base = completions.length;
      const events: string[] = [];
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'resolved', person, card, source,
      });
      const lineage = {
        kind: 'lineage' as const,
        person: 'Coco',
        direction: 'sponsees' as const,
        relationships: [{ from: 'Coco', to: 'Riv', year: 2014, pack_id: 'dusty-star-lore-25y', evidence_ref: 'e1' }],
      };
      (lookupHistory as jest.Mock).mockReturnValueOnce({
        json: '{"status":"cards_attached"}',
        cards: [lineage],
        resolvedPerson: person,
      });

      const turn = await session.chat('Who is Coco and who has she sponsored', {
        onToolCall: (name, forced) => events.push(`call:${name}:${forced}`),
        onToolDone: name => events.push(`done:${name}`),
      });

      expect(completions).toHaveLength(base); // no model completion at all
      expect((lookupHistory as jest.Mock).mock.calls.at(-1)?.[0]).toEqual({
        query: 'sponsees',
        entity: 'Coco', // the RESOLVED name, not the pronoun
      });
      expect(events).toEqual([
        'call:lookup_person:true', 'done:lookup_person',
        'call:lookup_history:true', 'done:lookup_history',
      ]);
      expect(turn.cards).toEqual([card, lineage]);
      expect(turn.text).toBe(
        "Here's what the camp remembers of Coco. The people they sponsored are below.",
      );
    });

    it('COMPOUND with an empty relation says so plainly instead of dropping the half', async () => {
      const session = await fresh();
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'resolved', person, card, source,
      });
      (lookupHistory as jest.Mock).mockReturnValueOnce({
        json: '{"status":"no_match"}',
        cards: [],
        absence: { query: 'sponsees', entity: 'Coco' },
      });
      const turn = await session.chat('who is Coco, and who did she sponsor?');
      expect(turn.cards).toEqual([card]);
      expect(turn.text.startsWith("Here's what the camp remembers of Coco.")).toBe(true);
      expect(turn.text.length).toBeGreaterThan("Here's what the camp remembers of Coco.".length);
    });

    it('asks on ambiguity instead of selecting retrieval rank', async () => {
      const session = await fresh();
      const base = completions.length;
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'ambiguous',
        query: 'David',
        candidates: [
          {
            pack_id: 'dusty-star-lore-25y',
            id: 'person:pug',
            name: 'Rook',
            aliases: ['David', 'Alex Mercer'],
          },
          {
            pack_id: 'dusty-star-lore-25y',
            id: 'person:dta',
            name: 'AJM',
            aliases: ['David', 'Alex J Mercer'],
          },
        ],
      });

      const turn = await session.chat('Who is David?');
      expect(completions).toHaveLength(base);
      expect(turn.cards).toEqual([]);
      expect(turn.text).toBe(
        'There are 2 campers matching David in your packs — ' +
          'Rook (Alex Mercer) and AJM (Alex J Mercer). Which one?',
      );
      expect(turn.text).not.toMatch(/Dusty Star|Memory Bank/);
    });

    it('uses pack IDs only when same-name candidates have no usable alias', async () => {
      const session = await fresh();
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'ambiguous',
        query: 'Alex',
        candidates: [
          {
            pack_id: 'camp-a',
            id: 'person:alex',
            name: 'Alex',
            aliases: [],
          },
          {
            pack_id: 'camp-b',
            id: 'person:alex',
            name: 'Alex',
            aliases: [],
          },
        ],
      });

      const turn = await session.chat('Who is Alex?');
      expect(turn.text).toBe(
        'There are 2 campers matching Alex in your packs — ' +
          'Alex (camp-a) and Alex (camp-b). Which one?',
      );
    });

    it('owns not-found and card-unavailable closes without model prose', async () => {
      const missing = await fresh();
      let base = completions.length;
      const absent = await missing.chat('Who is Ruckus?');
      expect(completions).toHaveLength(base);
      expect(absent.text).toBe(
        "I couldn't match Ruckus to one camper in the packs you're carrying.",
      );

      const unavailable = await fresh();
      base = completions.length;
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'card_unavailable',
        person,
        pack_name: 'Dusty Star Memory Bank',
      });
      const noCard = await unavailable.chat('Who is Coco?');
      expect(completions).toHaveLength(base);
      expect(noCard.text).toBe(
        "I found Coco in Dusty Star Memory Bank, but that pack doesn't carry their person card.",
      );
    });

    it.each([
      [
        'ambiguity',
        {
          status: 'ambiguous',
          query: 'David',
          candidates: [
            {
              pack_id: 'dusty-star-lore-25y',
              id: 'person:pug',
              name: 'Rook',
              aliases: ['Alex Mercer'],
            },
            {
              pack_id: 'dusty-star-lore-25y',
              id: 'person:dta',
              name: 'AJM',
              aliases: ['Alex J Mercer'],
            },
          ],
        },
      ],
      [
        'an unavailable card',
        {
          status: 'card_unavailable',
          person: {
            pack_id: 'another-pack',
            id: 'person:david',
            name: 'David',
          },
          pack_name: 'Another Pack',
        },
      ],
    ])('%s clears an older discourse anchor', async (_label, outcome) => {
      const session = await fresh();
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'resolved',
        person,
        card,
        source,
      });
      await session.chat('Who is Coco?');
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce(outcome);
      await session.chat('Who is David?');

      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'Nothing recorded.' }];
      await session.chat('who sponsored her?');
      expect(
        (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
      ).toBe('{"query":"sponsors","entity":"her"}');
      expect((executeTool as jest.Mock).mock.calls[executed][2]).toBeNull();
    });

    // grounding floor (2026-08-18): original spirit preserved — none of these
    // is ever PERSON-hijacked (no lookup_person pre-route; the model's own
    // words reach the user). The factual ones (floored: true) now carry the
    // floor's forced lookup_facts and answer post-lookup; the event-shaped
    // one stays floor-exempt and tool-free.
    it.each<[string, string, boolean]>([
      ['what is happening at camp tonight?', 'Plenty is happening tonight.', false],
      ['where is ice', 'Ice is sold at Arctica.', true],
      ['who is playing tonight', 'A few camps have music tonight.', true],
      ['tell me about ice', 'Ice comes in bags at Arctica.', true],
      ['who founded the camp?', 'Marisol founded the camp.', true],
    ])('never hijacks %s', async (question, answer, floored) => {
      const session = await fresh();
      const executed = (executeTool as jest.Mock).mock.calls.length;
      if (floored) {
        (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
      }
      results = [{ content: answer }, { content: answer }];
      const turn = await session.chat(question);
      expect((executeTool as jest.Mock).mock.calls).toHaveLength(
        executed + (floored ? 1 : 0),
      );
      if (floored) {
        // The only executed call is the floor's lookup_facts — never
        // lookup_person, never a person hijack.
        expect(
          (executeTool as jest.Mock).mock.calls[executed][0].function.name,
        ).toBe('lookup_facts');
      }
      expect(turn.toolRounds).toBe(floored ? 1 : 0);
      expect(turn.text).toBe(answer);
    });

    it('leaves relational questions to the history pre-route', async () => {
      const session = await fresh();
      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [
        { content: 'River was sponsored by someone.' },
        { content: 'I found the records.' },
      ];

      await session.chat('Who is River Moon’s sponsor?');
      const call = (executeTool as jest.Mock).mock.calls[executed][0];
      expect(call.function).toEqual({
        name: 'lookup_history',
        arguments: '{"query":"sponsors","entity":"River Moon"}',
      });
    });
  });

  describe('provenance (an answer carries the passages it stood on)', () => {
    const WATER = {
      id: 'survival-guide:1',
      pack: 'Survival Guide',
      doc: 'Water',
      heading: 'Survival Guide > Water',
      passage: 'Bring 1.5 gallons of water per person per day.',
      memorial: false,
    };
    const toolCall = (name: string, args: string) => ({
      id: null,
      function: { name, arguments: args },
    });

    const fresh = async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      return session;
    };

    it('hands the sources over the instant retrieval lands, and on the turn', async () => {
      const session = await fresh();
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"count":1,"passages":[]}',
        cards: [],
        sources: [WATER],
        shrink: async () => ({ json: '{}', cards: [], sources: [WATER] }),
      });
      results = [
        { content: '', tool_calls: [toolCall('lookup_facts', '{"topic":"water"}')] },
        { content: 'Bring a gallon and a half a day.' },
      ];

      const landed: unknown[] = [];
      const turn = await session.chat('how much water should I bring', {
        onToolDone: (_name, _cards, sources) => landed.push(sources),
      });

      // Grounding first: the UI can show where this came from seconds before
      // the prose that rests on it (the presence rule).
      expect(landed).toEqual([[WATER]]);
      expect(turn.sources).toEqual([WATER]);
      expect(turn.text).toBe('Bring a gallon and a half a day.');
    });

    it('an answer with no retrieval behind it cites nothing', async () => {
      const session = await fresh();
      results = [{ content: 'Everything I know rides in your pocket.' }];

      const turn = await session.chat('hello');
      expect(turn.sources).toEqual([]);
    });

    it('one passage found by two calls in a turn is one chip', async () => {
      const session = await fresh();
      const outcome = {
        json: '{"count":1,"passages":[]}',
        cards: [],
        sources: [WATER],
        shrink: async () => ({ json: '{}', cards: [], sources: [WATER] }),
      };
      (executeTool as jest.Mock)
        .mockResolvedValueOnce(outcome)
        .mockResolvedValueOnce(outcome);
      results = [
        {
          content: '',
          tool_calls: [
            toolCall('lookup_facts', '{"topic":"water"}'),
            toolCall('search_docs', '{"query":"water"}'),
          ],
        },
        { content: 'A gallon and a half a day.' },
      ];

      const turn = await session.chat('how much water should I bring');
      expect(turn.sources).toEqual([WATER]);
    });
  });

  describe('answer-forcing floor (r8: a turn may never end speechless)', () => {
    it('a speechless round retries ONCE: thinking suppressed, tools off', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      const base = completions.length;
      // Delta, not total: the log db is shared by every test in this file.
      const speechlessNotes = () =>
        mockLogDb
          .prepare("SELECT text FROM chat_log WHERE role = 'system_note' AND text LIKE 'speechless%'")
          .all().length;
      const notesBefore = speechlessNotes();

      // grounding floor (2026-08-18): 'well?' is factual and round 0 is EMPTY,
      // which still triggers the floor FIRST (it precedes the speechless
      // check); the speechless round being retried is now the POST-LOOKUP
      // round, so the turn takes three completions.
      (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
      results = [
        { content: '', reasoning_content: 'spent the whole completion thinking' },
        { content: '', reasoning_content: 'read the empty lookup, still no speech' },
        { content: 'Here it is, plainly.' },
      ];
      const turn = await session.chat('well?');
      expect(turn.text).toBe('Here it is, plainly.');
      expect(completions.length - base).toBe(3); // round 0 + post-lookup round + one retry, no more

      const first = completions[base + 1]; // the speechless post-lookup round
      expect(first.enable_thinking).toBe(true);
      expect(first.tools).toBeDefined();
      const retry = completions[base + 2];
      expect(retry.enable_thinking).toBe(false);
      // enable_thinking:false was NOT honored by LFM2.5's template on device
      // (2,737 think chars on a retry, 2026-08-17); a ZERO budget forces the
      // think closed at the first token, which is what "suppressed" must mean.
      expect(retry.thinking_budget_tokens).toBe(0);
      expect(first.thinking_budget_tokens).toBe(THINK_BUDGET_TOOL_ROUND_TOKENS);
      // Forced completions KEEP the tool list (KV-cache-stable prefix, 2026-08-17)
    // and forbid calling via tool_choice 'none'.
    expect(retry.tools).toBeDefined();
      expect(retry.tool_choice).toBe('none');
      // Same assembly re-run — the retry adds no messages.
      expect(retry.messages.map((m: any) => m.role)).toEqual(
        first.messages.map((m: any) => m.role),
      );

      expect(speechlessNotes() - notesBefore).toBe(1);
    });

    it('a doubly-speechless turn closes in real words — never whimsy, never empty', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      const base = completions.length;

      // grounding floor (2026-08-18): reworded 'anything?' -> 'sup' (smalltalk,
      // floor-exempt) — NO_ANSWER is the close for "nothing was looked up at
      // all", and a factual text now always carries the floor's lookup (that
      // grounded-empty close is the NOTHING_FOUND test below).
      results = [{ content: '' }, { content: '' }];
      const streamed: string[] = [];
      const turn = await session.chat('sup', { onToken: t => streamed.push(t) });
      expect(completions.length - base).toBe(2);
      expect(executeTool as jest.Mock).not.toHaveBeenCalled();
      // Nothing was looked up and the Angel produced no words: say THAT.
      // "That one slipped away into the dust" narrated a disappearance that
      // never happened — a deflection dressed as playa whimsy.
      expect(turn.text).toBe(NO_ANSWER);
      expect(turn.text).not.toMatch(/slipped away|dust/);
      expect(streamed.join('')).toContain(NO_ANSWER);
    });

    it('a lookup that found NOTHING closes by naming the packs as the boundary', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"count":0,"passages":[]}',
        cards: [],
        sources: [],
        emptyLookup: true,
        shrink: async () => ({ json: '{"count":0}', cards: [], sources: [] }),
      });

      results = [
        {
          content: '',
          tool_calls: [
            { id: null, function: { name: 'lookup_facts', arguments: '{"topic":"kombucha"}' } },
          ],
        },
        { content: '' },
        { content: '' },
      ];
      const turn = await session.chat('is there kombucha anywhere');

      expect(turn.text).toBe(NOTHING_FOUND);
      expect(turn.text).not.toMatch(/slipped away/);
      expect(turn.sources).toEqual([]);
    });

    it('an interrupted round does NOT retry — the user stopped it', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      const base = completions.length;

      results = [{ content: '', interrupted: true }];
      const turn = await session.chat('never mind');
      expect(completions.length - base).toBe(1); // no retry
      expect(turn.text).toBe('');
    });
  });

  /**
   * THE PRONOUN, END TO END (chat_log receipt, 2026-08-16, owner testing):
   *   turn 1  "Who is Coco"        -> Coco's person card renders. GOOD.
   *   turn 2  "who sponsored her?" -> lookup_history{"entity":"her"} ->
   *           {"status":"not_found","candidates":[]} -> "I don't have the
   *           sponsor details for Coco in my memory right now, but you can
   *           always ask your campmates or check Playa Info at Esplanade &
   *           5:45."
   * Two bugs in one turn: no camper is named "her" so the lookup could only
   * fail, and the close sent a camper asking about camp lineage to a Black
   * Rock City services desk.
   */
  describe('the session person anchor (one hop, one slot)', () => {
    const fresh = async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }]; // warm-up
      await session.load('/m.gguf', () => {});
      return session;
    };

    const cocoPerson = {
      pack_id: 'dusty-star-lore-25y',
      id: 'person:coco',
      name: 'Coco',
    };
    const cocoCard = {
      kind: 'person' as const,
      person_ref: cocoPerson,
      name: 'Coco',
      alsoKnownAs: null,
      aliases: [],
      tenure: { from: 'Mar 2011', to: 'Aug 2019' },
      summary: 'Coco was a Dusty Star camper, on the camp list from Mar 2011 to Aug 2019.',
      memoriam: 'In memoriam. The camp remembers her at the temple every year.',
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#coco',
    };

    /** Turn 1 of the receipt: the exact structured card that makes Coco the anchor. */
    const askWhoIsCoco = async (session: LlamaSession) => {
      (lookupPersonIdentity as jest.Mock).mockReturnValueOnce({
        status: 'resolved',
        person: cocoPerson,
        card: cocoCard,
        source: {
          id: 'dusty-star-lore-25y:42',
          pack: 'Dusty Star Memory Bank',
          doc: 'Who is Coco?',
          heading: 'Campers > Coco — Dusty Star camper > Who is Coco?',
          passage: cocoCard.summary,
          memorial: true,
        },
      });
      return session.chat('Who is Coco');
    };

    /** The device's own not_found, with the model's own domain-wrong close. */
    const sponsorsOfCocoNotFound = () => {
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"status":"not_found","query":"sponsors","candidates":[]}',
        cards: [],
        shrink: async () => ({ json: '{}', cards: [] }),
        historyAbsence: { query: 'sponsors', entity: 'Coco' },
      });
      results = [
        {
          content: '',
          tool_calls: [
            {
              id: null,
              // The device's drifted slot, verbatim.
              function: {
                name: 'lookup_history',
                arguments: '{"query":"sponsors","entity":"her"}',
              },
            },
          ],
        },
        {
          content:
            "I don't have the sponsor details for Coco in my memory right now, " +
            'but you can always ask your campmates or check Playa Info at ' +
            'Esplanade & 5:45.',
        },
      ];
    };

    it('THE RECEIPT: "who sponsored her?" looks up COCO, not "her"', async () => {
      const session = await fresh();
      const turn1 = await askWhoIsCoco(session);
      expect(turn1.cards).toEqual([cocoCard]);

      const executed = (executeTool as jest.Mock).mock.calls.length;
      sponsorsOfCocoNotFound();
      await session.chat('who sponsored her?');

      const call = (executeTool as jest.Mock).mock.calls[executed][0];
      expect(call.function).toEqual({
        name: 'lookup_history',
        arguments:
          '{"query":"sponsors","entity":"Coco","pack_id":"dusty-star-lore-25y"}',
      });
      // The executor is handed the exact graph identity too, so model-emitted
      // pronoun arguments and the deterministic pre-route share one antecedent.
      expect((executeTool as jest.Mock).mock.calls[executed][2]).toEqual(
        cocoPerson,
      );
    });

    it('THE RECEIPT, part two: the not-found close stays in the camp', async () => {
      const session = await fresh();
      await askWhoIsCoco(session);
      sponsorsOfCocoNotFound();
      const turn = await session.chat('who sponsored her?');

      expect(turn.text).toBe(
        "I don't have sponsorship records for Coco in the camp pack yet — " +
          "your campmates would know, and it's really theirs to tell.",
      );
      // The model's own close was TRUE and still wrong: Playa Info is a city
      // services desk and cannot answer camp lineage, for anyone, ever.
      expect(turn.text).not.toMatch(/Playa Info|Esplanade|5:45/);
      expect(turn.cards).toEqual([]);
    });

    it('asks deterministically when a history slot matches two exact people', async () => {
      const session = await fresh();
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"status":"ambiguous","query":"sponsors"}',
        cards: [],
        historyAmbiguity: {
          query: 'River Moon',
          candidates: [
            {
              pack_id: 'camp-a',
              id: 'person:river',
              name: 'River Moon',
            },
            {
              pack_id: 'camp-b',
              id: 'person:river',
              name: 'River Moon',
            },
          ],
        },
        shrink: async () => ({ json: '{}', cards: [] }),
      });
      results = [
        { content: 'I can answer without looking.' },
        { content: 'River Moon was sponsored by somebody.' },
      ];

      const turn = await session.chat('Who sponsored River Moon?');
      expect(turn.cards).toEqual([]);
      expect(turn.text).toBe(
        'There are 2 campers matching River Moon in your packs — ' +
          'River Moon (camp-a) and River Moon (camp-b). Which one?',
      );
    });

    it('a pronoun with NO prior person is left exactly as written', async () => {
      const session = await fresh();
      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'I could not find that.' }];
      await session.chat('who sponsored her?');

      // Today's path, byte for byte — including the not-found it produces.
      const call = (executeTool as jest.Mock).mock.calls[executed][0];
      expect(call.function.arguments).toBe('{"query":"sponsors","entity":"her"}');
      expect((executeTool as jest.Mock).mock.calls[executed][2]).toBeNull();
    });

    it('never rewrites a question that names its own person', async () => {
      const session = await fresh();
      await askWhoIsCoco(session);
      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'Records found.' }];
      await session.chat('Who sponsored River Moon?');
      expect(
        (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
      ).toBe('{"query":"sponsors","entity":"River Moon"}');
    });

    it('commits a graph identity only after its final history card survives', async () => {
      const session = await fresh();
      const blair = {
        pack_id: 'dusty-star-lore-25y',
        id: 'person:blair',
        name: 'Blair',
      };
      const lineage = {
        kind: 'lineage' as const,
        person: 'Blair',
        direction: 'sponsors' as const,
        relationships: [
          {
            from: 'Blair',
            to: 'Drew',
            year: 2014,
            pack_id: 'dusty-star-lore-25y',
            evidence_ref: 'history.md#blair-drew',
          },
        ],
      };
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"status":"cards_attached","query":"sponsors"}',
        cards: [lineage],
        shrink: async () => ({ json: '{}', cards: [lineage] }),
        resolvedPerson: blair,
      });
      results = [{ content: '' }, { content: 'Records found.' }];
      await session.chat('Who sponsored Blair?');

      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'Nothing recorded.' }];
      await session.chat('Who did they sponsor?');
      expect(
        (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
      ).toBe(
        '{"query":"sponsees","entity":"Blair","pack_id":"dusty-star-lore-25y"}',
      );
      expect((executeTool as jest.Mock).mock.calls[executed][2]).toEqual(blair);
    });

    it('clears an older anchor when equal-authority cards resolve two people', async () => {
      const session = await fresh();
      await askWhoIsCoco(session);
      const people = [
        {
          pack_id: 'dusty-star-lore-25y',
          id: 'person:blair',
          name: 'Blair',
        },
        {
          pack_id: 'dusty-star-lore-25y',
          id: 'person:river',
          name: 'River Moon',
        },
      ];
      const cards = people.map(person => ({
        kind: 'projects' as const,
        person: person.name,
        projects: [
          {
            name: `${person.name} Project`,
            year: 2023,
            pack_id: person.pack_id,
            evidence_ref: `history.md#${person.id}`,
          },
        ],
      }));
      for (let i = 0; i < people.length; i++) {
        (executeTool as jest.Mock).mockResolvedValueOnce({
          json: '{"status":"cards_attached"}',
          cards: [cards[i]],
          resolvedPerson: people[i],
          shrink: async () => ({
            json: '{"status":"cards_attached"}',
            cards: [cards[i]],
          }),
        });
      }
      results = [
        {
          content: '',
          tool_calls: people.map(person => ({
            function: {
              name: 'lookup_history',
              arguments: JSON.stringify({
                query: 'projects',
                entity: person.name,
              }),
            },
          })),
        },
        { content: 'I found both project records.' },
      ];
      await session.chat('Compare Blair and River Moon.');

      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'Nothing recorded.' }];
      await session.chat('who sponsored her?');
      expect(
        (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
      ).toBe('{"query":"sponsors","entity":"her"}');
      expect((executeTool as jest.Mock).mock.calls[executed][2]).toBeNull();
    });

    it('a new conversation drops the anchor — a pronoun there names nobody', async () => {
      const session = await fresh();
      await askWhoIsCoco(session);
      await session.newConversation();

      const executed = (executeTool as jest.Mock).mock.calls.length;
      results = [{ content: '' }, { content: 'Nothing found.' }];
      await session.chat('who sponsored her?');
      expect(
        (executeTool as jest.Mock).mock.calls[executed][0].function.arguments,
      ).toBe('{"query":"sponsors","entity":"her"}');
    });

    it('THE DISCRIMINATOR: a survival answer keeps its city referral', async () => {
      // Same empty-ish shape, different DOMAIN. Nothing in this turn proves a
      // camp-history absence, so the model's own words stand — and "check
      // Playa Info at Esplanade & 5:45" is a genuinely good answer to this.
      const session = await fresh();
      const answer =
        'Lost and found is at Playa Info, Esplanade & 5:45, open 9 am to 6 pm.';
      // grounding floor (2026-08-18): the factual question feeds the floor one
      // empty lookup and answers again post-lookup — and the model's words
      // STILL stand: nothing proved a camp-history absence, so no overwrite.
      (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
      results = [{ content: answer }, { content: answer }];
      const turn = await session.chat('where do I take something I found?');
      expect(turn.text).toBe(answer);
    });

    it('a camp-history ANSWER is never overwritten by an absence line', async () => {
      const session = await fresh();
      const lineage = {
        kind: 'lineage' as const,
        person: 'Blair',
        direction: 'sponsors' as const,
        relationships: [
          {
            from: 'Blair',
            to: 'Drew',
            year: 2014,
            pack_id: 'history',
            evidence_ref: 'history.md#blair-drew',
          },
        ],
      };
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"status":"cards_attached"}',
        cards: [lineage],
        sources: [
          {
            id: 'generic:1',
            pack: 'Generic Notes',
            doc: 'Blair',
            heading: 'Notes > Blair',
            passage: 'An unrelated lower-authority document passage.',
            memorial: false,
          },
        ],
        shrink: async () => ({ json: '{}', cards: [lineage] }),
        resolvedPerson: {
          pack_id: 'history',
          id: 'person:blair',
          name: 'Blair',
        },
      });
      results = [{ content: '' }, { content: 'Blair was sponsored in 2014.' }];
      const turn = await session.chat('Who sponsored Blair?');
      expect(turn.text).toBe('I found matching camp-history records below.');
      expect(turn.cards).toEqual([lineage]);
      expect(turn.sources).toEqual([]);
    });

    it('keeps person-card provenance when history cards share the turn', async () => {
      const session = await fresh();
      const lineage = {
        kind: 'lineage' as const,
        person: 'Coco',
        direction: 'sponsors' as const,
        relationships: [
          {
            from: 'Coco',
            to: 'Drew',
            year: 2014,
            pack_id: 'dusty-star-lore-25y',
            evidence_ref: 'history.md#coco-drew',
          },
        ],
      };
      const source = {
        id: 'dusty-star-lore-25y:42',
        pack: 'Dusty Star Memory Bank',
        doc: 'Who is Coco?',
        heading: 'Campers > Coco — Dusty Star camper > Who is Coco?',
        passage: cocoCard.summary,
        memorial: true,
      };
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: '{"status":"cards_attached"}',
        cards: [cocoCard, lineage],
        sources: [source],
        resolvedPerson: cocoPerson,
        shrink: async () => ({
          json: '{"status":"cards_attached"}',
          cards: [cocoCard, lineage],
          sources: [source],
        }),
      });
      results = [
        {
          content: '',
          tool_calls: [
            {
              function: {
                name: 'lookup_facts',
                arguments: '{"topic":"Coco"}',
              },
            },
          ],
        },
        { content: 'Coco had a sponsor.' },
      ];

      const turn = await session.chat('Show Coco and camp history together.');
      expect(turn.text).toBe("Here's what the camp remembers of Coco.");
      expect(turn.sources).toEqual([source]);
    });
  });

  describe('the echo guard (2026-08-18): a repeated final on a new question regenerates once', () => {
    const floorOutcome = () => ({
      json: '{"count":1}',
      cards: [],
      sources: [],
      shrink: async () => ({ json: '{}', cards: [], sources: [] }),
    });

    it('regenerates when the final equals the previous turn final verbatim', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }];
      await session.load('/m.gguf', () => {});
      // turn 1: grounded answer (floor feeds it)
      (executeTool as jest.Mock).mockResolvedValueOnce(floorOutcome());
      results = [
        { content: 'memory answer' },
        { content: 'It began in 1986 on Baker Beach.' },
      ];
      await session.chat('Where did Burning Man start?');
      // turn 2, DIFFERENT question: model echoes turn 1 verbatim, then answers
      (executeTool as jest.Mock).mockResolvedValueOnce(floorOutcome());
      results = [
        { content: 'memory answer' },
        { content: 'It began in 1986 on Baker Beach.' }, // the echo
        { content: 'Robot Heart is a sound camp famous for sunrise sets.' },
      ];
      const turn = await session.chat('what is robot heart');
      expect(turn.text).toBe('Robot Heart is a sound camp famous for sunrise sets.');
    });

    it('a repeated question may keep its answer — the guard needs a DIFFERENT question', async () => {
      const session = new LlamaSession(DEFAULT_PERSONA_ID);
      results = [{ content: '' }];
      await session.load('/m.gguf', () => {});
      (executeTool as jest.Mock).mockResolvedValueOnce(floorOutcome());
      results = [{ content: 'memory' }, { content: 'It began in 1986 on Baker Beach.' }];
      await session.chat('Where did Burning Man start?');
      (executeTool as jest.Mock).mockResolvedValueOnce(floorOutcome());
      results = [{ content: 'memory' }, { content: 'It began in 1986 on Baker Beach.' }];
      const turn = await session.chat('Where did Burning Man start?');
      expect(turn.text).toBe('It began in 1986 on Baker Beach.');
    });
  });

  describe('the grounding floor (2026-08-18): a factual no-tool answer is regenerated with passages', () => {
  it('drops the memory answer, forces lookup_facts on the question, and answers grounded', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    const guideSource = {
      id: 'survival-guide:9',
      pack: 'Survival Guide',
      doc: 'History',
      heading: 'Survival Guide > History',
      passage: 'Burning Man began on Baker Beach in 1986.',
      memorial: false,
    };
    (executeTool as jest.Mock).mockResolvedValueOnce({
      json: '{"count":1}',
      cards: [],
      sources: [guideSource],
      shrink: async () => ({ json: '{}', cards: [], sources: [guideSource] }),
    });
    results = [
      // round 0: the confabulation, NO tool call — the owner's session shape
      { content: 'Burning Man began in 1988 at the Reno County Fairgrounds.' },
      // after the forced lookup: the grounded answer
      { content: 'Burning Man began on Baker Beach in San Francisco in 1986.' },
    ];
    const turn = await session.chat('Where did Burning Man start?');
    // the confabulated round-0 text never reaches the user
    expect(turn.text).toBe('Burning Man began on Baker Beach in San Francisco in 1986.');
    expect(turn.answeredFrom).toBe('packs');
    expect(turn.sources).toEqual([guideSource]);
    const forced = (executeTool as jest.Mock).mock.calls[0][0];
    expect(forced.function.name).toBe('lookup_facts');
    expect(JSON.parse(forced.function.arguments).topic.toLowerCase()).toContain('burning man');
  });

  it('smalltalk is exempt — no forced lookup on a greeting', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    results = [{ content: 'Morning, dusty one!' }];
    const turn = await session.chat('good morning');
    expect(turn.text).toBe('Morning, dusty one!');
    expect(executeTool as jest.Mock).not.toHaveBeenCalled();
  });
});

  describe('raw-thread eviction (owner design 2026-08-18): oldest whole turns drop at the token budget', () => {
  it('a long thread keeps the newest turns and the system prompt; evicted turns leave no orphan tool messages', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    // Five turns, each with a fat floor payload (~7000 chars ≈ 1800 tokens):
    // budget 4000 fits ~2 such turns.
    const fat = 'x'.repeat(7000);
    for (let i = 0; i < 5; i++) {
      (executeTool as jest.Mock).mockResolvedValueOnce({
        json: JSON.stringify({ count: 1, passages: [{ text: fat }] }),
        cards: [],
        sources: [],
        shrink: async () => ({ json: '{}', cards: [], sources: [] }),
      });
      results = [{ content: '' }, { content: `answer ${i} about the playa` }];
      await session.chat(`factual question number ${i} about the playa?`);
    }
    const last = completions[completions.length - 1].messages;
    // newest turns retained; oldest evicted
    const users = last.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    expect(users[users.length - 1]).toBe('factual question number 4 about the playa?');
    expect(users).not.toContain('factual question number 0 about the playa?');
    expect(users.length).toBeLessThan(5);
    // structural integrity: every tool message follows an assistant with tool_calls
    last.forEach((m: any, i: number) => {
      if (m.role === 'tool') {
        expect(last[i - 1].role).toBe('assistant');
        expect(last[i - 1].tool_calls).toBeDefined();
      }
    });
    expect(last[0].role).toBe('system');
    expect(last.filter((m: any) => m.role === 'system')).toHaveLength(1);
  });
});

});

describe('fed-back tool-call turns carry their reasoning (KV-cache stability, 2026-08-17)', () => {
  it('the generated think rides on the fed-back assistant turn AND persists in the raw thread (KV prefix stays byte-identical across turns)', async () => {
    const completions: any[] = [];
    let results: any[] = [];
    const ctx = {
      completion: jest.fn(async (params: any) => {
        completions.push(JSON.parse(JSON.stringify(params)));
        return results.shift() ?? { content: '' };
      }),
      saveSession: jest.fn(async () => {}),
      loadSession: jest.fn(async () => {}),
      clearCache: jest.fn(async () => {}),
      stopCompletion: jest.fn(async () => {}),
      release: jest.fn(async () => {}),
    };
    (initLlama as jest.Mock).mockResolvedValue(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }];
    await session.load('/m.gguf', () => {});
    results = [
      {
        content: '',
        reasoning_content: 'water question -> lookup_facts',
        tool_calls: [{ id: null, function: { name: 'lookup_facts', arguments: '{"topic":"water"}' } }],
      },
      { content: '1.5 gallons a day.' },
    ];
    const base = completions.length;
    await session.chat('how much water');
    const round1 = completions[base + 1].messages;
    const fedBack = round1.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(fedBack.reasoning_content).toBe('water question -> lookup_facts');
    // Next turn: the raw thread replays the tool-call turn WITH its
    // reasoning — the whole point is a byte-identical prefix, so the phone
    // re-prefills nothing for retained history (owner design 2026-08-18;
    // the budget evicts whole turns when it must). Finals never carry
    // reasoning (they are written fresh from finalText).
    results = [{ content: 'Yes.' }];
    await session.chat('is that enough?');
    const next = completions[completions.length - 1].messages;
    const replayedToolCall = next.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(replayedToolCall.reasoning_content).toBe('water question -> lookup_facts');
    const finals = next.filter((m: any) => m.role === 'assistant' && !m.tool_calls);
    expect(finals.every((m: any) => m.reasoning_content === undefined)).toBe(true);
  });
});

describe('forced-final nudge (2026-08-17)', () => {
  // At the round cap the tools are withdrawn but the model was never TOLD;
  // LFM2.5 kept emitting tool grammar as text and the turn ended blank on
  // 10-12 of 31 battery cells (harness mirror). The last tool result now
  // carries one sentence saying the lookups are finished.
  it('nudgeLastToolMessage targets the LAST tool message, once, and is a no-op without one', () => {
    const msgs = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: '{"a":1}' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: '{"b":2}' },
    ];
    expect(nudgeLastToolMessage(msgs)).toBe(true);
    expect(msgs[3].content).toBe('{"a":1}');
    expect(msgs[5].content).toBe('{"b":2}' + FORCED_FINAL_NUDGE);
    expect(nudgeLastToolMessage(msgs)).toBe(true); // idempotent
    expect(msgs[5].content.split('[Angel:').length - 1).toBe(1);
    expect(nudgeLastToolMessage([{ role: 'user', content: 'u' }])).toBe(false);
  });

  it('the completion at the round cap sees the nudge on its last tool result; earlier rounds do not', async () => {
    const completions: any[] = [];
    let results: any[] = [];
    const ctx = {
      completion: jest.fn(async (params: any) => {
        completions.push(JSON.parse(JSON.stringify(params)));
        return results.shift() ?? { content: '' };
      }),
      saveSession: jest.fn(async () => {}),
      loadSession: jest.fn(async () => {}),
      clearCache: jest.fn(async () => {}),
      stopCompletion: jest.fn(async () => {}),
      release: jest.fn(async () => {}),
    };
    (initLlama as jest.Mock).mockResolvedValue(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});
    const call = (q: string) => ({
      content: '',
      tool_calls: [{ id: null, function: { name: 'search_events', arguments: JSON.stringify({ query: q }) } }],
    });
    // TOOL_ROUND_CAP tool rounds, then the forced final answers in prose.
    results = [
      ...Array.from({ length: TOOL_ROUND_CAP }, (_, i) => call(`burn ${i}`)),
      { content: 'The Man burns Saturday night.' },
    ];
    const base = completions.length;
    const turn = await session.chat('What night does the Man burn?');
    expect(turn.text).toBe('The Man burns Saturday night.');
    expect(turn.toolRounds).toBe(TOOL_ROUND_CAP);
    const rounds = completions.slice(base);
    expect(rounds).toHaveLength(TOOL_ROUND_CAP + 1);
    // Rounds before the cap: tools on, no nudge anywhere.
    for (const c of rounds.slice(0, TOOL_ROUND_CAP)) {
      expect(c.tool_choice).toBe('auto');
      expect(c.messages.some((m: any) => String(m.content).includes('[Angel:'))).toBe(false);
    }
    // The forced round: tools off, and exactly the LAST tool message ends with the nudge.
    const forced = rounds[TOOL_ROUND_CAP];
    // Forced completions KEEP the tool list (KV-cache-stable prefix, 2026-08-17)
    // and forbid calling via tool_choice 'none'.
    expect(forced.tools).toBeDefined();
    const toolMsgs = forced.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(TOOL_ROUND_CAP);
    expect(toolMsgs[toolMsgs.length - 1].content.endsWith(FORCED_FINAL_NUDGE)).toBe(true);
    for (const m of toolMsgs.slice(0, -1)) {
      expect(m.content.includes('[Angel:')).toBe(false);
    }
    // The persisted history is clean: the nudge never reaches the next turn.
    // grounding floor (2026-08-18): the factual follow-up feeds the floor one
    // empty lookup_facts and answers post-lookup; no round of it is nudged.
    (executeTool as jest.Mock).mockResolvedValueOnce(EMPTY_FLOOR_LOOKUP);
    results = [
      { content: '' }, // round 0 — discarded by the floor
      { content: 'Sunday.' },
    ];
    await session.chat('and the Temple?');
    const next = completions[completions.length - 1].messages;
    expect(next.some((m: any) => String(m.content).includes('[Angel:'))).toBe(false);
  });
});
