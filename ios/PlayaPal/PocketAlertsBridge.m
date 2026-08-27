#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PocketAlerts, NSObject)

RCT_EXTERN_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(notify:(NSString *)category
                  title:(NSString *)title
                  body:(NSString *)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancel:(NSString *)category
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The one door to the OS's own per-category notification settings — the
// granular surface this app deliberately does not duplicate.
RCT_EXTERN_METHOD(openSettings:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
