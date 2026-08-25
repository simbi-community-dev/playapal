/**
 * The camp board on the gossip mesh — board posts ride the pod (§6f's
 * payoff; docs/PUNCHLIST.md FORWARD CONSOLIDATION, owner Aug 24: "anything
 * that propagates across the camp do so as automatically as possible while
 * maintaining all the useful options we can for sharing with strangers").
 *
 * WHAT CHANGED. A board post used to move ONE way: export → Quick Share →
 * import, a deliberate act by two people standing together. The answering
 * machine's substrate (src/crews/messages.ts) already carries records phone
 * to phone whenever radios meet, and a board post is structurally the same
 * object as a pod message — id, author, body, expiry. So a post now ALSO
 * gossips: it is minted once as a `board-post` record and copied along
 * whoever walks past whoever, until it expires. The beam is untouched and
 * stays the only cross-platform, no-pod, works-with-strangers path.
 *
 * TWO TRUST CIRCLES, AND THEY ARE NOT THE SAME ONE. A POD CODE is a
 * transport circle: the phones that carry your bytes. A CAMP PASSPHRASE is
 * an authorship circle: the seal that says a board snapshot came from your
 * camp and reached you unmodified. This lane wires the first and changes
 * nothing about the second — the sealed-envelope check still applies on
 * every beam import (installCampBundle verifies key_id, payload_hash and
 * the HMAC tag before a single write), and a gossiped post never becomes a
 * sealed envelope: it lands as ROWS in the author's board pack, never in
 * `camp_writers`, so it is never re-exported under anyone's seal. Said
 * plainly, because the honest version matters more than the flattering
 * one: a post that arrives over a pod carries POD trust — anyone holding
 * the pod's PIN could have minted it — while a beamed board carries the
 * camp passphrase's. The residual (nothing binds a friend card to a board
 * writer id, so the mesh cannot prove authorship any more than the seal
 * can) is the same gap campBoard's TRUST LABEL already names, and it waits
 * on the same deferred control plane. A field nothing enforces would only
 * advertise a separation the architecture does not have (§6f fold 4).
 *
 * WHAT A POD-PIN HOLDER CAN AND CANNOT DO (pre-train review, Aug 24, and the
 * fold that answered it). STILL TRUE: nothing binds a friend card to a board
 * writer id, so anyone inside the pod can relay a post stamped with a
 * campmate's writer id, and this build cannot tell it from that campmate's
 * own — campId and writer ids are both learnable from the bodies that relay
 * past every pod member. NO LONGER TRUE: that such a post OWNS the board
 * position it claims. The winner of a revision fight is the highest writer
 * seq, and seq used to be unbounded — one relayed post stamped 2^30 outranked
 * the real author INDEFINITELY, including after a full beam re-sync, because
 * the reinstalled snapshot never reached that number and the mesh's self-heal
 * re-applied the forgery on the very next pass. campBoard's
 * GOSSIP_SEQ_LOOKAHEAD closes that specific hole: a gossiped copy is refused
 * unless it sits within 500 revisions of that writer's last SEALED seq (the
 * beam's high-water — a number the pod's PIN cannot write), anchored at 0 for
 * a writer this phone has never met. A forgery can no longer be placed out of
 * reach: the author's own next revisions climb past it, and any beam sealed
 * above it deletes it for good.
 *
 * WHAT REMAINS, in one sentence, because a bounded lie is still a lie: inside
 * that window a pod-PIN holder can still win a revision fight over a post and
 * hold it until the author advances past it or beams above it. The refusal of
 * everything beyond the window is counted (GossipApplyResult.refusedFuture),
 * logged, and said under the board — never a silent drop that reads like the
 * post was never sent.
 *
 * SCOPE: THE POD IS THE TRANSPORT, THE CAMP IS THE AUDIENCE. Posts gossip
 * within the pods whose codes this phone holds. A podmate in a DIFFERENT
 * camp still CARRIES them — that is the relay working, and carrying is not
 * showing (messages.ts: CARRY ≠ SHOW) — but the import gate below drops
 * anything whose camp id is not this phone's, so the post never reaches
 * their board. No passphrase on this phone means nothing published and
 * nothing imported: a pre-camp draft has no camp to be true in.
 *
 * WHAT THIS FILE OWNS: the body codec and the plumbing between the two
 * lanes. It does NOT decide who wins a revision fight — campBoard owns the
 * board's seq rules, and applyGossipedPosts() is where they run, so the
 * beam path and the mesh path can never disagree about which copy of a post
 * is current.
 */

