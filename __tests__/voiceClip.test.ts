/**
 * voiceClip — "can these bytes be played?", asked of a voice record's base64
 * body before a camper taps it.
 *
 * THE FIELD BUG THIS PINS (owner, 2026-08-25): "voice note delivered but wont
 * play 'prepare failed status=0x1'". A take whose stop() failed leaves an
 * MPEG-4 file with an ftyp header and a lump of audio but NO `moov` index —
 * non-empty, comfortably under the byte cap, and unplayable by anything. It
 * passed every size check on the way out, gossiped across camp, and arrived
 * looking exactly like a real message.
 *
 * The fixtures below are built as real box lists rather than mocked, because
 * the box list IS the thing under test: an unfinalised recording is not a
 * short file, it is a file with a box missing, and only a walk can tell.
 *
 * CONSERVATIVE ON PURPOSE. A false 'damaged' loses a message someone left,
 * so bytes this module cannot recognise come back 'unknown' and are treated
 * as playable everywhere — the last two cases pin that direction.
 */
import {
  arrivalDamageCopy,
  base64ByteLength,
  inspectVoiceClip,
  recordingDamageCopy,
  voiceClipPlayable,
} from '../src/crews/voiceClip';

/** One MPEG-4 box: 4-byte big-endian size, 4 ASCII type bytes, payload.
 * `declaredSize` lies about the size on purpose for the truncation case. */
function box(type: string, payload: number[] = [], declaredSize?: number): number[] {
  const size = declaredSize ?? 8 + payload.length;
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...[...type].map(c => c.charCodeAt(0)),
    ...payload,
  ];
}

// require('buffer') like artPhoto.test.ts: the tree has no @types/node, and
// the module under test is Hermes-safe (no Buffer) by design — this is
// FIXTURE machinery only.
const NodeBuffer = require('buffer').Buffer;
const b64 = (bytes: number[]): string =>
  NodeBuffer.from(bytes).toString('base64');

/** Audio payload, sized so the base64 crosses several 4-char groups —
 * byteAt() decodes one group at a time and off-by-one there would be
 * invisible in a two-box toy. */
const audio = Array.from({ length: 601 }, (_, i) => i % 251);

const FTYP = box('ftyp', [...'M4A '].map(c => c.charCodeAt(0)).concat([0, 0, 2, 0]));
/** A finished take: header, audio, and the index that says where it is. */
const FINISHED = b64([...FTYP, ...box('mdat', audio), ...box('moov', [1, 2, 3, 4])]);
/** THE FIELD FAILURE, byte for byte: stop() never wrote the index, and the
 * mdat it left claims "to the end of the file" (size 0). */
const UNFINISHED = b64([...FTYP, ...box('mdat', audio, 0)]);

