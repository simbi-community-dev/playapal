/**
 * Crews — Phase A of docs/CREW-DESIGN.md (§4): a named, saved subset of the
 * friend cards you already hold. "Which way, how far, for the four people I
 * actually care about tonight" — the model is only the chosen set; rows
 * render from the cards themselves (src/friends/friendCard.ts).
 *
 * Plural from day one (design §6.3): cheap to model now, and the UI shows
 * one crew until more are needed — no migration later.
 *
 * Storage: ONE JSON settings row (the waypoints.ts pattern). Crew counts
 * are tiny; deliberately not a schema migration. Unlike pins, crews key on
 * id, NEVER name — two crews may share a name, and a rename must not
 * silently replace a different crew.
 *
 * The code is a human-shareable join PIN for Phase B ("Campmates join
 * with this code — same code, same pod"): minted once at creation,
 * carried verbatim ever after so it stays stable across edits.
 *
 * A POD JOINED BY CODE HAS NO NAME. The code travels; the name does not
 * (the beacon carries only hashes). So a joined pod starts under a
 * PLACEHOLDER name derived from its code, marked as such, and adopts the
 * real name when a namer's member announcement arrives
 * (src/crews/podMembers.ts). Everything downstream reads the two apart
 * through isPlaceholderPodName: a name the user typed is never overwritten
 * by the mesh, and a placeholder never gets spoken in a sentence
 * ("Share my position with 4207" is a machine talking).
 *
 * NOT this module's business: FriendScope's 'crew' value in friendCard.ts
 * is an unrelated WIRE word meaning "pass this card on". It predates this
 * feature and never changes here (design §6.1 flags the collision).
 */

import { getSetting, setSetting } from '../events/db';
import { normalizeCrewCode } from './beacon';

export interface Crew {
  id: string;
  name: string;
  /** Human-shareable join PIN, e.g. "4207" (older pods carry the retired
   * "dusty-flamingo-42" phrase — both still join; see newCrewCode). */
  code: string;
  /** FriendCard ids (src/friends/friendCard.ts). */
  memberIds: string[];
  /** WHERE the name came from — 'code' (a placeholder derived from the
   * join PIN), 'mesh' (adopted from a podmate's announcement) or 'mine'
   * (typed on this phone). Two booleans' worth of question — "is it a real
   * name?" and "may the mesh replace it?" — that have different answers
   * for an adopted name, which is why this is a source and not a flag.
   * Absent on rows written before announcements shipped; podNameSource
   * reads those honestly instead of migrating them. */
  nameSource?: PodNameSource;
}

/** Where a pod's name came from (see Crew.nameSource). */
export type PodNameSource = 'code' | 'mesh' | 'mine';

const KEY = 'crews';
/** Pod display names are clamped here. EXPORTED because the invite codec
 * needs the same clamp to guarantee a name can never be the reason an
 * invite overflows one QR — and a second copy of the number is how that
 * guarantee quietly stops being true. */
export const NAME_MAX = 40;

// ---------------------------------------------------------------------------
// Change subscription (the favorites.ts revision-emitter pattern).
// ---------------------------------------------------------------------------

let revision = 0;
const watchers = new Set<() => void>();

export function crewsRevision(): number {
  return revision;
}

export function subscribeCrewsChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifyCrewsChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function listCrews(): Crew[] {
  const raw = getSetting(KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (c: any): c is Crew =>
        c &&
        typeof c.id === 'string' &&
        typeof c.name === 'string' &&
        typeof c.code === 'string' &&
        Array.isArray(c.memberIds) &&
        c.memberIds.every((m: unknown) => typeof m === 'string'),
      // nameSource is deliberately NOT required: a row written by an older
      // build has none, and absent means "no claim either way" —
      // podNameSource falls back to reading the name itself.
    );
  } catch {
    return []; // corrupt row: start clean rather than crash the section
  }
}

