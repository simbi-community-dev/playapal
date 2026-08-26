/**
 * Reading a QR out of a PHOTOGRAPH — the decode half of the in-app scanner
 * (owner, 2026-08-25: "should be a link/icon to open camera app to scan qr
 * codes, otherwise app has to be exited to scan manually").
 *
 * Every QR this app renders is meant to be scanned by the other phone's
 * ORDINARY camera app, and that stays true — it needs no permission and no
 * dependency, and it is what a person without Playa Pal uses. But the camper
 * holding this phone had no way to take a card WITHOUT leaving the app: home,
 * find Camera, point, tap the notification, come back. Four steps in the dust
 * with a person waiting.
 *
 * WHY A PHOTO AND NOT A LIVE SCANNER. A live scanner is a native camera
 * dependency (vision-camera and friends) added days before the burn, on a
 * tree whose iOS side is not yet build-verified. This path adds NO native
 * code at all: `react-native-image-picker` already ships, already holds the
 * CAMERA permission on both platforms (AddNoteSheet photographs art with it),
 * and hands back a base64 JPEG. The only new pieces are two pure-JS
 * libraries — `jpeg-js` decodes the frame, `jsqr` finds the code — so the
 * whole path is testable off-device, which is the half a device can prove.
 *
 * It costs one shutter press instead of a live viewfinder. It buys a scanner
 * that cannot break the native build.
 */

import { decode as decodeJpeg } from 'jpeg-js';
import jsQR from 'jsqr';

/**
 * Base64 input ceiling, in characters. A 1280 px camera JPEG is ~1.5 MB of
 * base64; 16 MB is a full-resolution phone photo with room to spare, and
 * anything past it is a bug upstream rather than a picture of a QR code.
 */
export const MAX_PHOTO_B64_CHARS = 16 * 1024 * 1024;

/**
 * Pixel budget handed to the code finder. The picker is asked for 1280 px
 * (~1 MP), but `maxWidth` is a REQUEST — an iOS representation that ignores
 * it would otherwise put a 12 MP frame through a pure-JS scan on a phone in
 * the dark. Above this the frame is sampled down by a whole factor first,
 * which a QR survives easily: at 1280 px across a screen-sized code, one
 * module is many pixels wide.
 */
export const MAX_SCAN_PIXELS = 2_400_000;

/** Same ceilings for the JPEG decoder itself, so a malformed header cannot
 * ask for a gigabyte before we ever look at the pixels. */
const MAX_JPEG_MP = 16;
const MAX_JPEG_MB = 256;

/**
 * Base64 → bytes, tolerant of BOTH alphabets and of padding/whitespace.
 *
 * image-picker hands over standard base64 (`+/`), and this module is also
 * the natural home for a hand-pasted payload, which may be url-safe
 * (`-_`) — accepting both costs two table entries and removes a whole class
 * of "it works on Android" report.
 */
export function base64ToBytes(b64: string): Uint8Array | null {
  if (b64.length > MAX_PHOTO_B64_CHARS) {
    return null;
  }
  const out = new Uint8Array(Math.ceil((b64.length * 3) / 4));
  let n = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i += 1) {
    const c = b64.charCodeAt(i);
    let v: number;
    if (c >= 65 && c <= 90) {
      v = c - 65; // A-Z
    } else if (c >= 97 && c <= 122) {
      v = c - 71; // a-z
    } else if (c >= 48 && c <= 57) {
      v = c + 4; // 0-9
    } else if (c === 43 || c === 45) {
      v = 62; // + or -
    } else if (c === 47 || c === 95) {
      v = 63; // / or _
    } else if (c === 61 || c === 32 || c === 10 || c === 13 || c === 9) {
      continue; // padding and whitespace carry no bits
    } else {
      return null;
    }
    // eslint-disable-next-line no-bitwise -- base64 IS bit packing
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      // eslint-disable-next-line no-bitwise -- base64 IS bit packing
      out[n] = (buf >> bits) & 0xff;
      n += 1;
    }
  }
  return out.subarray(0, n);
}

/** One RGBA frame, in the shape jsQR wants. */
export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Whole-factor nearest-neighbour downsample to fit the pixel budget.
 *
 * Nearest-neighbour rather than an average ON PURPOSE: averaging softens the
 * black/white edge a QR binariser keys on, and the smallest feature here is
 * a module many pixels wide, never a single pixel. Factor 1 returns the frame
 * untouched, so the common case allocates nothing.
 */
export function fitToScanBudget(frame: Frame, budget = MAX_SCAN_PIXELS): Frame {
  const pixels = frame.width * frame.height;
  if (pixels <= budget || budget <= 0) {
    return frame;
  }
  const factor = Math.ceil(Math.sqrt(pixels / budget));
  const w = Math.floor(frame.width / factor);
  const h = Math.floor(frame.height / factor);
  if (w < 1 || h < 1) {
    return frame;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcRow = y * factor * frame.width;
    for (let x = 0; x < w; x += 1) {
      const s = (srcRow + x * factor) * 4;
      const d = (y * w + x) * 4;
      out[d] = frame.data[s];
      out[d + 1] = frame.data[s + 1];
      out[d + 2] = frame.data[s + 2];
      out[d + 3] = frame.data[s + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/** An RGBA frame → the text of the first QR in it, or null when there is none. */
export function decodeQrFromFrame(frame: Frame): string | null {
  const fitted = fitToScanBudget(frame);
  const found = jsQR(fitted.data, fitted.width, fitted.height);
  return found ? found.data : null;
}

/**
 * A camera JPEG (base64, as image-picker returns it) → the QR's text.
 *
 * Returns null for every failure a camper can actually cause — a blurred
 * frame, a photo of a table, a truncated payload — because the caller says
 * one honest sentence for all of them and offers another go. A damaged JPEG
 * makes the decoder throw, and that is caught here for the same reason.
 */
export function decodeQrFromJpegBase64(b64: string): string | null {
  const bytes = base64ToBytes(b64.replace(/\s+/g, ''));
  if (!bytes || bytes.length === 0) {
    return null;
  }
  let raw: { width: number; height: number; data: Uint8Array };
  try {
    // useTArray is LOAD-BEARING, not a preference: without it jpeg-js
    // allocates a node Buffer, which does not exist under Hermes — the
    // library's own error message says so.
    raw = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_JPEG_MP,
      maxMemoryUsageInMB: MAX_JPEG_MB,
    });
  } catch {
    return null;
  }
  return decodeQrFromFrame({
    data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length),
    width: raw.width,
    height: raw.height,
  });
}
