#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Swift cannot catch Objective-C exceptions, and AVFAudio raises them for
/// its tap preconditions (measured three times on the owner's iPhone 13
/// mini: EXC_CRASH out of AUGraphNodeBaseV3::CreateRecordingTap, builds 25
/// and 27, guards notwithstanding). Enumerating preconditions is a spiral —
/// the next OS adds one more. Catch the class instead.
@interface ObjCTry : NSObject
/// Runs the block; returns nil on success, the caught NSException on raise.
+ (nullable NSException *)run:(void (NS_NOESCAPE ^)(void))block;
@end

NS_ASSUME_NONNULL_END
