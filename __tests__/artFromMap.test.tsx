/**
 * "Log art here" — the map-to-note path, end to end (owner, 2026-08-20:
 * "build into the app the ability to create an art directory live and beam
 * it aggregatorily across hippo-camper phones").
 *
 * You log a piece while STANDING at it, so the address must come from the
 * spot you already told the app about, not from a keyboard. This drives the
 * real chain — a map tap, the compass's derived clock address, the composer
 * prefill, the real camp-notes model on node:sqlite — and asserts on the
 * stored note, because every link in between can look right while the note
 * lands blank.
 *
 * GPS is deliberately absent in this rig: the address is a property of the
 * SELECTED TARGET, and a build that quietly read the phone's own position
 * instead would produce nothing here at all.
 */

import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import {
  CAMP_WRITER_ID_KEY,
  getCampIdentity,
  saveCampProfile,
} from '../src/camp/campBoard';
import { listCampNotes } from '../src/camp/campNotes';
import { latLonToBrc, type BrcGeometry } from '../src/geo/brcGeo';

const geo = require('../assets/city-geo/geometry.json') as BrcGeometry;

/** Where the finger lands on the map, in the ground coordinates the map
 * hands back. The expected address is derived from these by the geometry
 * itself, never typed in — a hard-coded string would still pass if the
 * screen stopped asking the geometry anything. */
const TAP = { label: 'Map spot', lat: 40.79, lon: -119.21 };
const TAP_ADDRESS = latLonToBrc(TAP.lat, TAP.lon, geo).address;

let mockConn: any;

jest.mock('../src/geo/cityGeometry', () => ({
  getCityGeometry: () => require('../assets/city-geo/geometry.json'),
}));
jest.mock('../src/geo/useLocation', () => ({
  useLocation: () => ({ position: null, status: 'searching' }),
}));
jest.mock('../src/geo/useHeading', () => ({ useHeading: () => null }));
jest.mock('../src/geo/waypoints', () => ({
  HOME_LABEL: 'Home',
  homePin: () => null,
  listPins: () => [],
  removePin: () => {},
  savePin: () => {},
}));
jest.mock('../src/friends/friendCard', () => ({
  listFriends: () => [],
  subscribeFriendsChanged: () => () => {},
  getMyCard: () => ({ name: 'Dusty', camp: 'Camp', address: '' }),
}));
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  rebuildFtsIndexes: jest.fn(),
}));
jest.mock('../src/screens/CityMap', () => {
  const ReactActual = require('react');
  const { Pressable, View } = require('react-native');
  return {
    CityMap: (props: { onMapTap?: (t: object) => void }) =>
      ReactActual.createElement(
        View,
        null,
        ReactActual.createElement(Pressable, {
          testID: 'city-map',
          onPress: () =>
            props.onMapTap?.({ label: 'Map spot', lat: 40.79, lon: -119.21 }),
        }),
      ),
  };
});

const { DatabaseSync } = require('node:sqlite');
const TestRenderer = require('react-test-renderer');
const RN = require('react-native');
const { CompassScreen } = require('../src/screens/CompassScreen');

function makePhone(writerId: string) {
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
  } as any;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
    CAMP_WRITER_ID_KEY,
    writerId,
  ]);
  return conn;
}

const renderScreen = (): ReactTestRenderer => {
  const holder: { root?: ReactTestRenderer } = {};
  TestRenderer.act(() => {
    holder.root = TestRenderer.create(
      React.createElement(CompassScreen, { initialTarget: null, onClose: () => {} }),
    );
  });
  return holder.root!;
};

const flat = (c: unknown): string =>
  Array.isArray(c) ? c.map(flat).join('') : String(c ?? '');

const texts = (root: ReactTestRenderer): string[] =>
  root.root.findAllByType(RN.Text).map((t: ReactTestInstance) => flat(t.props.children));

const pressLabel = (root: ReactTestRenderer, frag: string): void => {
  const node = root.root.findAll(
    (n: ReactTestInstance) =>
      typeof n.props?.onPress === 'function' &&
      String(n.props?.accessibilityLabel ?? '').includes(frag),
  )[0];
  expect(node).toBeTruthy();
  TestRenderer.act(() => node.props.onPress());
};

const tapMap = (root: ReactTestRenderer): void => {
  const map = root.root
    .findAllByProps({ testID: 'city-map' })
    .find((n: ReactTestInstance) => typeof n.props?.onPress === 'function');
  expect(map).toBeTruthy();
  TestRenderer.act(() => map!.props.onPress());
};

const typeInto = (root: ReactTestRenderer, placeholderStart: string, value: string): void => {
  const input = root.root
    .findAllByType(RN.TextInput)
    .find((i: ReactTestInstance) =>
      String(i.props.placeholder ?? '').startsWith(placeholderStart),
    );
  expect(input).toBeTruthy();
  TestRenderer.act(() => input!.props.onChangeText(value));
};

const pressText = (root: ReactTestRenderer, label: string): void => {
  const t = root.root
    .findAllByType(RN.Text)
    .find((n: ReactTestInstance) => n.props.children === label);
  expect(t).toBeTruthy();
  let node: ReactTestInstance | null = t!;
  while (node && typeof node.props?.onPress !== 'function') {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  TestRenderer.act(() => node!.props.onPress());
};

const myNotes = () => listCampNotes(mockConn, getCampIdentity(mockConn).campId);

beforeEach(() => {
  mockConn = makePhone('writeraaaa');
  saveCampProfile(mockConn, { authorName: 'Pug', passphrase: 'dusty hippos 2026' });
});

describe('logging art from the map', () => {
  test('no spot selected yet: nothing offers to log art', () => {
    const root = renderScreen();
    expect(texts(root).some(t => t.includes('Log art here'))).toBe(false);
  });

  test('a tapped spot offers to log art AT ITS CLOCK ADDRESS', () => {
    const root = renderScreen();
    tapMap(root);
    expect(TAP_ADDRESS).toMatch(/\d/); // the geometry really resolved it
    expect(texts(root).some(t => t === `🎨 Log art here — ${TAP_ADDRESS}`)).toBe(true);
  });

  test('the whole chain: tap, log, save — the note carries the tapped address', () => {
    const root = renderScreen();
    tapMap(root);
    pressLabel(root, 'Log art at');

    // The composer opened ON the art kind with the address already in it.
    const whereInput = root.root
      .findAllByType(RN.TextInput)
      .find((i: ReactTestInstance) =>
        String(i.props.placeholder ?? '').startsWith('Where'),
      );
    expect(whereInput).toBeTruthy();
    expect(whereInput!.props.value).toBe(TAP_ADDRESS);

    typeInto(root, 'Name of the piece', 'Bloom');
    typeInto(root, 'Artist', 'Ada Weatherwax');
    typeInto(root, 'What it looks like', 'A steel hippo that breathes fire at dusk.');
    pressText(root, 'Save note');

    const notes = myNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'art',
      title: 'Bloom — by Ada Weatherwax',
      where_addr: TAP_ADDRESS,
      text: 'A steel hippo that breathes fire at dusk.',
    });

    // …and it is already retrievable, address included — the beam carries
    // the same rows, so what the Angel can read here it can read in camp.
    const chunks = mockConn.execute(
      "SELECT heading, content FROM doc_chunks WHERE source_file = 'camp-notes'",
    ).rows!._array;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Bloom — by Ada Weatherwax');
    expect(chunks[0].content).toContain(`Art on playa at ${TAP_ADDRESS}`);
  });
});
