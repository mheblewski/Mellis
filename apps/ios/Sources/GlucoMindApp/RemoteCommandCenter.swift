import Combine
import Foundation
import UserNotifications
import GlucoMindCore

/// The app's remote-command wiring (remote-bolus-trio-plan.md W6): sending flows for the patient on screen and Trio's
/// answers. Trio's answer is an English push to this phone; in the foreground it is replaced by the Polish text, in the
/// background iOS shows Trio's text and the answer is reported once the app is open again (delivered notifications).
@MainActor
final class RemoteCommandCenter {
    static let shared = RemoteCommandCenter()

    let pendingStore = UserDefaultsPendingRemoteCommandStore()
    let notifier = UserNotificationsRemoteCommandNotifier()
    let settingsStore = KeychainTrioRemoteSettingsStore()
    let loopSettingsStore = KeychainLoopRemoteSettingsStore()
    /// Whether the patient's commands go to Loop (the capabilities' driver); set by the app container.
    var sendsToLoop: @MainActor (String) -> Bool = { _ in false }
    private var apiClient: APIClient?
    private var replyHandler: TrioReplyHandler?
    var pushToken: @MainActor () -> String? = { nil }
    /// Device mode: every command is signed with this phone's bolus key (Face ID enforced by the key).
    private var signer: RemoteCommandSigning?

    private init() {}

    func configure(apiClient: APIClient, pushToken: @escaping @MainActor () -> String?, signer: RemoteCommandSigning? = nil) {
        self.apiClient = apiClient
        flows = [:]
        self.pushToken = pushToken
        self.signer = signer
        replyHandler = TrioReplyHandler(api: apiClient, pendingStore: pendingStore, notifier: notifier)
    }

    private var flows: [String: RemoteBolusFlow] = [:]
    /// The patients' names as the app shows them now (a rename reaches the next command).
    private var names: [String: String] = [:]

    /// Another patient on screen: no confirmation of anyone else may stay open (nil closes them all).
    func cancelConfirmations(exceptPatientID patientID: String?) {
        for flow in flows.values where flow.patientID.lowercased() != patientID?.lowercased() {
            flow.cancel()
        }
    }

    enum FlowPlace: String {
        case bolusTab, chat, wbt
    }

    /// One flow per patient and screen: each screen presents its own confirmation (the server still allows one command
    /// of a patient at a time).
    func makeFlow(patientID: String, place: FlowPlace, patientName: String?) -> RemoteBolusFlow? {
        let cacheKey = "\(patientID):\(place.rawValue)"
        names[patientID.lowercased()] = patientName
        if let existing = flows[cacheKey] {
            if existing.patientName != patientName { existing.patientName = patientName }
            return existing
        }
        guard let apiClient else { return nil }
        let settingsStore = settingsStore
        let loopSettingsStore = loopSettingsStore
        let pendingStore = pendingStore
        let notifier = notifier
        let pushToken = pushToken
        // The patient's loop decides which settings and which sender, read at the moment they are used.
        let toLoop: @MainActor () -> Bool = { [weak self] in self?.sendsToLoop(patientID) ?? false }
        let limits: () -> RemoteCommandLimits? = {
            MainActor.assumeIsolated { toLoop() }
                ? ((try? loopSettingsStore.load(patientID: patientID)) ?? nil)
                : ((try? settingsStore.load(patientID: patientID)) ?? nil)
        }
        let signer = signer
        let flow = RemoteBolusFlow(patientID: patientID, patientName: patientName, api: apiClient, limits: limits, acknowledgement: UserDefaultsDIYAcknowledgementStore()) { [weak self] () -> RemoteCommandSending in
            #if DEBUG
            // Visual checks on fixtures: Trio's answer is played offline (nothing is sent, see UIPreviewFixtureSender).
            if UIPreviewFixtureSender.isActive { return UIPreviewFixtureSender() }
            // A local server check: signed and authorized by the server, never pushed to any loop.
            if RemoteCommandCenter.isDryRun {
                return DryRunRemoteCommandSender(
                    patientID: patientID,
                    patientName: self?.names[patientID.lowercased()] ?? patientName,
                    api: apiClient,
                    biometrics: LocalAuthenticationGate(),
                    signer: signer,
                    deviceID: DeviceIDStore.shared.deviceID,
                    pendingStore: pendingStore,
                    notifier: notifier,
                    driver: MainActor.assumeIsolated({ toLoop() }) ? "LOOP" : "TRIO"
                )
            }
            #endif
            if MainActor.assumeIsolated({ toLoop() }) {
                return LoopRemoteCommandSender(
                    patientID: patientID,
                    api: apiClient,
                    settingsStore: loopSettingsStore,
                    transport: URLSessionAPNsTransport(),
                    biometrics: LocalAuthenticationGate(),
                    identity: .current(),
                    deviceID: DeviceIDStore.shared.deviceID,
                    pushToken: pushToken,
                    pendingStore: pendingStore,
                    notifier: notifier,
                    replies: .shared,
                    patientName: self?.names[patientID.lowercased()] ?? patientName,
                    signer: signer
                )
            }
            return RemoteCommandSender(
                patientID: patientID,
                api: apiClient,
                settingsStore: settingsStore,
                transport: URLSessionAPNsTransport(),
                biometrics: LocalAuthenticationGate(),
                identity: .current(),
                deviceID: DeviceIDStore.shared.deviceID,
                pushToken: pushToken,
                pendingStore: pendingStore,
                notifier: notifier,
                patientName: self?.names[patientID.lowercased()] ?? patientName,
                signer: signer
            )
        }
        // The signing challenge is fetched as soon as a confirmation opens.
        if let signer { flow.prepareSigning = { await signer.prepare(patientID: patientID) } }
        flows[cacheKey] = flow
        return flow
    }

