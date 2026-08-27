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
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

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
 * The tap intent opens MainActivity plain (launchMode singleTask brings
 * the existing task forward). Deep-routing to the pod surface would need
 * new intent plumbing in App.tsx's manual tab shell — deliberately not
 * grown here; the deep-link family (/f /b /p) is for cross-app payloads,
 * not tab selection.
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
  fun notify(category: String, title: String, body: String, promise: Promise) {
    try {
      ensureChannels()
      val r = route(category)
      val open = PendingIntent.getActivity(
        ctx,
        0,
        Intent(ctx, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE,
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
