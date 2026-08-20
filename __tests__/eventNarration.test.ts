import { reconcileEventNarration } from '../src/llm/eventNarration';

describe('structured-event narration guard', () => {
  test.each([
    "I couldn't find any events matching that specific query.",
    'No matching events were found.',
    'There are no events scheduled for that.',
    "I don't have access to any events in the guide.",
  ])('replaces an absolute denial above real cards: %s', text => {
    expect(reconcileEventNarration(text, 5)).toBe(
      'I found 5 events in the offline guide.',
    );
  });

  test('uses singular count-aware copy', () => {
    expect(reconcileEventNarration('I cannot find any events.', 1)).toBe(
      'I found 1 event in the offline guide.',
    );
  });

  test('preserves qualified alternatives and positive narration', () => {
    const qualified =
      "I couldn't find Wednesday events, but I found these Thursday options.";
    expect(reconcileEventNarration(qualified, 3)).toBe(qualified);
    const positive = 'I found three sunrise yoga events for you.';
    expect(reconcileEventNarration(positive, 3)).toBe(positive);
  });

  test('preserves genuine zero-result narration', () => {
    const empty = 'No matching events were found.';
    expect(reconcileEventNarration(empty, 0)).toBe(empty);
  });
});
