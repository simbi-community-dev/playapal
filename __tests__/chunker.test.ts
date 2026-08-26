/**
 * Unit tests for the data-pack freeform chunker.
 */

import { chunkDocument, DEFAULT_MAX_CHARS } from '../src/packs/chunker';

describe('chunkDocument', () => {
  test('one chunk per small heading section, with breadcrumbs', () => {
    const md = [
      '# Survival Guide',
      'Intro paragraph.',
      '## Water',
      'Bring 1.5 gallons per person per day.',
      '## Shade',
      'Build shade first.',
    ].join('\n');
    const chunks = chunkDocument(md);
    expect(chunks.map(c => c.heading)).toEqual([
      'Survival Guide',
      'Survival Guide > Water',
      'Survival Guide > Shade',
    ]);
    expect(chunks[1].content).toBe('Bring 1.5 gallons per person per day.');
    expect(chunks.map(c => c.index)).toEqual([0, 1, 2]);
  });

  test('breadcrumb stack pops correctly on sibling/shallower headings', () => {
    const md = [
      '# A',
      'a',
      '## B',
      'b',
      '### C',
      'c',
      '## D',
      'd',
      '# E',
      'e',
    ].join('\n');
    const chunks = chunkDocument(md);
    expect(chunks.map(c => c.heading)).toEqual([
      'A',
      'A > B',
      'A > B > C',
      'A > D',
      'E',
    ]);
  });

  test('long sections split on paragraph boundaries within the budget', () => {
    const para = 'x'.repeat(800);
    const md = `## Long\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkDocument(md); // 3x800 > 2000 -> must split
    expect(chunks.length).toBe(2);
    expect(chunks.every(c => c.content.length <= DEFAULT_MAX_CHARS)).toBe(true);
    expect(chunks.every(c => c.heading === 'Long')).toBe(true);
  });

  test('a single oversized paragraph is hard-split under the budget', () => {
    const words = Array(1200).fill('word').join(' '); // ~6000 chars, no \n\n
    const chunks = chunkDocument(`## Big\n${words}`);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(c => c.content.length <= DEFAULT_MAX_CHARS)).toBe(true);
  });

  test('headingless plain text still chunks (empty breadcrumb)', () => {
    const chunks = chunkDocument('Just some notes.\n\nAnother paragraph.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('');
    expect(chunks[0].content).toBe('Just some notes.\n\nAnother paragraph.');
  });

  test('empty and whitespace-only sections are dropped', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('# Title only\n\n## Empty\n   \n')).toEqual([]);
  });

  test('custom budget is honored', () => {
    const chunks = chunkDocument('aaa\n\nbbb\n\nccc', { maxChars: 7 });
    expect(chunks.map(c => c.content)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});