/**
 * Save a crew: replace by id when it exists, otherwise add it first. Names
 * are display labels only — same-name crews coexist (see header).
 */
export function saveCrew(crew: Crew): Crew {
  const clean: Crew = {
    id: crew.id,
    name: crew.name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) || 'My pod',
    code: crew.code,
    memberIds: [...new Set(crew.memberIds)],
    nameSource: crew.nameSource ?? podNameSource(crew),
  };
  const all = listCrews();
  const at = all.findIndex(c => c.id === clean.id);
  if (at >= 0) {
    all[at] = clean;
  } else {
    all.unshift(clean);
  }
  setSetting(KEY, JSON.stringify(all));
  notifyCrewsChanged();
  return clean;
}

// ---------------------------------------------------------------------------
// Two rows, one code
// ---------------------------------------------------------------------------

/**
 * CAN ONE PHONE EVEN HOLD TWO DIFFERENT PODS UNDER ONE CODE? Every local
 * path that writes a row, traced, because the answer decides where the fix
 * belongs:
 *
 * - joinCrew(code) is IDEMPOTENT ON THE CODE: a code this phone already
 *   holds returns THAT row. Joining — from the code sheet or from a
 *   scanned invite, which hands podLink's code to the same function — can
 *   therefore never mint the second row for a code already here.
 * - saveCrew() only ever writes back a code its caller already had: the
 *   picker spreads `...crew`, a rename spreads `...crew`, adoptPodName
 *   spreads `...crew`. Nothing in the app types a code onto an existing
 *   pod.
 * - newCrew() MINTS one, at random, and used to do it without looking at
 *   what this phone holds. THAT is the whole reachable path: create a pod
 *   whose fresh PIN happens to equal a pod you already joined. With 10,000
 *   PINs the odds are (pods held)/10,000 per creation — small per tap, and
 *   a burn-week phone carrying half a dozen pods is exactly the place it
 *   lands.
 *
 * So the fix belongs AT THE MINT (newCrewCode rerolls past held codes),
 * which makes the deliberate-collision state unreachable going forward,
 * and the merge below keeps a guard for the rows that already exist.
 *
 * WHAT THE WIRE STILL CANNOT DO — say plainly, because a reader will
 * assume more than this fixes: crewHash is hash32 of the normalized code
 * (beacon.ts), so ON THE AIR THE CODE IS THE POD. Two pods sharing a code
 * cross-hear each other's beacons and mail no matter what the local rows
 * look like. The reroll prevents the LOCAL fusion — this phone's own two
 * rows — and nothing more. Two strangers independently minting the same
 * PIN on two phones stays a wire-level reality, carried with the rest of
 * the 13-bit-code posture in docs/CREW-DESIGN.md §6e. It is not fixable
 * here and this file does not pretend to fix it.
 */

/**
 * WHICH ROWS MAY BE FUSED. The predicate is an ORIGIN argument, not a
 * resemblance test, because nameSource records where a row came from:
 *
 * - 'code' or 'mesh' means NOBODY ON THIS PHONE NAMED IT — a placeholder
 *   built from the join code, or a name adopted off the mesh. Only
 *   joinCrew writes such a row: newCrew always stamps 'mine', and nothing
 *   downgrades a 'mine' name afterwards (adoptPodName refuses it,
 *   savePicker keeps it). So a row like this came from a JOIN — and since
 *   joining is idempotent on the code, TWO join rows under one code can
 *   only be the pre-idempotent bug. Fusing them is provably right.
 * - 'mine' is ambiguous: a pod created here (newCrew stamps it) or a
 *   joined pod the user typed a name into. Creating is the one act that
 *   can put a DIFFERENT pod's code on this phone, so two 'mine' rows may
 *   be two real pods and are never fused — the merge would union
 *   strangers' picks and throw one of the two names away.
 * - Mixed (one 'mine' row, the rest join rows) is the genuinely ambiguous
 *   case: the bug's twin next to a pod you made, or a pod you made whose
 *   mint landed on a pod you had joined. SHAPE decides it. A join row with
 *   no picks holds nothing a human here put in — its name came off the
 *   wire, its member list is empty — so dropping it costs nothing whichever
 *   it was. A join row carrying picks is somebody's work: leave the whole
 *   group alone and let crewCodeCollisions surface it.
 */

