package com.playapal

import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * ThemeReload — the one-trick module behind instant appearance switching.
 *
 * WHY A RELOAD AT ALL. Every screen freezes its colors at import time
 * (module-level StyleSheet.create), so a palette change only fully lands
 * when the JS bundle re-evaluates: src/theme/boot.ts runs first on every
 * load and applies the chosen palette before any StyleSheet freezes.
 * Reloading the JS surface is exactly what OTA-update libraries do in
 * production after installing a new bundle — same mechanism, tiny scope.
 *
 * The JS side treats ANY failure as "apply on next launch" (honest copy),
 * so this method may reject freely on exotic hosts.
 */
class ThemeReloadModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "ThemeReload"

  @ReactMethod
  fun reload(promise: Promise) {
    val host = try {
      (ctx.applicationContext as ReactApplication).reactHost
    } catch (e: Exception) {
      null
    }
    if (host == null) {
      promise.reject("reload", "no react host")
      return
    }
    // Resolve first: the JS caller must receive its answer before the JS
    // context it lives in is torn down mid-reload.
    promise.resolve(true)
    try {
      host.reload("appearance change")
    } catch (_: Exception) {
      // Promise already settled; the JS side's next-launch fallback copy
      // covers a host that refused to reload.
    }
  }
}
