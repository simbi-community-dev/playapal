/**
 * PodMessages — the answering machine's strip inside the Pod card. Pins:
 * the empty state speaks the phone-to-phone truth; Send composes into MY
 * outbox (never my own inbox) and shows the row as "You"; incoming mail
 * resolves sender names in ONE fixed order — the friend cards this phone
 * holds, then the pod's member announcements, then an honest "someone in
 * the pod" that says WHY it cannot name them ("naming the sender", below);
 * unread rows are marked and a tap flips them read; a voice row plays
 * through the injected player; hold-to-record runs the injected recorder
 * and lands a composed voice message; over-cap text shows the honest
 * inline copy and never inserts (and never truncates the draft).
 *
 * Harness: the crewMessages.test.ts approach — mock ../src/events/db with a
 * node:sqlite DatabaseSync running the REAL BASE_TABLES_SQL, so compose /
 * inbox / markRead / friend-card reads all run the shipped SQL. The crew
 * store's settings KV (pulled in via the CrewSection import graph) is a
 * Map, as in crew.test.tsx.
 */
import React from 'react';

let mockConn: any;
const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import { BASE_TABLES_SQL } from '../src/events/schema';
import {
  POD_MEMBER_TTL_MIN,
  TEXT_MAX_BYTES,
  acceptIncoming,
  epochMinutes,
  inbox,
  myOutbox,
  unreadCount,
  type WireMessage,
} from '../src/crews/messages';
import { hash32 } from '../src/crews/beacon';
import { announcedNames, encodeMemberBody } from '../src/crews/podMembers';
import { getMyCard, saveMyCard } from '../src/friends/friendCard';
import { PodMessages } from '../src/crews/PodMessages';

const TestRenderer = require('react-test-renderer');
const { DatabaseSync } = require('node:sqlite');

function makePhone() {
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
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  return conn;
}

const CODE = 'dusty-llamas-7';
const CREW = {
  id: 'crew-1',
  name: 'Dawn patrol',
  code: CODE,
  memberIds: ['aaaa1111'],
};
const ALEX_ID = 'aaaa1111';
// Present time, not a fixed date: the component prunes at mount with the
// real clock, so message times must live around NOW or a future test run
// would watch its fixtures get pruned (a time bomb, not a test).
const T0 = epochMinutes(Date.now());

let myId = '';

/** A valid heard-side wire message from Alex, overridable per test. */
const wireMsg = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'cafe1234-29000000-beef',
  crew_code: CODE,
  from_hash: hash32(ALEX_ID),
  to_hash: null,
  kind: 'text',
  body: 'water at 7:30 & C',
  mime: '',
  created_min: T0,
  expires_min: T0 + 60,
  hops: 0,
  ...over,
});

/**
 * A pod-member announcement as it ARRIVES: identity travels the same
 * store-and-forward rails the mail does (kind 'pod-member',
 * src/crews/podMembers.ts), so these cases plant a name exactly the way a
 * podmate's phone does — no reaching past the accept gate.
 */
const announcement = (cardId: string, name: string): WireMessage => ({
  id: `hello-${cardId}`,
  crew_code: CODE,
  from_hash: hash32(cardId),
  to_hash: null,
  kind: 'pod-member',
  body: encodeMemberBody({ cardId, name }),
  mime: '',
  created_min: T0,
  expires_min: T0 + POD_MEMBER_TTL_MIN,
  hops: 0,
});

// ----------------------------------------------------------- render utils
// The crew.test.tsx helpers: flatten Text trees, press by content.

function flatText(children: any): string {
  if (Array.isArray(children)) {
    return children.map(flatText).join('');
  }
  if (children === null || children === undefined) {
    return '';
  }
  return typeof children === 'object' ? '' : String(children);
}

function textOf(root: any): string {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => flatText(t.props.children))
    .join('\n');
}

function nodeWithHandler(text: any, handler: string) {
  let node: any = text;
  while (node && !node.props[handler]) {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  return node;
}

function press(root: any, label: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children) === label);
  expect(text).toBeTruthy();
  TestRenderer.act(() => nodeWithHandler(text, 'onPress').props.onPress());
}

