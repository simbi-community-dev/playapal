/**
 * Angel-over-the-board integration proof (doc 30 pilot §5): a REAL
 * LlamaSession turn with the REAL tool executor and REAL retrieval over a
 * REAL FTS5 database holding the survival guide + two board packs — only
 * the model itself is scripted. Verifies end-to-end that when the model
 * calls lookup_facts("offering bike tubes") the tool-result message it gets
 * back carries the beamed board (both authors, reply inline), and that the
 * two-turn assembly stays linear afterwards (no tool residue in turn 2).
 */

import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS, SURVIVAL_GUIDE_PACK_ID } from '../src/packs/builtins';
import {
  CAMP_WRITER_ID_KEY,
  exportCampBundle,
  installCampBundle,
  listCampBoard,
  saveCampProfile,
  upsertCampPost,
} from '../src/camp/campBoard';
import { LlamaSession } from '../src/llm/LlamaSession';
import { DEFAULT_PERSONA_ID } from '../src/llm/personas';
import { initLlama } from 'llama.rn';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...params);
      return { rows: undefined };
    },
  };
}

let mockConn: ReturnType<typeof makeConn>;

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  mkdir: jest.fn(async () => {}),
}));
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  identityAffiliationTerms: () => [],
  isFtsAvailable: () => true,
}));

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  const guidePack = BUILTIN_PACKS.find(p => p.manifest.id === SURVIVAL_GUIDE_PACK_ID)!;
  installPackFromFiles(mockConn as any, guidePack.files, { builtin: true });

  // This phone (Maria) offers tubes; Ben's beamed board replies to the offer.
  mockConn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    'aaaa1111',
  ]);
  saveCampProfile(mockConn as any, { authorName: 'Maria', passphrase: 'dusty mary' });
  upsertCampPost(mockConn as any, {
    type: 'offer',
    text: '3 spare bike tubes at the dome',
  });

  const ben = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    ben.execute(sql);
  }
  ben.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    'bbbb2222',
  ]);
  saveCampProfile(ben as any, { authorName: 'Ben', passphrase: 'dusty mary' });
  installCampBundle(ben as any, exportCampBundle(mockConn as any));
  const tubes = listCampBoard(ben as any).find(p => p.text.includes('tubes'))!;
  upsertCampPost(ben as any, {
    type: 'offer',
    text: 'took one, thanks!',
    ref_id: tubes.id,
  });
  installCampBundle(mockConn as any, exportCampBundle(ben as any));

  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

describe('the Angel answers a board question from beamed board data', () => {
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

  beforeAll(async () => {
    (initLlama as jest.Mock).mockResolvedValue(ctx);
  });

  it('feeds the board back through lookup_facts, thread and authors attributed', async () => {
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    results = [{ content: '' }]; // warm-up
    await session.load('/m.gguf', () => {});

    // Turn 1: the demo question. The scripted model routes to lookup_facts;
    // everything downstream of that call is REAL (executor -> searchDocs ->
    // FTS5 over the board packs) — the assertion is on what the pipeline
    // actually returned to the model.
    results = [
      {
        content: '',
        tool_calls: [
          {
            id: null,
            function: {
              name: 'lookup_facts',
              arguments: '{"topic":"offering bike tubes"}',
            },
          },
        ],
      },
      {
        content: 'Maria has spare bike tubes at the dome — one already claimed. 🚲',
      },
    ];
    const turn1 = await session.chat('anyone offering bike tubes?');
    expect(turn1.text).toMatch(/bike tubes/);

    // completions: [0]=warm-up, [1]=turn1 round1, [2]=turn1 round2.
    expect(completions).toHaveLength(3);
    const round2 = completions[2].messages;
    expect(round2.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    // THE integration proof: real retrieval put the board — offer, author,
    // and the beamed reply thread — into the model's tool result.
    const toolMsg = round2[3].content as string;
    expect(toolMsg).toContain('offering: 3 spare bike tubes at the dome (Maria)');
    expect(toolMsg).toContain('reply: took one, thanks! (Ben)');

    // Turn 2: follow-up stays linear — no tool residue from turn 1.
    // grounding floor (2026-08-18): the factual follow-up's round-0 no-tool
    // answer is discarded; the floor forces a REAL lookup_facts over the
    // board packs, then the scripted final lands. Turn 1's tool messages
    // still never leak — the only tool message is the floor's own.
    results = [
      { content: 'Just head over.' }, // round 0 memory answer — discarded
      { content: 'Head for the dome and ask for Maria.' },
    ];
    const turn2Result = await session.chat('where do I get one?');
    expect(turn2Result.text).toBe('Head for the dome and ask for Maria.');
    expect(completions).toHaveLength(5);
    const turn2 = completions[4].messages;
    // raw thread (2026-08-18): turn 1's board lookup replays whole — the
    // model can still SEE Maria's offer and Ben's reply while answering the
    // follow-up, which is exactly why "where do I get one?" is answerable.
    expect(turn2.map((m: any) => m.role)).toEqual([
      'system',
      'user',       // anyone offering bike tubes?
      'assistant',  // turn-1 lookup_facts call
      'tool',       // the REAL board retrieval (Maria, Ben's reply)
      'assistant',  // turn-1 final
      'user',       // where do I get one?
      'assistant',  // floor's forced lookup_facts
      'tool',       // its result
    ]);
    expect(turn2[4].content).toMatch(/bike tubes/); // turn-1 final replayed
    expect(turn2[3].content).toContain('offering: 3 spare bike tubes at the dome (Maria)');
    expect(turn2[6].tool_calls[0].function.name).toBe('lookup_facts');
  });
});
