/**
 * CAMP IDENTITY IS A FROZEN BYTE SEQUENCE. CHANGING IT UNJOINS A CAMP.
 *
 * `campIdFor(passphrase)` is sha256 over `playapal-camp-id:` plus the
 * normalized passphrase, and that sha256 runs on src/camp/hmac.ts's own
 * utf8Bytes. So the camp id — and the key fingerprint, and every board pack id
 * built from them — is a function of exactly which BYTES that encoder produces.
 *
 * WHY THIS SUITE EXISTS, and it is a specific near-miss rather than a
 * principle. Two of this app's three UTF-8 encoders were just fixed to stop
 * emitting CESU-8 for a lone surrogate (they were producing bytes our own
 * strict decoder refused). hmac.ts has the SAME defect and was deliberately
 * left alone, because its bytes are not a wire format that gets re-decoded —
 * they are the INPUT TO A DIGEST. "Fixing" it would be a correctness
 * improvement with a silent, ugly consequence:
 *
 *   a camper whose passphrase contains a lone surrogate — one truncated emoji,
 *   which is what `.slice()` on user text produces — would derive a DIFFERENT
 *   camp id on the new version. Their phone and their campmates' phones would
 *   compute different camp identities from the same typed words. The camp
 *   becomes unjoinable across versions, and nothing throws: both sides just
 *   quietly believe they are in different camps.
 *
 * normalizePassphrase trims, collapses whitespace and lowercases. It does NOT
 * strip surrogates, so the bad byte reaches the digest.
 *
 * SO THESE VALUES ARE FROZEN. A failure here is not "update the expected
 * value" — it means camp identity moved, and the question is whether a
 * deliberate, version-gated migration was intended. If it was, that migration
 * is the change; this table is its receipt.
 */
import { campIdFor, keyIdFor, normalizePassphrase } from '../src/camp/campBoard';
import { sha256Hex, utf8Bytes } from '../src/camp/hmac';

const nodeCrypto = require('crypto');

/** passphrase -> [campId, keyId], measured 2026-08-26 and frozen. */
const FROZEN: [string, string, string][] = [
  ['dusty llamas', 'd890fe5a', '98bbda08'],
  ['Dusty Llamas', 'd890fe5a', '98bbda08'],
  ['  dusty   llamas  ', 'd890fe5a', '98bbda08'],
  ['ünïcodé camp', '395a1a1a', '8451cee9'],
  ['日本語のキャンプ', 'ab5b8a9c', '626506a9'],
  ['🔥 fire camp', 'b023e886', 'f725a2d1'],
  // THE TWO THAT MATTER: a lone surrogate reaches the digest as CESU-8.
  ['truncated \uD83D', 'cbe553ce', '8240eec4'],
  ['a\uD800b', '8f755ecb', '489c26ef'],
];

describe('camp identity does not move', () => {
  test('the digest is real SHA-256 — INDEPENDENT ORACLE', () => {
    // Without this, the frozen table below could be pinning a broken hash: a
    // consistently wrong digest freezes just as happily as a right one.
    expect(sha256Hex('')).toBe(nodeCrypto.createHash('sha256').update('').digest('hex'));
    expect(sha256Hex('abc')).toBe(
      nodeCrypto.createHash('sha256').update('abc', 'utf8').digest('hex'),
    );
    for (const s of ['dusty llamas', 'ünïcodé', '日本語', '🔥']) {
      expect(sha256Hex(s)).toBe(nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  test('and it DELIBERATELY differs from the platform on a lone surrogate', () => {
    // This is the frozen bug, asserted as intentional so nobody "fixes" it by
    // accident. node encodes the lone surrogate as U+FFFD (EF BF BD); hmac.ts
    // emits CESU-8 (ED A0 80). The digests therefore differ — ON PURPOSE.
    const s = 'a\uD800b';
    expect(Array.from(utf8Bytes(s))).toEqual([97, 237, 160, 128, 98]);
    expect(sha256Hex(s)).not.toBe(
      nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    );
  });

  test('every frozen passphrase still derives the same camp id and key id', () => {
    const moved: string[] = [];
    for (const [pass, campId, keyId] of FROZEN) {
      if (campIdFor(pass) !== campId) {
        moved.push(`campIdFor(${JSON.stringify(pass)}): ${campIdFor(pass)} != frozen ${campId}`);
      }
      if (keyIdFor(pass) !== keyId) {
        moved.push(`keyIdFor(${JSON.stringify(pass)}): ${keyIdFor(pass)} != frozen ${keyId}`);
      }
    }
    expect(
      moved.length === 0
        ? []
        : [
            'CAMP IDENTITY MOVED. Every phone on the old version derives the old',
            'id from the same typed passphrase, so the camp splits in two and',
            'nothing throws — both sides just believe they are in different',
            'camps. If this change is deliberate it needs a version-gated',
            'migration, not a new expected value here.',
            ...moved,
          ],
    ).toEqual([]);
  });

  test('normalization is part of the frozen contract too', () => {
    // Case and whitespace folding are why three fixtures share an id. If
    // normalizePassphrase changed, the ids above would move for a reason that
    // has nothing to do with the encoder — so it is pinned separately.
    expect(normalizePassphrase('  Dusty   LLAMAS  ')).toBe('dusty llamas');
    expect(campIdFor('  Dusty   LLAMAS  ')).toBe(campIdFor('dusty llamas'));
    // ...and normalization must NOT strip the surrogate, or the freeze above
    // would be pinning the wrong thing entirely.
    expect(normalizePassphrase('a\uD800b')).toBe('a\uD800b');
  });
});

export {};
