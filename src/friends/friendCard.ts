/**
 * Friends on playa — a serverless friend map (owner commission 2026-08-19).
 *
 * The shape BurnerMap pioneered — "where are my people camped this year" —
 * rebuilt on this app's own primitives so the answer never touches a server:
 * your CARD (playa name, camp, address, a find-me note) is a small JSON file
 * you hand directly to friends over AirDrop / Quick Share / LocalSend, and
 * theirs land on your phone through the same "Import a pack…" button every
 * beam uses. Address strings resolve through the city geometry, so a
 * friend's row links straight to the whiteout compass and carries a walk
 * time. "Beam my friends" re-exports every card you hold, verbatim — the
 * camp board's multi-hop gossip trick — so one organized person at a
 * pre-party can collect and redistribute a whole crew with zero
 * infrastructure.
 *
 * CONFLICT RULE (one writer per card): each card carries its author's
 * monotonically increasing `seq`; an import keeps the greatest seq per card
 * id and reports lower ones as stale. Your own id is never overwritten by
 * an import.
 *
 * PILOT HONESTY (same posture as the camp beam): cards are not signed or
 * encrypted. The trust model is the exchange itself — you accepted a file
 * from a person you chose to accept it from. Anyone who has a card file can
 * read it and forward it; share what you'd write on a note board.
 */

import type { DbConnection as QuickSQLiteConnection } from '../events/engine';

export const FRIEND_BUNDLE_KIND = 'playapal-friend-card';
export const FRIEND_BUNDLE_FORMAT = 1;
export const FRIEND_SELF_KEY = 'friend_self_card';
/** Remembered "just for you / pass it on" choice (the share flow asks once,
 * then defaults to the last pick — owner design: default = ASK, remember
 * last choice). */
export const FRIEND_LAST_SCOPE_KEY = 'friend_last_scope';
export function getLastScope(conn: QuickSQLiteConnection): FriendScope | null {
  const v = kvGet(conn, FRIEND_LAST_SCOPE_KEY);
  return v === 'direct' || v === 'crew' ? v : null;
}
export function setLastScope(
  conn: QuickSQLiteConnection,
  scope: FriendScope,
): void {
  kvSet(conn, FRIEND_LAST_SCOPE_KEY, scope);
}
/** Gossip bound: nobody needs more cards than a big village in one file. */
export const MAX_BUNDLE_CARDS = 64;

const FIELD_MAX = 80;
const NOTE_MAX = 160;
const ID_RE = /^[0-9a-f]{8}$/;

/** Share scope the AUTHOR picks (owner's consent catch 2026-08-19): 'crew'
 * = pass it on (the gossip behavior), 'direct' = just for the person I hand
 * it to — exportFriendsBundle skips direct cards. */
export type FriendScope = 'crew' | 'direct';

export interface FriendCard {
  /** Author's per-install random id — stable across edits, so re-shares update. */
  id: string;
  /** Author's own edit counter; greatest wins on import. */
  seq: number;
  name: string;
  camp: string;
  /** Playa address as typed ("7:32 & C", "Esplanade & 4:15", "Center Camp"). */
  address: string;
  note: string;
  updated_at: string;
  scope: FriendScope;
}

export interface FriendBundle {
  kind: typeof FRIEND_BUNDLE_KIND;
  format: number;
  cards: FriendCard[];
}

export interface FriendInstallResult {
  added: string[];
  updated: string[];
  unchanged: number;
  stale: number;
}

// ------------------------------------------------------------- revisions
// One shared refresh path for every entry point (picker import, deep link,
// in-section edits): writers bump, mounted readers subscribe (review
// 2026-08-19: imports left mounted sections stale until remount).

type FriendsListener = () => void;
const friendsListeners = new Set<FriendsListener>();

export function subscribeFriendsChanged(cb: FriendsListener): () => void {
  friendsListeners.add(cb);
  return () => {
    friendsListeners.delete(cb);
  };
}

export function notifyFriendsChanged(): void {
  for (const cb of friendsListeners) {
    cb();
  }
}

/**
 * "Show my card" asked for from SOMEWHERE ELSE on the page — the same
 * listener shape one function up, for a request instead of a change.
 *
 * WHY (sharing audit, docs/SHARING-SURFACES.md §3.1/§3.3): the Camp tab's
 * "Share & receive" section needs a working "show my card as a QR" row, but
 * the QR modal, the "just for them / pass it on" consent ask, and the export
 * validation all live in FriendsSection further down the same scroll — and
 * they belong there, beside the card and its scope chips. Duplicating any of
 * that into a second call site would fork the ONE consent primitive in the
 * app, which is exactly what must not happen. So the Share row REQUESTS, and
 * FriendsSection — the owner of the card — answers with its existing flow.
 * The modal is an overlay, so it lands over the page wherever it is scrolled.
 *
 * A request with nobody listening is a silent no-op by design: FriendsSection
 * is always mounted by CampScreen, and if that ever stops being true, a dead
 * tap beats a crash.
 */
