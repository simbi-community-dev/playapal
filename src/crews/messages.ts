/**
 * Crew messages — the store + gossip policy of "the answering machine"
 * (docs/CREW-DESIGN.md §6b: async = ONE composed UX; §6a: texting is
 * connect-and-WRITE plus store-and-forward gossip). Pure TypeScript over
 * the app DB: the radio that actually moves bytes is an injected link one
 * file over (src/crews/syncLink.ts), mirroring how session.ts treats the
 * BLE radio — everything here runs identically under node:sqlite in tests
 * and on-device.
 *
 * THE MODEL. A message is a small immutable record minted ONCE by its
 * sender and then COPIED phone to phone whenever radios meet, until it
 * expires. Nothing is ever edited in place, so replication needs no merge
 * rules: the sender-minted id (memberHash hex + created_min + 4 random
 * hex) arrives identical over every gossip path and dedupe is just the
 * primary key. hops counts copies-of-copies and caps the gossip horizon.
 *
 * TYPED RECORDS, ONE SUBSTRATE. A pod message is not the only thing a
 * camp needs to propagate: a board post and a camp note are structurally
 * the SAME object — id, author, body, expiry — and today they move by
 * hand (export → Quick Share → import) while this layer already does real
 * gossip. So the store carries typed RECORDS keyed by `kind`, and the
 * pod's two kinds ('text', 'voice' — unchanged in every byte, on the wire
 * and in the table) are simply the two that the answering machine reads.
 * 'board-post' and 'camp-note' are RESERVED here: the substrate stores,
 * relays and serves them, and nothing publishes them yet. 'pod-member' is
 * the first NON-POD kind with a live publisher — src/crews/podMembers.ts
 * owns its body codec; this file only knows what it costs the mesh.
 *
 * Every gate reads its numbers from KIND_POLICY, never from a global — a
 * camp note is not a 5-second voice note, so caps, TTL, hop horizon and
 * the heard-row budget are all per kind. An UNKNOWN kind off a peer is
 * refused at the accept gate and never stored: relaying bytes whose
 * policy this build cannot name is exactly how a store grows junk.
 *
 * CARRY ≠ SHOW applies twice over: inbox()/unreadCount()/myOutbox() are
 * POD-ONLY by construction, so records of other kinds ride the same rails
 * without ever appearing in the answering machine. recordsOfKind() is the
 * typed reader a future board/notes lane calls.
 *
 * RELAY IS IMPLICIT. syncDigest() offers EVERYTHING this phone carries —
 * its own mail and everything heard — so any phone that wanders past
 * another physically carries the camp's mail (§6a: "a campmate walking
 * across camp carries the mail"). There is deliberately NO base-station
 * special case in this file: the always-on solar Android at camp (§6b)
 * differs only by being always awake and always in range, so it becomes
 * the reliable mailbox purely by existing. One policy, every phone.
 *
 * CARRY ≠ SHOW. A phone relays messages addressed to OTHER people; the
 * inbox filter (to_hash null-or-mine), not the store, is the privacy
 * line. Bodies are readable by any carrier — the friend-card posture
 * ("share what you'd write on a note board") stated honestly, not
 * encryption theater. The transport layer owns any on-air wrapping.
 *
 * TIME. Everything in this lane is EPOCH MINUTES (matching the beacon's
 * epochMin vocabulary and the wire columns); epochMinutes() converts at
 * the call boundary. Clocks and randomness are injected — no Date.now()
 * or Math.random() inside the policy functions — so every behavior here
 * replays exactly in tests.
 *
 * NO CACHE, ON PURPOSE (unlike favorites' key-set cache): the store must
 * stay connection-agnostic, because the multi-phone gossip tests — and
 * any future base-mode diagnostics — swap the underlying DB between
 * calls. Message reads are per-screen, not per-card-render, so there is
 * no hot path to save.
 */

import { getDb } from '../events/db';
import { hash32, normalizeCrewCode } from './beacon';

type Conn = ReturnType<typeof getDb>;
type Row = Record<string, unknown>;

/**
 * The POD kinds — what the answering machine composes and shows. These two
 * literals are the shipped wire values and are deliberately NOT renamed to
 * 'pod-text'/'pod-voice': the string in this column IS the on-air token,
 * and a rename would strand every phone already carrying the old one for
 * zero behavior gained. In design language these are the pod kinds; on the
 * wire they stay 'text' and 'voice'.
 */
export type MessageKind = 'text' | 'voice';

/**
 * Every kind the substrate can store, relay and serve. 'board-post' and
 * 'camp-note' are RESERVED: KIND_POLICY names their cost so a peer's copy
 * can be carried, but no code in the app publishes one yet (that is the
 * "wire camp board onto this" lane's job — see recordsOfKind/composeRecord).
 *
 * 'pod-member' IS published — by src/crews/podMembers.ts, which announces
 * "this card id is in this pod, and it goes by this name". A pod is joined
 * by a CODE, so without it a joiner's pod has no name, no roster and no
 * names on its mail; the announcement is how identity travels the same
 * rails the mail does. The token is permanent wire vocabulary.
 */
export type RecordKind = MessageKind | 'board-post' | 'camp-note' | 'pod-member';

/** The pod subset, as data — the one list inbox/unread/outbox filter on. */
export const POD_KINDS: readonly MessageKind[] = ['text', 'voice'];

export interface CrewMessage {
  /** Sender-minted: from_hash hex + '-' + created_min + '-' + 4 random
   * hex. Identical over every gossip path — the whole dedupe story. */
  id: string;
  /** Normalized crew code (beacon.ts normalizeCrewCode) — stored in the
   * clear because this DB is local and the inbox has to query by crew. */
  crew_code: string;
  /** hash32 of the sender's FriendCard.id — resolve against held cards. */
  from_hash: number;
  /** hash32 of the recipient's card id, or null = the whole crew. */
  to_hash: number | null;
  /** What this record IS — the discriminator every policy gate keys on. */
  kind: RecordKind;
  /** Text content, base64 audio for voice, or the kind's own serialized
   * payload (a board post / camp note rides as JSON its own lane parses).
   * Opaque to this store: the substrate sizes the envelope, never reads
   * inside it. */
  body: string;
  /** Audio codec hint for voice ('' for text). */
  mime: string;
  /** Epoch minutes, SENDER's clock — display truth, never validated
   * against the local clock (playa clocks drift; expiry is what gates). */
  created_min: number;
  expires_min: number;
  /** Copies-of-copies count; MAX_HOPS is the gossip horizon. */
  hops: number;
  /** 'mine' = composed on this phone; 'heard' = accepted off a peer.
   * Local bookkeeping — never rides the wire. */
  origin: 'mine' | 'heard';
  /** Local-only read stamp (epoch minutes); null = unread. Never synced —
   * your read state is nobody's business. */
  read_at: number | null;
}

/** What actually rides the sync link: a CrewMessage minus the two
 * local-only fields. acceptIncoming() validates raw wire input against
 * exactly this shape. */
export type WireMessage = Omit<CrewMessage, 'origin' | 'read_at'>;

/** Kind-neutral aliases. Identical types, better names for the non-pod
 * callers: a board post stored here is a CrewRecord, not a "message". The
 * CrewMessage/WireMessage names are preserved because PodMessages.tsx,
 * syncLink.ts and the existing suites import them. */
export type CrewRecord = CrewMessage;
export type WireRecord = WireMessage;

/** One line of a sync digest: enough for a peer to decide "do I want
 * this?" without moving any body bytes. */
export interface DigestEntry {
  id: string;
  expires_min: number;
}

// ---------------------------------------------------------------- policy

// The POD kinds' numbers. KIND_POLICY below reads them verbatim, so these
// stay the single place the answering machine's cost is stated — and stay
// exported, because the pod UI and the existing suites name them directly.

/** Pod TTL: one playa day. A note like "meet at the trash fence at 3" is
 * stale by tomorrow — the answering machine keeps messages, not archives.
 *
 * This bounds a record's life FROM ARRIVAL on each phone, not from its
 * original mint: a heard row is stored at now + the length the author asked
 * for, because a foreign absolute deadline is unreadable across two unsynced
 * playa phones. serveMessages then re-stamps the REMAINING life on the way
 * back out, so a relayed record decays across hops rather than restarting —
 * total circulation stays close to this horizon rather than multiplying by
 * the hop count. */
export const MESSAGE_TTL_MIN = 24 * 60;

/** Pod gossip horizon. Eight hops crosses a whole camp several times over;
 * past that a copy is almost certainly circling, not progressing. */
export const MAX_HOPS = 8;

