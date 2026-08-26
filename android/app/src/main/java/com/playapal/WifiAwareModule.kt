package com.playapal

import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.aware.WifiAwareManager
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Wi-Fi Aware — rung 4 of the connectivity ladder (docs/WALKIE-LADDER.md §9).
 *
 * THIS MODULE ANSWERS EXACTLY ONE QUESTION AND TOUCHES NO RADIO:
 *
 *     Does this phone have Wi-Fi Aware at all?
 *
 * No attach, no publish, no subscribe, no data path, no permission request,
 * nothing started, nothing torn down. It is deliberately inert — the feature
 * flag is that there is no code path to flag.
 *
 * WHY A PROBE SHIPS BEFORE THE FEATURE. Android Wi-Fi Aware is API 26+ but
 * VENDOR-DEPENDENT: plenty of shipping hardware simply does not have it, and
 * our own field phones (a Pixel 7 and a Pixel 9 Pro) are unmeasured. Every
 * rung-4 number in the ladder doc is from the standard rather than from our
 * hardware, and until this runs on a real phone we do not get to claim
 * otherwise. Shipping the probe with 0.8 is how the answer arrives in time to
 * change the design instead of after it.
 *
 * TWO DIFFERENT FALSES, reported separately on purpose:
 *   - `hardware=false` — the silicon/vendor stack has no Aware. Permanent.
 *     BLE is this phone's ceiling forever, which is exactly why the BLE floor
 *     is permanent and not a legacy path to retire.
 *   - `hardware=true, available=false` — the radio exists but the runtime says
 *     no right now, which happens when Wi-Fi or Location is switched off.
 *     Recoverable, and a completely different sentence to a user.
 * Collapsing those two into one boolean is how a permanent limitation ends up
 * wearing a "turn Wi-Fi on" prompt that can never work.
 *
 * AVAILABILITY IS NOT CAPABILITY (ladder §5). Even a `true` from here says
 * nothing about whether a given peer can be reached in the next thirty
 * seconds. Capability is announced; availability is proven per-peer by a
 * round trip. Nothing may promote a peer's rung on the strength of this call.
 */
class WifiAwareModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = NAME

  /**
   * The probe. Never rejects: "this phone cannot" is an ANSWER, not an error,
   * and a rejection here would read to JS as "the probe is broken" — which is
   * the one reading that would make us go looking for a bug instead of
   * writing down a measurement.
   */
  @ReactMethod
  fun describe(promise: Promise) {
    val out = Arguments.createMap()
    out.putString("platform", "android")
    out.putInt("sdkInt", Build.VERSION.SDK_INT)
    try {
      val hasFeature = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
      out.putBoolean("hardware", hasFeature)
      if (!hasFeature) {
        // No manager to ask, and asking anyway throws on some vendor images.
        out.putBoolean("available", false)
        out.putString(
          "reason",
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) "os-too-old" else "no-hardware",
        )
        promise.resolve(out)
        return
      }
      val mgr = ctx.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
      if (mgr == null) {
        // Feature advertised, service absent — a real vendor state, and one
        // that would otherwise surface as a ClassCastException at attach time.
        out.putBoolean("available", false)
        out.putString("reason", "no-service")
        promise.resolve(out)
        return
      }
      val available = mgr.isAvailable
      out.putBoolean("available", available)
      // isAvailable() goes false when Wi-Fi or Location is off; it does not
      // say which, and guessing would put a wrong instruction in front of a
      // camper. The honest token is "off", and the UI says "check Wi-Fi and
      // Location" rather than naming one.
      out.putString("reason", if (available) "ok" else "off")
      promise.resolve(out)
    } catch (e: Exception) {
      out.putBoolean("hardware", false)
      out.putBoolean("available", false)
      out.putString("reason", "error")
      out.putString("detail", e.message ?: e.javaClass.simpleName)
      promise.resolve(out)
    }
  }

  companion object {
    const val NAME = "WifiAware"
  }
}
