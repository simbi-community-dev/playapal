#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(CrewBeacon, RCTEventEmitter)

RCT_EXTERN_METHOD(setPayload:(NSString *)payloadB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startAdvertising:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopAdvertising:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startScan:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopScan:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// STOP ALL IS THE SHARING SESSION'S BARRIER, and the mailbox ship-gate
// minimum on iOS. It is not "stopAdvertising plus stopScan": the Swift
// side also RETIRES the published GATT services and clears the payload,
// the sync digest and every per-central cursor, so a central that already
// holds this phone's address finds nothing published rather than a quiet
// advertisement in front of a live mailbox. The distinction matters
// because a walkie AIRTIME hold deliberately keeps the mailbox reachable
// (share.ts argues that trade); ending sharing must not.
RCT_EXTERN_METHOD(stopAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The foreground scan fast path; radio.ts calls it through an OPTIONAL
// guard, so a build that forgets this line degrades to the slow cadence
// silently rather than crashing. That is exactly why a test reads this file.
RCT_EXTERN_METHOD(setScanMode:(BOOL)lowLatency
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSyncDigest:(NSString *)b64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// THE ANSWER CARRIES THE QUESTION'S IDENTITY, and the argument ORDER here is
// the wire: RN maps the JS call positionally onto this declaration, so
// peerId, requestId, serverEpoch, payload is the same order meshSync.ts
// calls in and the same order Kotlin declares. `requestId` names the exact
// want being answered and `serverEpoch` the offer it was built against; the
// Swift side installs only against the request it still has open at that id,
// under the offer it publishes right now, and resolves a named refusal
// otherwise. Bridged as NSNumber for the same reason publishSyncDigest's
// scope is: they are JS numbers, and a BOOL/NSString mismatch here rejects
// at runtime inside a call site that deliberately does not await.
RCT_EXTERN_METHOD(provideSyncMessages:(NSString *)peerId
                  requestId:(nonnull NSNumber *)requestId
                  serverEpoch:(nonnull NSNumber *)serverEpoch
                  payload:(NSString *)b64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(syncWithPeer:(NSString *)peerId
                  want:(NSString *)wantB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// THE MESH SESSION'S BARRIER, and it is NOT stopAll. stopAll retires the
// whole sharing surface (services, payload, every known central's access);
// endSession keeps the phone discoverable and ends only this mesh session's
// SCOPE — the in-flight sync is cancelled at the source and the published
// offer is withdrawn, so the digest characteristic goes back to answering
// "not ready" instead of serving a dead session's mailbox. A walkie
// open/close fires it dozens of times an evening and must not cost the
// camper their discoverability.
RCT_EXTERN_METHOD(endSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// THE SCOPED DIGEST PUBLISH. setSyncDigest installs unconditionally; this
// one carries the mesh session and its revision, installs only when
// strictly newer, and REJECTS a stale publish — the promise is the ACK JS
// records the offer against, so a resolve on a stale publish would tell JS
// a dead session's mailbox is the live offer.
RCT_EXTERN_METHOD(publishSyncDigest:(NSString *)b64
                  radioEpoch:(nonnull NSNumber *)radioEpoch
                  digestRevision:(nonnull NSNumber *)digestRevision
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startForegroundSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopForegroundSession:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