import type { DbConnection as QuickSQLiteConnection } from '../events/engine';
import {
  applyGossipedPosts,
  getCampIdentity,
  isFresh,
  ownBoardSnapshot,
  POST_TEXT_MAX,
  type CampPostType,
  type GossipApplyResult,
  type GossipedPost,
} from '../camp/campBoard';
import { normalizeCrewCode } from './beacon';
import type { Crew } from './crew';
import { composeRecord, recordsOfKind } from './messages';

/** The wire token, reserved by the substrate and spent here. Permanent
 * vocabulary once shipped — the string in that column IS the on-air value
 * (the rule that keeps pod mail on 'text'/'voice'). */
export const BOARD_POST_KIND = 'board-post' as const;

/**
 * DECISION (a) — BODY SERIALIZATION + VERSIONING.
 *
 * The substrate sizes envelopes and never looks inside one, so the body is
 * this lane's to define: JSON with the version marker INSIDE it, exactly
 * like a pod-member nameplate. One record carries ONE post — not a
 * snapshot — because gossip's whole trick is that a small immutable record
 * dedupes by id over every path, while a snapshot would need merge rules
 * the mesh has no place to run.
 *
 * The fields are the post's own columns plus the three things a receiver
 * needs to file it: which camp it belongs to, which writer authored it, and
 * the author's revision (see decision (c)). Nothing else — a body is a
 * statement, not a database.
 *
 * FORWARD COMPATIBILITY, three ways out, same as §6f:
 *  - ANOTHER FIELD in a v1 body: decode ignores keys it does not know, so
 *    it costs nothing and strands nobody.
 *  - A v2 BODY: decode accepts any version >= 1 and reads the fields it
 *    knows, so a v2 post is a board row on a v1 phone, never a hole.
 *  - A SIBLING KIND: a policy row in KIND_POLICY plus a codec here. Bump
 *    BOARD_BODY_VERSION only when a field's MEANING changes — never for an
 *    addition, which is what makes the tolerance above worth having.
 */
export const BOARD_BODY_VERSION = 1;

/**
 * Freshest own posts published per pod. Bounded on purpose: the substrate
 * gives the whole 'board' cap group 2000 heard rows PER POD, and a
 * camp-scale pod is 60-80 phones — 30 apiece keeps a busy camp inside its
 * own budget instead of evicting the oldest board posts on every sighting.
 * A camper with more than 30 fresh posts still beams all of them; the beam
 * carries the whole board and always did.
 */
export const MESH_POSTS_PER_POD = 30;

/** Re-ask the store rather than the spin guard after this long (minutes).
 * The guard exists for the case where a write's read-back fails; it must
 * never become a cache that outlives a real change. */
export const BOARD_REPUBLISH_MIN = 60;

/** What one board-post record says. */
export interface BoardBody {
  /** The camp the post was authored under — the audience gate on import. */
  campId: string;
  /** The author's per-install board writer id (campBoard's identity), NOT
   * their friend-card id. See decision (b). */
  writerId: string;
  authorName: string;
  /** The author's own_seq this copy is true as of — the revision rule. */
  seq: number;
  /** The board post's own id: the join between the two paths. */
  postId: string;
  type: CampPostType;
  text: string;
  /** The item this replies to, '' when it is an item itself. */
  refId: string;
  createdAt: string;
  done: boolean;
}

// ------------------------------------------------------------------- codec

/** Control characters out: the Angel's board chunks are line-joined, so a
 * text carrying a newline could otherwise forge a "  reply:" line inside
 * someone else's thread. Authoring already strips them (campBoard.clean);
 * a peer's word is not trusted. */
const stripControls = (raw: string): string =>
  // eslint-disable-next-line no-control-regex -- stripping controls IS the point
  raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The body this build mints. */
export function encodeBoardBody(b: BoardBody): string {
  return JSON.stringify({
    v: BOARD_BODY_VERSION,
    campId: b.campId,
    writerId: b.writerId,
    authorName: b.authorName,
    seq: b.seq,
    postId: b.postId,
    type: b.type === 'need' ? 'need' : 'offer',
    text: b.text,
    refId: b.refId,
    createdAt: b.createdAt,
    done: b.done,
  });
}