type MyCardQrListener = () => void;
const myCardQrListeners = new Set<MyCardQrListener>();

export function subscribeMyCardQr(cb: MyCardQrListener): () => void {
  myCardQrListeners.add(cb);
  return () => {
    myCardQrListeners.delete(cb);
  };
}

export function requestMyCardQr(): void {
  for (const cb of myCardQrListeners) {
    cb();
  }
}

const kvGet = (conn: QuickSQLiteConnection, key: string): string | null => {
  const res = conn.execute('SELECT value FROM settings WHERE key = ?', [key]);
  return res.rows && res.rows.length > 0 ? res.rows.item(0).value : null;
};

const kvSet = (conn: QuickSQLiteConnection, key: string, value: string): void => {
  conn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
};

const randHex = (chars: number): string => {
  let s = '';
  while (s.length < chars) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
};

const clean = (raw: string): string =>
  // eslint-disable-next-line no-control-regex -- stripping controls IS the point
  raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * One normalizer for one serialization. `allowBlankName` is the ONLY axis
 * that differs, and only ever for MY OWN card in my own settings: a
 * nameless card off the wire is a stranger nobody can be shown as, but a
 * nameless card of mine is the real, legal "minted, not filled in yet"
 * state that getMyCard persists (see below). Every wire path — the bundle
 * sniff, the install — keeps the strict default.
 */
const asCard = (raw: unknown, allowBlankName = false): FriendCard | null => {
  const r = raw as Record<string, unknown>;
  const id = String(r?.id ?? '');
  const seq = Number(r?.seq);
  if (!ID_RE.test(id) || !Number.isInteger(seq) || seq < 0) {
    return null;
  }
  const name = clean(String(r?.name ?? '')).slice(0, FIELD_MAX);
  if (name.length === 0 && !allowBlankName) {
    return null;
  }
  return {
    id,
    seq,
    name,
    camp: clean(String(r?.camp ?? '')).slice(0, FIELD_MAX),
    address: clean(String(r?.address ?? '')).slice(0, FIELD_MAX),
    note: clean(String(r?.note ?? '')).slice(0, NOTE_MAX),
    updated_at: clean(String(r?.updated_at ?? '')).slice(0, 32),
    // Migration default: cards written before the scope field existed (or by
    // an older app version) behave exactly as they always did — gossipable.
    scope: r?.scope === 'direct' ? 'direct' : 'crew',
  };
};

// ---------------------------------------------------------------- my card

export interface MyCardFields {
  name: string;
  camp: string;
  address: string;
  note: string;
  /** Omitted = keep the card's current scope (edits don't silently reset
   * consent). The editor always passes it explicitly. */
  scope?: FriendScope;
}

/** My own card as stored — blank name allowed, corrupt storage is not. */
const readSelfCard = (raw: string): FriendCard | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable settings value: there is nothing in it to keep, and this
    // runs on read paths that must not throw. Fall through to a fresh mint,
    // which overwrites it.
    return null;
  }
  return asCard(parsed, true);
};

/**
 * The id this phone minted but could not store. Per connection, so two
 * phones in one process (every multi-phone test, and a db swap at runtime)
 * never share an identity.
 */
const mintedIds = new WeakMap<QuickSQLiteConnection, string>();

/**
 * Mint this phone's identity AND commit it, in that order, before any
 * caller can compose with it.
 */
const mintMyCard = (conn: QuickSQLiteConnection): FriendCard => {
  const card: FriendCard = {
    id: mintedIds.get(conn) ?? randHex(8),
    seq: 0,
    name: '',
    camp: '',
    address: '',
    note: '',
    updated_at: '',
    scope: 'crew',
  };
  mintedIds.set(conn, card.id);
  try {
    // saveMyCard's exact shape and key — one card format, one writer's
    // serialization. The next real save reads this back as `prev` and keeps
    // the id, which is what makes mail sent before naming still read as
    // mine afterwards.
    kvSet(conn, FRIEND_SELF_KEY, JSON.stringify(card));
  } catch {
    // A storage that refuses the write must not take down the tab bar. The
    // memo above already pinned the id for the life of the process, which
    // is the property the pod rails actually need.
  }
  // Deliberately NOT notifyFriendsChanged(): no listener can observe a
  // difference (same blank card, same id it was already handed), and this
  // runs inside render and useState paths where a store notification would
  // re-enter React mid-render.
  return card;
};