/**
 * How far two playa phones' clocks may drift apart before we stop believing a
 * record at all.
 *
 * THE BUG THIS EXISTS FOR: acceptIncoming used to refuse on
 * `m.expires_min <= nowMin` — the SENDER's absolute timestamp measured against
 * the RECEIVER's clock. Playa phones have no cell and no NTP, so they drift
 * freely, and a receiver whose clock ran ~24 h ahead refused EVERY record
 * outright: a pod that syncs one way, silently, with nothing in the UI that
 * could explain it. That is a burn-week failure and it needs no attacker, no
 * bad radio and no bug anywhere else.
 *
 * Three days is deliberately generous. The cost of being too tight is a
 * silent one-way pod; the cost of being too loose is carrying a stale record
 * for one extra day, bounded by MAX_HOPS. Those are not close.
 */
export const CLOCK_SKEW_TOLERANCE_MIN = 3 * 24 * 60;


/** Pod body caps, enforced at compose AND accept (a peer's word is not
 * trusted). Text: 2 KiB is a long note, and small frames keep a GATT
 * exchange quick. Voice: 256 KiB of base64 (~192 KiB audio) fits several
 * PTT clips' worth of compressed speech (§6a: ~15-40 KB per ~5 s clip)
 * with room for longer rambles, while capping what one message costs
 * every relay that carries it. */
export const TEXT_MAX_BYTES = 2 * 1024;
export const VOICE_MAX_BYTES = 256 * 1024;

/** Hard cap on 'heard' POD rows, PER POD (see enforceHeardCap). A base
 * station relaying a whole camp must not grow unbounded — 2000 messages is
 * days of busy-camp traffic under the 24 h TTL, and oldest-expiring-first
 * eviction loses exactly the mail that was dying soonest anyway. 'mine'
 * rows are never evicted by the cap: your own outbox is yours until it
 * expires. */
export const HEARD_CAP = 2000;

// -- the reserved kinds' numbers ------------------------------------------
// Sized from the camp lane's OWN limits (src/camp/campBoard.ts,
// src/camp/campNotes.ts) so a record that lane can author always fits this
// envelope. Deliberately duplicated as literals rather than imported: the
// substrate must not depend on its passengers (crews/ knowing camp/ would
// invert the layering). If those limits move, these move with them.

/** A board post is POST_TEXT_MAX (2000 chars) plus id/author/type/ref/
 * created_at. 2000 chars of 4-byte codepoints is 8 KiB, so 16 KiB leaves
 * room for the fields and the JSON around them — and still costs a relay
 * a sixteenth of one voice note. */
export const BOARD_POST_MAX_BYTES = 16 * 1024;

/** A camp note carries NOTE_PHOTO_WIRE_MAX_B64 (64 KiB) of base64 JPEG on
 * top of its 2000-char text and its 120-char fields. 96 KiB fits the
 * photographed worst case with headroom and stays under the voice cap. */
export const CAMP_NOTE_MAX_BYTES = 96 * 1024;

/** Board posts live 72 h on the mesh — CAMP_FRESH_HOURS, the same window
 * the board itself calls "fresh". Past it a post is still on the authoring
 * phone (the board keeps 30 days locally); it just stops costing every
 * relay in camp, which is a different question from what a board shows. */
export const BOARD_POST_TTL_MIN = 72 * 60;

/** Camp notes live the week. A note is the durable kind — an art sighting,
 * a memory, a fix to a wrong fact — and it must still be spreading on
 * Sunday to reach the people who arrived Thursday. */
export const CAMP_NOTE_TTL_MIN = 7 * 24 * 60;

/** A longer life needs a longer horizon: a camp note gets many more
 * sightings than a day-old text, so 8 hops would burn out mid-camp before
 * a late arrival's phone ever met a carrier. 12 keeps the same "stops
 * circling" guarantee at 7 x the lifetime. */
export const NOTE_MAX_HOPS = 12;

/** Heard-row budgets for the reserved kinds. MAX_POSTS_PER_WRITER and
 * MAX_NOTES_PER_WRITER are both 500 in the camp lane: a board aggregates
 * many writers (2000 = a busy camp's boards), while notes are bigger and
 * rarer, so one writer's full set is the right ceiling for what a stranger
 * relays. */
export const BOARD_HEARD_CAP = 2000;
export const CAMP_NOTE_HEARD_CAP = 500;

// -- the member-announcement numbers --------------------------------------
// src/crews/podMembers.ts owns the body; these are what it costs the mesh.

/** An announcement is a NAMEPLATE, not a card: {v, cardId, name, podName}.
 * 512 bytes fits a 40-codepoint playa name and a 40-codepoint pod name
 * even if every character is a 4-byte emoji, with room for the JSON around
 * them — and it is small enough that a whole camp's worth of them costs a
 * relay less than one voice note. The codec clamps to those lengths, so
 * the cap is a backstop, never the thing a user meets. */
export const POD_MEMBER_MAX_BYTES = 512;

/** Seven days — an announcement must OUTLIVE the 24 h pod-mail cycle, or
 * the roster would empty out overnight while the pod is still together.
 * Members republish at half this (podMembers.ts), so a live pod's roster
 * never expires out from under it; a member who leaves fades in about a week,
 * which is the honest cost of a store-and-forward mesh with no delete.
 * "About": life is measured from arrival on each phone and the wire carries
 * the REMAINING life (serveMessages), so a late relay can stretch the tail
 * somewhat past seven days — it decays rather than restarting, but it is not
 * a hard seven. */
export const POD_MEMBER_TTL_MIN = 7 * 24 * 60;

/** Heard-row budget. 200 rows is several camps' worth of pods at a handful
 * of members each, plus the superseded copies a rename leaves behind —
 * and oldest-expiring-first eviction drops exactly those stale copies
 * before it touches a live member's newest announcement. */
export const POD_MEMBER_HEARD_CAP = 200;

/**
 * PER-KIND POLICY — the one table that says what a kind costs the mesh.
 *
 * ONE GLOBAL POLICY CANNOT WORK once more than pod mail rides these rails:
 * a single set of numbers would have to be the loosest of every kind's,
 * which is how a 5-second voice note ends up entitled to a week of every
 * relay's storage. So each gate — compose, accept, expiry clamp, hop
 * horizon, eviction — reads from here, keyed by kind.
 *
 * The pod rows below are EXACTLY the constants above, so generalizing this
 * layer changed no pod behavior at all.
 */
export interface KindPolicy {
  /** Max UTF-8 body bytes. Enforced at compose AND at accept — a peer's
   * word is not trusted, and composing something no peer would accept is
   * a message silently lost one hop later. */
  maxBytes: number;
  /** Life from mint, in minutes. Doubles as the accept-time expiry clamp,
   * so a lying peer cannot buy a record more life than its kind allows. */
  ttlMin: number;
  /** Copies-of-copies horizon for this kind. */
  maxHops: number;
  /** Which heard-row budget this kind spends. Kinds that share a group
   * share one budget; separate groups mean a long-lived kind can never
   * evict a short-lived one out of a full store (see enforceHeardCap). */
  capGroup: string;
  /**
   * Serve order in the digest — LOWER is offered first. Roster records go
   * ahead of mail because a pod whose ROSTER lags reads as broken, while a
   * pod whose mail lags reads as quiet; the first is a bug report, the
   * second is Tuesday.
   *
   * This has to be explicit and it has to be a PREFIX, because the obvious
   * simplification is a trap: today's `ORDER BY expires_min DESC` already
   * puts roster ahead of mail BY ACCIDENT, since pod-member's TTL is 7 days
   * against mail's 1. Switching to a bare recency sort would sink a
   * perfectly current 3-day-old announcement below every text from the last
   * hour and INTRODUCE the lagging-roster symptom the sort was changed to
   * prevent.
   */
  servePriority: number;
  /**
   * Eviction order WITHIN a cap group — HIGHER is deleted first. Only
   * meaningful between kinds that SHARE a capGroup; across groups the
   * budgets already isolate, which is what capGroup is for. Stated rather
   * than assumed, because a global rank would read as implemented and do
   * nothing.
   */
  evictRank: number;
  /** Does the answering machine show it? false = carried and relayed but
   * never in inbox/unread/outbox — recordsOfKind() is its only reader. */
  pod: boolean;
  /** Human copy for the two compose-side refusals. Per kind because
   * "record a shorter one" is nonsense for a board post. */
  emptyMessage: string;
  overCapMessage: string;
}

