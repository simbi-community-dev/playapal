package com.playapal

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CrewBeaconPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      CrewBeaconModule(reactContext),
      FieldAudioModule(reactContext),
      WalkieModule(reactContext),
      ThemeReloadModule(reactContext),
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
