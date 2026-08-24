/**
 * PERSON-CARD fixture tests. The fixtures are real shapes from the shipped
 * dusty-star-lore-25y pack, run through the REAL chunker — so the heading
 * breadcrumb and passage content under test are the ones the device
 * actually retrieves, not hand-typed approximations of them.
 *
 * The measured case being pinned (chat_log receipts, 2026-08-16): retrieval
 * returned the Marisol passage and the model answered "I don't have details
 * on who Marisol is in your specific camp right now." The first test asserts
 * the app now owns that answer; the controls assert everything else keeps
 * today's prose path exactly.
 */

import { chunkDocument } from '../src/packs/chunker';
import {
  parsePersonCard,
  personCardFromResults,
  questionNamesPerson,
} from '../src/facts/personCard';
import { structuredCardNarration } from '../src/llm/factNarration';
import type { DocSearchOutcome, PersonFactCard } from '../src/types';

const PEOPLE_MD = `# Campers

The people of Dusty Star, the Burning Man theme camp — one card for EVERY
author who ever wrote to the camp's 2010-2026 email list.

## Marisol Vega (Marisol) — Dusty Star camper

### Who is Marisol Vega?

Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads. Also appears on the list as Marisol.

Corpus topics Marisol wrote about most: tickets (48 messages), the hippo bus (37 messages), the kitchen and camp dinners (29 messages).

Signs off as "marisol", "pete".

Marisol wrote on 2010-09-18: "I have to reply here as the person who started the camp and ran the camp for most of the last decade."

## AJM (Alex J Mercer) — Dusty Star camper

### Who is AJM?

AJM — Alex J Mercer on the camp list — was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011, with 33 list messages across 28 threads. Also appears on the list as David T. Anderson.

In memoriam. The camp gathered for "AJM's Memorial" in 2013, and campers filled a reminiscing thread with their favorite AJM moments — Papa AJM to his hippo family.

Signed off as "-dta", "dtiz".

## Sallee — Dusty Star camper

### Who is Sallee?

Sallee wrote to the Dusty Star camp list once, in Jul 2023, in the thread "Introducing Christina Sallee as a new Hippo!". That message is this camper's whole trace in the archive.

## n o (n) — Dusty Star camper

### Who is n o?

n o is a Dusty Star camper, active on the camp list in Aug 2013, with 2 list messages across 2 threads.
`;

const LORE_MD = `## PLEASE READ - Email List Moved to Google (2010) with Morgan Berkus [March 2010]

Thread from the Dusty Star camp list: 2 messages, March 2010.

Morgan Berkus wrote on 2010-03-26: This is the very first message to/from our new Google email list.
`;

const GUIDE_MD = `# Survival Guide

## Water

Bring 1.5 gallons of water per person per day. Drink before you are thirsty.
`;

type Passage = DocSearchOutcome['results'][number];

/** Every chunk the real chunker makes of one pack file, as search results. */
function passages(markdown: string, sourceFile: string): Passage[] {
  return chunkDocument(markdown).map((chunk, index) => ({
    id: index + 1,
    pack_id: 'dusty-star-lore-25y',
    source_file: sourceFile,
    heading: chunk.heading,
    content: chunk.content,
    pack_name: 'Dusty Star 25 Years',
  }));
}

const people = passages(PEOPLE_MD, 'people-dusty-star.md');
const lore = passages(LORE_MD, 'lore-2010.md');
const guide = passages(GUIDE_MD, 'survival.md');

const personPassage = (name: string): Passage => {
  const hit = people.find(p => p.heading.endsWith(`Who is ${name}?`));
  if (!hit) {
    throw new Error(`fixture has no card for ${name}`);
  }
  return hit;
};

const card = (name: string): PersonFactCard => {
  const parsed = parsePersonCard(personPassage(name));
  if (!parsed) {
    throw new Error(`${name} did not parse as a person card`);
  }
  return parsed;
};