export const KIND_POLICY: Readonly<Record<RecordKind, KindPolicy>> = {
  text: {
    maxBytes: TEXT_MAX_BYTES,
    ttlMin: MESSAGE_TTL_MIN,
    maxHops: MAX_HOPS,
    capGroup: 'pod',
    servePriority: 1,
    // Text outlives voice: 2 KiB against 256 KiB, so evicting one voice
    // reclaims 128 texts' worth of room, and the words a camper typed are
    // the cheaper thing to keep.
    evictRank: 0,
    pod: true,
    emptyMessage: 'Nothing to send — write a message first.',
    overCapMessage: 'That message is too long to carry — trim it down.',
  },
  voice: {
    maxBytes: VOICE_MAX_BYTES,
    ttlMin: MESSAGE_TTL_MIN,
    maxHops: MAX_HOPS,
    capGroup: 'pod',
    servePriority: 1,
    // Evicted before text in the same pod (see text's note): one voice note
    // reclaims 128 texts' worth of room.
    evictRank: 1,
    pod: true,
    emptyMessage: 'Nothing recorded — hold to talk, then send.',
    overCapMessage: 'That voice note is too big to carry — record a shorter one.',
  },
  'board-post': {
    maxBytes: BOARD_POST_MAX_BYTES,
    ttlMin: BOARD_POST_TTL_MIN,
    // Same horizon as pod mail: a post has the same job — cross camp —
    // over a life measured in days, not the week a note gets.
    maxHops: MAX_HOPS,
    capGroup: 'board',
    servePriority: 1,
    // Alone in its cap group, so evictRank is never consulted — declared
    // rather than left undefined, which is the honest form.
    evictRank: 0,
    pod: false,
    emptyMessage: 'That board post is empty.',
    overCapMessage: 'That board post is too long to carry — trim it down.',
  },
  'camp-note': {
    maxBytes: CAMP_NOTE_MAX_BYTES,
    ttlMin: CAMP_NOTE_TTL_MIN,
    maxHops: NOTE_MAX_HOPS,
    capGroup: 'note',
    servePriority: 1,
    // Alone in its cap group; evictRank inert (see board-post).
    evictRank: 0,
    pod: false,
    emptyMessage: 'That camp note is empty.',
    overCapMessage: 'That camp note is too big to carry — shrink the photo or the text.',
  },
  'pod-member': {
    maxBytes: POD_MEMBER_MAX_BYTES,
    ttlMin: POD_MEMBER_TTL_MIN,
    // Same horizon as pod mail: an announcement has the same job as a
    // message — reach everyone in the pod — and a longer horizon would
    // only keep a departed member's nameplate circling.
    maxHops: MAX_HOPS,
    capGroup: 'member',
    // ROSTER FIRST in the digest. A pod whose roster lags reads as BROKEN; a
    // pod whose mail lags reads as quiet. Only the first is a bug report.
    servePriority: 0,
    // Also alone in its cap group, so it is already evicted LAST by budget
    // ISOLATION rather than by ordering — saying that here beats
    // re-implementing it as an ORDER BY that would do nothing across groups.
    evictRank: 0,
    // NOT the answering machine's business: an introduction is not mail
    // anyone left you, so it must never land in the inbox or the badge.
    pod: false,
    emptyMessage: 'That pod introduction is empty.',
    overCapMessage:
      'That pod introduction is too long to carry — a shorter name will fit.',
  },
};

/** Rows kept per cap group. Keyed by GROUP, not by kind, so two kinds in
 * one group can never disagree about the budget they share. */
/**
 * Past this age an OFFER cannot be live under any skew we would accept: the
 * longest TTL any kind carries, plus the whole clock tolerance. Derived from
 * the policy table rather than written as a number, so a kind with a longer
 * life cannot silently fall outside it.
 */
export const ANCIENT_OFFER_MIN =
  Math.max(...Object.values(KIND_POLICY).map(p => p.ttlMin)) +
  CLOCK_SKEW_TOLERANCE_MIN;

export const HEARD_CAPS: Readonly<Record<string, number>> = {
  pod: HEARD_CAP,
  board: BOARD_HEARD_CAP,
  note: CAMP_NOTE_HEARD_CAP,
  member: POD_MEMBER_HEARD_CAP,
};

/**
 * Is this a kind THIS BUILD can name a policy for? The accept gate's first
 * question about a peer's bytes. An unknown kind is not a future feature to
 * be helpfully carried — it is bytes with no cap, no TTL and no horizon, so
 * it is dropped unstored exactly like a foreign crew.
 */
export function isStorableKind(v: unknown): v is RecordKind {
  return (
    typeof v === 'string' &&
    Object.prototype.hasOwnProperty.call(KIND_POLICY, v)
  );
}

/** The policy for a kind the caller has already proven storable. */
export function policyFor(kind: RecordKind): KindPolicy {
  return KIND_POLICY[kind];
}

/**
 * BYTE budgets per (pod, cap group). The row cap is the wrong unit at camp
 * scale on its own: voice is 256 KiB against text's 2 KiB, so 2000 rows is
 * anywhere between 4 MiB and 512 MiB depending on what people said.
 *
 * SIZED TO ACTUALLY BIND, which is the whole point — a number chosen for
 * how safe it sounds is dead code. Against the row caps and the per-kind
 * maxima: pod tops out at 512 MiB, board at 32, note at 48, member at 0.1.
 * A flat 256 MiB would therefore be unreachable for four of the five groups
 * and would read as protection while providing none. These bind:
 *
 *   pod    48 MiB — ~190 voice notes in a pod-day (TTL is 24 h), which is
 *                   3 a day each in a 60-person pod. Binds well before the
 *                   2000-row cap for any voice-heavy pod, which is the case
 *                   the row cap cannot see.
 *   board  16 MiB — half its row ceiling.
 *   note   24 MiB — half its row ceiling.
 *   member  2 MiB — CANNOT BIND (200 rows x 512 B = 100 KB). Declared so the
 *                   roster has a stated budget rather than an implied one;
 *                   it is the row cap that governs there, and that is fine.
 *
 * WHAT THIS DOES NOT PROTECT, said plainly because the number invites the
 * wrong conclusion: every eviction query filters origin = 'heard'. A user's
 * OWN outbox is exempt by design (composeRecord never calls the cap), so a
 * phone that records three thousand of its own voice notes blows past every
 * budget here with zero eviction. This is a RELAY budget. It is not a disk
 * guarantee, and anyone who wants one has to decide separately what deleting
 * a person's own recordings should mean.
 */
/**
 * THE BYTE AXIS IS OFF FOR THE 0.8 TRAIN. Coordinator ruling, 2026-08-25.
 *
 * The budgets below are correct and the eviction that spends them is written
 * and tested — it simply does not run. The reason is cost, not doubt: the
 * cheap pre-filter only short-circuits while a (pod, cap group) holds fewer
 * than ~192 rows, against a row cap of 2000, and past that every call reads
 * `length(CAST(body AS BLOB))` for every row — which materialises every body,
 * because that cast is exactly what makes the measurement correct. And it is
 * not a rare call: pruneExpired sits at the top of BOTH serveDigest and
 * syncWithPeer, so it runs twice per peer sighting, plus on every accepted
 * batch. At camp scale that is a full-store read on the hot path, three days
 * before a burn, on the newest and least-proven axis in the slice.
 *
 * WHAT STILL RUNS, so nobody reads this as "eviction is off": the ROW cap
 * bounds every (pod, cap group), and kind-priority eviction still decides WHO
 * goes first within a group — voice before text. What is NOT enforced is a
 * byte ceiling, so a voice-saturated pod is bounded at 2000 rows rather than
 * at 48 MiB. That is the pre-existing behaviour, unchanged, and it is stated
 * here rather than left to be inferred from a constant that looks live.
 *
 * The durable cure is a `body_bytes` column written at both insert sites,
 * which turns all of this into an indexed integer sum. It needs a real ALTER
 * TABLE migration for installed phones, which is not a three-days-out change.
 * Flip this to true in the same commit that lands the column.
 */
export const HEARD_BYTE_BUDGET_ENABLED = false;

export const HEARD_BYTE_CAPS: Readonly<Record<string, number>> = {
  pod: 48 * 1024 * 1024,
  board: 16 * 1024 * 1024,
  note: 24 * 1024 * 1024,
  member: 2 * 1024 * 1024,
};

/** Cap groups, DERIVED from the table — adding a kind cannot forget to
 * give it an eviction budget, and a group's kinds are its row list.
 * maxBodyBytes is the group's worst-case row, which is what makes the byte
 * probe cheap: see enforceHeardCap. */
