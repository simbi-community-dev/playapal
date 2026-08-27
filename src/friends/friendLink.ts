/**
 * Friend-card deep links — the QR wire (Friends on playa, 2026-08-19).
 *
 * A shared card rides a URL FRAGMENT: `https://playapal.lol/f#<base64url>`.
 * The fragment never leaves the device — browsers do not send it over the
 * network — so even the online fallback (a friend without the app scanning
 * the code) decodes client-side and no server ever sees a card. With the
 * app installed, the link opens Playa Pal directly and works with zero
 * connectivity. `playapal://friend#<base64url>` is the belt-and-suspenders
 * custom scheme (offline-safe everywhere an https app-link is not yet
 * verified); both carry the same payload.
 *
 * Encoding is hand-rolled UTF-8 → base64url: no Buffer, no atob/btoa — the
 * same 40 lines run under Hermes and under node for tests.
 */

/* eslint-disable no-bitwise -- byte-twiddling IS this module's job */

export const FRIEND_LINK_HTTPS = 'https://playapal.lol/f';
export const FRIEND_LINK_SCHEME = 'playapal://friend';

// The alphabet is stated once, in src/util/base64.ts — see there for why
// this tree has two of them and why they must never be merged.
import { B64_URLSAFE as B64 } from '../util/base64';
import { encodeUtf8 } from '../util/utf8';

/** The shared encoder, re-exported under this module's long-standing name so
 * no call site moved. See src/util/utf8.ts for what proved the merge safe. */
export const utf8Encode = encodeUtf8;
/** Strict UTF-8: any malformed, truncated, or out-of-range sequence -> null. */
export const utf8DecodeStrict = (bytes: number[]): string | null => {
  let s = '';
  let i = 0;
  const cont = (j: number): boolean => j < bytes.length && (bytes[j] & 0xc0) === 0x80;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      if (!cont(i + 1)) {
        return null;
      }
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      if (cp < 0x80) {
        return null; // overlong
      }
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      if (!cont(i + 1) || !cont(i + 2)) {
        return null;
      }
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) {
        return null; // overlong or surrogate
      }
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      if (!cont(i + 1) || !cont(i + 2) || !cont(i + 3)) {
        return null;
      }
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        return null;
      }
      i += 4;
    } else {
      return null; // stray continuation or invalid lead byte
    }
    s += String.fromCodePoint(cp);
  }
  return s;
};

/** Fragments larger than any legal 64-card bundle are rejected pre-alloc.
 * SHARED with the pod and beam decoders, which import it rather than
 * restating it: one hostile-input ceiling that cannot drift apart, and
 * this module is the one both of them already depend on. */
export const MAX_FRAGMENT_CHARS = 360 * 1024;

export const base64urlEncode = (s: string): string => {
  const bytes = utf8Encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      out += B64[((b & 15) << 2) | (c >> 6)];
    }
    if (i + 2 < bytes.length) {
      out += B64[c & 63];
    }
  }
  return out; // unpadded, per base64url convention
};

export const base64urlDecode = (s: string): string | null => {
  if (s.length > MAX_FRAGMENT_CHARS) {
    return null;
  }
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) {
      return null;
    }
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  return utf8DecodeStrict(bytes);
};

/** Bundle JSON → the https link (share-sheet text; has the web fallback). */
export function encodeFriendLink(bundleJson: string): string {
  return `${FRIEND_LINK_HTTPS}#${base64urlEncode(bundleJson)}`;
}

/**
 * Bundle JSON → the custom-scheme link the QR encodes. The scheme opens the
 * app OFFLINE on both platforms regardless of app-link verification state —
 * https app-links only verify against the release signing key, which
 * dev/adhoc builds don't carry (review 2026-08-19).
 */
export function encodeFriendSchemeLink(bundleJson: string): string {
  return `${FRIEND_LINK_SCHEME}#${base64urlEncode(bundleJson)}`;
}

/**
 * Incoming URL → bundle JSON, or null when the URL is not a friend link.
 * Accepts both carriers, with or without www, http upgraded implicitly.
 */
export function decodeFriendLink(url: string): string | null {
  const m = url.match(
    /^(?:https?:\/\/(?:www\.)?playapal\.lol\/f|playapal:\/\/friend)#(.+)$/,
  );
  if (!m) {
    return null;
  }
  return base64urlDecode(m[1]);
}
