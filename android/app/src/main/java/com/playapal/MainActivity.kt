package com.playapal

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactApplication
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "PlayaPal"

  /**
   * Beam ingress (docs/BEAM-INGRESS-CONTRACT.md §2): a .playapal file opened
   * or shared to us arrives as an intent. Cold start lands here in onCreate
   * before JS exists, so the bytes are copied and QUEUED; a warm open lands
   * in onNewIntent (launchMode singleTask) and additionally wakes JS. Either
   * way the consumed intent is replaced with a neutral one, so an activity
   * recreation (rotation, theme change) cannot deliver the same file twice.
   * Friend-card links are NOT consumed here — consume() returns false for
   * them and they flow to RCTLinkingManager exactly as before.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null && BeamIngressModule.consume(this, intent, reactContext())) {
      intent = Intent(Intent.ACTION_MAIN)
    }
  }

  override fun onNewIntent(intent: Intent) {
    if (BeamIngressModule.consume(this, intent, reactContext())) {
      setIntent(Intent(Intent.ACTION_MAIN))
      return
    }
    super.onNewIntent(intent)
  }

  private fun reactContext() =
    (application as? ReactApplication)?.reactHost?.currentReactContext

  /**
   * JS owns every piece of UI state in this app, so Android's saved
   * view-hierarchy parcel is dead weight — and on text-heavy screens (the
   * reader, long Angel replies) it exceeded the 1 MB binder limit and
   * crashed the app on backgrounding (TransactionTooLargeException,
   * Pixel 9 Pro field crash 2026-08-20: 1.58 MB android:viewHierarchyState).
   */
  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.remove("android:viewHierarchyState")
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
