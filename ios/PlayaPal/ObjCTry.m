#import "ObjCTry.h"

@implementation ObjCTry
+ (NSException *)run:(void (NS_NOESCAPE ^)(void))block {
  @try {
    block();
    return nil;
  } @catch (NSException *e) {
    return e;
  }
}
@end
