import Foundation

/// Loop's answers to this phone's pushes, handed from the push handler to a sender waiting for them (a meal's bolus
/// goes only after Loop confirmed its carbs).
@MainActor
public final class LoopReplyWaiter {
    public static let shared = LoopReplyWaiter()

    private var waiting: [String: CheckedContinuation<LoopReply?, Never>] = [:]
    /// Answers that came before anyone waited for them (Loop can answer within a second), kept for a while.
    private var early: [String: (reply: LoopReply, at: Date)] = [:]
    private static let earlyKept: TimeInterval = 120

    public init() {}

    /// Loop's answer to this command's `step`, or nil when none came within `timeout`.
    public func wait(commandID: String, step: LoopCommandStep, timeout: TimeInterval) async -> LoopReply? {
        let key = Self.key(commandID, step)
        if let kept = early.removeValue(forKey: key), Date().timeIntervalSince(kept.at) <= Self.earlyKept { return kept.reply }
        return await withCheckedContinuation { continuation in
            waiting[key]?.resume(returning: nil)
            waiting[key] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.waiting.removeValue(forKey: key)?.resume(returning: nil)
            }
        }
    }

    /// True when a sender was waiting for it; otherwise it is kept for the next wait.
    @discardableResult
    public func deliver(_ reply: LoopReply, commandID: String) -> Bool {
        let key = Self.key(commandID, reply.step)
        guard let continuation = waiting.removeValue(forKey: key) else {
            early = early.filter { Date().timeIntervalSince($0.value.at) <= Self.earlyKept }
            early[key] = (reply, Date())
            return false
        }
        continuation.resume(returning: reply)
        return true
    }

    public func isWaiting(commandID: String, step: LoopCommandStep) -> Bool {
        waiting[Self.key(commandID, step)] != nil
    }

    private static func key(_ commandID: String, _ step: LoopCommandStep) -> String { "\(commandID.lowercased()):\(step.rawValue)" }
}

public extension Notification.Name {
    /// A meal's bolus push left this phone for Loop (object: the command id, lowercased): the Bolus tab's steps move on.
    static let loopBolusPushSent = Notification.Name("loopBolusPushSent")
}

/// Sends a command to the patient's Loop (loop-support-plan.md, stage 3). The steps every command shares are
/// RemoteCommandPipeline's; this is Loop's part: its settings and address, the one-time passwords, and a meal as two
/// pushes: the carbs, then the bolus only once Loop confirmed the carbs. Insulin in Loop without its carbs is the worse
/// half to be left with, so a bolus never goes first and never without that confirmation.
public final class LoopRemoteCommandSender: RemoteCommandSending {
    private let patientID: String
    private let api: RemoteCommandsAPI
    private let settingsStore: LoopRemoteSettingsStore
    private let transport: APNsTransport
    private let identity: GlucoMindPushIdentity
    private let pushToken: @MainActor () -> String?
    private let pendingStore: PendingRemoteCommandStore
    private let notifier: RemoteCommandNotifier
    private let replies: LoopReplyWaiter
    private let now: () -> Date
    private let sleep: (TimeInterval) async -> Void
    private let pipeline: RemoteCommandPipeline
    private let carbsConfirmationTimeout: TimeInterval

    /// How long the meal's bolus waits for Loop to confirm its carbs.
    public nonisolated static let carbsConfirmationTimeout: TimeInterval = 90
    /// A confirmation later than this after the carbs were sent no longer starts the bolus (the app may have been in the
    /// background meanwhile): the caregiver decides again.
    public nonisolated static let bolusLatestAfterCarbs: TimeInterval = 150

    private static let loopNames = LoopSystemKind.loop.names

