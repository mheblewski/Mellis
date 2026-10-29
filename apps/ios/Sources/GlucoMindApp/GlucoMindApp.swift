import SwiftUI
import GlucoMindCore
import CryptoKit

#if canImport(UIKit)
import UIKit

final class GlucoMindAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        NSLog("[PUSH-TAP] 00 app.didFinishLaunching entered")
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        NSLog("[PUSH-TAP] 00 delegate attached early")
        NSLog("[APNS] didFinishLaunchingWithOptions entered")
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            let context = Self.tapContext(from: userInfo)
            NSLog("[PUSH-TAP] 00 coldlaunch.payload conversationId=%@ type=%@ patientId=%@ routePath=%@ universalLink=%@", context.conversationID, context.type, context.patientID, context.routePath, context.universalLink)
            NSLog("[APNS] Launch options contain remote notification payload")
            Task { @MainActor in
                // The delegate hands the same tap over too, with the notification button used: this copy waits for it.
                NSLog("[PUSH-TAP] 03 inbox.receive launch copy conversationId=%@", context.conversationID)
                RemoteNotificationInbox.shared.receiveLaunchPayload(userInfo)
            }
        }
        NSLog("[APNS] didFinishLaunchingWithOptions exit")
        NSLog("[PUSH-TAP] 00 app.didFinishLaunching exit")
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let tokenHash = SHA256.hash(data: deviceToken).map { String(format: "%02x", $0) }.joined()
        NSLog("[APNS] didRegisterForRemoteNotificationsWithDeviceToken entered token_length=%d token_sha256=%@", token.count, tokenHash)
        Task { @MainActor in
            RemoteNotificationInbox.shared.receiveDeviceToken(deviceToken)
        }
        NSLog("[APNS] didRegisterForRemoteNotificationsWithDeviceToken exit")
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[APNS] didFailToRegisterForRemoteNotificationsWithError error=%{public}@", String(describing: error))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        // Trio's answer to a remote command: its English banner is replaced by the Polish one GlucoMind posts.
        if TrioReply.parse(userInfo: userInfo) != nil {
            let key = notification.request.identifier
            let date = notification.date
            Task { @MainActor in
                await RemoteCommandCenter.shared.handle(userInfo: userInfo, key: key, deliveredAt: date)
                completionHandler([])
            }
            return
        }
        // "Odpowiedź gotowa" is for a phone put away: in the open app the answer is already on the screen.
        if PushPayloadParser.isAnswerReady(userInfo: userInfo) {
            completionHandler([])
            return
        }
        completionHandler([.badge, .sound, .banner])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if TrioReply.parse(userInfo: userInfo) != nil {
            let key = response.notification.request.identifier
            let date = response.notification.date
            Task { @MainActor in
                // Read before the answer is handled (that clears the waiting command): the tap opens their Bolus tab.
                let patientID = RemoteCommandCenter.shared.pendingCommandPatientID
                await RemoteCommandCenter.shared.handle(userInfo: userInfo, key: key, deliveredAt: date)
                if let patientID {
                    RemoteNotificationInbox.shared.receivePushPayload(AppRoute.remoteCommandPayload(patientID: patientID))
                }
                completionHandler()
            }
            return
        }
        let context = Self.tapContext(from: userInfo)

        Task { @MainActor in
            NSLog("[PUSH-TAP] 01 delegate.didReceive entered conversationId=%@", context.conversationID)
            NSLog("[PUSH-TAP] 02 payload received conversationId=%@ type=%@ patientId=%@ routePath=%@ universalLink=%@", context.conversationID, context.type, context.patientID, context.routePath, context.universalLink)
            NSLog("[PUSH-TAP] 03 inbox.receive start conversationId=%@", context.conversationID)
            RemoteNotificationInbox.shared.receivePushPayload(userInfo)
            NSLog("[PUSH-TAP] 04 inbox.receive end conversationId=%@", context.conversationID)
            completionHandler()
        }
    }
}

private extension GlucoMindAppDelegate {
    nonisolated static func tapContext(from userInfo: [AnyHashable: Any]) -> (type: String, patientID: String, conversationID: String, routePath: String, universalLink: String) {
        guard let gluco = userInfo["gluco"] as? [String: Any] else {
            return ("n/a", "n/a", "n/a", "n/a", "n/a")
        }

        return (
            normalize(gluco["type"] as? String),
            normalize(gluco["patientId"] as? String),
            normalize(gluco["conversationId"] as? String),
            normalize(gluco["routePath"] as? String),
            normalize(gluco["universalLink"] as? String)
        )
    }

    nonisolated static func normalize(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "n/a" : trimmed
    }
}
#endif

@main
struct GlucoMindApp: App {
#if canImport(UIKit)
    @UIApplicationDelegateAdaptor(GlucoMindAppDelegate.self) private var appDelegate
#endif
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var container = AppContainer()
    @ObservedObject private var splash = LaunchSplashController.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .overlay {
                    if splash.phase != .gone {
                        LaunchSplash(start: splash.shownAt, leaveAt: splash.leaveAt, hurried: splash.hurried)
                    }
                }
                .onChange(of: launchReadiness, initial: true) { _, readiness in
                    splash.update(readiness)
                }
#if canImport(UIKit)
                .background {
                    if TestEnvironment.isEnabled {
                        TestEnvironmentFrameInstaller()
                    }
                }
#endif
                .onOpenURL { url in
                    container.handleUniversalLink(url)
                }
                .onChange(of: scenePhase) { _, newValue in
                    if newValue == .background {
                        container.setLiveUpdatesActive(false)
                    }
                    guard newValue == .active else {
                        return
                    }
                    // A read while the phone was locked could not see this phone's Trio setup (no Bolus tab).
                    container.refreshRemoteSetup()

                    Task {
                        await container.restoreSessionOnForeground()
                        await container.releasePendingDeviceIfSignedOut()
                        container.setLiveUpdatesActive(true)
                        await container.refreshAppConfig()
                        await container.refreshHandoffs()
                        await RemoteCommandCenter.shared.collectDeliveredAnswers()
                        await LiveActivityController.shared.appBecameActive()
                    }
                }
                .task {
#if DEBUG && canImport(ActivityKit) && os(iOS)
                    await LiveActivityFixture.startIfRequested()
#endif
                    await container.bootstrap()
                    await container.releasePendingDeviceIfSignedOut()
                }
        }
    }

    /// What the splash waits for: the dashboard's data when the app opens on a patient, nothing more otherwise.
    private var launchReadiness: LaunchSplashController.Readiness {
        guard container.bootstrapped, !container.loadingPatientEntry else { return .loading }
        if container.requiresSignIn || container.bootstrapError != nil || container.currentPatient == nil {
            return .ready
        }
        return .waitingForContent
    }
}
