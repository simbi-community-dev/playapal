package com.playapal

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Its own package, for the reason WifiAwarePackage gives: the radio
 * packages are live lanes' files, and a feature that makes an access point
 * has no business editing the walkie's registration to get itself loaded.
 */
class HotspotPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(HotspotModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
