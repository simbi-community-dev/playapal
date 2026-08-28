/**
 * OUR ENCODER MUST NEVER EMIT BYTES OUR DECODER REFUSES.
 *
 * A lone surrogate (U+D800–U+DFFF standing alone) is not a Unicode scalar
 * value and has no UTF-8 encoding. Both hand-rolled encoders wrote it as three
 * bytes anyway — ED A0 80, which is CESU-8 — and utf8DecodeStrict correctly
 * REJECTS that. So `base64urlDecode(base64urlEncode(s))` returned null for
 * such an s: the codec could not round-trip its own output.
 *
 * WHERE A LONE SURROGATE COMES FROM: UTF-16-unit truncation. `.slice(0, 24)`
 * on a name whose 24th unit is the first half of an emoji leaves exactly one.
 * src/camp/campBoard.ts truncates user text that way in a dozen places.
 *
 * WHY THIS WAS LATENT RATHER THAN LIVE, stated so nobody re-derives it: every
 * shipped wire format JSON.stringify()s before encoding, and JSON escapes a
 * lone surrogate to `\ud83d` — pure ASCII, which encodes and decodes fine. The
 * pod-invite path was measured doing exactly that. So no camper hit this. But
 * that safety belongs to the CALLERS, not to the codec, and the next caller to
 * encode raw text would have inherited a codec that cannot round-trip.
 *
 * WHY THE FIX CANNOT BREAK A WORKING CASE: the only inputs whose bytes change
 * are those that previously produced INVALID UTF-8 — bytes the strict decoder
 * already refused. Nothing that decodes today decodes differently tomorrow.
 */
import { base64urlEncode, base64urlDecode, utf8Encode } from '../src/friends/friendLink';
import { utf8Encode as callSignalUtf8 } from '../src/crews/callSignal';
// require, not import: the project's TS lib declares neither the web globals
// nor node's util types (@types/node is not in tsconfig's `types`), and a test
// that cannot TYPECHECK is one the documented gate stops at before ever
// running it — lint, typecheck, jest, in that order.
const { TextDecoder, TextEncoder } = require('util');

const LONE = 'a\uD800b';
const TRUNCATED_EMOJI = 'Dusty ' + '🔥'.slice(0, 1);

const isValidUtf8 = (bytes: number[]): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return true;
  } catch {
    return false;
  }
};

describe('a lone surrogate encodes to valid UTF-8', () => {
  test('the fixture really is a lone surrogate — CONTROL', () => {
    // Without this, every arm below could be asserting about ordinary text.
    expect(TRUNCATED_EMOJI.length).toBe(7);
    const last = TRUNCATED_EMOJI.charCodeAt(6);
    expect(last).toBeGreaterThanOrEqual(0xd800);
    expect(last).toBeLessThanOrEqual(0xdfff);
    // ...and a WELL-FORMED pair must not be touched by the fix.
    expect(Array.from(utf8Encode('🔥'))).toEqual(
      Array.from(new TextEncoder().encode('🔥')),
    );
  });

  test('both encoders match the platform on a lone surrogate', () => {
    const want = Array.from(new TextEncoder().encode(LONE));
    expect(Array.from(utf8Encode(LONE))).toEqual(want);
    expect(Array.from(callSignalUtf8(LONE))).toEqual(want);
  });

  test('the bytes are valid UTF-8, not CESU-8', () => {
    expect(isValidUtf8(Array.from(utf8Encode(LONE)))).toBe(true);
    expect(isValidUtf8(Array.from(callSignalUtf8(LONE)))).toBe(true);
    // ED A0 80 is what the bug produced; assert we no longer emit it.
    expect(Array.from(utf8Encode(LONE))).not.toContain(0xa0);
  });

  test('the codec round-trips its own output — the property that was broken', () => {
    for (const s of [LONE, TRUNCATED_EMOJI, '🔥', 'plain', '']) {
      expect(base64urlDecode(base64urlEncode(s))).not.toBeNull();
    }
    // and ordinary text is unchanged end to end
    expect(base64urlDecode(base64urlEncode('Dusty Llamas 🔥'))).toBe('Dusty Llamas 🔥');
  });
});

export {};
