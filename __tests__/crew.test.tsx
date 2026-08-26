/**
 * Crew, Phase A (docs/CREW-DESIGN.md §4): a named subset of the friend cards
 * you already hold, one settings-row store + a top-of-section UI. Pins: the
 * store replaces by id (never by name — same-name crews coexist), notifies
 * through the revision emitter, and survives a corrupt row; the section
 * shows the quiet invite card until a crew exists, builds one through the
 * inline name + member picker, renders member rows with "last confirmed"
 * said humanely, fires the compass with parsed address coords, and — the
 * Phase B seam — lets a presenceFor prop flip a row live and steer the
 * compass with presence coords instead.
 */
import React from 'react';

// The settings KV as a map (the crew store's whole db surface) plus a stub
// conn for the component's getDb() call.
//
// The conn swallows writes and answers reads from `mockRecords` — empty by
// default, which is the picked-cards-only world most of these assertions
// were written for, and one announcement row when a test is about the
// shared roster. The store's real behavior runs on the shipped DDL under
// node:sqlite in podMembers.test.ts; this suite is about what CrewSection
// RENDERS.
const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
  getDb: () => ({
    execute: (sql: string, params: unknown[] = []) => {
      // One SELECT is served for real: the member-announcement read
      // (recordsOfKind), so a test can put a podmate's hello on this
      // phone. `kind` is that query's last parameter. Everything else --
      // id lookups, inserts -- answers empty and swallows.
      const rows =
        /FROM crew_messages/.test(sql) && /kind = \?/.test(sql)
          ? mockRecords.filter(r => r.kind === params[params.length - 1])
          : [];
      return {
        rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
      };
    },
  }),
}));

/** crew_messages rows this phone "carries" for the test at hand. */
const mockRecords: any[] = [];

// Friend cards, my card, and the export lane the swap action rides.
let mockFriends: any[] = [];
const mockMe: any = {};
const mockCardJson = '{"kind":"playapal-friend-card","format":1,"cards":[]}';
jest.mock('../src/friends/friendCard', () => ({
  listFriends: () => mockFriends,
  getMyCard: () => mockMe,
  subscribeFriendsChanged: () => () => {},
  exportMyCard: () => mockCardJson,
}));

// Geometry + address seams: anything with an '&' parses to one fixed spot.
jest.mock('../src/geo/cityGeometry', () => ({
  getCityGeometry: () => ({ bearingDeg: 315 }),
}));
jest.mock('../src/geo/brcGeo', () => ({
  addressToLatLon: (address: string) =>
    address.includes('&') || /center camp/i.test(address)
      ? { lat: 40.78, lon: -119.2, label: address }
      : null,
  gpsVector: () => ({ distanceFt: 850, bearingDeg: 90 }),
  formatDistanceFt: (ft: number) => `${Math.round(ft)} ft`,
}));
jest.mock('../src/rightnow/playaWalk', () => ({
  playaWalkMinutes: () => 12,
}));

// The Message and Talk strips are stubbed here ON PURPOSE: they run REAL
// SQL (crew_messages) against their own node:sqlite harness in
// podMessages.test.tsx, and this suite's db mock is a settings Map. This
// file tests CrewSection's own behavior; the strips are composition.
jest.mock('../src/crews/PodMessages', () => ({
  PodMessages: () => null,
}));
jest.mock('../src/crews/WalkiePanel', () => ({
  WalkiePanel: () => null,
}));

import {
  crewsRevision,
  joinCrew,
  listCrews,
  newCrew,
  newCrewCode,
  removeCrew,
  saveCrew,
  subscribeCrewsChanged,
} from '../src/crews/crew';
import { encodeMemberBody, resetAnnounceGuard } from '../src/crews/podMembers';
import { hash32 } from '../src/crews/beacon';

import { agoPhrase, CrewSection } from '../src/crews/CrewSection';

const TestRenderer = require('react-test-renderer');

/** One podmate's hello, as the store row a sync would have written. */
const announcement = (
  code: string,
  cardId: string,
  name: string,
  agoMin = 0,
  podName?: string,
) => ({
  id: `${cardId}-hello`,
  crew_code: code,
  from_hash: hash32(cardId),
  to_hash: null,
  kind: 'pod-member',
  body: encodeMemberBody({ cardId, name, podName }),
  mime: '',
  created_min: Math.floor(Date.now() / 60000) - agoMin,
  expires_min: Math.floor(Date.now() / 60000) + 10080,
  hops: 1,
  origin: 'heard',
  read_at: null,
});


