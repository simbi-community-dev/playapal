/**
 * PodMessages — the answering machine's strip inside the Pod card. Pins:
 * the empty state speaks the phone-to-phone truth; Send composes into MY
 * outbox (never my own inbox) and shows the row as "You"; incoming mail
 * resolves sender names in ONE fixed order — the friend cards this phone
 * holds, then the pod's member announcements, then an honest "someone in
 * the pod" that says WHY it cannot name them ("naming the sender", below);
 * unread rows are marked and a tap flips them read; a voice row plays
 * through the injected player; hold-to-record runs the injected recorder
 * and lands a composed voice message, while a press too short to be one
 * creates nothing and hands the mic straight back ("a tap is not a voice
 * note", below); over-cap text shows the honest inline copy and never
 * inserts (and never truncates the draft).
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

/** Open the strip's circled ? — the InfoTap holding the transport lesson
 * (the Tufte pass, 2026-08-26). Found by the label it announces, which is
 * the same thing a screen reader navigates by, so this press cannot pass
 * against a glyph nobody could identify. */
function pressLinkTruth(root: any) {
  const glyph = root.root.find(
    (n: any) =>
      n.props?.accessibilityLabel === 'More about how messages travel' &&
      typeof n.props?.onPress === 'function',
  );
  TestRenderer.act(() => glyph.props.onPress());
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

/**
 * A voice row's CONTROL — the ▶/■ glyph and the surface it sits on. Found
 * from the glyph upward to the first ancestor that states a minHeight, so
 * the assertion never depends on the tree's exact depth — any wrapper that
 * later sits between the two is walked straight through.
 */
function voiceControl(root: any) {
  const { StyleSheet, Text } = require('react-native');
  const glyph = root.root
    .findAllByType(Text)
    .find((t: any) => ['▶', '■'].includes(flatText(t.props.children)));
  expect(glyph).toBeTruthy();
  let node: any = glyph.parent;
  while (node && StyleSheet.flatten(node.props.style)?.minHeight === undefined) {
    node = node.parent;
  }
  expect(node).toBeTruthy();
  return {
    mark: flatText(glyph.props.children),
    glyphSize: StyleSheet.flatten(glyph.props.style)?.fontSize,
    surface: StyleSheet.flatten(node.props.style),
  };
}

/** The row Pressable carrying a voice note — found by its spoken label, so
 * the lookup is the same thing a screen reader does. */
function voiceRowNode(root: any) {
  const node = root.root.find(
    (n: any) =>
      typeof n.props?.onPress === 'function' &&
      typeof n.props?.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.includes('voice note from'),
  );
  expect(node).toBeTruthy();
  return node;
}

/**
 * HOLDING THE MIC, IN TEST TIME. What mints a voice note is the LENGTH of
 * the press (PodMessages, VOICE_NOTE_MIN_MS — owner report 2026-08-26), and
 * a test's press-then-release takes about a microsecond, so the clock is
 * driven on purpose: pressMic freezes it at the moment the finger lands and
 * releaseMic moves it forward by exactly the span under test. Real clock
 * base, so the row composes at NOW and the mount-time prune never eats it.
 */
let micPressedAt = 0;
let micClock: any = null;

async function pressMic(root: any) {
  const mic = micNode(root);
  micPressedAt = Date.now();
  micClock = jest.spyOn(Date, 'now').mockReturnValue(micPressedAt);
  await TestRenderer.act(async () => {
    mic.props.onPressIn();
  });
  return mic;
}

/** Let go after `heldMs` of holding, then hand the clock back. */
async function releaseMic(mic: any, heldMs: number) {
  micClock.mockReturnValue(micPressedAt + heldMs);
  await TestRenderer.act(async () => {
    mic.props.onPressOut();
  });
  micClock.mockRestore();
  micClock = null;
}

/** One deliberate hold: pressed, held `heldMs`, let go. */
async function holdMic(root: any, heldMs: number) {
  const mic = await pressMic(root);
  await releaseMic(mic, heldMs);
}

/** The one sentence a too-quick press earns. */
const TOO_QUICK =
  'Too quick — hold the button a full second to leave a voice note.';

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
    // The footer moved with the behaviour (mailbox decoupling, 2026-08-25):
    // mail no longer waits on the position switch, so the sentence that said
    // it did would now be the app teaching a camper the old bug.
    //
    // AND THEN IT MOVED AGAIN, behind a ? (the Tufte pass, 2026-08-26): it
    // is transport teaching, identical on every phone, and it was sitting
    // under the composer at all times. This assertion followed it rather
    // than being deleted — the promise was never "the paragraph is printed",
    // it was "a camper can find out what carries their message", and only a
    // press proves that in the real tree. What must NOT move is the empty
    // state above, which is why it is still asserted inline.
    expect(t).not.toContain('Messages move whenever Playa Pal is open');
    pressLinkTruth(root);
    const opened = textOf(root);
    // Mutation: restore "while position sharing is on" — the strip tells
    // someone their message needs a switch it does not need.
    expect(opened).toContain(
      'Messages move whenever Playa Pal is open on both phones, hopping pod phone to pod phone — seconds when someone is beside you, longer when they are across camp. A plugged-in phone at camp keeps the mailbox.',
    );
    expect(opened).not.toContain('while position sharing is on');
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
    const mic = await pressMic(root);
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(textOf(root)).toContain('Recording — let go to send');
    await releaseMic(mic, 1500); // a hold anyone would call a hold
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

/**
 * READING ORDER AND STAYING AT THE NEWEST — the shape every messaging app on
 * the phone already taught the owner (his report, 2026-08-25: "it's hard to
 * follow because new shows up on top, unlike every messaging platform ever,
 * let's switch that").
 *
 * Three behaviours, and the third is the one that is easy to skip: newest at
 * the BOTTOM; the view follows new mail while the reader is at the bottom;
 * and it does NOT follow — it offers — while the reader is scrolled up in the
 * history. Gossip delivery lands mail at unpredictable moments, so the yank
 * this prevents is not a rare case, it is Tuesday afternoon in camp.
 */
describe('reading order', () => {
  /** The thread's own scroll window (the strip is inside the pod card, which
   * is inside the pod screen's ScrollView). */
  function threadView(root: any) {
    const views = root.root.findAllByType(require('react-native').ScrollView);
    expect(views.length).toBeGreaterThan(0);
    return views[0];
  }

  /** Where a body sits in render order — the joined text is emitted in tree
   * order, so an index comparison IS the on-screen ordering. */
  function orderOf(root: any, fragment: string): number {
    const at = textOf(root).indexOf(fragment);
    expect(at).toBeGreaterThanOrEqual(0);
    return at;
  }

  /** Tell the strip the reader is N points from the bottom of the thread. */
  function scrollTo(root: any, fromBottom: number) {
    TestRenderer.act(() =>
      threadView(root).props.onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 1000 - fromBottom },
          contentSize: { width: 300, height: 1200 },
          layoutMeasurement: { width: 300, height: 200 },
        },
      }),
    );
  }

  /** Content grew — what a mesh delivery looks like to the view. */
  function grewTo(root: any, height: number) {
    TestRenderer.act(() =>
      threadView(root).props.onContentSizeChange(300, height),
    );
  }

  test('newest sits at the BOTTOM, oldest at the top', () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [
          wireMsg({ id: 'm-old', body: 'coffee at sunrise', created_min: T0 - 30 }),
          wireMsg({ id: 'm-mid', body: 'water at 7:30 & C', created_min: T0 - 20 }),
          wireMsg({ id: 'm-new', body: 'bikes at the man', created_min: T0 - 5 }),
        ],
        [CODE],
        T0,
      );
    });
    const root = renderPod();
    expect(orderOf(root, 'coffee at sunrise')).toBeLessThan(
      orderOf(root, 'water at 7:30 & C'),
    );
    expect(orderOf(root, 'water at 7:30 & C')).toBeLessThan(
      orderOf(root, 'bikes at the man'),
    );
  });

  test('my own message joins the bottom of the thread, not the top', () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'm-old', body: 'coffee at sunrise', created_min: T0 - 30 })],
        [CODE],
        T0,
      );
    });
    const root = renderPod();
    const input = draftInput(root);
    TestRenderer.act(() => input.props.onChangeText('on my way'));
    press(root, 'Send');
    expect(orderOf(root, 'coffee at sunrise')).toBeLessThan(
      orderOf(root, 'on my way'),
    );
  });

  test('mail landing while the reader is scrolled up OFFERS, it does not yank', () => {
    TestRenderer.act(() => {
      acceptIncoming([wireMsg({ id: 'm-1', body: 'coffee at sunrise' })], [CODE], T0);
    });
    const root = renderPod();
    // Reading back through yesterday, well above the newest.
    scrollTo(root, 400);
    expect(textOf(root)).not.toContain('New messages');
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'm-2', body: 'bikes at the man', created_min: T0 + 1 })],
        [CODE],
        T0,
      );
    });
    grewTo(root, 1400); // the new row made the thread taller
    // The place they were reading is untouched; the arrival is announced
    // instead, with the one tap back.
    expect(textOf(root)).toContain('New messages');
    // Scrolling back down by hand answers the offer.
    scrollTo(root, 0);
    expect(textOf(root)).not.toContain('New messages');
  });

  test('mail landing while the reader is AT the newest never nags', () => {
    TestRenderer.act(() => {
      acceptIncoming([wireMsg({ id: 'm-1', body: 'coffee at sunrise' })], [CODE], T0);
    });
    const root = renderPod();
    scrollTo(root, 2); // at the bottom, inside the slack
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'm-2', body: 'bikes at the man', created_min: T0 + 1 })],
        [CODE],
        T0,
      );
    });
    grewTo(root, 1400);
    // Pinned readers are FOLLOWED, so there is nothing to announce — a chip
    // here would be a nag about mail already on screen.
    expect(textOf(root)).not.toContain('New messages');
  });

  test('sending re-pins a reader who had scrolled up', () => {
    TestRenderer.act(() => {
      acceptIncoming([wireMsg({ id: 'm-1', body: 'coffee at sunrise' })], [CODE], T0);
    });
    const root = renderPod();
    scrollTo(root, 400);
    const input = draftInput(root);
    TestRenderer.act(() => input.props.onChangeText('on my way'));
    press(root, 'Send');
    grewTo(root, 1400);
    // Nobody sends a note and then wants to keep reading yesterday, so the
    // send took the pin back and the arrival needs no announcement.
    expect(textOf(root)).not.toContain('New messages');
  });
});

