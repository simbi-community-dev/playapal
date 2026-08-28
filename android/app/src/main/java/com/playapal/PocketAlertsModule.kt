package com.playapal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * PocketAlerts — the LOCAL notification poster behind src/crews/
 * pocketAlerts.ts. Every buzz is minted on this phone from an on-device
 * event (a mesh arrival, a walkie call invite); there is no push service
 * and nothing here touches the network.
 *
 * DUMB ON PURPOSE. Every decision — whose mail buzzes, foreground
 * suppression, burst batching, the stored permission choice — lives in
 * the JS seam where it is unit-tested. This module knows exactly three
 * things: the channels, how to post into one, and how to clear one.
 *
 * FOUR CHANNELS, so the camper's system settings can tune each surface
 * separately (silence voice notes overnight, keep calls loud):
 *   pod-messages    DEFAULT importance — a buzz, not an alarm.
 *   pod-voice-notes DEFAULT importance.
 *   pod-mentions    HIGH importance + vibration: a podmate typed THIS
 *                   camper's name on purpose ("@Kupo, bring water"). It
 *                   earns a heads-up the way a direct message does in
 *                   every chat app the phone already runs.
 *   pod-calls       HIGH importance + vibration: a human is standing on
 *                   the same LAN with a ringing phone RIGHT NOW, and the
 *                   ring gives up in 30 seconds.
 *
 * THE CHANNELS ARE THE SETTINGS SCREEN (owner ask, 2026-08-26). Because
 * each surface is its own channel, Android's own per-app notification page
 * gives a switch, a sound and an importance dial per type for free — so
 * this app ships no per-type toggles of its own and instead opens that
 * page (openSettings below). One source of truth, in the camper's
 * language, honouring settings they already tuned.
 *
 * ONE NOTIFICATION SLOT PER CATEGORY (fixed ids): a second batch REPLACES
 * the first summary instead of stacking — the JS side already collapses a
 * burst to one alert, and the fixed id keeps the shade honest across
 * batches too. Ids live beside CrewShareService's 5050 so no surface ever
 * collides with another.
 *
 * THE TAP CARRIES ITS POD (2026-08-27). It used to open MainActivity
 * plain, and the owner-facing complaint was exact: a mention buzzes the
 * pocket, the camper taps it, and the app opens generically — the buzz
 * named a person and their words, and the answer made the camper do the
 * finding twice. The intent now carries the category and the pod code the
 * JS seam minted the buzz from, MainActivity consumes it into the slot
 * below, and JS drains that slot and steers the Pods tab to the right
 * pod's Mail pane. It is still not the deep-link family (/f /b /p): those
 * are for payloads arriving from ANOTHER app. This is one process handing
 * itself back a note it wrote a moment ago, and it never touches the
 * radio.
 *
 * FLAG_UPDATE_CURRENT is not decoration. A PendingIntent is keyed by
 * request code and intent shape, and without it the SECOND buzz on a
 * category silently reuses the FIRST one's extras — every mention after
 * the first would land on the pod the first one named. The request code is
 * the notification slot id, so the four surfaces never share a
 * PendingIntent either.
 *
 * POST_NOTIFICATIONS is asked in JS (PermissionsAndroid, radio.ts) before
 * any of this fires; if the grant was revoked mid-session, notify()
 * resolves false instead of throwing — a missed buzz must never crash the
 * sync that triggered it (the CrewShareService.setInterrupted posture).
 */
class PocketAlertsModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = NAME

  private fun manager(): NotificationManager =
    ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** Channel registration is idempotent and cheap, so it runs before every
   * post rather than at some app-start hook that a cold notify could race. */
  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < 26) {
      return
    }
    val nm = manager()
    nm.createNotificationChannel(
      NotificationChannel(
        CH_MESSAGES,
        "Pod messages",
        NotificationManager.IMPORTANCE_DEFAULT,
      ),
    )
    nm.createNotificationChannel(
      NotificationChannel(
        CH_VOICE,
        "Pod voice notes",
        NotificationManager.IMPORTANCE_DEFAULT,
      ),
    )
    nm.createNotificationChannel(
      NotificationChannel(
        CH_MENTIONS,
        "Mentions",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        // Someone typed this camper's name. Two firm taps — felt through a
        // coat pocket, distinct from the single tap ordinary mail makes,
        // and deliberately NOT the call's three-beat ring.
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 300, 200, 300)
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(
        CH_CALLS,
        "Pod calls",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        // The pocket case IS the design case: a call must be felt through
        // denim and dust. Pause-buzz-pause so it reads as a ring, not a
        // single mail tap.
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 400, 250, 400, 250, 400)
      },
    )
  }

  private data class Route(val channel: String, val id: Int, val icon: Int)

  private fun route(category: String): Route = when (category) {
    "voice" -> Route(CH_VOICE, ID_VOICE, android.R.drawable.stat_notify_chat)
    "mention" -> Route(CH_MENTIONS, ID_MENTION, android.R.drawable.stat_notify_chat)
    "call" -> Route(CH_CALLS, ID_CALL, android.R.drawable.stat_sys_phone_call)
    // Unknown categories from a NEWER JS fold to the mildest surface —
    // the same direction every cross-version seam in this app degrades.
    else -> Route(CH_MESSAGES, ID_MESSAGE, android.R.drawable.stat_notify_chat)
  }

  @ReactMethod
  fun notify(
    category: String,
    title: String,
    body: String,
    crewCode: String,
    promise: Promise,
  ) {
    try {
      ensureChannels()
      val r = route(category)
      val open = PendingIntent.getActivity(
        ctx,
        r.id,
        Intent(ctx, MainActivity::class.java)
          .putExtra(EXTRA_CATEGORY, category)
          .putExtra(EXTRA_CREW, crewCode),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val builder = if (Build.VERSION.SDK_INT >= 26) {
        Notification.Builder(ctx, r.channel)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx).apply {
          // Pre-channel builds carry the urgency on the notification
          // itself: calls and mentions ride high priority + the device
          // vibrate default, because there are no channels to carry it.
          if (category == "call" || category == "mention") {
            setPriority(Notification.PRIORITY_HIGH)
            setDefaults(Notification.DEFAULT_VIBRATE)
          }
        }
      }
      if (category == "call") {
        // Lets the OS rank it with real telephony (heads-up, DND rules).
        builder.setCategory(Notification.CATEGORY_CALL)
      }
      if (category == "mention") {
        // CATEGORY_MESSAGE is what a person-to-person message IS, and it
        // is what Android's priority-conversation and DND-exception rules
        // key on — so a camper who allows "messages" through Do Not
        // Disturb gets the one buzz they meant to allow.
        builder.setCategory(Notification.CATEGORY_MESSAGE)
      }
      manager().notify(
        r.id,
        builder
          .setContentTitle(title)
          .setContentText(body)
          .setSmallIcon(r.icon)
          .setAutoCancel(true) // tapping it consumed it — the app is open now
          .setContentIntent(open)
          .build(),
      )
      promise.resolve(true)
    } catch (e: Exception) {
      // No POST_NOTIFICATIONS grant (SecurityException) or a torn context:
      // report "did not buzz" and move on — the mail itself is safe in the
      // store, and the next app open shows it.
      promise.resolve(false)
    }
  }

  /**
   * Hand JS the notification the camper tapped, once.
   *
   * A DRAIN RATHER THAN A CALLBACK, the BeamIngressModule shape and for the
   * same reason: a COLD tap is the thing that launched the process, so
   * there is no JS to call back into when it arrives. MainActivity stashes
   * it; JS collects it on mount and on every return to the foreground, and
   * the emit below is the extra courtesy for a tap taken from the shade
   * over an app that never went to the background.
   *
   * Null once it has been taken — a tap is a single gesture and must steer
   * exactly once, or a later app-switch would drag the camper back to a
   * pod they already left.
   */
  @ReactMethod
  fun drainTap(promise: Promise) {
    val t = synchronized(PENDING_LOCK) {
      val held = pendingTap
      pendingTap = null
      held
    }
    if (t == null) {
      promise.resolve(null)
      return
    }
    val m = Arguments.createMap()
    m.putString("category", t.first)
    m.putString("crewCode", t.second)
    promise.resolve(m)
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  @ReactMethod
  fun cancel(category: String, promise: Promise) {
    try {
      manager().cancel(route(category).id)
    } catch (e: Exception) {
      // A shade we cannot reach clears itself when the app opens.
    }
    promise.resolve(null)
  }

  /** iOS's UNUserNotificationCenter needs an explicit authorization call;
   * Android's runtime grant is PermissionsAndroid's job in JS. Answering
   * true keeps the JS seam platform-uniform without a Platform branch on
   * every arm. */
  @ReactMethod
  fun requestPermission(promise: Promise) {
    promise.resolve(true)
  }

  /**
   * THE ONE DOOR TO THE GRANULAR SETTINGS (owner ask, 2026-08-26: "maybe
   * should happen in OS permissions menus linked from app instead to be
   * more elegant"). The per-channel switches, sounds, importance dials and
   * DND rules all live on Android's own app-notification page — this opens
   * it, so the app never grows a second, drifting copy of them.
   *
   * ensureChannels FIRST, deliberately: a camper who taps this before any
   * mail has ever arrived would otherwise land on a page listing no
   * channels at all — the granular control the row promised, missing at
   * the exact moment it was promised. Registration is idempotent.
   *
   * Pre-26 has no channel page; the app details screen carries the
   * notification switch there. Resolves false rather than throwing when an
   * OEM ships neither — the caller's copy stays honest.
   */
  @ReactMethod
  fun openSettings(promise: Promise) {
    try {
      ensureChannels()
      val intent = if (Build.VERSION.SDK_INT >= 26) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.fromParts("package", ctx.packageName, null))
      }
      // The activity is preferred (the page opens inside our own task and
      // Back returns here); NEW_TASK is the fallback for a module call that
      // arrives with no activity attached, where startActivity would throw.
      val activity = ctx.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  companion object {
    const val NAME = "PocketAlerts"

    /** JS's wake-up for a tap taken while the process was already running
     * (src/crews/pocketAlerts.ts, POCKET_ALERT_TAP_EVENT). */
    const val EVENT = "PlayaPalPocketAlertTap"

    /** The two extras a tap intent carries — namespaced, because
     * MainActivity's intent is also the door every other launch comes
     * through and a bare "category" would be a name anyone could collide
     * with. */
    const val EXTRA_CATEGORY = "com.playapal.alert.category"
    const val EXTRA_CREW = "com.playapal.alert.crew"

    private val PENDING_LOCK = Any()

    /** The tapped notification waiting for JS to collect it: (category,
     * pod code). Written from the main thread (onCreate/onNewIntent), read
     * from the bridge thread (drainTap) — hence the monitor rather than a
     * bare field. At most one: a tap is a gesture, and the newest gesture
     * is the one the camper meant. */
    private var pendingTap: Pair<String, String>? = null

    /**
     * MainActivity's hook. True when this intent WAS a notification tap,
     * so the caller can neutralise it — an activity recreation (rotation,
     * theme change) must not re-deliver the same tap and yank a camper who
     * has since navigated somewhere else.
     *
     * Deliberately tolerant of a missing pod code: a call's buzz carries
     * none by design, and an empty one simply steers nowhere. What matters
     * is that a tap is recognisable AS a tap.
     */
    @JvmStatic
    fun consumeTap(intent: Intent?, reactContext: ReactContext?): Boolean {
      val i = intent ?: return false
      val category = try {
        i.getStringExtra(EXTRA_CATEGORY)
      } catch (_: Exception) {
        // A malformed extras bundle from anywhere is not our tap.
        null
      } ?: return false
      val crew = try {
        i.getStringExtra(EXTRA_CREW)
      } catch (_: Exception) {
        null
      } ?: ""
      synchronized(PENDING_LOCK) {
        pendingTap = Pair(category, crew)
      }
      // Wake a JS side that is already running. A cold tap has no context
      // here and does not need one — the drain on mount is what collects
      // it, which is the whole reason the slot exists.
      try {
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT, Arguments.createMap())
        }
      } catch (_: Exception) {
        // A torn bridge costs the wake-up, never the tap: the next return
        // to the foreground drains it anyway.
      }
      return true
    }

    const val CH_MESSAGES = "pod-messages"
    const val CH_VOICE = "pod-voice-notes"
    const val CH_MENTIONS = "pod-mentions"
    const val CH_CALLS = "pod-calls"

    // 5050 is CrewShareService's persistent session notification.
    const val ID_MESSAGE = 5051
    const val ID_VOICE = 5052
    const val ID_CALL = 5053
    const val ID_MENTION = 5054
  }
}