const HOUR = 3600e3;
const DAY = 24 * HOUR;

const alex = (updated_at = '') => ({
  id: 'aaaa1111',
  seq: 1,
  name: 'Alex',
  camp: 'Mudskipper Cafe',
  address: '7:32 & C',
  note: '',
  updated_at,
  scope: 'crew',
});
const sam = () => ({
  id: 'bbbb2222',
  seq: 1,
  name: 'Sam',
  camp: '',
  address: 'by the big speaker stack',
  note: '',
  updated_at: '',
  scope: 'crew',
});

function flatText(children: any): string {
  if (Array.isArray(children)) {
    return children.map(flatText).join('');
  }
  if (children === null || children === undefined) {
    return '';
  }
  // Nested <Text> elements surface as their own instances in findAllByType.
  return typeof children === 'object' ? '' : String(children);
}

function textOf(root: any): string {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => flatText(t.props.children))
    .join('\n');
}

function pressNode(text: any) {
  let node: any = text;
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  // BRACES, NOT AN ARROW-RETURN: an async onPress (swapCards) would make
  // the arrow return a promise, act() would treat the call as an async act,
  // and the un-awaited scope-exit then interleaves into the NEXT act and
  // unmounts its renderer — the full-gate-only "Can't access .root on
  // unmounted test renderer" (React's own warning named it: "You called
  // act(async () => ...) without await", Aug 24 gate log).
  TestRenderer.act(() => {
    void node.props.onPress();
  });
}

function press(root: any, label: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children) === label);
  expect(text).toBeTruthy();
  pressNode(text);
}

/** Open a circled ? by the label it ANNOUNCES (the Tufte pass, 2026-08-26).
 * By its label and not by its glyph on purpose: this card can carry several
 * of them, "?" identifies none of them, and the label is what a screen
 * reader navigates by — so a press that finds nothing here is a glyph
 * nobody could have found either. */
function pressInfo(root: any, label: string) {
  const glyph = root.root.find(
    (n: any) =>
      n.props?.accessibilityLabel === label &&
      typeof n.props?.onPress === 'function',
  );
  expect(glyph).toBeTruthy();
  TestRenderer.act(() => glyph.props.onPress());
}

function pressContaining(root: any, fragment: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children).includes(fragment));
  expect(text).toBeTruthy();
  pressNode(text);
}

function nameInput(root: any) {
  return root.root
    .findAllByType(require('react-native').TextInput)
    .find((t: any) => t.props.placeholder === 'Pod name');
}

/**
 * Roots are tracked and unmounted after every test. Without this they
 * accumulate still-subscribed across tests, every later saveCrew() outside
 * act() re-renders the whole graveyard, and one stale root dying mid-update
 * unmounted the CURRENT test's renderer ("Can't access .root on unmounted
 * test renderer" in whichever test ran late enough — measured on the gate,
 * Aug 24).
 */
const liveRoots: any[] = [];

function renderSection(props: {
  onOpenCompass?: (t: any) => void;
  presenceFor?: (cardId: string) => any;
} = {}) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(
      <CrewSection
        onOpenCompass={props.onOpenCompass ?? (() => {})}
        presenceFor={props.presenceFor}
      />,
    );
  });
  liveRoots.push(root);
  return root;
}

beforeEach(() => {
  mockSettings.clear();
  // The announce spin-guard is module state that outlives a test (it has
  // to: it guards a UI effect against a store that cannot read back).
  resetAnnounceGuard();
  mockRecords.length = 0;
  mockFriends = [alex(), sam()];
  Object.assign(mockMe, {
    id: 'ffff0000',
    seq: 1,
    name: 'Dusty',
    camp: 'Sunrise Saloon',
    address: '4:30 & E',
    note: '',
    updated_at: '',
    scope: 'crew',
  });
});

afterEach(() => {
  TestRenderer.act(() => {
    for (const r of liveRoots) {
      r.unmount();
    }
  });
  liveRoots.length = 0;
  jest.restoreAllMocks();
});

