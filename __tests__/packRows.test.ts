/**
 * packRows shared-row behaviors (Option A consolidation): the two
 * presentation bugs the forensics found — same-name packs reading as
 * duplicates, and a dangling '· vN' separator on zero-count rows — plus the
 * board-pack id predicate that keeps camp-board packs out of the managed
 * rows. Pure-function coverage; the card component itself is thin.
 */
import {
  isBoardPack,
  packCountLine,
  packVersionNote,
} from '../src/screens/packRows';
import type { PackRow } from '../src/types';

const row = (over: Partial<PackRow>): PackRow =>
  ({
    id: 'pack-a',
    name: 'Camp Lore',
    version: 3,
    description: 'd',
    builtin: false,
    enabled: true,
    eventCount: 0,
    chunkCount: 0,
    postCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    ...over,
  } as PackRow);

describe('packVersionNote', () => {
  it('returns null when no other pack shares the name', () => {
    const p = row({ id: 'a', name: 'Solo' });
    expect(packVersionNote(p, [p, row({ id: 'b', name: 'Other' })])).toBeNull();
  });

  it('labels the older same-name copy with its provenance, not a bare vN', () => {
    const old = row({ id: 'a', version: 2 });
    const fresh = row({ id: 'b', version: 4 });
    expect(packVersionNote(old, [old, fresh])).toBe(
      'older copy (v2) — from a previous install or passphrase',
    );
  });

  it('labels the newest same-name copy with a plain version', () => {
    const old = row({ id: 'a', version: 2 });
    const fresh = row({ id: 'b', version: 4 });
    expect(packVersionNote(fresh, [old, fresh])).toBe('v4');
  });
});

describe('packCountLine', () => {
  it('never emits a dangling version separator on a zero-count row', () => {
    const p = row({ id: 'a' });
    const line = packCountLine(p, [p]);
    expect(line).not.toContain('v3');
    expect(line).toBe('');
  });

  it('shows the version note alone when a dupe row has no counts', () => {
    const old = row({ id: 'a', version: 2 });
    const fresh = row({ id: 'b', version: 4 });
    expect(packCountLine(old, [old, fresh])).toBe(
      'older copy (v2) — from a previous install or passphrase',
    );
  });

  it('joins counts and the note with a single separator', () => {
    const old = row({ id: 'a', version: 2, nodeCount: 12, edgeCount: 30 });
    const fresh = row({ id: 'b', version: 4 });
    expect(packCountLine(old, [old, fresh])).toBe(
      '12 facts · 30 relationships · older copy (v2) — from a previous install or passphrase',
    );
  });

  it('suppresses the guide-passage count when board posts carry the chunks', () => {
    const p = row({ id: 'a', chunkCount: 40, postCount: 9 });
    expect(packCountLine(p, [p])).toBe('9 board posts');
  });

  it('lists the counts that exist, in order', () => {
    const p = row({ id: 'a', eventCount: 5, chunkCount: 40, nodeCount: 2 });
    expect(packCountLine(p, [p])).toBe('5 events · 40 guide passages · 2 facts');
  });
});

describe('isBoardPack', () => {
  it('matches only the camp-board- id prefix', () => {
    expect(isBoardPack(row({ id: 'camp-board-deadbyte' }))).toBe(true);
    expect(isBoardPack(row({ id: 'camp-lore' }))).toBe(false);
  });
});
