/**
 * The grounding floor: a factual turn may not end as an unsourced memory
 * answer (owner's Pixel session 2026-08-18 — ten consecutive no-tool answers
 * in one thread, "Reno County Fairgrounds" confabulated and once falsely
 * attributed to the Survival Guide). Helpers tested directly; the forced-call
 * mechanics ride the same machinery as the relational floor.
 */
import { isFactualTurn, groundingTopic } from '../src/llm/groundingFloor';

describe('isFactualTurn — everything is factual except unmistakable smalltalk', () => {
  it.each([
    // the owner's actual session turns, verbatim
    'Who are the founders of burning man',
    'What year did Burning Man start',
    'Where did Burning Man start?',
    'How do I secure my tent in the wind?',
    'What about lag bolts',
    'When does the temple burn',
    'Where can I get ice',
    'How large is the playa?',
    'What is black rock Desert',
    'So does it take place at the fairgrounds or in the desert',
    'what is robot heart',
    'What is yoga?',
    'Who founded Sunrise Movement?',
    'What role did music play at early Burning Man?',
    'Tell me a little about MOOP',
    'Write the emergency phone number',
    'Say where I can get ice',
    'Write a haiku and tell me the emergency phone number',
    'Write a haiku; tell me the emergency phone number',
    'Write the emergency phone number and a haiku',
    'Write a haiku and make it funny, then tell me the emergency phone number',
    'Write a haiku. Tell me the emergency phone number.',
    'Write a haiku and the emergency phone number',
  ])('fires: %s', q => expect(isFactualTurn(q)).toBe(true));

  it.each([
    'hi', 'hey!', 'thanks', 'thank you!', 'ok', 'cool', 'good morning', 'gm',
    'lol', 'yes', 'nope', '', 'say something poetic', 'write a haiku',
    'tell me a story', 'write a haiku and make it funny',
    'write a poem and tell me a story', 'write a funny, short haiku',
  ])(
    'exempt: %s',
    q => expect(isFactualTurn(q)).toBe(false),
  );

  it('a question mark always fires, even short', () => {
    expect(isFactualTurn('ice?')).toBe(true);
  });
});

describe('groundingTopic — the question minus interrogative scaffolding', () => {
  it.each([
    ['Where did Burning Man start?', 'did Burning Man start'],
    ['what is robot heart', 'is robot heart'],
    ['When does the temple burn', 'does the temple burn'],
  ])('%s -> keeps the nouns', (q, _unused) => {
    const topic = groundingTopic(q);
    // the load-bearing property: content nouns survive
    for (const noun of q.toLowerCase().match(/burning man|robot heart|temple|tent|ice/g) ?? []) {
      expect(topic.toLowerCase()).toContain(noun);
    }
    expect(topic.length).toBeGreaterThan(3);
  });
});
