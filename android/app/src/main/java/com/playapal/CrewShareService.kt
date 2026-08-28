package com.playapal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * CrewShareService — Crew Phase C (docs/CREW-DESIGN.md): the share session
 * surviving the pocket.
 *
 * WHAT IT IS. A foreground service whose ONLY jobs are (1) keeping the app
 * process — and with it the React instance, the BLE radio callbacks, and the
 * while-in-use location grant — alive with the screen off, and (2) ticking a
 * heartbeat event to JS so the session refreshes its advertised position and
 * prunes stale sightings. All crew logic stays in JS; the service knows
 * nothing about crews, payloads, or positions.
 *
 * WHY type location|connectedDevice: connectedDevice covers the BLE work;
 * location keeps GPS flowing in the background under the existing
 * while-in-use grant — the modern stand-in for ACCESS_BACKGROUND_LOCATION, which
 * this app deliberately never requests (a lighter Play declaration and a
 * far less scary permission screen).
 *
 * CONSENT POSTURE. The persistent notification IS the "this is on" surface:
 * it names what is happening and opening the app is one tap from stopping
 * it. START_NOT_STICKY on purpose — a share session the system or the user
 * killed must NOT resurrect itself; sharing restarts only by a human tap.
 *
 * AND IT MUST NOT LIE. A notification that still reads "Your pod can find
 * you" while the Bluetooth adapter is off is the same defect as a checked
 * switch over a dead radio — worse, because it is the surface a pocketed
 * phone shows. setInterrupted() re-posts the same notification id with the
 * honest text when the radio drops and back when it returns; the service
 * itself never decides this, the radio module tells it.
 */
class CrewShareService : Service() {

  private val main = Handler(Looper.getMainLooper())
  private var ticking = false

  private val tick = object : Runnable {
    override fun run() {
      if (!ticking) {
        log("service//tick skip=not-ticking")
        return
      }
      val rc = reactContext()
      if (rc == null) {
        // The process lives, the service ticks, and JS hears nothing: the
        // session stops refreshing while the notification still says it is
        // on. Silent until now.
        log("service//tick drop=1 reason=no-react-context")
      } else if (!rc.hasActiveReactInstance()) {
        log("service//tick drop=1 reason=no-active-react-instance")
      } else {
        rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(TICK_EVENT, Arguments.createMap())
        log("service//tick sent=1 nextMs=$TICK_MS")
      }
      main.postDelayed(this, TICK_MS)
    }
  }

  private fun log(line: String) {
    Log.i(TAG, line)
  }

  private fun reactContext(): ReactContext? =
    (application as? ReactApplication)?.reactHost?.currentReactContext

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    log("service//start startId=$startId flags=$flags ticking=$ticking")
    running = true
    val notification = buildNotification(this, interrupted)
    // SECOND BELT, because the first one cannot cover this: on API 34+ a
    // location-typed foreground service throws SecurityException right
    // here if the location grant is missing or was REVOKED while we ran,
    // and an escape from onStartCommand kills the app. The caller gates on
    // the grant; this catches the revoked-mid-session race and stops
    // cleanly instead. Sharing degrades to foreground-only, which the UI
    // already says out loud.
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        if (Build.VERSION.SDK_INT >= 31) {
          type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        }
        startForeground(NOTIFICATION_ID, notification, type)
        log("service//foreground ok=1 type=$type sdk=${Build.VERSION.SDK_INT}")
      } else {
        startForeground(NOTIFICATION_ID, notification)
        log("service//foreground ok=1 type=none sdk=${Build.VERSION.SDK_INT}")
      }
    } catch (e: Exception) {
      // Location grant missing or revoked mid-session: sharing degrades to
      // foreground-only and every later tick is gone.
      log("service//foreground ok=0 err=${e.javaClass.simpleName} action=stopSelf")
      stopSelf()
      return START_NOT_STICKY
    }
    if (!ticking) {
      ticking = true
      main.post(tick)
      log("service//ticking started=1 everyMs=$TICK_MS")
    } else {
      log("service//ticking skip=already-ticking")
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    log("service//destroy wasTicking=$ticking")
    ticking = false
    running = false
    main.removeCallbacks(tick)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val TICK_EVENT = "CrewBeaconTick"
    const val CHANNEL_ID = "crew-share"
    const val NOTIFICATION_ID = 5050
    const val TICK_MS = 30_000L
    /** Same field-log tag as the radio; one grep covers the whole mesh. */
    private const val TAG = CrewBeaconModule.TAG

    /** Whether a service instance is live. Guards setInterrupted: posting
     * this notification when no service holds it would leave an ongoing
     * notification nobody can dismiss. */
    @Volatile
    private var running = false

    /** The radio's verdict, kept here so a service that starts (or is
     * restarted by the system) mid-outage opens with the honest text. */
    @Volatile
    private var interrupted = false

    private fun buildNotification(context: Context, down: Boolean): Notification {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) {
        nm.createNotificationChannel(
          NotificationChannel(
            CHANNEL_ID,
            "Pod sharing",
            NotificationManager.IMPORTANCE_LOW, // silent: presence, not an alert
          ),
        )
      }
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE,
      )
      val builder = if (Build.VERSION.SDK_INT >= 26) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      // Two truths, never a third: sharing is carrying, or sharing is on
      // and the radio is not carrying it. The interrupted copy also says
      // that it comes back by itself, so nobody re-flips a switch that is
      // already in the right position.
      val title =
        if (down) "Sharing paused — Bluetooth is off" else "Sharing with your pod"
      val text = if (down) {
        "Your pod cannot see you until Bluetooth is back on. Sharing picks up by itself."
      } else {
        "Your pod can find you while this is on. Tap to open; stop from the Camp tab."
      }
      return builder
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setOngoing(true)
        .setContentIntent(open)
        .build()
    }

    /**
     * Re-post the notification honestly. Called by CrewBeaconModule from the
     * adapter-state receiver — the only thing that knows. Updating a
     * foreground service's notification by re-notifying its id is the
     * documented path and keeps the service's foreground state intact.
     */
    fun setInterrupted(context: Context, down: Boolean) {
      if (interrupted == down) {
        return
      }
      interrupted = down
      if (!running) {
        Log.i(TAG, "service//notify skip=not-running interrupted=$down")
        return
      }
      try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(context, down))
        Log.i(TAG, "service//notify interrupted=$down")
      } catch (e: Exception) {
        // No POST_NOTIFICATIONS grant, or the service died between the two
        // lines: sharing itself is unaffected.
        Log.i(TAG, "service//notify ok=0 err=${e.javaClass.simpleName}")
      }
    }

    fun start(context: Context) {
      Log.i(TAG, "service//start-intent sdk=${Build.VERSION.SDK_INT}")
      // A new share session starts believed-healthy; the radio says
      // otherwise within a round trip if it is not.
      interrupted = false
      val intent = Intent(context, CrewShareService::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      Log.i(TAG, "service//stop-intent")
      context.stopService(Intent(context, CrewShareService::class.java))
    }
  }
}