describe('person-card detection', () => {
  test('THE MARISOL CASE: the retrieved passage the model refused now renders a card', () => {
    const passage = personPassage('Marisol Vega');
    // The device receipt's breadcrumb, verbatim — the shape detection reads.
    expect(passage.heading).toBe(
      'Campers > Marisol Vega (Marisol) — Dusty Star camper > Who is Marisol Vega?',
    );

    const marisol = personCardFromResults(
      [passage, ...lore],
      'Who is Marisol from the camp',
    );

    expect(marisol).toMatchObject({
      kind: 'person',
      name: 'Marisol Vega',
      alsoKnownAs: 'Marisol',
      aliases: ['Marisol'],
      tenure: { from: 'Mar 2010', to: 'Aug 2026' },
      memoriam: null,
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#marisol-vega',
    });
    // The card's own summary sentence, minus the alias sentence it renders
    // separately — the pack's words, never the model's.
    expect(marisol!.summary).toBe(
      'Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads.',
    );
  });

  test('a NON-person passage never takes the card path (prose stands)', () => {
    for (const passage of [...lore, ...guide]) {
      expect(parsePersonCard(passage)).toBeNull();
    }
    expect(personCardFromResults(lore, 'who moved the email list')).toBeNull();
    expect(
      personCardFromResults(guide, 'how much water should I bring'),
    ).toBeNull();
  });

  test('a memorial card carries the camp’s own remembrance and drops the volume clause', () => {
    const dta = card('AJM');
    expect(dta.memoriam).toBe(
      'In memoriam. The camp gathered for "AJM\'s Memorial" in 2013, and campers filled a reminiscing thread with their favorite AJM moments — Papa AJM to his hippo family.',
    );
    // Past tense throughout, and no message/thread counts anywhere on it.
    expect(dta.summary).toBe(
      'AJM — Alex J Mercer on the camp list — was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011.',
    );
    expect(dta.summary).not.toMatch(/messages|threads/);
    expect(dta.tenure).toEqual({ from: 'Apr 2010', to: 'Oct 2011' });
    // The alias sentence is the paragraph's last one, and the names in it
    // carry periods of their own.
    expect(dta.aliases).toEqual(['David T. Anderson']);
  });

  test('a one-post camper parses with a single-month activity window', () => {
    expect(card('Sallee')).toMatchObject({
      name: 'Sallee',
      alsoKnownAs: null,
      aliases: [],
      tenure: { from: 'Jul 2023', to: null },
      memoriam: null,
    });
  });
});

describe('person-card engagement gates', () => {
  test('a person passage the question did not name keeps the prose path', () => {
    // Retrieval can float a camper card into an unrelated answer; only the
    // asker's own words let it render.
    expect(
      personCardFromResults(
        [personPassage('Marisol Vega')],
        'what time do the camp dinners start',
      ),
    ).toBeNull();
    expect(questionNamesPerson(card('Marisol Vega'), 'who is marina')).toBe(
      false,
    );
  });

  test('a "who is" question takes its camper’s card from below the top rank', () => {
    // THE WIDENING (owner ruling: the card is the standard shape for any
    // "who is" answer). lookup_facts returns two passages, so a camper whose
    // lore thread out-ranks their own card used to fall all the way back to
    // model prose — the exact configuration that produced the measured false
    // IDK. The asker asked who Marisol is; rank is retrieval's business.
    expect(
      personCardFromResults(
        [...lore, personPassage('Marisol Vega')],
        'Who is Marisol from the camp',
      ),
    ).toMatchObject({ kind: 'person', name: 'Marisol Vega' });
  });

  test('a question that is NOT an identity question keeps top-ranked-only', () => {
    // An events/logistics/relational turn can float a camper card into its
    // results; nothing below rank 1 may hijack it, even when the question
    // happens to carry the name.
    for (const question of [
      'what time do the camp dinners start with Marisol',
      'who sponsored Marisol Vega',
      'where is ice',
    ]) {
      expect(
        personCardFromResults(
          [...lore, personPassage('Marisol Vega')],
          question,
        ),
      ).toBeNull();
    }
  });

  test('the widening never invents a card the asker did not name', () => {
    expect(
      personCardFromResults([...lore, personPassage('AJM')], 'Who is Coco'),
    ).toBeNull();
  });

  test('one- and two-character list names never match a question', () => {
    // "n o (n)" is a real card; a bare "n" would match half of English.
    expect(questionNamesPerson(card('n o'), 'can i get a ride to the burn')).toBe(
      false,
    );
    expect(questionNamesPerson(card('n o'), 'who is n o')).toBe(false);
  });
});