/**
 * A VOICE NOTE THAT CANNOT PLAY MUST NOT LOOK LIKE ONE THAT CAN.
 *
 * The field bug (owner, 2026-08-25): "voice note delivered but wont play
 * 'prepare failed status=0x1'". The bytes were an MPEG-4 recording whose
 * stop() never wrote the `moov` index — non-empty, under the cap, and dead.
 * Two things were wrong: the row promised playback it could not deliver, and
 * the failure spoke in hex. Both ends are pinned here, with real container
 * bytes rather than a mocked verdict (src/crews/voiceClip.ts owns the walk).
 */
describe('a voice note that cannot play', () => {
  function box(type: string, payload: number[], declaredSize?: number): number[] {
    const size = declaredSize ?? 8 + payload.length;
    return [
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
      ...[...type].map(c => c.charCodeAt(0)),
      ...payload,
    ];
  }
  const ftyp = box('ftyp', [...'M4A '].map(c => c.charCodeAt(0)).concat([0, 0, 2, 0]));
  const audio = Array.from({ length: 900 }, (_, i) => i % 251);
  // Fixture machinery only (artPhoto.test.ts's require): the tree has no
  // @types/node, and the code under test never touches Buffer.
  const NodeBuffer = require('buffer').Buffer;
  const b64 = (bytes: number[]) => NodeBuffer.from(bytes).toString('base64');
  /** What the recorder writes when stop() fails: header, audio, no index. */
  const UNPLAYABLE = b64([...ftyp, ...box('mdat', audio, 0)]);
  /** The same take, finished. */
  const PLAYABLE = b64([...ftyp, ...box('mdat', audio), ...box('moov', [1, 2, 3, 4])]);

  test('the row says it will not play, and the tap says what to do about it', () => {
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'v-bad', kind: 'voice', body: UNPLAYABLE, mime: 'audio/mp4' })],
        [CODE],
        T0,
      );
    });
    const player = { play: jest.fn(async () => 1200), stop: jest.fn(async () => {}) };
    const root = renderPod({ player });
    const shown = textOf(root);
    // No transport glyph and no duration: both are promises this row
    // cannot keep. Asserted on the bare '▶' now that the glyph is its own
    // Text inside the control surface — a damaged row must not grow a play
    // button just because playable rows did.
    expect(shown).toContain("Voice note · won't play");
    expect(shown).not.toContain('▶');
    // The row carries the reason before the tap, in camper words.
    expect(shown).toContain('ask them to send it again');
    expect(shown).not.toMatch(/status=0x/);
    pressContaining(root, "won't play");
    // Handing these bytes to the player is exactly how the hex status
    // reached a screen in the dust.
    expect(player.play).not.toHaveBeenCalled();
    // Still a message that was opened: the read receipt stands.
    expect(unreadCount([CODE], myId)).toBe(0);
  });

  test('a finished take still plays, and still reads as a normal row', () => {
    // The other direction of the same guard: a real recording must not be
    // condemned by it. Without this, "mark everything damaged" would pass.
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'v-ok', kind: 'voice', body: PLAYABLE, mime: 'audio/mp4' })],
        [CODE],
        T0,
      );
    });
    const player = { play: jest.fn(async () => 1200), stop: jest.fn(async () => {}) };
    const root = renderPod({ player });
    expect(textOf(root)).toContain('▶');
    expect(textOf(root)).toContain('Voice note ·');
    expect(textOf(root)).not.toContain("won't play");
    pressContaining(root, 'Voice note ·');
    expect(player.play).toHaveBeenCalledWith(PLAYABLE);
  });

  test('a broken take never enters the mesh — the recorder says so instead', async () => {
    const recorder = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => ({
        base64: UNPLAYABLE,
        mime: 'audio/mp4',
        durationMs: 2000,
      })),
    };
    const root = renderPod({ recorder });
    openStrip(root);
    // Held well past the minimum, so this is the DAMAGE gate answering and
    // not the too-quick one — a two-second take that cannot play.
    await holdMic(root, 2000);
    // Nothing composed: a note nobody can play is 90 KB every relay in camp
    // carries for a day, and a row that does nothing on the far phone.
    expect(myOutbox([CODE], myId)).toEqual([]);
    // And the person holding the phone is told, with the next move in it.
    expect(textOf(root)).toContain("That take didn't finish recording");
    expect(textOf(root)).not.toContain(TOO_QUICK);
  });
});

