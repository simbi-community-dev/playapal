import {
  historyToolArgs,
  historyToolPlans,
  shouldForceHistoryTool,
  splitClauses,
} from '../src/llm/historyIntent';

describe('structured history intent', () => {
  it.each([
    ['Which years did Riv attend?', { query: 'attendance', entity: 'Riv' }],
    ['Did River Moon attend in 2023?', { query: 'attendance', entity: 'River Moon', year: 2023 }],
    ['What projects did River Moon work on?', { query: 'projects', entity: 'River Moon' }],
    ['Who sponsored River Moon?', { query: 'sponsors', entity: 'River Moon' }],
    ['Who did Blair sponsor?', { query: 'sponsees', entity: 'Blair' }],
    ['Who was in the 2022 cohort?', { query: 'cohort', year: 2022 }],
    [
      'What is the sponsorship path between River and Drew?',
      { query: 'path', entity: 'River', target: 'Drew' },
    ],
  ])('fills enum-locked slots for %s', (text, expected) => {
    expect(historyToolArgs(text as string)).toEqual(expected);
  });

  it.each([
    'Which years did Riv attend?',
    'When did River Moon attend camp?',
    'Did River attend in 2023?',
    'Who sponsored River Moon?',
    'Show Blair sponsees',
    'What is the sponsorship lineage for River?',
    'Who was in the 2022 cohort?',
    'What projects did River work on?',
    "Show River's projects",
    'What is the connection between River and Drew?',
  ])('forces lookup_history for %s', text => {
    expect(shouldForceHistoryTool(text)).toBe(true);
  });

  it.each([
    'Who is River Moon?',
    'Tell me the story of the Shade Build',
    'What projects are happening today?',
    'Did it rain in 2023?',
    'What is the relationship between MOOP and Leave No Trace?',
    'What is happening at camp tonight?',
  ])('leaves non-relational routing to the model for %s', text => {
    expect(shouldForceHistoryTool(text)).toBe(false);
  });
});

/**
 * THE DEVICE RECEIPT (chat_log, 2026-08-16, owner testing): "Who is Coco"
 * rendered Coco's card, and the very next question — "who sponsored her?" —
 * filled entity:"her". No camper is named "her", so that lookup could only
 * come back not_found. The anchor is the person the app itself resolved one
 * turn earlier.
 */
describe('pronouns resolve to the session’s anchor', () => {
  it('THE RECEIPT: "who sponsored her?" is a question about Coco', () => {
    expect(historyToolArgs('who sponsored her?', 'Coco')).toEqual({
      query: 'sponsors',
      entity: 'Coco',
    });
  });

  it.each([
    ['who sponsored her?', { query: 'sponsors', entity: 'Coco' }],
    ['Who did she sponsor?', { query: 'sponsees', entity: 'Coco' }],
    ['Which years did they attend?', { query: 'attendance', entity: 'Coco' }],
    ['Did he attend in 2023?', { query: 'attendance', entity: 'Coco', year: 2023 }],
    ['What projects did they work on?', { query: 'projects', entity: 'Coco' }],
    ['projects by him', { query: 'projects', entity: 'Coco' }],
    ['sponsees of her', { query: 'sponsees', entity: 'Coco' }],
    ['Who was she sponsored by?', { query: 'sponsors', entity: 'Coco' }],
    [
      'What is the connection between her and Drew?',
      { query: 'path', entity: 'Coco', target: 'Drew' },
    ],
  ])('binds the slot in %s', (text, expected) => {
    expect(historyToolArgs(text as string, 'Coco')).toEqual(expected);
  });

  it('leaves the pronoun ALONE when the session has resolved nobody', () => {
    // The conservative contract: no anchor means today's path, byte for byte
    // — including the not-found this fix exists to explain.
    expect(historyToolArgs('who sponsored her?')).toEqual({
      query: 'sponsors',
      entity: 'her',
    });
    expect(historyToolArgs('who sponsored her?', null)).toEqual({
      query: 'sponsors',
      entity: 'her',
    });
  });

  it.each([
    ['Who sponsored River Moon?', { query: 'sponsors', entity: 'River Moon' }],
    ['Who did Blair sponsor?', { query: 'sponsees', entity: 'Blair' }],
    ['Who was in the 2022 cohort?', { query: 'cohort', year: 2022 }],
    [
      'What is the sponsorship path between River and Drew?',
      { query: 'path', entity: 'River', target: 'Drew' },
    ],
  ])('never rewrites a slot that names someone: %s', (text, expected) => {
    // A question that names its own people is unaffected by ANY anchor.
    expect(historyToolArgs(text as string, 'Coco')).toEqual(expected);
    expect(historyToolArgs(text as string, 'Coco')).toEqual(
      historyToolArgs(text as string),
    );
  });

  it('resolves one bare slot, never a phrase — this is not coreference', () => {
    // "her camp" is not "her": a phrase keeps its own words and then fails
    // the graph lookup on its own merits, which is the safe direction.
    expect(historyToolArgs('who sponsored her camp?', 'Coco')).toEqual({
      query: 'sponsors',
      entity: 'her camp',
    });
  });
});

