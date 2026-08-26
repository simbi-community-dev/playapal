import Foundation
import React
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
