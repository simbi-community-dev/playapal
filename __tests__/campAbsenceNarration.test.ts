/**
 * THE HONEST CLOSE for a camp-history question the camp pack cannot answer.
 *
 * Device receipt (2026-08-16, owner testing): "who sponsored her?" came back
 * not_found and the app closed with "…you can always ask your campmates or
 * check Playa Info at Esplanade & 5:45."
 *
 * The address is REAL — verbatim in the shipped survival guide — so nothing
 * about the string is wrong. The DOMAIN is. Playa Info is a Black Rock City
 * services desk: lost and found, tows, lockouts, directions. It cannot say
 * who sponsored a camper into this camp, for anybody, ever. These tests pin
 * the discriminator: a camp-history answer refers INTO the camp, and the
 * survival/logistics path keeps every city referral it has.
 */

import { campHistoryAbsenceNarration } from '../src/llm/factNarration';

/** A Black Rock City services referral — right for logistics, wrong here. */
const CITY_SERVICES = /Playa Info|Center Camp|Esplanade|Ranger|Arctica|Airport/i;
/** A BRC clock address ("Esplanade & 5:45", "7:30 & G"). */
const CITY_ADDRESS = /\b\d{1,2}:\d{2}\b|&\s+[A-K]\b/;

describe('camp-history absence narration', () => {
  it('THE RECEIPT: sponsorship for a camper the pack does not carry', () => {
    expect(campHistoryAbsenceNarration({ query: 'sponsors', entity: 'Coco' })).toBe(
      "I don't have sponsorship records for Coco in the camp pack yet — " +
        "your campmates would know, and it's really theirs to tell.",
    );
  });

  it.each([
    ['sponsors', { query: 'sponsors', entity: 'Coco' }],
    ['sponsees', { query: 'sponsees', entity: 'Coco' }],
    ['attendance', { query: 'attendance', entity: 'Coco' }],
    ['projects', { query: 'projects', entity: 'Coco' }],
    ['path', { query: 'path', entity: 'Coco', target: 'Drew' }],
    ['cohort', { query: 'cohort', entity: '1998' }],
  ])('stays in the camp for a %s question', (_query, absence) => {
    const line = campHistoryAbsenceNarration(absence as never);
    // Says plainly that the pack does not have it — and "yet", which is the
    // true part: the lineage pack is still being built.
    expect(line).toMatch(/I don't have/);
    expect(line).toMatch(/camp pack yet|roster for/);
    // Refers into the camp, and nowhere else.
    expect(line).toMatch(/campmates/);
    expect(line).not.toMatch(CITY_SERVICES);
    expect(line).not.toMatch(CITY_ADDRESS);
    // Never claims the pack HAS something it does not.
    expect(line).not.toMatch(/I found|here's what|records below/i);
    // Plain and warm, never the whimsical deflection.
    expect(line).not.toMatch(/slipped away|dust/i);
  });

  it('names the people the question named, and only them', () => {
    expect(campHistoryAbsenceNarration({ query: 'sponsees', entity: 'Blair' })).toContain(
      'who Blair sponsored',
    );
    expect(
      campHistoryAbsenceNarration({ query: 'path', entity: 'Blair', target: 'Drew' }),
    ).toContain('between Blair and Drew');
    expect(campHistoryAbsenceNarration({ query: 'cohort', entity: '1998' })).toContain(
      'a roster for 1998',
    );
  });
});
