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
 */
class FieldAudioModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "FieldAudio"

  companion object {
    const val MAX_MS = 30_000
    const val DIR = "voice-notes"
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
      // an immediate-stop take is empty; resolveTake's size check covers it
    } finally {
      r.release()
    }
    if (path != null && File(path).length() > 0L) {
      completedTake = path to durationMs
    } else {
      path?.let { File(it).delete() }
    }
  }

  private fun resolveTake(file: File, durationMs: Long, promise: Promise?) {
    if (!file.exists() || file.length() == 0L) {
      file.delete()
      promise?.reject("empty", "nothing recorded — hold the button a moment longer")
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
      // A stop() within ~500ms of start throws — treat as an empty take.
    } finally {
      r.release()
    }
    val file = path?.let { File(it) }
    if (file == null) {
      promise?.reject("empty", "nothing recorded — hold the button a moment longer")
      return
    }
    resolveTake(file, durationMs, promise)
  }

  // ------------------------------------------------------------ play

  @ReactMethod
  fun play(b64: String, promise: Promise) {
    stopPlaybackInternal()
    val bytes = try {
      Base64.decode(b64, Base64.NO_WRAP)
    } catch (e: Exception) {
      promise.reject("payload", "clip is not base64")
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
      f.delete()
      stopPlaybackInternal()
      promise.reject("play", e.message ?: "could not play the clip")
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
