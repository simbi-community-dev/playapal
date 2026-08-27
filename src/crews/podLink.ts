/**
 * Pod invite links — rung 0 of the connectivity ladder
 * (docs/WALKIE-LADDER.md §8), and the answer to "did pods get the same kit
 * the friend card and the camp beam got?"
 *
 * They did not. Until this file, a pod was the ONLY shareable object in the
 * app you could not hand to someone by pointing a camera at a screen: the
 * friend card has `friendLink.ts` + a QR + an intent filter, the camp board
 * has `beamLink.ts` + `BeamQr` + its own filter, and a pod had four typed
 * digits. It is also the object where handing it over matters most, because
 * it starts a relationship rather than copying a file.
 *
 * SAME SHAPE AS ITS TWO SIBLINGS, deliberately, down to the regex:
 *   - the payload rides the URL FRAGMENT, which browsers never send over the
 *     network, so even the online fallback (someone without the app scanning
 *     the code) decodes client-side and no server ever learns a pod code;
 *   - `https://playapal.lol/p#<frag>` is the share-sheet carrier (has a web
 *     fallback), `playapal://pod#<frag>` is the QR carrier (opens the app
 *     offline regardless of app-link verification, which dev and adhoc
 *     builds never have);
 *   - decoding is PATH-ANCHORED, so a /f friend link and a /b beam link both
 *     return null here, and a /p pod link returns null from their decoders.
 *     Three filter families that can never shadow each other.
 *
 * WHAT IS NOT CHANGED, and this is the invariant that keeps two doors from
 * becoming two rooms: THE CODE IS STILL THE IDENTITY. `joinCrew(code)` is
 * untouched, the typed 4-digit PIN keeps working exactly as it does, and an
 * invite is a second door to the same pod. Everything else in the payload is
 * a convenience that arrives EARLY — the name and the card would have come
 * over the air eventually; the scan just beats the radio to it.
 *
 * What arriving early actually buys (docs/PUNCHLIST.md FIELD TEST):
 *   #3 the pod NAME never travels — the joiner stares at
 *      "electric-flamingo-54" in six places until gossip lands. Over a scan
 *      the name is there before the pod is.
 *   #5 every message from an un-carded podmate reads "someone in the pod" —
 *      the invite IS a card swap, so the inviter has a face immediately.
 *      kimi's line generalized: the card swap is an announcement the air has
 *      not delivered yet, and a QR is that announcement delivered by eyeball.
 *
 * ENTROPY, honestly: this adds none. The link carries the same 13.3-bit code
 * the PIN does (#9). What it buys is that a longer code becomes FREE LATER —
 * once the normal way in is a scan, code length stops costing UX, and the
 * typed PIN stays short as the degraded path. That change belongs to the
 * identity lane and the owner's 4-digit ruling, not here.
 */
import type { FriendCard } from '../friends/friendCard';
import { FRIEND_BUNDLE_FORMAT, FRIEND_BUNDLE_KIND } from '../friends/friendCard';
import { normalizeCrewCode } from './beacon';
import { MAX_FRAGMENT_CHARS, base64urlDecode, base64urlEncode } from '../friends/friendLink';

export const POD_LINK_HTTPS = 'https://playapal.lol/p';
export const POD_LINK_SCHEME = 'playapal://pod';

/** The body format this build MINTS. Decode accepts anything >= 1, the
 * podMembers.ts posture: a v2 invite from a newer phone still has a code in
 * it, and a code is the whole point. */
export const POD_INVITE_VERSION = 1;

// MAX_FRAGMENT_CHARS is imported from the friend decoder — the same ceiling,
// stated once. A hostile fragment never gets to allocate against the phone.

/** One QR's worth of characters, matching beamLink.QR_MAX_CHARS. Duplicated
 * rather than imported so the crews lane carries no dependency on the beam
 * lane; the invariant is pinned by a test that reads both files. */
export const POD_QR_MAX_CHARS = 1800;

// NAME_MAX is imported from crew.ts, where pod names are actually clamped.
// Restating the number here is what would let the two drift apart.
import { NAME_MAX } from './crew';

export interface PodInvite {
  /** The pod's join code. Identity — normalized on both encode and decode so
   * a scanned invite and a typed PIN land in the same pod. */
  code: string;
  /** The pod's name, when the inviter has named it. */
  name?: string;
  /** The inviter's own FriendCard. Dropped rather than refused when the
   * invite would overflow one QR (see fitPodInvite). */
  card?: FriendCard;
  /** The inviter's rung bitmap (docs/WALKIE-LADDER.md §4) — so the ladder
   * starts warm and the first live frame already knows which rung to probe. */
  radios?: number;
}

const clampName = (s: string): string =>
  [...s.trim().replace(/\s+/g, ' ')].slice(0, NAME_MAX).join('');

/** The wire body. Absent fields are OMITTED, never sent as null — an invite
 * for an unnamed pod with no card is ~40 bytes, which is the case that has
 * to stay smallest because it is the one a stranger scans. */
export function encodePodInviteBody(invite: PodInvite): string {
  const code = normalizeCrewCode(invite.code);
  const body: Record<string, unknown> = { v: POD_INVITE_VERSION, code };
  const name = invite.name === undefined ? '' : clampName(invite.name);
  if (name.length > 0) {
    body.name = name;
  }
  if (invite.card) {
    body.card = invite.card;
  }
  if (typeof invite.radios === 'number' && Number.isInteger(invite.radios) && invite.radios > 0) {
    body.radios = invite.radios;
  }
  return JSON.stringify(body);
}

