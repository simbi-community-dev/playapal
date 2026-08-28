/**
 * @-mentions (src/crews/mentions.ts) — the matcher both ends of the
 * feature depend on: the composer offering podmates, and the arrival seam
 * deciding whether a message earns the loud buzz.
 *
 * WHY EVERY ONE OF THESE MATTERS OUT THERE. The failure mode is not a
 * crash, it is a phone that buzzes for someone else's business — or worse,
 * one that stays silent when a podmate typed your name. Neither is
 * debuggable at camp, and both erode the one thing a notification has:
 * being worth looking at.
 *
 * THE FOUR RULES, each pinned to the mutation it dies on:
 *  - LONGEST FIRST: a pod holding "Kupo" and "Kupo Two" must not buzz
 *    Kupo for every message to Kupo Two.
 *  - WORD BOUNDARY, BOTH ENDS: '@' inside a word is an address, and a
 *    name followed by more letters is a different word.
 *  - CASE-INSENSITIVE: nobody capitalises correctly in a dust storm.
 *  - THE SIGIL IS REQUIRED: a name in a sentence is a sentence.
 *
 * Pure text in, pure text out — no mocks, because there is nothing here to
 * mock. Names come from other people's phones, so a name made of regex
 * metacharacters is one of the cases.
 *
 * PLANTED AND MEASURED, 2026-08-26 — each rule was broken on purpose and
 * this suite watched go red, then reverted:
 *
 *   longest-first sort dropped         2 failed (here AND in pocketAlerts)
 *   leading word boundary dropped      1 failed  (mail@kupo buzzes Kupo)
 *   trailing word boundary dropped     1 failed  (@Kupolicious does)
 *   case fold dropped                  2 failed  (@kupo names nobody)
 *   blank-name filter dropped          1 failed  (every '@' is a mention)
 *   roster dedupe dropped              1 failed  (three chips, one person)
 *   applyMention inserts a token       3 failed  (across all three suites)
 *
 * One line did NOT fail when broken: mentionsMe's empty-name early return.
 * It is redundant with the blank-name filter, and its comment now says so
 * rather than letting it read as the guard.
 */
import {
  MENTION_SIGIL,
  applyMention,
  mentionQuery,
  mentionSuggestions,
  mentionedNames,
  mentionsMe,
} from '../src/crews/mentions';

const POD = ['Kupo', 'Kupo Two', 'Dusty Boots', 'Rusty'];

describe('who a message names', () => {
  test('the plain case: an @ before a roster name', () => {
    expect(mentionedNames('@Kupo bring water', POD)).toEqual(['Kupo']);
    expect(mentionedNames('hey @Rusty, shade is up', POD)).toEqual(['Rusty']);
  });

  test('LONGEST FIRST: "@Kupo Two" belongs to Kupo Two, and only to her', () => {
    // THE LOAD-BEARING ONE. Mutation: drop the length sort in candidates()
    // and every message for Kupo Two also buzzes Kupo — on both phones, all
    // week, with nothing on screen to explain why.
    expect(mentionedNames('@Kupo Two bring water', POD)).toEqual(['Kupo Two']);
    expect(mentionedNames('@Kupo Two bring water', POD)).not.toContain('Kupo');
    // …and the short name still works when it is the one that was typed.
    expect(mentionedNames('@Kupo bring water', POD)).toEqual(['Kupo']);
  });

  test('names hold spaces, because playa names do', () => {
    expect(mentionedNames('ask @Dusty Boots about the bikes', POD)).toEqual([
      'Dusty Boots',
    ]);
  });

  test('WORD BOUNDARY: an email address is not a mention, and neither is a longer word', () => {
    // Mutation: drop the preceding-character check and "mail@kupo.example"
    // buzzes Kupo. Drop the trailing one and "@Kupolicious" does.
    expect(mentionedNames('write to mail@kupo for the map', POD)).toEqual([]);
    expect(mentionedNames('@Kupolicious is a great name', POD)).toEqual([]);
    // A name followed by punctuation IS the ordinary way people type.
    expect(mentionedNames('@Kupo, bring water', POD)).toEqual(['Kupo']);
    expect(mentionedNames('thanks @Rusty!', POD)).toEqual(['Rusty']);
    expect(mentionedNames('@Kupo', POD)).toEqual(['Kupo']);
  });

  test('CASE-INSENSITIVE, and the ROSTER’s spelling is what comes back', () => {
    // Mutation: compare raw strings — a camper typing "@kupo" at 4am names
    // nobody, which is exactly how the owner phrased the ask.
    expect(mentionedNames('@kupo bring water', POD)).toEqual(['Kupo']);
    expect(mentionedNames('@DUSTY BOOTS where are you', POD)).toEqual([
      'Dusty Boots',
    ]);
  });

  test('THE SIGIL IS REQUIRED: a name in a sentence is just a sentence', () => {
    // Mutation: match bare names and every message mentioning a podmate in
    // the third person buzzes them.
    expect(mentionedNames('Kupo has the water', POD)).toEqual([]);
    expect(MENTION_SIGIL).toBe('@');
  });

  test('several names, in the order they appear, each once', () => {
    expect(
      mentionedNames('@Rusty and @Kupo and @Rusty again', POD),
    ).toEqual(['Rusty', 'Kupo']);
  });

  test('a name made of regex metacharacters is just a name', () => {
    // Mutation: build a RegExp from each roster name — a podmate calling
    // themselves "(" takes down the arrival path for the whole pod, and a
    // long adversarial name becomes a backtracking hazard on the seam that
    // runs while mail is landing.
    const odd = ['a.*b', '(', 'C++'];
    expect(mentionedNames('@a.*b hello', odd)).toEqual(['a.*b']);
    expect(mentionedNames('@aXXb hello', odd)).toEqual([]);
    expect(mentionedNames('@( hello', odd)).toEqual(['(']);
  });

  test('blank and duplicate roster entries cannot match anything', () => {
    // Mutation: keep empty names and every '@' in every message becomes a
    // mention of a nameless card.
    expect(mentionedNames('@ hello', ['', '   ', 'Kupo'])).toEqual([]);
    expect(mentionedNames('@Kupo hi', ['Kupo', 'kupo', 'KUPO'])).toEqual([
      'Kupo',
    ]);
    // The dedupe earns its keep on the OFFER, not the match: one person
    // announced under three spellings (a card, an announcement, a rename
    // still gossiping) would otherwise be three chips above the composer.
    // Mutation: drop the `seen` check in rosterCandidates() — this is the
    // only assertion that notices.
    expect(mentionSuggestions('@ku', ['Kupo', 'kupo', 'KUPO'])).toEqual([
      'Kupo',
    ]);
  });
});