/**
 * This phone's card; a blank one (seq 0, empty name) before first save.
 *
 * MINTING AN ID IS A WRITE (release blocker 2026-08-24). The id in this
 * card is this phone's identity on the pod rails: messages.ts stamps
 * hash32(id) into every record's from_hash, and the inbox predicate's
 * "from_hash != mine" is the whole reason my own mail stays out of my own
 * inbox. A phone that skipped setup has no saved card — saveMyCard refuses
 * a nameless one, and onboarding only writes a card if a name was given —
 * so this used to hand out a FRESH RANDOM id on every call. Then the Pods
 * badge (recomputed per revision, with a new id each time) counted the
 * camper's OWN messages as waiting mail, while the open pod (frozen on its
 * mount id) read zero; nothing could clear it, because marking read skips
 * mail I sent. One phantom ① per message the camper sent, for the message's
 * full TTL.
 *
 * So the id is persisted the moment it is minted. Everything downstream —
 * the badge, the pod header, sharing, the camp announce, the board's
 * writer-id fallback — inherits one stable identity instead of guarding
 * against a moving one.
 */
export function getMyCard(conn: QuickSQLiteConnection): FriendCard {
  const raw = kvGet(conn, FRIEND_SELF_KEY);
  if (raw) {
    const card = readSelfCard(raw);
    if (card) {
      return card;
    }
  }
  return mintMyCard(conn);
}

/** Save = one edit: the seq bumps, so friends' imports know newest wins. */
export function saveMyCard(
  conn: QuickSQLiteConnection,
  fields: MyCardFields,
  now: Date = new Date(),
): FriendCard {
  if (clean(fields.name).length === 0) {
    // A card is how a friend knows WHO landed on their phone: the wire
    // parser drops a nameless one, and the exports refuse to send it. The
    // id no longer rides on this check — getMyCard persists the blank card
    // at mint time and reads it back — but a save that produces a card
    // nobody can receive is still a save that must not happen silently
    // (review 2026-08-19, id rotation closed 2026-08-24).
    throw new Error('Your card needs a name — that is how friends know you.');
  }
  // prev is the minted blank card on a first save, so its id — already
  // stamped into anything sent before naming — carries into the real card.
  const prev = getMyCard(conn);
  const card: FriendCard = {
    id: prev.id,
    seq: prev.seq + 1,
    name: clean(fields.name).slice(0, FIELD_MAX),
    camp: clean(fields.camp).slice(0, FIELD_MAX),
    address: clean(fields.address).slice(0, FIELD_MAX),
    note: clean(fields.note).slice(0, NOTE_MAX),
    updated_at: now.toISOString(),
    scope: fields.scope ?? prev.scope,
  };
  kvSet(conn, FRIEND_SELF_KEY, JSON.stringify(card));
  notifyFriendsChanged();
  return card;
}

// ---------------------------------------------------------------- friends

export function listFriends(conn: QuickSQLiteConnection): FriendCard[] {
  const res = conn.execute(
    'SELECT * FROM friend_cards ORDER BY address, name COLLATE NOCASE',
  );
  const rows = (res.rows?._array ?? []) as FriendCard[];
  return rows.map(r => ({
    ...r,
    seq: Number(r.seq),
    // Old rows (pre-migration) carry the column default 'crew'; anything
    // unexpected fails open to crew = the historical behavior.
    scope: (r as any).scope === 'direct' ? 'direct' : 'crew',
  }));
}

export function removeFriend(conn: QuickSQLiteConnection, id: string): void {
  conn.execute('DELETE FROM friend_cards WHERE id = ?', [id]);
  notifyFriendsChanged();
}

// ------------------------------------------------------------ wire format

/** My card alone — the file you hand a friend. */
export function exportMyCard(conn: QuickSQLiteConnection): string {
  const me = getMyCard(conn);
  if (me.name.length === 0) {
    throw new Error('Fill in your card first — at least your name.');
  }
  // Sharing this card IS the consent moment: the pick at share time becomes
  // the card's scope, so what I hand over carries my intent with it.
  const picked = getLastScope(conn) ?? me.scope;
  const bundle: FriendBundle = {
    kind: FRIEND_BUNDLE_KIND,
    format: FRIEND_BUNDLE_FORMAT,
    cards: [{ ...me, scope: picked }],
  };
  return JSON.stringify(bundle, null, 1);
}

/**
 * Every card this phone holds that its AUTHOR marked "pass it on" — the
 * gossip export that lets one person assemble a crew's map and pass it on.
 * scope:direct cards are skipped: their author handed them to specific
 * people, not to the room. (Honor-system like the beam: the receiving app
 * respects the bit; a hand-edited file can lie — see the header's PILOT
 * HONESTY note.)
 */
