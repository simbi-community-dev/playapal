package com.playapal

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

/**
 * FieldAudio — voice notes for the answering machine (docs/CREW-DESIGN.md
 * §6b): hold-to-record a short clip, get it back as base64 small enough to
 * gossip over the pod's BLE sync pipe, play one on arrival.
 *
 * SIZE IS THE DESIGN CONSTRAINT. A voice note travels as a crew message
 * (256 KiB body cap) over framed GATT reads, so the recorder is tuned for
 * tiny-but-intelligible speech: AAC mono, 16 kHz, 24 kbps — about 3 KB per
 * second, so the 30-second hard stop lands near 90 KB, well under the cap
 * with base64 overhead. Not music quality, exactly walkie quality.
 *
 * Recording asks nothing itself: RECORD_AUDIO must already be granted or
 * start rejects with code 'permission' and the JS side asks in context with
 * payoff copy — the same discipline as camera, location and Bluetooth.
 *
 * Files land in cacheDir/voice-notes and are DELETED as soon as the base64
 * is handed to JS (the message store in SQLite is the owner of the bytes;
 * a cache file would be a second, unmanaged copy).
 *
 * A TAKE WITHOUT AN INDEX NEVER LEAVES THIS MODULE (hasIndex, below). That is
 * the cure for the field bug where a note "delivered" and then met "prepare
 * failed status=0x1" on the other phone: an unfinalised MPEG-4 is non-empty,
 * cheap to send and impossible to play, so size is the wrong gate.
 */
class FieldAudioModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "FieldAudio"

  companion object {
    const val MAX_MS = 30_000
    const val DIR = "voice-notes"
    /** A malformed file must not walk forever; a real take has a handful of
     * top-level boxes (see hasIndex). */
    const val MAX_BOXES = 64
  }

  private val main = Handler(Looper.getMainLooper())
  private var recorder: MediaRecorder? = null
  private var recordingPath: String? = null
  private var recordStartedAt = 0L
  private var hardStop: Runnable? = null
  /** A take the 30 s hard stop finished while the finger was still down:
   * kept (path, durationMs) so the eventual stopRecording RESOLVES it —
   * discarding a maximum-length message punished exactly the person with
   * the most to say (composed review, Aug 24; iOS always kept it). */
  private var completedTake: Pair<String, Long>? = null
  private var player: MediaPlayer? = null
  private var playerFile: File? = null

  private fun hasMic(): Boolean =
    ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  // ------------------------------------------------------------ record

  @ReactMethod
  fun startRecording(promise: Promise) {
    if (!hasMic()) {
      promise.reject("permission", Manifest.permission.RECORD_AUDIO)
      return
    }
    if (recorder != null) {
      promise.reject("busy", "already recording")
      return
    }
    val dir = File(ctx.cacheDir, DIR)
    dir.mkdirs()
    val out = File(dir, "${UUID.randomUUID()}.m4a")
    try {
      val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else {
        @Suppress("DEPRECATION")
        MediaRecorder()
      }
      r.setAudioSource(MediaRecorder.AudioSource.MIC)
      r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioChannels(1)
      r.setAudioSamplingRate(16_000)
      r.setAudioEncodingBitRate(24_000)
      r.setMaxDuration(MAX_MS)
      r.setOutputFile(out.absolutePath)
      r.prepare()
      r.start()
      recorder = r
      recordingPath = out.absolutePath
      recordStartedAt = System.currentTimeMillis()
      completedTake?.let { File(it.first).delete() }
      completedTake = null
      // Belt over the recorder's own maxDuration: stop from OUR side, but
      // KEEP the take — the finger is still down and its stopRecording is
      // still coming.
      val stopper = Runnable { hardStopKeepTake() }
      hardStop = stopper
      main.postDelayed(stopper, MAX_MS.toLong() + 500L)
      promise.resolve(null)
    } catch (e: Exception) {
      out.delete()
      recorder = null
      recordingPath = null
      promise.reject("record", e.message ?: "could not start recording")
    }
  }

  @ReactMethod
  fun stopRecording(promise: Promise) {
    val kept = completedTake
    if (recorder == null && kept != null) {
      // The hard stop already finished this take; hand it over now.
      completedTake = null
      resolveTake(File(kept.first), kept.second, promise)
      return
    }
    finishRecording(promise)
  }

  /** The 30 s ceiling: finalize the file but keep it for the pending
   * stopRecording (see completedTake). */
  private fun hardStopKeepTake() {
    val r = recorder ?: return
    recorder = null
    hardStop = null
    val path = recordingPath
    recordingPath = null
    val durationMs = System.currentTimeMillis() - recordStartedAt
    try {
      r.stop()
    } catch (_: Exception) {
      // Not evidence either way: at the 30 s ceiling the framework may have
      // stopped the recorder already, leaving a perfectly finalised file that
      // our stop() then throws over. resolveTake reads the CONTAINER (hasIndex)
      // rather than trusting this exception or the file's size.
    } finally {
      r.release()
    }
    if (path != null && File(path).length() > 0L) {
      completedTake = path to durationMs
    } else {
      path?.let { File(it).delete() }
    }
  }

  /**
   * Does this take carry the INDEX a player needs? The whole answer to the
   * field bug (owner, 2026-08-25): "voice note delivered but wont play
   * 'prepare failed status=0x1'".
   *
   * MediaRecorder streams audio into the `mdat` box as it captures and writes
   * the `moov` box — the table saying where every frame is — only at stop().
   * A take whose stop() failed (a tap too short for the encoder to produce a
   * frame, a recorder fault, the process dying with the finger down) leaves a
   * file that is NOT empty: ftyp header, a lump of audio, and no index. It
   * passes every length > 0 check, base64s to a plausible ~90 KB body, gossips
   * across camp costing every relay its bytes, and then no player on earth can
   * open it — which is precisely the hex status the owner met.
   *
   * So the size check is not the gate; the container is. This also keeps the
   * MAXIMUM-length take that the 30 s ceiling finalises for us (hardStopKeep-
   * Take): our own stop() may well throw there because the framework already
   * stopped, and the file is perfectly good — an exception is not evidence,
   * the moov box is.
   */
  private fun hasIndex(file: File): Boolean {
    if (file.length() < 8L) {
      return false
    }
    return try {
      RandomAccessFile(file, "r").use { raf ->
        val total = raf.length()
        val header = ByteArray(8)
        var off = 0L
        var boxes = 0
        while (off + 8 <= total && boxes < MAX_BOXES) {
          raf.seek(off)
          raf.readFully(header)
          // 0xffL, not 0xff: Kotlin has no Long.and(Int), and a sign-extended
          // byte would turn any high-bit size into a negative jump.
          var size = 0L
          for (i in 0..3) {
            size = (size shl 8) or (header[i].toLong() and 0xffL)
          }
          val type = String(header, 4, 4, Charsets.US_ASCII)
          if (type == "moov") {
            return@use true
          }
          if (size == 1L) {
            // 64-bit size follows the header; a voice note never needs the
            // high half, so anything set there is nonsense.
            raf.seek(off + 8)
            val big = ByteArray(8)
            raf.readFully(big)
            size = 0L
            for (i in 0..7) {
              size = (size shl 8) or (big[i].toLong() and 0xffL)
            }
          }
          // size 0 = "runs to the end of the file", which is exactly what an
          // unfinalised mdat looks like. Nothing can follow it.
          if (size < 8L) {
            return@use false
          }
          off += size
          boxes++
        }
        false
      }
    } catch (_: Exception) {
      false // unreadable is not playable
    }
  }

  private fun resolveTake(file: File, durationMs: Long, promise: Promise?) {
    if (!file.exists() || file.length() == 0L) {
      file.delete()
      promise?.reject("empty", "Nothing recorded — hold the button a moment longer.")
      return
    }
    if (!hasIndex(file)) {
      // Bytes without an index. Refusing here is what keeps a dead voice note
      // out of the mesh entirely — the JS side re-checks the same thing
      // (src/crews/voiceClip.ts) for takes that reach it another way.
      file.delete()
      promise?.reject(
        "damaged",
        "That take didn't finish recording — hold the button a moment longer and try again.",
      )
      return
    }
    val bytes = file.readBytes()
    file.delete() // SQLite owns the bytes from here; no orphan cache copies
    val m = Arguments.createMap()
    m.putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    m.putString("mime", "audio/mp4")
    m.putInt("bytes", bytes.size)
    m.putInt("durationMs", durationMs.toInt())
    promise?.resolve(m)
  }

  private fun finishRecording(promise: Promise?) {
    val r = recorder ?: run {
      promise?.reject("idle", "not recording")
      return
    }
    hardStop?.let { main.removeCallbacks(it) }
    hardStop = null
    recorder = null
    val path = recordingPath
    recordingPath = null
    val durationMs = System.currentTimeMillis() - recordStartedAt
    try {
      r.stop()
    } catch (_: Exception) {
      // A stop() within ~500 ms of start throws, and the half-written file it
      // leaves behind is NOT empty — ftyp plus a lump of audio, no index. It
      // used to sail through the size check below and become an unplayable
      // voice note on someone else's phone. resolveTake now reads the
      // container, so this take dies here with copy the recorder can act on.
    } finally {
      r.release()
    }
    val file = path?.let { File(it) }
    if (file == null) {
      promise?.reject("empty", "Nothing recorded — hold the button a moment longer.")
      return
    }
    resolveTake(file, durationMs, promise)
  }

  // ------------------------------------------------------------ play

  /**
   * NOTHING FROM THE MEDIA STACK REACHES A CAMPER'S SCREEN. MediaPlayer's own
   * words for a bad file are "Prepare failed.: status=0x1" — which the owner
   * met in the dust and could do exactly nothing with. These bytes arrived
   * over a gossip mesh from someone else's phone, so the only true action is
   * the social one: ask them again. The technical detail still rides along as
   * the rejection's cause, for a bug report, never as the sentence shown.
   */
  @ReactMethod
  fun play(b64: String, promise: Promise) {
    stopPlaybackInternal()
    val bytes = try {
      Base64.decode(b64, Base64.NO_WRAP)
    } catch (e: Exception) {
      promise.reject(
        "damaged",
        "That voice note arrived scrambled — ask them to send it again.",
        e,
      )
      return
    }
    if (bytes.isEmpty()) {
      promise.reject(
        "damaged",
        "This voice note arrived with no audio in it — ask them to send it again.",
      )
      return
    }
    val dir = File(ctx.cacheDir, DIR)
    dir.mkdirs()
    val f = File(dir, "play-${UUID.randomUUID()}.m4a")
    try {
      f.writeBytes(bytes)
      val p = MediaPlayer()
      p.setDataSource(f.absolutePath)
      p.setOnCompletionListener {
        stopPlaybackInternal()
      }
      p.prepare()
      p.start()
      player = p
      playerFile = f
      promise.resolve(p.duration)
    } catch (e: Exception) {
      val indexed = hasIndex(f)
      f.delete()
      stopPlaybackInternal()
      promise.reject(
        "damaged",
        if (indexed) {
          // A whole container the device still could not open — a codec this
          // phone lacks, or damage inside the audio itself.
          "This phone couldn't play that voice note — ask them to send it again."
        } else {
          "This voice note never finished recording on their phone — ask them to send it again."
        },
        e,
      )
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    stopPlaybackInternal()
    promise.resolve(null)
  }

  private fun stopPlaybackInternal() {
    try {
      player?.stop()
      player?.release()
    } catch (_: Exception) {
      // released twice / never started — the goal state is reached
    }
    player = null
    playerFile?.delete()
    playerFile = null
  }

  override fun invalidate() {
    hardStop?.let { main.removeCallbacks(it) }
    try {
      recorder?.release()
    } catch (_: Exception) {}
    recorder = null
    recordingPath?.let { File(it).delete() }
    recordingPath = null
    stopPlaybackInternal()
    super.invalidate()
  }
}