const HEARD_CAP_GROUPS: ReadonlyArray<{
  kinds: RecordKind[];
  cap: number;
  byteCap: number;
  maxBodyBytes: number;
}> = (() => {
  const byGroup = new Map<string, RecordKind[]>();
  for (const kind of Object.keys(KIND_POLICY) as RecordKind[]) {
    const group = KIND_POLICY[kind].capGroup;
    byGroup.set(group, [...(byGroup.get(group) ?? []), kind]);
  }
  return [...byGroup].map(([group, kinds]) => ({
    kinds,
    cap: HEARD_CAPS[group] ?? HEARD_CAP,
    byteCap: HEARD_BYTE_CAPS[group] ?? HEARD_BYTE_CAPS.pod,
    maxBodyBytes: Math.max(...kinds.map(k => KIND_POLICY[k].maxBytes)),
  }));
})();

/**
 * A SQL CASE over kind, built from KIND_POLICY rather than written as a
 * literal, so a new kind cannot forget to declare where it sorts. The kind
 * names are internal constants (the RecordKind union), never user input —
 * nothing here interpolates anything a peer can influence.
 */
function kindOrderCase(field: 'servePriority' | 'evictRank'): string {
  const arms = (Object.keys(KIND_POLICY) as RecordKind[])
    .map(k => `WHEN '${k}' THEN ${KIND_POLICY[k][field]}`)
    .join(' ');
  return `CASE kind ${arms} ELSE 99 END`;
}

/**
 * A RUNAWAY BACKSTOP on digest size — deliberately far above anything
 * legitimate use produces, and NOT a working limit.
 *
 * The first version of this was HEARD_CAP (2000) and it was wrong in a way
 * worth leaving written down: the heard cap is per (pod, cap group), so a
 * phone in several pods legitimately holds many multiples of it, plus its own
 * outbox which no cap touches at all. A 2000-entry digest silently stopped
 * offering mail the phone was holding — the tests that count a full digest
 * caught it immediately, and at camp scale it would have looked exactly like
 * the starvation this slice exists to cure.
 *
 * ALSO CORRECTING A CLAIM I MADE WHILE DESIGNING THIS: a limit is NOT
 * required for the serve ORDER to matter. wantsFrom preserves the peer's
 * offer order and syncWithPeer takes the first MAX_FETCH_IDS of it, so the
 * order decides which ids are fetched first whether or not the digest is
 * capped. The order is load-bearing on its own.
 *
 * What a huge digest DOES cost is the push: the whole thing goes to native on
 * every store change. That is real and it is NOT fixed here — the fix is to
 * debounce or diff the push, which is a transport change and does not belong
 * in an eviction-policy slice. This number only stops a corrupted or hostile
 * store from producing an unbounded frame.
 */
export const DIGEST_MAX_ENTRIES = 50_000;

/** Opaque-id ceiling for wire input — generous over the minted shape so a
 * future format tweak doesn't strand old phones, tight enough that junk
 * can't bloat the table. */
const ID_MAX = 64;
const MIME_MAX = 64;

