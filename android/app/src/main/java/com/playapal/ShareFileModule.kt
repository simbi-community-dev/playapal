package com.playapal

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Shares a FILE (content URI + chooser), which the RN Share API cannot do
 * on Android (text-only). The camp beam must arrive as an importable .json
 * file, not pasted text: share targets refuse to save raw text ("Can't
 * save text") and the receiver's Import needs a document (two-human field
 * test, 2026-08-20).
 */
class ShareFileModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "ShareFile"

  @ReactMethod
  fun shareFile(path: String, mimeType: String, title: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.reject("ENOENT", "No file at $path")
        return
      }
      val uri = FileProvider.getUriForFile(
        reactApplicationContext,
        "${reactApplicationContext.packageName}.fileprovider",
        file,
      )
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, title)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, title).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val activity = reactApplicationContext.currentActivity
      (activity ?: reactApplicationContext).startActivity(chooser)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ESHARE", e.message, e)
    }
  }
}