describe('reading the container', () => {
  test('a finished take is playable', () => {
    expect(inspectVoiceClip(FINISHED)).toEqual({ state: 'playable' });
    expect(voiceClipPlayable(FINISHED)).toBe(true);
  });

  test('a take with audio but no index is DAMAGED, not merely short', () => {
    // The exact shape MediaRecorder leaves when stop() throws. Note the size:
    // this is not an empty file, which is why every length > 0 check passed it
    // through to the mesh.
    expect(base64ByteLength(UNFINISHED)).toBeGreaterThan(600);
    expect(inspectVoiceClip(UNFINISHED)).toEqual({
      state: 'damaged',
      damage: 'unfinished',
    });
    expect(voiceClipPlayable(UNFINISHED)).toBe(false);
  });

  test('an index-less take is caught however the writer left it', () => {
    // Same failure with an honestly-sized mdat (some writers do fill it in
    // before dying): the missing box is the defect, not the size field.
    const sized = b64([...FTYP, ...box('mdat', audio)]);
    expect(inspectVoiceClip(sized)).toEqual({
      state: 'damaged',
      damage: 'unfinished',
    });
  });

  test('a body that stops inside a box it declared is truncated', () => {
    // The transfer-cut shape: mdat says 40 000 bytes and 609 arrived.
    const cut = b64([...FTYP, ...box('mdat', audio, 40_000)]);
    expect(inspectVoiceClip(cut)).toEqual({
      state: 'damaged',
      damage: 'truncated',
    });
  });

  test('an empty body is damaged, and says the emptiest thing', () => {
    expect(inspectVoiceClip('')).toEqual({ state: 'damaged', damage: 'empty' });
  });

  test('the index is found after a big mdat — the walk JUMPS, it does not scan', () => {
    // 96 KiB of audio between the header and the index, the real proportions
    // of a 30 s note. A scan would be the slow way to be right; the walk
    // reads two box headers.
    const big = Array.from({ length: 96 * 1024 }, (_, i) => i % 253);
    const whole = b64([...FTYP, ...box('mdat', big), ...box('moov', [9, 9, 9, 9])]);
    expect(inspectVoiceClip(whole)).toEqual({ state: 'playable' });
  });

  test('verdicts are memoized — the same body string never walks twice', () => {
    // Mutation: drop the cache in inspectVoiceClip — every voice row
    // re-walks its whole base64 body on every store revision, twice per
    // row (render + tap). Damaged verdicts are minted fresh per walk, so
    // reference equality here proves the cache hit, not value equality.
    expect(inspectVoiceClip(UNFINISHED)).toBe(inspectVoiceClip(UNFINISHED));
  });

  test('line-wrapped base64 reads the same as NO_WRAP', () => {
    const wrapped = (FINISHED.match(/.{1,76}/g) ?? []).join('\n');
    expect(inspectVoiceClip(wrapped)).toEqual({ state: 'playable' });
  });

  test('URL-safe base64 reads the same', () => {
    const urlSafe = FINISHED.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
    expect(inspectVoiceClip(urlSafe)).toEqual({ state: 'playable' });
  });
});

describe('what it refuses to accuse', () => {
  test('bytes that are not MPEG-4 at all come back unknown — the player decides', () => {
    // Another lane's container, a future codec, a test fixture: this module
    // knows one format and must not condemn what it cannot read.
    expect(inspectVoiceClip(b64([...'OggS'].map(c => c.charCodeAt(0)).concat(audio)))).toEqual({
      state: 'unknown',
    });
    expect(voiceClipPlayable('QUJD')).toBe(true); // 'ABC' — too small to judge
  });

  test('base64 that is not base64 is unknown, not damaged', () => {
    expect(inspectVoiceClip('!!!!!!!!!!!!')).toEqual({ state: 'unknown' });
  });
});

describe('what a camper reads', () => {
  test('no sentence carries a status code, and each ends in something to do', () => {
    const all = [
      recordingDamageCopy('empty'),
      recordingDamageCopy('unfinished'),
      recordingDamageCopy('truncated'),
      arrivalDamageCopy('empty'),
      arrivalDamageCopy('unfinished'),
      arrivalDamageCopy('truncated'),
    ];
    for (const line of all) {
      expect(line).not.toMatch(/status|0x|prepare|MediaPlayer|error/i);
      expect(line).toMatch(/hold the button|send it again/);
    }
  });

  test('the recorder speaks to the person holding the phone, the row to the reader', () => {
    // Two different people: one can re-record, the other can only ask.
    expect(recordingDamageCopy('unfinished')).toContain('hold the button');
    expect(arrivalDamageCopy('unfinished')).toContain('ask them to send it again');
  });
});

describe('base64ByteLength', () => {
  test('counts bytes through padded, unpadded and wrapped forms', () => {
    expect(base64ByteLength(b64([1, 2, 3]))).toBe(3);
    expect(base64ByteLength(b64([1, 2, 3, 4]))).toBe(4); // one '=' of padding
    expect(base64ByteLength(b64([1, 2, 3, 4, 5]))).toBe(5); // two
    expect(base64ByteLength(b64([1, 2, 3, 4]).replace(/[=]+$/, ''))).toBe(4);
    expect(base64ByteLength('')).toBe(0);
  });
});
