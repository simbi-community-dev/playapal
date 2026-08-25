import Foundation
import React

#if canImport(WiFiAware)
import WiFiAware
#endif

/**
 Wi-Fi Aware — rung 4 of the connectivity ladder (docs/WALKIE-LADDER.md §9),
 iOS half. Mirrors `WifiAwareModule.kt` field for field.

 THIS MODULE ANSWERS EXACTLY ONE QUESTION AND TOUCHES NO RADIO:

     Does this phone have Wi-Fi Aware at all?

 No publish, no subscribe, no data path, no permission ask, nothing started.
 It is deliberately inert — the feature flag is that there is no code path to
 flag.

 THE THREE FALSES, kept apart on purpose (same reasoning as the Android half,
 where the split is hardware-vs-runtime):
   - `reason: "os-too-old"` — Apple opened Wi-Fi Aware to third-party apps in
     iOS 26. Every earlier iPhone is BLE-only FOREVER, which is precisely why
     the BLE floor is permanent and never a legacy path to retire.
   - `reason: "no-framework"` — built against an SDK that predates the
     framework. A build fact, not a device fact.
   - `reason: "unsupported"` — iOS 26 and the framework are both here and the
     device still says no.
 One boolean would collapse a permanent limitation and a stale build into the
 same sentence, and only one of them is worth telling a user about.

 NOT DECLARED YET, deliberately: real operations require the services to be
 listed under the `WiFiAwareServices` Info.plist key, and those names go over
 the air. Declaring a service this build does not implement would be a lie
 shipped in a plist, so the key is added with the data path, not with the
 probe.

 AVAILABILITY IS NOT CAPABILITY (ladder §5): even `true` here says nothing
 about reaching a given peer in the next thirty seconds. Nothing may promote a
 peer's rung on the strength of this call — promotion needs a round trip.

 UNVERIFIED ON THIS BOX: there is no macOS or Xcode 26 in this environment, so
 the `WACapabilities.supportedFeatures` call below is written from Apple's
 iOS 26 documentation and has NOT been compiled. The `canImport` guard means a
 wrong symbol cannot break a build that lacks the framework, but it CAN break
 the first build that has it — first Xcode 26 compile is where this gets
 confirmed, and that check is called out in the lane report rather than
 assumed.
 */
@objc(WifiAware)
final class WifiAware: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /**
   The probe. Never rejects: "this phone cannot" is an ANSWER, not an error.
   A rejection would read to JS as "the probe is broken", which is the one
   reading that sends someone hunting a bug instead of recording a
   measurement.
   */
  @objc(describe:rejecter:)
  func describe(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    var out: [String: Any] = [
      "platform": "ios",
      "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
      "hardware": false,
      "available": false,
      "reason": "unsupported",
    ]

    #if canImport(WiFiAware)
      if #available(iOS 26.0, *) {
        let supported = WACapabilities.supportedFeatures.contains(.wifiAware)
        out["hardware"] = supported
        // The framework exposes device support, not a live radio state the
        // way Android's isAvailable() does. Reporting `available` equal to
        // `hardware` would be inventing a signal; the honest position is that
        // on iOS the only thing that proves reachability is a round trip, and
        // §5 already requires one.
        out["available"] = supported
        out["reason"] = supported ? "ok" : "unsupported"
      } else {
        out["reason"] = "os-too-old"
      }
    #else
      out["reason"] = "no-framework"
    #endif

    resolve(out)
  }
}
