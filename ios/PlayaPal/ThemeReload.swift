import Foundation
import React

/**
 ThemeReload — iOS half of instant appearance switching. The palette is
 applied by src/theme/boot.ts before any StyleSheet freezes, so a full JS
 reload (the same RCTReloadCommand OTA-update libraries fire in production)
 re-lands every frozen style in the new scheme. The JS caller treats any
 failure as "apply on next launch."
 */
@objc(ThemeReload)
final class ThemeReload: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool { false }

  @objc(reload:rejecter:)
  func reload(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    // Resolve first — the promise must land before its JS context is torn
    // down by the reload itself.
    resolve(true)
    DispatchQueue.main.async {
      RCTTriggerReloadCommandListeners("appearance change")
    }
  }
}
