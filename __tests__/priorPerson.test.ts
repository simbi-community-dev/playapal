/**
 * THE PERSON ANCHOR — the receipt, in units.
 *
 * Device chat_log, 2026-08-16, owner testing:
 *   turn 1  "Who is Coco"        -> Coco's person card renders.
 *   turn 2  "who sponsored her?" -> lookup_history{"entity":"her"} -> not_found
 * There is no camper named "her". These tests pin the two halves of the fix:
 * what the app is allowed to treat as an antecedent, and what counts as a
 * pronoun worth resolving.
 */

import {
  isPronounSlot,
  personAnchorFromCards,
  resolvePersonArgument,
  resolvePersonSlot,
} from '../src/llm/priorPerson';
import type { ChatCard, PersonRef } from '../src/types';

const coco: PersonRef = {
  pack_id: 'dusty-star-lore-25y',
  id: 'person:coco',
  name: 'Coco',
};
const cocoCard: ChatCard = {
  kind: 'person',
  person_ref: coco,
  name: 'Coco',
  alsoKnownAs: null,
  aliases: [],
  tenure: { from: 'Mar 2011', to: 'Aug 2019' },
  summary: 'Coco was a Dusty Star camper.',
  memoriam: 'In memoriam.',
  pack_id: 'dusty-star-lore-25y',
  evidence_ref: 'people-dusty-star.md#coco',
};

describe('pronoun slots', () => {
  it.each(['her', 'him', 'them', 'she', 'he', 'they', 'his', 'hers', 'their', 'theirs'])(
    'reads %s as a pronoun',
    slot => {
      expect(isPronounSlot(slot)).toBe(true);
    },
  );

  it.each(['Her?', ' her ', 'HER', 'her.'])('ignores case and punctuation: %s', slot => {
    expect(isPronounSlot(slot)).toBe(true);
  });

  it.each([
    'her camp',
    'his projects',
    'Coco',
    'River Moon',
    'the guy from Reno',
    'herbert',
    'Heather',
    '',
    // Whitespace is never collapsed away, so two words cannot fuse into one
    // pronoun ("T. Hey" is not "they").
    'T. Hey',
  ])('leaves %s alone — only a BARE pronoun resolves', slot => {
    expect(isPronounSlot(slot)).toBe(false);
  });
});

describe('resolvePersonSlot', () => {
  it('binds a pronoun to the exact graph anchor and carries pack scope', () => {
    expect(resolvePersonArgument('her', coco)).toEqual({
      value: 'Coco',
      anchored: true,
      pack_id: 'dusty-star-lore-25y',
    });
    expect(resolvePersonSlot('her', coco)).toBe('Coco');
  });

  it('leaves the pronoun alone when the session has resolved nobody', () => {
    // The conservative half: with no antecedent the slot is passed through
    // untouched and today's path runs, not-found and all.
    expect(resolvePersonSlot('her', null)).toBe('her');
  });

  it('never touches a slot that names someone', () => {
    expect(resolvePersonArgument('River Moon', coco)).toEqual({
      value: 'River Moon',
      anchored: false,
    });
    expect(resolvePersonSlot('Blair', coco)).toBe('Blair');
  });
});

describe('personAnchorFromCards — exact identity references only', () => {
  it('returns the structured identity attached to a direct person card', () => {
    expect(personAnchorFromCards([cocoCard])).toEqual(coco);
  });

  it.each([
    ['presentation-only person card', { ...cocoCard, person_ref: undefined }],
    ['attendance', { kind: 'attendance', person: 'River Moon', years: [] }],
    ['projects', { kind: 'projects', person: 'River Moon', projects: [] }],
    [
      'lineage',
      { kind: 'lineage', person: 'River Moon', direction: 'sponsors', relationships: [] },
    ],
    ['path', { kind: 'path', from: 'River Moon', to: 'Drew', relationships: [] }],
    ['cohort', { kind: 'cohort', year: 2023, people: [] }],
  ])('does not reconstruct identity from a %s card', (_kind, card) => {
    expect(personAnchorFromCards([card as ChatCard])).toBeNull();
  });

  it('ignores event cards and an empty turn', () => {
    const event: ChatCard = {
      kind: 'event',
      event: {
        id: 1,
        title: 'Sunrise Yoga',
        desc: '',
        day: 'Tuesday',
        date: '2026-09-01',
        time_start: '07:00',
        time_end: '08:00',
        camp: 'Dusty Star',
        location: '7:30 & G',
      },
    };
    expect(personAnchorFromCards([event])).toBeNull();
    expect(personAnchorFromCards([])).toBeNull();
  });

  it('takes the last exact person reference shown', () => {
    const blair = {
      pack_id: 'dusty-star-lore-25y',
      id: 'person:blair',
      name: 'Blair',
    };
    const blairCard: ChatCard = {
      ...cocoCard,
      person_ref: blair,
      name: 'Blair',
    };
    expect(personAnchorFromCards([cocoCard, blairCard])).toEqual(blair);
  });
});