/** ms -> the lane's time unit. The one place the conversion lives. */
export function epochMinutes(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

/**
 * UTF-8 byte count WITHOUT allocating (the caps above are byte caps —
 * radio budget — and a 256 KiB body should not cost a scratch array to
 * measure). Same code-point walk as friendLink's utf8Encode.
 */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

// ------------------------------------------------------------- revisions
// The favorites revision-emitter pattern (src/events/favorites.ts):
// writers bump, mounted readers (inbox screen, unread badge) subscribe.

let revision = 0;
const watchers = new Set<() => void>();

export function messagesRevision(): number {
  return revision;
}

export function subscribeMessagesChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifyMessagesChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

/**
 * THE LEVEL TRIGGER the mesh was missing (field report, 2026-08-25: "notes
 * and messages dont deliver very quick over bluetooth"). subscribeMessagesChanged
 * fires on EVERY store change — including accepting a peer's gossip — so the
 * sync layer cannot use it to mean "this phone has news to hand out" without
 * dial-storming on every accept. This hook fires ONLY when composeRecord
 * mints a record ON THIS PHONE: the one moment a human just acted and is
 * watching the pod for the delivery. meshSync uses it to try the radio NOW
 * instead of waiting out a cooldown built for idle gossip.
 */
const composeWatchers = new Set<() => void>();

export function subscribeLocalCompose(cb: () => void): () => void {
  composeWatchers.add(cb);
  return () => {
    composeWatchers.delete(cb);
  };
}

function notifyLocalCompose(): void {
  for (const w of composeWatchers) {
    w();
  }
}

/**
 * THE POCKET SEAM (pocketAlerts.ts): fired ONLY by acceptIncoming, with
 * the rows one accept batch actually stored — records that arrived FROM A
 * PEER, as this phone wrote them (origin 'heard', hops bumped, expiry
 * re-anchored to arrival).
 *
 * Deliberately a THIRD emitter rather than a reuse of the two above,
 * because each of those fires on this phone's OWN writes too:
 * subscribeMessagesChanged bumps on compose/markRead/prune, and
 * subscribeLocalCompose is by definition the local human acting. A
 * notification lane hanging off either would buzz a camper for their own
 * message — so the accept-only hook exists to make that wiring mistake
 * unrepresentable, not merely avoided.
 *
 * CARRY ≠ SHOW still applies downstream: an accepted batch legitimately
 * contains other people's mail and roster records; the LISTENER filters
 * with the inbox predicate. This hook reports arrivals, nothing more.
 */
const acceptedWatchers = new Set<(records: CrewRecord[]) => void>();

export function subscribeRecordsAccepted(
  cb: (records: CrewRecord[]) => void,
): () => void {
  acceptedWatchers.add(cb);
  return () => {
    acceptedWatchers.delete(cb);
  };
}

function notifyRecordsAccepted(records: CrewRecord[]): void {
  for (const w of acceptedWatchers) {
    w(records);
  }
}

// -------------------------------------------------------------- helpers

const placeholders = (n: number): string => Array(n).fill('?').join(', ');

const rowsOf = (res: { rows?: { _array?: unknown[] } }): Row[] =>
  (res.rows?._array ?? []) as Row[];

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const rowToMessage = (r: Row): CrewMessage => ({
  id: String(r.id),
  crew_code: String(r.crew_code),
  from_hash: Number(r.from_hash),
  to_hash: numOrNull(r.to_hash),
  // Rows only ever land through the compose/accept gates, so an unknown
  // kind here is impossible — coerced rather than thrown so a row written
  // by a NEWER build (a kind this one has no policy for) degrades to an
  // inert text row instead of crashing the inbox.
  kind: isStorableKind(r.kind) ? r.kind : 'text',
  body: String(r.body),
  mime: String(r.mime ?? ''),
  created_min: Number(r.created_min),
  expires_min: Number(r.expires_min),
  hops: Number(r.hops),
  origin: r.origin === 'mine' ? 'mine' : 'heard',
  read_at: numOrNull(r.read_at),
});

/** Distinct normalized codes, empties dropped — every entry point takes
 * human-typed codes and " Dusty-Llamas " must reach the same rows as
 * "dusty-llamas" (the beacon lane's exact rule). */
const normalizeCodes = (codes: string[]): string[] => [
  ...new Set(codes.map(normalizeCrewCode).filter(c => c.length > 0)),
];

const countWhere = (conn: Conn, where: string, params: unknown[]): number => {
  const res = conn.execute(
    `SELECT COUNT(*) AS n FROM crew_messages WHERE ${where}`,
    params,
  );
  return Number((rowsOf(res)[0] ?? { n: 0 }).n);
};

const messageExists = (conn: Conn, id: string): boolean =>
  rowsOf(
    conn.execute('SELECT 1 AS hit FROM crew_messages WHERE id = ?', [id]),
  ).length > 0;

const hex4 = (rand: () => number): string => {
  let s = '';
  while (s.length < 4) {
    s += Math.min(15, Math.floor(rand() * 16)).toString(16);
  }
  return s;
};

/** Mint the sender-owned id. The 4 random hex only disambiguate two
 * messages from the same sender in the same minute; a same-minute
 * collision (1 in 65536) re-mints rather than silently swallowing a
 * message under INSERT OR IGNORE. */
const mintId = (
  conn: Conn,
  fromHash: number,
  createdMin: number,
  rand: () => number,
): string => {
  for (let tries = 0; tries < 8; tries++) {
    const id = `${fromHash.toString(16)}-${createdMin}-${hex4(rand)}`;
    if (!messageExists(conn, id)) {
      return id;
    }
  }
  throw new Error('Could not mint a unique message id — try again.');
};

/** Evict 'heard' rows over each budget, oldest-expiring first (id as the
 * deterministic tie-break). Subquery form because DELETE..ORDER BY..LIMIT
 * needs a compile flag not every SQLite build has. Returns evicted count;
 * the CALLER notifies.
 *
 * THE BUDGET IS PER (POD, CAP GROUP) — both halves are load-bearing.
 *
 * Per GROUP, because oldest-expiring-first across ALL kinds would mean a
 * full store always evicts pod mail (24 h) before a camp note (7 days),
 * and the answering machine — the live surface — would starve behind
 * records nobody is reading yet.
 *
 * Per POD, because a shared budget is a shared fate: one chatty 60-person
 * camp pod would evict a quiet 3-person friend pod's mail, oldest-expiring
 * first, and the INTIMATE channel dies first precisely because it has less
 * traffic defending it (cross-family review, Aug 24 — a measured defect,
 * not a hypothetical: store starvation silently deletes a best friend's
 * message because camp was chatty). Each pod now gets its own guaranteed
 * budget, so a phone's ceiling is the cap times the number of pods it
 * belongs to — a number the user chose, one pod at a time, rather than a
 * number the noisiest pod chose for them. */
function enforceHeardCap(conn: Conn): number {
  let evicted = 0;
  for (const group of HEARD_CAP_GROUPS) {
    const marks = placeholders(group.kinds.length);
    // Counts only, and NO `HAVING` — a pod can sit under the ROW cap and
    // still be over the BYTE cap, which is the whole reason bytes exist as a
    // second axis. Filtering here would hide exactly those pods.
    const counts = conn.execute(
      `SELECT crew_code, COUNT(*) AS n FROM crew_messages
       WHERE origin = 'heard' AND kind IN (${marks})
       GROUP BY crew_code`,
      [...group.kinds],
    );
    for (const row of rowsOf(counts)) {
      const code = String(row.crew_code);
      const n = Number(row.n);
      const rowExcess = Math.max(0, n - group.cap);
      // THE CHEAP PRE-FILTER, and it is what keeps the byte axis affordable.
      // n x worst-case-body is an upper bound on this pod's bytes computable
      // from the COUNT alone; if even the worst case fits, no measurement of
      // the real bytes can change the answer. It matters because
      // length(CAST(body AS BLOB)) has to READ each body, and this runs on
      // every accepted batch.
      //
      // (The durable cure is a body_bytes column written at both insert
      // sites, which turns all of this into an indexed integer sum. It is not
      // here because BASE_TABLES_SQL uses CREATE TABLE IF NOT EXISTS, so an
      // installed phone would not gain the column without a real ALTER TABLE
      // migration and a backfill — a bigger change than this slice, and one
      // that should not ride in quietly beside an eviction-policy change.)
      if (
        rowExcess === 0 &&
        (!HEARD_BYTE_BUDGET_ENABLED || n * group.maxBodyBytes <= group.byteCap)
      ) {
        continue;
      }
      evicted += evictFromGroup(conn, group, marks, code, rowExcess);
    }
  }
  return evicted;
}

/**
 * Evict from one (pod, cap group) until BOTH budgets are satisfied.
 *
 * Order is kind priority first, then the oldest-expiring rule that was
 * already here: within a pod, voice goes before text (evictRank), and among
 * equals the mail that was dying soonest anyway goes first. Kind priority
 * and the byte budget pull the same direction by construction — one voice
 * note reclaims what 128 texts would — so the byte deficit closes in far
 * fewer deletions than a blind sweep.
 */
function evictFromGroup(
  conn: Conn,
  group: (typeof HEARD_CAP_GROUPS)[number],
  marks: string,
  code: string,
  rowExcess: number,
): number {
  // With the byte axis off, do NOT ask for the body lengths — that read is
  // the whole cost. Selecting 0 keeps one code path instead of two, and the
  // byte loop below then never triggers because the total is zero.
  const res = conn.execute(
    `SELECT id, ${HEARD_BYTE_BUDGET_ENABLED ? 'length(CAST(body AS BLOB))' : '0'} AS b
     FROM crew_messages
     WHERE origin = 'heard' AND kind IN (${marks}) AND crew_code = ?
     ORDER BY ${kindOrderCase('evictRank')} DESC, expires_min ASC, id ASC`,
    [...group.kinds, code],
  );
  // CAST to BLOB deliberately: length() on a TEXT value counts CHARACTERS,
  // so a 256 KiB base64 voice body and a 256 KiB emoji text body would score
  // identically wrong. octet_length() would be cleaner and is SQLite 3.43+
  // only — this tree ships two drivers plus node:sqlite in tests, so
  // portability is not free.
  const rows = rowsOf(res).map(r => ({ id: String(r.id), b: Number(r.b) || 0 }));
  let bytes = rows.reduce((sum, r) => sum + r.b, 0);
  const doomed: string[] = [];
  for (const r of rows) {
    // When the byte axis is off, `bytes` is 0 by construction (see the SELECT
    // above), so this reduces to the row cap alone — no second condition to
    // reason about, and no way for a disabled budget to evict anything.
    if (doomed.length >= rowExcess && (!HEARD_BYTE_BUDGET_ENABLED || bytes <= group.byteCap)) {
      break;
    }
    doomed.push(r.id);
    bytes -= r.b;
  }
  if (doomed.length === 0) {
    return 0;
  }
  for (let i = 0; i < doomed.length; i += 100) {
    const slice = doomed.slice(i, i + 100);
    conn.execute(
      `DELETE FROM crew_messages WHERE id IN (${placeholders(slice.length)})`,
      slice,
    );
  }
  return doomed.length;
}

// -------------------------------------------------------------- compose

/**
 * Mint a record of ANY storable kind on this phone — the one write path,
 * which composeText/composeVoice are thin wrappers over and which a future
 * board/notes lane calls directly with its own serialized body.
 *
 * Every per-kind number comes from KIND_POLICY: the byte cap, the human
 * copy on refusal, and the TTL that sets expires_min. Nothing here knows
 * what a board post IS — it sizes the envelope and stamps the clock.
 *
 * `nowMin` is epoch minutes (epochMinutes(Date.now()) at the call
 * boundary); `rand` is injectable for tests, Math.random in the app.
 */
export function composeRecord(
  kind: RecordKind,
  crewCode: string,
  myCardId: string,
  body: string,
  mime: string,
  toCardId: string | null,
  nowMin: number,
  rand: () => number = Math.random,
): CrewRecord {
  const policy = KIND_POLICY[kind];
  if (!policy) {
    // Only reachable from untyped callers; a kind with no policy has no
    // cap, no TTL and no horizon, so it must never reach the table.
    throw new Error('That is not something this phone knows how to send.');
  }
  if (body.length === 0) {
    throw new Error(policy.emptyMessage);
  }
  if (utf8ByteLength(body) > policy.maxBytes) {
    // The same cap acceptIncoming enforces — composing something no peer
    // would accept is a record silently lost one hop later.
    throw new Error(policy.overCapMessage);
  }
  const code = normalizeCrewCode(crewCode);
  if (code.length === 0) {
    throw new Error('This message needs a crew to go to.');
  }
  const conn = getDb();
  const fromHash = hash32(myCardId);
  const msg: CrewRecord = {
    id: mintId(conn, fromHash, nowMin, rand),
    crew_code: code,
    from_hash: fromHash,
    to_hash: toCardId === null ? null : hash32(toCardId),
    kind,
    body,
    mime: mime.slice(0, MIME_MAX),
    created_min: nowMin,
    expires_min: nowMin + policy.ttlMin,
    hops: 0,
    origin: 'mine',
    read_at: null,
  };
  conn.execute(
    `INSERT INTO crew_messages
       (id, crew_code, from_hash, to_hash, kind, body, mime,
        created_min, expires_min, hops, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'mine')`,
    [
      msg.id,
      msg.crew_code,
      msg.from_hash,
      msg.to_hash,
      msg.kind,
      msg.body,
      msg.mime,
      msg.created_min,
      msg.expires_min,
    ],
  );
  notifyMessagesChanged();
  notifyLocalCompose();
  return msg;
}

/**
 * Leave a text for the crew (toCardId null) or one crewmate. `nowMin` is
 * epoch minutes (epochMinutes(Date.now()) at the call boundary); `rand`
 * is injectable for tests, Math.random in the app.
 */
export function composeText(
  crewCode: string,
  myCardId: string,
  text: string,
  toCardId: string | null,
  nowMin: number,
  rand: () => number = Math.random,
): CrewMessage {
  // Whitespace-only is empty to a HUMAN even though it is bytes to the
  // generic gate — the one check the pod text kind adds of its own.
  if (text.trim().length === 0) {
    throw new Error(KIND_POLICY.text.emptyMessage);
  }
  return composeRecord('text', crewCode, myCardId, text, '', toCardId, nowMin, rand);
}

/** Leave a PTT voice note — base64 audio, mime names the codec. The
 * store treats the audio as opaque; recording/playback is another lane. */
export function composeVoice(
  crewCode: string,
  myCardId: string,
  base64Audio: string,
  mime: string,
  toCardId: string | null,
  nowMin: number,
  rand: () => number = Math.random,
): CrewMessage {
  return composeRecord(
    'voice',
    crewCode,
    myCardId,
    base64Audio,
    mime,
    toCardId,
    nowMin,
    rand,
  );
}

// ----------------------------------------------------------------- reads

/** "…and it is pod mail". The answering machine's surfaces are POD-ONLY:
 * a board post or camp note riding these rails is carried and relayed, but
 * it is not a message anyone left you, so it must never reach the inbox,
 * the unread badge or the outbox tape. Derived from POD_KINDS so a new
 * kind is invisible to the pod UI by default — the safe direction. */
const podKindSql = `kind IN (${placeholders(POD_KINDS.length)})`;

/** SQL fragment + params for "addressed to me in these crews": pod kinds,
 * to_hash null-or-mine, not from me. Shared by inbox and the badge count
 * so the two can never disagree about what "for me" means. */
const inboxWhere = (
  codes: string[],
  myHash: number,
): { where: string; params: unknown[] } => ({
  where: `crew_code IN (${placeholders(codes.length)})
     AND ${podKindSql}
     AND from_hash != ?
     AND (to_hash IS NULL OR to_hash = ?)`,
  params: [...codes, ...POD_KINDS, myHash, myHash],
});

/**
 * Messages for ME, newest first. read state rides each row (read_at).
 * Expired rows are pruneExpired()'s job, not a per-read filter — the
 * sync conductor and the UI cadence both prune, so anything still here
 * is at worst minutes past its TTL, and reads stay clock-free.
 */
export function inbox(crewCodes: string[], myCardId: string): CrewMessage[] {
  const codes = normalizeCodes(crewCodes);
  if (codes.length === 0) {
    return [];
  }
  const { where, params } = inboxWhere(codes, hash32(myCardId));
  const res = getDb().execute(
    `SELECT * FROM crew_messages WHERE ${where}
     ORDER BY created_min DESC, id DESC`,
    params,
  );
  return rowsOf(res).map(rowToMessage);
}

/** The badge number: unread rows of exactly the inbox's predicate. */
export function unreadCount(crewCodes: string[], myCardId: string): number {
  const codes = normalizeCodes(crewCodes);
  if (codes.length === 0) {
    return 0;
  }
  const { where, params } = inboxWhere(codes, hash32(myCardId));
  return countWhere(getDb(), `${where} AND read_at IS NULL`, params);
}

/** Mark one message read (local-only; never syncs). No-op — and no
 * phantom re-render — when it is unknown or already read. */
export function markRead(id: string, nowMin: number): void {
  const conn = getDb();
  const res = conn.execute(
    'SELECT 1 AS hit FROM crew_messages WHERE id = ? AND read_at IS NULL',
    [id],
  );
  if (rowsOf(res).length === 0) {
    return;
  }
  conn.execute('UPDATE crew_messages SET read_at = ? WHERE id = ?', [
    nowMin,
    id,
  ]);
  notifyMessagesChanged();
}

/** What I sent, newest first — the answering machine's outgoing tape.
 * Pod-only for the same reason inbox() is: a board post I authored belongs
 * on the board, not on my messages tape. */
export function myOutbox(crewCodes: string[], myCardId: string): CrewMessage[] {
  const codes = normalizeCodes(crewCodes);
  if (codes.length === 0) {
    return [];
  }
  const res = getDb().execute(
    `SELECT * FROM crew_messages
     WHERE crew_code IN (${placeholders(codes.length)})
       AND ${podKindSql}
       AND origin = 'mine' AND from_hash = ?
     ORDER BY created_min DESC, id DESC`,
    [...codes, ...POD_KINDS, hash32(myCardId)],
  );
  return rowsOf(res).map(rowToMessage);
}

/**
 * Every record of ONE kind this phone carries for these crews, newest
 * first — mine and heard together, addressed or not, because a board post
 * has no "for me" and a relay's copy is as good as the author's.
 *
 * This is the typed reader for the non-pod kinds: the future camp-board
 * lane calls recordsOfKind('board-post', codes) and parses the bodies it
 * put there. Deliberately NOT filtered by expiry — pruneExpired() owns
 * that, exactly like inbox().
 */
export function recordsOfKind(
  kind: RecordKind,
  crewCodes: string[],
): CrewRecord[] {
  const codes = normalizeCodes(crewCodes);
  if (codes.length === 0) {
    return [];
  }
  const res = getDb().execute(
    `SELECT * FROM crew_messages
     WHERE crew_code IN (${placeholders(codes.length)}) AND kind = ?
     ORDER BY created_min DESC, id DESC`,
    [...codes, kind],
  );
  return rowsOf(res).map(rowToMessage);
}

/** Rows by id, chunked under SQLite's bound-parameter limit. The serving
 * side of a sync reads through this. */
export function messagesByIds(ids: string[]): CrewMessage[] {
  const conn = getDb();
  const out: CrewMessage[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const res = conn.execute(
      `SELECT * FROM crew_messages WHERE id IN (${placeholders(slice.length)})`,
      slice,
    );
    for (const r of rowsOf(res)) {
      out.push(rowToMessage(r));
    }
  }
  return out;
}

// ------------------------------------------------------------- retention

/**
 * Delete everything past its expiry, then re-assert the heard cap.
 * Returns how many rows fell. The sync conductor runs this before
 * serving; the UI runs it on its own cadence (nothing here schedules
 * itself — the session.ts lifecycle rule).
 */
export function pruneExpired(nowMin: number): number {
  const conn = getDb();
  const expired = countWhere(conn, 'expires_min <= ?', [nowMin]);
  if (expired > 0) {
    conn.execute('DELETE FROM crew_messages WHERE expires_min <= ?', [nowMin]);
  }
  const dropped = expired + enforceHeardCap(conn);
  // The want ledger is swept on the same schedule as the mail it tracks —
  // one retention story, not two that can drift apart.
  pruneWants(nowMin);
  if (dropped > 0) {
    notifyMessagesChanged();
  }
  return dropped;
}

// ---------------------------------------------------------------- gossip

/**
 * What this phone CARRIES for these crews — mine + heard, EVERY KIND,
 * every row, as {id, expires_min} pairs. This IS the relay policy:
 * everything carried is offered, no per-role and no per-kind branching
 * (see the header — a base station is just a phone that never sleeps, and
 * a board post is just mail with a different kind). Freshest-expiring
 * first, so a peer that can only take part of the list takes the
 * liveliest mail.
 *
 * The digest deliberately stays two fields: an id is enough to dedupe,
 * an expiry is enough to skip corpses, and anything more (hops, kind)
 * would grow every exchange for edge cases the accept gate already
 * handles.
 *
 * ORDER: roster records first (KIND_POLICY.servePriority), then newest
 * first. A pod whose ROSTER lags reads as broken; a pod whose mail lags
 * reads as quiet, and only the first is a bug report.
 *
 * The kind prefix is LOAD-BEARING, not decoration. The tempting
 * simplification — drop it and sort by created_min DESC alone — is a
 * REGRESSION: the old `expires_min DESC` happened to put roster ahead of
 * mail because pod-member's TTL is 7 days against mail's 1, so a bare
 * recency sort would sink a perfectly current 3-day-old announcement below
 * every text from the last hour and introduce the exact symptom this order
 * exists to prevent.
 *
 * The former "known cost" — a hops-dead id re-offered and re-rejected every
 * sighting — is now cured on the ASKING side by the want ledger
 * (crew_sync_wants), which is where it belonged: the server cannot know why
 * a particular peer refused a particular id.
 */
export function syncDigest(crewCodes: string[]): DigestEntry[] {
  const codes = normalizeCodes(crewCodes);
  if (codes.length === 0) {
    return [];
  }
  const res = getDb().execute(
    `SELECT id, expires_min FROM crew_messages
     WHERE crew_code IN (${placeholders(codes.length)})
     ORDER BY ${kindOrderCase('servePriority')}, created_min DESC, id ASC
     LIMIT ?`,
    [...codes, DIGEST_MAX_ENTRIES],
  );
  return rowsOf(res).map(r => ({
    id: String(r.id),
    expires_min: Number(r.expires_min),
  }));
}

/**
 * Which of a peer's offered ids this phone lacks — the "want list" a
 * sync sends back. Digest entries are wire input (untrusted): malformed
 * or already-expired offers are skipped here so no fetch is wasted on a
 * message the accept gate would refuse anyway. Preserves the peer's
 * offer order (freshest first — see syncDigest).
 */
export function wantsFrom(digest: DigestEntry[], nowMin: number): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const e of digest) {
    if (!e || typeof e.id !== 'string') {
      continue;
    }
    if (e.id.length === 0 || e.id.length > ID_MAX) {
      continue;
    }
    if (!Number.isInteger(e.expires_min)) {
      continue;
    }
    // ANCIENT offers are still skipped — but the bound is clock-TOLERANT.
    //
    // `e.expires_min <= nowMin` was the same sender-stamp-versus-our-clock
    // test the accept gate stopped making, standing one call earlier on the
    // same path, and it silently undid the cure: syncWithPeer returns the
    // moment this list is empty, so past ~24 h of receiver-ahead skew the
    // phone asked for NOTHING and acceptIncoming was never reached at all.
    // The failure moved from "fetched then refused" to "never fetched",
    // which is strictly harder to see.
    //
    // An offer expiring "now" is genuinely AMBIGUOUS — it is either a record
    // that just died with clocks agreeing, or a perfectly live one seen by a
    // phone running a day fast. Nothing in a digest entry can separate those,
    // so the honest move is to fetch it and let the accept gate judge with
    // reasoning that needs no shared clock. One wasted fetch, and the want
    // ledger backs the id off if it never lands.
    // What IS still separable is the genuinely ancient: past the longest TTL
    // any kind has PLUS the full skew tolerance, no clock disagreement we
    // accept could make the record live.
    if (e.expires_min < nowMin - ANCIENT_OFFER_MIN) {
      continue;
    }
    if (seen.has(e.id)) {
      continue;
    }
    seen.add(e.id);
    candidates.push(e.id);
  }
  if (candidates.length === 0) {
    return [];
  }
  const conn = getDb();
  const held = new Set<string>();
  for (let i = 0; i < candidates.length; i += 100) {
    const slice = candidates.slice(i, i + 100);
    const res = conn.execute(
      `SELECT id FROM crew_messages WHERE id IN (${placeholders(slice.length)})`,
      slice,
    );
    for (const r of rowsOf(res)) {
      held.add(String(r.id));
    }
  }
  const backedOff = wantsBackedOff(conn, candidates, nowMin);
  return candidates.filter(id => !held.has(id) && !backedOff.has(id));
}

