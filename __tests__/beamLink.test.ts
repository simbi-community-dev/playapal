/**
 * Beam link (QR wire) tests — contract §5. Pure node: no native modules, no
 * RN runtime; the module under test runs under Hermes unchanged (no Buffer,
 * no TextDecoder beyond friendLink's hand-rolled UTF-8).
 */
import {
  BEAM_LINK_HTTPS,
  BEAM_LINK_SCHEME,
  QR_MAX_CHARS,
  decodeBeamLink,
  encodeBeamLink,
  encodeBeamSchemeLink,
  fitsOneQr,
} from '../src/beam/beamLink';
import { decodeFriendLink } from '../src/friends/friendLink';

const BOARD = JSON.stringify({
  kind: 'playapal-camp-board',
  version: 1,
  envelopes: [
    { id: 'a1', notes: [{ text: 'Dust storm Tuesday', where_addr: '4:15 & C' }] },
    { id: 'b2', notes: [{ text: 'Ice run at noon', where_addr: '9:00 & Esplanade' }] },
  ],
});

describe('encode/decode round trip', () => {
  it('https link decodes back to the exact bundle JSON', () => {
    expect(decodeBeamLink(encodeBeamLink(BOARD))).toBe(BOARD);
  });

  it('scheme link decodes back to the exact bundle JSON', () => {
    expect(decodeBeamLink(encodeBeamSchemeLink(BOARD))).toBe(BOARD);
  });

  it('carriers and prefixes are what the contract §5 declares', () => {
    expect(encodeBeamLink(BOARD).startsWith(`${BEAM_LINK_HTTPS}#`)).toBe(true);
    expect(encodeBeamSchemeLink(BOARD).startsWith(`${BEAM_LINK_SCHEME}#`)).toBe(true);
    expect(BEAM_LINK_HTTPS).toBe('https://playapal.lol/b');
    expect(BEAM_LINK_SCHEME).toBe('playapal://beam');
  });

  it('round trips unicode (emoji, non-BMP) intact', () => {
    const json = JSON.stringify({ kind: 'playapal-camp-board', note: '🔥 burn at 9:00 & 🔥 — café' });
    expect(decodeBeamLink(encodeBeamLink(json))).toBe(json);
  });

  it('gzip actually compresses: a realistic board is much smaller than raw JSON', () => {
    // A naive no-compression encoder would produce ~4/3 of the raw JSON
    // length; a real gzip encoder lands well under it for repeated content.
    const big = JSON.stringify({
      kind: 'playapal-camp-board',
      envelopes: Array.from({ length: 20 }, (_, i) => ({
        id: `w${i}`,
        notes: [{ text: 'the same camp story told again and again', where_addr: '4:15 & C' }],
      })),
    });
    const fragLen = encodeBeamLink(big).length - `${BEAM_LINK_HTTPS}#`.length;
    expect(fragLen).toBeLessThan(big.length); // gzip, not 4/3 base64 of raw
  });
});

describe('both representations accepted (contract §5)', () => {
  it('decodes a PLAIN (ungzipped) fragment — magic sniff absent → UTF-8 JSON', () => {
    // Hand-rolled: base64url of the raw JSON, no gzip. The decoder must
    // sniff the missing 0x1f 0x8b and take the plain path.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes: number[] = [];
    for (const ch of BOARD) {
      bytes.push(ch.charCodeAt(0)); // BOARD is pure ASCII
    }
    let frag = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      frag += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bytes.length) frag += B64[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bytes.length) frag += B64[c & 63];
    }
    expect(decodeBeamLink(`${BEAM_LINK_SCHEME}#${frag}`)).toBe(BOARD);
  });

  it('MUTATION-KILL: a decoder that skips the gzip sniff and always inflates fails', () => {
    // The plain fragment above must decode; a skip-the-sniff decoder throws
    // inside inflate on non-gzip bytes. This test pins the sniff.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = Array.from(BOARD).map((ch) => ch.charCodeAt(0));
    let frag = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      frag += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bytes.length) frag += B64[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bytes.length) frag += B64[c & 63];
    }
    const out = decodeBeamLink(`${BEAM_LINK_HTTPS}#${frag}`);
    expect(out).toBe(BOARD);
    expect(out).not.toBeNull();
  });

  it('corrupt gzip bytes → null, never a throw', () => {
    // 0x1f 0x8b then garbage: the sniff fires, inflate fails, honest null.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bad = [0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe];
    let frag = '';
    for (let i = 0; i < bad.length; i += 3) {
      const a = bad[i];
      const b = i + 1 < bad.length ? bad[i + 1] : 0;
      const c = i + 2 < bad.length ? bad[i + 2] : 0;
      frag += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bad.length) frag += B64[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bad.length) frag += B64[c & 63];
    }
    expect(decodeBeamLink(`${BEAM_LINK_SCHEME}#${frag}`)).toBeNull();
  });
});

