import Foundation
import React
import UIKit

#if canImport(WiFiAware) && canImport(DeviceDiscoveryUI)
  import DeviceDiscoveryUI
  import SwiftUI
  import WiFiAware
#endif

/**
 THE PAIRING CEREMONY — rung 4's missing door (docs/WALKIE-LADDER.md §9a).

 THE GAP THIS CLOSES. `WalkieAwareLink` publishes and browses scoped to
 `.allPairedDevices`, and Apple forms an Aware link ONLY between devices the
 OS has paired. The app shipped no pairing surface, so that set was empty on
 every phone, forever: two iPhones running Playa Pal side by side reached
 `aware//browse-empty` and stopped. The rung was not waiting on Apple. It was
 waiting on this file.

 WHAT PAIRING IS, IN A CAMPER'S TERMS: two phones do it once, together, in
 the same place — one shows itself, the other finds it, and a six-digit code
 is confirmed. After that the OS remembers the pair, and the walkie's Aware
 rung can carry voice between them with no Wi-Fi in the world.

 WHY BOTH HALVES ARE ON ONE SHEET. Apple's own sample says it plainly: "Tap +
 on BOTH devices. On the subscriber device, select the publisher device to
 pair with." One phone must ADVERTISE (`DevicePairingView`) while the other
 BROWSES (`DevicePicker`) — a ceremony with two roles, and our app is
 symmetric, so neither phone has been assigned one. Putting both controls on
 one sheet, in the order the two people will use them, is the honest shape:
 the pair decides who taps what, which is exactly the decision the API leaves
 to us. A single button would have to guess, and a wrong guess is two phones
 both advertising to nobody.

 WHAT THIS FILE DOES NOT DO. It does not unpair (Apple exposes no API for
 that — Settings › Privacy & Security › Paired Devices is the only door), and
 it does not connect. Paired is not connected: it means the walkie MAY now
 form a link, and `WalkieAwareLink` is what forms it. That separation is
 deliberate and matches Android's, where discovery and datapath are also two
 different events.

 UNVERIFIED ON THIS BOX — the same standing condition as `WifiAware.swift`.
 There is no Mac or Xcode 26 in this lane, so every DeviceDiscoveryUI symbol
 below is transcribed from Apple's shipped sample ("Building peer-to-peer
 apps") and carries an `EAS-VERIFY` comment naming exactly what to check. EAS
 is this project's only Swift compiler, and a wrong symbol here fails the
 WHOLE app build — so if this file is what breaks the build, DELETE THE PAIR
 (this file and `WifiAwarePairingBridge.m`, plus their four pbxproj rows
 each) rather than the app: the JS row self-hides when the module is absent,
 which is precisely why the seam checks for it.

 The framework gate is doubled on purpose: `canImport(DeviceDiscoveryUI)` is
 a BUILD fact and `#available(iOS 26.0, *)` is a RUN fact, and an app whose
 deployment target is 15.1 needs both — the linker weak-links a framework
 introduced after the deployment target, so an iOS 15 phone must never reach
 a symbol from it.
 */
@objc(WifiAwarePairing)
final class WifiAwarePairing: NSObject {
  /// UIKit presentation and SwiftUI hosting are main-thread-only.
  @objc static func requiresMainQueueSetup() -> Bool {
    return true
  }

  /**
   Open the pairing sheet. NEVER REJECTS, for the reason the probe never
   rejects: "this phone cannot pair" is an ANSWER. It resolves
   `{ presented, reason }` so the JS row can say a true sentence instead of
   showing an error that reads as a bug.
   */
  @objc(present:rejecter:)
  func present(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let answer = Self.openSheet()
      awareLog("pairing-present presented=" + String(answer.0) + " reason=" + answer.1)
      resolve(["presented": answer.0, "reason": answer.1])
    }
  }

  /// MAIN. Returns (presented, reason) — one reason per cause, kept apart
  /// for the same reason the probe keeps its three falses apart: a build
  /// fact, an OS fact and a silicon fact deserve different sentences.
  private static func openSheet() -> (Bool, String) {
    #if canImport(WiFiAware) && canImport(DeviceDiscoveryUI)
      if #available(iOS 26.0, *) {
        guard WACapabilities.supportedFeatures.contains(.wifiAware) else {
          return (false, "unsupported")
        }
        // EAS-VERIFY: WAPublishableService/WASubscribableService
        // `allServices[name]` — the same lookup WalkieAwareLink makes. nil
        // means the WiFiAwareServices Info.plist entry is missing or
        // spelled differently, and it is the ONE failure that would leave a
        // camper tapping a button that does nothing.
        guard
          let publishable = WAPublishableService.allServices[WalkieAwareLink.serviceName],
          let subscribable = WASubscribableService.allServices[WalkieAwareLink.serviceName]
        else {
          return (false, "no-service")
        }
        guard let host = topViewController() else {
          return (false, "no-window")
        }
        let dismisser = PairingDismisser()
        let sheet = UIHostingController(
          rootView: AwarePairingSheet(
            publishable: publishable,
            subscribable: subscribable,
            onDone: { dismisser.dismiss() }
          )
        )
        dismisser.host = sheet
        // A page sheet, not full screen: the swipe-down is a second way out
        // that owes nothing to the Done button working.
        sheet.modalPresentationStyle = .pageSheet
        sheet.isModalInPresentation = false
        // PROJECT LAW (CLAUDE.md, iOS native-exception law): UIKit raises
        // ObjC exceptions for presentation preconditions — presenting on a
        // controller that is already presenting is the common one — and a
        // raise is UNCATCHABLE by Swift do/catch. It aborts the app, from a
        // user gesture, in the dust.
        let raised = ObjCTry.run {
          host.present(sheet, animated: true) {
            awareLog("pairing-sheet-shown")
          }
        }
        if let raised {
          awareLog("pairing-raise " + (raised.reason ?? raised.name.rawValue))
          return (false, "error")
        }
        awareLog("pairing-started service=" + WalkieAwareLink.serviceName)
        return (true, "ok")
      }
      return (false, "os-too-old")
    #else
      return (false, "no-framework")
    #endif
  }

  /// MAIN. The controller a modal should hang off. React Native's root sits
  /// under the key window, and anything already presented (the InfoTap
  /// modal, an Alert) must be presented ON rather than replaced.
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    guard var top = scene?.keyWindow?.rootViewController else {
      return nil
    }
    while let presented = top.presentedViewController {
      top = presented
    }
    return top
  }
}