// ------------------------------------------------------------ want ledger
//
// See src/events/schema.ts (crew_sync_wants) for WHY this exists. The short
// version: wantsFrom skips ids we HOLD, but acceptIncoming refuses ids for
// four reasons wantsFrom cannot see — past the hop horizon, over the per-kind
// byte cap, an unknown kind, an unknown crew. Such an id is never held, never
// expires out of the peer's digest, and is re-requested every sighting
// FOREVER, occupying one of the MAX_FETCH_IDS slots. At camp scale enough of
// them at the head of a digest starve the tail permanently, through ordinary
// use, with no attacker involved.

/** First back-off step. Two minutes is ~2 sightings at the 60 s per-peer
 * cooldown — long enough to stop an id burning a slot every single sighting,
 * short enough that a transient miss (peer walked away mid-transfer) costs
 * almost nothing. */
export const WANT_BACKOFF_BASE_MIN = 2;

/** The ceiling on doubling. Six hours, not "never": an id we could not take
 * today may be legitimately reachable tomorrow from a DIFFERENT carrier with
 * a lower hop count, and banishing it outright would turn a starvation cure
 * into a starvation cause. Backed off, never banished. */
export const WANT_BACKOFF_MAX_MIN = 6 * 60;

/** Ledger rows older than this are swept. Nothing in crew_messages outlives
 * the week by construction, so a want older than that names a message that
 * cannot exist any more. */
