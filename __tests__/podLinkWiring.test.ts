/**
 * Rung 0's LAST MILE — the pod invite actually arriving somewhere
 * (docs/WALKIE-LADDER.md §8).
 *
 * podLink.test.ts pins the codec. This file pins the thing the codec was
 * for, and it exists because that thing was missing: the encoder, the QR,
 * the share sheet and both Android intent filters shipped, while
 * `decodePodLink` and `inviteCardBundleJson` had ZERO production callers.
 * A scanned pod QR opened Playa Pal and nothing happened — a claimed URL
 * that dead-ends, which is worse than never claiming it, because the camper
 * standing there has no way to tell a broken feature from a broken phone.
 *
 * TWO KINDS OF TEST, deliberately separated (the sharingSurfaces.test.ts
 * shape, for the same reason it was chosen there):
 *
 *   - REAL unit tests of the join the confirm button performs, run against
 *     the shipped modules on the app's own DDL — what a Join writes, what a
 *     decline leaves behind, and what a second scan of the same invite does;
 *   - SOURCE assertions that App.tsx's URL handler is wired to exactly that
 *     sequence, each written to DIE on a specific mutation named beside it.
 *     App.tsx is not renderable in a unit suite (it mounts the llama session,
 *     the speech registry and the fs layer at import), which is why
 *     navigationIA.test.ts already pins App.tsx by reading it.
 *
 * The source half is what binds the unit half to the app: `confirmJoin`
 * below is the confirm button's body transcribed, and the assertions in
 * "the URL handler is wired to that join" are what stop the two drifting.
 */

let mockConn: any;
let mockSettings: Map<string, string>;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import { ADDITIVE_COLUMNS, BASE_TABLES_SQL } from '../src/events/schema';
import {
  canAdoptPodName,
  joinCrew,
  listCrews,
  placeholderPodName,
  podDisplayName,
  podNameSource,
  saveCrew,
} from '../src/crews/crew';
import {
  installFriendBundle,
  listFriends,
  saveMyCard,
  type FriendCard,
} from '../src/friends/friendCard';
import {
  decodePodLink,
  encodePodLink,
  encodePodSchemeLink,
  inviteCardBundleJson,
  type PodInvite,
} from '../src/crews/podLink';

const { DatabaseSync } = require('node:sqlite');

/** One phone: its own in-memory db on the REAL shipped DDL (including the
 * additive migrations the app runs at boot), plus its own settings map for
 * the crew store. */
