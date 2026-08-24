/**
 * The person-identity pre-route's matching rule, pinned question by question.
 *
 * THE MEASURED CASES (chat_log receipts, 2026-08-16, v3.0, fresh sessions):
 * "Who is pug" and "Who is Marisol from the camp" routed to lookup_facts and
 * answered; "Who is Coco" made NO tool call and invented "a camp located in
 * the 9:00 sector of Black Rock City" for a dead, memorialized camper. All
 * three now fill the same slots deterministically.
 *
 * The negative controls carry the weight: every question shape the app
 * already answers correctly must come back null, because null is the no-op.
 */

import {
  identityName,
  identityToolArgs,
  shouldForceIdentityTool,
} from '../src/llm/identityIntent';

const AFFILIATIONS = ['Dusty Star', 'Robot Heart'];

describe('person-identity intent', () => {
  it.each([
    // The three device receipts.
    ['Who is pug', { topic: 'pug' }],
    ['Who is Marisol from the camp', { topic: 'Marisol' }],
    ['Who is Coco', { topic: 'Coco' }],
    // The rest of the declared shapes.
    ["who's Coco?", { topic: 'Coco' }],
    ['Who was AJM?', { topic: 'AJM' }],
    ['who is marisol from dusty star', { topic: 'marisol' }],
    ['Who is Bob from Robot Heart?', { topic: 'Bob' }],
    ['Who is Coco on the camp list?', { topic: 'Coco' }],
    ['Tell me about River Moon.', { topic: 'River Moon' }],
    ['tell me more about pug', { topic: 'pug' }],
    ['What do you know about Coco?', { topic: 'Coco' }],
    // A name is allowed the punctuation real names carry.
    ['Who is David T. Anderson', { topic: 'David T. Anderson' }],
    ["who is O'Ryan", { topic: "O'Ryan" }],
    // historyIntent explicitly leaves this one to the model; the identity
    // router is the one that now claims it.
    ['Who is River Moon?', { topic: 'River Moon' }],
  ])('fills the lookup_facts slot for %s', (text, expected) => {
    expect(identityToolArgs(text as string, null, AFFILIATIONS)).toEqual(expected);
    expect(shouldForceIdentityTool(text as string, null, AFFILIATIONS)).toBe(true);
  });

  it.each([
    // EVENTS — the nudge's own "what is happening" class, untouched.
    'What is happening at camp tonight?',
    'what is happening tonight',
    'who is playing tonight',
    'who is playing',
    'who is cooking dinner',
    'who is djing at center camp',
    // LOGISTICS — never an identity question.
    'where is ice',
    'tell me about ice',
    'what do you know about water',
    'tell me about the 10 principles',
    'what is MOOP?',
    // RELATIONAL — historyIntent is the more specific router and owns these.
    'Who sponsored River Moon?',
    'Who did Blair sponsor?',
    'Who was River sponsored by?',
    'Who was in the 2022 cohort?',
    'Which years did Riv attend?',
    'What projects did River Moon work on?',
    'What is the sponsorship path between River and Drew?',
    // ROLES, not names.
    'who is the camp lead',
    'who is Robot Heart',
    'who is the guy from Reno',
    'who is everyone else',
    // Shapes that only look like the declared ones.
    'whose bike is this',
    'who founded the camp?',
    'why is the gate closed',
  ])('leaves %s on today’s path', text => {
    expect(identityToolArgs(text, null, AFFILIATIONS)).toBeNull();
    expect(shouldForceIdentityTool(text, null, AFFILIATIONS)).toBe(false);
  });
});

describe('conservative name extraction', () => {
  it.each([
    ['Marisol from the camp', 'Marisol'],
    ['Marisol from camp', 'Marisol'],
    ['Marisol from dusty star', 'Marisol'],
    ['Marisol in our camp', 'Marisol'],
    ['Marisol on the camp list', 'Marisol'],
    ['Marisol of the dusty star camp', 'Marisol'],
    ['Bob from Robot Heart', 'Bob'],
    ['Bob in our Robot Heart camp', 'Bob'],
  ])('strips the affiliation trailer from %s', (slot, expected) => {
    expect(identityName(slot, AFFILIATIONS)).toBe(expected);
  });

  it('refuses anything it cannot confidently read as a name', () => {
    for (const slot of [
      '', // nothing left after the shape
      'the lead', // a role, headed by a determiner
      'going to be at the temple tonight', // a phrase, not a name
      'camper 42', // digits are never a name
      'n o', // 1-2 char names cannot engage a person card anyway
      'the 2022 cohort',
    ]) {
      expect(identityName(slot)).toBeNull();
    }
  });

  it('keeps a name of up to three tokens and no more', () => {
    expect(identityName('River Moon')).toBe('River Moon');
    expect(identityName('Alex J Mercer')).toBe('Alex J Mercer');
    expect(identityName('Alex J Mercer junior senior')).toBeNull();
  });
});

/**
 * The identity half of the session anchor. "Who is Coco" renders her card;
 * the follow-up may name her with a pronoun, and the app already knows who
 * that is — it did the resolving itself, one turn ago.
 */
describe('identity questions resolve pronouns against the anchor', () => {
  it.each([
    'who is she?',
    'Who is she',
    'who was he',
    "who's she?",
    'Tell me about her.',
    'tell me more about them',
    'What do you know about him?',
  ])('reads %s as a question about the anchored person', text => {
    expect(identityToolArgs(text, 'Coco')).toEqual({ topic: 'Coco' });
    expect(shouldForceIdentityTool(text, 'Coco')).toBe(true);
  });

  it('stays null with no anchor — a pronoun names nobody on its own', () => {
    // Unchanged behaviour: 'her' is a NOT_A_NAME word and always was, so a
    // fresh session runs exactly as it does today.
    expect(identityToolArgs('who is she?')).toBeNull();
    expect(identityToolArgs('Tell me about her.')).toBeNull();
    expect(shouldForceIdentityTool('who is she?')).toBe(false);
  });

  it('resolves a BARE pronoun only, never a phrase that contains one', () => {
    expect(identityToolArgs('tell me about her camp', 'Coco')).toBeNull();
    expect(identityToolArgs('who is their lead', 'Coco')).toBeNull();
  });

  it('still yields to the relational router, which reads the same anchor', () => {
    // "who sponsored her" is lookup_history's shape with the anchor bound
    // exactly as it is without one — the two pre-routes never both claim a
    // turn.
    expect(identityToolArgs('who sponsored her?', 'Coco')).toBeNull();
    expect(identityToolArgs('who sponsored her?')).toBeNull();
  });

  it('never lets an anchor rewrite a question that names someone', () => {
    expect(identityToolArgs('Who is Marisol from the camp', 'Coco')).toEqual({
      topic: 'Marisol',
    });
    expect(identityToolArgs('where is ice', 'Coco')).toBeNull();
    expect(identityToolArgs('who is playing tonight', 'Coco')).toBeNull();
  });
});
