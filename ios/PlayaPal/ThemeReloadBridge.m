#import <React/RCTBridgeModule.h>
#import <React/RCTReloadCommand.h>

@interface RCT_EXTERN_MODULE(ThemeReload, NSObject)

RCT_EXTERN_METHOD(reload:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