function makeInvitePhone(): void {
  const db = new DatabaseSync(':memory:');
  for (const sql of BASE_TABLES_SQL) {
    db.exec(sql);
  }
  for (const m of ADDITIVE_COLUMNS) {
    const cols = (db.prepare(`PRAGMA table_info(${m.table})`).all() as any[]).map(
      (c: any) => String(c.name),
    );
    if (!cols.includes(m.column)) {
      db.exec(m.ddl);
    }
  }
  mockConn = {
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
  mockSettings = new Map();
}

/** The inviter's card, as it rides inside an invite. */
const INVITER: FriendCard = {
  id: 'facec0de',
  seq: 3,
  name: 'Sparkle',
  camp: 'Camp Questionable',
  address: '4:30 & Esplanade',
  note: 'wakes late',
  updated_at: '2026-08-24T10:00:00.000Z',
  scope: 'crew',
};

const NAMED_INVITE: PodInvite = {
  code: '4821',
  name: 'Dust Bunnies',
  card: INVITER,
  radios: 3,
};

/**
 * THE CONFIRM BUTTON'S BODY, transcribed from App.tsx's askToJoinPod.
 *
 * Kept in one place so a reader can see the whole write in one glance, and
 * pinned to the real one by the source assertions at the bottom of this
 * file. Everything it calls is the shipped module, not a stand-in.
 */
function confirmJoin(invite: PodInvite): void {
  const joined = joinCrew(invite.code);
  if (
    invite.name !== undefined &&
    invite.name !== joined.name &&
    canAdoptPodName(joined)
  ) {
    saveCrew({ ...joined, name: invite.name, nameSource: 'mesh' });
  }
  const bundle = inviteCardBundleJson(invite);
  if (bundle) {
    installFriendBundle(mockConn, bundle);
  }
}

beforeEach(() => {
  makeInvitePhone();
});

describe('a scanned pod link decodes into an invite the app can act on', () => {
  test('both carriers round-trip, whole', () => {
    // Mutation: an entry point that decodes only the https carrier. The QR
    // encodes the SCHEME link on purpose (it opens the app offline whatever
    // app-link verification says), so a scheme-blind handler dead-ends on
    // exactly the path a camper standing in front of you uses.
    expect(decodePodLink(encodePodSchemeLink(NAMED_INVITE))).toEqual(NAMED_INVITE);
    expect(decodePodLink(encodePodLink(NAMED_INVITE))).toEqual(NAMED_INVITE);
  });

  test('the pod NAME arrives with the link, before the pod does', () => {
    const invite = decodePodLink(encodePodSchemeLink(NAMED_INVITE))!;
    expect(invite.name).toBe('Dust Bunnies');
  });

  test('an unnamed pod still names itself honestly in the ask', () => {
    // What the consent ask puts in its title when the inviter never named
    // the pod. Never the bare code: "Join 4821?" is a machine talking, and
    // crew.ts already owns the answer.
    const invite = decodePodLink(encodePodSchemeLink({ code: '4821' }))!;
    expect(invite.name).toBeUndefined();
    expect(placeholderPodName(invite.code)).toBe('Pod 4821');
  });

  test('a friend link and a beam link are not pod invites', () => {
    // Mutation: dropping the path anchor. Three filter families share one
    // handler, and the pod branch runs LAST — an over-eager decoder would
    // offer to join a pod when a camper scanned a friend card.
    expect(decodePodLink('https://playapal.lol/f#abcdef')).toBeNull();
    expect(decodePodLink('https://playapal.lol/b#abcdef')).toBeNull();
  });
});

describe('declining writes nothing at all', () => {
  test('a decoded invite that is never confirmed leaves no pod and no card', () => {
    // The whole point of asking. Decoding must not be joining: the URL
    // arrives from a camera pointed at a stranger's screen, and until the
    // camper taps Join there is no relationship to record.
    const invite = decodePodLink(encodePodSchemeLink(NAMED_INVITE))!;
    expect(invite.code).toBe('4821');
    expect(listCrews()).toEqual([]);
    expect(listFriends(mockConn)).toEqual([]);
  });

  test('a second scan asks again — nothing about the decline persists', () => {
    // Mutation: remembering a declined invite (a "don't ask again" set).
    // A decline is "not now", said to a person standing there; the invite
    // is just a URL and scanning it again is a fresh ask.
    decodePodLink(encodePodSchemeLink(NAMED_INVITE));
    const again = decodePodLink(encodePodSchemeLink(NAMED_INVITE));
    expect(again).toEqual(NAMED_INVITE);
    expect(listCrews()).toEqual([]);
  });
});

describe('confirming joins the pod and installs the inviter', () => {
  test('the pod exists, under the name the invite carried', () => {
    confirmJoin(decodePodLink(encodePodSchemeLink(NAMED_INVITE))!);
    const crews = listCrews();
    expect(crews).toHaveLength(1);
    expect(crews[0].code).toBe('4821');
    expect(podDisplayName(crews[0])).toBe('Dust Bunnies');
  });

  test("the invite's name is adopted as the MESH's, never as this phone's", () => {
    // The load-bearing one. joinCrew(code, name) stores nameSource 'mine',
    // which would (a) freeze the pod against a later rename and (b) make
    // this phone re-broadcast a name it never chose — podMembers.ts records
    // that exact regression as measured on two phones. A rung-0 invite is
    // the mesh delivered by eyeball, so it adopts under the mesh's rule.
    confirmJoin(NAMED_INVITE);
    const crew = listCrews()[0];
    expect(podNameSource(crew)).toBe('mesh');
    expect(canAdoptPodName(crew)).toBe(true);
  });

  test('a name typed on THIS phone is never overwritten by an invite', () => {
    // Mutation: adopting unconditionally. Someone who named their own pod
    // and is later handed a link to it keeps their name.
    saveCrew({
      id: 'crew-local-1',
      name: 'My little pod',
      code: '4821',
      memberIds: [],
      nameSource: 'mine',
    });
    confirmJoin(NAMED_INVITE);
    const crews = listCrews();
    expect(crews).toHaveLength(1);
    expect(crews[0].name).toBe('My little pod');
    expect(podNameSource(crews[0])).toBe('mine');
  });

  test('the invite IS a card swap — the inviter has a face immediately', () => {
    confirmJoin(NAMED_INVITE);
    const friends = listFriends(mockConn);
    expect(friends).toHaveLength(1);
    expect(friends[0].id).toBe('facec0de');
    expect(friends[0].name).toBe('Sparkle');
    expect(friends[0].address).toBe('4:30 & Esplanade');
  });

  test('the card rides the SAME importer a beamed friend card uses', () => {
    // Mutation: a second import path. installFriendBundle owns the merge
    // rules (greatest seq wins, my own id skipped) and there must be exactly
    // one copy of them — so the invite's card is handed over as a bundle,
    // not written to friend_cards directly.
    const bundle = inviteCardBundleJson(NAMED_INVITE)!;
    const parsed = JSON.parse(bundle);
    expect(parsed.kind).toBe('playapal-friend-card');
    expect(parsed.cards).toEqual([INVITER]);
    const r = installFriendBundle(mockConn, bundle);
    expect(r.added).toEqual(['Sparkle']);
  });

  test('a stale card in an old invite never overwrites a newer one', () => {
    // The merge rule doing its job through this path: a link forwarded
    // around camp for two days carries the card as it was, and the newer
    // card already on this phone wins.
    installFriendBundle(
      mockConn,
      JSON.stringify({
        kind: 'playapal-friend-card',
        format: 1,
        cards: [{ ...INVITER, seq: 9, address: '7:15 & Ballyhoo' }],
      }),
    );
    confirmJoin(NAMED_INVITE);
    expect(listFriends(mockConn)[0].address).toBe('7:15 & Ballyhoo');
  });

  test('my own card riding back in an invite is not imported as a friend', () => {
    // Scanning an invite I minted (or one that carries my card because a
    // podmate forwarded mine) must not put me in my own friend list.
    const me = saveMyCard(mockConn, {
      name: 'Pug',
      camp: 'Camp Questionable',
      address: '4:30 & Esplanade',
      note: '',
    });
    confirmJoin({ code: '4821', name: 'Dust Bunnies', card: me });
    expect(listFriends(mockConn)).toEqual([]);
    expect(listCrews()).toHaveLength(1);
  });

  test('an invite with no card still joins the pod', () => {
    // fitPodInvite drops the card rather than refusing the invite when it
    // overflows one QR, so a card-less invite is a NORMAL invite, not a
    // damaged one.
    confirmJoin({ code: '4821', name: 'Dust Bunnies', radios: 3 });
    expect(listCrews()).toHaveLength(1);
    expect(listFriends(mockConn)).toEqual([]);
  });

  test('scanning the same invite twice lands in the same pod, once', () => {
    // The code is the identity and joinCrew is idempotent on it. Mutation:
    // minting a crew per scan — two phones measured exactly that in August,
    // and every message then had two places to live.
    confirmJoin(NAMED_INVITE);
    confirmJoin(NAMED_INVITE);
    expect(listCrews()).toHaveLength(1);
    expect(listFriends(mockConn)).toHaveLength(1);
  });

  test('a scanned invite and a typed PIN are the same pod', () => {
    // The §8 invariant: the link is a second DOOR, never a second room.
    joinCrew('4821');
    confirmJoin(NAMED_INVITE);
    const crews = listCrews();
    expect(crews).toHaveLength(1);
    // ...and the typed join's placeholder gives way to the invite's name.
    expect(podDisplayName(crews[0])).toBe('Dust Bunnies');
  });

  test("the inviter's radios is carried and deliberately not stored", () => {
    // THE RADIOS FINDING, pinned so it cannot be quietly "fixed" the wrong
    // way. `radios` is CAPABILITY, and §5's rule is that a phone announces
    // its own. The announce/reconcile seam only ever puts THIS phone's rungs
    // on the air (reconcilePods takes myRungsSync()), and the only store of
    // a peer's rungs is announcedMembers() — records that peer authored.
    // Writing the inviter's bitmap there would mint a record in their name
    // that the relay then spreads as their word. So joining reads the field
    // and stores nothing: the inviter's own announcement carries the same
    // number over rung 1/2.
    const invite = decodePodLink(encodePodSchemeLink(NAMED_INVITE))!;
    expect(invite.radios).toBe(3);
    confirmJoin(invite);
    expect(JSON.stringify(listCrews())).not.toContain('radios');
  });
});

describe('the URL handler is wired to that join', () => {
  // Named readAppFile, not `readSrc`/`readFile`: those top-level names
  // already belong to navigationIA.test.ts and sharingSurfaces.test.ts, and
  // a suite that redeclares one is a tsc error (TS2451) jest never shows.
  const readAppFile = (p: string): string =>
    require('fs').readFileSync(p, 'utf8') as string;
  const app = readAppFile('App.tsx');
  const beamAt = app.indexOf('const beamJson = decodeBeamLink(url);');
  const friendAt = app.indexOf('const json = decodeFriendLink(url);');
  const podAt = app.indexOf('const invite = decodePodLink(url);');
  const askAt = app.indexOf('const askToJoinPod = useCallback(');
  const ask = askAt < 0 ? '' : app.slice(askAt, app.indexOf('useEffect(() => {', askAt));

  test('the pod branch exists in the one URL entry point', () => {
    // Mutation: the codec shipping with no caller — which is the exact bug
    // this file was opened for.
    expect(podAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(-1);
    expect(app).toContain('askToJoinPod(invite)');
  });

  test('it decodes beam, then friend, then pod', () => {
    expect(beamAt).toBeGreaterThan(-1);
    expect(friendAt).toBeGreaterThan(-1);
    expect(beamAt).toBeLessThan(friendAt);
    expect(friendAt).toBeLessThan(podAt);
  });

  test('a friend link still returns before the pod decode', () => {
    // Mutation: dropping the friend branch's `return`, which would offer a
    // pod join after every installed card.
    expect(app.slice(friendAt, podAt)).toContain('return;');
  });

  test('the ask comes BEFORE any write', () => {
    // The consent rule as a source fact: in askToJoinPod the Alert is
    // raised first, and every call that touches storage sits inside the
    // confirm button's onPress. Mutation: joining on decode and telling the
    // camper afterwards.
    const alertAt = ask.indexOf('Alert.alert(');
    const pressAt = ask.indexOf('onPress:');
    expect(alertAt).toBeGreaterThan(-1);
    expect(pressAt).toBeGreaterThan(alertAt);
    expect(ask.indexOf('joinCrew(')).toBeGreaterThan(pressAt);
    expect(ask.indexOf('installFriendBundle(')).toBeGreaterThan(pressAt);
    expect(ask.indexOf("openTab('pod')")).toBeGreaterThan(pressAt);
  });

  test('the ask is the app\'s two-button consent shape, decline first', () => {
    // The disband ask's shape (CrewSection.tsx): a cancel-styled way out
    // listed first, and it carries NO onPress — declining runs no code.
    expect(ask).toContain("{ text: 'Not now', style: 'cancel' },");
    expect(ask.indexOf("text: 'Not now'")).toBeLessThan(ask.indexOf("text: 'Join'"));
  });

  test('the ask names the pod, and never shows a bare code', () => {
    // Mutation: `Join ${invite.code}?`. crew.ts owns the honest stand-in.
    expect(ask).toContain('invite.name ?? placeholderPodName(invite.code)');
    expect(ask).toContain('Join ${podName}?');
  });

  test('the ask says who it is from when the card rides along', () => {
    expect(ask).toContain('invite.card?.name.trim()');
    expect(ask).toContain('invited you');
  });

  test('the ask tells the truth about what joining does', () => {
    // The pod card's own join-code copy is the register: "Anyone who has it
    // sees the pod's names, and where the people sharing are." Names go out
    // on joining; position only while sharing is on. Mutation: a cheerful
    // "You're in!" that says neither.
    expect(ask).toContain('puts your name on the air in this pod');
    expect(ask).toContain("where you are while you're sharing");
  });

  test('the confirm does not hand the invite name to joinCrew', () => {
    // Mutation: joinCrew(invite.code, invite.name) — which stores
    // nameSource 'mine' and starts this phone re-announcing a name it never
    // chose. The adopt below it is the correct door.
    expect(ask).toContain('joinCrew(invite.code)');
    expect(ask).not.toContain('joinCrew(invite.code,');
    expect(ask).toContain("nameSource: 'mesh'");
    expect(ask).toContain('canAdoptPodName(joined)');
  });

  test('a card that will not install never costs the pod', () => {
    // Mutation: one try block around both writes. The join is what the
    // camper consented to; the card is a courtesy the mesh repeats anyway.
    const joinAt = ask.indexOf('joinCrew(invite.code)');
    const cardAt = ask.indexOf('installFriendBundle(');
    expect(ask.slice(joinAt, cardAt)).toContain('catch');
    expect(ask.indexOf("openTab('pod')")).toBeGreaterThan(cardAt);
  });

  test('a successful join lands on the Pods tab', () => {
    // Not decoration: openTab('pod') is what MOUNTS CrewSection, whose
    // reconcile effect announces this phone into the pod it just joined.
    expect(ask).toContain("openTab('pod')");
    expect(app).toContain("if (t === 'pod') {");
  });
});
