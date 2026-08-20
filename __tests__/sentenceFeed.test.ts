/**
 * SentenceFeed — incremental sentence-boundary detection for streamed speech.
 */

import { SentenceFeed } from '../src/speech/sentenceFeed';

describe('SentenceFeed', () => {
  it('emits a sentence the moment its boundary streams in', () => {
    const feed = new SentenceFeed();
    expect(feed.push('Bring 1')).toEqual([]);
    expect(feed.push('.5 gallons of water')).toEqual([]);
    expect(feed.push(' per day. Also bring')).toEqual([
      'Bring 1.5 gallons of water per day.',
    ]);
    expect(feed.flush()).toBe('Also bring');
  });

  it('does not split on decimals (the "." is not followed by whitespace)', () => {
    const feed = new SentenceFeed();
    expect(feed.push('Water: 1.5 gallons. Electrolytes help. ')).toEqual([
      'Water: 1.5 gallons.',
      'Electrolytes help.',
    ]);
  });

  it('treats newlines as boundaries (markdown lines speak as units)', () => {
    const feed = new SentenceFeed();
    expect(feed.push('## Water\n- Bring lots\n')).toEqual([
      '## Water',
      '- Bring lots',
    ]);
  });

  it('handles ! ? … and closing quotes/brackets before the space', () => {
    const feed = new SentenceFeed();
    expect(feed.push('Dusty out there! Ready? ')).toEqual([
      'Dusty out there!',
      'Ready?',
    ]);
    expect(feed.push('"Stay hydrated." And rest. ')).toEqual([
      '"Stay hydrated."',
      'And rest.',
    ]);
  });

  it('emits multiple sentences from one big chunk, in order', () => {
    const feed = new SentenceFeed();
    expect(feed.push('One. Two. Three. Fou')).toEqual(['One.', 'Two.', 'Three.']);
    expect(feed.push('r. ')).toEqual(['Four.']);
  });

  it('flush returns the tail and resets', () => {
    const feed = new SentenceFeed();
    feed.push('Unfinished thought');
    expect(feed.flush()).toBe('Unfinished thought');
    expect(feed.flush()).toBe('');
    expect(feed.push('Fresh start. ')).toEqual(['Fresh start.']);
  });
});
