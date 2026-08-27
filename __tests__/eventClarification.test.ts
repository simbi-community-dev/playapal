import {
  eventClarificationQuery,
  eventSearchQuery,
  isEventRequest,
  shouldRouteEventSearch,
  splitEventClauses,
} from '../src/llm/eventClarification';

describe('event day clarification detection', () => {
  test('retains only event keywords after an explicit day request', () => {
    expect(
      eventClarificationQuery(
        'ok thanks now what about sunrise sets',
        "I don't have the full weekly schedule. Name a day and I can look.",
      ),
    ).toEqual({
      query: 'sunrise sets',
      rawUserText: 'ok thanks now what about sunrise sets',
    });
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
    ).toEqual({
      query: '',
      rawUserText: "what's happening?",
    });
  });

  test.each([
    ["what's happening at camp tonight?", true],
    ['music tonight', true],
    // Binding review C4: `shows?` matched the imperative verb "show" and
    // sent the commonest browse imperative into the collection branch,
    // whose head grammar then refused it; the article/adjective slot is
    // the same finding's verified secondary gap.
    ['show me yoga', true],
    ['find me a dance party', true],
    ['any good parties', true],
    // codex closure measurements on C4: the polite auxiliary prefix.
    ['can you show me sunrise yoga', true],
    ['would you show me yoga', true],
    ['sunrise sets Tuesday', true],
    ['Where is Sunrise Yoga Friday?', true],
    ['What events are Friday?', true],
    ['What is the schedule for Friday?', true],
    ['What is yoga Friday?', true],
    ['What events?', true],
    ['Find workshops', true],
    ['What classes are offered?', true],
    ['When are the workshops?', true],
    ['Where are the classes?', true],
    ['Find pottery workshops', true],
    ['What workshops can I join?', true],
    ['events for kids', true],
    ['concerts featuring jazz', true],
    ['What events happen at camp?', true],
    ['Can you show me events?', true],
    ['When is the first-aid class?', true],
    ['Where is the activity?', true],
    ['What time is the show?', true],
    ['What is yoga?', false],
    ['What is the schedule?', false],
    ['What is an event?', false],
    ['What is a consent workshop?', false],
    ['When was the first yoga workshop founded?', false],
    ['Where did Sunrise Movement begin?', false],
    ['Who founded Sunrise Movement?', false],
    ['What events shaped early Burning Man?', false],
    ["What music events shaped the city's history?", false],
    ['What are the event safety rules?', false],
    ['What is this consent workshop about?', false],
    ['Explain the first-aid class', false],
    ['what was the party vibe like in 2019?', false],
    ['Show me the bike rules', false],
  ])('separates deterministic event routing for %s', (text, expected) => {
    expect(shouldRouteEventSearch(text)).toBe(expected);
  });

  // The C4 widening's own blast radius (binding re-review measured 21 of
  // 26 newly-routing strings to be ordinary talk). Each of these turns a
  // forced search's EMPTY result into app-voice authority if it routes.
  test.each([
    'no music please',
    'no dinner for me',
    'avoid parties',
    'skip breakfast',
    'cancel dinner',
    'my dance teacher is great',
    'the burn barrel is out back',
    'our dinner was burnt',
    'her yoga mat is missing',
    'the sunrise was beautiful',
    'my swim trunks are wet',
    'that dance was wild',
    'this swim is cold',
    'the dinner bell rang',
    'a party foul',
    'some music theory',
    'great music!',
    'what dinner is best',
  ])('ordinary talk carrying an activity noun does not route: %s', text => {
    expect(shouldRouteEventSearch(text)).toBe(false);
  });

  test('keeps broad domain hints separate from deterministic routing', () => {
    expect(isEventRequest('tell me about music')).toBe(true);
    expect(shouldRouteEventSearch('tell me about music')).toBe(false);
  });

  test.each([
    ['Show me yoga Friday', 'yoga'],
    ['Find sunrise workshops Tuesday', 'sunrise'],
    ['Show concerts Friday', 'concerts'],
    ['What classes are offered?', 'classes'],
    ['Find pottery workshops', 'pottery'],
    [
      'Please search the guide: what events, activities, classes, or workshops include sunrise yoga Tuesday',
      'sunrise yoga',
    ],
  ])('removes event request shells before the semantic cap: %s', (text, query) => {
    expect(eventSearchQuery(text)).toBe(query);
  });

  test('plans elliptical weekdays as separate event authorities', () => {
    expect(splitEventClauses('What events are Friday and Saturday?')).toEqual({
      eventClauses: ['What events are Friday', 'Saturday'],
      otherClauses: [],
    });
  });

  test('never cuts a coordinator inside a named title span (binding review C2)', () => {
    // The session supplies enabled-title spans; here a fake provider marks
    // "Sock puppet workshop and karaoke" wherever it appears. Without the
    // protection this dismembered into two searches that returned two
    // DIFFERENT events as authoritative cards (measured on the bundled
    // pack: 'Sock Puppet Crafting' + 'Karaoke!', neither the named event).
    const TITLE = 'Sock puppet workshop and karaoke';
    const spans = (text: string) => {
      const at = text.indexOf(TITLE);
      return at >= 0 ? [{ start: at, end: at + TITLE.length }] : [];
    };
    expect(
      splitEventClauses(`when is ${TITLE}`, () => true, spans),
    ).toEqual({
      eventClauses: [`when is ${TITLE}`],
      otherClauses: [],
    });
    // A coordinator OUTSIDE the span still splits.
    expect(
      splitEventClauses(`when is ${TITLE} and Saturday`, () => true, spans),
    ).toEqual({
      eventClauses: [`when is ${TITLE}`, 'Saturday'],
      otherClauses: [],
    });
  });

  test('re-joins a title that splitClauses itself cut (codex closure on C2)', () => {
    // CLAUSE_SPLIT (the history-intent splitter) runs BEFORE the
    // coordinator shield and cut "Cum and Make Sum Noise" at its own
    // 'and' — measured on the bundled pack: the two halves searched for
    // events the camper never named. Parts a title span straddles are
    // re-joined from the original text.
    const TITLE = 'Cum and Make Sum Noise';
    const spans = (text: string) => {
      const at = text.indexOf(TITLE);
      return at >= 0 ? [{ start: at, end: at + TITLE.length }] : [];
    };
    expect(
      splitEventClauses(`when is ${TITLE}`, () => true, spans),
    ).toEqual({
      eventClauses: [`when is ${TITLE}`],
      otherClauses: [],
    });
  });

  test.each([
    [
      'What events are Friday, Saturday?',
      ['What events are Friday', 'Saturday'],
    ],
    [
      'What events are Friday or Saturday?',
      ['What events are Friday', 'Saturday'],
    ],
    [
      'Show yoga Friday and Saturday morning',
      ['Show yoga Friday', 'Saturday morning'],
    ],
    [
      'Show yoga Friday or Saturday at 9pm',
      ['Show yoga Friday', 'Saturday at 9pm'],
    ],
  ])('splits temporal-only coordinated authorities in %s', (text, eventClauses) => {
    expect(splitEventClauses(text)).toEqual({
      eventClauses,
      otherClauses: [],
    });
  });

  test('does not promote a factual clause merely because its suffix has a day', () => {
    expect(splitEventClauses(
      'Where can I get ice Friday or Saturday morning?',
    )).toEqual({
      eventClauses: [],
      otherClauses: ['Where can I get ice Friday', 'Saturday morning'],
    });
  });

  test('accepts a title-aware routing predicate for exact-title lists', () => {
    const titles = new Set(['Morning Coffee', 'Night Swim', 'Tea &amp; Tarot']);
    const routesTitle = (text: string) => [...titles].some(title => text.includes(title));
    expect(splitEventClauses(
      'When are Morning Coffee, Night Swim, and Tea &amp; Tarot?',
      routesTitle,
    )).toEqual({
      eventClauses: ['When are Morning Coffee', 'Night Swim', 'Tea &amp; Tarot'],
      otherClauses: [],
    });
  });

  test('splits coordinated event activities with separate days', () => {
    expect(splitEventClauses('Show yoga Friday and music Saturday')).toEqual({
      eventClauses: ['Show yoga Friday', 'music Saturday'],
      otherClauses: [],
    });
  });

  test('splits coordinated named-event shapes with separate days', () => {
    expect(splitEventClauses(
      'When is Morning Coffee Friday and Night Swim Saturday?',
    )).toEqual({
      eventClauses: ['When is Morning Coffee Friday', 'Night Swim Saturday'],
      otherClauses: [],
    });
  });

  test('keeps unrelated factual clauses outside the event plan', () => {
    expect(splitEventClauses(
      'What events are Friday, and what events are Saturday, and where can I get ice?',
    )).toEqual({
      eventClauses: ['What events are Friday', 'what events are Saturday'],
      otherClauses: ['where can I get ice'],
    });
    expect(splitEventClauses(
      'What events are Friday, and where can I get ice today?',
    )).toEqual({
      eventClauses: ['What events are Friday'],
      otherClauses: ['where can I get ice today'],
    });
  });

  test('does not arm a factual activity clarification', () => {
    expect(eventClarificationQuery(
      'What about music history?',
      'Which day should I search?',
    )).toBeNull();
  });
});