/**
 * A peer's body is a peer's word for it — every field checked, null on
 * anything malformed (the decodeBeacon posture: a bad frame is cheap to
 * drop, never a crash). A version this build does not know is NOT a
 * rejection: the fields we understand still make a board row.
 */
export function decodeBoardBody(body: string): BoardBody | null {
  const raw = (() => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  })();
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.v) || (r.v as number) < 1) {
    return null;
  }
  if (
    typeof r.campId !== 'string' ||
    typeof r.writerId !== 'string' ||
    typeof r.postId !== 'string' ||
    typeof r.text !== 'string' ||
    typeof r.createdAt !== 'string'
  ) {
    return null;
  }
  if (!Number.isInteger(r.seq) || (r.seq as number) < 0) {
    return null;
  }
  const text = stripControls(r.text);
  const postId = r.postId.trim();
  const campId = r.campId.trim();
  const writerId = r.writerId.trim();
  if (
    campId.length === 0 ||
    writerId.length === 0 ||
    postId.length === 0 ||
    postId.length > 64 ||
    text.length === 0 ||
    // Over the authoring cap is refused, never truncated: half a statement
    // is a different statement, and the author's own phone refused it too.
    text.length > POST_TEXT_MAX ||
    r.createdAt.length === 0 ||
    r.createdAt.length > 32
  ) {
    return null;
  }
  return {
    campId,
    writerId,
    authorName: stripControls(
      typeof r.authorName === 'string' ? r.authorName : '',
    ).slice(0, 24),
    seq: r.seq as number,
    postId,
    type: r.type === 'need' ? 'need' : 'offer',
    text,
    refId: typeof r.refId === 'string' ? r.refId.trim().slice(0, 64) : '',
    createdAt: r.createdAt,
    // Anything but an explicit true is open: a post nobody said was done is
    // the safer default on a board about needs.
    done: r.done === true,
  };
}

// --------------------------------------------------------------- publishing

export interface BoardPublishResult {
  /** Records minted this pass, across every pod. */
  published: number;
  /** Refusals in the substrate's OWN words, one per post that would not
   * fit. Surfaced by the caller, never swallowed: a post silently absent
   * from the mesh is exactly the failure this lane exists to end. */
  refusals: string[];
}

/** What one post SAYS, for "has this changed since I last published it?".
 * Content only — the seq is what the receiver orders by, not what tells
 * this phone whether it has anything new to announce. */
const contentSignature = (b: BoardBody): string =>
  [b.type, b.text, b.refId, b.createdAt, b.done ? '1' : '0'].join('\u001f');

/**
 * THE SPIN GUARD (podMembers.ts's, same reason). This runs from a UI effect
 * that re-fires on the store change it causes, so a write whose read-back
 * fails would otherwise mint a record per render forever. Keyed by content,
 * so a real edit still goes out immediately.
 */
const lastPublished = new Map<string, { signature: string; atMin: number }>();

/** Drop the spin guard's memory (tests; a store swap). */
export function resetBoardMeshGuard(): void {
  lastPublished.clear();
}

/**
 * DECISION (c) — REVISIONS.
 *
 * Gossip records are immutable: a record is minted once and copied
 * verbatim, so an EDIT cannot rewrite the copies already in the air. An
 * edited post is therefore a NEW record, and campBoard's existing rule
 * picks the winner — the author's monotonic `own_seq`, which bumps on every
 * own-payload change and is the same number the beam's high-water uses.
 *
 * So every record is stamped with the writer's CURRENT seq: read it as
 * "as of my revision N, this post says X", not "revision N created this".
 * Both readings are true of the snapshot at N, and the first is the one
 * that makes a gossiped copy comparable with a beamed one (applyGossipedPosts).
 *
 * What gets published: my own posts in the CURRENT camp that are still
 * fresh by the board's own 72 h window — the same window the substrate
 * gives a board-post record, so a post leaves the mesh at the moment it
 * leaves the board's default view. Replies ride too; a thread with no
 * answers is half a conversation.
 */
