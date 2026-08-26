/**
 * SOURCE-CHIP interaction tests — the owner's "real and tappable so you can
 * see why it said something", pinned at the surface.
 *
 * Collapsed, a chip names the document and its pack and shows NO passage
 * text (the wall-of-citations failure). One tap opens the passage the model
 * read; a second closes it. Under a memorial the row speaks in the camp's
 * register, not a citation's. Touch targets are generous enough for one
 * dusty thumb at night — asserted on the style, since that is the only
 * device fact a unit test can hold.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SourceChips } from '../src/components/SourceChips';
import type { SourceRef } from '../src/types';

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

const WATER: SourceRef = {
  id: 'survival-guide:12',
  pack: 'Survival Guide',
  doc: 'Water',
  heading: 'Survival Guide > Water',
  passage: 'Bring 1.5 gallons of water per person per day.',
  memorial: false,
};

const AJM: SourceRef = {
  id: 'dusty-star-lore-25y:88',
  pack: 'Dusty Star 25 Years',
  doc: 'Who is AJM?',
  heading: 'Campers > AJM (Alex J Mercer) — Dusty Star camper > Who is AJM?',
  passage:
    'In memoriam. The camp gathered for "AJM\'s Memorial" in 2013 — Papa AJM to his hippo family.',
  memorial: false,
};

function mount(sources: SourceRef[]) {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<SourceChips sources={sources} />);
  });
  const r = renderer!;
  // The Pressable itself: the one node carrying both the press handler and
  // the button role (its rendered host Views carry the role but no onPress).
  const chips = () =>
    r.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        node.props?.accessibilityRole === 'button',
    );
  return {
    text: () => textContent(r.toJSON()),
    chips,
    style: (index: number) => StyleSheet.flatten(chips()[index].props.style),
    tap: (index: number) => {
      const chip = chips()[index];
      act(() => {
        chip.props.onPress();
      });
    },
  };
}

describe('SourceChips', () => {
  test('collapsed, a chip names the document and pack and hides the passage', () => {
    const ui = mount([WATER]);

    expect(ui.text()).toContain('Where this came from');
    expect(ui.text()).toContain('Water');
    expect(ui.text()).toContain('Survival Guide');
    // Quiet by default: the passage is behind the tap, not under the answer.
    expect(ui.text()).not.toContain('1.5 gallons');
  });

  test('a tap opens the passage the model read; a second tap closes it', () => {
    const ui = mount([WATER]);

    ui.tap(0);
    expect(ui.text()).toContain('Bring 1.5 gallons of water per person per day.');
    // The full breadcrumb rides along, so the passage keeps its place.
    expect(ui.text()).toContain('Survival Guide > Water');

    ui.tap(0);
    expect(ui.text()).not.toContain('1.5 gallons');
  });

  test('chips open independently, one row per passage', () => {
    const ui = mount([WATER, { ...AJM, memorial: false }]);

    expect(ui.chips()).toHaveLength(2);
    ui.tap(1);
    expect(ui.text()).toContain('Papa AJM to his hippo family');
    expect(ui.text()).not.toContain('1.5 gallons');
  });

  test('one dusty thumb: every chip is a generous target, no precision needed', () => {
    const ui = mount([WATER, AJM]);

    for (let i = 0; i < ui.chips().length; i++) {
      expect(ui.style(i).minHeight).toBeGreaterThanOrEqual(44);
      // Dark ink on the card ground — never a low-contrast grey link.
      expect(ui.style(i).backgroundColor).toBe('#EFE6D8');
    }
  });

  test('a chip is a labelled button that announces its open state', () => {
    const ui = mount([WATER]);

    expect(ui.chips()[0].props.accessibilityRole).toBe('button');
    expect(ui.chips()[0].props.accessibilityState).toEqual({ expanded: false });
    expect(ui.chips()[0].props.accessibilityLabel).toBe(
      'Read the passage from Water',
    );

    ui.tap(0);
    expect(ui.chips()[0].props.accessibilityState).toEqual({ expanded: true });
  });

  test('MEMORIAL REGISTER: provenance for the departed is the camp speaking', () => {
    const ui = mount([{ ...AJM, memorial: true }]);

    // Not a citation header, and not a database row anywhere on the row.
    expect(ui.text()).toContain('In the camp’s own words');
    expect(ui.text()).not.toContain('Where this came from');
    expect(ui.text()).not.toContain('dusty-star-lore-25y');
    expect(ui.text()).not.toMatch(/\.md\b/);

    // The remembrance is still one tap away, and the edge is the memorial
    // card's own sage, never the record accent.
    ui.tap(0);
    expect(ui.text()).toContain('Papa AJM to his hippo family');
    // sage, not clay — deepened 2026-08-24 (a11y contrast fold: 4.5:1+ as
    // small text on every light ground; same dusty-sage hue).
    expect(ui.style(0).borderLeftColor).toBe('#5F6B47');
  });

  test('an answer with no retrieval behind it shows nothing at all', () => {
    const ui = mount([]);

    expect(ui.text()).toBe('');
  });
});