    public init(
        patientID: String,
        api: RemoteCommandsAPI,
        settingsStore: LoopRemoteSettingsStore,
        transport: APNsTransport,
        biometrics: BiometricGate,
        identity: GlucoMindPushIdentity,
        deviceID: String,
        pushToken: @escaping @MainActor () -> String?,
        pendingStore: PendingRemoteCommandStore,
        notifier: RemoteCommandNotifier,
        replies: LoopReplyWaiter,
        patientName: String? = nil,
        signer: RemoteCommandSigning? = nil,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (TimeInterval) async -> Void = { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) },
        carbsConfirmationTimeout: TimeInterval = LoopRemoteCommandSender.carbsConfirmationTimeout
    ) {
        self.carbsConfirmationTimeout = carbsConfirmationTimeout
        self.patientID = patientID
        self.api = api
        self.settingsStore = settingsStore
        self.transport = transport
        self.identity = identity
        self.pushToken = pushToken
        self.pendingStore = pendingStore
        self.notifier = notifier
        self.replies = replies
        self.now = now
        self.sleep = sleep
        pipeline = RemoteCommandPipeline(patientID: patientID, patientName: patientName, api: api, biometrics: biometrics, signer: signer, deviceID: deviceID, pendingStore: pendingStore, notifier: notifier, loopNames: Self.loopNames, now: now)
    }

    public func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        let ignoresReplies: Bool
        switch await pipeline.waitForEarlierCommand() {
        case let .refused(message): return .notSent(message)
        case let .free(ignores): ignoresReplies = ignores
        }

        // 1. This phone's settings and limits.
        guard var settings = (try? settingsStore.load(patientID: patientID)) ?? nil else {
            return .notSent("Uzupełnij ustawienia zdalnego sterowania Loopa (koło zębate → Zdalne sterowanie Loop).")
        }
        if let problem = settings.problems(loop: nil).first(where: { !$0.hasPrefix("Wpisz Team ID") }) {
            return .notSent(problem)
        }
        if draft.carbsG < 0 || draft.insulinU < 0 || (draft.carbsG == 0 && draft.insulinU == 0) {
            return .notSent("Podaj węglowodany i/lub insulinę.")
        }
        if let problem = settings.limitProblem(carbsG: draft.carbsG, insulinU: draft.insulinU) {
            return .notSent(problem)
        }
        let bolusStep = draft.pumpBolusStep ?? settings.bolusIncrement
        if RemoteCommandFormat.roundDown(draft.insulinU, step: bolusStep) != draft.insulinU {
            return .notSent("Dawka musi być wielokrotnością kroku pompy (\(RemoteCommandFormat.units(bolusStep)) j).")
        }
        guard let token = await pushToken(), !token.isEmpty else {
            return .notSent("Mellis nie ma jeszcze adresu powiadomień: Loop nie mógłby odpowiedzieć. Włącz powiadomienia dla aplikacji Mellis.")
        }

        // 2. Where Loop is, and that it is this patient's Loop.
        let target: LoopRemoteTarget
        do {
            let response = try await api.getLoopRemoteTarget(patientID: patientID)
            guard response.patient_id.lowercased() == patientID.lowercased() else {
                return .notSent("Serwer podał Loopa innego pacjenta. Nic nie zostało wysłane.")
            }
            target = response.loop
        } catch {
            return .notSent(error.remoteCommandRefusal ?? "Nie udało się sprawdzić Loopa w Nightscout.")
        }
        guard target.isReady else { return .notSent(target.summary) }
        guard let loopTeam = settings.loopTeamID(target: target) else {
            return .notSent("Wpisz Team ID konta Apple, które zbudowało Loopa (ustawienia zdalnego sterowania).")
        }
        if let loopMax = target.max_bolus_u, draft.insulinU > loopMax {
            return .notSent("\(RemoteCommandFormat.units(draft.insulinU)) j to więcej niż maksymalny bolus w Loopie (\(RemoteCommandFormat.units(loopMax)) j).")
        }
        let pin = LoopPatientGuard.pin(settings: settings, target: target, patientID: patientID, store: settingsStore)
        if let problem = LoopPatientGuard.message(pin, patientName: pipeline.patientName) {
            return .notSent(problem)
        }
        if pin == .needsConfirmation, let first = PinnedLoop(target: target, teamID: loopTeam, at: now()) {
            settings.pinnedLoop = first
            try? settingsStore.save(settings, patientID: patientID)
        }
        if LoopPatientGuard.secretUsedByOtherPatient(settings.otpURL, patientID: patientID, store: settingsStore) {
            return .notSent(LoopPatientGuard.secretMessage)
        }
        if loopTeam != identity.teamID, settings.returnKeyID == nil {
            return .notSent("Loop jest zbudowany na innym koncie Apple: dodaj klucz APNs konta aplikacji Mellis w ustawieniach.")
        }
        let authToken: APNsAuthToken
        do {
            authToken = try APNsAuthToken(keyID: settings.apnsKeyID, teamID: loopTeam, p8: settings.apnsKeyP8)
        } catch {
            return .notSent("Klucz APNs (.p8) jest niepoprawny.")
        }
        let returnNotification = TrioReturnNotification(
            productionEnvironment: identity.productionEnvironment,
            deviceToken: token,
            bundleId: identity.bundleID,
            teamId: identity.teamID,
            keyId: settings.returnKeyID ?? settings.apnsKeyID,
            apnsKey: settings.returnKeyP8 ?? settings.apnsKeyP8
        )

        // 3–4. Face ID, then the server.
        let command: RemoteCommand
        switch await pipeline.confirmAndAuthorize(draft, bolusStep: bolusStep, driver: "LOOP") {
        case let .authorized(authorized): command = authorized
        case let .stopped(outcome): return outcome
        }
        let carbsAt = draft.carbsG > 0 && draft.mealInMinutes != nil ? command.carbs_at.flatMap(ServerDate.parse) : nil

        // 5. The first push: the carbs (then the bolus), or the bolus alone.
        let first: LoopCommandStep = draft.carbsG > 0 ? .carbs : .bolus
        var pending = PendingRemoteCommand(patientID: patientID, commandID: command.id, carbsG: draft.carbsG, insulinU: draft.insulinU, sentAt: now(), patientName: pipeline.patientName)
        pending.ignoresTrioReplies = ignoresReplies ? true : nil
        pending.driver = "LOOP"
        pending.loopStep = first
        let firstResult = await push(step: first, draft: draft, carbsAt: carbsAt, command: command, settings: &settings, target: target, teamID: loopTeam, authToken: authToken, returnNotification: returnNotification, pending: pending)
        switch firstResult {
        case let .notPrepared(message):
            await pipeline.reportSent(commandID: command.id, accepted: false, message: message)
            return .notSent("\(message) Nic nie zostało wysłane.")
        case let .refused(message):
            pendingStore.pending = nil
            await pipeline.reportSent(commandID: command.id, accepted: false, message: message)
            return .sendFailed(message)
        case .accepted:
            break
        }
        notifier.commandSent(commandID: command.id, patientID: patientID, summary: [draft.notificationSummary, pipeline.patientName].compactMap { $0 }.joined(separator: " · "))
        notifier.scheduleNoReply(commandID: command.id, patientID: patientID, after: RemoteCommandPipeline.replyTimeout)
        let reported = await pipeline.reportSent(commandID: command.id, accepted: true, message: nil)
        guard first == .carbs, draft.insulinU > 0 else { return .sent(reported ?? command) }

        // 6. The meal's bolus, once Loop confirmed the carbs: on its own, so the screen follows the command from the
        // carbs on (the server's SENT and Loop's "carbs stored") instead of waiting for the whole meal.
        let carbsSentAt = pending.sentAt
        let mealSettings = settings
        bolusTask = Task { @MainActor [self] in
            var settings = mealSettings
            await sendMealBolus(draft: draft, command: command, pending: pending, carbsSentAt: carbsSentAt, settings: &settings, target: target, teamID: loopTeam, authToken: authToken, returnNotification: returnNotification)
        }
        return .sent(reported ?? command)
    }

    /// The meal's bolus still on its way after `send` returned (tests wait for it).
    public private(set) var bolusTask: Task<Void, Never>?

    private func sendMealBolus(draft: RemoteCommandDraft, command: RemoteCommand, pending: PendingRemoteCommand, carbsSentAt: Date, settings: inout LoopRemoteSettings, target: LoopRemoteTarget, teamID: String, authToken: APNsAuthToken, returnNotification: TrioReturnNotification) async {
        let confirmation = await replies.wait(commandID: command.id, step: .carbs, timeout: carbsConfirmationTimeout)
        guard let confirmation, confirmation.success else {
            if confirmation == nil { await withholdBolus(command: command, pending: pending, reason: "Loop nie potwierdził węglowodanów w \(Int(carbsConfirmationTimeout)) s") }
            // A refusal of the carbs settled the command already (the push handler reported it).
            return
        }
        guard now().timeIntervalSince(carbsSentAt) <= Self.bolusLatestAfterCarbs else {
            await withholdBolus(command: command, pending: pending, reason: "Loop potwierdził węglowodany za późno")
            return
        }
        var bolusPending = pendingStore.pending ?? pending
        bolusPending.loopStep = .bolus
        switch await push(step: .bolus, draft: draft, carbsAt: nil, command: command, settings: &settings, target: target, teamID: teamID, authToken: authToken, returnNotification: returnNotification, pending: bolusPending) {
        case .accepted:
            NotificationCenter.default.post(name: .loopBolusPushSent, object: command.id.lowercased())
        case let .notPrepared(message), let .refused(message):
            // The carbs are in Loop, the bolus never left: said so, and the meal's bolus can be retried.
            _ = try? await api.reportRemoteCommandReply(patientID: patientID, commandID: command.id, success: false, message: "Bolus nie został wysłany: \(message)", step: .bolus)
        }
    }

    private enum PushResult: Equatable {
        case accepted
        /// Nothing left the phone (no password, the request could not be built).
        case notPrepared(String)
        /// APNs refused it.
        case refused(String)
    }

    /// One push with a password Loop has not seen from this phone (the next period's when the current one is used).
    private func push(step: LoopCommandStep, draft: RemoteCommandDraft, carbsAt: Date?, command: RemoteCommand, settings: inout LoopRemoteSettings, target: LoopRemoteTarget, teamID: String, authToken: APNsAuthToken, returnNotification: TrioReturnNotification, pending: PendingRemoteCommand) async -> PushResult {
        var password = settings.unusedPassword(at: now())
        if password == nil {
            let periodEnd = Double(LoopOTP.counter(at: now()) + 1) * LoopOTP.period
            await sleep(max(0, periodEnd - now().timeIntervalSince1970) + 0.5)
            password = settings.unusedPassword(at: now())
        }
        guard let password else { return .notPrepared("Brak nowego kodu jednorazowego.") }
        settings.markUsed(counter: password.counter)
        try? settingsStore.save(settings, patientID: patientID)
        let request: URLRequest
        do {
            request = try LoopCommandRequestBuilder.request(step: step, carbsG: draft.carbsG, insulinU: draft.insulinU, carbsAt: carbsAt, otp: password.password, commandID: command.id, returnNotification: returnNotification, target: target, teamID: teamID, authToken: authToken, now: now())
        } catch {
            return .notPrepared("Nie udało się przygotować polecenia.")
        }
        // Recorded before sending: Loop may answer within a second.
        var sent = pending
        sent.loopStep = step
        sent.loopStepSentAt = now()
        pendingStore.pending = sent
        let result: APNsSendResult
        do {
            let (status, body) = try await transport.send(request)
            result = APNsSendResult(status: status, body: body)
        } catch {
            // No answer from APNs: the push may or may not have left. Treated as sent, so nobody resends blindly.
            result = .accepted
        }
        if case .refused = result { return .refused(result.message) }
        return .accepted
    }

    /// The meal's bolus is not sent: the caregiver is told, and Loop's late "carbs stored" settles it as carbs without
    /// the bolus (TrioReplyHandler).
    private func withholdBolus(command: RemoteCommand, pending: PendingRemoteCommand, reason: String) async {
        var withheld = pendingStore.pending ?? pending
        guard withheld.commandID == command.id else { return }
        withheld.bolusWithheld = true
        pendingStore.pending = withheld
        // The server and the other caregivers learn it too: no bolus left, so nobody reads "it may have been given".
        _ = try? await api.reportLoopBolusWithheld(patientID: patientID, commandID: command.id, message: reason)
        notifier.commandFinished(
            commandID: command.id,
            patientID: patientID,
            title: "⚠️ Bolus nie został wysłany\(pipeline.patientName.map { " · \($0)" } ?? "")",
            body: "\(reason): bolusu \(RemoteCommandFormat.units(command.insulin_u)) j nie wysłano. Sprawdź w Loopie, czy węglowodany są zapisane, zanim podasz bolus."
        )
    }
}