export function publishBoardPosts(
  conn: QuickSQLiteConnection,
  crews: Crew[],
  myCardId: string,
  nowMin: number,
  rand: () => number = Math.random,
): BoardPublishResult {
  const out: BoardPublishResult = { published: 0, refusals: [] };
  const identity = getCampIdentity(conn);
  // No camp, nothing to say: a pre-camp draft belongs to no camp, and the
  // camp id is exactly what a receiver files the post under.
  if (identity.campId.length === 0 || myCardId.length === 0) {
    return out;
  }
  const codes = [
    ...new Set(crews.map(c => normalizeCrewCode(c.code)).filter(c => c.length > 0)),
  ];
  if (codes.length === 0) {
    return out;
  }
  const now = new Date(nowMin * 60_000);
  const { seq, posts } = ownBoardSnapshot(conn);
  const fresh = posts
    .filter(p => isFresh(p.created_at, now))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, MESH_POSTS_PER_POD);
  if (fresh.length === 0) {
    return out;
  }
  for (const code of codes) {
    // What I have already told THIS pod, newest per post. Per pod because
    // a post published to one pod is not on another pod's rails at all.
    //
    // "Mine" is the BOARD WRITER id in the body, deliberately NOT the
    // record's from_hash. (getMyCard now persists its first-minted id, so
    // the original reason — a fresh random card id per call — is gone;
    // the choice STANDS on its remaining leg: the writer id survives a
    // deliberate card swap, and it is the identity the post actually
    // belongs to on the board's own pack.)
    const said = new Map<string, BoardBody>();
    for (const rec of recordsOfKind(BOARD_POST_KIND, [code])) {
      const body = decodeBoardBody(rec.body);
      if (!body || body.writerId !== identity.writerId) {
        continue;
      }
      const prev = said.get(body.postId);
      if (!prev || body.seq > prev.seq) {
        said.set(body.postId, body);
      }
    }
    for (const post of fresh) {
      const body: BoardBody = {
        campId: identity.campId,
        writerId: identity.writerId,
        authorName: identity.authorName,
        seq,
        postId: post.id,
        type: post.type,
        text: post.text,
        refId: post.ref_id ?? '',
        createdAt: post.created_at,
        done: post.done,
      };
      const signature = contentSignature(body);
      const already = said.get(post.id);
      if (already && contentSignature(already) === signature) {
        continue; // nothing changed — the copies in the air still speak for me
      }
      const key = `${code}|${post.id}`;
      const guard = lastPublished.get(key);
      if (
        guard &&
        guard.signature === signature &&
        nowMin - guard.atMin < BOARD_REPUBLISH_MIN
      ) {
        continue;
      }
      try {
        composeRecord(
          BOARD_POST_KIND,
          code,
          myCardId,
          encodeBoardBody(body),
          '',
          null, // the whole pod: a board post has no addressee
          nowMin,
          rand,
        );
        out.published += 1;
        lastPublished.set(key, { signature, atMin: nowMin });
      } catch (e: any) {
        // The kind's own copy, in the substrate's words ("That board post is
        // too long to carry — trim it down"). Unreachable through legal
        // authoring today (POST_TEXT_MAX is 2000 characters against a 16 KiB
        // envelope) — kept because the caps are independent and the honest
        // refusal is what campBoard's export contract promises everywhere
        // else. Deliberately NOT stamped in the guard: the refusal has to
        // keep coming back, or the sentence on screen would vanish while the
        // post it names is still missing from every campmate's board. The
        // retry is free — the cap is checked before anything is written.
        out.refusals.push(String(e?.message ?? e));
      }
    }
  }
  return out;
}

// --------------------------------------------------------------- importing