/// Dismissal without the init-time capture knot: the closure holds this
/// object strongly, this object holds the controller WEAKLY, so the sheet
/// can be handed a working Done button before it exists.
private final class PairingDismisser {
  weak var host: UIViewController?
  func dismiss() {
    awareLog("pairing-dismissed")
    host?.dismiss(animated: true)
  }
}

#if canImport(WiFiAware) && canImport(DeviceDiscoveryUI)

  /**
   The sheet. Deliberately plain: two controls, in ceremony order, and a
   live count of what the OS has actually remembered.

   THE COPY IS THE FEATURE HERE. Pairing is a two-person ritual with a code,
   performed by people who have never done it before, probably at night. The
   sheet has to say who taps what before either of them taps anything.
   */
  @available(iOS 26.0, *)
  private struct AwarePairingSheet: View {
    let publishable: WAPublishableService
    let subscribable: WASubscribableService
    let onDone: () -> Void

    /// How many devices the OS currently has paired for this app. The ONLY
    /// honest "did it work" signal on this screen, and the reason the sheet
    /// stays open after the system flow finishes.
    @State private var pairedCount = 0

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("Link iPhones directly")
            .font(.title2.bold())
          Text(
            "Two iPhones pair once, here, together — then they can talk at "
              + "full quality with no Wi-Fi at all. You only do this once per "
              + "pair of phones."
          )
          .font(.subheadline)
          .foregroundStyle(.secondary)

          Divider()

          Text("One of you taps this")
            .font(.headline)
          Text("It shows this iPhone to the other one.")
            .font(.footnote)
            .foregroundStyle(.secondary)
          // EAS-VERIFY: DevicePairingView(_:label:fallback:) with the
          // publisher shape `.wifiAware(.connecting(to: SERVICE, from:
          // .userSpecifiedDevices))` — Apple's sample verbatim, including
          // the argument order (the browser below takes the SWAPPED order)
          // and the omitted `access:` parameter. If `access:` is required,
          // pass `.default`.
          DevicePairingView(
            .wifiAware(.connecting(to: publishable, from: .userSpecifiedDevices))
          ) {
            Label("Show this iPhone", systemImage: "iphone.radiowaves.left.and.right")
          } fallback: {
            Label("This iPhone can't be shown", systemImage: "xmark.circle")
          }

          Divider()

          Text("The other one taps this")
            .font(.headline)
          Text(
            "It finds the first iPhone. Pick it, then confirm the same "
              + "six-digit code on both phones."
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
          // EAS-VERIFY: DevicePicker(_:onSelect:label:fallback:) with the
          // subscriber shape `.wifiAware(.connecting(to:
          // .userSpecifiedDevices, from: SERVICE))` — Apple's sample
          // verbatim. Their sample omits `parameters:`, so it has a
          // default; if the builder demands it, pass NWParameters matching
          // WalkieAwareLink's realtime/interactiveVoice stack.
          DevicePicker(
            .wifiAware(.connecting(to: .userSpecifiedDevices, from: subscribable))
          ) { endpoint in
            // The endpoint is deliberately DROPPED. It arrives once, it
            // cannot be reused on the next app launch, and connecting from
            // here would mint a second link outside the one place that owns
            // links. WalkieAwareLink's browser picks the peer up on its own
            // once the pair is remembered — which is what "paired, not
            // connected" means.
            awareLog("pairing-paired (a device was selected and the ceremony completed)")
            _ = endpoint
          } label: {
            Label("Find the other iPhone", systemImage: "magnifyingglass")
          } fallback: {
            Label("This iPhone can't search", systemImage: "xmark.circle")
          }

          Divider()

          Text(
            pairedCount == 0
              ? "No iPhones linked yet."
              : pairedCount == 1
                ? "1 iPhone linked."
                : "\(pairedCount) iPhones linked."
          )
          .font(.headline)
          Text(
            "Linked is not connected — it means the walkie is allowed to "
              + "reach them. Turn the walkie on and they show up on the "
              + "channel. To unlink, use Settings › Privacy & Security › "
              + "Paired Devices."
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
          Text("New — being field-tested. If it doesn't take, the walkie still works the way it did.")
            .font(.footnote)
            .foregroundStyle(.secondary)

          Button(action: onDone) {
            Text("Done").font(.body.bold())
          }
          .padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .task {
        await watchPairedDevices()
      }
    }

    /// The OS's own answer to "did the ceremony take", streamed. Also the
    /// sheet's only state, so nothing here can disagree with the phone.
    private func watchPairedDevices() async {
      do {
        // EAS-VERIFY: WAPairedDevice.allDevices — an async sequence of a
        // keyed collection; Apple's sample iterates it and reads `.values`.
        for try await updated in WAPairedDevice.allDevices {
          let n = Array(updated.values).count
          awareLog("paired-devices n=" + String(n) + " (pairing sheet)")
          pairedCount = n
        }
      } catch {
        awareLog("pairing-watch-failed " + error.localizedDescription)
      }
    }
  }

#endif