describe('the model’s one deferential line', () => {
  test('a person card replaces the prose the model would have written', () => {
    expect(structuredCardNarration([card('Marisol Vega')])).toBe(
      "Here's what the camp list remembers about Marisol Vega.",
    );
  });

  test('a memorial line speaks of the departed without reciting the archive', () => {
    const line = structuredCardNarration([card('AJM')]);
    expect(line).toBe("Here's what the camp remembers of AJM.");
    expect(line).not.toMatch(/\d/);
  });

  test('cardless turns keep the model’s own prose', () => {
    expect(structuredCardNarration([])).toBeNull();
  });
});

describe('person-card fail-soft', () => {
  const marisol = personPassage('Marisol Vega');

  test('a passage outside a people-*.md file is never a card', () => {
    expect(
      parsePersonCard({ ...marisol, source_file: 'lore-2026.md' }),
    ).toBeNull();
  });

  test('a drifted heading shape is never a card', () => {
    for (const heading of [
      // Headings disagree on who the card is about.
      'Campers > Marisol Vega (Marisol) — Dusty Star camper > Who is Marisol?',
      // Missing the "Who is …?" leaf.
      'Campers > Marisol Vega (Marisol) — Dusty Star camper',
      // Missing the camper segment.
      'Campers > Marisol Vega > Who is Marisol Vega?',
      // Not a camper card at all.
      'Campers > Marisol Vega (Marisol) — Dusty Star bus > Who is Marisol Vega?',
    ]) {
      expect(parsePersonCard({ ...marisol, heading })).toBeNull();
    }
  });

  test('a mid-card chunk (no summary sentence) is never a card', () => {
    expect(
      parsePersonCard({
        ...marisol,
        content:
          'Signs off as "marisol", "pete".\n\nMarisol wrote on 2010-09-18: "I have to reply here as the person who started the camp."',
      }),
    ).toBeNull();
  });

  test('a summary with no parseable activity window is never a card', () => {
    expect(
      parsePersonCard({
        ...marisol,
        content: 'Marisol Vega is a Dusty Star camper of long standing.',
      }),
    ).toBeNull();
  });
});

describe('the person card follows a pronoun to the session anchor', () => {
  // "Who is Sallee" rendered her card; the next question may name her the
  // way people actually talk. The app resolved that pronoun itself, so the
  // card gates read that resolution, not the user re-typing a name.
  const sallee = [personPassage('Sallee'), ...lore];

  test('renders the card for "tell me about her" once Sallee is the anchor', () => {
    expect(personCardFromResults(sallee, 'tell me about her', 'Sallee')).toMatchObject({
      kind: 'person',
      name: 'Sallee',
    });
    expect(personCardFromResults(sallee, 'who is she?', 'Sallee')).toMatchObject({
      name: 'Sallee',
    });
  });

  test('the rank widening follows too — a pronoun question is an identity question', () => {
    // Her own card sitting behind a lore thread: gate 1 has to see the
    // identity shape THROUGH the pronoun, or the widening never engages.
    const behind = [...lore, personPassage('Sallee')];
    expect(personCardFromResults(behind, 'tell me about her', 'Sallee')).toMatchObject({
      name: 'Sallee',
    });
  });

  test('no anchor, no card — a pronoun names nobody on its own', () => {
    expect(personCardFromResults(sallee, 'tell me about her')).toBeNull();
    expect(personCardFromResults(sallee, 'who is she?', null)).toBeNull();
  });

  test('the anchor never overrides a question that names someone else', () => {
    // Asking about Marisol while Sallee is the anchor is a question about
    // Marisol: the expansion fires only when the anchor-free parse read no
    // name at all.
    expect(
      personCardFromResults(
        [personPassage('Marisol Vega'), ...lore],
        'Who is Marisol from the camp',
        'Sallee',
      ),
    ).toMatchObject({ name: 'Marisol Vega' });
    // A non-identity question keeps top-ranked-only, with no expansion.
    expect(
      personCardFromResults(
        [...lore, personPassage('Sallee')],
        'who moved the email list',
        'Sallee',
      ),
    ).toBeNull();
  });
});
