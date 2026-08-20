/**
 * anchorTopic — the untrusted-hint pattern for lookup_facts topics: recover
 * the proper nouns / years the 2.6B drops from its topic slot, from the
 * user's own question. The first case is the device-measured failure the
 * function exists for (lore-reachability round, 2026-08-14).
 */

import { anchorTopic } from '../src/facts/anchorTopic';

describe('anchorTopic', () => {
  test('DEVICE-MEASURED: recovers "Brook" and "2010" the model dropped', () => {
    expect(
      anchorTopic('classic car offered', 'what classic car did Brook offer for the 2010 filming?'),
    ).toBe('classic car offered Brook 2010');
  });

  test('a topic already carrying its anchors is unchanged', () => {
    expect(
      anchorTopic('Brook classic car 2010', 'what classic car did Brook offer for the 2010 filming?'),
    ).toBe('Brook classic car 2010');
  });

  test('all-lowercase questions add nothing (the common survival case)', () => {
    expect(anchorTopic('water', 'how much water should I bring')).toBe('water');
    expect(anchorTopic('anchor shade structure', 'how do I anchor my shade structure?')).toBe(
      'anchor shade structure',
    );
  });

  test('sentence-initial capitals and stopword-shaped capitals are not anchors', () => {
    expect(anchorTopic('greeters', 'Who are the greeters? What do they do?')).toBe('greeters');
    expect(anchorTopic('radio', 'The Is And Which radio channel')).toBe('radio');
  });

  test('ALL-CAPS acronyms are left to the model (MOOP already routes)', () => {
    expect(anchorTopic('trash', "what's MOOP?")).toBe('trash');
  });

  test('years anchor even sentence-initial; caps at 3 anchors total', () => {
    expect(anchorTopic('survey glitch', '2021 survey glitch?')).toBe('survey glitch 2021');
    expect(
      anchorTopic('story', 'remember when Alice met Bob and Carol and Dave in 2015'),
    ).toBe('story Alice Bob Carol');
  });

  test('duplicate anchors collapse; empty topic still gains anchors', () => {
    expect(anchorTopic('camp', 'was Brook with Brook at camp in 2024')).toBe('camp Brook 2024');
    expect(anchorTopic('', 'what did Ruckus say in 2021?')).toBe('Ruckus 2021');
  });

  test('empty question is a no-op', () => {
    expect(anchorTopic('water', '')).toBe('water');
  });
});
