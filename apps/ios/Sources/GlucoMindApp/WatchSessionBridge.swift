import Foundation
import GlucoMindCore
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

/// Connects the Apple Watch app, which never signs in itself, to the caregiver's server: once the watch app is installed
/// and the caregiver is signed in (paired), the phone creates a read-only watch token (POST /v1/me/watch-devices, the
/// first patients up to four) and sends it with the server's address and the patients as the watch's application
/// context (WatchLink). The device is kept in this phone's Keychain and made again when the server or the caregiver
/// changes, or when the watch says the server refused its token. Signing out (unpairing) revokes it and clears the watch.
/// The session starts at app launch, so a watch can reach a phone app it woke in the background, before any screen.
@MainActor
final class WatchSessionBridge: NSObject {
    static let shared = WatchSessionBridge()

    /// The signed-in (paired) API, else nil; set by the app at launch.
    private var signedInAPI: () -> APIClient? = { nil }
    private let record = KeychainCodableItem<WatchDeviceRecord>(service: "pl.mellis.watch-link", account: "apple-watch-device")
    private var syncing = false
    private var syncAgain = false
    /// The watch may not have what the phone last sent (it asked, or its app or complications changed).
    private var resendRequested = false

    /// At app launch, also a background one.
    func activate() {
        #if canImport(WatchConnectivity)
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        #endif
    }

    /// Once the app knows its session: a token can be made from now on.
    func connect(signedInAPI: @escaping () -> APIClient?) {
        self.signedInAPI = signedInAPI
        sync()
    }

    /// Makes sure the watch has a working token for the signed-in caregiver (on sign-in, foreground, watch changes).
    func sync() {
        Task { await syncNow() }
    }

    /// Before the session goes (sign-out, "Odłącz ten telefon"): the watch's token is revoked while the API still works,
    /// and the watch forgets it.
    func signingOut(api: APIClient?) async {
        if let device = record.load(), let api {
            do {
                try await api.revokeWatchDevice(id: device.deviceID)
            } catch {
                NSLog("[WATCH] watch device revoke failed: %@", String(describing: error))
            }
        }
        record.clear()
        send(WatchLink.signedOutContext)
    }

    /// The server ended this phone's session (revoked): the watch is cleared; a new pairing makes a new token (the old
    /// device of the same label is revoked by the server then).
    func sessionEnded() {
        record.clear()
        send(WatchLink.signedOutContext)
    }

    private func syncNow() async {
        #if canImport(WatchConnectivity)
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        // Still starting, or signed out: a token made earlier still works (a sign-out clears it on its own path).
        guard let api = signedInAPI() else {
            if let device = record.load() { sendCurrent(device) }
            return
        }
        guard !syncing else { syncAgain = true; return }
        syncing = true
        defer { syncing = false }
        repeat {
            syncAgain = false
            guard let device = await currentDevice(api: api) else { return }
            sendCurrent(device)
        } while syncAgain
        #endif
    }

    private func sendCurrent(_ device: WatchDeviceRecord) {
        send(WatchLink.context(device.credentials), resend: resendRequested)
        resendRequested = false
    }

    /// The device of this server, created when there is none.
    private func currentDevice(api: APIClient) async -> WatchDeviceRecord? {
        if let device = record.load() {
            if device.baseURL == api.baseURL { return device }
            // Another server (re-paired elsewhere): the old device cannot be reached any more; forgotten here.
            record.clear()
        }
        do {
            let created = try await api.createAppleWatchDevice(label: Self.label)
            let device = WatchDeviceRecord(
                deviceID: created.device.id,
                token: created.token,
                baseURL: api.baseURL,
                patients: created.patients.map { WatchLink.Patient(id: $0.id, name: $0.name) }
            )
            try record.save(device)
            NSLog("[WATCH] watch device created for %d patients", device.patients.count)
            return device
        } catch {
            NSLog("[WATCH] watch device creation failed: %@", String(describing: error))
            return nil
        }
    }

    /// The watch's server answered 401 for this token: a new device, unless the phone already moved on.
    private func tokenRejected(fingerprint: String) {
        guard let device = record.load(), WatchLink.fingerprint(device.token) == fingerprint else {
            // The phone already has another token and the watch did not get it.
            resendRequested = true
            sync()
            return
        }
        record.clear()
        sync()
    }

    /// One label per phone: the server replaces this phone's earlier Apple Watch device (reinstall) by it.
    private static var label: String {
        String("Apple Watch · \(AppContainer.deviceName)".prefix(40))
    }

    private func send(_ context: [String: Any], resend: Bool = false) {
        #if canImport(WatchConnectivity)
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        let same = WatchLink.sameContext(context, session.applicationContext)
        guard !same || resend else { return }
        let outgoing = same ? WatchLink.resent(context, at: Date()) : context
        do {
            try session.updateApplicationContext(outgoing)
            // A context waits for the watch app. With a Mellis complication on the face this also wakes the app.
            if session.isComplicationEnabled, session.remainingComplicationUserInfoTransfers > 0 {
                session.transferCurrentComplicationUserInfo(outgoing)
            }
        } catch {
            NSLog("[WATCH] hand-over failed: %@", String(describing: error))
        }
        #endif
    }

    /// A record exists only while signed in (signing out clears it), and it can be read before the app has its session.
    private func currentContext() -> [String: Any] {
        guard let device = record.load() else { return [:] }
        return WatchLink.context(device.credentials)
    }

    private func received(_ message: [String: Any]) {
        if let fingerprint = message[WatchLink.rejectedTokenKey] as? String {
            tokenRejected(fingerprint: fingerprint)
        } else {
            resendRequested = true
            sync()
        }
    }
}

#if canImport(WatchConnectivity)
extension WatchSessionBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.sync() }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Switched to another watch: activate again for it.
        WCSession.default.activate()
    }

    /// The watch app was installed or a complication added: it may have nothing yet.
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in
            self.resendRequested = true
            self.sync()
        }
    }

    /// The watch asks for the context (it has none) or reports a refused token; the reply is what the phone has now.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let message = message
        Task { @MainActor in
            self.received(message)
            replyHandler(self.currentContext())
        }
    }

    /// A refused token reported while the phone app was not running (queued by the watch).
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let userInfo = userInfo
        Task { @MainActor in self.received(userInfo) }
    }
}
#endif