/**
 * A TAP IS NOT A VOICE NOTE (owner report, 2026-08-26: "it's really easy to
 * tap it and let go and create one with no content"). The mic sits in the
 * compose row between the draft field and Send — both taps — so the thumb
 * that means to send text finds the mic instead, and a note with a breath in
 * it goes out to the whole pod.
 *
 * The gate measures the PRESS, at the mint (PodMessages, VOICE_NOTE_MIN_MS),
 * which is what these cases pin: below the line nothing is created, the mic
 * comes back for the next press, and the strip says what it wants instead;
 * on the line the note goes exactly as it always did.
 */
describe('a tap is not a voice note', () => {
  /** A take the mesh would have accepted — short of the container walk's
   * accusation, under every cap. Only the PRESS can refuse this one, which
   * is what makes it the right fixture here. */
  const TAKE = 'QUJDREVG';

  /** The recorder as the native side really behaves: armed by start, and
   * unable to arm again until a stop hands the mic back. */
  function statefulRecorder() {
    let armed = false;
    return {
      armed: () => armed,
      start: jest.fn(async () => {
        if (armed) {
          const e: any = new Error('The mic is still busy with the last take.');
          e.code = 'busy';
          throw e;
        }
        armed = true;
      }),
      stop: jest.fn(async () => {
        if (!armed) {
          const e: any = new Error('Nothing is recording.');
          e.code = 'idle';
          throw e;
        }
        armed = false;
        return { base64: TAKE, mime: 'audio/mp4', durationMs: 300 };
      }),
    };
  }

  test('a press let go inside the second creates nothing, and says why', async () => {
    // Mutation: drop the VOICE_NOTE_MIN_MS check before composeVoice and
    // this take — playable, under the caps — lands in the pod's mail.
    const recorder = statefulRecorder();
    const root = renderPod({ recorder });
    openStrip(root);
    await holdMic(root, 300);
    expect(myOutbox([CODE], myId)).toEqual([]);
    expect(textOf(root)).toContain(TOO_QUICK);
  });

  test('the dropped take does not take the mic with it — the next press records', async () => {
    // Mutation: refuse the tap by returning BEFORE getRecorder().stop() and
    // the mic stays armed, so the next start() rejects 'busy' and the real
    // note that follows is never made. The tap costing the next note is a
    // worse bug than the tap itself.
    const recorder = statefulRecorder();
    const root = renderPod({ recorder });
    openStrip(root);
    await holdMic(root, 300);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.armed()).toBe(false);

    await holdMic(root, 1500);
    expect(recorder.start).toHaveBeenCalledTimes(2);
    expect(myOutbox([CODE], myId)).toMatchObject([
      { kind: 'voice', body: TAKE, origin: 'mine' },
    ]);
    // And the hint goes when the press it was about is answered — a line
    // still telling someone to hold longer while their note sits above it
    // would be the strip arguing with itself.
    expect(textOf(root)).not.toContain(TOO_QUICK);
  });

  test("a recorder that refuses the empty take is answered in the app's words", async () => {
    // Mutation: let the catch fall through to setNotice(e.message) and the
    // same gesture comes back worded two ways depending on which side
    // noticed — the native 'empty' reject here, the press gate a tap later.
    const recorder = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => {
        const e: any = new Error('Nothing recorded — hold the button a moment longer.');
        e.code = 'empty';
        throw e;
      }),
    };
    const root = renderPod({ recorder });
    openStrip(root);
    await holdMic(root, 200);
    expect(myOutbox([CODE], myId)).toEqual([]);
    expect(textOf(root)).toContain(TOO_QUICK);
    expect(textOf(root)).not.toContain('Nothing recorded');
  });

  test('the line is one second: 999 ms is a tap, 1000 ms is a note', async () => {
    // Mutation: `<=` for `<`, or any threshold that drifts off the owner's
    // "min 1+ sec". Both directions in one case — a gate that refuses
    // everything passes every test that only presses too briefly.
    const recorder = statefulRecorder();
    const root = renderPod({ recorder });
    openStrip(root);
    await holdMic(root, 999);
    expect(myOutbox([CODE], myId)).toEqual([]);

    await holdMic(root, 1000);
    expect(myOutbox([CODE], myId)).toHaveLength(1);
    expect(textOf(root)).not.toContain(TOO_QUICK);
  });
});