function pressContaining(root: any, fragment: string) {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children).includes(fragment));
  expect(text).toBeTruthy();
  TestRenderer.act(() => nodeWithHandler(text, 'onPress').props.onPress());
}

/** The SPOKEN label of the row carrying this body text — the sender line a
 * screen reader hears, which is a different code path from what renders. */
function rowLabelFor(root: any, fragment: string): string {
  const text = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children).includes(fragment));
  expect(text).toBeTruthy();
  const label = nodeWithHandler(text, 'onPress').props.accessibilityLabel;
  expect(typeof label).toBe('string');
  return label as string;
}

/** Every Text on screen, as exact strings — for "is this name rendered
 * VERBATIM", which `toContain` on the joined blob cannot answer (one name
 * can be a substring of another). */
function textsOf(root: any): string[] {
  return root.root
    .findAllByType(require('react-native').Text)
    .map((t: any) => flatText(t.props.children));
}

/** The mic Pressable, found by its 🎤 child (walking up to onPressIn). */
function micNode(root: any) {
  const icon = root.root
    .findAllByType(require('react-native').Text)
    .find((t: any) => flatText(t.props.children) === '🎤');
  expect(icon).toBeTruthy();
  return nodeWithHandler(icon, 'onPressIn');
}

function draftInput(root: any) {
  return root.root
    .findAllByType(require('react-native').TextInput)
    .find((t: any) => t.props.placeholder === 'Message the pod…');
}

/**
 * Roots tracked and unmounted after every test inside act() — the
 * crew.test lesson: still-subscribed stale roots re-render on later store
 * updates and one dying mid-update kills the CURRENT test's renderer.
 */
const liveRoots: any[] = [];

function renderPod(props: { recorder?: any; player?: any } = {}) {
  let root: any;
  TestRenderer.act(() => {
    root = TestRenderer.create(
      <PodMessages crew={CREW} recorder={props.recorder} player={props.player} />,
    );
  });
  liveRoots.push(root);
  return root;
}

/** The strip mounts COLLAPSED behind its header when no mail is waiting
 * (a11y+IA fold 2026-08-24) — tests that need the thread/composer tap the
 * header open first, exactly as a thumb would. */
function openStrip(root: any) {
  press(root, 'Answering machine');
}

