package com.playapal

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayInputStream
import java.io.File
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicBoolean

/**
 * UPDATE TO LATEST — the sideloader's missing update channel.
 *
 * WHY THIS EXISTS. Playa Pal reaches most Android phones as an APK handed
 * over by another phone (ShareAppModule, "Lane D") or downloaded once from
 * a release page. Neither of those leaves anything behind that will ever
 * tell the camper a newer build exists. Obtainium solves this properly and
 * nobody is going to set Obtainium up in a dust storm, so the app has to
 * carry the one honest version of the job itself: ask GitHub what the
 * latest release is, fetch that one file, and hand it to the system
 * installer. The asking half lives in TypeScript (src/update/appUpdate.ts);
 * this file is the fetching and the handing over, which no JS can do.
 *
 * DOWNLOADMANAGER, NOT OUR OWN SOCKET. The APK is 130 MB and the camper is
 * on one bar of borrowed signal. DownloadManager is the system service
 * built for exactly that: it survives the screen going off, it retries
 * across a network that comes and goes, it puts the progress in the
 * notification shade where a camper who tabs away can still see it, and it
 * writes to our own external files dir — already a FileProvider root
 * (res/xml/file_paths.xml, `external-files-path name="beams"`), so the
 * finished file can be handed to the installer with no new plumbing.
 *
 * THE SIGNATURE WALL IS CHECKED FIRST, NOT DISCOVERED LAST. Android
 * refuses to install a release-signed APK over a debug-signed one — same
 * package name, different key, "App not installed" and no explanation.
 * Bench and field-build phones in this house run the checked-in debug key
 * (android/app/debug.keystore, `CN=Android Debug`), so for those phones the
 * download is 130 MB of dust-bound bandwidth spent to reach a refusal.
 * `describe()` reports the signing key up front and `download()` refuses
 * on it a second time, so the sentence a camper reads arrives BEFORE the
 * wait rather than after it.
 *
 * FAILURE IS AN ANSWER, NOT AN ERROR — the stance WifiAwareModule set and
 * HotspotModule carries. Nothing here rejects a promise. A rejection
 * collapses every distinct, actionable refusal into one 'error', and the
 * whole value of this module is that "there is no room on the phone",
 * "the download died halfway" and "this phone runs a developer build" are
 * three different sentences with three different next steps.
 *
 *   developer-build .... debug-signed install; the prod APK cannot land.
 *   no-manager ......... DownloadManager is absent or disabled (a stripped
 *                        ROM, a work profile). Permanent on this phone.
 *   no-space ........... not enough room for the copy.
 *   no-storage ......... the external files dir is gone or unwritable —
 *                        a phone with the SD card pulled mid-download.
 *   download-failed .... the transfer stopped: HTTP error, redirect loop,
 *                        an unresumable break. The playa default.
 *   no-installer ....... the file landed and nothing on this phone will
 *                        open an APK (rare; locked-down ROMs).
 *   error .............. something threw. Reported with its message.
 *
 * WATCHING IS DONE TWICE ON PURPOSE. The completion broadcast is the
 * authority — it is what DownloadManager promises to send — and a 500 ms
 * poll of the same row runs alongside it, because the poll is the only
 * source of a percentage AND because a receiver that never fires (a ROM
 * that drops the broadcast, an export-flag rule that changes again) would
 * otherwise strand the camper on a progress bar forever. Two readers of
 * one row, one settle: whichever sees the end first wins, and the other
 * finds the promise already spent.
 */
class AppUpdateModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  /** The download in flight, so a React teardown can unregister it.
   * @Volatile because `download` is called on the bridge's own thread and
   * `invalidate` on another, and a teardown that reads a stale null leaves
   * a system receiver bound to a dead React instance. */
  @Volatile
  private var live: Watch? = null

  /**
   * What this install IS, without touching the network — the version the
   * camper is actually running and whether a release APK could ever land
   * on top of it. The row reads this on mount, which is why it may not
   * cost a byte of signal: an offline-first app that phones home when a
   * screen opens is not offline-first.
   */
  @ReactMethod
  fun describe(promise: Promise) {
    val map = Arguments.createMap()
    try {
      map.putString("versionName", packageInfo().versionName ?: "")
      map.putBoolean("developerBuild", isDebugSigned())
      map.putBoolean("canInstall", canRequestInstalls())
      map.putString("reason", "ok")
    } catch (e: Exception) {
      // A phone that cannot describe itself still gets a row; it just
      // falls back to the version baked into the JS bundle.
      map.putString("versionName", "")
      map.putBoolean("developerBuild", false)
      map.putBoolean("canInstall", false)
      map.putString("reason", "error")
      map.putString("detail", e.message)
    }
    promise.resolve(map)
  }

  /**
   * Fetch the release APK and hand it to the system installer. Resolves
   * when the installer is on screen — whether the camper goes through with
   * it is theirs to know, exactly as the share sheet is in ShareAppModule.
   */
  @ReactMethod
  fun download(url: String, promise: Promise) {
    val ctx = reactApplicationContext
    if (isDebugSigned()) {
      promise.resolve(fail("developer-build", null))
      return
    }
    val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
    if (dm == null) {
      promise.resolve(fail("no-manager", null))
      return
    }
    val dir = ctx.getExternalFilesDir(null)
    if (dir == null) {
      promise.resolve(fail("no-storage", "no external files directory on this phone"))
      return
    }
    val dest = File(dir, "$UPDATE_DIR/$APK_NAME")
    val parent = dest.parentFile
    if (parent != null && !parent.isDirectory && !parent.mkdirs()) {
      promise.resolve(fail("no-storage", "could not create ${parent.path}"))
      return
    }
    // A leftover from a run whose process died is worse than no file at
    // all: DownloadManager does not overwrite, it writes alongside as
    // "playapal-1.apk", and we would then hand the installer the STALE
    // copy sitting at the path we know. Delete, then enqueue.
    dest.delete()

    val id = try {
      dm.enqueue(
        DownloadManager.Request(Uri.parse(url))
          .setTitle(DOWNLOAD_TITLE)
          .setDescription(DOWNLOAD_DESC)
          .setMimeType(APK_MIME)
          // Visible in the shade: a 130 MB transfer on playa signal is
          // long enough that the camper will leave the app, and the
          // notification is the only thing that tells them it is alive.
          .setNotificationVisibility(
            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
          )
          .setDestinationInExternalFilesDir(ctx, null, "$UPDATE_DIR/$APK_NAME"),
      )
    } catch (e: Exception) {
      promise.resolve(fail("error", e.message))
      return
    }

    val watch = Watch(dm, id, dest, promise)
    live = watch
    watch.start()
  }

  /**
   * A dev reload or a bridgeless restart must not leave a system receiver
   * registered against a dead React instance — the same discipline
   * ShareAppModule keeps for its copy thread.
   */
  override fun invalidate() {
    live?.abandon()
    live = null
    super.invalidate()
  }

  // NativeEventEmitter wants these two to exist even though JS listens
  // through DeviceEventEmitter, the same as the share-app progress event.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  /**
   * One download, watched by a broadcast and a poll, settled exactly once.
   */
  private inner class Watch(
    private val dm: DownloadManager,
    private val id: Long,
    private val dest: File,
    private val promise: Promise,
  ) : BroadcastReceiver() {

    private val settled = AtomicBoolean(false)
    // Its own latch, because the hand-off hops to the UI thread and the
    // promise stays unspent until it lands: without this, the broadcast
    // and the poll can both see STATUS_SUCCESSFUL in that gap and open
    // the installer twice.
    private val handing = AtomicBoolean(false)
    private val handler = Handler(Looper.getMainLooper())
    private var registered = false

    private val poll = object : Runnable {
      override fun run() {
        if (settled.get()) {
          return
        }
        if (!readOnce()) {
          handler.postDelayed(this, POLL_MS)
        }
      }
    }

    fun start() {
      try {
        // RECEIVER_EXPORTED, and it is not a loosening: ACTION_DOWNLOAD_
        // COMPLETE arrives from the system, and Android 14's export rule
        // has enough edge cases around protected broadcasts that the
        // tighter flag risks a receiver that simply never fires. A forged
        // broadcast from another app costs nothing here — the id is
        // checked and then DownloadManager itself is re-read, so a lie
        // buys the liar one extra cursor query reporting "still running".
        ContextCompat.registerReceiver(
          reactApplicationContext,
          this,
          IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
          ContextCompat.RECEIVER_EXPORTED,
        )
        registered = true
      } catch (e: Exception) {
        // The poll below is a complete watcher on its own, so a ROM that
        // refuses the registration loses the notification-shade tap, not
        // the download.
      }
      handler.post(poll)
    }

    override fun onReceive(context: Context?, intent: Intent?) {
      val got = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: -1L
      if (got == id) {
        readOnce()
      }
    }

    /** Drop the receiver without answering — teardown, not completion. */
    fun abandon() {
      settled.set(true)
      handler.removeCallbacksAndMessages(null)
      unregister()
    }

    /**
     * Read the download's row once. Returns true when the transfer has
     * ENDED, either way, so the poll knows to stop rescheduling itself.
     */
    private fun readOnce(): Boolean {
      if (settled.get()) {
        return true
      }
      val cursor = try {
        dm.query(DownloadManager.Query().setFilterById(id))
      } catch (e: Exception) {
        settle(fail("error", e.message))
        return true
      }
      if (cursor == null) {
        settle(fail("error", "the download queue could not be read"))
        return true
      }
      // The lambda's VALUE is the answer, not a non-local return: `use` is
      // inline either way, but a function whose every exit hides inside a
      // lambda reads as one with no exit at all.
      return cursor.use { row ->
        if (!row.moveToFirst()) {
          // The row is gone: the camper cleared it from the shade, or the
          // system pruned it. Either way nothing is coming.
          settle(fail("download-failed", "the download left the queue"))
          return@use true
        }
        val status = row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val soFar =
          row.getLong(row.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val total =
          row.getLong(row.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> {
            emitProgress(100, soFar, soFar)
            install()
            true
          }
          DownloadManager.STATUS_FAILED -> {
            val code = row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            settle(fail(reasonFor(code), "download manager code $code"))
            true
          }
          else -> {
            // total is -1 until the server sends a length, and a percentage
            // computed from that reads as -0% forever.
            emitProgress(
              if (total > 0L) ((soFar * 100L) / total).toInt() else 0,
              soFar,
              total,
            )
            false
          }
        }
      }
    }

    /**
     * Hand the finished file to the system package installer. ACTION_VIEW
     * on a content:// URI with the APK mime is the whole contract — the
     * read grant rides the flag, because the installer is a different app
     * and our FileProvider is not exported.
     */
    private fun install() {
      if (!handing.compareAndSet(false, true)) {
        return
      }
      UiThreadUtil.runOnUiThread {
        val ctx = reactApplicationContext
        try {
          val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", dest)
          val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          (ctx.currentActivity ?: ctx).startActivity(view)
          val out = Arguments.createMap()
          out.putBoolean("ok", true)
          out.putString("reason", "ok")
          out.putString("path", dest.path)
          settle(out)
        } catch (e: Exception) {
          settle(fail("no-installer", e.message))
        }
      }
    }

    private fun settle(answer: WritableMap) {
      if (!settled.compareAndSet(false, true)) {
        return
      }
      handler.removeCallbacksAndMessages(null)
      unregister()
      promise.resolve(answer)
    }

    private fun unregister() {
      if (!registered) {
        return
      }
      registered = false
      try {
        reactApplicationContext.unregisterReceiver(this)
      } catch (e: IllegalArgumentException) {
        // Already gone (a teardown raced the completion). Nothing to undo.
      }
    }
  }

  private fun emitProgress(percent: Int, soFar: Long, total: Long) {
    val ctx = reactApplicationContext
    if (!ctx.hasActiveReactInstance()) {
      return
    }
    val map = Arguments.createMap()
    map.putInt("percent", percent)
    map.putDouble("copied", soFar.toDouble())
    map.putDouble("total", total.toDouble())
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(PROGRESS_EVENT, map)
  }

  /**
   * DownloadManager's failure codes, each kept apart only where the next
   * step differs. "Free some space" and "try again with better signal" are
   * different actions; six flavours of transport break are not.
   */
  private fun reasonFor(code: Int): String = when (code) {
    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "no-space"
    DownloadManager.ERROR_DEVICE_NOT_FOUND -> "no-storage"
    DownloadManager.ERROR_FILE_ERROR -> "no-storage"
    DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "no-storage"
    else -> "download-failed"
  }

  private fun fail(reason: String, detail: String?): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("ok", false)
    map.putString("reason", reason)
    if (detail != null) {
      map.putString("detail", detail)
    }
    return map
  }

  /**
   * Is this install signed with a debug key? The Android debug keystore —
   * including the one checked in at android/app/debug.keystore — issues a
   * self-signed certificate whose subject is `CN=Android Debug`, and that
   * string is the ground truth for "a production APK will bounce off this
   * phone". Reading the certificate is the honest test; FLAG_DEBUGGABLE is
   * not, because a release build signed with the debug key for a field
   * phone is not debuggable and would sail straight past it.
   *
   * IT SWALLOWS ITS OWN FAILURES, AND FALSE IS THE RIGHT DEFAULT. Reading
   * a certificate can throw on a ROM with a rewritten package manager, and
   * this is called from `download` where an escaping exception would
   * become the one thing this module promises never to do — a rejected
   * promise. A phone whose signature cannot be read is not a phone to
   * block: let the download run, and if the key really does clash, the
   * system installer refuses honestly at the end. Guessing "debug" would
   * withhold updates from a working phone on no evidence at all.
   */
  @Suppress("DEPRECATION")
  private fun isDebugSigned(): Boolean {
    val pm = reactApplicationContext.packageManager
    val pkg = reactApplicationContext.packageName
    return try {
      val raw: List<ByteArray> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
        val signing = info.signingInfo
        val certs = when {
          signing == null -> null
          signing.hasMultipleSigners() -> signing.apkContentsSigners
          else -> signing.signingCertificateHistory
        }
        certs?.map { it.toByteArray() } ?: emptyList()
      } else {
        pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures
          ?.map { it.toByteArray() } ?: emptyList()
      }
      val factory = CertificateFactory.getInstance("X.509")
      raw.any { bytes ->
        val cert = factory.generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
        cert.subjectX500Principal.name.contains(DEBUG_CERT_SUBJECT)
      }
    } catch (e: Exception) {
      false
    }
  }

  /**
   * Has the camper already allowed this app to install packages? Android
   * asks for REQUEST_INSTALL_PACKAGES per-source at the moment of install,
   * so a false here is not a refusal — it is the extra screen the row's
   * copy warns about, so nobody reads "Blocked by Play Protect" cold.
   */
  private fun canRequestInstalls(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactApplicationContext.packageManager.canRequestPackageInstalls()
    } else {
      true
    }

  @Suppress("DEPRECATION")
  private fun packageInfo(): PackageInfo {
    val pm = reactApplicationContext.packageManager
    val pkg = reactApplicationContext.packageName
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0L))
    } else {
      pm.getPackageInfo(pkg, 0)
    }
  }

  companion object {
    const val NAME = "AppUpdate"

    /** The one MIME that makes Android offer its package installer. */
    const val APK_MIME = "application/vnd.android.package-archive"

    const val PROGRESS_EVENT = "PlayaPalAppUpdateProgress"

    /** The subject every Android debug keystore mints, ours included. */
    private const val DEBUG_CERT_SUBJECT = "CN=Android Debug"

    private const val UPDATE_DIR = "updates"
    private const val APK_NAME = "playapal.apk"
    private const val DOWNLOAD_TITLE = "Playa Pal update"
    private const val DOWNLOAD_DESC = "Downloading the newest Playa Pal"
    private const val POLL_MS = 500L
  }
}