/**
 * THE VOICE ROW IS THE BUTTON (owner report, 2026-08-26: "the play button is
 * tiny on received voicenotes"). Out there the hand is gloved, the glass is
 * dusty and the sun is in your eyes — Apple and Android both put the floor
 * at 44pt, and a transport control on a phone held at arm's length earns
 * more than the floor.
 *
 * The press has always belonged to the whole row; what was missing was any
 * sign of it, so these cases pin BOTH halves — that a press far from the
 * glyph plays, and that the glyph is drawn as the control it is. Plus the
 * state the row never had: while a note is talking the row says so, a second
 * press stops it, and the row goes dark on the length the player reported.
 */
describe('a voice row is a control, not a line of text', () => {
  /**
   * Eleven seconds of note by the receiver's own estimate: the store carries
   * bodies, not durations, so PodMessages reads length back off the base64
   * at ~4000 chars/second. The exact number is the point — the spoken label
   * has to carry it, and the owner's own example row said "11s".
   */
  const ELEVEN_SECONDS = 'Q'.repeat(4000 * 11);

  function heardVoice(body: string = ELEVEN_SECONDS) {
    TestRenderer.act(() => {
      acceptIncoming(
        [wireMsg({ id: 'v-ctl', kind: 'voice', body, mime: 'audio/mp4' })],
        [CODE],
        T0,
      );
    });
  }

  function fakePlayer(durationMs = 11_000) {
    return {
      play: jest.fn(async () => durationMs),
      stop: jest.fn(async () => {}),
    };
  }

  test('the whole row plays — pressed on the sender line, nowhere near the glyph', async () => {
    // Mutation: hang onPress on the ▶ glyph instead of the row Pressable and
    // this press — on Alex's name, the far end of the row from the triangle
    // — stops playing anything. Which is the bug as it was FELT: a target
    // the size of a glyph on a phone held in a dust storm.
    heardVoice();
    const player = fakePlayer();
    const root = renderPod({ player });
    await TestRenderer.act(async () => {
      pressContaining(root, 'Alex');
    });
    expect(player.play).toHaveBeenCalledWith(ELEVEN_SECONDS);
  });

  test('the spoken row is a button that names the action and the length', () => {
    // Mutation: drop the seconds from the label and a listener is offered a
    // note with no idea whether it is a word or a minute of someone's night.
    heardVoice();
    const root = renderPod({ player: fakePlayer() });
    const row = voiceRowNode(root);
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toContain('11 seconds');
    expect(row.props.accessibilityLabel).toContain('tap to play');
    // Not talking yet, and said so rather than left to the eye.
    expect(row.props.accessibilityState).toEqual({ selected: false });
  });

  test('one gloved thumb: 44pt of surface, and a glyph bigger than its own label', () => {
    // Mutation: put the glyph back at type.body (16) and drop the surface,
    // and the row renders exactly the way the owner reported it — a play
    // button the size of a comma. Both numbers, because a big glyph in a
    // 20pt row and a 44pt row with a tiny glyph each fix only half of it.
    heardVoice();
    const root = renderPod({ player: fakePlayer() });
    const ctl = voiceControl(root);
    expect(ctl.mark).toBe('▶');
    expect(ctl.surface.minHeight).toBeGreaterThanOrEqual(44);
    // The label beside it is body size; the control has to out-read it.
    expect(ctl.glyphSize).toBeGreaterThan(16);
  });

  test('a talking row says PLAYING, and the next press stops it', async () => {
    // Mutation: drop the playing state and a camper who cannot hear over
    // the sound camp next door has no way to tell a note that is playing
    // from one that never started — and presses again, and again.
    heardVoice();
    const player = fakePlayer();
    const root = renderPod({ player });
    await TestRenderer.act(async () => {
      pressContaining(root, 'Voice note ·');
    });
    expect(textOf(root)).toContain('Playing · 11s');
    expect(voiceControl(root).mark).toBe('■');
    expect(voiceRowNode(root).props.accessibilityState).toEqual({
      selected: true,
    });
    expect(voiceRowNode(root).props.accessibilityLabel).toContain(
      'playing, tap to stop',
    );

    await TestRenderer.act(async () => {
      pressContaining(root, 'Playing ·');
    });
    expect(player.stop).toHaveBeenCalledTimes(1);
    // Once only: the second press is a stop, never another play.
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(textOf(root)).toContain('Voice note · 11s');
    expect(voiceControl(root).mark).toBe('▶');
  });

  test('the lit row goes dark on the length the player reported', async () => {
    // Mutation: never arm the end-of-clip timer and the row stays lit
    // forever — a strip claiming a note is playing into a silence, which is
    // a worse lie than the missing indicator was.
    jest.useFakeTimers();
    try {
      heardVoice();
      const root = renderPod({ player: fakePlayer(11_000) });
      await TestRenderer.act(async () => {
        pressContaining(root, 'Voice note ·');
      });
      expect(textOf(root)).toContain('Playing · 11s');

      // One second short of the end: still talking.
      TestRenderer.act(() => {
        jest.advanceTimersByTime(10_000);
      });
      expect(textOf(root)).toContain('Playing · 11s');

      TestRenderer.act(() => {
        jest.advanceTimersByTime(1_000);
      });
      expect(textOf(root)).toContain('Voice note · 11s');
      expect(voiceControl(root).mark).toBe('▶');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a note that will not open clears the lit row and says what happened', async () => {
    // Mutation: leave the row lit on a rejected play and the strip shows a
    // note playing while the notice under it explains that it cannot.
    heardVoice();
    const player = {
      play: jest.fn(async () => {
        throw new Error('This phone couldn’t play that voice note.');
      }),
      stop: jest.fn(async () => {}),
    };
    const root = renderPod({ player });
    await TestRenderer.act(async () => {
      pressContaining(root, 'Voice note ·');
    });
    expect(textOf(root)).not.toContain('Playing ·');
    expect(voiceControl(root).mark).toBe('▶');
    expect(textOf(root)).toContain('couldn’t play that voice note');
  });

  test('a note I sent wears the same control as one I received', async () => {
    // Mutation: give the received branch the control and leave sent notes on
    // the old text line. Both come off ONE renderRow and must stay that way:
    // "did it send?" is answered by looking at your own row, and a row that
    // renders differently from the recipient's is the answer going wrong.
    const recorder = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => ({
        base64: ELEVEN_SECONDS,
        mime: 'audio/mp4',
        durationMs: 11_000,
      })),
    };
    const root = renderPod({ recorder, player: fakePlayer() });
    openStrip(root);
    await holdMic(root, 1500);
    expect(myOutbox([CODE], myId)).toHaveLength(1);
    const ctl = voiceControl(root);
    expect(ctl.mark).toBe('▶');
    expect(ctl.surface.minHeight).toBeGreaterThanOrEqual(44);
    expect(textOf(root)).toContain('Voice note · 11s');
  });
});

