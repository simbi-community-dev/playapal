package com.playapal

/**
 * IMA ADPCM, the rung-3 codec (docs/WALKIE-LADDER.md §6, id 0x5): 4 bits
 * per sample, ~4:1 over PCM16, zero dependencies, symmetric ~30-line
 * encode/decode. At 8 kHz that is 4 KB/s of payload — inside the measured
 * 10-30 KB/s GATT budget with most of the radio left for the answering
 * machine, which is a peer of live talk and must not be starved (§2a/§6).
 *
 * The doc's table names Opus @ 6 kbps and Codec2 for this rung; both are
 * native codec DEPENDENCIES this tree does not carry, and the ladder's law
 * is that the rung changes the codec and the socket, never the frame — so
 * a self-contained codec that ships now beats a better one that does not.
 * Intelligible-and-choppy beats silent; the codec byte exists precisely so
 * a later build can add 0x3/0x4 without touching the frame.
 *
 * FRAME PAYLOAD LAYOUT (codec 0x5): predictor s16 BE + step index u8 +
 * reserved u8, then packed 4-bit codes, low nibble first. The 4-byte state
 * header makes every frame SELF-CONTAINED: a lost frame costs its own
 * 60 ms and nothing after it — the walkie's drop-stale-never-retransmit
 * rule needs decode state that never spans frames.
 */
object Adpcm {
  const val STATE_BYTES = 4

  private val STEP_TABLE = intArrayOf(
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
    598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
    2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
    18500, 20350, 22385, 24623, 27086, 29794, 32767,
  )
  private val INDEX_TABLE = intArrayOf(-1, -1, -1, -1, 2, 4, 6, 8)

  fun encode(samples: ShortArray): ByteArray {
    val out = ByteArray(STATE_BYTES + (samples.size + 1) / 2)
    if (samples.isEmpty()) {
      return out
    }
    // Seeding the predictor with the first sample makes the first code a
    // zero-diff — cheaper than letting the ramp from 0 spend the frame's
    // opening milliseconds climbing to the signal.
    var predictor = samples[0].toInt()
    var index = 0
    out[0] = ((predictor shr 8) and 0xFF).toByte()
    out[1] = (predictor and 0xFF).toByte()
    out[2] = index.toByte()
    out[3] = 0
    var pos = STATE_BYTES
    var low = true
    for (s in samples) {
      var diff = s - predictor
      var code = 0
      if (diff < 0) {
        code = 8
        diff = -diff
      }
      var step = STEP_TABLE[index]
      // vpdiff accumulates the same halvings decode() replays, so the two
      // predictors track bit-for-bit — the only way a stateless-per-frame
      // codec stays clean.
      var vpdiff = step shr 3
      if (diff >= step) {
        code = code or 4
        diff -= step
        vpdiff += step
      }
      step = step shr 1
      if (diff >= step) {
        code = code or 2
        diff -= step
        vpdiff += step
      }
      step = step shr 1
      if (diff >= step) {
        code = code or 1
        vpdiff += step
      }
      predictor += if ((code and 8) != 0) -vpdiff else vpdiff
      predictor = predictor.coerceIn(-32768, 32767)
      index = (index + INDEX_TABLE[code and 7]).coerceIn(0, STEP_TABLE.size - 1)
      if (low) {
        out[pos] = (code and 0x0F).toByte()
      } else {
        out[pos] = (out[pos].toInt() or ((code and 0x0F) shl 4)).toByte()
        pos++
      }
      low = !low
    }
    return out
  }

  /** Decode `len` payload bytes at `off`. A payload too short to carry
   * state decodes to silence — a torn frame must never throw on the
   * receive path. */
  fun decode(bytes: ByteArray, off: Int, len: Int): ShortArray {
    if (len <= STATE_BYTES) {
      return ShortArray(0)
    }
    var predictor = (((bytes[off].toInt() and 0xFF) shl 8) or
      (bytes[off + 1].toInt() and 0xFF)).toShort().toInt()
    var index = (bytes[off + 2].toInt() and 0xFF).coerceIn(0, STEP_TABLE.size - 1)
    val n = (len - STATE_BYTES) * 2
    val out = ShortArray(n)
    for (i in 0 until n) {
      val b = bytes[off + STATE_BYTES + (i shr 1)].toInt()
      val code = if ((i and 1) == 0) b and 0x0F else (b shr 4) and 0x0F
      val step = STEP_TABLE[index]
      var vpdiff = step shr 3
      if ((code and 4) != 0) {
        vpdiff += step
      }
      if ((code and 2) != 0) {
        vpdiff += step shr 1
      }
      if ((code and 1) != 0) {
        vpdiff += step shr 2
      }
      predictor += if ((code and 8) != 0) -vpdiff else vpdiff
      predictor = predictor.coerceIn(-32768, 32767)
      index = (index + INDEX_TABLE[code and 7]).coerceIn(0, STEP_TABLE.size - 1)
      out[i] = predictor.toShort()
    }
    return out
  }
}
