/**
 * Pod invite link tests — rung 0 of the connectivity ladder
 * (docs/WALKIE-LADDER.md §8). Pure node: no native modules, no RN runtime.
 * `podLink.ts` imports only `beacon.ts` (which has zero imports) and two
 * const strings plus a type from `friendCard.ts`, so the whole module runs
 * under Hermes and under node unchanged.
 *
 * Every assertion below is written to DIE on a specific mutation, named
 * beside it. The two that matter most are the path-anchoring pair (a link
 * family that shadows another silently routes a scan to the wrong importer)
 * and the leading-zero code (a 4-digit PIN of "0042" that becomes 42 joins a
 * DIFFERENT pod, and does it quietly, in the one place a user cannot check).
 */
import {
  POD_INVITE_VERSION,
  POD_LINK_HTTPS,
  POD_LINK_SCHEME,
  POD_QR_MAX_CHARS,
  decodePodInviteBody,
  decodePodLink,
  encodePodInviteBody,
  encodePodLink,
  encodePodSchemeLink,
  fitPodInvite,
  fitsOnePodQr,
  inviteCardBundleJson,
  type PodInvite,
} from '../src/crews/podLink';
import { QR_MAX_CHARS, decodeBeamLink, encodeBeamLink } from '../src/beam/beamLink';
import { decodeFriendLink, encodeFriendLink } from '../src/friends/friendLink';
import { FRIEND_BUNDLE_FORMAT, FRIEND_BUNDLE_KIND } from '../src/friends/friendCard';

const CARD = {
  id: 'a1b2c3d4',
  seq: 3,
  name: 'Dust Bunny',
  camp: 'Camp Placeholder',
  address: '7:30 & E',
  note: 'find me at sunrise',
  updated_at: '2026-08-24T00:00:00.000Z',
  scope: 'direct' as const,
};

const INVITE: PodInvite = { code: '4821', name: 'Sunrise Crew', card: CARD, radios: 2 };

describe('encode/decode round trip', () => {
  it('the https link decodes back to the same invite', () => {
    expect(decodePodLink(encodePodLink(INVITE))).toEqual(INVITE);
  });

  it('the scheme link decodes back to the same invite', () => {
    expect(decodePodLink(encodePodSchemeLink(INVITE))).toEqual(INVITE);
  });

  it('both carriers are the documented ones', () => {
    // Mutation: change either carrier and the intent filters in
    // AndroidManifest.xml stop matching what the QR actually encodes —
    // a scan that opens nothing, discoverable only on a second phone.
    expect(POD_LINK_HTTPS).toBe('https://playapal.lol/p');
    expect(POD_LINK_SCHEME).toBe('playapal://pod');
    expect(encodePodLink(INVITE).startsWith(`${POD_LINK_HTTPS}#`)).toBe(true);
    expect(encodePodSchemeLink(INVITE).startsWith(`${POD_LINK_SCHEME}#`)).toBe(true);
  });

  it('a code-only invite round-trips — the smallest case is the one a stranger scans', () => {
    expect(decodePodLink(encodePodSchemeLink({ code: '4821' }))).toEqual({ code: '4821' });
  });

  it('www and http are accepted like the two sibling decoders', () => {
    const frag = encodePodLink(INVITE).split('#')[1];
    expect(decodePodLink(`https://www.playapal.lol/p#${frag}`)).toEqual(INVITE);
    expect(decodePodLink(`http://playapal.lol/p#${frag}`)).toEqual(INVITE);
  });
});

