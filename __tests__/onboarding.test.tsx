/**
 * First-run onboarding (0.7.3): three skippable steps — welcome, optional
 * name, camp picker over the enabled packs' camp directory with freehand
 * fallback — persisting display_name / home_camp_name / home_camp_location
 * and the onboarding_done flag through the settings KV. Pins: welcome shows
 * first; Skip on the name step advances without keeping a name; the picker
 * filters the directory; freehand camp text is kept even when it matches no
 * row; "Let's go" persists all three settings plus the done flag; and
 * campDirectory dedupes by camp name keeping the first non-empty location.
 */
import React from 'react';
import { OnboardingFlow } from '../src/onboarding/OnboardingFlow';
import {
  campDirectory,
  markOnboardingDone,
  onboardingDone,
} from '../src/onboarding/onboarding';

// The settings KV as a map, the events table as canned camp rows — the
// module's whole db surface (getSetting/setSetting/getDb().execute).
const mockSettings = new Map<string, string>();
let mockCampRows: { camp: string; location: string }[] = [];

jest.mock('../src/events/db', () => ({
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
  getDb: () => ({
    execute: () => ({
      rows: {
        _array: mockCampRows,
        length: mockCampRows.length,
        item: (i: number) => mockCampRows[i],
      },
    }),
  }),
}));

// The geometry/address seam and the my-card seam, stubbed. waypoints is
// deliberately NOT mocked: the pin-seeding tests assert the REAL savePin
// wrote its JSON through the settings mock above.
jest.mock('../src/geo/cityGeometry', () => ({
  getCityGeometry: () => ({ bearingDeg: 315 }),
}));
jest.mock('../src/geo/brcGeo', () => ({
  addressToLatLon: (address: string) =>
    address ? { lat: 40.78, lon: -119.2, label: address } : null,
}));
const mockMyCard: { name: string; saved: object | null } = {
  name: '',
  saved: null,
};
jest.mock('../src/friends/friendCard', () => ({
  getMyCard: () => ({ name: mockMyCard.name }),
  saveMyCard: (_conn: unknown, fields: object) => {
    mockMyCard.saved = fields;
  },
}));

// The static full-roster index (0.7.4) — empty by default so the original
// events-derived cases keep testing that path alone.
let mockIndexRows: { camp: string; location: string }[] = [];
jest.mock('../src/onboarding/campIndex', () => ({
  campIndex: () => mockIndexRows,
}));

const TestRenderer = require('react-test-renderer');

function render(onDone: () => void = () => {}) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(<OnboardingFlow onDone={onDone} />);
  });
  return root;
}

function textOf(root: any): string {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => String(t.props.children))
    .join('\n');
}

function press(root: any, label: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => String(t.props.children) === label);
  expect(text).toBeTruthy();
  let node: any = text;
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  TestRenderer.act(() => node.props.onPress());
}

function typeInto(root: any, placeholder: string, value: string) {
  const input = root.root
    .findAllByType(require('react-native').TextInput)
    .find((t: any) => t.props.placeholder === placeholder);
  expect(input).toBeTruthy();
  TestRenderer.act(() => input.props.onChangeText(value));
}

beforeEach(() => {
  mockSettings.clear();
  mockMyCard.name = '';
  mockMyCard.saved = null;
  mockIndexRows = [];
  mockCampRows = [
    { camp: 'Camp Threat', location: '' },
    { camp: 'Mudskipper Cafe', location: '9:00 & G' },
    { camp: 'Sunrise Saloon', location: '4:30 & E' },
  ];
});

