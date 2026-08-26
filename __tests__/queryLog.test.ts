/**
 * The query log is a fold over chat_log rows. Every branch of that fold is
 * a claim about what a real turn looked like on the phone, so each case
 * below mirrors a row shape LlamaSession.ts actually writes (see the
 * logChat calls there): tool_call {name,args}, tool_result {name,
 * card_kinds, json}, and the lookup_person pre-route variant.
 */
import { foldQueries, summarize, type QueryLogRow } from '../src/log/queryLog';

let id = 0;
const row = (
  role: string,
  text: string,
  extra: Partial<QueryLogRow> = {},
): QueryLogRow => ({
  id: ++id,
  ts: `2026-08-30T12:00:${String(id).padStart(2, '0')}Z`,
  session_id: 's1',
  persona: 'angel',
  role,
  text,
  ...extra,
});

beforeEach(() => {
  id = 0;
});

describe('foldQueries', () => {
  test('a routed question that retrieved rows', () => {
    const rows = [
      row('system_note', 'persona: angel'),                     // pre-question chatter
      row('user', 'When does the Man burn?'),
      row('tool_call', JSON.stringify({ name: 'search_events', args: { query: 'man burn' } })),
      row('tool_result', JSON.stringify({ name: 'search_events', card_kinds: ['event'],
        json: { count: 1, events: [{ id: 7 }] } })),
      row('assistant', 'The Man burns Saturday night. Bring layers.', { ttft_ms: 2100, total_ms: 9800 }),
    ];
    const [q] = foldQueries(rows);
    expect(q).toMatchObject({
      question: 'When does the Man burn?',
      tools: [{ name: 'search_events', arg: 'man burn' }],
      retrieved: true,
      empty: false,
      untooled: false,
      answer_head: 'The Man burns Saturday night.',
      ttft_ms: 2100,
      total_ms: 9800,
    });
    expect(foldQueries(rows)).toHaveLength(1);
  });

  test('a routed question whose every tool came back EMPTY is the honest gap', () => {
    const rows = [
      row('user', 'who sponsored coco'),
      row('tool_call', JSON.stringify({ name: 'lookup_person', args: { topic: 'coco' } })),
      row('tool_result', JSON.stringify({ name: 'lookup_person', status: 'not_found', card_kinds: [] })),
      row('tool_call', JSON.stringify({ name: 'lookup_facts', args: JSON.stringify({ topic: 'coco' }) })),
      row('tool_result', JSON.stringify({ name: 'lookup_facts', card_kinds: [], json: { count: 0, passages: [] } })),
      row('assistant', "I don't have sponsorship records for Coco."),
    ];
    const [q] = foldQueries(rows);
    expect(q.tools.map(t => t.name)).toEqual(['lookup_person', 'lookup_facts']);
    // args arrive as an object OR a JSON string — both must name the topic
    expect(q.tools.map(t => t.arg)).toEqual(['coco', 'coco']);
    expect(q).toMatchObject({ retrieved: false, empty: true, untooled: false });
  });

  test('an untooled answer is neither retrieved nor empty', () => {
    const rows = [
      row('user', 'thanks!'),
      row('assistant', 'Any time. Stay hydrated out there.'),
    ];
    const [q] = foldQueries(rows);
    expect(q).toMatchObject({ retrieved: false, empty: false, untooled: true, tools: [] });
  });

  test('consecutive questions split correctly and a trailing question flushes', () => {
    const rows = [
      row('user', 'q1'),
      row('assistant', 'a1.'),
      row('user', 'q2'),
      row('tool_call', JSON.stringify({ name: 'search_docs', args: { query: 'x' } })),
      row('tool_result', JSON.stringify({ name: 'search_docs', card_kinds: [], json: { count: 2 } })),
      row('assistant', 'a2.'),
      row('user', 'q3 with no answer yet'),
    ];
    const qs = foldQueries(rows);
    expect(qs.map(q => q.question)).toEqual(['q1', 'q2', 'q3 with no answer yet']);
    expect(qs[1].retrieved).toBe(true);
    expect(qs[2].answer_head).toBe('');
  });

  test('unreadable tool rows do not crash the fold and count as empty', () => {
    const rows = [
      row('user', 'q'),
      row('tool_call', 'not json'),
      row('tool_result', '{broken'),
      row('assistant', 'a.'),
    ];
    const [q] = foldQueries(rows);
    expect(q.tools).toEqual([{ name: '?', arg: '' }]);
    expect(q).toMatchObject({ retrieved: false, empty: true });
  });
});

describe('summarize', () => {
  test('aggregates by tool, lists empties, and ranks repeated questions', () => {
    const mk = (question: string, session: string, tool?: string, count = 1) => {
      const rs = [row('user', question, { session_id: session })];
      if (tool) {
        rs.push(row('tool_call', JSON.stringify({ name: tool, args: { query: 'x' } }), { session_id: session }));
        rs.push(row('tool_result', JSON.stringify({ name: tool, card_kinds: [], json: { count } }), { session_id: session }));
      }
      rs.push(row('assistant', 'ok.', { session_id: session }));
      return rs;
    };
    const rows = [
      ...mk('Where is the temple?', 's1', 'search_docs', 3),
      ...mk('where is the Temple', 's2', 'search_docs', 3),   // same question, different case/punct
      ...mk('what is playa foot', 's2', 'lookup_facts', 0),  // empty
      ...mk('hi', 's3'),                                       // untooled
    ];
    const s = summarize(foldQueries(rows));
    expect(s.questions).toBe(4);
    expect(s.sessions).toBe(3);
    expect(s.untooled).toBe(1);
    expect(s.retrieved).toBe(2);
    expect(s.empty).toBe(1);
    expect(s.by_tool).toEqual({ search_docs: 2, lookup_facts: 1 });
    expect(s.empty_questions).toEqual(['what is playa foot']);
    expect(s.top_questions[0]).toEqual({ question: 'where is the temple', n: 2 });
  });
});
