/**
 * Beam links — the QR wire for SMALL boards (contract §5, 2026-08-21).
 *
 * A sibling of the friend link, never a reuse of it:
 * `https://playapal.lol/b#<frag>` and `playapal://beam#<frag>` where
 * `<frag>` is base64url of gzip(bundleJSON) via fflate. The fragment never
 * reaches a server; with the app installed the deep link opens Playa Pal
 * directly, offline. gzip is what makes a real camp board fit one QR at
 * all — measured (FINAL-WEEK.md): 2 envelopes ≈ 1,008 chars, 8 ≈ 1,596,
 * 12 ≈ 1,892 (over budget).
 *
 * The decoder accepts BOTH representations on the fragment: gzip-magic
 * (0x1f 0x8b) present → inflate; absent → plain UTF-8 JSON. A hand-rolled
 * or older uncompressed beam therefore still scans.
 *
 * No Buffer, no TextDecoder assumptions beyond what friendLink already
 * relies on — the same code runs under Hermes and under node for tests.
 */

/* eslint-disable no-bitwise -- byte-twiddling IS this module's job */

import { gunzipSync, gzipSync } from 'fflate';
import { MAX_FRAGMENT_CHARS, base64urlEncode, utf8DecodeStrict, utf8Encode } from '../friends/friendLink';

export const BEAM_LINK_HTTPS = 'https://playapal.lol/b';
export const BEAM_LINK_SCHEME = 'playapal://beam';

/**
 * One-QR capacity, in link characters. Version-40 codes top out near 2953
 * bytes; beyond ~1800 the modules are too dense for a dusty
 * across-the-table scan anyway (review 2026-08-19). THE shared constant —
 * FriendsSection imports it from here rather than keeping a second copy.
 */
export const QR_MAX_CHARS = 1800;

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

// MAX_FRAGMENT_CHARS is imported from the friend decoder, not restated.

/** Contract §3's native wire cap (4 MiB + 4 KiB slack), mirrored JS-side. */
const MAX_INFLATE_BYTES = 4 * 1024 * 1024 + 4 * 1024;

// The alphabet is stated once, in src/util/base64.ts — see there for why
// this tree has two of them and why they must never be merged.
import { B64_URLSAFE as B64 } from '../util/base64';

/** base64url string → raw bytes, or null on any invalid character. */
const base64urlDecodeBytes = (s: string): number[] | null => {
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
  return bytes;
};

/** Bundle JSON → gzipped bytes (fflate, pure JS — Hermes and node). */
const gzipBytes = (json: string): Uint8Array => {
  // fflate's gzipSync is the gzip CONTAINER (magic 0x1f 0x8b), which is
  // what the decoder sniffs for.
  return gzipSync(new Uint8Array(utf8Encode(json)));
};

/** Raw bytes → base64url string (unpadded, per convention). */
const base64urlEncodeBytes = (bytes: ArrayLike<number>): string => {
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
  return out;
};

/** Bundle JSON → the https link (share-sheet text; has the web fallback). */
export function encodeBeamLink(bundleJson: string): string {
  return `${BEAM_LINK_HTTPS}#${base64urlEncodeBytes(gzipBytes(bundleJson))}`;
}

/**
 * Bundle JSON → the custom-scheme link the QR encodes. The scheme opens the
 * app OFFLINE on both platforms regardless of app-link verification state
 * (same reasoning as the friend link, review 2026-08-19).
 */
export function encodeBeamSchemeLink(bundleJson: string): string {
  return `${BEAM_LINK_SCHEME}#${base64urlEncodeBytes(gzipBytes(bundleJson))}`;
}

/**
 * Incoming URL → bundle JSON, or null when the URL is not a beam link.
 * Anchored on the PATH like decodeFriendLink: a /f friend link MUST return
 * null here (and a /b link must return null from decodeFriendLink), or the
 * two filter families shadow each other. The fragment may carry
 * gzip(json) (magic 0x1f 0x8b → inflate) or plain UTF-8 JSON (both
 * representations accepted).
 */
export function decodeBeamLink(url: string): string | null {
  const m = url.match(
    /^(?:https?:\/\/(?:www\.)?playapal\.lol\/b|playapal:\/\/beam)#(.+)$/,
  );
  if (!m) {
    return null;
  }
  // Same pre-alloc ceiling as the friend decoder — a hostile fragment
  // never gets to allocate against the phone.
  if (m[1].length > MAX_FRAGMENT_CHARS) {
    return null;
  }
  const bytes = base64urlDecodeBytes(m[1]);
  if (!bytes || bytes.length === 0) {
    return null;
  }
  if (bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
    try {
      // Inflate with an output cap at the native wire ceiling (contract §3,
      // 4 MiB + 4 KiB slack) so a gzip-bomb fragment dies here instead of
      // expanding against the install seam's own size gate.
      const plain = gunzipSync(new Uint8Array(bytes), {
        out: new Uint8Array(MAX_INFLATE_BYTES),
      });
      if (plain.length >= MAX_INFLATE_BYTES) {
        return null;
      }
      return utf8DecodeStrict(Array.from(plain));
    } catch {
      return null; // corrupt gzip — honest null, never a throw into Linking
    }
  }
  if (bytes.length > MAX_INFLATE_BYTES) {
    return null;
  }
  return utf8DecodeStrict(bytes);
}

/**
 * Does this bundle fit one QR? Measured against the SCHEME link, because that
 * is what the QR renders (BeamQr) — and the scheme link is the SHORTER of the
 * two, `playapal://beam#` at 16 chars against `https://playapal.lol/b#` at 23.
 *
 * The previous comment here had that backwards ("a few chars longer than the
 * https one"). It was harmless while both were the same shape and became a
 * live 7-character overflow the moment the QR rendered the https carrier —
 * fitsOneQr would answer yes about a link nobody could scan. Measure what you
 * render.
 */
export function fitsOneQr(bundleJson: string): boolean {
  return encodeBeamSchemeLink(bundleJson).length <= QR_MAX_CHARS;
}

// Re-export so callers of the beam lane never need to know the friend
// module exists; the friend link's plain base64urlEncode stays the
// single implementation of unpadded base64url over UTF-8 text.
export { base64urlEncode };
