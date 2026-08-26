/**
 * Routing-shaped tests for the deterministic tool dispatch: given the tool
 * call the model emits for a factual question ("how much water should I
 * bring" -> lookup_facts(topic='water')), assert the right executor runs
 * with the right shape. Executors are mocked — SQLite never loads.
 */

import { executeTool, LOOKUP_FACTS_TOP_N } from '../src/llm/toolExecutor';
import { searchEvents } from '../src/events/searchEvents';
import { searchDocs } from '../src/docs/searchDocs';
import { lookupFactsSemantic as lookupFacts } from '../src/facts/lookupFacts';
import { lookupHistory } from '../src/facts/historyLookup';
import type { ToolCall } from 'llama.rn';

jest.mock('../src/events/searchEvents', () => ({
  searchEvents: jest.fn(async () => ({
    results: [
      {
        id: 1,
        title: 'Sunrise Yoga',
        desc: '',
        day: 'Tuesday',
        date: '2026-09-01',
        time_start: '06:30',
        time_end: '07:30',
        camp: 'Camp Om',
        location: '7:30 & G',
      },
    ],
    state: 'matches',
    window: null,
    relation: 'unconstrained',
    strategy: 'fts-and',
  })),
  toolResultJson: jest.fn((o: any) => JSON.stringify({ count: o.results.length })),
}));

jest.mock('../src/docs/searchDocs', () => ({
  searchDocs: jest.fn(() => ({ results: [], strategy: 'none' })),
  docsResultJson: jest.fn((o: any) => JSON.stringify({ count: o.results.length })),
}));

jest.mock('../src/facts/historyLookup', () => ({
  HISTORY_QUERIES: ['attendance', 'projects', 'sponsors', 'sponsees', 'cohort', 'path'],
  lookupHistory: jest.fn(() => ({
    json: JSON.stringify({ status: 'cards_attached', query: 'attendance' }),
    cards: [
      {
        kind: 'attendance',
        person: 'River',
        years: [
          {
            year: 2023,
            pack_id: 'history',
            evidence_ref: 'history.md#river-2023',
          },
        ],
      },
    ],
  })),
}));

jest.mock('../src/facts/lookupFacts', () => {
  const outcome = {
    results: [
      { id: 1, pack_id: 'survival-guide', source_file: 'guide.md', heading: 'Survival > Water', content: '1.5 gallons per person per day.', pack_name: 'Survival Guide' },
      { id: 2, pack_id: 'survival-guide', source_file: 'guide.md', heading: 'Survival > Hydration', content: 'Drink before you are thirsty.', pack_name: 'Survival Guide' },
      { id: 3, pack_id: 'survival-guide', source_file: 'guide.md', heading: 'Survival > Ice', content: 'Ice is sold at Arctica.', pack_name: 'Survival Guide' },
    ],
    strategy: 'fts-and',
  };
  return {
    lookupFacts: jest.fn(() => outcome),
    // The executor's production path is the semantic twin; mock it to the
    // same fixture (the wiring contract itself is covered by
    // queryEmbedder.test.ts and semanticArm.test.ts).
    lookupFactsSemantic: jest.fn(async () => outcome),
    // Unscoped search_docs runs the specialty floors (2026-08-17); identity
    // here — the floor's own behavior is proven in campRetrieval.test.ts.
    withSpecialtyFloors: jest.fn((merged: any) => merged),
    factsResultJson: jest.fn((o: any) =>
      JSON.stringify({
        count: o.results.length,
        passages: o.results.map((c: any) => ({ heading: c.heading, text: c.content })),
      }),
    ),
  };
});

