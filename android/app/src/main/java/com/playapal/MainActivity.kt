package com.playapal

import android.os.Bundle
import com.facebook.react.ReactActivity
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