describe('owner phone-test class (2026-08-17): compound sentences, sentence-local pronouns, tense variants', () => {
  // "Who is pug and who has he sponsored" matched nothing: every shape was
  // whole-string anchored, "who has X sponsored" was not a shape, and "he"
  // had no antecedent on a fresh session. It fell to the model, which called
  // lookup_history(query='pug'). These are the classes, not the question.
  test('compound: relational clause after "and", pronoun resolved to the earlier clause\'s topic', () => {
    expect(historyToolArgs('Who is pug and who has he sponsored', null)).toEqual({
      query: 'sponsees',
      entity: 'pug',
    });
    expect(historyToolArgs('Who is Coco, and who sponsored her?', null)).toEqual({
      query: 'sponsors',
      entity: 'Coco',
    });
    expect(historyToolArgs('tell me about Riv and which years did she attend', null)).toEqual({
      query: 'attendance',
      entity: 'Riv',
    });
  });

  test('a session anchor still wins over the sentence when both exist', () => {
    expect(historyToolArgs('who is pug and who has she sponsored', 'Coco')).toEqual({
      query: 'sponsees',
      entity: 'Coco',
    });
  });

  test('a pronoun with no antecedent anywhere stays unparsed (falls to ordinary routing)', () => {
    expect(historyToolArgs('what is MOOP and who has he sponsored', null)).toBeNull();
    // A lone pronoun clause keeps the pre-existing behavior (the pronoun is
    // passed through as typed; the lookup reports it absent).
    expect(historyToolArgs('who has he sponsored', null)).toEqual({ query: 'sponsees', entity: 'he' });
  });

  test('tense/aspect variants: subject position decides direction', () => {
    expect(historyToolArgs('who has pug sponsored', null)).toEqual({ query: 'sponsees', entity: 'pug' });
    expect(historyToolArgs('Whom did Pug sponsor?', null)).toEqual({ query: 'sponsees', entity: 'Pug' });
    expect(historyToolArgs('who did Pug bring in', null)).toEqual({ query: 'sponsees', entity: 'Pug' });
    expect(historyToolArgs('who has sponsored pug', null)).toEqual({ query: 'sponsors', entity: 'pug' });
    expect(historyToolArgs('who had been sponsoring Riv', null)).toEqual({ query: 'sponsors', entity: 'Riv' });
    expect(historyToolArgs('who brought in Coco?', null)).toEqual({ query: 'sponsors', entity: 'Coco' });
  });

  test('every pre-existing single-clause shape is untouched (whole string parses first)', () => {
    expect(historyToolArgs('who sponsored Riv', null)).toEqual({ query: 'sponsors', entity: 'Riv' });
    expect(historyToolArgs('who did Riv sponsor?', null)).toEqual({ query: 'sponsees', entity: 'Riv' });
    expect(historyToolArgs('sponsorship path between Riv and Coco', null)).toEqual({
      query: 'path',
      entity: 'Riv',
      target: 'Coco',
    });
    // "and" inside a path question is NOT a clause boundary (whole string first).
    expect(historyToolArgs('how are Riv and Coco connected', null)).toEqual({
      query: 'path',
      entity: 'Riv',
      target: 'Coco',
    });
  });

  test('keeps a single history clause as one plan', () => {
    expect(historyToolPlans('when did River Moon attend?')).toEqual([{
      args: { query: 'attendance', entity: 'River Moon' },
      rawUserText: 'when did River Moon attend?',
    }]);
  });

  test('plans every explicit history clause without greedy entity capture', () => {
    expect(historyToolPlans(
      'Who sponsored River Moon, and what projects did River Moon work on?',
    )).toEqual([
      {
        args: { query: 'sponsors', entity: 'River Moon' },
        rawUserText: 'Who sponsored River Moon',
      },
      {
        args: { query: 'projects', entity: 'River Moon' },
        rawUserText: 'what projects did River Moon work on',
      },
    ]);
  });

  test('plans every sentence-local pronoun against the preceding identity topic', () => {
    expect(historyToolPlans(
      'Who is Coco, who sponsored her, and what projects did she work on?',
    )).toEqual([
      {
        args: { query: 'sponsors', entity: 'Coco' },
        rawUserText: 'who sponsored her',
      },
      {
        args: { query: 'projects', entity: 'Coco' },
        rawUserText: 'what projects did she work on',
      },
    ]);
  });

  test('protects honorific periods without disabling real sentence boundaries', () => {
    expect(splitClauses('Tell me about Dr. Who')).toEqual([
      'Tell me about Dr. Who',
    ]);
    expect(splitClauses(
      'Tell me about Dr. Who. What projects did he work on?',
    )).toEqual([
      'Tell me about Dr. Who',
      'What projects did he work on',
    ]);
    expect(splitClauses('I met Coco. Who sponsored her?')).toEqual([
      'I met Coco',
      'Who sponsored her',
    ]);
  });
});
