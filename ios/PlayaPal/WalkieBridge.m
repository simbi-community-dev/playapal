#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(Walkie, RCTEventEmitter)

RCT_EXTERN_METHOD(start:(nonnull NSNumber *)podHash
                  senderHash:(nonnull NSNumber *)senderHash
                  displayName:(NSString *)displayName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// THE STOP IS A BARRIER, AND IT RESOLVES A STRUCTURED OUTCOME. It used to
// REJECT with code "advertiser" and JS read that one code as the
// fail-closed fact — correct, and it made every OTHER rejection a generic
// error some later reader could mistake for a close. The Swift side now
// resolves { outcome, why, leaseId, requestId, state } with outcome in
// clear | debt | notOwner, and the JS boundary adds `unknown` for an
// answer it cannot understand. Only `clear` may be read as a close; that
// is the whole contract and it lives on one field instead of in the shape
// of a rejection.
RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startTalking:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopTalking:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(netInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// THE AIRTIME STATE — the ARBITER's whole versioned state, asked. The
// WalkieAirtimeState event carries the identical body on every revision;
// this is the road for the windows in which nobody was subscribed (the
// gap after a stop answers, a JS reload, a background). Both are
// OBSERVABILITY: nothing JS reads here can move a radio, because the
// arbiter drives the suppression and the resume itself, at the effect.
//
// ABSENT FROM HERE IS ABSENT TO JS no matter how correct the Swift is —
// and the honest answer to that is the capability policy, not a fallback:
// walkieAirtimeCapability() answers 'absent', the hold PARKS with a
// reason, and no watcher is left waiting on an event shape that will
// never arrive (S9).
RCT_EXTERN_METHOD(airtimeState:(RCTPromiseResolveBlock)resolve
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