const call = (name: string, args: unknown): ToolCall => ({
  type: 'function' as const,
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

describe('executeTool routing', () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes a factual question's call to lookup_facts with the top-N budget (phone-latency tuning) and headings", async () => {
    const outcome = await executeTool(
      call('lookup_facts', { topic: 'water' }),
      'how much water should I bring',
    );
    expect(lookupFacts).toHaveBeenCalledWith({ topic: 'water' }, LOOKUP_FACTS_TOP_N);
    // 3 whole passages of the excerpt-budget-chunked guide (2026-08-17) cost
    // what 2 windowed 700-char excerpts did — the token budget, not the
    // count, is the phone-latency knob.
    expect(LOOKUP_FACTS_TOP_N).toBe(3);
    const parsed = JSON.parse(outcome.json);
    expect(parsed.count).toBe(3);
    expect(parsed.passages[0].heading).toBe('Survival > Water');
    // lookup_facts returns passages, never event cards.
    expect(outcome.cards).toEqual([]);
    expect(searchEvents).not.toHaveBeenCalled();
    expect(searchDocs).not.toHaveBeenCalled();
  });

  it('re-anchors the topic from the raw question (untrusted-hint, device-measured drop)', async () => {
    await executeTool(
      call('lookup_facts', { topic: 'classic car offered' }),
      'what classic car did Brook offer for the 2010 filming?',
    );
    expect(lookupFacts).toHaveBeenCalledWith(
      { topic: 'classic car offered Brook 2010' },
      LOOKUP_FACTS_TOP_N,
    );
  });

  it('shrink rebuilds lookup_facts with a smaller limit (context-overflow retry)', async () => {
    const outcome = await executeTool(
      call('lookup_facts', { topic: 'exodus' }),
      'when is exodus',
    );
    await outcome.shrink(2);
    expect(lookupFacts).toHaveBeenLastCalledWith({ topic: 'exodus' }, 2);
  });

  it('routes search_events with query + verbatim day word, returns structured rows', async () => {
    const outcome = await executeTool(
      call('search_events', { query: 'sunrise yoga', day: 'tomorrow' }),
      'any yoga tomorrow morning?',
    );
    expect(searchEvents).toHaveBeenCalledWith(
      { query: 'sunrise yoga', day: 'tomorrow' },
      'any yoga tomorrow morning?',
    );
    expect(outcome.cards).toHaveLength(1);
    expect(outcome.cards[0]).toMatchObject({
      kind: 'event',
      event: { title: 'Sunrise Yoga' },
    });
    expect(outcome.eventSearch).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      results: [{ id: 1 }],
    });
  });

  it.each([
    {
      state: 'not-run',
      results: [],
      window: null,
      reason: 'no-keywords-or-window',
      strategy: 'none',
    },
    {
      state: 'empty',
      results: [],
      window: null,
      searchedScope: 'all-enabled-events',
      strategy: 'none',
    },
  ])('preserves structured zero-result state: $state', async eventSearch => {
    (searchEvents as jest.Mock).mockResolvedValueOnce(eventSearch);
    const outcome = await executeTool(
      call('search_events', { query: '' }),
      'events',
    );
    expect(outcome.cards).toEqual([]);
    expect(outcome.eventSearch).toEqual(eventSearch);
  });

  it('turns the top passage into a person card when it is the camper the asker named', async () => {
    // The device receipt the card path exists for: routing and retrieval
    // both worked and the model still refused. The passage is a person card,
    // so the app answers instead of the prose.
    (lookupFacts as unknown as jest.Mock).mockResolvedValueOnce({
      results: [
        {
          id: 9,
          pack_id: 'dusty-star-lore-25y',
          source_file: 'people-dusty-star.md',
          heading:
            'Campers > Marisol Vega (Marisol) — Dusty Star camper > Who is Marisol Vega?',
          content:
            'Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads. Also appears on the list as Marisol.',
          pack_name: 'Dusty Star 25 Years',
        },
      ],
      strategy: 'fts-and',
      terms: ['marisol', 'camp'],
    });

    const outcome = await executeTool(
      call('lookup_facts', { topic: 'marisol from camp' }),
      'Who is Marisol from the camp',
    );

    expect(outcome.cards).toHaveLength(1);
    expect(outcome.cards[0]).toMatchObject({
      kind: 'person',
      name: 'Marisol Vega',
      alsoKnownAs: 'Marisol',
      tenure: { from: 'Mar 2010', to: 'Aug 2026' },
      memoriam: null,
    });
  });

  it('answers a named person with no passages as a KNOWABLE ABSENCE, not a shrug', async () => {
    // The empty-result half of the Coco failure: an identity question whose
    // lookup finds nothing must not leave the model a blank payload to
    // narrate over. It says, in words, that the packs do not cover her.
    (lookupFacts as unknown as jest.Mock).mockResolvedValueOnce({
      results: [],
      strategy: 'none',
    });

    const outcome = await executeTool(
      call('lookup_facts', { topic: 'Coco' }),
      'Who is Coco',
    );

    const parsed = JSON.parse(outcome.json);
    expect(parsed).toMatchObject({
      count: 0,
      passages: [],
      status: 'no_coverage',
      entity: 'Coco',
    });
    expect(parsed.instruction).toContain('Coco');
    expect(parsed.instruction).toMatch(/never describe, place, or guess/i);
    // The turn-level signal the honest close reads (LlamaSession.runTurn).
    expect(outcome.noCoverage).toBe('Coco');
    expect(outcome.cards).toEqual([]);
  });

  it('hands the passages back as tappable sources, in the packs’ own words', async () => {
    const outcome = await executeTool(
      call('lookup_facts', { topic: 'water' }),
      'how much water should I bring',
    );

    // Same passages, same rank order, capped for a one-handed glance.
    expect(outcome.sources).toHaveLength(3);
    expect(outcome.sources![0]).toMatchObject({
      id: 'survival-guide:1',
      pack: 'Survival Guide',
      doc: 'Water',
      heading: 'Survival > Water',
      passage: '1.5 gallons per person per day.',
      memorial: false,
    });
    expect(outcome.emptyLookup).toBe(false);
  });

  it('a knowable absence carries no sources and marks the empty lookup', async () => {
    (lookupFacts as unknown as jest.Mock).mockResolvedValueOnce({
      results: [],
      strategy: 'none',
    });

    const outcome = await executeTool(
      call('lookup_facts', { topic: 'ice' }),
      'where is ice',
    );

    expect(outcome.sources).toEqual([]);
    // The turn-level input for the honest close (LlamaSession.runTurn): a
    // lookup RAN and the packs carry nothing.
    expect(outcome.emptyLookup).toBe(true);
  });

  it('search_docs reaches the same card path and the same sources', async () => {
    // The model picks between search_docs and lookup_facts unreliably — the
    // whole reason identityIntent exists. A "who is" answer reached through
    // THIS tool is a card too, never bare prose.
    (searchDocs as unknown as jest.Mock).mockReturnValueOnce({
      results: [
        {
          id: 4,
          pack_id: 'dusty-star-lore-25y',
          source_file: 'people-dusty-star.md',
          heading:
            'Campers > Marisol Vega (Marisol) — Dusty Star camper > Who is Marisol Vega?',
          content:
            'Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads.',
          pack_name: 'Dusty Star 25 Years',
        },
      ],
      strategy: 'fts-and',
      terms: ['marisol'],
    });

    const outcome = await executeTool(
      call('search_docs', { query: 'marisol' }),
      'Who is Marisol from the camp',
    );

    expect(outcome.cards[0]).toMatchObject({ kind: 'person', name: 'Marisol Vega' });
    expect(outcome.sources![0]).toMatchObject({
      pack: 'Dusty Star 25 Years',
      doc: 'Who is Marisol Vega?',
      memorial: false,
    });
  });

  it('leaves an empty NON-identity lookup exactly as it is today', async () => {
    (lookupFacts as unknown as jest.Mock).mockResolvedValueOnce({
      results: [],
      strategy: 'none',
    });

    const outcome = await executeTool(
      call('lookup_facts', { topic: 'ice' }),
      'where is ice',
    );

    expect(JSON.parse(outcome.json)).toEqual({ count: 0, passages: [] });
    expect(outcome.noCoverage).toBeUndefined();
  });

  it('keeps the ordinary passage payload when a named person IS covered', async () => {
    const outcome = await executeTool(
      call('lookup_facts', { topic: 'pug' }),
      'Who is pug',
    );
    expect(JSON.parse(outcome.json).count).toBe(3);
    expect(JSON.parse(outcome.json).status).toBeUndefined();
    expect(outcome.noCoverage).toBeUndefined();
  });

  it('a free-text lookup_history query (not in the enum) becomes a search_docs over those words', async () => {
    // Owner phone 2026-08-17: lookup_history(query='shade structure',
    // entity='camp') twice, then an answer from nothing. The v4.0 model never
    // saw this tool in training and three sibling tools use `query` for
    // free text. The intent is a search; give it passages, not an error.
    (lookupHistory as jest.Mock).mockClear();
    const { searchDocs } = require('../src/docs/searchDocs');
    (searchDocs as jest.Mock).mockClear();
    const out = await executeTool(
      call('lookup_history', { query: 'shade structure', entity: 'camp' }) as any,
      'when did the camp build the big shade structure',
    );
    expect(lookupHistory).not.toHaveBeenCalled();
    // The words the model typed, both slots, ran through the docs search.
    expect((searchDocs as jest.Mock).mock.calls[0][0]).toEqual({ query: 'shade structure camp' });
    const json = JSON.parse(out.json);
    expect(json.note).toMatch(/searched the packs for "shade structure camp"/);
    expect(json).toHaveProperty('count');
  });

  it('a valid enum query still runs the graph lookup unchanged', async () => {
    (lookupHistory as jest.Mock).mockClear();
    await executeTool(call('lookup_history', { query: 'attendance', entity: 'River' }) as any, 'which years did River attend');
    expect(lookupHistory).toHaveBeenCalledWith({ query: 'attendance', entity: 'River' });
  });

  it('rewrites a model-emitted history pronoun to the exact pack-scoped identity', async () => {
    const anchor = {
      pack_id: 'identity-test',
      id: 'person:coco',
      name: 'Coco',
    };
    await executeTool(
      call('lookup_history', { query: 'sponsors', entity: 'her' }),
      'who sponsored her?',
      anchor,
    );
    expect(lookupHistory).toHaveBeenCalledWith({
      query: 'sponsors',
      entity: 'Coco',
      pack_id: 'identity-test',
    });
  });

  it('preserves exact history ambiguity for app-owned narration', async () => {
    const ambiguity = {
      query: 'River Moon',
      candidates: [
        { pack_id: 'camp-a', id: 'person:river', name: 'River Moon' },
        { pack_id: 'camp-b', id: 'person:river', name: 'River Moon' },
      ],
    };
    (lookupHistory as jest.Mock).mockReturnValueOnce({
      json: '{"status":"ambiguous"}',
      cards: [],
      ambiguity,
    });

    const outcome = await executeTool(
      call('lookup_history', {
        query: 'sponsors',
        entity: 'River Moon',
      }),
      'who sponsored River Moon?',
    );
    expect(outcome.historyAmbiguity).toEqual(ambiguity);
  });

  it('routes enum-locked history lookups and preserves app-owned cards on shrink', async () => {
    const args = { query: 'attendance', entity: 'River' };
    const outcome = await executeTool(
      call('lookup_history', args),
      'which years did River attend?',
    );

    expect(lookupHistory).toHaveBeenCalledWith(args);
    expect(outcome.cards).toEqual([
      {
        kind: 'attendance',
        person: 'River',
        years: [
          {
            year: 2023,
            pack_id: 'history',
            evidence_ref: 'history.md#river-2023',
          },
        ],
      },
    ]);
    await expect(outcome.shrink(2)).resolves.toEqual({
      json: outcome.json,
      cards: outcome.cards,
    });
  });

  it('parses string arguments and survives malformed JSON', async () => {
    await executeTool(call('lookup_facts', '{"topic":"MOOP"}'), "what's MOOP?");
    expect(lookupFacts).toHaveBeenCalledWith({ topic: 'MOOP' }, LOOKUP_FACTS_TOP_N);
    const outcome = await executeTool(
      call('lookup_facts', '{broken json'),
      'medical?',
    );
    expect(lookupFacts).toHaveBeenLastCalledWith({ topic: '' }, LOOKUP_FACTS_TOP_N);
    expect(outcome.cards).toEqual([]);
  });

  it('answers unknown tools with an error payload instead of crashing the turn', async () => {
    const outcome = await executeTool(call('summon_art_car', {}), 'hi');
    expect(JSON.parse(outcome.json).error).toContain('summon_art_car');
    expect(outcome.cards).toEqual([]);
  });
});
