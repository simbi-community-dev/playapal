package com.playapal

/**
 * Big-endian u32 on the walkie wire (docs/WALKIE-LADDER.md §4): the pod
 * and sender hashes ride bytes 3-6 and 7-10 of every PW frame, on every
 * rung. One pair for the package — WalkieModule, WalkieAwareLink, and
 * WalkieBleLink each carried a byte-identical private copy until the
 * 2026-08-26 dedup pass. Top-level so every call site reads unchanged.
 */
internal fun writeU32(b: ByteArray, at: Int, v: Long) {
  b[at] = ((v shr 24) and 0xFF).toByte()
  b[at + 1] = ((v shr 16) and 0xFF).toByte()
  b[at + 2] = ((v shr 8) and 0xFF).toByte()
  b[at + 3] = (v and 0xFF).toByte()
}

internal fun readU32(b: ByteArray, at: Int): Long =
  ((b[at].toLong() and 0xFF) shl 24) or
    ((b[at + 1].toLong() and 0xFF) shl 16) or
    ((b[at + 2].toLong() and 0xFF) shl 8) or
    (b[at + 3].toLong() and 0xFF)