describe('the crew store', () => {
  test('create, replace by id, remove — crews key on id, never name', () => {
    const a = saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0].memberIds).toEqual(['aaaa1111']);
    // Replace by id: same crew, new fields, join code carried verbatim.
    saveCrew({ ...a, name: 'Dusk patrol', memberIds: ['aaaa1111', 'bbbb2222'] });
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0].name).toBe('Dusk patrol');
    expect(listCrews()[0].code).toBe(a.code);
    // Same name, different id: coexists — NOT the waypoints label-replace.
    const b = saveCrew(newCrew('dusk patrol'));
    expect(listCrews()).toHaveLength(2);
    removeCrew(b.id);
    expect(listCrews().map(c => c.id)).toEqual([a.id]);
  });

  test('a blank name falls back and duplicate member ids collapse', () => {
    const c = saveCrew(newCrew('   ', ['aaaa1111', 'aaaa1111']));
    expect(c.name).toBe('My pod');
    expect(c.memberIds).toEqual(['aaaa1111']);
  });

  test('a corrupt settings row starts clean rather than crash', () => {
    mockSettings.set('crews', 'not json');
    expect(listCrews()).toEqual([]);
    mockSettings.set('crews', '{"a":1}');
    expect(listCrews()).toEqual([]);
    mockSettings.set('crews', '[{"id":"x"},7]'); // malformed entries filtered
    expect(listCrews()).toEqual([]);
  });

  test('saves and removes notify subscribers and bump the revision', () => {
    const before = crewsRevision();
    const fired = jest.fn();
    const off = subscribeCrewsChanged(fired);
    const c = saveCrew(newCrew('Dawn patrol'));
    expect(fired).toHaveBeenCalledTimes(1);
    expect(crewsRevision()).toBeGreaterThan(before);
    removeCrew(c.id);
    expect(fired).toHaveBeenCalledTimes(2);
    off();
    saveCrew(newCrew('Another'));
    expect(fired).toHaveBeenCalledTimes(2);
  });

  test('join codes are 4-digit PINs, leading zeros kept', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newCrewCode();
      // A STRING at every layer: "0042" parsed as a number would join a
      // different pod than the one that was said out loud.
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^\d{4}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(50); // spread, not a constant
  });
});

