import {
  isNoToolFailure,
  refersToPriorFailure,
} from '../src/llm/inferenceHistory';

describe('no-tool inference failure classification', () => {
  test.each([
    "I don't know who that is.",
    "I don't have access to the full weekly schedule.",
    "I can't find anything about Ruckus in my guides.",
    'I could not locate that information.',
    "I'm not sure.",
    'I have no information about that person.',
  ])('marks a compact no-tool inability: %s', text => {
    expect(isNoToolFailure(text, 0)).toBe(true);
  });

  test('does not mark tool-backed, substantive, empty, or long answers', () => {
    expect(isNoToolFailure("I couldn't find matching events.", 1)).toBe(false);
    expect(isNoToolFailure('Ruckus is Mark Lehmann.', 0)).toBe(false);
    expect(isNoToolFailure('', 0)).toBe(false);
    expect(isNoToolFailure(`I don't know. ${'More context. '.repeat(30)}`, 0))
      .toBe(false);
  });
});

describe('prior-failure meta follow-ups', () => {
  test.each([
    "why couldn't you find it?",
    'what do you mean?',
    'your answer was odd',
    'try it again',
  ])('retains prior failure for: %s', text => {
    expect(refersToPriorFailure(text)).toBe(true);
  });

  test('a repeated or new factual question is not a meta follow-up', () => {
    expect(refersToPriorFailure('who is Ruckus?')).toBe(false);
    expect(refersToPriorFailure('who is Coco?')).toBe(false);
  });
});