/**
 * TYPING @ OFFERS THE POD (owner ask, 2026-08-26: "if kupo is in a pod with
 * me, and i type @kupo in chat, it would send her phone a real buzz").
 *
 * The buzz itself is minted on the RECEIVING phone when the message lands
 * (src/crews/pocketAlerts.ts, pinned in its own suite). What this end owes
 * the camper is the ability to spell a podmate's name correctly without
 * remembering it — and the honesty about when the buzz happens.
 *
 * WHAT MUST NOT HAPPEN HERE: a suggestion row that offers people who are
 * not in this pod (mentioning them buzzes nobody), offers ME (nobody @s
 * themselves), or inserts anything but characters (the wire is untouched —
 * a phone on last week's build renders the sentence exactly as typed).
 */
describe('typing @ offers the pod', () => {
  /** Announced into the pod, no card on this phone. */
  const RUSTY = 'bbbb2222';
  /** A friend card this phone holds who is NOT in this pod. */
  const STRANGER = 'dddd4444';

  /** The '@' chips above the composer, in render order. */
  function chips(root: any): string[] {
    return root.root
      .findAll(
        (n: any) =>
          typeof n.props?.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Mention '),
      )
      .map((n: any) => n.props.accessibilityLabel as string);
  }

  function typeDraft(root: any, text: string) {
    TestRenderer.act(() => draftInput(root).props.onChangeText(text));
  }

  beforeEach(() => {
    // Alex (card, picked into the pod by CREW.memberIds) + Rusty (announced
    // only) + a friend from another camp who is neither.
    mockConn.execute(
      `INSERT INTO friend_cards (id, seq, name, camp, address, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [STRANGER, 1, 'Marisol', '', '', '', ''],
    );
    TestRenderer.act(() => {
      acceptIncoming([announcement(RUSTY, 'Rusty')], [CODE], T0);
    });
  });

  test('a bare @ offers the pod, and nobody else', () => {
    // Mutation: build the row off the sender-name table (which holds every
    // card on the phone) instead of the roster, and the composer offers a
    // friend from another camp — a mention that can never buzz anyone,
    // because they are not in this pod's mail at all.
    const root = renderPod();
    openStrip(root);
    typeDraft(root, 'meet at @');
    const offered = chips(root);
    expect(offered.some(l => l.startsWith('Mention Alex'))).toBe(true);
    expect(offered.some(l => l.startsWith('Mention Rusty'))).toBe(true);
    expect(offered.some(l => l.startsWith('Mention Marisol'))).toBe(false);
    // And never me: nobody @s themselves.
    expect(offered.some(l => l.startsWith('Mention Dusty'))).toBe(false);
  });

  test('the row narrows as you type, and closes when the sentence goes on', () => {
    // Mutation: leave the row mounted whenever the draft holds an '@' and
    // the chips sit over the composer for the rest of the message.
    const root = renderPod();
    openStrip(root);
    typeDraft(root, '@ru');
    expect(chips(root).some(l => l.startsWith('Mention Rusty'))).toBe(true);
    expect(chips(root).some(l => l.startsWith('Mention Alex'))).toBe(false);
    typeDraft(root, '@Rusty shade is up');
    expect(chips(root)).toEqual([]);
    typeDraft(root, 'no mention here');
    expect(chips(root)).toEqual([]);
  });

  test('tapping a chip completes the name as PLAIN TEXT, and the message carries it', () => {
    // Mutation: insert a token, a marker, an id — anything but characters —
    // and the record that rides the mesh becomes something a phone on last
    // week's build renders as noise. The wire is the compatibility surface.
    const root = renderPod();
    openStrip(root);
    typeDraft(root, 'water at @ru');
    press(root, '@Rusty');
    expect(draftInput(root).props.value).toBe('water at @Rusty ');
    typeDraft(root, 'water at @Rusty bring the jug');
    press(root, 'Send');
    const out = myOutbox([CODE], myId);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('water at @Rusty bring the jug');
    expect(out[0].kind).toBe('text');
    // The record itself gained nothing — same shape as any other message.
    expect(Object.keys(out[0]).sort()).toEqual(
      [
        'body',
        'created_min',
        'crew_code',
        'expires_min',
        'from_hash',
        'hops',
        'id',
        'kind',
        'mime',
        'origin',
        'read_at',
        'to_hash',
      ].sort(),
    );
  });

  test('the caption tells the mesh truth: real buzz, radio timing', () => {
    // Mutation: promise an instant buzz. There is no push server and no
    // internet out there — a mention lands when the two phones next hear
    // each other, and a camper who learns otherwise learns it at the worst
    // possible moment.
    const root = renderPod();
    openStrip(root);
    typeDraft(root, '@');
    const t = textOf(root);
    expect(t).toContain(
      'Naming someone buzzes their phone — when the message reaches it.',
    );
    expect(t).not.toMatch(/instantly|right away|immediately/i);
  });

  test('the chips are thumb-sized, like every other target on this card', () => {
    // Mutation: drop the tap floor and the row becomes a line of small text
    // between a dusty glove and the Send button it sits above.
    const { StyleSheet } = require('react-native');
    const root = renderPod();
    openStrip(root);
    typeDraft(root, '@');
    const chip = root.root.find(
      (n: any) =>
        typeof n.props?.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Mention Alex'),
    );
    expect(
      StyleSheet.flatten(chip.props.style)?.minHeight,
    ).toBeGreaterThanOrEqual(44);
  });
});
