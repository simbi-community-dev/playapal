#import <React/RCTBridgeModule.h>

// Rung 4's pairing door (docs/WALKIE-LADDER.md §9a). NSObject, not
// RCTEventEmitter: the sheet reports its own state on screen and the
// walkie's Aware rung reports the peer — this module answers one call.
//
// A missing bridge export has been a ship-stopper on this project before — a
// Swift module with no .m compiles, links, ships, and is simply invisible to
// JS. The check is the symmetry: every native module is a PAIR of files with
// four pbxproj entries each. The JS seam (src/crews/awarePairing.ts) treats
// an absent module as "no pairing door on this build" and hides the row, so
// the failure is quiet — which is exactly why the pin reads this file.
@interface RCT_EXTERN_MODULE(WifiAwarePairing, NSObject)

RCT_EXTERN_METHOD(present:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