describe('does it name ME', () => {
  test('my own name matches whether or not the roster also carries it', () => {
    expect(mentionsMe('@Kupo bring water', ['Kupo'], POD)).toBe(true);
    expect(mentionsMe('@Kupo bring water', ['Kupo'], [])).toBe(true);
  });

  test('a podmate whose name CONTAINS mine does not buzz me', () => {
    // Mutation: test mentionsMe without folding the rest of the pod into
    // the pool — "@Kupo Two" starts matching Kupo again, and this is the
    // half of the longest-first rule that only shows up here.
    expect(mentionsMe('@Kupo Two bring water', ['Kupo'], POD)).toBe(false);
    expect(mentionsMe('@Kupo Two bring water', ['Kupo Two'], POD)).toBe(true);
  });

  test('a historical self target still shares the whole longest-name pool', () => {
    const names = [...POD, 'OldName Two'];
    expect(mentionsMe('@OldName bring water', ['NewName', 'OldName'], names)).toBe(
      true,
    );
    expect(
      mentionsMe('@OldName Two bring water', ['NewName', 'OldName'], names),
    ).toBe(false);
  });

  test('a phone with no name on its card can never be mentioned', () => {
    // Mutation: drop the empty-name guard and an empty needle matches at
    // every '@' — a nameless phone buzzes for everyone else's mentions.
    expect(mentionsMe('@Kupo bring water', [''], POD)).toBe(false);
    expect(mentionsMe('@Kupo bring water', ['   '], POD)).toBe(false);
  });

  test('somebody else’s mention is somebody else’s', () => {
    expect(mentionsMe('@Rusty shade is up', ['Kupo'], POD)).toBe(false);
  });
});

describe('the composer’s half', () => {
  test('a bare @ opens the whole roster — that is the discovery', () => {
    // Mutation: require a character after the sigil and nobody ever learns
    // the feature exists, because nothing appears when they type '@'.
    expect(mentionQuery('meet at @')).toBe('');
    expect(mentionSuggestions('meet at @', POD)).toEqual([
      'Dusty Boots',
      'Kupo',
      'Kupo Two',
      'Rusty',
    ]);
  });

  test('typing narrows it, case-insensitively', () => {
    expect(mentionSuggestions('@ku', POD)).toEqual(['Kupo', 'Kupo Two']);
    expect(mentionSuggestions('@KU', POD)).toEqual(['Kupo', 'Kupo Two']);
    expect(mentionSuggestions('@dusty b', POD)).toEqual(['Dusty Boots']);
  });

  test('the row closes when the name is finished and the sentence goes on', () => {
    // Mutation: trim the query before comparing, and the chips hang over
    // the composer for the rest of the message — covering the thread and
    // stealing the taps meant for it.
    expect(mentionSuggestions('@Kupo bring water', POD)).toEqual([]);
    expect(mentionSuggestions('@Rusty ', POD)).toEqual([]);
    // …while a name with a space in it survives its OWN space, which is the
    // same comparison doing both jobs. "@Kupo " keeps offering Kupo Two
    // because that IS still a name being spelled; one more word closes it.
    expect(mentionSuggestions('@Dusty ', POD)).toEqual(['Dusty Boots']);
    expect(mentionSuggestions('@Kupo ', POD)).toEqual(['Kupo Two']);
    expect(mentionSuggestions('@Kupo is here', POD)).toEqual([]);
  });

  test('no row for an @ that is not a mention', () => {
    expect(mentionQuery('mail@kupo')).toBeNull();
    expect(mentionSuggestions('mail@kupo', POD)).toEqual([]);
    expect(mentionSuggestions('nothing here', POD)).toEqual([]);
    // An '@' left far behind, or on an earlier line, is prose now.
    expect(mentionQuery('@kupo\nsecond thought')).toBeNull();
    expect(mentionQuery(`@${'x'.repeat(41)}`)).toBeNull();
  });

  test('the offer is capped, so the chips cannot eat the card', () => {
    const many = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    expect(mentionSuggestions('@a', many)).toHaveLength(5);
    expect(mentionSuggestions('@a', many, 2)).toEqual(['a1', 'a2']);
  });

  test('tapping a name completes it as PLAIN TEXT with a trailing space', () => {
    // Mutation: insert a token, a marker, anything but characters — and the
    // wire starts carrying something an older build renders as noise.
    expect(applyMention('meet at @ku', 'Kupo Two')).toBe('meet at @Kupo Two ');
    expect(applyMention('@', 'Rusty')).toBe('@Rusty ');
    expect(applyMention('hello', 'Rusty')).toBe('hello@Rusty ');
  });
});