describe('the three link families never shadow each other', () => {
  // THE LOAD-BEARING PAIR. App.tsx tries the decoders in sequence, so a
  // decoder that accepts a sibling's URL silently routes a scanned friend
  // card into the pod importer (or worse, the reverse). Both directions are
  // asserted because a one-directional fix reads as done and is not.
  it('a friend link and a beam link are NOT pod links', () => {
    expect(decodePodLink('https://playapal.lol/f#abcdef')).toBeNull();
    expect(decodePodLink('playapal://friend#abcdef')).toBeNull();
    expect(decodePodLink('https://playapal.lol/b#abcdef')).toBeNull();
    expect(decodePodLink('playapal://beam#abcdef')).toBeNull();
    expect(decodePodLink(encodeFriendLink('{"kind":"x"}'))).toBeNull();
    expect(decodePodLink(encodeBeamLink('{"kind":"y"}'))).toBeNull();
  });

  it('a pod link is NOT a friend link or a beam link', () => {
    const https = encodePodLink(INVITE);
    const scheme = encodePodSchemeLink(INVITE);
    expect(decodeFriendLink(https)).toBeNull();
    expect(decodeFriendLink(scheme)).toBeNull();
    expect(decodeBeamLink(https)).toBeNull();
    expect(decodeBeamLink(scheme)).toBeNull();
  });

  it('a bare host with no path is not a pod link', () => {
    expect(decodePodLink('https://playapal.lol#abcdef')).toBeNull();
    expect(decodePodLink('playapal://#abcdef')).toBeNull();
  });
});

describe('the code is the identity, and it survives intact', () => {
  it('a leading-zero PIN is preserved exactly', () => {
    // Mutation: parse the code as a number anywhere in the chain and "0042"
    // becomes 42 — a DIFFERENT pod, joined silently, in the one place the
    // user cannot see what went wrong. The owner ruled 4-digit PINs, so
    // 1 in 10 codes begins with a zero.
    const out = decodePodLink(encodePodSchemeLink({ code: '0042' }));
    expect(out?.code).toBe('0042');
    expect(out?.code).not.toBe('42');
  });

  it('a numeric code is REFUSED, not coerced', () => {
    // Mutation: accept `code: 42` and String() it — "0042" and 42 then
    // normalize to different pods while looking like the same invite.
    expect(decodePodInviteBody(JSON.stringify({ v: 1, code: 4821 }))).toBeNull();
  });

  it('the code is normalized the same way joinCrew normalizes it', () => {
    // Mutation: skip normalizeCrewCode on either side and a scanned invite
    // lands in a different pod than the same code typed by hand — two doors,
    // two rooms, which is the one thing rung 0 must never do.
    const out = decodePodLink(encodePodSchemeLink({ code: '  ELECTRIC-Flamingo-54 ' }));
    expect(out?.code).toBe('electric-flamingo-54');
  });

  it('an invite with no usable code is null, never a join sheet that cannot succeed', () => {
    expect(decodePodInviteBody(JSON.stringify({ v: 1, code: '   ' }))).toBeNull();
    expect(decodePodInviteBody(JSON.stringify({ v: 1 }))).toBeNull();
  });
});

describe('a peer’s invite is a peer’s word for it', () => {
  it('malformed input is null and never throws — this feeds Linking', () => {
    // Mutation: let anything throw and a hostile QR crashes the app at the
    // moment of scanning, before any UI exists to explain it.
    expect(decodePodLink('not a url')).toBeNull();
    expect(decodePodLink(`${POD_LINK_SCHEME}#!!!not-base64!!!`)).toBeNull();
    expect(decodePodLink(`${POD_LINK_SCHEME}#`)).toBeNull();
    expect(decodePodInviteBody('{')).toBeNull();
    expect(decodePodInviteBody('null')).toBeNull();
    expect(decodePodInviteBody('[]')).toBeNull();
    expect(decodePodInviteBody('"a string"')).toBeNull();
  });

  it('an unknown future version still joins — the code is the point', () => {
    // Mutation: reject v!==1 and a phone one release ahead cannot invite a
    // phone one release behind, at BRC, where neither can update.
    expect(decodePodInviteBody(JSON.stringify({ v: 9, code: '4821', wat: 1 }))).toEqual({
      code: '4821',
    });
    expect(POD_INVITE_VERSION).toBe(1);
  });

  it('v0 and a non-integer version are refused', () => {
    expect(decodePodInviteBody(JSON.stringify({ v: 0, code: '4821' }))).toBeNull();
    expect(decodePodInviteBody(JSON.stringify({ v: '1', code: '4821' }))).toBeNull();
  });

  it('a half-decoded card is dropped, the invite survives', () => {
    // Mutation: accept a partial card and it renders as a blank friend row,
    // which is worse than the identity simply arriving over the air later.
    const body = JSON.stringify({ v: 1, code: '4821', card: { id: 'a1b2c3d4', name: 'x' } });
    expect(decodePodInviteBody(body)).toEqual({ code: '4821' });
  });

  it('a card with a bogus scope is dropped', () => {
    const body = JSON.stringify({ v: 1, code: '4821', card: { ...CARD, scope: 'everyone' } });
    expect(decodePodInviteBody(body)).toEqual({ code: '4821' });
  });

  it('absent fields are OMITTED from the wire, never sent as null', () => {
    // Mutation: emit nulls and the smallest invite — the one a stranger
    // scans — grows for no reason at the only budget that is tight.
    const body = encodePodInviteBody({ code: '4821' });
    expect(JSON.parse(body)).toEqual({ v: 1, code: '4821' });
    expect(body).not.toMatch(/null/);
  });

  it('a blank name and a zero radios bitmap do not travel', () => {
    const body = JSON.parse(encodePodInviteBody({ code: '4821', name: '   ', radios: 0 }));
    expect(body).toEqual({ v: 1, code: '4821' });
  });
});

