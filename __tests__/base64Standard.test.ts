/**
 * ONE STANDARD-ALPHABET CODEC, HELD TO AN INDEPENDENT ORACLE.
 *
 * This existed twice — src/crews/radio.ts and src/crews/callSignal.ts — as two
 * structurally DIFFERENT implementations: a quad decoder with a precomputed
 * output length, and a bit accumulator. Reading them side by side could not
 * settle whether they were interchangeable, and a wire codec is exactly where
 * "they look equivalent" is not evidence. So the merge was decided by a
 * differential: 10,000 fuzz cases over random byte strings, random VALID
 * base64, and random JUNK, plus every encoder's output round-tripped through
 * both decoders. They agreed everywhere, including on the malformed inputs —
 * which is where two decoders usually part company and where reading tells you
 * least.
 *
 * NOW THAT THERE IS ONE, a differential has nothing to compare against, so
 * this suite checks it against an INDEPENDENT ORACLE instead: node's Buffer.
 * That is strictly stronger than self-round-tripping, which a codec that is
 * consistently WRONG passes perfectly.
 */
const { Buffer: NodeBuffer } = require('buffer');
import { decodeB64Standard, encodeB64Standard } from '../src/util/base64';
import { bytesToB64, b64ToBytes } from '../src/crews/radio';
import { b64Encode, b64Decode } from '../src/crews/callSignal';

/** Deterministic, so a failure is reproducible rather than a rumour. */
let seed = 0x20260826;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

describe('the standard base64 codec is correct, not merely self-consistent', () => {
  test('the oracle is real — CONTROL', () => {
    // If Buffer were unavailable or misused, every arm below would compare a
    // value against itself and pass over nothing.
    expect(NodeBuffer.from([104, 105]).toString('base64')).toBe('aGk=');
    expect(Array.from(NodeBuffer.from('aGk=', 'base64'))).toEqual([104, 105]);
    // ...and the oracle must be able to DISAGREE with a wrong answer.
    expect(NodeBuffer.from([104, 105]).toString('base64')).not.toBe('aGk');
  });

  test('encoding matches node Buffer over 2000 random inputs, padding included', () => {
    const bad: string[] = [];
    for (let t = 0; t < 2000 && bad.length < 3; t++) {
      const bytes = new Uint8Array(Array.from({ length: rnd(200) }, () => rnd(256)));
      const ours = encodeB64Standard(bytes);
      const want = NodeBuffer.from(bytes).toString('base64');
      if (ours !== want) { bad.push(`len=${bytes.length} ours=${ours} node=${want}`); }
    }
    expect(bad).toEqual([]);
  });

  test('decoding matches node Buffer over 2000 well-formed inputs', () => {
    const bad: string[] = [];
    for (let t = 0; t < 2000 && bad.length < 3; t++) {
      const bytes = new Uint8Array(Array.from({ length: rnd(200) }, () => rnd(256)));
      const b64 = NodeBuffer.from(bytes).toString('base64');
      const ours = Array.from(decodeB64Standard(b64));
      if (JSON.stringify(ours) !== JSON.stringify(Array.from(bytes))) {
        bad.push(`len=${bytes.length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('both modules still expose the SAME codec under their old names', () => {
    // The merge kept every call site by re-exporting. If someone re-implements
    // one of these locally, this stops being true and the duplication is back.
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(bytesToB64(b)).toBe(encodeB64Standard(b));
    expect(b64Encode(b)).toBe(encodeB64Standard(b));
    expect(Array.from(b64ToBytes('AAEC+vv8/Q=='))).toEqual(Array.from(b));
    expect(Array.from(b64Decode('AAEC+vv8/Q=='))).toEqual(Array.from(b));
  });

  test('decoding is LENIENT — junk is skipped, not fatal, and that is deliberate', () => {
    // Both originals did this; the merge preserves it, and a test says so out
    // loud so a future "hardening" is a decision rather than an accident.
    // NOTE this differs from the url-safe decoder, which REJECTS — that one
    // guards a hostile link fragment, this one carries our own frames.
    expect(Array.from(decodeB64Standard('aG k=\n'))).toEqual([104, 105]);
    expect(Array.from(decodeB64Standard('aG@k='))).toEqual([104, 105]);
  });
});

export {};
