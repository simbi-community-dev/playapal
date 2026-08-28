/**
 * Lineage ego view (src/facts/lineageView.ts) against a real camp pack's
 * graph files — the same lineage edges the phone draws.
 *
 * Camp packs are user data and none ships in this repo: point
 * CAMP_LORE_PACK_DIR at a local pack folder (nodes.json / edges.json /
 * pack.json) and the suite runs against it; unset, it skips cleanly. The
 * synthetic no-lineage checks always run. Assertions use display names,
 * never internal ids.
 */

import React from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { BASE_TABLES_SQL } from '../src/events/schema';
import { installPackFromFiles } from '../src/packs/installPack';
import { refreshFactGraph, type FactNodeRef } from '../src/facts/factGraph';
import { LineageScreen } from '../src/screens/LineageScreen';
import {
  describeEvidence,
  egoView,
  flagGlyph,
  hasLineageData,
  lineageRoots,
  lineageSearch,
  lineageTier,
  personFlags,
  topSponsors,
  type LineagePerson,
} from '../src/facts/lineageView';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs') as {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: string): string;
};
const path = require('path') as { join(...parts: string[]): string };
const env = (k: string): string => (globalThis as any).process?.env?.[k] || '';

const PACK_DIRS = [env('CAMP_LORE_PACK_DIR')].filter(Boolean);
const PACK_DIR = PACK_DIRS.find(
  d => fs.existsSync(path.join(d, 'pack.json')) && fs.existsSync(path.join(d, 'edges.json')),
);
const describePack = PACK_DIR ? describe : describe.skip;

function makeConn() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  };
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

let mockConn: ReturnType<typeof makeConn>;

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  isFtsAvailable: () => false,
}));

/** Exact name-or-alias hit — the way a camper would pick someone. */
function findPerson(name: string): LineagePerson {
  const hit = lineageSearch(name).find(
    p => p.name === name || p.aliases.includes(name),
  );
  if (!hit) {
    throw new Error(`no person named "${name}" in the installed pack`);
  }
  return hit;
}
const knownAs = (p: LineagePerson, name: string) => p.name === name || p.aliases.includes(name);
const links = <T extends { person: LineagePerson }>(list: T[], name: string): T[] =>
  list.filter(l => knownAs(l.person, name));

