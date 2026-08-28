import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FactCard } from '../src/components/FactCard';
import type { FactCard as FactCardData } from '../src/types';

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join('');
  }
  if (value && typeof value === 'object' && 'children' in value) {
    return textContent((value as { children?: unknown }).children);
  }
  return '';
}

function render(fact: FactCardData): string {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<FactCard fact={fact} />);
  });
  return textContent(renderer!.toJSON());
}

describe('FactCard', () => {
  test('renders attendance values and provenance from structured data', () => {
    const output = render({
      kind: 'attendance',
      person: 'River Moon',
      years: [
        {
          year: 2023,
          pack_id: 'history',
          evidence_ref: 'history.md#river-2023',
        },
      ],
    });

    expect(output).toContain('River Moon · Attendance');
    expect(output).toContain('2023');
    expect(output).toContain('Source: source recorded in the camp pack');
  });

  test('renders relationship direction, year, and evidence without model prose', () => {
    const output = render({
      kind: 'path',
      from: 'River Moon',
      to: 'Drew',
      relationships: [
        {
          from: 'River Moon',
          to: 'Blair',
          year: 2019,
          pack_id: 'history',
          evidence_ref: 'history.md#river-blair',
        },
      ],
    });

    // Words in the human direction, never the storage arrow: the edge is
    // River Moon sponsored_by Blair, so the row reads "Blair sponsored River
    // Moon" (owner phone 2026-08-17: "Coco → Pug" under Pug's sponsees read
    // as the opposite of the fact).
    expect(output).toContain('Sponsorship path: River Moon to Drew');
    expect(output).toContain('Blair sponsored River Moon');
    expect(output).not.toContain('→');
    expect(output).toContain('2019');
    expect(output).toContain('Source: source recorded in the camp pack');
  });

  test('renders a camper identity from the pack, not from model prose', () => {
    const output = render({
      kind: 'person',
      name: 'Marisol Vega',
      alsoKnownAs: 'Marisol',
      aliases: ['Marisol'],
      tenure: { from: 'Mar 2010', to: 'Aug 2026' },
      summary:
        'Marisol Vega is a Dusty Star camper, active on the camp list from Mar 2010 to Aug 2026, with 657 list messages across 466 threads.',
      memoriam: null,
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#marisol-vega',
    });

    expect(output).toContain('Marisol Vega (Marisol)');
    expect(output).toContain('Mar 2010 – Aug 2026 on the camp list');
    expect(output).toContain('Also on the list as Marisol');
    expect(output).toContain('active on the camp list from Mar 2010');
    expect(output).toContain('Source: source recorded in the camp pack');
  });

  test('a memorial card leads with the camp’s remembrance, in past tense', () => {
    const output = render({
      kind: 'person',
      name: 'AJM',
      alsoKnownAs: 'Alex J Mercer',
      aliases: ['David T. Anderson'],
      tenure: { from: 'Apr 2010', to: 'Oct 2011' },
      summary:
        'AJM — Alex J Mercer on the camp list — was a Dusty Star camper, on the camp list from Apr 2010 to Oct 2011.',
      memoriam: 'In memoriam. The camp gathered for "AJM\'s Memorial" in 2013.',
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#ajm',
    });

    // Remembrance before any date or count, past-tense alias label, and no
    // message/thread volume anywhere on the card.
    expect(output.indexOf('In memoriam.')).toBeLessThan(
      output.indexOf('Apr 2010'),
    );
    expect(output).toContain('Also appeared on the list as David T. Anderson');
    expect(output).not.toMatch(/messages|threads/);
    // And NO evidence row: "dusty-star-lore-25y · people-dusty-star.md#ajm" under
    // the camp's goodbye is the database row this card is written against.
    // The provenance lives in the source chip below the message instead,
    // which names the pack in human words (components/SourceChips).
    expect(output).not.toContain('dusty-star-lore-25y');
    expect(output).not.toMatch(/\.md\b/);
  });

  test('a LIVING camper keeps the evidence line — there it is a citation', () => {
    const output = render({
      kind: 'person',
      name: 'Marisol Vega',
      alsoKnownAs: null,
      aliases: [],
      tenure: { from: 'Mar 2010', to: 'Aug 2026' },
      summary: 'Marisol Vega is a Dusty Star camper.',
      memoriam: null,
      pack_id: 'dusty-star-lore-25y',
      evidence_ref: 'people-dusty-star.md#marisol-vega',
    });

    expect(output).toContain('Source: source recorded in the camp pack');
  });
});