/** Named on THIS phone — typed by the user, never derived or adopted. */
function namedHere(c: Crew): boolean {
  return podNameSource(c) === 'mine';
}

/** Anything a human here put into the row: a name they typed, or people
 * they picked. Neither means the row is wire residue. */
function holdsOwnWork(c: Crew): boolean {
  return namedHere(c) || c.memberIds.length > 0;
}

/** May these same-code rows be fused? See the origin argument above. */
function isTwinSet(group: Crew[]): boolean {
  const named = group.filter(namedHere);
  if (named.length > 1) {
    return false; // two pods a human named here — possibly two real pods
  }
  if (named.length === 0) {
    return true; // every row came from a join: the bug is the only source
  }
  return group.every(c => namedHere(c) || c.memberIds.length === 0);
}

/** Rows grouped by normalized code, groups of two or more only, in
 * first-appearance order. */
function crewsSharingCode(all: Crew[]): Crew[][] {
  const byCode = new Map<string, Crew[]>();
  for (const c of all) {
    const k = normalizeCrewCode(c.code);
    const group = byCode.get(k);
    if (group) {
      group.push(c);
    } else {
      byCode.set(k, [c]);
    }
  }
  return [...byCode.values()].filter(g => g.length > 1);
}

/**
 * Same-code rows this phone holds that are NOT the old bug's twins — a
 * real collision, left intact by dedupeCrewsByCode. Read it to SAY so
 * ("two pods here share 4207"): the one thing a collision must never be is
 * silent, because the pods look identical on the air and their mail lands
 * in both.
 */
export function crewCodeCollisions(): Crew[][] {
  return crewsSharingCode(listCrews()).filter(g => !isTwinSet(g));
}

/**
 * ONE-TIME MERGE of the rows the join minted before it was idempotent
 * (measured Aug 24: joining your own code minted a twin, and once the
 * pod's real name arrived over the mesh BOTH twins adopted it — "two Dust
 * Bunnies", owner-caught). joinCrew refuses to mint the second row now,
 * but the rows it already wrote are DATA, and data outlives the bug.
 *
 * Only twin sets merge (isTwinSet). Survivor: the row holding a human's
 * own work if exactly one does, then the strongest name claim
 * ('mine' > 'mesh' > placeholder), then the OLDEST row (ids carry their
 * mint time — it is the one the pod's history accreted under). memberIds
 * are unioned so nobody's pick is lost when two filled-in twins collapse.
 * Picks outrank the name because a name is recoverable and a pick is not:
 * a survivor left wearing a placeholder adopts the pod's real name again
 * on the next reconcile, the same way it got it the first time.
 *
 * Idempotent and SILENT when there is nothing to merge, so callers may run
 * it every reconcile pass.
 */
export function dedupeCrewsByCode(): boolean {
  const nameClaim = (c: Crew): number =>
    podNameSource(c) === 'mine' ? 2 : podNameSource(c) === 'mesh' ? 1 : 0;
  const born = (c: Crew): number => {
    const m = /^crew-(\d+)-/.exec(c.id);
    return m ? Number(m[1]) : 0;
  };
  const all = listCrews();
  const merged = new Map<string, Crew>();
  const dropped = new Set<string>();
  for (const group of crewsSharingCode(all)) {
    if (!isTwinSet(group)) {
      continue; // a real collision — crewCodeCollisions() surfaces it
    }
    const head = [...group].sort(
      (a, b) =>
        Number(holdsOwnWork(b)) - Number(holdsOwnWork(a)) ||
        nameClaim(b) - nameClaim(a) ||
        born(a) - born(b),
    )[0];
    merged.set(head.id, {
      ...head,
      memberIds: [...new Set(group.flatMap(c => c.memberIds))],
    });
    for (const c of group) {
      if (c.id !== head.id) {
        dropped.add(c.id);
      }
    }
  }
  if (dropped.size === 0) {
    return false;
  }
  // Original display order, untouched rows as they were.
  const ordered = all
    .filter(c => !dropped.has(c.id))
    .map(c => merged.get(c.id) ?? c);
  setSetting(KEY, JSON.stringify(ordered));
  notifyCrewsChanged();
  return true;
}

