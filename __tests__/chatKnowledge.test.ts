import {
  enabledKnowledgePacks,
  knowledgeEmptyState,
} from '../src/screens/chatKnowledge';
import type { PackRow } from '../src/types';

function pack(
  id: string,
  name: string,
  counts: Partial<
    Pick<PackRow, 'eventCount' | 'chunkCount' | 'postCount' | 'nodeCount' | 'edgeCount'>
  > = {},
  enabled = true,
): PackRow {
  return {
    id,
    name,
    description: '',
    version: 1,
    builtin: false,
    enabled,
    eventCount: counts.eventCount ?? 0,
    chunkCount: counts.chunkCount ?? 0,
    postCount: counts.postCount ?? 0,
    nodeCount: counts.nodeCount ?? 0,
    edgeCount: counts.edgeCount ?? 0,
  };
}

describe('Angel enabled-knowledge visibility', () => {
  test('excludes disabled and empty packs while preserving database order', () => {
    const packs = [
      pack('events', 'BRC Events', { eventCount: 10 }),
      pack('empty', 'Empty Import'),
      pack('off', 'Disabled Lore', { chunkCount: 20 }, false),
      pack('camp-board-hippo', 'Dusty Star Camp Board', { postCount: 3 }),
    ];
    expect(enabledKnowledgePacks(packs).map(p => p.name)).toEqual([
      'BRC Events',
      'Dusty Star Camp Board',
    ]);
  });

  test.each([
    [
      [pack('events', 'Events', { eventCount: 1 })],
      'Ask about your enabled events. Everything answers offline.',
    ],
    [
      [pack('guide', 'Guide', { chunkCount: 1 })],
      'Ask about your enabled guides and stories. Everything answers offline.',
    ],
    [
      [pack('board', 'Board', { chunkCount: 1, postCount: 1 })],
      'Ask about your enabled camp boards. Everything answers offline.',
    ],
    [
      [pack('history', 'History', { nodeCount: 4, edgeCount: 3 })],
      'Ask about your enabled people and camp history. Everything answers offline.',
    ],
  ])('describes one available knowledge category', (packs, expected) => {
    expect(knowledgeEmptyState(packs as PackRow[])).toBe(expected);
  });

  test('describes mixed enabled content without claiming disabled content', () => {
    const packs = [
      pack('events', 'Events', { eventCount: 1 }),
      pack('guide', 'Guide', { chunkCount: 1 }),
      pack('board', 'Board', { chunkCount: 1, postCount: 1 }),
    ];
    expect(knowledgeEmptyState(packs)).toBe(
      'Ask about your enabled events, guides and stories, and camp boards. Everything answers offline.',
    );
  });

  test('directs the user to Packs when no nonempty pack is enabled', () => {
    const packs = [
      pack('empty', 'Empty'),
      pack('off', 'Off', { eventCount: 1 }, false),
    ];
    expect(knowledgeEmptyState(packs)).toBe(
      'No offline knowledge is enabled yet. Open Packs to choose what the Angel can read.',
    );
  });
});