export const WANT_LEDGER_TTL_MIN = 7 * 24 * 60;

function backoffFor(tries: number): number {
  const steps = Math.max(0, Math.min(tries, 20));
  const grown = WANT_BACKOFF_BASE_MIN * Math.pow(2, steps);
  return Math.min(grown, WANT_BACKOFF_MAX_MIN);
}

/** Which of these ids are currently backed off. Chunked like the held-id
 * probe above, for the same reason: a camp digest can carry thousands. */
function wantsBackedOff(
  conn: ReturnType<typeof getDb>,
  ids: string[],
  nowMin: number,
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const res = conn.execute(
      `SELECT id FROM crew_sync_wants
        WHERE retry_min > ? AND id IN (${placeholders(slice.length)})`,
      [nowMin, ...slice],
    );
    for (const r of rowsOf(res)) {
      out.add(String(r.id));
    }
  }
  return out;
}

/**
 * Stamp the ids we are about to ask for. Call BEFORE the fetch, not after:
 * a fetch that never returns (peer walked away mid-transfer) is exactly the
 * case that must still count as a try, or a peer who reliably drops us keeps
 * the same ids in the slot list forever.
 */
export function recordWants(ids: string[], nowMin: number): void {
  if (ids.length === 0) {
    return;
  }
  const conn = getDb();
  for (const id of ids) {
    const res = conn.execute('SELECT tries FROM crew_sync_wants WHERE id = ?', [id]);
    const prior = rowsOf(res)[0];
    const tries = prior ? Number(prior.tries) + 1 : 0;
    conn.execute(
      `INSERT INTO crew_sync_wants (id, asked_min, tries, retry_min)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET asked_min = ?, tries = ?, retry_min = ?`,
      [
        id,
        nowMin,
        tries,
        nowMin + backoffFor(tries),
        nowMin,
        tries,
        nowMin + backoffFor(tries),
      ],
    );
  }
}

/**
 * The transport failed; the ids did not. Undo the penalty recordWants just
 * charged them.
 *
 * The ledger exists to back off ids a peer ANSWERED about and still did not
 * hand over — accept-gate refusals, serve omissions — because re-fetching
 * those burns bytes forever. A fetch that THREW is a different animal: the
 * connection died and nothing was ever said about any id. On this mesh that
 * is routine, not exceptional — a BLE address rotates on every advertise
 * restart, so the second dial of a two-pass sync regularly dials a name
 * that no longer exists.
 *
 * Measured, 2026-08-24, and this is what it costs to skip this call: a
 * message sent while a patch was flaky had its id stamped on each failed
 * pass, the back-off doubled past the heal, and a text between two phones
 * SITTING NEXT TO EACH OTHER arrived twenty minutes late — with a six-hour
 * ceiling had the flake lasted longer. The ledger was blaming the ids for
 * the address's crime.
 *
 * THE STRIKE STANDS; only the SENTENCE is commuted. The forgiven row keeps
 * its bumped tries and is merely re-armed at the base step. The first
 * version of this decremented tries as well, and a second cross-family
 * pass caught what that really was: with every failure bumping and every
 * forgiveness un-bumping, tries oscillated between zero and one FOREVER,
 * so the ceiling below was unreachable on exactly the pathological peer it
 * was written for — dead code wearing a bound's name, and the first 64
 * offered ids could pin every encounter's transfer budget after all.
 *
 * With the strike kept, the schedule reads: a transport-failed id retries
 * at the base cadence a handful of times — which fully covers the measured
 * case, a fresh message caught in a flaky patch — and on the failure past
 * the ceiling it stops being forgiven and graduates to the ordinary
 * doubling. A peer whose serve reliably dies mid-read costs a few quick
 * retries and then backs off like any poison; the digest's tail gets its
 * slots. An id with real refusal history that suffers one transport blip
 * sits above the ceiling already, is not forgiven, and keeps its earned
 * back-off — the poison-erosion hole the RESTORE draft had is closed by
 * not touching those rows at all. Landing still wipes the slate: success
 * runs clearWants, and a later re-offer starts from zero.
 */
export const FORGIVE_TRIES_CEILING = 3;

export function forgiveWants(ids: string[], nowMin: number): void {
  if (ids.length === 0) {
    return;
  }
  const conn = getDb();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    conn.execute(
      `UPDATE crew_sync_wants
          SET retry_min = ? + ${WANT_BACKOFF_BASE_MIN}
        WHERE tries <= ${FORGIVE_TRIES_CEILING}
          AND id IN (${placeholders(slice.length)})`,
      [nowMin, ...slice],
    );
  }
}

/**
 * Forget the ids that actually landed. A message we now HOLD is skipped by
 * the held-id probe anyway, so leaving its row would only waste space — but
 * clearing it also means a later re-offer of the same id (after our copy
 * expires) starts from tries=0 rather than inheriting an old back-off.
 */
export function clearWants(ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  const conn = getDb();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    conn.execute(
      `DELETE FROM crew_sync_wants WHERE id IN (${placeholders(slice.length)})`,
      slice,
    );
  }
}

