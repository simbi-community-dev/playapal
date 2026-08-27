/**
 * THE TWO BASE64 ALPHABETS, SIDE BY SIDE, ON PURPOSE.
 *
 * This tree had FIVE copies of a base64 alphabet across four directories, and
 * they were not all the same alphabet — two were url-safe and three were
 * standard, every one of them correct for its own job, and every one of them
 * named `B64`. That is the worst possible arrangement: a name that promises
 * sameness over values that must differ.
 *
 * A sweep for duplicate constants reported them as identical, because it
 * compared a truncated 60-character preview of a 64-character string — the
 * two bytes that distinguish the alphabets are the last two. Merging them on
 * that evidence would have silently corrupted either every friend card and
 * beam link, or every radio and camp-note payload, depending which way the
 * merge went. Nothing would have thrown; the bytes would just have been wrong.
 *
 * So they live here TOGETHER, named for what they are, with the reason each
 * one exists written next to it. Stating them once each is what stops them
 * drifting; stating them adjacently is what stops the next person merging
 * them.
 */

/**
 * RFC 4648 §4, the standard alphabet, with `+` and `/`.
 * For payloads that travel as opaque bytes and are never pasted into a URL:
 * the mesh radio frames, call signalling, and camp-note photo wire format.
 */
export const B64_STANDARD =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * RFC 4648 §5, the url-safe alphabet, with `-` and `_`.
 * For anything that ends up in a link or a QR fragment — friend cards, beam
 * bundles, pod invites. `+` and `/` are not safe there: `+` decodes to a
 * space in a query string and `/` ends a path segment, so a standard-alphabet
 * payload can be silently mangled by any hop that normalises the URL.
 */
export const B64_URLSAFE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * STANDARD-ALPHABET BASE64, one implementation.
 *
 * This existed twice — src/crews/radio.ts and src/crews/callSignal.ts — as two
 * structurally different implementations: a quad decoder with a precomputed
 * output length, and a bit accumulator. They were merged only after a
 * differential proved them interchangeable, not after they were read and
 * judged similar. 10,000 fuzz cases agreed: encoders over random byte strings,
 * decoders over random VALID and random JUNK strings, and every encoder's
 * output round-tripping through both decoders. The malformed cases mattered
 * most — that is where two decoders usually part company, and where reading
 * the code tells you least.
 *
 * DECODING IS LENIENT ON PURPOSE: characters outside the alphabet are SKIPPED,
 * not rejected, so whitespace in a pasted payload does not destroy it. Both
 * originals did this and the merge preserves it. Note this differs from the
 * url-safe decoder in friendLink, which REJECTS an out-of-alphabet character —
 * a deliberate difference, because that one guards a hostile link fragment
 * while this one carries our own frames.
 */
export function encodeB64Standard(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_STANDARD[a >> 2] + B64_STANDARD[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64_STANDARD[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_STANDARD[c & 63] : '=';
  }
  return out;
}

export function decodeB64Standard(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const c2 = i + 2 < clean.length ? B64_STANDARD.indexOf(clean[i + 2]) : 0;
    const c3 = i + 3 < clean.length ? B64_STANDARD.indexOf(clean[i + 3]) : 0;
    const n =
      (B64_STANDARD.indexOf(clean[i]) << 18) |
      (B64_STANDARD.indexOf(clean[i + 1]) << 12) |
      (c2 << 6) |
      c3;
    out[o++] = (n >> 16) & 255;
    if (o < out.length) {
      out[o++] = (n >> 8) & 255;
    }
    if (o < out.length) {
      out[o++] = n & 255;
    }
  }
  return out;
}
