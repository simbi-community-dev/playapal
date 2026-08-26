import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { EventCard } from '../src/components/EventCard';

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'children' in value) {
    return text((value as { children?: unknown }).children);
  }
  return '';
}

// IA adaptation (integration 2026-08-25): this branch's EventCard carries
// the favorites heart, which reads the real db at render. The ported
// suite asserts the DATE LINE, not favorites — an inert store keeps the
// original assertions meaningful without dragging op-sqlite into jest.
jest.mock('../src/events/favorites', () => ({
  favKey: (e: { title: string }) => e.title,
  favoriteKeySet: () => new Set<string>(),
  favoritesRevision: () => 0,
  subscribeFavoritesChanged: () => () => undefined,
  toggleFavorite: () => undefined,
}));
jest.mock('../src/events/db', () => ({
  getDb: () => {
    throw new Error('EventCard suite must not reach the real db');
  },
  hideItem: () => undefined,
}));

describe('EventCard authoritative date', () => {
  it('renders the exact structured date alongside weekday and time', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EventCard
          event={{
            id: 1,
            title: 'Sunrise Yoga',
            desc: 'Gentle movement.',
            day: 'Thursday',
            date: '2026-09-03',
            time_start: '07:00',
            time_end: '08:00',
            camp: 'Test Camp',
            location: '7:30 & G',
          }}
        />,
      );
    });
    expect(text(renderer!.toJSON())).toContain(
      'Thursday, September 3, 2026 · 07:00–08:00',
    );
  });
});