beforeEach(() => {
  mockConn = makePhone();
  mockSettings.clear();
  // A saved self card pins my id (an unsaved card re-mints a random id per
  // read — the component tolerates that, the assertions should not).
  saveMyCard(mockConn, { name: 'Dusty', camp: '', address: '', note: '' });
  myId = getMyCard(mockConn).id;
  // Alex's card, so incoming from_hash resolves to a name. Base DDL only —
  // this harness runs BASE_TABLES_SQL, not the migrations (scope arrives
  // there); listFriends defaults the missing column safely.
  mockConn.execute(
    `INSERT INTO friend_cards (id, seq, name, camp, address, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ALEX_ID, 1, 'Alex', '', '', '', ''],
  );
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

// ---------------------------------------------------------------------------

describe('the strip', () => {
  test('collapsed by default when empty; opening speaks the phone-to-phone truth', () => {
    const root = renderPod();
    // Collapsed mount (a11y+IA fold 2026-08-24): only the header shows —
    // the Pod card no longer carries the whole strip unasked.
    const before = textOf(root);
    expect(before).toContain('Answering machine');
    expect(before).not.toContain('No messages waiting');
    openStrip(root);
    const t = textOf(root);
    expect(t).toContain(
      'No messages waiting. Leave one — the pod picks it up when phones pass in range, like the answering machine at your first house.',
    );
    expect(t).toContain(
      'Messages move while position sharing is on, hopping pod phone to pod phone — minutes to hours, not instant. A plugged-in phone at camp keeps the mailbox.',
    );
  });

  test('Send composes into MY outbox, not my inbox — the row reads as You', () => {
    const root = renderPod();
    openStrip(root); // composer lives behind the collapsed header
    const input = draftInput(root);
    TestRenderer.act(() => input.props.onChangeText('meet at the trash fence at 3'));
    press(root, 'Send');
    expect(myOutbox([CODE], myId).map(m => m.body)).toEqual([
      'meet at the trash fence at 3',
    ]);
    expect(inbox([CODE], myId)).toEqual([]);
    const t = textOf(root);
    expect(t).toContain('You');
    expect(t).toContain('meet at the trash fence at 3');
    expect(t).not.toContain('No messages waiting');
    // the draft cleared for the next note
    expect(draftInput(root).props.value).toBe('');
  });

  test('incoming mail names its sender from the cards; unknown hashes stay honest', () => {
    const root = renderPod();
    openStrip(root); // mounted empty → collapsed; open to watch mail land
    TestRenderer.act(() => {
      acceptIncoming(
        [
          wireMsg(),
          wireMsg({
            id: 'stranger-1',
            from_hash: hash32('99999999'), // no card on this phone
            body: 'psst — free pancakes at sunrise',
          }),
        ],
        [CODE],
        T0,
      );
    });
    const t = textOf(root);
    expect(t).toContain('Alex');
    expect(t).toContain('water at 7:30 & C');
    expect(t).toContain('someone in the pod');
    expect(t).toContain('psst — free pancakes at sunrise');
  });

  test('unread shows a count and a dot; tapping the row flips it read', () => {
    TestRenderer.act(() => {
      acceptIncoming([wireMsg()], [CODE], T0);
    });
    const root = renderPod();
    expect(unreadCount([CODE], myId)).toBe(1);
    let t = textOf(root);
    expect(t).toContain('1 new');
    expect(t).toContain('●');
    // Waiting mail auto-expands the strip at mount (a11y+IA fold
    // 2026-08-24: a message must never hide behind the chevron) — the row
    // is visible with NO header tap.
    expect(t).toContain('water at 7:30 & C');
    pressContaining(root, 'water at 7:30 & C');
    expect(unreadCount([CODE], myId)).toBe(0);
    expect(inbox([CODE], myId)[0].read_at).not.toBeNull();
    t = textOf(root);
    expect(t).not.toContain('1 new');
    expect(t).not.toContain('●');
  });

  test('a voice row plays its body through the injected player (and reads it)', async () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'v1', kind: 'voice', body: 'QUJD', mime: 'audio/mp4' })],
        [CODE],
        T0,
      );
    });
    const player = {
      play: jest.fn(async () => 1200),
      stop: jest.fn(async () => {}),
    };
    const root = renderPod({ player });
    expect(textOf(root)).toContain('Voice note');
    await TestRenderer.act(async () => {
      const label = root.root
        .findAllByType(require('react-native').Text)
        .find((t: any) => flatText(t.props.children).includes('Voice note'));
      nodeWithHandler(label, 'onPress').props.onPress();
    });
    expect(player.play).toHaveBeenCalledWith('QUJD');
    expect(unreadCount([CODE], myId)).toBe(0); // the tap was also the read
  });

  test('hold-to-record: recorder start/stop, then composeVoice lands in my outbox', async () => {
    const recorder = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => ({
        base64: 'QUJDREVG',
        mime: 'audio/mp4',
        durationMs: 2000,
      })),
    };
    const root = renderPod({ recorder });
    openStrip(root); // the mic lives behind the collapsed header
    const mic = micNode(root);
    await TestRenderer.act(async () => {
      mic.props.onPressIn();
    });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(textOf(root)).toContain('Recording — let go to send');
    await TestRenderer.act(async () => {
      mic.props.onPressOut();
    });
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    const out = myOutbox([CODE], myId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'voice',
      body: 'QUJDREVG',
      mime: 'audio/mp4',
      origin: 'mine',
    });
    expect(textOf(root)).not.toContain('Recording — let go to send');
  });

  test('over-cap text shows the honest copy, never inserts, never truncates', () => {
    const root = renderPod();
    openStrip(root); // composer lives behind the collapsed header
    const input = draftInput(root);
    const tooLong = 'x'.repeat(TEXT_MAX_BYTES + 1);
    TestRenderer.act(() => input.props.onChangeText(tooLong));
    expect(textOf(root)).toContain(
      'That message is too long to carry — trim it down.',
    );
    press(root, 'Send');
    expect(myOutbox([CODE], myId)).toEqual([]);
    // the draft survives untouched — trimming is the human's call
    expect(draftInput(root).props.value).toHaveLength(TEXT_MAX_BYTES + 1);
  });
});

/**
 * WHO SENT THIS — the resolution order, pinned end to end.
 *
 * A pod is joined by a CODE, which carries no names, so a sender line has
 * two possible sources and one fixed order (src/crews/podMembers.ts, "CARD
 * FIRST, ANNOUNCEMENT SECOND"): the friend cards this phone holds, then the
 * member announcements that gossip in over the mesh. Neither = the honest
 * fallback, which also has to say WHY, because an anonymous message in a
 * small pod reads like a stranger got in.
 *
 * Each of the three was reachable only by reading the component before
 * this block existed.
 */
describe('naming the sender', () => {
  /** Announced into the pod, but no card for them on this phone. */
  const RUSTY = 'bbbb2222';

  test('an announcement names a podmate this phone holds no card for', () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [
          announcement(RUSTY, 'Rusty'),
          wireMsg({
            id: 'rusty-1',
            from_hash: hash32(RUSTY),
            body: 'shade is up at 4:30 & D',
          }),
        ],
        [CODE],
        T0,
      );
    });
    // waiting mail auto-expands the strip at mount — no header tap needed
    const root = renderPod();
    const t = textOf(root);
    expect(t).toContain('Rusty');
    expect(t).toContain('shade is up at 4:30 & D');
    // a known name is NOT the anonymous case: neither the fallback nor its
    // hint may appear
    expect(t).not.toContain('someone in the pod');
    expect(t).not.toContain("hasn't reached this phone yet");
    expect(rowLabelFor(root, 'shade is up')).toContain('message from Rusty:');
    // an introduction is not mail: it names the row, it is never a row
    expect(inbox([CODE], myId).map(m => m.id)).toEqual(['rusty-1']);
    expect(unreadCount([CODE], myId)).toBe(1);
  });

  test('a hash with nothing known stays honest — and says why, in the row', () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [
          wireMsg({
            id: 'ghost-1',
            from_hash: hash32('99999999'), // no card, no announcement
            body: 'free pancakes at sunrise',
          }),
        ],
        [CODE],
        T0,
      );
    });
    const root = renderPod();
    const t = textOf(root);
    expect(t).toContain('someone in the pod');
    // the hint is the whole point of the fallback: "not yet", not "stranger"
    expect(t).toContain(
      "Their hello hasn't reached this phone yet — it comes with the next time you pass.",
    );
    // and it travels to a listener too, on the row's own spoken label
    const label = rowLabelFor(root, 'free pancakes');
    expect(label).toContain('message from someone in the pod:');
    expect(label).toContain("their hello hasn't reached this phone yet");
  });

  test('a held card beats the announcement — one person, one name', () => {
    // Alex's card is on this phone (beforeEach) and their announcement
    // spells it differently. The card wins: it is what the rest of the app
    // calls them, and one person under two names on one screen is worse
    // than a slightly stale one.
    TestRenderer.act(() => {
      acceptIncoming(
        [announcement(ALEX_ID, 'Alexandra of the Dust'), wireMsg()],
        [CODE],
        T0,
      );
    });
    // The announcement really did land — without this the case could pass
    // for the wrong reason (a card beating nothing at all).
    expect(announcedNames(CODE).get(hash32(ALEX_ID))).toBe(
      'Alexandra of the Dust',
    );
    const root = renderPod();
    // exact strings, not a substring search: 'Alex' is a prefix of the
    // announced spelling, so toContain on the joined text proves nothing
    const texts = textsOf(root);
    expect(texts).toContain('Alex');
    expect(texts).not.toContain('Alexandra of the Dust');
    expect(rowLabelFor(root, 'water at 7:30 & C')).toContain(
      'message from Alex:',
    );
  });
});