describe('the QR budget degrades, it never refuses', () => {
  it('a normal invite fits one QR whole', () => {
    expect(fitsOnePodQr(INVITE)).toBe(true);
    expect(fitPodInvite(INVITE)).toEqual({ invite: INVITE, droppedCard: false });
  });

  it('an oversize card is DROPPED and the invite still works', () => {
    // Mutation: return null / throw on overflow and the pod becomes
    // unshareable because of an optional courtesy field. The code is the
    // payload; the card is the bonus.
    const fat = { ...CARD, note: 'x'.repeat(4000) };
    const invite: PodInvite = { code: '4821', name: 'Sunrise Crew', card: fat, radios: 2 };
    expect(fitsOnePodQr(invite)).toBe(false);
    const fitted = fitPodInvite(invite);
    expect(fitted.droppedCard).toBe(true);
    expect(fitted.invite.card).toBeUndefined();
    expect(fitted.invite.code).toBe('4821');
    expect(fitted.invite.name).toBe('Sunrise Crew');
    expect(fitted.invite.radios).toBe(2);
    expect(fitsOnePodQr(fitted.invite)).toBe(true);
    // and it is still a real, scannable, decodable invite
    expect(decodePodLink(encodePodSchemeLink(fitted.invite))?.code).toBe('4821');
  });

  it('the QR budget agrees with the beam lane’s', () => {
    // podLink duplicates the constant rather than importing across lanes;
    // this is the pin that keeps the duplicate honest. Mutation: change one
    // and not the other, and a code that BeamQr calls scannable is one PodQr
    // calls too big (or worse, the reverse).
    expect(POD_QR_MAX_CHARS).toBe(QR_MAX_CHARS);
  });

  it('a hostile fragment is rejected before it can allocate', () => {
    expect(decodePodLink(`${POD_LINK_SCHEME}#${'A'.repeat(400 * 1024)}`)).toBeNull();
  });
});

describe('the inviter’s card installs through the friend importer, not a second one', () => {
  it('the bundle is exactly what installFriendBundle takes', () => {
    // Mutation: hand-roll a second merge path and the two drift — greatest-seq
    // wins in one place and last-write-wins in the other, for the same card.
    const json = inviteCardBundleJson(INVITE);
    expect(json).not.toBeNull();
    expect(JSON.parse(json as string)).toEqual({
      kind: FRIEND_BUNDLE_KIND,
      format: FRIEND_BUNDLE_FORMAT,
      cards: [CARD],
    });
  });

  it('no card means no bundle, not an empty one', () => {
    // Mutation: return a bundle with cards: [] and the importer reports
    // "nothing new" where it should have said nothing at all.
    expect(inviteCardBundleJson({ code: '4821' })).toBeNull();
  });
});
