package com.playapal

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.SoftApConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * The camp hotspot — one phone makes the shared Wi-Fi the pod's video calls
 * need, with no internet anywhere near it.
 *
 * WHY THIS EXISTS. Voice carries with no network at all. Video does not: a
 * video call needs an IP network under it, and with no camp Wi-Fi there is
 * none. `WifiManager.startLocalOnlyHotspot` is the one public Android API
 * that makes a real WPA2 access point WITHOUT tethering, without an
 * upstream, and without any system-level permission: "a local-only hotspot
 * enables applications on devices connected to the Wi-Fi hotspot to
 * communicate with each other, and the network created will not have
 * internet access". Once the other phones are associated, they are on one
 * LAN, and ordinary ICE host candidates connect the call the way they
 * always have. No fork, no relay, no new protocol.
 *
 * WE DO NOT CHOOSE THE NAME OR THE PASSWORD, AND THAT IS THE POINT. Android
 * generates both (an `AndroidShare_xxxx`-shaped SSID and a random
 * passphrase) and hands them back on the reservation. Custom credentials
 * need a system-signature permission, and every recipe for forcing one is
 * reflection against a hidden class. So this module READS and REPORTS; JS
 * turns what it read into a QR the phone next to you can point a camera at.
 *
 * FAILURE IS AN ANSWER, NOT AN ERROR (the stance WifiAwareModule set). None
 * of these methods reject. A phone that will not host is a sentence a
 * camper has to read standing in the dust, and every distinct refusal gets
 * its own token so the sentence can be the right one:
 *
 *   no-hardware ........ no Wi-Fi radio at all. Permanent.
 *   os-too-old ......... below Android 8; the API does not exist. Permanent.
 *   no-permission ...... the nearby-Wi-Fi (33+) / location (32-) grant is
 *                        not held. Recoverable, and the caller knows how.
 *   location-off ....... the grant is held but location SERVICES are off.
 *                        A different fix from the one above, and telling
 *                        someone to "allow location" when they already did
 *                        is how a camper decides the app is broken.
 *   no-channel ......... the radio could not find a channel — usually this
 *                        phone is already associated with a Wi-Fi network,
 *                        or a second AP-class interface is already up.
 *   incompatible-mode .. the Wi-Fi stack is in a mode that excludes SoftAP.
 *   tethering-off ...... hotspot use is disallowed by policy (carrier, MDM,
 *                        work profile). Nothing the app can do.
 *   busy ............... this app already asked and is still waiting. One
 *                        request per app is the documented ceiling.
 *   no-credentials ..... it started, and the configuration read back empty.
 *                        Rare and vendor-specific — reported rather than
 *                        rendered as a QR of the empty string. The radio
 *                        is CLOSED before this is reported: a refusal on
 *                        screen must never sit over a live access point.
 *   cancelled .......... the switch went off while the radio was still
 *                        coming up. Whatever landed afterwards was closed
 *                        where it landed, and this is the receipt.
 *   error .............. the call threw. Reported with its message, never
 *                        swallowed.
 *
 * TEARDOWN IS LOUD. The system can take the hotspot away on its own (the
 * user starts real tethering, the Wi-Fi stack resets). That arrives as
 * `onStopped`, which is emitted to JS as its own event, because a QR still
 * on screen for a network that no longer exists is the worst version of
 * this feature.
 */
class HotspotModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = NAME

  /** The live reservation. Holding it IS the hotspot; closing it stops it. */
  @Volatile private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

  /** A request is in flight. Android allows one per app, so a second tap
   * must be answered honestly instead of queued into a callback nobody is
   * waiting on. */
  @Volatile private var pending = false

  /**
   * WHICH request the camper is still waiting for.
   *
   * STARTING IS NOT INSTANT, AND THAT IS THE WHOLE BUG THIS CLOSES. The
   * radio can take seconds to bring an access point up, and the switch can
   * go off inside those seconds — the camper flips it back, the pod card
   * unmounts, React tears the module down. Until this counter existed,
   * `stop()` had nothing to stop in that window (the reservation is still
   * null) and so recorded NOTHING; the reservation that landed a beat later
   * was stored as a live hotspot with no switch anywhere on screen bound to
   * it. An access point broadcasting on the owner's battery, invisible
   * until the phone reboots.
   *
   * So: every start captures this number, every cancel bumps it, and a
   * callback that finds it moved knows it is answering a question nobody is
   * asking any more — and CLOSES what it was handed instead of keeping it.
   */
  private val generation = java.util.concurrent.atomic.AtomicInteger(0)

  private fun emit(name: String, body: WritableMap) {
    if (ctx.hasActiveReactInstance()) {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body)
    }
  }

  private fun fail(reason: String, detail: String? = null): WritableMap {
    val out = Arguments.createMap()
    out.putBoolean("ok", false)
    out.putString("reason", reason)
    if (detail != null) {
      out.putString("detail", detail)
    }
    return out
  }

  /**
   * Give a reservation back, and never make a noise about it.
   *
   * Closing something the system already took away throws, and there is
   * nobody to tell — but NOT closing it is an access point nobody can see.
   * Every path that stops caring about a reservation comes through here, so
   * "stopped caring" and "closed" cannot drift apart.
   */
  private fun closeQuietly(res: WifiManager.LocalOnlyHotspotReservation?) {
    try {
      res?.close()
    } catch (e: Exception) {
      // Already gone. Nothing left to release and nothing worth reporting.
    }
  }

  /**
   * The permission this phone actually needs, named rather than guessed.
   * Android 13 moved hotspot/nearby-Wi-Fi work off the location grant onto
   * NEARBY_WIFI_DEVICES; below that it rides ACCESS_FINE_LOCATION. Both are
   * already declared in the manifest for the walkie's Aware rung — this
   * feature adds no new permission to the app, only a new moment at which
   * the existing one is asked for.
   */
  private fun permissionHeld(): Boolean {
    val needed =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Manifest.permission.NEARBY_WIFI_DEVICES
      } else {
        Manifest.permission.ACCESS_FINE_LOCATION
      }
    return ContextCompat.checkSelfPermission(ctx, needed) ==
      PackageManager.PERMISSION_GRANTED
  }

  /**
   * Location SERVICES, which is a different switch from the location GRANT
   * and refuses `startLocalOnlyHotspot` on its own below Android 13. Only
   * consulted where it can bite; on 33+ the nearby-Wi-Fi grant replaces it.
   */
  private fun locationServicesOn(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return true
    }
    val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      ?: return true
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        lm.isLocationEnabled
      } else {
        @Suppress("DEPRECATION")
        lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
          lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      }
    } catch (e: Exception) {
      // An unreadable switch is not a refusal; let the real call decide.
      true
    }
  }

  /**
   * Can this phone host at all? Asked before anything is switched on, so a
   * phone that can never do this shows the reason instead of a dead switch.
   */
  @ReactMethod
  fun describe(promise: Promise) {
    val out = Arguments.createMap()
    out.putString("platform", "android")
    out.putInt("sdkInt", Build.VERSION.SDK_INT)
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        out.putBoolean("supported", false)
        out.putString("reason", "os-too-old")
        promise.resolve(out)
        return
      }
      if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)) {
        out.putBoolean("supported", false)
        out.putString("reason", "no-hardware")
        promise.resolve(out)
        return
      }
      // SUPPORTED means "the API exists on hardware that has the radio".
      // It deliberately does NOT mean "will succeed": the grant, the
      // location switch and the channel are all decided at start time, and
      // pretending otherwise here would put a green light in front of a
      // camper whose next tap fails.
      out.putBoolean("supported", true)
      out.putBoolean("running", reservation != null)
      out.putString("reason", "ok")
      promise.resolve(out)
    } catch (e: Exception) {
      out.putBoolean("supported", false)
      out.putString("reason", "error")
      out.putString("detail", e.message ?: e.javaClass.simpleName)
      promise.resolve(out)
    }
  }

  /**
   * Start the hotspot and report the credentials Android chose.
   *
   * Never rejects. Resolves `{ok:true, ssid, passphrase, security}` or
   * `{ok:false, reason, detail?}`.
   */
  @ReactMethod
  fun start(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(fail("os-too-old"))
      return
    }
    val live = reservation
    if (live != null) {
      // Idempotent: a second tap while it is already up re-reads the same
      // reservation rather than throwing away a working network. Through
      // describeOrClose, because a re-read that fails is the same lie as a
      // first read that fails: a refusal on screen over a live radio.
      promise.resolve(describeOrClose(live))
      return
    }
    if (pending) {
      promise.resolve(fail("busy"))
      return
    }
    if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)) {
      promise.resolve(fail("no-hardware"))
      return
    }
    if (!permissionHeld()) {
      promise.resolve(fail("no-permission"))
      return
    }
    if (!locationServicesOn()) {
      promise.resolve(fail("location-off"))
      return
    }
    val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    if (wifi == null) {
      promise.resolve(fail("no-hardware"))
      return
    }
    // The callback needs a Looper thread; the native-modules thread has
    // none. Main is the documented choice and nothing here blocks it.
    val handler = Handler(Looper.getMainLooper())
    pending = true
    // The request this callback belongs to. `stop()` and `invalidate()`
    // move the counter; a callback that finds it moved is a late arrival
    // for a hotspot nobody wants any more.
    val gen = generation.incrementAndGet()
    val once = java.util.concurrent.atomic.AtomicBoolean(false)
    val answer = { map: WritableMap ->
      if (once.compareAndSet(false, true)) {
        pending = false
        promise.resolve(map)
      }
    }
    try {
      wifi.startLocalOnlyHotspot(
        object : WifiManager.LocalOnlyHotspotCallback() {
          override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
            if (generation.get() != gen) {
              // THE LATE ARRIVAL. The switch went off while the radio was
              // coming up, so this access point is already nobody's: no
              // card is bound to it and nothing on screen can stop it. It
              // is closed HERE, before it is ever stored, described or
              // announced — the only hand that will ever be on it.
              closeQuietly(res)
              answer(fail("cancelled"))
              return
            }
            reservation = res
            answer(describeOrClose(res))
          }

          override fun onFailed(reason: Int) {
            if (generation.get() == gen) {
              reservation = null
            }
            answer(fail(failureToken(reason), "code $reason"))
          }

          override fun onStopped() {
            // The system took it away. If it happens before we answered,
            // it IS the answer; afterwards it is news JS has to act on,
            // because a QR on screen for a dead network is a lie.
            val current = generation.get() == gen
            if (current) {
              reservation = null
            }
            if (!once.get()) {
              answer(fail(if (current) "stopped" else "cancelled"))
              return
            }
            if (!current) {
              // The echo of our own cancellation — closing a reservation
              // brings this callback with it. Announcing a teardown for a
              // hotspot the camper already switched off would repaint a
              // card that is correctly showing nothing.
              return
            }
            val body = Arguments.createMap()
            body.putString("reason", "stopped")
            emit(EVENT_STOPPED, body)
          }
        },
        handler,
      )
    } catch (e: Exception) {
      // SecurityException (grant revoked between check and call) and
      // IllegalStateException (Wi-Fi mid-restart) both land here.
      reservation = null
      answer(
        fail(
          if (e is SecurityException) "no-permission" else "error",
          e.message ?: e.javaClass.simpleName,
        ),
      )
    }
  }

  /**
   * Stop it. Never rejects; stopping something already stopped is fine.
   *
   * AND STOPPING SOMETHING NOT YET STARTED IS THE POINT. The half-arc law
   * here: "stop while starting" owes "late arrival closed". A stop with no
   * reservation to take away used to be a no-op, which meant the camper's
   * "off" left no trace anywhere and the reservation that landed a second
   * later became a hotspot with nobody's hand on it. The bump below is that
   * trace, and it is written BEFORE the null check rather than inside it.
   */
  @ReactMethod
  fun stop(promise: Promise) {
    val out = Arguments.createMap()
    generation.incrementAndGet()
    val live = reservation
    reservation = null
    if (live == null) {
      out.putBoolean("ok", true)
      out.putBoolean("wasRunning", false)
      promise.resolve(out)
      return
    }
    try {
      live.close()
      out.putBoolean("ok", true)
      out.putBoolean("wasRunning", true)
    } catch (e: Exception) {
      out.putBoolean("ok", false)
      out.putString("reason", "error")
      out.putString("detail", e.message ?: e.javaClass.simpleName)
    }
    promise.resolve(out)
  }

  /**
   * Read a reservation we are holding — and STOP HOLDING IT if the read
   * fails.
   *
   * FAILED AND LIVE CANNOT BOTH BE TRUE. By the time this runs the access
   * point is already up, so an empty configuration (`no-credentials`) or a
   * throw out of `describeReservation` reports a refusal over a radio that
   * is still broadcasting. The JS reducer reads `failed` as "nothing is
   * running" — correctly, because that is what every other failure means —
   * and draws a card with no way to turn anything off. So the rule is
   * simply: what we cannot describe, we do not keep.
   */
  private fun describeOrClose(res: WifiManager.LocalOnlyHotspotReservation): WritableMap {
    val out = describeReservation(res)
    if (out.hasKey("ok") && out.getBoolean("ok")) {
      return out
    }
    closeQuietly(res)
    if (reservation === res) {
      reservation = null
    }
    return out
  }

  /**
   * Read the credentials off a live reservation.
   *
   * Two eras: `getSoftApConfiguration()` from Android 11, and the
   * deprecated `getWifiConfiguration()` before it — whose SSID and
   * pre-shared key arrive WRAPPED IN QUOTES, a detail that would otherwise
   * ship straight into a QR payload and make every scan join a network
   * whose name has quote marks in it.
   */
  private fun describeReservation(res: WifiManager.LocalOnlyHotspotReservation): WritableMap {
    val out = Arguments.createMap()
    try {
      var ssid: String? = null
      var pass: String? = null
      var security = "wpa2"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val cfg = res.softApConfiguration
        ssid =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            unquote(cfg.wifiSsid?.toString())
          } else {
            @Suppress("DEPRECATION")
            unquote(cfg.ssid)
          }
        pass = cfg.passphrase
        security =
          when (cfg.securityType) {
            SoftApConfiguration.SECURITY_TYPE_OPEN -> "open"
            SoftApConfiguration.SECURITY_TYPE_WPA3_SAE -> "wpa3"
            SoftApConfiguration.SECURITY_TYPE_WPA3_SAE_TRANSITION -> "wpa3-transition"
            else -> "wpa2"
          }
      } else {
        @Suppress("DEPRECATION")
        val cfg = res.wifiConfiguration
        ssid = unquote(cfg?.SSID)
        pass = unquote(cfg?.preSharedKey)
      }
      if (ssid.isNullOrEmpty()) {
        return fail("no-credentials")
      }
      out.putBoolean("ok", true)
      out.putString("ssid", ssid)
      out.putString("passphrase", pass ?: "")
      out.putString("security", if (pass.isNullOrEmpty()) "open" else security)
      return out
    } catch (e: Exception) {
      return fail("error", e.message ?: e.javaClass.simpleName)
    }
  }

  /** Strip the wrapping quotes the legacy WifiConfiguration strings carry. */
  private fun unquote(s: String?): String? {
    if (s == null) {
      return null
    }
    return if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
      s.substring(1, s.length - 1)
    } else {
      s
    }
  }

  /**
   * The framework's four failure codes, each kept apart because each one
   * has a different sentence and only one of them ("you are on Wi-Fi
   * already") is something a camper can act on in ten seconds.
   */
  private fun failureToken(code: Int): String =
    when (code) {
      WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "no-channel"
      WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> "incompatible-mode"
      WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "tethering-off"
      else -> "generic"
    }

  /**
   * A React teardown (dev reload, bridgeless restart) must not leave an
   * access point broadcasting with nothing on screen that can turn it off.
   * That covers the hotspot we are holding AND the one still on its way in:
   * the same bump `stop()` writes, so a reservation that lands into a dead
   * module closes itself rather than outliving the app that asked for it.
   */
  override fun invalidate() {
    generation.incrementAndGet()
    try {
      reservation?.close()
    } catch (e: Exception) {
      // Already gone. Nothing to report to a JS side that no longer exists.
    }
    reservation = null
    super.invalidate()
  }

  // NativeEventEmitter wants these to exist even though JS listens through
  // DeviceEventEmitter, same as the beam ingress and share events.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  companion object {
    const val NAME = "CampHotspot"
    const val EVENT_STOPPED = "campHotspotStopped"
  }
}
