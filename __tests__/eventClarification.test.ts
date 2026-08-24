import { eventClarificationQuery } from '../src/llm/eventClarification';

describe('event day clarification detection', () => {
  test('retains only event keywords after an explicit day request', () => {
    expect(
      eventClarificationQuery(
        'ok thanks now what about sunrise sets',
        "I don't have the full weekly schedule. Name a day and I can look.",
      ),
    ).toBe('sunrise sets');
  });

  test.each([
    ['what is MOOP?', 'Which day should I search?'],
    ['any sunrise sets?', 'I am not sure what you mean.'],
    ['what sets Hippo apart?', 'Tell me a day if you want.'],
  ])('does not arm for a non-event request or non-day answer', (user, assistant) => {
    expect(eventClarificationQuery(user, assistant)).toBeNull();
  });

  test('allows a day-only browse when the request has no search keywords', () => {
    expect(
      eventClarificationQuery(
        "what's happening?",
        'Which day are you interested in?',
      ),
    ).toBe('');
  });
});