describe('agoPhrase — "last confirmed", said like a person', () => {
  const now = Date.parse('2026-08-26T20:00:00Z');

  test('minutes and hours', () => {
    expect(agoPhrase(now - 20e3, now)).toBe('just now');
    expect(agoPhrase(now - 25 * 60e3, now)).toBe('25m ago');
    expect(agoPhrase(new Date(now - 2 * HOUR).toISOString(), now)).toBe(
      '2h ago',
    );
  });

  test('days inside a week read as a weekday name', () => {
    const t = now - 3 * DAY;
    const phrase = agoPhrase(t, now);
    expect(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).toContain(
      phrase,
    );
    // The weekday is the timestamp's own (in the phone's zone), not today's.
    expect(phrase).not.toBe(agoPhrase(now - 60e3, now));
  });

  test('older than a week reads as a short date', () => {
    expect(agoPhrase(now - 30 * DAY, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  test('a non-time is null, never a fake phrase', () => {
    expect(agoPhrase('', now)).toBeNull();
    expect(agoPhrase('address TBD', now)).toBeNull();
  });
});

describe('CrewSection — no crew yet', () => {
  test('one quiet card: the invite copy and a Start button, nothing else', () => {
    const root = renderSection();
    const t = textOf(root);
    expect(t).toContain('Pod');
    // THE LEDE STAYS. Someone with no pod needs to be told what a pod IS,
    // and that sentence is the whole card's reason. Mutation: sweep it
    // behind the ? with the rest and the empty state explains nothing.
    expect(t).toContain(
      'Your pod is the people whose phones stay in touch — for a night, a day, or the whole camp all week.',
    );
    expect(t).toContain('Start a pod');
    expect(t).not.toContain('Share code');

    // …and what a pod LOOKS like once you have one moved behind the ?
    // (the Tufte pass, 2026-08-26). This assertion followed the sentence
    // rather than being deleted: the promise is that a curious camper can
    // still reach it, and only a press proves that in the real tree.
    expect(t).not.toContain('One glance: which way, how far.');
    pressInfo(root, 'More about what a pod shows you');
    expect(textOf(root)).toContain('One glance: which way, how far.');
  });

  test('Start a pod: default name, member picker over friend cards, Save persists', () => {
    const root = renderSection();
    press(root, 'Start a pod');
    expect(nameInput(root).props.value).toBe('My pod');
    const t = textOf(root);
    expect(t).toContain('Alex');
    expect(t).toContain(' · Mudskipper Cafe'); // name + camp on the row
    press(root, 'Alex'); // check the box
    press(root, 'Save pod');
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0].memberIds).toEqual(['aaaa1111']);
    // The section flipped to the crew header live, without a remount.
    const after = textOf(root);
    expect(after).toContain('My pod');
    expect(after).toContain('Share code');
    expect(after).toContain(listCrews()[0].code);
    expect(after).toContain(
      'Campmates join with this code — same code, same pod.',
    );
  });
});

describe('CrewSection — with a crew', () => {
  test('member rows: where line, walk time, and "last confirmed" from the card', () => {
    mockFriends = [alex(new Date(Date.now() - 2 * HOUR).toISOString()), sam()];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111', 'bbbb2222']));
    const t = textOf(renderSection());
    expect(t).toContain('Dawn patrol');
    // "SO FAR", never a total: membership lives in the gossiped log, so
    // this phone reports what has reached it (the "Dust Bunnies — 0 people"
    // lesson — a local pick list rendered as the pod's size).
    expect(t).toContain('2 so far');
    expect(t).not.toContain('2 people');
    expect(t).toContain('🧭 7:32 & C — Mudskipper Cafe · ~12 min walk');
    expect(t).toContain('last confirmed 2h ago');
    // Sam's address does not parse: honest words, no dead compass affordance.
    expect(t).toContain('by the big speaker stack');
    expect((t.match(/🧭/g) ?? []).length).toBe(1);
    expect(t).toContain('not confirmed yet — swap cards when you meet');
  });

  test('compass tap fires with the parsed coords, labeled with the person', () => {
    mockFriends = [alex()];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const onOpenCompass = jest.fn();
    const root = renderSection({ onOpenCompass });
    pressContaining(root, '7:32 & C');
    expect(onOpenCompass).toHaveBeenCalledWith({
      label: 'Alex',
      lat: 40.78,
      lon: -119.2,
    });
  });

  test('presenceFor flips a row live and the compass uses THOSE coords', () => {
    mockFriends = [alex(new Date(Date.now() - 2 * HOUR).toISOString())];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const onOpenCompass = jest.fn();
    const now = Date.now();
    const presenceFor = (cardId: string) =>
      cardId === 'aaaa1111'
        ? {
            atMs: now,
            live: true,
            pos: { lat: 40.7901, lon: -119.21, atMs: now },
          }
        : null;
    const root = renderSection({ onOpenCompass, presenceFor });
    const t = textOf(root);
    expect(t).toContain('live · 850 ft away'); // my card's address anchors "how far"
    expect(t).not.toContain('last confirmed');
    pressContaining(root, '7:32 & C');
    expect(onOpenCompass).toHaveBeenCalledWith({
      label: 'Alex',
      lat: 40.7901,
      lon: -119.21,
    });
  });

  test('a podmate heard WITHOUT a position is live, and steers nothing', () => {
    // The mailbox decoupling's row-level consequence (2026-08-25): their
    // phone is carrying pod mail with position sharing off, so the mesh
    // proves REACH and says nothing about place. The row goes live; the
    // compass falls back to their card's address exactly as if the mesh had
    // never heard them, because about their place it hasn't.
    // Mutation: pin from a position-less sighting (or default a missing
    // pos to the city center) — the compass is handed 40.7901/-119.21-ish
    // coordinates nobody broadcast, which at BRC is a pin on the Man.
    mockFriends = [alex(new Date(Date.now() - 2 * HOUR).toISOString())];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const onOpenCompass = jest.fn();
    const presenceFor = (cardId: string) =>
      cardId === 'aaaa1111' ? { atMs: Date.now(), live: true, pos: null } : null;
    const root = renderSection({ onOpenCompass, presenceFor });
    const t = textOf(root);
    expect(t).toContain('live');
    expect(t).not.toContain('away'); // no distance from a place nobody sent
    pressContaining(root, '7:32 & C');
    expect(onOpenCompass).toHaveBeenCalledWith({
      label: 'Alex',
      lat: 40.78,
      lon: -119.2, // the card's parsed address, the pre-mesh floor
    });
  });

  test('"We\'re together — swap cards" opens a QR, and shares NOTHING by itself', () => {
    // THE REGRESSION (owner, 2026-08-25). This row used to hand
    // Share.share({message}) the raw bundle JSON: Android opened a chooser
    // for a text blob nobody can import, and iOS previewed the first line of
    // the pretty-printed bundle — a single "{" and nothing else. Two people
    // standing together is the rung-0 case, so it shows a code now.
    //
    // Mutation this dies on: putting exportMyCard(conn) back into a share
    // sheet on the row's press.
    mockFriends = [alex()];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const rn = require('react-native');
    const shareSpy = jest
      .spyOn(rn.Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' });
    const root = renderSection();
    press(root, "We're together — swap cards");
    expect(shareSpy).not.toHaveBeenCalled();
    expect(textOf(root)).toContain('Swap cards with Alex');
    const codes = root.root.findAllByType('QRCode');
    expect(codes).toHaveLength(1);
    // The SCHEME carrier, not https: this code is held up to a phone that
    // has the app, and the scheme opens it whatever the app-link
    // verification state is (a dev build never carries the release key).
    expect(codes[0].props.value.startsWith('playapal://friend#')).toBe(true);
    // ...and what it carries is the card, not a description of it.
    expect(codes[0].props.value).not.toContain('{');
  });

  test('the swap panel\'s link fallback sends a LINK, never the bundle JSON', () => {
    // The other half of the same fix: someone who is NOT standing here gets
    // an https link with a web fallback. Mutation: `message: exportMyCard(conn)`.
    mockFriends = [alex()];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const rn = require('react-native');
    const shareSpy = jest
      .spyOn(rn.Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' });
    const root = renderSection();
    press(root, "We're together — swap cards");
    // 'Send my card', not 'Send a link' — the pod's invite row owns that
    // second phrase, and this press finding THAT button is exactly the
    // ambiguity the wording avoids (it happened while writing this test).
    press(root, 'Send my card');
    expect(shareSpy).toHaveBeenCalledTimes(1);
    const payload = shareSpy.mock.calls[0][0] as { message: string };
    expect(payload.message.startsWith('https://playapal.lol/f#')).toBe(true);
    expect(payload.message).not.toContain('{');
    expect(payload.message).not.toBe(mockCardJson);
  });

  test('the swap panel offers the camera — taking theirs, not just giving mine', () => {
    // Both directions in one panel (owner: "app has to be exited to scan
    // manually"). Mutation: a panel that only shows my code.
    mockFriends = [alex()];
    saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const root = renderSection();
    press(root, "We're together — swap cards");
    expect(textOf(root)).toContain('Scan theirs');
  });

  test('Edit reopens the picker prefilled; Save keeps the same id and code', () => {
    mockFriends = [alex(), sam()];
    const c = saveCrew(newCrew('Dawn patrol', ['aaaa1111']));
    const root = renderSection();
    press(root, 'Edit');
    expect(nameInput(root).props.value).toBe('Dawn patrol');
    press(root, 'Sam');
    press(root, 'Save pod');
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0]).toMatchObject({
      id: c.id,
      code: c.code,
      memberIds: ['aaaa1111', 'bbbb2222'],
    });
  });
});

describe('my own reinstall ghost, claimed and said consistently', () => {
  // A pre-wipe identity announces under MY name and, with self excluded
  // from the roster, reads as another person — seen in the field as a
  // "Pug" row on Pug's own screen and "2 so far" for one camper. The
  // self-anchor claims it; these renders pin that every line on the card
  // then tells ONE story. Review round 3: the first fix suppressed only
  // the body's empty copy while the header still said "nobody yet" one
  // line above a footer explaining what had been heard.
  test('header, body and footer agree when everything heard is my past', () => {
    mockFriends = [];
    const c = saveCrew({ ...newCrew('Dawn patrol'), code: '4207' });
    // The ghost: card-less, announced, quiet, bearing my own name.
    mockRecords.push(announcement(c.code, 'dead0001', 'Dusty', 90));
    const t = textOf(renderSection());
    // The footer claims the past and names the recourse...
    expect(t).toContain('older phone here also went by Dusty');
    expect(t).toContain('says hello');
    // ...the header agrees instead of calling the air silent...
    expect(t).toContain('only this phone so far');
    expect(t).not.toContain('nobody yet');
    // ...and the body's empty copy yields to the footer entirely.
    expect(t).not.toContain("Nobody's phone has said hello yet");
    // No row for the ghost — that is the point of claiming it.
    expect(t).not.toContain('said hello 1h ago');
  });

  test('a real podmate beside my ghost: normal count, ghost still claimed', () => {
    mockFriends = [];
    const c = saveCrew({ ...newCrew('Dawn patrol'), code: '4207' });
    mockRecords.push(announcement(c.code, 'dead0001', 'Dusty', 90));
    mockRecords.push(announcement(c.code, 'cccc3333', 'Bo Lantern'));
    const t = textOf(renderSection());
    expect(t).toContain('Bo Lantern');
    expect(t).toContain('1 so far');
    expect(t).toContain('older phone here also went by Dusty');
    expect(t).not.toContain('2 so far');
  });
});

describe('multiple pods (owner ruling §6c #4: plural, like n2y groups)', () => {
  test('two pods: both chips render, switching swaps the shown card', () => {
    // Codes pinned: two random 4-digit PINs collide once in 10,000, and a
    // test that flakes that rarely is worse than one that never does.
    const day = saveCrew({ ...newCrew('Day pod', ['aaaa1111']), code: '1111' });
    const camp = saveCrew({
      ...newCrew('Camp pod', ['bbbb2222']),
      code: '2222',
    });
    const root = renderSection();
    const t = textOf(root);
    expect(t).toContain('Day pod');
    expect(t).toContain('Camp pod');
    // The chip row is a pure SELECTION row now (a11y+IA fold 2026-08-24):
    // one "Add or join…" door instead of two action chips dressed as pods.
    expect(t).toContain('Add or join…');
    expect(t).not.toContain('+ New pod');
    // The store is newest-first (waypoints pattern), so the LAST-saved pod
    // is the default view — consistent with a new pod auto-showing.
    expect(t).toContain(camp.code);
    expect(t).not.toContain(day.code);
    press(root, 'Day pod');
    const after = textOf(root);
    expect(after).toContain(day.code);
    expect(after).not.toContain(camp.code);
  });

  test('Add or join… → New pod opens a blank picker; Save creates and SHOWS the new pod', () => {
    saveCrew(newCrew('Day pod', ['aaaa1111']));
    const root = renderSection();
    // The two-tap door (a11y+IA fold 2026-08-24): the action chip opens a
    // tiny option row; "New pod" lives there, not in the selection row.
    expect(textOf(root)).not.toContain('New pod');
    press(root, 'Add or join…');
    expect(textOf(root)).toContain('Join with a code'); // both options shown
    press(root, 'New pod');
    expect(nameInput(root).props.value).toBe('My pod');
    press(root, 'Sam');
    press(root, 'Save pod');
    expect(listCrews()).toHaveLength(2);
    const made = listCrews().find(c => c.name === 'My pod')!;
    const t = textOf(root);
    expect(t).toContain(made.code); // the new pod is the one on screen
    expect(made.memberIds).toEqual(['bbbb2222']);
  });

  test('disbanding the shown pod falls back to the remaining one', () => {
    const day = saveCrew(newCrew('Day pod', ['aaaa1111']));
    saveCrew(newCrew('Camp pod', ['bbbb2222']));
    const rn = require('react-native');
    const alertSpy = jest.spyOn(rn.Alert, 'alert').mockImplementation(
      (...args: unknown[]) => {
        const buttons = args[2] as
          | Array<{ text?: string; onPress?: () => void }>
          | undefined;
        buttons?.find(b => b.text === 'Disband')?.onPress?.();
      },
    );
    const root = renderSection();
    press(root, 'Camp pod');
    press(root, 'Edit');
    press(root, 'Disband pod');
    alertSpy.mockRestore();
    expect(listCrews()).toHaveLength(1);
    expect(textOf(root)).toContain(day.code); // fell back to the survivor
  });

  test('joinCrew: a campmate\'s code becomes a local pod, code verbatim', () => {
    const joined = joinCrew('  Dusty-Flamingo-42 ', 'Karl pod');
    // A retired word phrase still joins — someone may have one written
    // down, and the wire keys on the hash of whatever was typed.
    expect(joined.code).toBe('Dusty-Flamingo-42'); // trimmed, case KEPT —
    // the wire normalizes at hash time, humans see what they typed
    expect(joined.name).toBe('Karl pod');
    expect(joined.nameSource).toBe('mine'); // typed = the user's choice
    // No name given: a PLACEHOLDER, marked as one, so a podmate's
    // announcement may fill in the pod's real name later.
    const pin = joinCrew('4207');
    expect(pin.name).toBe('Pod 4207');
    expect(pin.nameSource).toBe('code');
    expect(listCrews()).toHaveLength(2);
  });

  test('Join with a code, from empty: the joined pod is on screen', () => {
    const root = renderSection();
    press(root, 'Have a code? Join a pod');
    const input = root.root
      .findAllByType(require('react-native').TextInput)
      .find((t: any) => String(t.props.placeholder).startsWith('Pod code'));
    expect(input).toBeTruthy();
    TestRenderer.act(() => input.props.onChangeText('4207'));
    press(root, 'Join pod');
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0].code).toBe('4207');
    const t = textOf(root);
    expect(t).toContain('4207'); // shown card = the joined pod
    // The pod wears a placeholder, never the bare code where a name goes,
    // and the sentences say "this pod" until a real name arrives.
    expect(t).toContain('Pod 4207');
    // Sentences say "this pod", never the join code: "Edit 4207" is a
    // machine talking (the share row's label is the same call, and it only
    // renders when the native radio is present).
    const labels = root.root
      .findAll((n: any) => typeof n.props?.accessibilityLabel === 'string')
      .map((n: any) => n.props.accessibilityLabel);
    expect(labels).toContain('Edit this pod');
    // This phone HOLDS cards (Alex, Sam), so the empty roster points at
    // Edit — and still says the mesh half out loud.
    expect(t).toContain(
      'Nobody here yet — tap Edit to add people whose cards you hold, or wait for a podmate to pass in range.',
    );
  });

  test('an announced podmate is a ROW, with no card and no address', () => {
    // The measured bug, at the render layer: this phone holds no card for
    // Bo, has picked nobody, and must still show a member — the roster is
    // the gossiped log, not the local pick list.
    mockFriends = [];
    const c = saveCrew({ ...newCrew('Dawn patrol'), code: '4207' });
    mockRecords.push(announcement(c.code, 'cccc3333', 'Bo Lantern'));
    const t = textOf(renderSection());
    expect(t).toContain('Bo Lantern');
    expect(t).toContain('no card on this phone yet');
    expect(t).toContain('said hello');
    // Counted as "so far", never as a total.
    expect(t).toContain('1 so far');
    expect(t).not.toContain('1 person');
    expect(t).not.toContain(
      "Nobody's phone has said hello yet. Podmates fill in here when one passes in range.",
    );
  });

  test('a joined pod shows its code AS a code until the name record lands', () => {
    const joined = joinCrew('4207');
    const before = textOf(renderSection());
    expect(before).toContain('Pod 4207');
    expect(before).toContain(
      "No name yet — it arrives with the first podmate's phone.",
    );
    // The namer's announcement arrives; the pod takes the name, and the
    // "no name yet" line goes away because it is no longer true.
    mockRecords.push(
      announcement(joined.code, 'cccc3333', 'Bo Lantern', 0, 'Dawn patrol'),
    );
    const after = textOf(renderSection());
    expect(after).toContain('Dawn patrol');
    expect(after).not.toContain('No name yet');
    expect(listCrews()[0].nameSource).toBe('mesh');
  });

  test('joined pod, no cards on this phone: the empty state is the mesh one', () => {
    mockFriends = [];
    const root = renderSection();
    press(root, 'Have a code? Join a pod');
    const input = root.root
      .findAllByType(require('react-native').TextInput)
      .find((t: any) => String(t.props.placeholder).startsWith('Pod code'));
    TestRenderer.act(() => input.props.onChangeText('4207'));
    press(root, 'Join pod');
    // "tap Edit to choose your people" was a dead end here — there is
    // nobody to choose. Say what is actually true.
    expect(textOf(root)).toContain(
      "Nobody's phone has said hello yet. Podmates fill in here when one passes in range.",
    );
  });
});
