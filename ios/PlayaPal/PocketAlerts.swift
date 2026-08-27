import Foundation
import React
import UIKit
import UserNotifications

/**
 PocketAlerts — iOS half of src/crews/pocketAlerts.ts: LOCAL notifications
 for mesh mail and walkie call invites. No push entitlement, no server —
 every alert is minted on this phone by the JS seam, which also owns every
 decision (foreground suppression, burst batching, the stored permission
 choice). This class only authorizes, posts, and clears.

 ONE SLOT PER CATEGORY: the request identifier is derived from the
 category, and posting first removes the previous delivered/pending entry
 under the same id — a burst's second summary REPLACES the first in
 Notification Center instead of stacking (mirrors the Android module's
 fixed notification ids).

 THE 'mention' CATEGORY is the loud one: a podmate typed this camper's
 name on purpose ("@Kupo, bring water"), so it carries its own
 categoryIdentifier — which is what iOS groups, summarises and lets the
 camper switch off separately in Settings > Notifications > Playa Pal —
 and asks for .timeSensitive delivery, so it can break Focus the way a
 direct message does.

 TIME-SENSITIVE IS ASKED FOR, NOT ASSUMED. The treatment needs
 com.apple.developer.usernotifications.time-sensitive on the App ID, and
 that entitlement is NOT in PlayaPal.entitlements — the Wi-Fi Aware lesson
 (build 85f44108 failed to SIGN over an entitlement the profile did not
 carry) says an unprovisioned key costs the whole app while a missing
 capability costs one rung. Setting the property is free either way: iOS
 delivers the notification with standard sound and banner when the
 entitlement is absent, and starts honouring the level the moment the
 owner enables it in the portal. Nothing here needs to change then.

 REACH, stated honestly (the JS seam's Help copy says this to campers):
 these fire while the app is alive — foregrounded-then-pocketed, or
 backgrounded with the BLE session running under the declared
 bluetooth-central/peripheral background modes. An app iOS has fully
 terminated hears no Bluetooth arrival and posts nothing; that mail waits
 for the next open. requestAuthorization is the in-context ask the JS seam
 triggers the first time a pod/walkie feature arms.
 */
@objc(PocketAlerts)
final class PocketAlerts: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool { false }

  private func slot(_ category: NSString) -> String { "pod-\(category)" }

  @objc(requestPermission:rejecter:)
  func requestPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { granted, _ in
      // A denial is an answer, not an error — the JS seam stores it and
      // degrades silently, so this promise never rejects.
      resolve(granted)
    }
  }

  @objc(notify:title:body:resolver:rejecter:)
  func notify(
    _ category: NSString,
    title: NSString,
    body: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    let center = UNUserNotificationCenter.current()
    let id = slot(category)
    let content = UNMutableNotificationContent()
    content.title = title as String
    content.body = body as String
    // Calls could ask for a critical sound, but that needs a special
    // entitlement Apple grants case-by-case; .default plus the JS seam's
    // high-urgency copy is the honest reachable version.
    content.sound = .default
    content.threadIdentifier = id
    // The category is what Settings > Notifications lists, so every buzz
    // carries the one it belongs to — that list IS this app's granular
    // notification settings screen (see openSettings).
    content.categoryIdentifier = id
    if category as String == "mention" {
      content.interruptionLevel = .timeSensitive
    }
    // Replace, don't stack (see header).
    center.removeDeliveredNotifications(withIdentifiers: [id])
    center.removePendingNotificationRequests(withIdentifiers: [id])
    center.add(
      UNNotificationRequest(identifier: id, content: content, trigger: nil)
    ) { err in
      // false = "did not post" (authorization missing/revoked): the JS
      // side treats it exactly like Android's SecurityException — the
      // mail is safe in the store and the next app open shows it.
      resolve(err == nil)
    }
  }

  /**
   THE ONE DOOR TO THE GRANULAR SETTINGS (owner ask, 2026-08-26: "maybe
   should happen in OS permissions menus linked from app instead to be
   more elegant"). iOS 16+ opens Settings directly on this app's
   NOTIFICATIONS page, where alerts, sounds, badges, lock screen, banner
   style and the per-category switches all live; older iOS lands on the
   app's settings page, which is one tap away from the same thing.

   Main queue because UIApplication is main-thread-only, and under
   ObjCTry because a UIKit call reachable from a finger is exactly what
   the ObjC-raise law is about (CLAUDE.md, the AVFAudio crashes): a raise
   here would abort the app from a Settings row. A caught raise resolves
   false, and the row's copy already knows what false means.
   */
  @objc(openSettings:rejecter:)
  func openSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let path: String
      if #available(iOS 16.0, *) {
        path = UIApplication.openNotificationSettingsURLString
      } else {
        path = UIApplication.openSettingsURLString
      }
      guard let url = URL(string: path) else {
        resolve(false)
        return
      }
      let raised = ObjCTry.run {
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
      }
      resolve(raised == nil)
    }
  }

  @objc(cancel:resolver:rejecter:)
  func cancel(
    _ category: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    let center = UNUserNotificationCenter.current()
    let id = slot(category)
    center.removeDeliveredNotifications(withIdentifiers: [id])
    center.removePendingNotificationRequests(withIdentifiers: [id])
    resolve(nil)
  }
}
