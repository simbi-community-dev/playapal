#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PocketAlerts, NSObject)

RCT_EXTERN_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(notify:(NSString *)category
                  title:(NSString *)title
                  body:(NSString *)body
                  crewCode:(NSString *)crewCode
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The other half of a buzz: which notification the camper tapped, so the
// Pods tab can land on that pod's Mail pane instead of opening generically.
// Null once taken — a tap is one gesture and must steer exactly once.
RCT_EXTERN_METHOD(drainTap:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancel:(NSString *)category
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The one door to the OS's own per-category notification settings — the
// granular surface this app deliberately does not duplicate.
RCT_EXTERN_METHOD(openSettings:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