describe('the first-run flow', () => {
  it('opens on the welcome step, with onboarding not yet done', () => {
    const t = textOf(render());
    expect(t).toContain('Welcome to Playa Pal');
    expect(t).toContain('Nothing you type leaves this phone');
    expect(onboardingDone()).toBe(false);
  });

  it('the name step is optional — Skip advances and keeps no name', () => {
    const root = render();
    press(root, 'Next'); // welcome -> name
    expect(textOf(root)).toContain('What do your campmates call you?');
    typeInto(root, 'Your name', 'Dus'); // half-typed, then skipped
    press(root, 'Skip'); // name -> camp, discarding the text
    expect(textOf(root)).toContain('Where are you camped?');
    press(root, "Let's go");
    expect(mockSettings.has('display_name')).toBe(false);
  });

  it('the camp picker filters the directory as you type', () => {
    const root = render();
    press(root, 'Next');
    press(root, 'Skip');
    expect(textOf(root)).toContain('Sunrise Saloon · 4:30 & E');
    typeInto(root, 'Search camps, or type your own', 'mud');
    const t = textOf(root);
    expect(t).toContain('Mudskipper Cafe · 9:00 & G');
    expect(t).not.toContain('Sunrise Saloon');
  });

  it('freehand camp text is kept even when it matches no row', () => {
    const root = render();
    press(root, 'Next');
    press(root, 'Skip');
    typeInto(root, 'Search camps, or type your own', 'Camp Nowhere');
    press(root, "Let's go");
    expect(mockSettings.get('home_camp_name')).toBe('Camp Nowhere');
    // '' on purpose, never a stale directory address: a replay that changes
    // camp freehand must clear the old camp's location with it.
    expect(mockSettings.get('home_camp_location')).toBe('');
  });

  it("Let's go persists name, camp, location, and the done flag", () => {
    const onDone = jest.fn();
    const root = render(onDone);
    press(root, 'Next');
    typeInto(root, 'Your name', 'Dusty');
    press(root, 'Next');
    typeInto(root, 'Search camps, or type your own', 'mud');
    press(root, 'Mudskipper Cafe · 9:00 & G');
    press(root, "Let's go");
    expect(mockSettings.get('display_name')).toBe('Dusty');
    expect(mockSettings.get('home_camp_name')).toBe('Mudskipper Cafe');
    expect(mockSettings.get('home_camp_location')).toBe('9:00 & G');
    expect(mockSettings.get('onboarding_done')).toBe('1');
    expect(onboardingDone()).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Skip setup on the welcome step finishes without saving anything', () => {
    const onDone = jest.fn();
    const root = render(onDone);
    press(root, 'Skip setup');
    expect(mockSettings.get('onboarding_done')).toBe('1');
    expect(mockSettings.has('display_name')).toBe(false);
    expect(mockSettings.has('home_camp_name')).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('what a camp choice composes into (0.7.3 integration)', () => {
  const pickDirectoryCamp = (root: any) => {
    press(root, 'Next'); // welcome -> name
    press(root, 'Skip'); // name -> camp
    typeInto(root, 'Search camps, or type your own', 'mud');
    press(root, 'Mudskipper Cafe · 9:00 & G');
    press(root, "Let's go");
  };

  it('a directory camp with an address seeds the Home pin at that spot', () => {
    pickDirectoryCamp(render());
    const pins = JSON.parse(mockSettings.get('saved_waypoints')!);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ label: 'Home', lat: 40.78, lon: -119.2 });
  });

  it('a freehand camp (no address) seeds NO pin', () => {
    const root = render();
    press(root, 'Next');
    press(root, 'Skip');
    typeInto(root, 'Search camps, or type your own', 'Camp Nowhere');
    press(root, "Let's go");
    expect(mockSettings.has('saved_waypoints')).toBe(false);
  });

  it('name + camp seed a BLANK my-card so nothing is typed twice', () => {
    const root = render();
    press(root, 'Next');
    typeInto(root, 'Your name', 'Dusty');
    press(root, 'Next');
    typeInto(root, 'Search camps, or type your own', 'mud');
    press(root, 'Mudskipper Cafe · 9:00 & G');
    press(root, "Let's go");
    expect(mockMyCard.saved).toEqual({
      name: 'Dusty',
      camp: 'Mudskipper Cafe',
      address: '9:00 & G',
      note: '',
    });
  });

  it('a my-card the user already wrote is never touched', () => {
    mockMyCard.name = 'Already Named';
    const root = render();
    press(root, 'Next');
    typeInto(root, 'Your name', 'Dusty');
    press(root, 'Next');
    press(root, "Let's go");
    expect(mockMyCard.saved).toBeNull();
  });

  it('no name means no card seed — a nameless card is rejected on reload', () => {
    pickDirectoryCamp(render());
    expect(mockMyCard.saved).toBeNull();
  });
});

describe('the onboarding logic module', () => {
  it('onboardingDone flips true after markOnboardingDone', () => {
    expect(onboardingDone()).toBe(false);
    markOnboardingDone();
    expect(onboardingDone()).toBe(true);
  });

  it('a placed camp hosting NO events still appears, from the index (the owner field-test class)', () => {
    mockIndexRows = [
      { camp: 'Quiet Sky Collective', location: '5:00 & F' },
      { camp: 'Camp Threat', location: '3:15 & B' }, // also hosts events (row above)
    ];
    const dir = campDirectory();
    expect(dir.some(c => c.camp === 'Quiet Sky Collective' && c.location === '5:00 & F')).toBe(true);
    // union, not replacement: event-derived camps survive alongside
    expect(dir.some(c => c.camp === 'Mudskipper Cafe')).toBe(true);
    // the index's official placement fills an events-side blank
    expect(dir.find(c => c.camp === 'Camp Threat')?.location).toBe('3:15 & B');
    // one row per camp, alphabetical
    expect(dir.filter(c => c.camp === 'Camp Threat')).toHaveLength(1);
    const names = dir.map(c => c.camp.toLowerCase());
    expect([...names].sort()).toEqual(names);
  });

  it('campDirectory dedupes by camp name, keeping the first non-empty location', () => {
    mockCampRows = [
      { camp: 'Sunrise Saloon', location: '' },
      { camp: 'sunrise saloon', location: '4:30 & E' },
      { camp: 'Sunrise Saloon', location: '4:45 & E' },
    ];
    expect(campDirectory()).toEqual([
      { camp: 'Sunrise Saloon', location: '4:30 & E' },
    ]);
  });
});