/**
 * A peer's invite is a peer's word for it — every field checked, null on
 * anything malformed (the decodeBeacon/decodeMemberBody posture: a bad frame
 * is cheap to drop and must never be a throw into Linking). A version we do
 * not know is NOT a rejection: the fields we understand still make a join.
 */
export function decodePodInviteBody(body: string): PodInvite | null {
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
  if (typeof r.code !== 'string') {
    return null;
  }
  const code = normalizeCrewCode(r.code);
  if (code.length === 0) {
    // An invite with no code names no pod — it would open a join sheet that
    // cannot succeed, which is worse than the scan simply not being ours.
    return null;
  }
  const out: PodInvite = { code };
  if (typeof r.name === 'string' && clampName(r.name).length > 0) {
    out.name = clampName(r.name);
  }
  const card = validCard(r.card);
  if (card) {
    out.card = card;
  }
  if (Number.isInteger(r.radios) && (r.radios as number) > 0) {
    out.radios = r.radios as number;
  }
  return out;
}

/** A card is carried whole or not at all: a half-decoded card would render
 * as a blank friend row, which is worse than the identity simply arriving
 * over the air a few seconds later, the way it does today. */
function validCard(v: unknown): FriendCard | null {
  if (!v || typeof v !== 'object') {
    return null;
  }
  const c = v as Record<string, unknown>;
  const strings = ['id', 'name', 'camp', 'address', 'note', 'updated_at'];
  for (const k of strings) {
    if (typeof c[k] !== 'string') {
      return null;
    }
  }
  if (!Number.isInteger(c.seq) || (c.seq as number) < 0) {
    return null;
  }
  if (c.scope !== 'crew' && c.scope !== 'direct') {
    return null;
  }
  return {
    id: c.id as string,
    seq: c.seq as number,
    name: c.name as string,
    camp: c.camp as string,
    address: c.address as string,
    note: c.note as string,
    updated_at: c.updated_at as string,
    scope: c.scope as FriendCard['scope'],
  };
}

/** Invite → the https link (share-sheet text; has the web fallback). */
export function encodePodLink(invite: PodInvite): string {
  return `${POD_LINK_HTTPS}#${base64urlEncode(encodePodInviteBody(invite))}`;
}

/** Invite → the custom-scheme link the QR encodes. Opens the app offline on
 * both platforms regardless of app-link verification state. */
export function encodePodSchemeLink(invite: PodInvite): string {
  return `${POD_LINK_SCHEME}#${base64urlEncode(encodePodInviteBody(invite))}`;
}

/**
 * Incoming URL → invite, or null when the URL is not a pod link. Anchored on
 * the PATH like its two siblings: a /f friend link and a /b beam link MUST
 * return null here, or the three filter families shadow each other.
 */
export function decodePodLink(url: string): PodInvite | null {
  const m = url.match(
    /^(?:https?:\/\/(?:www\.)?playapal\.lol\/p|playapal:\/\/pod)#(.+)$/,
  );
  if (!m) {
    return null;
  }
  if (m[1].length > MAX_FRAGMENT_CHARS) {
    return null;
  }
  const body = base64urlDecode(m[1]);
  if (body === null) {
    return null;
  }
  return decodePodInviteBody(body);
}

/**
 * The invite that actually fits one QR — it DEGRADES, it never refuses.
 *
 * Code and name always fit (a code is ~10 chars, a name is clamped at 40), so
 * the only thing that can overflow is the card, and the card is the only part
 * the mesh would have delivered anyway. Dropping it costs the joiner a few
 * seconds of "someone in the pod"; refusing the invite costs them the pod.
 * That asymmetry is the whole rule.
 *
 * Returns the fitted invite plus whether the card was dropped, so the QR view
 * can say the true thing in one sentence instead of silently handing over a
 * smaller invite than the user thought they were sharing.
 */
export function fitPodInvite(invite: PodInvite): {
  invite: PodInvite;
  droppedCard: boolean;
} {
  if (encodePodSchemeLink(invite).length <= POD_QR_MAX_CHARS) {
    return { invite, droppedCard: false };
  }
  if (invite.card === undefined) {
    // Nothing left to drop. A code-and-name invite over the QR budget is not
    // reachable from any UI in this app (both fields are clamped), but saying
    // so with a flag beats pretending it fit.
    return { invite, droppedCard: false };
  }
  const rest: PodInvite = { code: invite.code };
  if (invite.name !== undefined) {
    rest.name = invite.name;
  }
  if (invite.radios !== undefined) {
    rest.radios = invite.radios;
  }
  return { invite: rest, droppedCard: true };
}

/** True when this invite fits one QR whole, card included. */
export function fitsOnePodQr(invite: PodInvite): boolean {
  return encodePodSchemeLink(invite).length <= POD_QR_MAX_CHARS;
}

/**
 * The inviter's card as the friend BUNDLE JSON that `installFriendBundle`
 * already takes — so a scanned pod invite installs its card through the same
 * merge path (greatest seq wins, scope honored) as a scanned friend card. No
 * second importer, no second set of merge rules to drift.
 */
export function inviteCardBundleJson(invite: PodInvite): string | null {
  if (!invite.card) {
    return null;
  }
  return JSON.stringify({
    kind: FRIEND_BUNDLE_KIND,
    format: FRIEND_BUNDLE_FORMAT,
    cards: [invite.card],
  });
}