export function removeCrew(id: string): void {
  setSetting(KEY, JSON.stringify(listCrews().filter(c => c.id !== id)));
  notifyCrewsChanged();
}

// ---------------------------------------------------------------------------
// Creation + join codes
// ---------------------------------------------------------------------------

/** Rolls a fresh PIN gets before it settles for a code already held. */
const MINT_TRIES = 12;

/** One roll: "0000"-"9999", string, leading zero kept. */
function mintPin(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

/**
 * A 4-digit PIN, "0000"-"9999" (owner, Aug 24: "i think codes may be too
 * long ... a 4digit pin, or word+number is fine"). It is a STRING at every
 * layer — a leading zero is part of the code, and "0042" parsed as a
 * number would join a different pod than the one that was said out loud.
 *
 * ENTROPY, measured rather than assumed: the retired three-word phrase was
 * 10 adjectives x 10 nouns x 90 numbers = 9,000 spellings (13.1 bits); a
 * 4-digit PIN is 10,000 (13.3 bits). The short code is very slightly
 * STRONGER than the long one and far easier to shout across a loud camp
 * and type with gloves, so there is no security trade in this change. What
 * was true before is still true: 13 bits resists shoulder-surfing, NOT
 * capture (docs/CREW-DESIGN.md §6e) — real entropy belongs in the QR/beam
 * path, not in a code humans say out loud.
 *
 * REROLLS PAST A CODE THIS PHONE ALREADY HOLDS. 10,000 PINs means a fresh
 * pod can land on one you already joined, and that is the ONLY way one
 * phone ends up holding two different pods under one code (the trace is
 * above dedupeCrewsByCode). One reroll costs a settings read and makes the
 * state unreachable, so it happens at the mint rather than being sorted
 * out later by a merge that cannot tell the two pods apart.
 *
 * BOUNDED. A mint must always return a code — a phone that cannot name a
 * new pod is worse than a collision, and a collision is survivable: the
 * merge fuses it only when the other row holds nothing a human made, and
 * otherwise leaves both rows for crewCodeCollisions to surface. With
 * MINT_TRIES rolls even a phone holding a hundred pods misses by about one
 * chance in 10^24; the bound is here for the loop's sake, not the odds'.
 */
export function newCrewCode(): string {
  const held = new Set(listCrews().map(c => normalizeCrewCode(c.code)));
  let code = mintPin();
  for (let i = 1; i < MINT_TRIES && held.has(normalizeCrewCode(code)); i++) {
    code = mintPin();
  }
  return code;
}

/** A fresh, unsaved crew — id and join code minted here; saveCrew persists.
 * A pod you START is named by you, so it is never a placeholder. */
export function newCrew(name: string, memberIds: string[] = []): Crew {
  return {
    id: `crew-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    name,
    code: newCrewCode(),
    memberIds,
    nameSource: 'mine',
  };
}

/**
 * Join a pod somebody ELSE minted — the missing half of "same code, same
 * pod" (composed review, Aug 24: codes displayed but nothing accepted one).
 * The code IS the shared identity on the wire (beacon + messages key on its
 * hash, normalized trim+lowercase there); locally this is just a crew whose
 * code arrived from a campmate. Members start empty — rows fill in as
 * podmates' announcements arrive and as cards are swapped, which is the
 * honest order of operations at a dusty camp.
 *
 * ANY code shape joins. New pods mint 4-digit PINs, but a campmate may
 * still be holding a written-down "dusty-flamingo-42" from an older build,
 * and the wire keys on the hash of whatever string is typed — so the old
 * shape keeps working forever and only the minting changed.
 *
 * The name is a PLACEHOLDER unless the joiner typed one: the pod's real
 * name arrives over the mesh (podMembers.ts), and until it does, nothing
 * here may pretend a join code is a name a human chose.
 *
 * IDEMPOTENT ON THE CODE. "Same code, same pod" has to be true locally too:
 * joining a code this phone already holds returns THAT pod, it does not
 * mint a second one (measured on two phones, Aug 24: typing your own pod's
 * code produced an identical duplicate, and every message then had two
 * places to live). This does not touch the "two pods may share a name"
 * invariant — the code is the identity, the name is a label, and pods are
 * still keyed by id. A name typed while re-joining fills in a placeholder
 * and never overwrites a name already chosen.
 */
export function joinCrew(code: string, name?: string): Crew {
  const clean = code.trim();
  const chosen = name?.trim() ?? '';
  const already = listCrews().find(
    c => normalizeCrewCode(c.code) === normalizeCrewCode(clean),
  );
  if (already) {
    return chosen.length > 0 && canAdoptPodName(already)
      ? saveCrew({ ...already, name: chosen, nameSource: 'mine' })
      : already;
  }
  return saveCrew({
    id: `crew-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    name: chosen || placeholderPodName(clean),
    code: clean,
    memberIds: [],
    nameSource: chosen.length > 0 ? 'mine' : 'code',
  });
}