    #if DEBUG
    /// GLUCOMIND_REMOTE_DRY_RUN=1 (Debug, simulator against a local server): remote commands go through the server's
    /// signature check and authorization, then stop; nothing is pushed to APNs or any loop.
    static var isDryRun: Bool { ProcessInfo.processInfo.environment["GLUCOMIND_REMOTE_DRY_RUN"] == "1" }
    #endif

    /// A command of some patient is being sent (Face ID, the server, the push to Trio): nothing may interrupt it.
    var isSending: Bool {
        flows.values.contains { $0.state == .sending }
    }

    private var idleActions: [() -> Void] = []
    private var idleWatch: AnyCancellable?

    /// Runs `action` now, or once no command is being sent any more (a notification's screen waits for the send).
    func whenNotSending(_ action: @escaping () -> Void) {
        guard isSending else {
            action()
            return
        }
        idleActions.append(action)
        guard idleWatch == nil else { return }
        // `$state` publishes before the change: read the flows again on the next turn of the run loop.
        idleWatch = Publishers.MergeMany(flows.values.map { $0.$state.map { _ in () } })
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { @MainActor in self?.runIdleActionsIfNotSending() }
            }
    }

    private func runIdleActionsIfNotSending() {
        guard !isSending, !idleActions.isEmpty else { return }
        let actions = idleActions
        idleActions = []
        idleWatch = nil
        actions.forEach { $0() }
    }

    /// The patient of the command still waiting for Trio's answer (a tap on Trio's own notification opens their Bolus
    /// tab).
    var pendingCommandPatientID: String? {
        pendingStore.pending?.patientID
    }

    /// A push arrived or was tapped; true when it was Trio's answer.
    @discardableResult
    func handle(userInfo: [AnyHashable: Any], key: String?, deliveredAt: Date?) async -> Bool {
        guard let replyHandler else { return TrioReply.parse(userInfo: userInfo) != nil }
        return await replyHandler.handle(userInfo: userInfo, key: key, deliveredAt: deliveredAt)
    }

    /// Answers Trio delivered while the app was in the background.
    func collectDeliveredAnswers() async {
        guard pendingStore.pending != nil else { return }
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        for notification in delivered.sorted(by: { $0.date < $1.date }) {
            let userInfo = notification.request.content.userInfo
            guard TrioReply.parse(userInfo: userInfo) != nil else { continue }
            await handle(userInfo: userInfo, key: notification.request.identifier, deliveredAt: notification.date)
        }
    }
}
