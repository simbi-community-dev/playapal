/**
 * The events OR-rung relevance floor (owner field bug 2026-08-13: a MOOP
 * clarify follow-up surfaced a packing-for-exodus event card — an OR-only,
 * single-term match with no floor).
 */

jest.mock('../src/events/db', () => ({
  getDb: jest.fn(),
  isFtsAvailable: jest.fn(() => true),
}));

import { orRelevanceFloor } from '../src/events/searchEvents';
import { collectLadder } from '../src/events/ladder';
import type { EventRow } from '../src/types';

const event = (id: number, title: string, desc: string): EventRow => ({
  id,
  title,
  desc,
  day: 'Monday',
  date: '2026-08-31',
  time_start: '10:00',
  time_end: '',
  camp: 'Camp Test',
  location: '7:30 & G',
});

describe('orRelevanceFloor', () => {
  it('is disabled for single-term queries (OR == AND there)', () => {
    expect(orRelevanceFloor(['moop'])).toBeUndefined();
  });

  it('requires two distinct terms for multi-term queries', () => {
    const floor = orRelevanceFloor(['moop', 'trash', 'leave'])!;
    // One term only ("leave" via "leaving"): rejected.
    expect(floor(event(1, 'Packing for Exodus', 'Leaving on Sunday? Pack it right.'))).toBe(false);
    // Two terms ("moop" + "trash"): accepted.
    expect(floor(event(2, 'MOOP Sweep', 'Bring trash bags and gloves.'))).toBe(true);
    // Zero terms: rejected.
    expect(floor(event(3, 'Sunrise Yoga', 'Gentle flow at dawn.'))).toBe(false);
  });

  it('matches porter-stem variants via the 4-char prefix', () => {
    const floor = orRelevanceFloor(['packing', 'moop'])!;
    // "packing" matches "Pack it in" via the "pack" prefix; "moop" matches.
    expect(floor(event(4, 'MOOP 101', 'Pack it in, pack it out.'))).toBe(true);
  });
});

describe('collectLadder with a rung acceptor', () => {
  const rows = [
    event(1, 'MOOP Sweep', 'moop and trash pickup'),
    event(2, 'Packing for Exodus', 'leaving town'),
  ];
  const conn = {
    execute: () => ({
      rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
    }),
  } as any;

  it('skips rows the acceptor rejects, keeps the rest, fills to limit', () => {
    const floor = orRelevanceFloor(['moop', 'trash'])!;
    const out = collectLadder<'fts-or', EventRow>(
      conn,
      [{ q: { sql: 'SELECT', params: [] }, strategy: 'fts-or', accept: floor as any }],
      5,
    );
    expect(out.rows.map(r => r.id)).toEqual([1]);
    expect(out.strategy).toBe('fts-or');
  });

  it('a rejected row is NOT consumed — a later floorless rung may accept it', () => {
    const floor = () => false;
    const out = collectLadder<'fts-or' | 'like-or', EventRow>(
      conn,
      [
        { q: { sql: 'SELECT', params: [] }, strategy: 'fts-or', accept: floor },
        { q: { sql: 'SELECT', params: [] }, strategy: 'like-or' },
      ],
      5,
    );
    expect(out.rows).toHaveLength(2);
    expect(out.strategy).toBe('like-or');
  });
});
