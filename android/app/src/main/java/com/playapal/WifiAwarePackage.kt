package com.playapal

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Its own package rather than a line inside CrewBeaconPackage: the radio
 * package is a live lane's file, and rung 4 has no business editing rung 1-2's
 * registration to introduce a module that touches no radio at all.
 */
class WifiAwarePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(WifiAwareModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
