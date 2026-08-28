/**
 * My card, ready to hand over — ONE payload builder for every door that
 * shares it (docs/SHARING-SURFACES.md §2.1, duplication #1).
 *
 * THE BUG THIS FILE ENDS (owner, 2026-08-25): the pod row's "We're together
 * — swap cards" put the RAW BUNDLE JSON into the share sheet. On Android
 * that opens a chooser for a text blob the receiver cannot import; on iPhone
 * the sheet previewed the first line of `JSON.stringify(bundle, null, 1)` —
 * a single `{` and nothing else. FriendsSection had already paid for this
 * exact lesson in the field and switched to a LINK (Marisol, 2026-08-20),
 * but the pod row lived in another lane and never got the cure. Two copies
 * of one gesture is how one of them stays broken, so there is one builder
 * now and both doors call it.
 *
 * WHY TWO CARRIERS. They are not a preference:
 *
 *   - the SHARE-SHEET link is `https`, because it may reach a phone with no
 *     Playa Pal on it, and the fragment then renders as a card page with a
 *     pointer to the app. The fragment never leaves the device either way —
 *     browsers do not send it — so no server sees a card.
 *   - the QR link is the CUSTOM SCHEME, because a QR held up between two
 *     people is aimed at a phone that HAS the app: the scheme opens it
 *     offline whatever the https app-link verification state is, and dev and
 *     ad-hoc builds never carry the release signing key that verification
 *     needs. This is PodQr's reasoning, unchanged, applied to the card.
 *
 * Both throw when the card has no name — `exportMyCard` refuses to send a
 * card nobody can be shown as, and the callers open the editor instead.
 */

import type { DbConnection } from '../events/engine';
import { exportMyCard } from './friendCard';
import { encodeFriendLink, encodeFriendSchemeLink } from './friendLink';

/** The link you SEND to someone who is not standing in front of you. */
export function myCardShareLink(conn: DbConnection): string {
  return encodeFriendLink(exportMyCard(conn));
}

/** The link a QR carries when the other phone has the app — offline-safe. */
export function myCardQrLink(conn: DbConnection): string {
  return encodeFriendSchemeLink(exportMyCard(conn));
}
