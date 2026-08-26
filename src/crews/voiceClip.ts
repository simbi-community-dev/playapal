/**
 * voiceClip — can these bytes actually be PLAYED, asked of the base64 body
 * of a 'voice' record before anyone taps it (docs/CREW-DESIGN.md §6b).
 *
 * WHAT WENT WRONG IN THE FIELD (owner report, 2026-08-25): a voice note
 * arrived, showed as an ordinary "▶ Voice note · 3s" row, and playing it put
 * `prepare failed status=0x1` on screen — Android MediaPlayer's way of saying
 * "these bytes are not a media file I can open". Both halves of that are
 * bugs: the bytes should never have been minted, and a hex status is not
 * something a camper in the dust can do anything with.
 *
 * THE SHAPE OF THE DAMAGE. Both recorders write MPEG-4 (AAC in an .m4a
 * container). MediaRecorder/AVAudioRecorder stream the audio into an `mdat`
 * box as it is captured and write the INDEX — the `moov` box, which says
 * where every frame is — only at stop(). A take whose stop() failed (a tap
 * so short the encoder never got a frame, a recorder fault, a process death
 * mid-take) therefore leaves a file that is NOT empty: it has an `ftyp`
 * header and a lump of audio, so every length > 0 check passes it, and it
 * travels the mesh looking exactly like a real message. It cannot be played
 * by anything, ever, because nothing in it says where the audio is.
 *
 * So this file reads the CONTAINER, not the audio: walk the top-level box
 * list and answer whether an index is present and whether the file is whole.
 * It is deliberately a structural check with no codec knowledge — it cannot
 * tell you the audio sounds right, only that a player will find something to
 * open.
 *
 * CONSERVATIVE BY CONSTRUCTION. A false 'damaged' is worse than a false
 * 'playable': one loses a real message someone left, the other costs a tap
 * and an honest native error. So `damaged` is returned only when the bytes
 * POSITIVELY prove it — an MPEG-4 file with no index, or one that stops in
 * the middle of a box it declared. Anything this file cannot recognise (a
 * future codec, another platform's container, a test fixture) comes back
 * `unknown` and is treated as playable everywhere: the player decides.
 *
 * THE PHOTO LANE ALREADY DOES THIS (src/camp/campNotes.ts isJpegBase64: SOI
 * prefix plus the EOI trailer read out of the base64 tail, because truncation
 * is the realistic wire corruption). This is the audio sibling of that check
 * — same posture, and MPEG-4's box list is what plays the role JPEG's markers
 * play there.
 *
 * NO DECODE. Bodies run to 256 KiB of base64 and rows re-render on every
 * store revision, so decoding the whole payload to read four box headers
 * would be the expensive way to ask a cheap question. byteAt() decodes the
 * single 4-char base64 group a byte falls in, so a walk costs a handful of
 * groups per box and one jump over the (huge) mdat.
 */

/** Standard alphabet plus the URL-safe pair, so a body that took a
 * URL-safe path somewhere still reads rather than scoring as damage. */