describe('path anchoring — /f and /b must never shadow each other', () => {
  it('MUTATION-KILL: a /f friend link returns null from decodeBeamLink', () => {
    expect(decodeBeamLink('https://playapal.lol/f#abcdef')).toBeNull();
    expect(decodeBeamLink('playapal://friend#abcdef')).toBeNull();
    // A /f link whose fragment is valid base64url of valid plain-UTF-8 JSON
    // — a regex that accepts /f WOULD decode this, so it must return null.
    // base64url('{"kind":"playapal-friend-card"}') computed inline:
    const friendJson = '{"kind":"playapal-friend-card"}';
    const B64 =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = Array.from(friendJson).map((ch) => ch.charCodeAt(0));
    let frag = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      frag += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bytes.length) frag += B64[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bytes.length) frag += B64[c & 63];
    }
    expect(decodeBeamLink(`https://playapal.lol/f#${frag}`)).toBeNull();
    expect(decodeBeamLink(`playapal://friend#${frag}`)).toBeNull();
  });

  it('a /b beam link returns null from decodeFriendLink (symmetry)', () => {
    expect(decodeFriendLink(encodeBeamLink(BOARD))).toBeNull();
    expect(decodeFriendLink(encodeBeamSchemeLink(BOARD))).toBeNull();
  });

  it('rejects lookalikes: wrong host, wrong path, missing fragment', () => {
    expect(decodeBeamLink('https://example.com/b#abc')).toBeNull();
    expect(decodeBeamLink('https://playapal.lol/board#abc')).toBeNull();
    expect(decodeBeamLink('https://playapal.lol/b')).toBeNull();
    expect(decodeBeamLink('playapal://beamish#abc')).toBeNull();
  });

  it('accepts www and http upgrades like the friend decoder does', () => {
    const frag = encodeBeamLink(BOARD).split('#')[1];
    expect(decodeBeamLink(`https://www.playapal.lol/b#${frag}`)).toBe(BOARD);
    expect(decodeBeamLink(`http://playapal.lol/b#${frag}`)).toBe(BOARD);
  });

  it('invalid base64url in the fragment → null', () => {
    expect(decodeBeamLink(`${BEAM_LINK_SCHEME}#not!!!base64`)).toBeNull();
    expect(decodeBeamLink(`${BEAM_LINK_SCHEME}#`)).toBeNull();
  });
});

describe('QR budget', () => {
  it('a small board fits one QR', () => {
    expect(fitsOneQr(BOARD)).toBe(true);
    expect(encodeBeamSchemeLink(BOARD).length).toBeLessThanOrEqual(QR_MAX_CHARS);
  });

  it('matches the FINAL-WEEK measurement shape: ~8 envelopes in, ~12+ out', () => {
    // Varied, INCOMPRESSIBLE note content — FINAL-WEEK warns the naive test
    // "compresses 20 identical envelopes to nothing and lies". A keyed PRNG
    // (no Math.random — determinism under both node and Hermes) makes every
    // note distinct so gzip cannot dedupe across envelopes.
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const word = () => rnd().toString(36) + rnd().toString(36);
    const mk = (n: number) =>
      JSON.stringify({
        kind: 'playapal-camp-board',
        envelopes: Array.from({ length: n }, (_, i) => ({
          writer: `writer-${word()}`,
          notes: [
            {
              id: `n${i}-${word()}`,
              text: Array.from({ length: 12 }, word).join(' '),
              where_addr: `${3 + (rnd() % 7)}:${15 + (rnd() % 45)} & ${'ABCDEFGH'[rnd() % 8]}`,
              when: `2026-08-2${rnd() % 9}`,
            },
          ],
        })),
      });
    expect(fitsOneQr(mk(4))).toBe(true);
    expect(fitsOneQr(mk(60))).toBe(false);
  });

  it('MUTATION-KILL: an over-budget board must NOT fit (guards the honest overflow)', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const word = () => rnd().toString(36) + rnd().toString(36);
    const huge = JSON.stringify({
      kind: 'playapal-camp-board',
      envelopes: Array.from({ length: 200 }, (_, i) => ({
        writer: `w${i}-${word()}`,
        notes: [{ text: Array.from({ length: 30 }, word).join(' ') }],
      })),
    });
    expect(fitsOneQr(huge)).toBe(false);
    // And the encoded link really is over budget — the false isn't an
    // encode failure masquerading as overflow.
    expect(encodeBeamSchemeLink(huge).length).toBeGreaterThan(QR_MAX_CHARS);
  });

  it('QR_MAX_CHARS is the contract constant 1800', () => {
    expect(QR_MAX_CHARS).toBe(1800);
  });
});