/**
 * Which of these ids this phone now HOLDS. The caller needs it to clear only
 * the wants that actually LANDED — clearing the whole request would reset the
 * back-off on every id that did not arrive, which is precisely the starvation
 * the ledger exists to stop, reintroduced by the cure.
 */
export function heldIdsAmong(ids: string[]): string[] {
  if (ids.length === 0) {
    return [];
  }
  const conn = getDb();
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const res = conn.execute(
      `SELECT id FROM crew_messages WHERE id IN (${placeholders(slice.length)})`,
      slice,
    );
    for (const r of rowsOf(res)) {
      out.push(String(r.id));
    }
  }
  return out;
}

/** Sweep ledger rows for messages that can no longer exist. */
export function pruneWants(nowMin: number): number {
  const conn = getDb();
  const cutoff = nowMin - WANT_LEDGER_TTL_MIN;
  const res = conn.execute(
    'SELECT COUNT(*) AS n FROM crew_sync_wants WHERE asked_min <= ?',
    [cutoff],
  );
  const n = Number(rowsOf(res)[0]?.n ?? 0);
  if (n > 0) {
    conn.execute('DELETE FROM crew_sync_wants WHERE asked_min <= ?', [cutoff]);
  }
  return n;
}

const U32_MAX = 0xffffffff;
const isU32 = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= U32_MAX;

/** Wire input is a peer's word for it — validate every field before it
 * touches the table. null = reject (silently: festival radio is noisy
 * and a bad frame must be cheap, the decodeBeacon posture). */
const asWireMessage = (raw: unknown): WireMessage | null => {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object') {
    return null;
  }
  const id = typeof r.id === 'string' ? r.id : '';
  const crew =
    typeof r.crew_code === 'string' ? normalizeCrewCode(r.crew_code) : '';
  if (id.length === 0 || id.length > ID_MAX || crew.length === 0) {
    return null;
  }
  // A kind with no policy in THIS build is refused here, before anything
  // is stored or relayed. Not a compatibility shim waiting to happen: a
  // record whose cap, TTL and horizon are unknown cannot be carried
  // safely, so a newer peer's new kind simply does not spread through old
  // phones — it spreads through the ones that were taught what it costs.
  if (!isStorableKind(r.kind)) {
    return null;
  }
  if (typeof r.body !== 'string' || !isU32(r.from_hash)) {
    return null;
  }
  if (r.to_hash !== null && r.to_hash !== undefined && !isU32(r.to_hash)) {
    return null;
  }
  if (!Number.isInteger(r.created_min) || (r.created_min as number) < 0) {
    return null;
  }
  if (!Number.isInteger(r.expires_min) || !Number.isInteger(r.hops)) {
    return null;
  }
  if ((r.hops as number) < 0) {
    return null;
  }
  return {
    id,
    crew_code: crew,
    from_hash: r.from_hash as number,
    to_hash: (r.to_hash ?? null) as number | null,
    kind: r.kind,
    body: r.body,
    mime: typeof r.mime === 'string' ? r.mime.slice(0, MIME_MAX) : '',
    created_min: r.created_min as number,
    expires_min: r.expires_min as number,
    hops: r.hops as number,
  };
};

/**
 * THE ACCEPT GATE — the heart of the gossip policy. Every message that
 * arrives over any radio lands here, and each one must clear:
 *
 *  - shape: every field typed and in range (asWireMessage);
 *  - KIND: one this build has a policy for — an unknown kind is dropped
 *    unstored and unrelayed (isStorableKind), because the three gates
 *    below have no numbers to read for it;
 *  - crew: a crew this phone belongs to — a stranger's crew is dropped
 *    unstored, exactly like a foreign beacon;
 *  - life: unexpired by MY clock, and the stored expiry is CLAMPED to
 *    now + the KIND's TTL so a lying peer cannot mint immortal mail that
 *    squats in every relay for the whole week;
 *  - horizon: hops < the kind's maxHops — at the horizon a copy stops
 *    spreading;
 *  - size: the compose-side byte cap for that kind, re-enforced (a peer's
 *    word is not trusted);
 *  - dedupe: an id already held is a no-op (INSERT OR IGNORE backstops
 *    the pre-check).
 *
 * Survivors land origin='heard', hops+1, unread. NOTE: not addressed-to-
 * me is NOT a rejection — carrying other people's mail is the relay
 * working (header: CARRY ≠ SHOW). Returns how many were newly written
 * (the cap may rotate the oldest-expiring back out in the same call —
 * the count reports ingest, not residency).
 */
export function acceptIncoming(
  msgs: unknown[],
  crewCodes: string[],
  nowMin: number,
): number {
  const known = new Set(normalizeCodes(crewCodes));
  if (known.size === 0) {
    return 0;
  }
  const conn = getDb();
  let accepted = 0;
  const stored: CrewRecord[] = [];
  for (const raw of msgs) {
    const m = asWireMessage(raw);
    if (!m || !known.has(m.crew_code)) {
      continue;
    }
    const policy = KIND_POLICY[m.kind];
    if (m.hops >= policy.maxHops) {
      continue;
    }
    // FRESHNESS WITHOUT A SHARED CLOCK. The old test — `m.expires_min <=
    // nowMin` — compared the SENDER's absolute stamp against OUR clock, which
    // is exactly the quantity two playa phones disagree about. Instead:
    //   - the record must be internally coherent (it may not claim to expire
    //     before it was written), which needs no clock of ours at all;
    //   - and its birth must be plausible against ours, with three days of
    //     slack for drift.
    // Everything inside that window is STORED, and its life is then measured
    // from arrival (below) rather than from a number we cannot interpret.
    if (m.expires_min <= m.created_min) {
      continue;
    }
    if (
      m.created_min > nowMin + CLOCK_SKEW_TOLERANCE_MIN ||
      m.created_min < nowMin - (policy.ttlMin + CLOCK_SKEW_TOLERANCE_MIN)
    ) {
      continue;
    }
    if (utf8ByteLength(m.body) > policy.maxBytes) {
      continue;
    }
    if (messageExists(conn, m.id)) {
      continue;
    }
    // LIFE IS MEASURED FROM ARRIVAL (the long comment below the INSERT):
    // hoisted to a name so the stored row handed to the accepted hook
    // carries the SAME expiry the table does — two computations of one
    // number is how they drift.
    const expiresLocal =
      Math.max(0, Math.min(m.expires_min - m.created_min, policy.ttlMin)) +
      nowMin;
    conn.execute(
      `INSERT OR IGNORE INTO crew_messages
         (id, crew_code, from_hash, to_hash, kind, body, mime,
          created_min, expires_min, hops, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'heard')`,
      [
        m.id,
        m.crew_code,
        m.from_hash,
        m.to_hash,
        m.kind,
        m.body,
        m.mime,
        m.created_min,
        // LIFE IS MEASURED FROM ARRIVAL, AT THE LENGTH THE SENDER MEANT.
        //
        // The old form, Math.min(m.expires_min, nowMin + ttl), clamped from
        // ABOVE only, so a heard row inherited the sender's ABSOLUTE number
        // whenever it was the smaller one. A receiver running S minutes ahead
        // therefore gave every RECEIVED message a life of (ttl - S) while its
        // OWN mail — stamped nowMin + ttl by composeRecord — kept the full
        // ttl. pruneExpired then deleted on the local clock, so only heard
        // mail vanished. One-way pod, no visible cause, nothing in the logs.
        //
        // What is trustworthy across two unsynced phones is not the sender's
        // absolute DEADLINE but the LENGTH they asked for, because a
        // difference of two of their own timestamps carries no clock offset
        // at all. So we take that length, cap it at our own policy so a lying
        // peer cannot buy extra life, and start it from arrival.
        //
        // THE TRADE, stated because it is a real cost and not a free win: a
        // relayed record's life restarts at each hop, so a 24 h message can
        // circulate longer than 24 h — bounded by MAX_HOPS, and bounded in
        // practice by needing a real encounter per hop. The alternative is
        // believing a clock we have no way to check, which is what silently
        // emptied a pod's inbox.
        expiresLocal,
        m.hops + 1,
      ],
    );
    accepted += 1;
    // The row AS STORED, for the accepted hook — origin/hops/expiry are
    // this phone's writes, not the wire's claims.
    stored.push({
      ...m,
      expires_min: expiresLocal,
      hops: m.hops + 1,
      origin: 'heard',
      read_at: null,
    });
  }
  if (accepted > 0) {
    enforceHeardCap(conn);
    notifyMessagesChanged();
    // AFTER the store settles (cap enforced, revision bumped): a listener
    // reading the DB inside its callback sees the world the batch left.
    notifyRecordsAccepted(stored);
  }
  return accepted;
}
