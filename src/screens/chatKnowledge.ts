import type { PackRow } from '../types';

export function enabledKnowledgePacks(packs: PackRow[]): PackRow[] {
  return packs.filter(
    p =>
      p.enabled &&
      (p.eventCount > 0 ||
        p.chunkCount > 0 ||
        p.postCount > 0 ||
        p.nodeCount > 0 ||
        p.edgeCount > 0),
  );
}

/** Truthful first-run copy for the knowledge currently reachable by Angel. */
export function knowledgeEmptyState(packs: PackRow[]): string {
  const enabled = enabledKnowledgePacks(packs);
  if (enabled.length === 0) {
    return 'No offline knowledge is enabled yet. Open Packs to choose what the Angel can read.';
  }
  const kinds = [
    enabled.some(p => p.eventCount > 0) ? 'events' : null,
    enabled.some(p => p.chunkCount > 0 && p.postCount === 0)
      ? 'guides and stories'
      : null,
    enabled.some(p => p.postCount > 0) ? 'camp boards' : null,
    enabled.some(p => p.nodeCount > 0 || p.edgeCount > 0)
      ? 'people and camp history'
      : null,
  ].filter((k): k is string => k !== null);
  const readable =
    kinds.length === 1
      ? kinds[0]
      : kinds.length === 2
      ? `${kinds[0]} and ${kinds[1]}`
      : `${kinds.slice(0, -1).join(', ')}, and ${kinds[kinds.length - 1]}`;
  return `Ask about your enabled ${readable}. Everything answers offline.`;
}
