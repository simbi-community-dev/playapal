#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(Walkie, RCTEventEmitter)

RCT_EXTERN_METHOD(start:(nonnull NSNumber *)podHash
                  senderHash:(nonnull NSNumber *)senderHash
                  displayName:(NSString *)displayName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startTalking:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopTalking:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(netInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// "Look again": ask every radio to re-discover now. The Swift side is the
// whole contract — this line only makes it reachable from JS, and a method
// missing from HERE is a method JS sees as absent no matter how correct
// the Swift is.
RCT_EXTERN_METHOD(refreshDiscovery:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendSignal:(nonnull NSNumber *)toHash
                  payload:(NSString *)payload
                  fanout:(nonnull NSNumber *)fanout
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setCallActive:(BOOL)active
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The hang-diagnosis pulse. No resolver: JS fires and forgets, and the two
// NSLog lines the Swift side prints ARE the return value. Absent from here
// means absent to JS (walkiePulsePresent() answers false) no matter how
// correct the Swift is — which is the honest degrade on an older native.
RCT_EXTERN_METHOD(logPulse:(NSString *)tag)

@end
