package com.playapal

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Lane D — share the APP ITSELF (docs/FINAL-WEEK.md "Lane D").
 *
 * The bootstrap hole: a campmate with no app cannot receive a beam, and on
 * playa they cannot download one. Android hands us the path of our own
 * installed APK (`ApplicationInfo.sourceDir`), so phone-to-phone install over
 * Quick Share is possible with no internet at all — but that path lives
 * outside every FileProvider root, so it cannot be shared directly. We copy
 * it into `cacheDir/share-app/` (covered by the `share-app` cache-path in
 * res/xml/file_paths.xml) and share THAT.
 *
 * Deliberate choices:
 *   - the copy is 132.5 MB in release and 292.5 MB in debug (measured
 *     2026-08-21, after the splits.abi cure in f5ac9b3 — the earlier
 *     abiFilters attempt changed nothing), so it runs on a background
 *     thread, streams, and
 *     reports percent through the `PlayaPalShareAppProgress` device event;
 *     JS shows "Preparing…" from the first byte, not a frozen row.
 *   - a same-size copy is REUSED, so the second camper in line waits for a
 *     share sheet and not for a second pass over the whole APK;
 *   - copies of OTHER versions are deleted first — this is a cache, and
 *     leaving one APK per upgrade behind fills a phone the owner cannot
 *     reach a laptop from;
 *   - the write goes to `<name>.apk.part` and is renamed only when complete,
 *     because a truncated APK that merely LOOKS present is a failed install
 *     in dust, at the moment nobody can debug it;
 *   - a SPLIT install (Play delivers config APKs per ABI) is refused with a
 *     named error: the base APK alone is not installable, and sending one
 *     produces "App not installed" on the receiver with no explanation. Our
 *     release is a single arm64 APK (contract §6), so this is the emulator /
 *     future-Play-listing case, and it says so rather than shipping a dud.
 */
class ShareAppModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  private val io = Executors.newSingleThreadExecutor()

  /**
   * What we would share, WITHOUT copying the whole APK to find out: the version, the
   * byte count and whether this install can be shared at all. The Settings row
   * reads it on mount so the size is honest before the tap.
   */
  @ReactMethod
  fun describe(promise: Promise) {
    try {
      val apk = File(installedApkPath())
      val map = Arguments.createMap()
      map.putString("versionName", versionName())
      map.putDouble("bytes", apk.length().toDouble())
      map.putBoolean("splitInstall", isSplitInstall())
      map.putBoolean("shareable", !isSplitInstall() && apk.canRead())
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("EDESCRIBE", e.message, e)
    }
  }

  /**
   * Copy the installed APK into the shareable cache (or reuse a good copy)
   * and open the system share sheet on it. Resolves once the sheet is up —
   * whether the camper completes a send is theirs to know, exactly as the
   * beam share does.
   */
  @ReactMethod
  fun shareApp(promise: Promise) {
    io.execute {
      try {
        if (isSplitInstall()) {
          promise.reject(
            "ESPLIT",
            "This copy of Playa Pal was installed in per-device pieces, so it " +
              "cannot be passed on whole. Share from a phone that installed the APK directly.",
          )
          return@execute
        }
        val src = File(installedApkPath())
        if (!src.exists() || !src.canRead()) {
          promise.reject("ENOENT", "Cannot read this app's own APK at ${src.path}")
          return@execute
        }
        val dir = File(reactApplicationContext.cacheDir, SHARE_DIR)
        if (!dir.isDirectory && !dir.mkdirs()) {
          promise.reject("EMKDIR", "Could not create ${dir.path}")
          return@execute
        }
        val dest = File(dir, "PlayaPal-${fileSafe(versionName())}.apk")
        // A cache, not an archive: last version's copy is dead weight.
        dir.listFiles()?.forEach { f -> if (f != dest) f.delete() }

        val total = src.length()
        val reused = dest.exists() && dest.length() == total && total > 0L
        if (reused) {
          emitProgress(100, total, total)
        } else {
          if (dir.usableSpace < total + FREE_SPACE_SLACK) {
            promise.reject(
              "ENOSPC",
              "Not enough free space to prepare the app for sharing " +
                "(${mb(total)} MB needed).",
            )
            return@execute
          }
          copyStreaming(src, dest, total)
        }
        shareOnUiThread(dest, total, reused, promise)
      } catch (e: Exception) {
        promise.reject("ESHAREAPP", e.message, e)
      }
    }
  }

  /**
   * The copy thread outlives nothing: a React instance teardown (dev reload,
   * bridgeless restart) leaves the executor's thread alive otherwise.
   */
  override fun invalidate() {
    io.shutdown()
    super.invalidate()
  }

  // NativeEventEmitter requires these two to exist, even when unused —
  // JS listens through DeviceEventEmitter, same as the beam ingress event.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  private fun shareOnUiThread(dest: File, total: Long, reused: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val ctx = reactApplicationContext
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", dest)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = APK_MIME
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_TITLE, SHARE_TITLE)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, SHARE_TITLE).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        (ctx.currentActivity ?: ctx).startActivity(chooser)
        val out = Arguments.createMap()
        out.putString("path", dest.path)
        out.putDouble("bytes", total.toDouble())
        out.putString("versionName", versionName())
        out.putBoolean("reused", reused)
        promise.resolve(out)
      } catch (e: Exception) {
        promise.reject("ESHARE", e.message, e)
      }
    }
  }

  private fun copyStreaming(src: File, dest: File, total: Long) {
    val part = File(dest.parentFile, dest.name + PART_SUFFIX)
    try {
      src.inputStream().use { input ->
        FileOutputStream(part).use { out ->
          val buf = ByteArray(BUFFER_BYTES)
          var copied = 0L
          var lastPct = -1
          while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            out.write(buf, 0, n)
            copied += n
            val pct = if (total > 0L) ((copied * 100L) / total).toInt() else 0
            if (pct != lastPct) {
              lastPct = pct
              emitProgress(pct, copied, total)
            }
          }
          out.fd.sync()
        }
      }
      if (!part.renameTo(dest)) {
        throw IOException("Could not finish the copy at ${dest.path}")
      }
    } catch (e: Exception) {
      part.delete()
      throw e
    }
  }

  private fun emitProgress(pct: Int, copied: Long, total: Long) {
    val ctx = reactApplicationContext
    if (!ctx.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putInt("percent", pct)
    map.putDouble("copied", copied.toDouble())
    map.putDouble("total", total.toDouble())
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(PROGRESS_EVENT, map)
  }

  private fun installedApkPath(): String = appInfo().sourceDir

  private fun isSplitInstall(): Boolean = (appInfo().splitSourceDirs?.size ?: 0) > 0

  private fun versionName(): String = packageInfo().versionName ?: "app"

  @Suppress("DEPRECATION")
  private fun appInfo(): ApplicationInfo {
    val pm = reactApplicationContext.packageManager
    val pkg = reactApplicationContext.packageName
    return if (Build.VERSION.SDK_INT >= 33) {
      pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0L))
    } else {
      pm.getApplicationInfo(pkg, 0)
    }
  }

  @Suppress("DEPRECATION")
  private fun packageInfo(): PackageInfo {
    val pm = reactApplicationContext.packageManager
    val pkg = reactApplicationContext.packageName
    return if (Build.VERSION.SDK_INT >= 33) {
      pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0L))
    } else {
      pm.getPackageInfo(pkg, 0)
    }
  }

  private fun fileSafe(s: String): String = s.replace(Regex("[^A-Za-z0-9._-]"), "-")

  private fun mb(bytes: Long): Long = (bytes + 524288L) / 1048576L

  companion object {
    const val NAME = "ShareApp"

    /** The one MIME that makes a receiver's Files app offer "Install". */
    const val APK_MIME = "application/vnd.android.package-archive"

    const val PROGRESS_EVENT = "PlayaPalShareAppProgress"

    private const val SHARE_DIR = "share-app"
    private const val SHARE_TITLE = "Share Playa Pal"
    private const val PART_SUFFIX = ".part"
    private const val BUFFER_BYTES = 1 shl 16
    private const val FREE_SPACE_SLACK = 8L * 1024L * 1024L
  }
}