/**
 * DECISION (b) — IDENTITY RECONCILIATION.
 *
 * THE PROBLEM. A gossip record is identified by an id minted from the
 * sender's FRIEND CARD (`from_hash` = hash32(card id)); the camp board is
 * keyed by (pack, post id), where the pack encodes (camp, board writer id).
 * Those two identities never meet: one phone's card id and its board writer
 * id are unrelated strings, a card can be swapped without touching the
 * board, and a writer-incarnation rotation mints a new writer id under the
 * same card. So the record's own identity CANNOT be the join.
 *
 * THE JOIN IS THE BOARD POST'S OWN ID, carried inside the body beside the
 * writer id that scopes it. The two paths then land on ONE row:
 *
 *  - BEAM path: installCampBundle writes (id, boardPackId(camp, writer)).
 *  - MESH path: this import writes (id, boardPackId(camp, writer)) — the
 *    same pack, the same id, so it is literally the same row.
 *
 * camp_posts is PRIMARY KEY (pack_id, id), so the second arrival REPLACES
 * the first instead of doubling it, and listCampBoard — which reads rows,
 * not envelopes — renders it once no matter which path won the race or
 * whether both ran. Nothing needs to remember which door a post came
 * through, which is the property that makes this safe to leave running.
 *
 * WHAT IS DELIBERATELY NOT JOINED: `from_hash`. A relay's copy is as good
 * as the author's, so the record's sender says nothing about the post's
 * author, and checking it would break exactly the multi-hop case this lane
 * is for. (podMembers CAN check hash32(cardId) === from_hash because a
 * nameplate is a claim ABOUT a card; a board post is a claim about a
 * writer, and this build has nothing that binds the two.)
 */
export function importBoardPosts(
  conn: QuickSQLiteConnection,
  crewCodes: string[],
): GossipApplyResult {
  const incoming: GossipedPost[] = [];
  for (const rec of recordsOfKind(BOARD_POST_KIND, crewCodes)) {
    const body = decodeBoardBody(rec.body);
    if (!body) {
      continue; // malformed or from a build whose v1 is not ours
    }
    incoming.push({
      campId: body.campId,
      writerId: body.writerId,
      authorName: body.authorName,
      seq: body.seq,
      post: {
        id: body.postId,
        writer_id: body.writerId,
        author_name: body.authorName,
        type: body.type,
        text: body.text,
        ref_id: body.refId.length > 0 ? body.refId : null,
        created_at: body.createdAt,
        done: body.done,
      },
      recordId: rec.id,
      recordMin: rec.created_min,
    });
  }
  return applyGossipedPosts(conn, incoming);
}

// ------------------------------------------------------------------ the pass

export interface BoardMeshResult extends BoardPublishResult {
  /** Rows the mesh added or changed on the board this pass. */
  imported: number;
  /** Author names whose posts arrived over the mesh this pass. */
  writers: string[];
}

/**
 * What the board says when the seq cap held a post back. It rides `refusals`
 * — the same line under the board the publish refusals use — because the
 * whole point of the cap is that the held-back post is VISIBLE as held back:
 * a drop the reader cannot tell from "nobody posted" is the failure this lane
 * exists to end. It re-states on every pass while the record is still in the
 * pod (72 h), which is correct: the post is still missing.
 */
const heldBackNote = (n: number): string =>
  n === 1
    ? 'One post claimed to be a much later revision of a campmate’s board than anything they have beamed to this phone — it is not shown. Beam their board from their phone to catch up.'
    : `${n} posts claimed to be much later revisions of campmates’ boards than anything beamed to this phone — they are not shown. Beam those boards from their phones to catch up.`;

/**
 * One housekeeping pass: say what is new on my board, then take what
 * arrived. Idempotent — the common case reads the pod's records, decodes
 * them and writes NOTHING, which is what lets a UI effect call it on every
 * store change without the board churning under the camper's thumb. The
 * read is the honest cost: it is proportional to what the pod carries, and
 * it is paid on every change signal rather than on a timer.
 *
 * The two halves are independent on purpose: a phone with no camp
 * passphrase still relays other people's posts (that is the substrate's
 * job and needs no help from here), and a phone whose pods are empty still
 * beams. Nothing here starts, stops or asks for a radio — a record moves
 * exactly when the pod's sync already moves.
 */
export function syncBoardOverMesh(
  conn: QuickSQLiteConnection,
  crews: Crew[],
  myCardId: string,
  nowMin: number,
  rand: () => number = Math.random,
): BoardMeshResult {
  const published = publishBoardPosts(conn, crews, myCardId, nowMin, rand);
  const codes = crews.map(c => c.code);
  const applied = importBoardPosts(conn, codes);
  return {
    published: published.published,
    refusals:
      applied.refusedFuture > 0
        ? [...published.refusals, heldBackNote(applied.refusedFuture)]
        : published.refusals,
    imported: applied.applied,
    writers: applied.writers,
  };
}
