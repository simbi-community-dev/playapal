/**
 * SOURCE-REF fixture tests. Like personCard.test.ts, the fixtures run real
 * pack markdown through the REAL chunker, so the headings and passage text
 * under test are the ones the device actually retrieves.
 *
 * What is being pinned: an answer's provenance reaches the screen in the
 * packs' own words (no pack ids, no filenames — camp-voice's "never a
 * database row"), carrying the SAME excerpt the model was fed, capped so a
 * turn can never become a wall of citations, and flagged when the passage
 * remembers someone who died.
 */

import { chunkDocument } from '../src/packs/chunker';
import {
  MAX_SOURCE_REFS,
  mergeSourceRefs,
  sourceRef,
  sourceRefs,
} from '../src/docs/sourceRef';
import type { DocSearchOutcome } from '../src/types';

const PEOPLE_MD = `# Campers

## Marisol Vega (Marisol) — Dusty Star camper

### Who is Marisol Vega?

Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads. Also appears on the list as Marisol.

## AJM (Alex J Mercer) — Dusty Star camper

### Who is AJM?

AJM — Alex J Mercer on the camp list — was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011, with 33 list messages across 28 threads. Also appears on the list as David T. Anderson.

In memoriam. The camp gathered for "AJM's Memorial" in 2013, and campers filled a reminiscing thread with their favorite AJM moments — Papa AJM to his hippo family.
`;

const GUIDE_MD = `# Survival Guide

## Water

Bring 1.5 gallons of water per person per day. Drink before you are thirsty.
`;

type Passage = DocSearchOutcome['results'][number];

function passages(
  markdown: string,
  sourceFile: string,
  packId: string,
  packName: string,
  firstId: number,
): Passage[] {
  return chunkDocument(markdown).map((chunk, index) => ({
    id: firstId + index,
    pack_id: packId,
    source_file: sourceFile,
    heading: chunk.heading,
    content: chunk.content,
    pack_name: packName,
  }));
}

const people = passages(
  PEOPLE_MD,
  'people-dusty-star.md',
  'dusty-star-lore-25y',
  'Dusty Star 25 Years',
  1,
);
const guide = passages(
  GUIDE_MD,
  'survival.md',
  'survival-guide',
  'Survival Guide',
  50,
);

const person = (name: string): Passage => {
  const hit = people.find(p => p.heading.endsWith(`Who is ${name}?`));
  if (!hit) {
    throw new Error(`fixture has no card for ${name}`);
  }
  return hit;
};

const outcome = (results: Passage[], terms?: string[]): DocSearchOutcome => ({
  results,
  terms,
  strategy: 'fts-and',
});

describe('source refs', () => {
  test('a chip names the pack and the document in their own words', () => {
    const [water] = sourceRefs(outcome(guide, ['water']));

    expect(water.pack).toBe('Survival Guide');
    expect(water.doc).toBe('Water');
    expect(water.heading).toBe('Survival Guide > Water');
    expect(water.passage).toContain('1.5 gallons of water');
  });

  test('NO storage tokens ever reach a ref: no pack id, no filename', () => {
    const refs = sourceRefs(outcome([...guide, person('Marisol Vega')]));
    const rendered = refs
      .map(r => `${r.pack} ${r.doc} ${r.heading} ${r.passage}`)
      .join(' ');

    expect(rendered).not.toContain('dusty-star-lore-25y');
    expect(rendered).not.toContain('survival-guide');
    expect(rendered).not.toMatch(/\.md\b/);
  });

  test('the chip opens onto the excerpt the MODEL read, not a fresh cut', () => {
    // A chunk past the payload budget: the excerpt window follows the query
    // terms, exactly as the tool payload's does (docs/excerpt).
    const long: Passage = {
      ...guide[0],
      content: `${'filler sentence. '.repeat(60)}The bus threw a rod near Gerlach.${' more filler.'.repeat(60)}`,
    };
    const ref = sourceRef(long, ['bus']);

    expect(ref.passage).toContain('The bus threw a rod near Gerlach.');
    expect(ref.passage.length).toBeLessThan(long.content.length);
  });

  test('a headingless chunk falls back to its document, with the file chrome off', () => {
    const bare: Passage = { ...guide[0], heading: '' };

    expect(sourceRef(bare, []).doc).toBe('Survival');
  });

  test('a memorial passage is flagged for the gentle register', () => {
    expect(sourceRef(person('AJM'), []).memorial).toBe(true);
    // A living camper's card, and an ordinary guide passage, stay records.
    expect(sourceRef(person('Marisol Vega'), []).memorial).toBe(false);
    expect(sourceRef(guide[0], []).memorial).toBe(false);
  });

  test('quiet by construction: never more than the cap, in rank order', () => {
    const many = [...guide, ...people, ...guide.map(g => ({ ...g, id: g.id + 900 }))];
    const refs = sourceRefs(outcome(many));

    expect(MAX_SOURCE_REFS).toBe(3);
    expect(refs).toHaveLength(MAX_SOURCE_REFS);
    expect(refs.map(r => r.id)).toEqual(many.slice(0, 3).map(p => `${p.pack_id}:${p.id}`));
  });

  test('a passage retrieved twice in one turn is one chip, at its first rank', () => {
    // Two tool rounds that both surfaced the water chunk, plus the people
    // pack's two cards: three chips, water first, nothing repeated.
    const water = sourceRefs(outcome(guide));
    const merged = mergeSourceRefs([...water, ...water, ...sourceRefs(outcome(people))]);

    expect(merged.map(r => r.id)).toEqual([
      'survival-guide:50',
      'dusty-star-lore-25y:1',
      'dusty-star-lore-25y:2',
    ]);
    expect(new Set(merged.map(r => r.id)).size).toBe(merged.length);
  });
});
