/**
 * ONE UTF-8 ENCODER FOR THE WIRE CODECS — and deliberately NOT the only one in
 * the tree.
 *
 * friendLink.ts and callSignal.ts each carried this walk. They were merged
 * after a differential, not after a reading: 4,000 fuzz cases over strings
 * mixing ASCII, 2-byte, 3-byte and astral code points AND lone surrogates,
 * checked against each other and against the platform's TextEncoder. They
 * agreed everywhere.
 *
 * WHY IT IS CALLED encodeUtf8 AND NOT utf8Bytes: src/camp/hmac.ts has a
 * function of that name which must NOT be merged into this one. Its bytes feed
 * a digest that derives CAMP IDENTITY, so it is deliberately frozen on the old
 * CESU-8 behaviour for lone surrogates — changing it splits a camp across app
 * versions. __tests__/campIdentityFrozen.test.ts pins that. A distinct name is
 * the cheapest way to stop a future dedupe pass reaching for the obvious
 * merge; the guard is the expensive way, and both are here.
 */

/**
 * Encode to UTF-8 bytes, matching the platform exactly — including U+FFFD for
 * a lone surrogate, which has no UTF-8 encoding of its own. Emitting three
 * bytes for the surrogate itself is CESU-8, and our strict decoder rejects it:
 * that bug shipped, and the round trip returned null for any string carrying a
 * truncated emoji.
 *
 * Returns number[] rather than Uint8Array because the link codecs index it
 * directly; callers wanting a typed array wrap it once.
 */
export const encodeUtf8 = (s: string): number[] => {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      const sc = cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
      out.push(0xe0 | (sc >> 12), 0x80 | ((sc >> 6) & 0x3f), 0x80 | (sc & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
};