describePack('lineage ego view — the real private camp pack', () => {
  beforeAll(() => {
    mockConn = makeConn();
    const files = ['pack.json', 'nodes.json', 'edges.json'].map(name => ({
      name,
      content: fs.readFileSync(path.join(PACK_DIR!, name), 'utf8'),
    }));
    const res = installPackFromFiles(mockConn as any, files, {});
    expect(res.edges).toBeGreaterThan(0);
    refreshFactGraph(mockConn as any);
  });

  test('hasLineageData: true with the pack enabled, false once it is disabled', () => {
    expect(hasLineageData(mockConn as any)).toBe(true);
    expect(hasLineageData()).toBe(true); // default conn = the app db (mocked)
    mockConn.execute('UPDATE packs SET enabled = 0');
    expect(hasLineageData(mockConn as any)).toBe(false);
    mockConn.execute('UPDATE packs SET enabled = 1');
  });

  test("Pug: sponsor Jonathan Weisblatt (2009), sponsee Coco (2013), in human direction", () => {
    const pug = findPerson('Pug');
    const view = egoView(pug.ref)!;
    expect(view).not.toBeNull();
    expect(view.person.name).toMatch(/^(Pug|David Anderson)$/);
    expect(view.sponsor).not.toBeNull();
    expect(knownAs(view.sponsor!.person, 'Jonathan Weisblatt')).toBe(true);
    expect(view.sponsor!.year).toBe(2009);
    expect(view.sponsor!.tier).toBe('stated');
    expect(view.sponsor!.evidence_ref).toMatch(/^stated /);
    expect(view.sponsors).toHaveLength(1);
    const coco = links(view.sponsees, 'Coco');
    expect(coco).toHaveLength(1);
    expect(coco[0].year).toBe(2013);
    // Never a raw id where a camper reads a name.
    for (const l of [view.sponsor!, ...view.sponsees]) {
      expect(l.person.name).not.toMatch(/^person\./);
      expect(l.person.ref.id).toMatch(/^person\./);
    }
    expect(view.yearsAttended.length).toBeGreaterThan(0);
    expect(view.yearsAttended).toEqual([...view.yearsAttended].sort((a, b) => a - b));
  });

  test('Coco: sponsees include David Morley (2015) and Pamella Inveen (2023), sorted by year', () => {
    const view = egoView(findPerson('Coco').ref)!;
    expect(links(view.sponsees, 'David Morley')[0]?.year).toBe(2015);
    expect(links(view.sponsees, 'Pamella Inveen')[0]?.year).toBe(2023);
    const years = view.sponsees.map(s => s.year ?? Infinity);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    // Coco was sponsored by Pug — the same edge, seen from the other end.
    expect(knownAs(view.sponsor!.person, 'Pug') || knownAs(view.sponsor!.person, 'David Anderson')).toBe(true);
  });

  test('backwards-chain flag: Coco → Pamella (2023) vs Pamella → Cristina (2015)', () => {
    const pamella = findPerson('Pamella Inveen');
    const flags = personFlags(pamella.ref);
    const back = flags.filter(f => f.kind === 'backwards-chain');
    expect(back).toHaveLength(1);
    expect(back[0].why).toBe(
      'Pamella Inveen sponsored Cristina Young in 2015 but was sponsored in 2023 — one of these years is a statement date, not the event',
    );
    expect(back[0].about[0]).toBe(pamella.ref.id);
    expect(back[0].evidence_refs).toHaveLength(2);
    expect(flagGlyph(back[0].kind)).toBe('≠');
    // Pamella first attended 2016 < sponsorship 2023 → the second computed flag.
    const early = flags.filter(f => f.kind === 'sponsee-in-camp-before-sponsorship');
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ year: 2023, first_attended: 2016 });
    expect(flagGlyph(early[0].kind)).toBe('?');
    // The ego view carries them, and so does Pamella's card on Coco's tree.
    expect(egoView(pamella.ref)!.flags).toEqual(flags);
    const onCoco = links(egoView(findPerson('Coco').ref)!.sponsees, 'Pamella Inveen')[0];
    expect(onCoco.flags.map(f => f.kind)).toEqual(expect.arrayContaining(['backwards-chain']));
    // Pug: sponsored 2009, sponsored Coco 2013, first attended 2010 → clean.
    expect(personFlags(findPerson('Pug').ref)).toEqual([]);
  });

  test("lineageSearch('xtra') finds Krystal Wellman; prefix + word-prefix, case-insensitive", () => {
    expect(lineageSearch('xtra').some(p => knownAs(p, 'Krystal Wellman'))).toBe(true);
    expect(lineageSearch('XTRA').some(p => knownAs(p, 'Krystal Wellman'))).toBe(true);
    expect(lineageSearch('wellman').some(p => knownAs(p, 'Krystal Wellman'))).toBe(true);
    expect(lineageSearch('')).toEqual([]);
    expect(lineageSearch('zzzzqqq')).toEqual([]);
    // Exact hit ranks first among the prefix matches.
    expect(knownAs(lineageSearch('Coco')[0], 'Coco')).toBe(true);
  });

  test('roots sponsor others but are sponsored by no one; top sponsors are ordered by count', () => {
    const roots = lineageRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      const v = egoView(r.person.ref)!;
      expect(v.sponsors).toEqual([]);
      expect(v.sponsees.length).toBe(r.sponseeCount);
      expect(r.sponseeCount).toBeGreaterThan(0);
    }
    const top = topSponsors(8);
    expect(top).toHaveLength(8);
    const counts = top.map(t => t.sponseeCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    // Pug is sponsored (by Jonathan) so he is not a root; Jonathan's line
    // starts with Joey Levine in this pack (a root).
    expect(roots.some(r => knownAs(r.person, 'Pug'))).toBe(false);
  });

  test('a person with no sponsorship on record still gets a view (edge state, not an error)', () => {
    const lonely = lineageSearch('a').find(p => {
      const v = egoView(p.ref)!;
      return v.sponsors.length === 0 && v.sponsees.length === 0;
    });
    expect(lonely).toBeDefined();
    const v = egoView(lonely!.ref)!;
    expect(v.sponsor).toBeNull();
    expect(v.sponsees).toEqual([]);
    expect(v.flags).toEqual([]);
    const missing: FactNodeRef = { pack_id: 'nope', id: 'person.nobody' };
    expect(egoView(missing)).toBeNull();
  });

  test('LineageScreen smoke: start list → tap a person → tree with sponsor + sponsees → back', () => {
    const text = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number'
        ? String(v)
        : Array.isArray(v)
        ? v.map(text).join('')
        : v && typeof v === 'object' && 'children' in v
        ? text((v as { children?: unknown }).children)
        : '';
    const onBack = jest.fn();
    let r: ReactTestRenderer;
    act(() => {
      r = create(React.createElement(LineageScreen, { onBack }));
    });
    const screen = () => text(r.toJSON());
    const words = (inst: ReactTestInstance | string): string =>
      typeof inst === 'string' ? inst : inst.children.map(words).join('');
    const press = (label: string) => {
      // Pressable is wrapped (memo/forwardRef) under the RN jest preset, so
      // match on the onPress prop rather than the component type.
      // The tightest pressable reading the label = the chip, not the card
      // around it (a card's words include its own year chip's).
      const hit = r.root
        .findAll(n => typeof n.props.onPress === 'function')
        .filter(p => words(p).includes(label))
        .sort((a, b) => words(a).length - words(b).length)[0];
      if (!hit) {
        throw new Error(`no pressable reading "${label}"`);
      }
      act(() => hit.props.onPress());
    };
    expect(screen()).toContain('Start with someone');
    expect(screen()).toContain("Your camp's roots");
    const first = topSponsors(1)[0];
    expect(screen()).toContain(first.person.name);
    // Search, then re-center on Pug via the results list.
    act(() => r.root.findByType(TextInput).props.onChangeText('pug'));
    expect(screen()).not.toContain('Start with someone');
    press('Pug');
    const pug = egoView(findPerson('Pug').ref)!;
    const s = screen();
    expect(s).toContain(pug.sponsor!.person.name); // sponsor card above
    for (const l of pug.sponsees) {
      expect(s).toContain(l.person.name); // sponsee cards below
    }
    expect(s).toContain('2009');
    expect(s).toContain('‹ back');
    // Year chip → provenance sheet in words; flag chip → the why.
    press('2009');
    expect(screen()).toContain(`${pug.sponsor!.person.name} sponsored ${pug.person.name} · 2009`);
    expect(screen()).toContain('Where to check: said on 2010-06-17');
    press('Close');
    expect(screen()).not.toContain('Where to check');
    expect(pug.sponsor!.flags.map(f => f.kind)).toContain('backwards-chain'); // Jonathan: sponsored 2010, sponsored Pug 2009
    press('≠');
    expect(screen()).toContain('The years disagree');
    expect(screen()).toContain('one of these years is a statement date');
    press('Close');
    // Follow the line to Coco (a sponsee card), then back to Pug, then out.
    press('Coco');
    expect(screen()).toContain('David Morley');
    press('‹ back');
    expect(screen()).toContain(pug.sponsor!.person.name);
    press('‹ back');
    expect(screen()).toContain('Start with someone');
    press('‹ Camp');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('lineage — synthetic packs and evidence wording (always run)', () => {
  test('a 3-node pack with no sponsored_by edge → hasLineageData() false', () => {
    const conn = makeConn();
    installPackFromFiles(conn as any, [
      {
        name: 'pack.json',
        content: JSON.stringify({ id: 'test-facts', name: 'Test Facts', description: '', version: 1 }),
      },
      {
        name: 'nodes.json',
        content: JSON.stringify([
          { id: 'person:alex', type: 'person', name: 'Alex', attrs: { aliases: ['A'] } },
          { id: 'year:2024', type: 'year', name: '2024' },
          { id: 'project:shade', type: 'project', name: 'Shade Build' },
        ]),
      },
      {
        name: 'edges.json',
        content: JSON.stringify([
          { src: 'person:alex', dst: 'year:2024', type: 'attended', year: 2024, evidence_ref: 'roster 2024' },
          { src: 'person:alex', dst: 'project:shade', type: 'worked_on', year: 2024, evidence_ref: 'stated 2024-05-01 t1#1' },
        ]),
      },
    ]);
    expect(hasLineageData(conn as any)).toBe(false);
    conn.execute('DELETE FROM packs');
    expect(hasLineageData(conn as any)).toBe(false);
  });

  test('evidence_ref reads in words; tier is the ref grammar\'s leading token', () => {
    expect(describeEvidence('stated 2013-06-02 t001234#5')).toBe('said on 2013-06-02');
    expect(describeEvidence('roster 2013')).toBe('on the 2013 camp list');
    expect(describeEvidence('owner-stated 2026-08-01')).toBe('told to the app by the camp, 2026-08-01');
    expect(describeEvidence('said 2026-08-30 by Cricket')).toBe('said by Cricket on playa, 2026-08-30');
    expect(describeEvidence('fixture.md#x')).toBe('source recorded in the camp pack');
    expect(lineageTier('stated 2013-06-02 t001234#5')).toBe('stated');
    expect(lineageTier('roster 2013')).toBe('roster');
    expect(lineageTier('owner-stated 2026-08-01')).toBe('owner-stated');
    expect(lineageTier('said 2026-08-30 by Cricket')).toBe('stated-on-playa');
    expect(lineageTier('inferred t1#1')).toBe('inferred');
    expect(lineageTier('fixture.md#x')).toBe('unknown');
  });
});
