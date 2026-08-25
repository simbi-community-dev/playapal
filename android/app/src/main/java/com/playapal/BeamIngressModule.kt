package com.playapal

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Native half of the beam RECEIVE path (docs/BEAM-INGRESS-CONTRACT.md §2-3).
 *
 * A .playapal file opened from Files / Downloads / Quick Share (ACTION_VIEW)
 * or shared to us (ACTION_SEND) arrives as a content:// URI with a
 * temporary read grant. This module copies the bytes into an app-private
 * cache file while the grant is live, then hands JS {ingressId, localPath,
 * displayName, mime, bytes, source} — nothing more. It never parses JSON and
 * owns no camp semantics: JS sniffs, verifies and installs through the same
 * seam the picker uses.
 *
 * The copy runs on a worker thread (a cloud-backed provider — Drive, a mail
 * attachment, a Quick Share item still landing — can block openInputStream
 * for seconds, which on the UI thread inside onCreate is an ANR in front of
 * the camper at the exact moment beaming is proving itself). The URI grant
 * outlives consume() because the activity keeps the grant, so the worker is
 * legal. The file is written as <id>.playapal.part and renamed only when
 * complete, so a half-copy is never mistaken for a beam.
 *
 * Delivery: the finished item is QUEUED and, if JS is alive, an event wakes
 * it; JS drains on mount and on every event. The queue is RAM-only, so it is
 * an optimisation, not the source of truth: the FILE is. Its name stem IS
 * the ingressId, and JS sweeps cacheDir/beam-ingress on mount for anything
 * a process death stranded between copy and drain (xrev pug-opus, ea1ba6e).
 */
class BeamIngressModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "BeamIngress"

  @ReactMethod
  fun drain(promise: Promise) {
    val items = BeamIngressQueue.drain()
    val arr = Arguments.createArray()
    for (m in items) {
      arr.pushMap(m)
    }
    promise.resolve(arr)
  }

  // NativeEventEmitter requires these two to exist, even when unused.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  companion object {
    const val EVENT = "PlayaPalBeamIngress"
    const val MIME = "application/vnd.playapal.beam+json"
    const val DIR = "beam-ingress"
    const val EXT = "playapal"

    /** MAX_BEAM_BYTES (4 MiB) plus slack — a larger file is refused unread. */
    const val MAX_COPY_BYTES = 4L * 1024 * 1024 + 4 * 1024

    /**
     * Called from MainActivity for every intent it sees. Returns true when the
     * intent carried a stream we consumed (so the activity can neutralise it).
     */
    fun consume(context: Context, intent: Intent?, reactContext: ReactContext?): Boolean {
      if (intent == null) {
        return false
      }
      val action = intent.action ?: return false
      val source: String
      val uri: Uri?
      var extraCount = 1
      when (action) {
        Intent.ACTION_VIEW -> {
          source = "android-view"
          uri = intent.data
        }
        Intent.ACTION_SEND -> {
          source = "android-send"
          uri = streamExtra(intent)
        }
        Intent.ACTION_SEND_MULTIPLE -> {
          // Contract §3: take the first stream; JS reports "1 of N" from the
          // count rather than importing a batch of boards at once.
          source = "android-send"
          val list = streamExtras(intent)
          extraCount = list.size
          uri = list.firstOrNull()
        }
        else -> return false
      }
      if (uri == null) {
        return false
      }
      // FILES ONLY. A deep link (https://playapal.lol/b or /f, playapal://beam
      // or playapal://friend) is also an ACTION_VIEW with a data URI, and it
      // belongs to RCTLinkingManager → App.tsx handle(). Without this gate the
      // link was copied as if it were a file, failed with "No content
      // provider", and the intent was neutralised so JS never saw the URL —
      // which killed the QR path AND the shipped friend cards (kimi, scan-path
      // gate on the emulator, 2026-08-21). content:// and file:// are the only
      // schemes a byte-carrying file arrives on.
      val scheme = uri.scheme
      if (scheme != "content" && scheme != "file") {
        return false
      }
      val mime = intent.type
      val app = context.applicationContext
      worker.execute {
        val item = copyIn(app, uri, mime, source, extraCount)
        BeamIngressQueue.push(item)
        reactContext?.let { rc ->
          if (rc.hasActiveReactInstance()) {
            // The event carries the §2 payload (same ABI as iOS). JS still
            // drains the queue on every event, so the payload is informative
            // and the queue + file sweep remain the delivery truth. A map can
            // only be consumed once by the bridge, hence the copy.
            rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              .emit(EVENT, item.copy())
          }
        }
      }
      return true
    }

    private val worker = Executors.newSingleThreadExecutor { r ->
      Thread(r, "beam-ingress-copy").apply { isDaemon = true }
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
      if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
      }

    @Suppress("DEPRECATION")
    private fun streamExtras(intent: Intent): List<Uri> =
      (if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      }) ?: emptyList()

    /**
     * Stream-copy the URI into cacheDir/beam-ingress/<id>.playapal under the
     * byte cap. Every failure becomes an {error} item rather than a throw,
     * because the caller is an Activity lifecycle method and a crash there
     * takes the whole app down on a tap.
     */
    private fun copyIn(
      context: Context,
      uri: Uri,
      intentMime: String?,
      source: String,
      extraCount: Int,
    ): WritableMap {
      val id = UUID.randomUUID().toString()
      val map = Arguments.createMap()
      map.putString("ingressId", id)
      map.putString("source", source)
      map.putInt("extraCount", extraCount)

      val resolver = context.contentResolver
      var displayName = uri.lastPathSegment ?: "beam"
      var declaredSize = -1L
      try {
        resolver.query(uri, null, null, null, null)?.use { c ->
          if (c.moveToFirst()) {
            val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (n >= 0 && !c.isNull(n)) {
              displayName = c.getString(n)
            }
            val s = c.getColumnIndex(OpenableColumns.SIZE)
            if (s >= 0 && !c.isNull(s)) {
              declaredSize = c.getLong(s)
            }
          }
        }
      } catch (_: Exception) {
        // file:// and some providers refuse query(); the copy still works.
      }
      map.putString("displayName", displayName)
      map.putString("mime", intentMime ?: (resolver.getType(uri) ?: ""))

      if (declaredSize > MAX_COPY_BYTES) {
        map.putString("error", "too large")
        map.putDouble("bytes", declaredSize.toDouble())
        return map
      }

      val dir = File(context.cacheDir, DIR)
      dir.mkdirs()
      val done = File(dir, "$id.$EXT")
      val out = File(dir, "$id.$EXT.part")
      var total = 0L
      try {
        val input = resolver.openInputStream(uri)
          ?: throw IllegalStateException("could not open the file")
        input.use { ins ->
          FileOutputStream(out).use { os ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = ins.read(buf)
              if (n < 0) {
                break
              }
              total += n
              if (total > MAX_COPY_BYTES) {
                throw TooLarge()
              }
              os.write(buf, 0, n)
            }
          }
        }
        if (!out.renameTo(done)) {
          throw IllegalStateException("could not finish the copy")
        }
        map.putString("localPath", done.absolutePath)
        map.putDouble("bytes", total.toDouble())
      } catch (e: TooLarge) {
        out.delete()
        map.putString("error", "too large")
        map.putDouble("bytes", total.toDouble())
      } catch (e: Exception) {
        out.delete()
        map.putString("error", e.message ?: e.javaClass.simpleName)
        map.putDouble("bytes", total.toDouble())
      }
      return map
    }

    private class TooLarge : Exception("too large")
  }
}

/**
 * Process-wide queue of delivered-but-unconsumed items. Static on purpose:
 * the Activity consumes the intent before the React instance exists on a
 * cold start, and the module instance that serves drain() is created later.
 */
object BeamIngressQueue {
  private val items = ArrayList<WritableMap>()

  @Synchronized
  fun push(item: WritableMap) {
    items.add(item)
  }

  @Synchronized
  fun drain(): List<WritableMap> {
    val out = ArrayList(items)
    items.clear()
    return out
  }
}