export function exportFriendsBundle(conn: QuickSQLiteConnection): string {
  const me = getMyCard(conn);
  const cards = [
    ...(me.name.length > 0 && me.scope === 'crew' ? [me] : []),
    ...listFriends(conn).filter(f => f.scope === 'crew'),
  ];
  if (cards.length === 0) {
    throw new Error(
      'No cards to beam yet — fill in yours or import a friend. (Cards shared "just with you" stay with you.)',
    );
  }
  const bundle: FriendBundle = {
    kind: FRIEND_BUNDLE_KIND,
    format: FRIEND_BUNDLE_FORMAT,
    cards: cards.slice(0, MAX_BUNDLE_CARDS),
  };
  return JSON.stringify(bundle, null, 1);
}

/** Sniff: is this JSON a friend bundle? (Import button, before camp beams.) */
export function parseFriendBundle(text: string): FriendBundle | null {
  if (text.length > 256 * 1024) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r?.kind !== FRIEND_BUNDLE_KIND || !Array.isArray(r?.cards)) {
    return null;
  }
  if (Number(r?.format) !== FRIEND_BUNDLE_FORMAT) {
    return null;
  }
  const cards: FriendCard[] = [];
  for (const c of (r.cards as unknown[]).slice(0, MAX_BUNDLE_CARDS)) {
    const card = asCard(c);
    if (!card) {
      return null; // one malformed card poisons the file: refuse whole, honestly
    }
    cards.push(card);
  }
  if (cards.length === 0) {
    return null;
  }
  return { kind: FRIEND_BUNDLE_KIND, format: FRIEND_BUNDLE_FORMAT, cards };
}

/** Upsert per card id, greatest seq wins; my own id is never imported. */
export function installFriendBundle(
  conn: QuickSQLiteConnection,
  text: string,
): FriendInstallResult {
  const bundle = parseFriendBundle(text);
  if (!bundle) {
    throw new Error('This file is not a Playa Pal friend card.');
  }
  const myId = getMyCard(conn).id;
  const result: FriendInstallResult = {
    added: [],
    updated: [],
    unchanged: 0,
    stale: 0,
  };
  conn.execute('BEGIN');
  try {
    for (const card of bundle.cards) {
      if (card.id === myId) {
        continue; // your own card riding back in a gossip bundle
      }
      const prev = conn.execute('SELECT seq FROM friend_cards WHERE id = ?', [
        card.id,
      ]);
      const prevSeq =
        prev.rows && prev.rows.length > 0 ? Number(prev.rows.item(0).seq) : null;
      if (prevSeq !== null && card.seq < prevSeq) {
        result.stale += 1;
        continue;
      }
      if (prevSeq !== null && card.seq === prevSeq) {
        result.unchanged += 1;
        continue;
      }
      conn.execute(
        `INSERT INTO friend_cards (id, seq, name, camp, address, note, updated_at, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           seq = excluded.seq, name = excluded.name, camp = excluded.camp,
           address = excluded.address, note = excluded.note,
           updated_at = excluded.updated_at, scope = excluded.scope`,
        [card.id, card.seq, card.name, card.camp, card.address, card.note, card.updated_at, card.scope],
      );
      (prevSeq === null ? result.added : result.updated).push(card.name);
    }
    conn.execute('COMMIT');
  } catch (e) {
    conn.execute('ROLLBACK');
    throw e;
  }
  if (result.added.length > 0 || result.updated.length > 0) {
    notifyFriendsChanged();
  }
  return result;
}

// ------------------------------------------------------------- paper map

/**
 * The printable list — BurnerMap's beloved paper artifact. Plain text,
 * sorted by clock address, ready for the share sheet and a home printer.
 */
export function friendsListText(conn: QuickSQLiteConnection): string {
  const me = getMyCard(conn);
  const lines: string[] = ['FRIENDS ON PLAYA', ''];
  if (me.name.length > 0) {
    lines.push(entryLine({ ...me, name: `${me.name} (me)` }));
  }
  for (const f of listFriends(conn)) {
    lines.push(entryLine(f));
  }
  lines.push('', 'Made with Playa Pal — offline, on-device, no server.');
  return lines.join('\n');
}

const entryLine = (c: FriendCard): string => {
  const where = [c.address, c.camp].filter(s => s.length > 0).join(' — ');
  const note = c.note.length > 0 ? `  (${c.note})` : '';
  return `${(where || 'address TBD').padEnd(28)} ${c.name}${note}`;
};
