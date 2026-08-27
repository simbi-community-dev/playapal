/**
 * ONE UTF-8 ENCODER FOR THE WIRE CODECS, HELD TO THE PLATFORM.
 *
 * friendLink.ts and callSignal.ts each carried the same code-point walk. They
 * were merged after a DIFFERENTIAL rather than a reading — 4,000 fuzz cases
 * over strings mixing ASCII, 2-byte, 3-byte and astral code points and LONE
 * SURROGATES, checked against each other and against the platform. Once there
 * is one implementation a differential has nothing left to compare, so the
 * permanent guard uses the platform's TextEncoder as an INDEPENDENT ORACLE:
 * self-consistency is passed perfectly by an encoder that is consistently
 * wrong, which is exactly what these two were before eee3aa5.
 *
 * THE DECODERS ARE NOT MERGED, and that is a decision rather than an omission.
 * friendLink's is STRICT — malformed input returns null, because it guards a
 * hostile link fragment a stranger can hand you. callSignal's is LENIENT,
 * because it carries our own frames and skipping junk beats dropping a call.
 * A differential over 3,000 random byte strings confirmed they part company
 * only where that strictness says they should.
 *
 * AND camp/hmac.ts's utf8Bytes IS STILL SEPARATE ON PURPOSE. Its bytes feed
 * the digest that derives camp identity, so it stays frozen on the old CESU-8
 * behaviour; merging it would split a camp across app versions. That is why
 * the shared function is called encodeUtf8 and not utf8Bytes — a different
 * name is the cheap guard, campIdentityFrozen.test.ts is the real one.
 */
import { utf8Encode as flEncode } from '../src/friends/friendLink';
import { utf8Encode as csEncode } from '../src/crews/callSignal';
import { encodeUtf8 } from '../src/util/utf8';
import { utf8ByteLength } from '../src/crews/messages';
import { utf8Bytes as hmacUtf8 } from '../src/camp/hmac';

const { TextEncoder } = require('util');

let seed = 0x20260826;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
/** Strings that reach every branch, including the one with no valid encoding. */
const randStr = (len: number): string => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const r = rnd(100);
    if (r < 55) {
      s += String.fromCharCode(rnd(128));
    } else if (r < 75) {
      s += String.fromCharCode(0x80 + rnd(0x700));
    } else if (r < 90) {
      s += String.fromCharCode(0x800 + rnd(0xd000));
    } else if (r < 97) {
      s += String.fromCodePoint(0x10000 + rnd(0xfffff));
    } else {
      s += String.fromCharCode(0xd800 + rnd(0x800));
    }
  }
  return s;
};

describe('the wire codecs share one encoder, and it matches the platform', () => {
  test('the oracle and the generator are real — CONTROLS', () => {
    expect(Array.from(new TextEncoder().encode('é'))).toEqual([195, 169]);
    // The generator must actually produce lone surrogates, or the arm that
    // matters below never runs and the suite is green over nothing.
    let sawLone = false;
    for (let t = 0; t < 500 && !sawLone; t++) {
      for (const ch of randStr(20)) {
        const c = ch.charCodeAt(0);
        if (c >= 0xd800 && c <= 0xdfff && ch.length === 1) {
          sawLone = true;
          break;
        }
      }
    }
    expect(sawLone).toBe(true);
  });

  test('both exported names ARE the shared implementation', () => {
    // If someone re-implements one locally, this fails rather than the
    // duplication quietly returning.
    for (const s of ['', 'a', 'é', '日', '🔥', 'a\uD800b']) {
      expect(flEncode(s)).toEqual(encodeUtf8(s));
      expect(Array.from(csEncode(s))).toEqual(encodeUtf8(s));
    }
  });

  test('FUZZ: 4000 strings encode exactly as the platform does', () => {
    const bad: string[] = [];
    for (let t = 0; t < 4000 && bad.length < 3; t++) {
      const s = randStr(rnd(40));
      const ours = encodeUtf8(s);
      const want = Array.from(new TextEncoder().encode(s));
      if (JSON.stringify(ours) !== JSON.stringify(want)) {
        bad.push(`${JSON.stringify(s)} ours=${ours} node=${want}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('the allocation-free byte COUNTER agrees with the encoder', () => {
    // messages.ts counts UTF-8 bytes without building them, because the radio
    // caps are byte caps and a 256 KiB body should not cost a scratch array.
    // Two ways of computing one number: if they disagree, a message is either
    // rejected that would fit or accepted that will not.
    const bad: string[] = [];
    for (let t = 0; t < 2000 && bad.length < 3; t++) {
      const s = randStr(rnd(40));
      if (utf8ByteLength(s) !== encodeUtf8(s).length) {
        bad.push(`${JSON.stringify(s)} count=${utf8ByteLength(s)} actual=${encodeUtf8(s).length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('camp/hmac keeps its OWN encoder, frozen — asserted, not assumed', () => {
    // The merge must not have swept this one in. A lone surrogate is where the
    // frozen behaviour differs, so that is where it is checked.
    const lone = 'a\uD800b';
    expect(Array.from(hmacUtf8(lone))).toEqual([97, 237, 160, 128, 98]); // CESU-8
    expect(encodeUtf8(lone)).toEqual([97, 239, 191, 189, 98]); // U+FFFD
    // ...and they must still agree on everything that is NOT a lone surrogate.
    for (const s of ['', 'a', 'é', '日', '🔥', 'dusty llamas']) {
      expect(Array.from(hmacUtf8(s))).toEqual(encodeUtf8(s));
    }
  });
});

export {};
