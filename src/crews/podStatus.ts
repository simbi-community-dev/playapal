/**
 * Pod link status — the pure half of the pod card's connection list
 * (owner ask, 2026-08-25: "ui indicators for when phones are 'aware' of
 * each other within the pod ... am i connected and who to are the key
 * questions, link speed/ladder rung for any active connections and what
 * that enables should be clear").
 *
 * TWO LAWS GOVERN EVERY WORD AND GLYPH HERE:
 *
 *  1. PROOF BEFORE CLAIM (docs/WALKIE-LADDER.md §5). A live-voice tier may
 *     only come from the walkie's own peer list — the native side lists a
 *     peer only after the link is proven (datapath up, or connect + MTU +
 *     identity read). Presence is a heard beacon, so it proves "their radio
 *     reaches mine right now" and nothing more. Capability announcements
 *     (the radios bitmap) prove NOTHING about reachability and are
 *     deliberately not an input to any tier.
 *
 *  2. CAPABILITY WORDS, NEVER MECHANISM (§5a, extended by the owner's ask
 *     to this one surface). The user hears what a link ENABLES — voice,
 *     messages now, messages when you pass by — never which radio carries
 *     it. The one fidelity word is "lo-fi", because the panel's channel
 *     list already wears it ("Name (lo-fi)", walkie.ts) and it names a real
 *     audible difference: one vocabulary, one lane. The regression suite
 *     bans protocol words from every phrase.
 *
 * An out-of-range podmate is STILL A MEMBER (§1: a rung failure degrades
 * fidelity, never membership) — 'quiet' is a calm state with calm words,
 * not an error. And an async-only podmate is never a degraded live one
 * (§2a): "messages when you pass by" is what the mesh actually does for
 * them, said as the capability it is.
 *
 * Pure on purpose: no store reads, no clocks, no native imports — the
 * component (PodLinks.tsx) feeds these functions from the same stores the
 * rest of the pod card already reads.
 */

import { nameKey } from './rosterFold';
import type { WalkiePeerEntry } from './walkie';

/**
 * The ladder, translated to what a camper can DO with it, best first:
 *
 *  - 'voice'      a proven live channel at full quality
 *  - 'voice-lofi' a proven live channel, rougher (the panel's lo-fi badge)
 *  - 'near'       their beacon is arriving now — messages get through
 *  - 'recent'     heard lately, not right now — store-and-forward reality
 *  - 'quiet'      a member the air has not carried lately; notes keep
 */
export type LinkTier = 'voice' | 'voice-lofi' | 'near' | 'recent' | 'quiet';

/** What one member's row needs to know, from stores the caller owns. */
export interface MemberLinkEvidence {
  /** Their row in the walkie's peer list, while the walkie is OPEN — the
   * only evidence that may claim live voice (§5). Null when the walkie is
   * off, absent, or does not list them. */
  walkieRung: WalkiePeerEntry['rung'] | null;
  /** The sighting store's answer (src/crews/presence.ts): live means a
   * beacon within the live window; a non-live sighting is still within the
   * 30-minute TTL or the store would have pruned it. */
  presence: { atMs: number; live: boolean } | null;
}

/**
 * The tier, from evidence — and ONLY downward on missing evidence, with no
 * intermediate "connecting…" state to superstitiously watch (§5a). A
 * proven walkie row outranks presence because it proves more: voice
 * flowing on a LAN reaches a podmate the Bluetooth beacon may never see.
 */
export function memberLinkTier(e: MemberLinkEvidence): LinkTier {
  if (e.walkieRung === 'lan' || e.walkieRung === 'aware') {
    return 'voice';
  }
  if (e.walkieRung === 'ble') {
    return 'voice-lofi';
  }
  // A DEMOTED datagram row ('stale') claims no voice at all and falls
  // through to the presence evidence below. That is the §5 direction: the
  // row stopped proving it was alive, so the only honest thing left to say
  // about this person is what the beacon store saw.
  if (e.presence?.live) {
    return 'near';
  }
  if (e.presence) {
    return 'recent';
  }
  return 'quiet';
}

/**
 * The non-verbal channel: bar steps whose INK encodes the tier, so the
 * eye ranks rows without reading (and color is never the only signal —
 * every glyph rides beside its capability phrase). Steps, not bars-of-N:
 * three, two, one, then the two non-live shapes, deliberately not steps at
 * all — an absent link is a different KIND of state, not a smaller amount
 * of the same one (§2a).
 */
