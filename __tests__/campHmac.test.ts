/**
 * The camp beam seal: hand-rolled SHA-256 / HMAC-SHA256 pinned three ways —
 * FIPS 180-4 known digests, RFC 4231 HMAC vectors (the ASCII-byte-safe
 * ones), and cross-implementation equality against node:crypto for the
 * paths the fixed vectors cannot reach through a string API (>64-byte keys,
 * multi-byte UTF-8, block-boundary lengths).
 */

import {
  digestsEqual,
  hmacSha256Hex,
  sha256,
  utf8Bytes,
} from '../src/camp/hmac';

const nodeCrypto = require('crypto');

const sha256Hex = (s: string): string =>
  Array.from(sha256(utf8Bytes(s)), (b: number) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

describe('sha256 (FIPS 180-4 vectors)', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the two-block FIPS vector', () => {
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node:crypto across padding-boundary lengths (55/56/63/64/65 bytes)', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const msg = 'x'.repeat(n);
      expect(sha256Hex(msg)).toBe(
        nodeCrypto.createHash('sha256').update(msg).digest('hex'),
      );
    }
  });
});

describe('hmacSha256Hex (RFC 4231 + node:crypto cross-check)', () => {
  it('RFC 4231 test case 1 (0x0b*20 key, "Hi There")', () => {
    expect(hmacSha256Hex('\x0b'.repeat(20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('RFC 4231 test case 2 ("Jefe")', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('matches node:crypto for >64-byte keys (the hash-the-key path) and UTF-8', () => {
    const cases: [string, string][] = [
      ['k'.repeat(200), 'long ascii key'],
      ['playapal-camp-v0:dusty mary', 'water barrel 3: half full'],
      ['🔥 pass phrase 🔥', 'ünïcode message — 水 half'],
      ['', ''],
    ];
    for (const [key, msg] of cases) {
      expect(hmacSha256Hex(key, msg)).toBe(
        nodeCrypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex'),
      );
    }
  });

  it('any single-character change flips the digest', () => {
    const base = hmacSha256Hex('camp-secret', 'item-a\nitem-b');
    expect(hmacSha256Hex('camp-secret', 'item-a\nitem-c')).not.toBe(base);
    expect(hmacSha256Hex('camp-secreT', 'item-a\nitem-b')).not.toBe(base);
  });
});

describe('digestsEqual', () => {
  it('equal / unequal / length-mismatch', () => {
    expect(digestsEqual('abcd', 'abcd')).toBe(true);
    expect(digestsEqual('abcd', 'abce')).toBe(false);
    expect(digestsEqual('abcd', 'abcde')).toBe(false);
  });
});