// ---------------------------------------------------------------------------
// What a pod is CALLED
// ---------------------------------------------------------------------------

/** The stand-in name for a pod nobody on this phone has named: "Pod 4207".
 * Reads as a thing rather than as a machine token, and still says WHICH
 * pod — the code is the only handle a joiner has until a name arrives. */
export function placeholderPodName(code: string): string {
  return `Pod ${code.trim()}`.slice(0, NAME_MAX);
}

/**
 * Where this pod's name came from. The stored source is the truth for
 * anything saved since announcements shipped; a row without one is read,
 * never migrated — joinCrew used to store the raw code as the name, and
 * placeholderPodName is what it stores now, so a name that matches either
 * shape was never chosen by a human and anything else was.
 */
export function podNameSource(crew: Crew): PodNameSource {
  if (crew.nameSource) {
    return crew.nameSource;
  }
  const name = crew.name.trim();
  return normalizeCrewCode(name) === normalizeCrewCode(crew.code) ||
    name === placeholderPodName(crew.code)
    ? 'code'
    : 'mine';
}

/** Is this pod still wearing a name nobody chose? */
export function isPlaceholderPodName(crew: Crew): boolean {
  return podNameSource(crew) === 'code';
}

/**
 * May a podmate's announcement set this pod's name? Yes until the user
 * types one: a placeholder is waiting for a name, and an ADOPTED name is
 * still the mesh's to update (the namer renamed the pod — nobody here
 * decided anything). A name typed on this phone is never overwritten.
 */
export function canAdoptPodName(crew: Crew): boolean {
  return podNameSource(crew) !== 'mine';
}

/**
 * The pod's name where a name belongs — a chip, a card title. Never empty:
 * an unnamed pod shows its placeholder, which carries the code.
 */
export function podDisplayName(crew: Crew): string {
  return isPlaceholderPodName(crew)
    ? placeholderPodName(crew.code)
    : crew.name;
}

/**
 * The pod's name INSIDE A SENTENCE ("Share my position with ___"). An
 * unnamed pod says "this pod": a join code where a name belongs is the
 * exact thing the two-phone test caught — "Share my position with
 * electric-flamingo-54" is not a sentence a person would write.
 */
export function podLabel(crew: Crew): string {
  return isPlaceholderPodName(crew) ? 'this pod' : crew.name;
}
