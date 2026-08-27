#import <React/RCTBridgeModule.h>

// Rung 4's export (docs/WALKIE-LADDER.md §9). NSObject, not RCTEventEmitter:
// the probe answers one question and emits nothing.
//
// A missing bridge export has been a ship-stopper on this project before — a
// Swift module with no .m compiles, links, ships, and is simply invisible to
// JS. The check is the symmetry: every native module is a PAIR of files with
// four pbxproj entries each.
@interface RCT_EXTERN_MODULE(WifiAware, NSObject)

RCT_EXTERN_METHOD(describe:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
