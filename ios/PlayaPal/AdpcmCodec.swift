import Foundation

/**
 IMA ADPCM, the rung-3 codec (docs/WALKIE-LADDER.md §6, id 0x5) — the iOS
 half, a BIT-COMPATIBLE port of Adpcm.kt: the same step/index tables, the
 same predictor seeding and vpdiff halvings, the same low-nibble-first
 packing, the same clamps. The two implementations must track bit-for-bit
 or a Pixel's frame decodes on an iPhone as rising sand — the walkieLadder
 suite pins the tables and structure in BOTH files, and the only full proof
 is the device pair itself (no build host here runs a Pixel's encoder
 against this decoder).

 FRAME PAYLOAD LAYOUT (codec 0x5): predictor s16 BE + step index u8 +
 reserved u8, then packed 4-bit codes, low nibble first. The 4-byte state
 header makes every frame SELF-CONTAINED: a lost frame costs its own 60 ms
 and nothing after it — the walkie's drop-stale-never-retransmit rule needs
 decode state that never spans frames.
 */
enum AdpcmCodec {
  static let stateBytes = 4

  private static let stepTable: [Int] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
    598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
    2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
    18500, 20350, 22385, 24623, 27086, 29794, 32767,
  ]
  private static let indexTable: [Int] = [-1, -1, -1, -1, 2, 4, 6, 8]

  static func encode(_ samples: [Int16]) -> Data {
    var out = Data(count: stateBytes + (samples.count + 1) / 2)
    if samples.isEmpty {
      return out
    }
    // Seeding the predictor with the first sample makes the first code a
    // zero-diff — cheaper than letting the ramp from 0 spend the frame's
    // opening milliseconds climbing to the signal. (Adpcm.kt, verbatim.)
    var predictor = Int(samples[0])
    let index0 = 0
    var index = index0
    out[0] = UInt8((predictor >> 8) & 0xFF)
    out[1] = UInt8(predictor & 0xFF)
    out[2] = UInt8(index0)
    out[3] = 0
    var pos = stateBytes
    var low = true
    for s in samples {
      var diff = Int(s) - predictor
      var code = 0
      if diff < 0 {
        code = 8
        diff = -diff
      }
      var step = stepTable[index]
      // vpdiff accumulates the same halvings decode() replays, so the two
      // predictors track bit-for-bit — the only way a stateless-per-frame
      // codec stays clean.
      var vpdiff = step >> 3
      if diff >= step {
        code |= 4
        diff -= step
        vpdiff += step
      }
      step >>= 1
      if diff >= step {
        code |= 2
        diff -= step
        vpdiff += step
      }
      step >>= 1
      if diff >= step {
        code |= 1
        vpdiff += step
      }
      predictor += (code & 8) != 0 ? -vpdiff : vpdiff
      predictor = min(max(predictor, -32768), 32767)
      index = min(max(index + indexTable[code & 7], 0), stepTable.count - 1)
      if low {
        out[pos] = UInt8(code & 0x0F)
      } else {
        out[pos] = out[pos] | UInt8((code & 0x0F) << 4)
        pos += 1
      }
      low = !low
    }
    return out
  }

  /// Decode `len` payload bytes at `off`. A payload too short to carry
  /// state decodes to silence — a torn frame must never throw on the
  /// receive path.
  static func decode(_ bytes: [UInt8], at off: Int, count len: Int) -> [Int16] {
    if len <= stateBytes || off < 0 || off + len > bytes.count {
      return []
    }
    var predictor = Int(Int16(bitPattern: (UInt16(bytes[off]) << 8) | UInt16(bytes[off + 1])))
    var index = min(max(Int(bytes[off + 2]), 0), stepTable.count - 1)
    let n = (len - stateBytes) * 2
    var out = [Int16](repeating: 0, count: n)
    for i in 0 ..< n {
      let b = Int(bytes[off + stateBytes + (i >> 1)])
      let code = (i & 1) == 0 ? b & 0x0F : (b >> 4) & 0x0F
      let step = stepTable[index]
      var vpdiff = step >> 3
      if (code & 4) != 0 {
        vpdiff += step
      }
      if (code & 2) != 0 {
        vpdiff += step >> 1
      }
      if (code & 1) != 0 {
        vpdiff += step >> 2
      }
      predictor += (code & 8) != 0 ? -vpdiff : vpdiff
      predictor = min(max(predictor, -32768), 32767)
      index = min(max(index + indexTable[code & 7], 0), stepTable.count - 1)
      out[i] = Int16(predictor)
    }
    return out
  }
}
