/**
 * One door for an arriving link, whoever opened it.
 *
 * App.tsx has always owned what a Playa Pal URL DOES — install a beam,
 * install a card, ask before joining a pod — and `Linking` was the only way
 * in. The in-app scanner is a second way in with the same payload, and the
 * one thing it must not become is a second importer: the merge rules, the
 * consent ask and the confirmations all live in that handler, and a copy of
 * them would drift the day someone edits one.
 *
 * So the scanner does not act. It DELIVERS, on the same listener shape
 * friendCard.ts already uses for "show my card" — App.tsx subscribes with the
 * very function it hands `Linking`, and there is still exactly one actor.
 */

import { decodeBeamLink } from '../beam/beamLink';
import { decodeFriendLink } from '../friends/friendLink';
import { decodePodLink } from '../crews/podLink';

type UrlListener = (url: string) => void;
const listeners = new Set<UrlListener>();

export function subscribeIncomingUrl(cb: UrlListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Is this text one of ours? Asked with the SHIPPED decoders rather than a
 * fourth copy of the URL patterns — a scanner that recognises a link the
 * handler cannot read (or refuses one it can) is the worst of both.
 */
export function isPlayaPalLink(text: string): boolean {
  return (
    decodeBeamLink(text) !== null ||
    decodeFriendLink(text) !== null ||
    decodePodLink(text) !== null
  );
}

/**
 * Hand a scanned or pasted link to the app's URL handler.
 *
 * Returns false when the text is not a Playa Pal link — the caller owes the
 * camper a sentence in that case, because "nothing happened" in front of a
 * person waiting to swap cards is indistinguishable from a broken phone
 * (the dead-end the pod QR already paid for, docs/WALKIE-LADDER.md §8).
 */
export function deliverIncomingUrl(text: string): boolean {
  if (!isPlayaPalLink(text)) {
    return false;
  }
  for (const cb of listeners) {
    cb(text);
  }
  return true;
}
