#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MicProbe, NSObject)

RCT_EXTERN_METHOD(run:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
