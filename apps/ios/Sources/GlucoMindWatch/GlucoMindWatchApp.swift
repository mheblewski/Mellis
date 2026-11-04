import SwiftUI
import WatchConnectivity
import WidgetKit

@main
struct GlucoMindWatchApp: App {
    @StateObject private var model = WatchHomeModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Here and not in a view: the system also starts the app in the background to hand it the phone's context.
        PhoneSessionReceiver.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            WatchHomeView(model: model)
                .task { PhoneSessionReceiver.shared.onChange = { model.sessionChanged() } }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.refresh() } }
                }
        }
        .backgroundTask(.watchConnectivity) { await PhoneSessionReceiver.shared.receivePending() }
    }
}

/// Receives the watch token from the phone app (WatchSessionBridge, WatchLink): it goes to the watch's Keychain group,
/// where the complications read it too, and the complications reload. A sign-out on the phone clears it. It arrives with
/// the app open or in a background start, which the system decides, so the complications' notice names both apps.
final class PhoneSessionReceiver: NSObject, WCSessionDelegate {
    static let shared = PhoneSessionReceiver()
    var onChange: (() -> Void)?
    /// A request for the context that the phone has not answered yet.
    private var wantsSession = false

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Asks the phone for the context again (the watch has no token yet). With the phone out of reach: when it is back,
    /// and queued for its app.
    func requestSession() {
        wantsSession = true
        guard WCSession.default.activationState == .activated else { return }
        let message = [WatchLink.requestKey: "session"]
        if WCSession.default.isReachable {
            send(message)
        } else if !WCSession.default.outstandingUserInfoTransfers.contains(where: { $0.userInfo[WatchLink.requestKey] != nil }) {
            WCSession.default.transferUserInfo(message)
        }
    }

    /// A background start: done when what the phone sent has arrived (at most 10 s).
    func receivePending() async {
        activate()
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, WCSession.isSupported(),
              WCSession.default.activationState != .activated || WCSession.default.hasContentPending {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// The server refused this token (401): the phone makes a new one. Queued when the phone is not reachable.
    func reportRejected(fingerprint: String) {
        let message = [WatchLink.rejectedTokenKey: fingerprint]
        guard WCSession.default.activationState == .activated else { return }
        if WCSession.default.isReachable {
            send(message)
        } else {
            WCSession.default.transferUserInfo(message)
        }
    }

    private func send(_ message: [String: Any]) {
        guard WCSession.default.activationState == .activated, WCSession.default.isReachable else { return }
        WCSession.default.sendMessage(message, replyHandler: { [weak self] reply in
            self?.apply(reply)
        }, errorHandler: { error in
            NSLog("[WATCH] message to the phone failed: %@", String(describing: error))
        })
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if !session.receivedApplicationContext.isEmpty {
            apply(session.receivedApplicationContext)
        } else if WatchSession.credentialStore.load() == nil {
            requestSession()
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        if session.isReachable, wantsSession { requestSession() }
    }

    /// The same context, sent to wake the app for a complication on the face.
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        apply(userInfo)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }

    private func apply(_ context: [String: Any]) {
        switch WatchLink.parse(context) {
        case .signedOut:
            WatchSession.credentialStore.clear()
            WatchCache.clear()
        case let .credentials(credentials):
            wantsSession = false
            // The same token sent again: the complications may still show that it was missing.
            guard credentials != WatchSession.credentialStore.load() || context[WatchLink.sentAtKey] != nil else { return }
            do {
                try WatchSession.credentialStore.save(credentials)
            } catch {
                NSLog("[WATCH] saving the phone's hand-over failed: %@", String(describing: error))
                return
            }
            // The face editor offers one complication per patient: rebuild its list for the new hand-over.
            WatchCache.savePatients(credentials.patients.map { WatchPatient(id: $0.id, name: $0.name) })
            WidgetCenter.shared.invalidateConfigurationRecommendations()
        case nil:
            return
        }
        WidgetCenter.shared.reloadAllTimelines()
        DispatchQueue.main.async { self.onChange?() }
    }
}
