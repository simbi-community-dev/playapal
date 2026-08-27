/**
 * NOT CRYPTOGRAPHIC, AND THE NEXT CALLER NEEDS TO KNOW THAT.
 *
 * This existed twice, privately, in campBoard.ts and friendCard.ts. Stating it
 * once is the point of this file; stating the CONSTRAINT once is the reason it
 * is worth a docstring rather than a re-export.
 *
 * Math.random is not a CSPRNG. Every current caller is fine with that, and the
 * reason is the threat model, not luck:
 *
 *   - the camp incarnation token compares a value in the app database against
 *     one in the Caches directory, to notice that settings were restored from
 *     a backup without their cache. It never leaves the device, and an
 *     attacker who can read it already has the phone.
 *   - writer ids and post ids need to be DISTINCT, not unguessable; envelopes
 *     carry their own signature, so knowing a writer id does not let you write
 *     as one.
 *
 * If you need a value whose UNPREDICTABILITY is load-bearing — a capability
 * token, a pairing secret, anything a stranger could gain by guessing — do not
 * reach for this. Math.random is seeded from a small state and its output is
 * recoverable from a handful of samples.
 */
export const randHex = (chars: number): string => {
  let s = '';
  while (s.length < chars) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
};