const B64_VALUES = (() => {
  const t = new Int16Array(128).fill(-1);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) {
    t[alphabet.charCodeAt(i)] = i;
  }
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Base64 with the line breaks some encoders add. Both native recorders use
 * NO_WRAP, so this is the rare path — checked with indexOf (native, one
 * pass) rather than paid for on every body with a regex replace. */
const unwrapped = (b64: string): string =>
  b64.indexOf('\n') < 0 && b64.indexOf('\r') < 0 && b64.indexOf(' ') < 0
    ? b64
    : b64.replace(/[\r\n\t ]+/g, '');

/** How many BYTES this base64 stands for. Padding-tolerant in both
 * directions: canonical '=' padding and the unpadded form. */
export function base64ByteLength(b64: string): number {
  return unwrappedByteLength(unwrapped(b64));
}

/** The math half, for callers that already hold the unwrapped string —
 * inspectVoiceClip re-derived the unwrap here on every call, which was
 * three more full indexOf scans per row per render. */
function unwrappedByteLength(s: string): number {
  const groups = Math.floor(s.length / 4);
  const rem = s.length % 4;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  // A 2- or 3-char tail is an unpadded final group: 1 or 2 bytes.
  const tail = rem === 2 ? 1 : rem === 3 ? 2 : 0;
  return Math.max(0, groups * 3 - pad + tail);
}

/**
 * The i-th decoded byte, decoding only the group it lives in; -1 when the
 * group holds a character that is not base64 at all (garbled body).
 */
function byteAt(s: string, i: number): number {
  const group = (i / 3) | 0;
  const at = group * 4;
  let triple = 0;
  for (let k = 0; k < 4; k++) {
    const ch = at + k < s.length ? s.charCodeAt(at + k) : 61 /* '=' */;
    // '=' and a short final group both mean "no bits here" — zero, which is
    // safe because base64ByteLength already bounds what the caller may read.
    const v = ch === 61 ? 0 : ch < 128 ? B64_VALUES[ch] : -1;
    if (v < 0) {
      return -1;
    }
    triple = (triple << 6) | v;
  }
  return (triple >>> (16 - 8 * (i - group * 3))) & 0xff;
}

/** What a voice body is, as far as a container walk can tell. */
export type VoiceClipState = 'playable' | 'damaged' | 'unknown';

/** Why a body is damaged — each reason is a different sentence to a human,
 * so the copy helpers below (and the two surfaces) can say the true one. */
export type VoiceClipDamage = 'empty' | 'unfinished' | 'truncated';

export type VoiceClipVerdict =
  | { state: 'playable' | 'unknown' }
  | { state: 'damaged'; damage: VoiceClipDamage };

const PLAYABLE: VoiceClipVerdict = { state: 'playable' };
const UNKNOWN: VoiceClipVerdict = { state: 'unknown' };
const damaged = (damage: VoiceClipDamage): VoiceClipVerdict => ({
  state: 'damaged',
  damage,
});

/** A malformed or hostile file must not walk forever; a real voice note has
 * four or five top-level boxes. */
const MAX_BOXES = 64;

/** Verdicts are pure functions of the body, and PodMessages asks per ROW
 * per RENDER (and again on tap): uncached, a thread of voice notes
 * re-walked megabytes of base64 on every store revision. Keyed by the
 * body string itself — the engines cache a string's hash after its first
 * lookup, and the store already holds these exact string references, so
 * the cache adds no copies. Bounded so a long session cannot hoard
 * bodies the store has let go of. */
const VERDICT_CACHE_MAX = 64;
const verdictCache = new Map<string, VoiceClipVerdict>();

/**
 * Read the container. `ftyp` first identifies MPEG-4; a top-level `moov` is
 * the index a player needs; a box whose declared size runs past the end of
 * the bytes means the file stops mid-transfer.
 */
export function inspectVoiceClip(base64: string): VoiceClipVerdict {
  const hit = verdictCache.get(base64);
  if (hit) {
    return hit;
  }
  const verdict = walkClip(base64);
  if (verdictCache.size >= VERDICT_CACHE_MAX) {
    // Insertion order is age; the oldest entry is the least likely to
    // still be on screen.
    const oldest = verdictCache.keys().next().value;
    if (oldest !== undefined) {
      verdictCache.delete(oldest);
    }
  }
  verdictCache.set(base64, verdict);
  return verdict;
}

function walkClip(base64: string): VoiceClipVerdict {
  const s = unwrapped(base64);
  if (s.length === 0) {
    return damaged('empty');
  }
  const total = unwrappedByteLength(s);
  if (total === 0) {
    return damaged('empty');
  }
  if (total < 8) {
    // Too small to hold even one box header — nothing to identify, and too
    // small to accuse. The player gets the last word.
    return UNKNOWN;
  }
  const u32 = (off: number): number => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const b = byteAt(s, off + k);
      if (b < 0) {
        return -1;
      }
      v = v * 256 + b;
    }
    return v;
  };
  const type = (off: number): string => {
    let out = '';
    for (let k = 0; k < 4; k++) {
      const b = byteAt(s, off + k);
      if (b < 0) {
        return '';
      }
      out += String.fromCharCode(b);
    }
    return out;
  };

  let off = 0;
  let sawMoov = false;
  for (let n = 0; n < MAX_BOXES && off + 8 <= total; n++) {
    const size = u32(off);
    const kind = type(off + 4);
    if (size < 0 || kind === '') {
      return UNKNOWN; // not base64 all the way through — not our accusation
    }
    if (off === 0 && kind !== 'ftyp') {
      // Not the container either recorder writes. Some other lane's audio,
      // or a fixture: this file has nothing true to say about it.
      return UNKNOWN;
    }
    if (kind === 'moov') {
      sawMoov = true;
    }
    if (size === 0) {
      // "To the end of the file" — legal, and exactly what an mdat left
      // unfinalized looks like. Nothing can follow it, so the walk is over
      // and the index (if any) has already been seen.
      break;
    }
    if (size === 1) {
      // 64-bit size follows the header. Only the low half can matter here:
      // a voice note is 256 KiB, so a high half at all means nonsense.
      const hi = u32(off + 8);
      const lo = u32(off + 12);
      if (hi !== 0 || lo < 16) {
        return damaged('truncated');
      }
      if (off + lo > total) {
        return damaged('truncated');
      }
      off += lo;
      continue;
    }
    if (size < 8) {
      return damaged('truncated'); // a box smaller than its own header
    }
    if (off + size > total) {
      // The file ends inside a box it promised — cut short in transit, or
      // the writer died holding the pen.
      return damaged('truncated');
    }
    off += size;
  }
  if (sawMoov) {
    return PLAYABLE;
  }
  // ftyp present (proved at off 0) and no index anywhere: this is the take
  // whose stop() never finished. Nothing will ever play it.
  return damaged('unfinished');
}

/** True when a row should be OFFERED for playback — everything except the
 * bodies we can prove are dead. */
export const voiceClipPlayable = (base64: string): boolean =>
  inspectVoiceClip(base64).state !== 'damaged';

/**
 * What the RECORDER says to the person who just held the button. The take
 * is still in their hands, so every sentence ends in something to do.
 */
export function recordingDamageCopy(damage: VoiceClipDamage): string {
  switch (damage) {
    case 'empty':
      return 'Nothing recorded — hold the button a moment longer.';
    case 'truncated':
      return "That take didn't finish writing — hold the button and try again.";
    default:
      // The same sentence the native recorder rejects with when it catches
      // this itself (FieldAudioModule.kt / FieldAudio.swift): whichever half
      // notices first, the camper reads one message.
      return "That take didn't finish recording — hold the button a moment longer and try again.";
  }
}

/**
 * What a RECEIVED row says. The bytes are already here and re-recording is
 * not this phone's to do, so the action is the honest social one: ask the
 * sender again. Never a status code — 'prepare failed status=0x1' told the
 * owner nothing he could act on.
 */
export function arrivalDamageCopy(damage: VoiceClipDamage): string {
  switch (damage) {
    case 'truncated':
      return "Only part of this voice note made it across — ask them to send it again.";
    case 'empty':
      return 'This voice note arrived with no audio in it — ask them to send it again.';
    default:
      return "This voice note never finished recording on their phone — ask them to send it again.";
  }
}

/** The short label a damaged row wears instead of "▶ Voice note · 5s", so a
 * note that cannot play never looks like one that can. */
export const DAMAGED_VOICE_LABEL = "Voice note · won't play";
