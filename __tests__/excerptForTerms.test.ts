/**
 * Query-focused tool-payload excerpting (lore-reachability round). The old
 * head-slice fed the model a chunk's FIRST 700 chars; for email-thread lore
 * chunks that is metadata, and the ranking fact sat past the cut (device
 * chat_log rows 172-175: right chunk retrieved, answer invisible, honest
 * IDK). The excerpt window must follow the query terms, and a Credit: line
 * must always ride (v4 technique chunks carried theirs at ~1200 of ~1300 —
 * attribution never reached the model before this).
 */

import { docsResultJson, excerptForTerms } from '../src/docs/searchDocs';
import type { DocSearchOutcome } from '../src/types';

jest.mock('../src/events/db', () => ({
  getDb: () => {
    throw new Error('no db in this suite');
  },
  isFtsAvailable: () => false,
}));

const FILLER = 'the camp list talked about many unrelated things that week. ';

describe('excerptForTerms', () => {
  test('content within budget passes through byte-identical', () => {
    const short = 'A tidy fact-dense chunk about water rations.';
    expect(excerptForTerms(short, ['water'])).toBe(short);
  });

  test('the window follows the query-term cluster deep in the chunk (the buried-answer shape)', () => {
    // Fictional stand-in for the device-measured shape: the fact that made
    // the chunk rank sits ~1100 chars in, past the old head-slice.
    const content =
      FILLER.repeat(18) + // ~1060 chars of preamble
      'Vera wrote: I can offer my 1963 Rambler wagon for the 2011 parade filming downtown. ' +
      FILLER.repeat(8);
    const out = excerptForTerms(content, ['classic', 'wagon', 'offered', 'vera', '2011']);
    expect(out.length).toBeLessThanOrEqual(710);
    expect(out).toContain('Rambler');
    expect(out).toContain('Vera');
    expect(out.startsWith('…')).toBe(true);
  });

  test('no terms (or no hits) falls back to the head slice', () => {
    const content = FILLER.repeat(30);
    const out = excerptForTerms(content, undefined);
    expect(out.startsWith('the camp list')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(700);
  });

  test('a Credit: line beyond the window is appended; one inside is not duplicated', () => {
    const credit =
      'Credit: [Burn.Life — Anchoring guide](https://burn.life/anchoring), retrieved 2026-08-14';
    const content =
      'Anchoring: drive lag screws through chain links. ' +
      FILLER.repeat(22) +
      credit;
    const out = excerptForTerms(content, ['anchor', 'shade']);
    expect(out).toContain('Credit: [Burn.Life');
    expect(out.match(/Credit:/g)!.length).toBe(1);

    const shortWithCredit = `Short technique text.\n${credit}`;
    const out2 = excerptForTerms(shortWithCredit, ['anchor']);
    expect(out2.match(/Credit:/g)!.length).toBe(1);
  });

  test('4-char prefix tolerance: "filming" matches "film" forms', () => {
    const content = FILLER.repeat(20) + 'the film crew arrived with cameras. ' + FILLER.repeat(6);
    const out = excerptForTerms(content, ['filming']);
    expect(out).toContain('film crew');
  });
});

const passage = (id: number, heading: string): DocSearchOutcome['results'][number] => ({
  id,
  pack_id: 'guide',
  pack_name: 'Survival Guide',
  source_file: 'guide.md',
  heading,
  content: `Evidence for ${heading}.`,
});

function payload(
  terms: string[],
  results: DocSearchOutcome['results'],
): { count: number; passages: Array<Record<string, string>> } {
  return JSON.parse(docsResultJson({ results, strategy: 'fts-and', terms }));
}

describe('docsResultJson ordinal evidence', () => {
  const results = [
    passage(2, 'The 10 Principles of Burning Man > Principle 2: Gifting'),
    passage(8, 'The 10 Principles of Burning Man > Principle 8: Leaving No Trace'),
  ];

  test.each<[string, number, string]>([
    ['second', 2, 'Principle 2 of 10: Gifting'],
    ['2nd', 2, 'Principle 2 of 10: Gifting'],
    ['eighth', 8, 'Principle 8 of 10: Leaving No Trace'],
    ['8th', 8, 'Principle 8 of 10: Leaving No Trace'],
  ])('%s selects one explicitly positioned item', (ordinal, id, item) => {
    const out = payload([ordinal, 'principle'], results);
    expect(out.count).toBe(1);
    expect(out.passages).toHaveLength(1);
    expect(out.passages[0].item).toBe(item);
    expect(out.passages[0].text).toContain(`Principle ${id}`);
  });

  test('non-ordinal passages are numbered in current retrieval order', () => {
    const out = payload(['principle'], results);
    expect(out.passages.map(p => p.item)).toEqual([
      '1. The 10 Principles of Burning Man > Principle 2: Gifting',
      '2. The 10 Principles of Burning Man > Principle 8: Leaving No Trace',
    ]);
    const shrunk = payload(['principle'], results.slice(1));
    expect(shrunk.passages[0].item).toBe(
      '1. The 10 Principles of Burning Man > Principle 8: Leaving No Trace',
    );
  });

  test('an unmatched ordinal never fabricates a positioned item', () => {
    const out = payload(['10th', 'principle'], results);
    expect(out.count).toBe(2);
    expect(out.passages.every(p => !p.item.includes('Principle 10 of'))).toBe(true);
  });
});