export function linkGlyph(tier: LinkTier): string {
  switch (tier) {
    case 'voice':
      return '▂▄▆';
    case 'voice-lofi':
      return '▂▄';
    case 'near':
      return '▂';
    case 'recent':
      return '◌';
    case 'quiet':
      return '—';
  }
}

/**
 * The capability phrase — what this link lets the camper DO, in the words
 * the rest of the app already uses ("rougher" is the walkie hint's own
 * word for lo-fi; "keeps" is the voice-note route's). No radio names, no
 * ladder talk: the vocabulary test holds every phrase to that.
 */
export function tierPhrase(tier: LinkTier): string {
  switch (tier) {
    case 'voice':
      return 'voice — you can talk now';
    case 'voice-lofi':
      return 'lo-fi voice — rougher, but live';
    case 'near':
      return 'nearby — messages get through now';
    case 'recent':
      return 'messages when you pass by';
    case 'quiet':
      return 'not seen lately — messages keep for them';
  }
}

/**
 * Walkie peers, keyed for the roster. The peers event carries NAMES, not
 * card ids (the native side never learns a card id), so matching a channel
 * row to a roster row is a name fold — the same trimmed/collapsed/cased
 * key rosterFold uses, and the same honesty about it: two same-named
 * podmates can collide here, which mislabels a row's TIER at worst, never
 * its membership. Exact matching needs the sender hash in the peers event
 * — surfaced as an open question, not bolted on.
 *
 * On a collision the BETTER rung wins: claiming lo-fi for a person the
 * radio provably reaches at full quality understates, and understating is
 * the safe direction — but between two proven rungs, the one that sounds
 * better is the one the camper will actually experience.
 */
export function rungsByName(
  entries: WalkiePeerEntry[],
): Map<string, WalkiePeerEntry['rung']> {
  // Ranked, not enumerated: 'stale' arrived and a two-case comparison
  // ("held is ble and the newcomer is not") silently read a DEMOTED row as
  // an upgrade over a proven lo-fi one. Rank makes the order total, and the
  // native side already lives by the same one.
  const rank = (r: WalkiePeerEntry['rung']): number =>
    r === 'lan' ? 0 : r === 'aware' ? 1 : r === 'ble' ? 2 : 3;
  const out = new Map<string, WalkiePeerEntry['rung']>();
  for (const e of entries) {
    const key = nameKey(e.name);
    const held = out.get(key);
    if (held === undefined || rank(e.rung) < rank(held)) {
      out.set(key, e.rung);
    }
  }
  return out;
}

/**
 * The one-line answer to "who can I reach?", over the whole list. "In
 * reach" counts the live tiers only — recent/quiet members are reachable
 * by note eventually, and the zero state says exactly that instead of
 * reading as failure (§2a: absence of link is a state to show calmly).
 */
export function linkSummary(tiers: LinkTier[]): string {
  if (tiers.length === 0) {
    return 'No podmates in the list yet';
  }
  const reach = tiers.filter(
    t => t === 'voice' || t === 'voice-lofi' || t === 'near',
  ).length;
  if (reach === 0) {
    return 'Nobody in reach right now — notes keep until phones meet';
  }
  const voice = tiers.filter(t => t === 'voice' || t === 'voice-lofi').length;
  const base = `${reach} of ${tiers.length} in reach`;
  return voice > 0 ? `${base} · voice with ${voice}` : base;
}

/**
 * The manual check's report — what checkPodUpdates (meshSync.ts) ACTUALLY
 * did, in capability words. Never a fake spinner's vocabulary: zero in
 * range says so calmly (reusing the summary's own "notes keep" promise),
 * and a check that moved nothing is "caught up", not silence. `moved`
 * counts what arrived HERE — what peers pulled from us is their phones'
 * knowledge, and this surface never guesses.
 */
export function checkOutcomePhrase(r: {
  inRange: number;
  moved: number;
}): string {
  if (r.inRange === 0) {
    return 'Nobody in range right now — notes keep until phones meet';
  }
  if (r.moved > 0) {
    return `Caught up — ${r.moved} new ${
      r.moved === 1 ? 'message' : 'messages'
    } arrived`;
  }
  return `All caught up with ${
    r.inRange === 1 ? 'the podmate' : 'everyone'
  } in range`;
}

