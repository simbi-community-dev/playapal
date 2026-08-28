import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  private var launchDocumentURLToSuppress: URL?

  // Friend-card deep links (2026-08-19): forward warm/background opens to
  // RCTLinkingManager so Linking.addEventListener fires — without these only
  // cold-start launchOptions URLs ever reach JS.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if url.isFileURL {
      // UIKit may repeat a cold launchOptions URL through openURL before the
      // app becomes active. Consume that callback without minting a second ID.
      if launchDocumentURLToSuppress == url.standardizedFileURL {
        launchDocumentURLToSuppress = nil
        return true
      }
      BeamIngress.receive(url)
      return true
    }
    return RCTLinkingManager.application(app, open: url, options: options)
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    // If UIKit did not repeat the launch URL, do not suppress a later real open.
    launchDocumentURLToSuppress = nil
  }

  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    return RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // RN 0.87 starts JS after this method returns. Begin the scoped copy now;
    // completion queues one item and emits a wake-up if JS became ready first.
    if let url = launchOptions?[.url] as? URL, url.isFileURL {
      launchDocumentURLToSuppress = url.standardizedFileURL
      BeamIngress.receive(url)
    }

    // A tapped pocket notification is delivered ONLY to the notification
    // centre's delegate, and Apple requires that delegate to be assigned
    // before launching finishes — otherwise the response for the
    // notification that LAUNCHED the app (the cold tap, which is the common
    // case for a phone in a pocket) never arrives. Two lines here rather
    // than a lazy install inside the module, because a lazy install would
    // work for every tap except the one that mattered.
    PocketAlertsTapObserver.install()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "PlayaPal",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