/** The honest recency line beside the pod's own status: when mail last
 * actually moved, or the plain truth that it has not yet this session. */
export function lastSyncPhrase(ago: string | null): string {
  return ago === null
    ? 'Not caught up with anyone yet'
    : `Last caught up ${ago}`;
}

/** What this phone knows about ITSELF, from the session and the walkie. */
export interface MyLinkEvidence {
  /** Position sharing is on for THIS pod (share.ts sharingCrewId). */
  sharingOn: boolean;
  /** The session exists but its RADIO dropped (session.ts radioInterrupted,
   * excluding 'no-fix') — the state that must never read as connected,
   * because the pod genuinely cannot hear this phone. */
  radioDown: boolean;
  /** Sharing is on and the phone has no GPS fix yet ('no-fix'). Since the
   * mailbox decoupling this is NOT a dead radio: the phone is on the air
   * carrying mail, it simply has no place to put in the advert yet, and
   * saying "the pod can't hear this phone" about it would be false in the
   * one direction that matters to someone waiting on a message. */
  waitingForFix: boolean;
  /** The walkie channel is open (walkie.ts walkieOn). */
  walkieOn: boolean;
  /** The mailbox is on the air: this phone is advertising position-free,
   * scanning and serving pod mail (share.ts mailboxPresenceOn). Sharing
   * implies it — a shared position rides the same session. */
  mailboxOn: boolean;
}

/**
 * "Am I connected" — the header's answer, glyph + phrase, same vocabulary
 * as the member rows. RADIO TRUTH ORDERS THE ARMS: a dead radio wins over
 * every on-switch, because intent is not carriage (the share row's own
 * lesson) and a header claiming "on the air" over a paused radio is the
 * exact lie §5 exists to forbid.
 *
 * QUIET GOT A SMALLER MEANING (the mailbox decoupling, 2026-08-25). It used
 * to be literally true that a phone with sharing off was doing nothing at
 * all: no advert, no scan, no delivery. Now the app carries pod mail
 * whenever it is open, so "quiet" means UNPLACED, not unreachable — and the
 * words have to say which, because a camper who reads "podmates can't see
 * this phone" and concludes their message will not arrive has been told
 * something false by an app that knows better.
 */
export function myLinkStatus(e: MyLinkEvidence): {
  glyph: string;
  phrase: string;
} {
  if (e.sharingOn && e.radioDown) {
    return {
      glyph: '—',
      phrase: "Sharing is paused — the pod can't hear this phone right now",
    };
  }
  if (e.sharingOn && e.waitingForFix) {
    // Half on, and both halves said: the mail is moving (the mailbox frame
    // is on the air) and the place is not there yet. The pod card's own
    // share row carries the "step into the open" advice; this line's job is
    // only to stop the header claiming either extreme.
    return {
      glyph: '▂',
      phrase:
        "Finding your position — messages are moving; your pod sees you as soon as this phone has a fix",
    };
  }
  if (e.mailboxOn && e.radioDown) {
    // Not sharing, and the radio that was carrying the mail is down: the
    // one state where "nothing is moving" is the honest answer.
    return {
      glyph: '—',
      phrase: "This phone is off the air right now — notes wait until it's back",
    };
  }
  if (e.sharingOn && e.walkieOn) {
    return {
      glyph: '▂▄▆',
      phrase: "You're on the air — sharing and walkie are on",
    };
  }
  if (e.sharingOn) {
    return {
      glyph: '▂',
      phrase: "You're on the air — podmates in range can find you",
    };
  }
  if (e.walkieOn) {
    return {
      glyph: '▂▄',
      phrase: "Walkie is on — position sharing is off for this pod",
    };
  }
  if (e.mailboxOn) {
    // The common resting state now: app open, pod in the list, nobody's
    // position on the air. Two clauses because there are two facts, and the
    // camper needs both — mail moves, place doesn't.
    return {
      glyph: '◌',
      phrase:
        "You're quiet — messages still pass when a podmate is near, but nobody sees where you are",
    };
  }
  return {
    glyph: '—',
    phrase: "You're quiet — nothing is passing until you open a pod or share",
  };
}
