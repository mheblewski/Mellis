import Foundation
import LocalAuthentication
import UserNotifications

// Sending one confirmed meal/bolus to Trio (remote-bolus-trio-plan.md W4–W6). The order is fixed: phone limits →
// Face ID / Touch ID → the server's authorization (switches, safety checks, one command at a time) → the APNs push →
// the reports. Nothing reaches Trio unless every step passed.

/// Sends one APNs request. The real one is used only by the app after the caregiver confirmed; tests use a recorder.
public protocol APNsTransport {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

public struct URLSessionAPNsTransport: APNsTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        // URLSession speaks HTTP/2 to APNs on its own.
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

public enum BiometricResult: Equatable {
    case confirmed
    case refused(String)
}

public protocol BiometricGate {
    func confirm(reason: String) async -> BiometricResult
}

/// Face ID or Touch ID only: no fallback to the phone's passcode (W5).
public struct LocalAuthenticationGate: BiometricGate {
    public init() {}

    public func confirm(reason: String) async -> BiometricResult {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .refused(Self.message(for: error))
        }
        do {
            let passed = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            return passed ? .confirmed : .refused("Nie potwierdzono tożsamości.")
        } catch {
            return .refused(Self.message(for: error as NSError))
        }
    }

    private static func message(for error: NSError?) -> String {
        switch error.flatMap({ LAError.Code(rawValue: $0.code) }) {
        case .biometryNotEnrolled:
            return "Face ID / Touch ID nie jest skonfigurowane na tym telefonie."
        case .biometryNotAvailable:
            return "Face ID / Touch ID jest niedostępne (sprawdź zgodę w Ustawieniach iOS)."
        case .biometryLockout:
            return "Face ID / Touch ID jest zablokowane. Odblokuj telefon kodem i spróbuj ponownie."
        case .userCancel, .appCancel, .systemCancel:
            return "Anulowano."
        default:
            return "Nie potwierdzono tożsamości."
        }
    }
}

/// What the caregiver confirmed.
public struct RemoteCommandDraft: Equatable {
    public let source: RemoteCommandSource
    public let carbsG: Int
    public let insulinU: Decimal
    public let conversationID: String?
    public let proposalID: String?
    public let meal: RemoteCommandMeal?
    public let followsCommandID: String?
    /// Warning keys the confirmation showed.
    public let acknowledgedWarnings: [String]
    /// When the data the caregiver confirmed were checked: the command's timestamp, so Trio refuses it when a bolus was
    /// given since then.
    public let confirmedAt: Date?
    /// The pump's step Trio reports (from the check the caregiver confirmed); nil: this phone's setting.
    public let pumpBolusStep: Decimal?
    /// The WBT window's meal: the command is that meal's WBT.
    public let wbtMealID: String?
    /// The planned second part of a split meal bolus.
    public let plannedBolusID: String?
    /// Rescue carbs: the alert or chat card they answer.
    public var rescueAlertID: String? = nil
    public var rescueProposalID: String? = nil
    /// "Przypomnij" in the Bolus tab: what to remind about after this bolus.
    public var reminders: [BolusReminder] = []
    /// "+15 min" in the Bolus tab: the meal is eaten this many minutes from now (carbs dated then in Trio).
    public var mealInMinutes: Int? = nil
    /// "Zapisz jako posiłek" in the Bolus tab: the dose becomes a meal of the Meals journal.
    public var createMeal = false
    /// The separate low-glucose alert confirmed insulin while glucose is below 70 or a low is near.
    public var lowGlucoseConfirmed = false

    public init(source: RemoteCommandSource, carbsG: Int, insulinU: Decimal, conversationID: String? = nil, proposalID: String? = nil, meal: RemoteCommandMeal? = nil, followsCommandID: String? = nil, acknowledgedWarnings: [String], confirmedAt: Date? = nil, pumpBolusStep: Decimal? = nil, wbtMealID: String? = nil, plannedBolusID: String? = nil) {
        self.confirmedAt = confirmedAt
        self.wbtMealID = wbtMealID
        self.plannedBolusID = plannedBolusID
        self.pumpBolusStep = pumpBolusStep
        self.followsCommandID = followsCommandID
        self.source = source
        self.carbsG = carbsG
        self.insulinU = insulinU
        self.conversationID = conversationID
        self.proposalID = proposalID
        self.meal = meal
        self.acknowledgedWarnings = acknowledgedWarnings
    }

    /// "4,6 j insuliny i 46 g węglowodanów": the insulin first, as the notification says it.
    public var notificationSummary: String {
        var parts: [String] = []
        if insulinU > 0 { parts.append("\(RemoteCommandFormat.units(insulinU)) j insuliny") }
        if carbsG > 0 { parts.append("\(carbsG) g węglowodanów") }
        return parts.joined(separator: " i ")
    }

    /// "46 g węglowodanów i 4,6 j insuliny"
    public var summary: String {
        var parts: [String] = []
        if carbsG > 0 { parts.append("\(carbsG) g węglowodanów") }
        if insulinU > 0 { parts.append("\(RemoteCommandFormat.units(insulinU)) j insuliny") }
        return parts.joined(separator: " i ")
    }
}

public enum RemoteSendOutcome: Equatable {
    /// APNs took the push: Trio's answer comes later.
    case sent(RemoteCommand)
    /// Nothing left the phone (limits, settings, biometrics, the server's refusal, the deadline).
    case notSent(String)
    /// The push was refused by APNs.
    case sendFailed(String)
    /// Nothing left the phone: the server refused the chat card as expired (PROPOSAL_EXPIRED).
    case proposalExpired(String)
}

/// The command waiting for Trio's answer on this phone. Trio 1.0 does not echo our command id, so its answer is matched
/// to the one command this phone has in flight (the server allows only one per patient).
public struct PendingRemoteCommand: Codable, Equatable {
    public let patientID: String
    public let commandID: String
    public let carbsG: Int
    public let insulinU: Decimal
    public let sentAt: Date
    /// The caregiver was already told the final answer (its report to the server is still being retried).
    public var finalNotified: Bool
    /// Named in the result notification, so a caregiver of several patients knows whose dose it was.
    public var patientName: String? = nil
    /// Sent while another patient's command had no answer: Trio's answers carry no patient, so none is taken for this
    /// one (Nightscout decides its result). Optional: older stored values have no such key.
    public var ignoresTrioReplies: Bool? = nil
    /// TRIO or LOOP; nil (older stored values): Trio.
    public var driver: String? = nil
    /// Loop: the push Loop answers next (carbs, then bolus). Nil for Trio.
    public var loopStep: LoopCommandStep? = nil
    /// Loop: the bolus of this meal was not sent (Loop did not confirm the carbs in time); a late confirmation of the
    /// carbs then settles the command as "carbs stored, bolus not given".
    public var bolusWithheld: Bool? = nil
    /// Loop: when the push of `loopStep` left. Loop's answers name no command, so an answer older than that push
    /// (a late answer to an earlier command) is not this one's.
    public var loopStepSentAt: Date? = nil

    public var isLoop: Bool { driver == "LOOP" }
    /// The loop's name for the caregiver's messages.
    public var loopNames: LoopSystemNames { (isLoop ? LoopSystemKind.loop : .trio).names }

    public init(patientID: String, commandID: String, carbsG: Int, insulinU: Decimal, sentAt: Date, finalNotified: Bool = false, patientName: String? = nil) {
        self.patientName = patientName
        self.patientID = patientID
        self.commandID = commandID
        self.carbsG = carbsG
        self.insulinU = insulinU
        self.sentAt = sentAt
        self.finalNotified = finalNotified
    }
}

public protocol PendingRemoteCommandStore: AnyObject {
    var pending: PendingRemoteCommand? { get set }
    /// Trio answers (delivered notifications) already reported, kept across launches.
    var handledReplyKeys: [String] { get set }
}

public final class UserDefaultsPendingRemoteCommandStore: PendingRemoteCommandStore {
    private let defaults: UserDefaults
    private let key = "gluco.remoteCommand.pending"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var pending: PendingRemoteCommand? {
        get { defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(PendingRemoteCommand.self, from: $0) } }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                defaults.set(data, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }

    public var handledReplyKeys: [String] {
        get { defaults.stringArray(forKey: "gluco.remoteCommand.handledReplies") ?? [] }
        set { defaults.set(Array(newValue.suffix(100)), forKey: "gluco.remoteCommand.handledReplies") }
    }
}

/// The caregiver-facing notifications of a command (W6).
public protocol RemoteCommandNotifier {
    func commandSent(commandID: String, patientID: String, summary: String)
    func scheduleNoReply(commandID: String, patientID: String, after seconds: TimeInterval)
    func cancelNoReply(commandID: String)
    /// Replaces the "sent" notification with the result (one notification per command).
    func commandFinished(commandID: String, patientID: String, title: String, body: String)
    /// Trio's own (English) notifications already handled leave the notification list.
    func removeDelivered(identifiers: [String])
}

public struct UserNotificationsRemoteCommandNotifier: RemoteCommandNotifier {
    public init() {}

    public func commandSent(commandID: String, patientID: String, summary: String) {
        post(id: "remote-command-\(commandID)", patientID: patientID, title: "⏱️ Polecenie wysłane", body: "Czekam na odpowiedź \(loopNames(commandID).genitive) · \(summary)")
    }

    public func scheduleNoReply(commandID: String, patientID: String, after seconds: TimeInterval) {
        let content = UNMutableNotificationContent()
        content.title = "Brak odpowiedzi z \(loopNames(commandID).genitive)"
        content.body = "Nie wysyłaj ponownie. Sprawdź telefon pacjenta lub Nightscout."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.userInfo = AppRoute.remoteCommandPayload(patientID: patientID)
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "remote-noreply-\(commandID)", content: content, trigger: trigger))
    }

    public func cancelNoReply(commandID: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["remote-noreply-\(commandID)"])
    }

    public func commandFinished(commandID: String, patientID: String, title: String, body: String) {
        // The same identifier: the result takes the place of "Polecenie wysłane" instead of queueing behind it.
        post(id: "remote-command-\(commandID)", patientID: patientID, title: title, body: body)
    }

    public func removeDelivered(identifiers: [String]) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    /// The loop of the command this phone just sent (recorded before the push, so before these notifications).
    private func loopNames(_ commandID: String) -> LoopSystemNames {
        let pending = UserDefaultsPendingRemoteCommandStore().pending
        return pending?.commandID == commandID ? pending!.loopNames : LoopSystemKind.trio.names
    }

    /// A tap opens the patient's Bolus tab (AppRoute.remoteCommands).
    private func post(id: String, patientID: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.userInfo = AppRoute.remoteCommandPayload(patientID: patientID)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}

public enum RemoteCommandFormat {
    /// "2:10": minutes and seconds left.
    public static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.up)))
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }

    /// "07:05": a clock time, 24 h in Polish whatever the phone's region (as everywhere in the app).
    public static func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// "21 paź, 07:05": a day and its time.
    public static func dayAndTime(_ date: Date) -> String {
        "\(dayFormatter.string(from: date)), \(time(date))"
    }

    /// "21 paź 2026": a day.
    public static func day(_ date: Date) -> String {
        dayYearFormatter.string(from: date)
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()

    private static let dayYearFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.setLocalizedDateFormatFromTemplate("d MMM y")
        return formatter
    }()

    public static func units(_ value: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        return formatter.string(from: value as NSDecimalNumber) ?? "\(value)"
    }

    public static func units(_ value: Double) -> String {
        units(Decimal(value))
    }

    /// What a typed amount may be: digits only for carbs; digits and one decimal separator (a comma, two places) for
    /// insulin; at most 6 characters. Whatever the system keypad or a paste gives.
    public static func sanitizedAmount(_ raw: String, decimal: Bool) -> String {
        var result = ""
        var hasSeparator = false
        var decimals = 0
        for character in raw {
            if character.isASCII, character.isNumber {
                if hasSeparator {
                    guard decimals < 2 else { continue }
                    decimals += 1
                }
                result.append(character)
            } else if decimal, character == "," || character == ".", !hasSeparator {
                hasSeparator = true
                result.append(result.isEmpty ? "0," : ",")
            }
        }
        return String(result.prefix(6))
    }

    /// Rounds down to the pump step (as the server does).
    public static func roundDown(_ value: Decimal, step: Decimal) -> Decimal {
        guard value > 0, step > 0 else { return 0 }
        var steps = value / step
        var floored = Decimal()
        NSDecimalRound(&floored, &steps, 0, .down)
        return floored * step
    }
}

@MainActor
/// What sends a command (the real sender; in debug UI previews a stand-in that only pretends Trio's steps).
public protocol RemoteCommandSending {
    func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome
}

public final class RemoteCommandSender: RemoteCommandSending {
    private let patientID: String
    private let api: RemoteCommandsAPI
    private let settingsStore: TrioRemoteSettingsStore
    private let transport: APNsTransport
    private let biometrics: BiometricGate
    private let identity: GlucoMindPushIdentity
    private let deviceID: String
    private let pushToken: @MainActor () -> String?
    private let pendingStore: PendingRemoteCommandStore
    private let notifier: RemoteCommandNotifier
    private let now: () -> Date
    /// The patient's name, said in Face ID's question and the notifications.
    private let patientName: String?
    /// Device mode: signs each command with the bolus key (Face ID) instead of the separate Face ID check.
    private let signer: RemoteCommandSigning?
    private var pipeline: RemoteCommandPipeline {
        RemoteCommandPipeline(patientID: patientID, patientName: patientName, api: api, biometrics: biometrics, signer: signer, deviceID: deviceID, pendingStore: pendingStore, notifier: notifier, loopNames: LoopSystemKind.trio.names, now: now)
    }

    public static let replyTimeout: TimeInterval = RemoteCommandPipeline.replyTimeout
    public static let lockTimeout: TimeInterval = RemoteCommandPipeline.lockTimeout

    static func clock(_ seconds: TimeInterval) -> String { RemoteCommandFormat.clock(seconds) }

    public init(
        patientID: String,
        api: RemoteCommandsAPI,
        settingsStore: TrioRemoteSettingsStore,
        transport: APNsTransport,
        biometrics: BiometricGate,
        identity: GlucoMindPushIdentity,
        deviceID: String,
        pushToken: @escaping @MainActor () -> String?,
        pendingStore: PendingRemoteCommandStore,
        notifier: RemoteCommandNotifier,
        patientName: String? = nil,
        signer: RemoteCommandSigning? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.patientName = patientName
        self.signer = signer
        self.patientID = patientID
        self.api = api
        self.settingsStore = settingsStore
        self.transport = transport
        self.biometrics = biometrics
        self.identity = identity
        self.deviceID = deviceID
        self.pushToken = pushToken
        self.pendingStore = pendingStore
        self.notifier = notifier
        self.now = now
    }

    public func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        // 0. This phone still waits for Trio's answer to an earlier command: Trio 1.0 answers without our command id, so a
        // second command would take the first one's answer. Released once the server knows the final state or that Trio
        // did not answer in time (NO_REPLY): from then on the server's own checks decide (a remote bolus that MAY have
        // been given must be acknowledged there), and the phone never stays locked for longer than Trio's answer takes.
        let ignoresTrioReplies: Bool
        switch await pipeline.waitForEarlierCommand() {
        case let .refused(message): return .notSent(message)
        case let .free(ignoresReplies): ignoresTrioReplies = ignoresReplies
        }

        // 1. This phone's settings and limits.
        guard let settings = (try? settingsStore.load(patientID: patientID)) ?? nil else {
            return .notSent("Uzupełnij ustawienia zdalnego sterowania Trio (koło zębate → Zdalne sterowanie Trio).")
        }
        if let problem = settings.problems(trio: nil).first {
            return .notSent(problem)
        }
        if draft.carbsG < 0 || draft.insulinU < 0 || (draft.carbsG == 0 && draft.insulinU == 0) {
            return .notSent("Podaj węglowodany i/lub insulinę.")
        }
        if draft.insulinU > settings.maxBolusUnits {
            return .notSent("\(RemoteCommandFormat.units(draft.insulinU)) j przekracza limit na tym telefonie (\(RemoteCommandFormat.units(settings.maxBolusUnits)) j).")
        }
        if draft.carbsG > settings.maxCarbsGrams {
            return .notSent("\(draft.carbsG) g przekracza limit na tym telefonie (\(settings.maxCarbsGrams) g).")
        }
        let bolusStep = draft.pumpBolusStep ?? settings.bolusIncrement
        if RemoteCommandFormat.roundDown(draft.insulinU, step: bolusStep) != draft.insulinU {
            return .notSent("Dawka musi być wielokrotnością kroku pompy (\(RemoteCommandFormat.units(bolusStep)) j).")
        }
        guard let token = pushToken(), !token.isEmpty else {
            return .notSent("Mellis nie ma jeszcze adresu powiadomień: Trio nie mogłoby odpowiedzieć. Włącz powiadomienia dla Mellisa.")
        }

        // 2. Where Trio is, and that it is this patient's Trio: the one the caregiver confirmed for this patient, no other
        // patient's on this phone, and a Shared Secret no other patient here has (Trio decrypts only with its own).
        let target: TrioRemoteTarget
        do {
            let response = try await api.getTrioRemoteTarget(patientID: patientID)
            guard response.patient_id.lowercased() == patientID.lowercased() else {
                return .notSent("Serwer podał Trio innego pacjenta. Nic nie zostało wysłane.")
            }
            target = response.trio
        } catch {
            return .notSent(error.remoteCommandRefusal ?? "Nie udało się sprawdzić Trio w Nightscout.")
        }
        guard target.isReady, let trioTeam = target.team_id else {
            return .notSent(target.summary)
        }
        let pin = TrioPatientGuard.pin(settings: settings, target: target, patientID: patientID, store: settingsStore)
        if let problem = TrioPatientGuard.message(pin, patientName: patientName) {
            return .notSent(problem)
        }
        if pin == .needsConfirmation, let first = PinnedTrio(target: target, at: now()) {
            // Settings saved before Trio was remembered: this patient's Trio from now on.
            var remembered = settings
            remembered.pinnedTrio = first
            try? settingsStore.save(remembered, patientID: patientID)
        }
        if TrioPatientGuard.secretUsedByOtherPatient(settings.sharedSecret, patientID: patientID, store: settingsStore) {
            return .notSent(TrioPatientGuard.secretMessage)
        }
        if trioTeam != identity.teamID, settings.returnKeyID == nil {
            return .notSent("Trio jest zbudowane na innym koncie Apple: dodaj klucz APNs konta aplikacji Mellis w ustawieniach.")
        }
        let authToken: APNsAuthToken
        do {
            authToken = try APNsAuthToken(keyID: settings.apnsKeyID, teamID: trioTeam, p8: settings.apnsKeyP8)
        } catch {
            return .notSent("Klucz APNs (.p8) jest niepoprawny.")
        }

        // 3–4. Face ID, then the server's authorization (switches, fresh safety checks, one command at a time).
        let command: RemoteCommand
        switch await pipeline.confirmAndAuthorize(draft, bolusStep: bolusStep, driver: "TRIO") {
        case let .authorized(authorized): command = authorized
        case let .stopped(outcome): return outcome
        }

        // 5. The push.
        let request: URLRequest
        do {
            let payload = TrioCommandPayload(
                user: "Mellis",
                commandType: draft.carbsG > 0 ? .meal : .bolus,
                // The confirmed data's time (Trio refuses the command if a bolus came after it), kept within Trio's
                // 10-minute window.
                timestamp: max(draft.confirmedAt ?? now(), now().addingTimeInterval(-540)).timeIntervalSince1970,
                bolusAmount: draft.insulinU > 0 ? draft.insulinU : nil,
                carbs: draft.carbsG > 0 ? draft.carbsG : nil,
                // The date the server checked the dose for (its ICR); a server that did not date them leaves them now.
                scheduledTime: draft.carbsG > 0 && draft.mealInMinutes != nil ? command.carbs_at.flatMap(ServerDate.parse)?.timeIntervalSince1970 : nil,
                commandId: command.id,
                returnNotification: TrioReturnNotification(
                    productionEnvironment: identity.productionEnvironment,
                    deviceToken: token,
                    bundleId: identity.bundleID,
                    teamId: identity.teamID,
                    keyId: settings.returnKeyID ?? settings.apnsKeyID,
                    apnsKey: settings.returnKeyP8 ?? settings.apnsKeyP8
                )
            )
            request = try TrioCommandRequestBuilder.request(payload: payload, target: target, sharedSecret: settings.sharedSecret, authToken: authToken, now: now())
        } catch {
            await reportSent(commandID: command.id, accepted: false, message: "Nie udało się przygotować polecenia.")
            return .notSent("Nie udało się przygotować polecenia. Nic nie zostało wysłane.")
        }

        // Recorded before sending: Trio may answer within a second.
        var sentPending = PendingRemoteCommand(patientID: patientID, commandID: command.id, carbsG: draft.carbsG, insulinU: draft.insulinU, sentAt: now(), patientName: patientName)
        sentPending.ignoresTrioReplies = ignoresTrioReplies ? true : nil
        pendingStore.pending = sentPending
        let result: APNsSendResult
        do {
            let (status, body) = try await transport.send(request)
            result = APNsSendResult(status: status, body: body)
        } catch {
            // No answer from APNs: the push may or may not have left. Treated as sent, so nobody resends blindly.
            result = .accepted
        }

        switch result {
        case .accepted:
            notifier.commandSent(commandID: command.id, patientID: patientID, summary: [draft.notificationSummary, patientName].compactMap { $0 }.joined(separator: " · "))
            notifier.scheduleNoReply(commandID: command.id, patientID: patientID, after: Self.replyTimeout)
            let reported = await reportSent(commandID: command.id, accepted: true, message: nil)
            return .sent(reported ?? command)
        case .refused:
            pendingStore.pending = nil
            await reportSent(commandID: command.id, accepted: false, message: result.message)
            return .sendFailed(result.message)
        }
    }

    @discardableResult
    private func reportSent(commandID: String, accepted: Bool, message: String?) async -> RemoteCommand? {
        await pipeline.reportSent(commandID: commandID, accepted: accepted, message: message)
    }
}


/// What every remote command does, whichever loop it goes to: one command at a time on this phone, the caregiver's Face
/// ID, the server's authorization (switches, fresh safety checks) and the "sent" report. The loop's own part (settings,
/// address, the push) is its sender's: RemoteCommandSender (Trio) and LoopRemoteCommandSender (Loop).
struct RemoteCommandPipeline {
    let patientID: String
    let patientName: String?
    let api: RemoteCommandsAPI
    let biometrics: BiometricGate
    /// Device mode: the bolus key signs what was confirmed; its Face ID replaces `biometrics`.
    var signer: RemoteCommandSigning? = nil
    let deviceID: String
    let pendingStore: PendingRemoteCommandStore
    let notifier: RemoteCommandNotifier
    /// The loop's name for the caregiver's messages.
    let loopNames: LoopSystemNames
    let now: () -> Date

    static let replyTimeout: TimeInterval = 180
    /// The longest this phone waits for an earlier command before the next one: the loop's answer time and the server's
    /// grace for an unreported send (then the server says NO_REPLY, or cannot be asked at all).
    static let lockTimeout: TimeInterval = 210
    static let reportAttempts = 3

    enum EarlierCommand: Equatable {
        /// Nothing in the way; `ignoresReplies`: another patient's loop may still answer late, so no answer without our
        /// command id is taken for this command.
        case free(ignoresReplies: Bool)
        case refused(String)
    }

    /// 0. This phone still waits for an answer to an earlier command: an answer without our command id would be taken for
    /// the next one. Released once the server knows the final state or that no answer came in time (NO_REPLY): from then
    /// on the server's own checks decide (a remote bolus that MAY have been given must be acknowledged there), and the
    /// phone never stays locked for longer than an answer takes.
    func waitForEarlierCommand() async -> EarlierCommand {
        guard let pending = pendingStore.pending, now().timeIntervalSince(pending.sentAt) <= TrioReplyHandler.matchWindow else { return .free(ignoresReplies: false) }
        let current = try? await api.getRemoteCommand(patientID: pending.patientID, commandID: pending.commandID)
        let waited = now().timeIntervalSince(pending.sentAt)
        let released = current?.isSettled == true || current?.status == "NO_REPLY" || (current == nil && waited > Self.lockTimeout)
        guard released else {
            let remaining = max(0, Self.lockTimeout - waited)
            let other = pending.patientID.lowercased() != patientID.lowercased()
            return .refused("Poprzednie polecenie\(other ? (pending.patientName.map { " (\($0))" } ?? " innego pacjenta") : "") czeka na odpowiedź \(pending.loopNames.genitive), jeszcze \(RemoteCommandFormat.clock(remaining)).")
        }
        let ignores = current?.isSettled != true && pending.patientID.lowercased() != patientID.lowercased()
        if current?.isSettled == true { notifier.cancelNoReply(commandID: pending.commandID) }
        pendingStore.pending = nil
        return .free(ignoresReplies: ignores)
    }

    enum Authorization {
        case authorized(RemoteCommand)
        case stopped(RemoteSendOutcome)
    }

    /// 3. The caregiver, again: Face ID / Touch ID right before anything is authorized or sent. 4. The server: switches,
    /// fresh safety checks, one command at a time, and the driver of the patient's loop.
    func confirmAndAuthorize(_ draft: RemoteCommandDraft, bolusStep: Decimal, driver: String) async -> Authorization {
        // Device mode: the bolus key signs the exact amounts for the patient the server names, and the key itself asks
        // for Face ID (one prompt, enforced by the server's signature check). A new challenge every time: a refused
        // command (409 REMOTE_COMMAND_WARNINGS_CHANGED included) has used its challenge up.
        var signed: SignedRemoteCommand?
        if let signer {
            do {
                signed = try await signer.signRemoteCommand(patientID: patientID, insulinU: draft.insulinU, carbsG: draft.carbsG)
            } catch let error as RemoteCommandSigningError {
                return .stopped(.notSent(error.message))
            } catch {
                return .stopped(.notSent("Nie udało się podpisać polecenia. Nic nie zostało wysłane."))
            }
        } else {
            switch await biometrics.confirm(reason: patientName.map { "\($0): podać \(draft.summary)?" } ?? "Podać \(draft.summary)?") {
            case .confirmed:
                break
            case let .refused(message):
                return .stopped(.notSent(message))
            }
        }

        let command: RemoteCommand
        do {
            var request = RemoteCommandAuthorizeRequest(
                source: draft.source,
                carbs_g: draft.carbsG,
                insulin_u: draft.insulinU,
                bolus_step: bolusStep,
                device_id: deviceID,
                conversation_id: draft.conversationID,
                proposal_id: draft.proposalID,
                follows_command_id: draft.followsCommandID,
                meal: draft.carbsG > 0 ? draft.meal : nil,
                wbt_meal_id: draft.wbtMealID,
                planned_bolus_id: draft.plannedBolusID,
                acknowledged_warnings: draft.acknowledgedWarnings
            )
            request.rescue_alert_id = draft.rescueAlertID
            request.rescue_proposal_id = draft.rescueProposalID
            // Every chat card's confirmation is previewed with its proposal_id (RemoteBolusFlow.check / update).
            if draft.proposalID != nil { request.card_warnings_shown = true }
            request.reminders = draft.reminders.isEmpty ? nil : draft.reminders
            request.meal_in_minutes = draft.carbsG > 0 ? draft.mealInMinutes : nil
            request.create_meal = draft.createMeal && draft.carbsG > 0 ? true : nil
            request.driver = driver
            request.device_authorization = signed?.authorization
            // Only the separate low-glucose alert sets it; the server refuses insulin while low without it.
            request.low_glucose_confirmed = draft.lowGlucoseConfirmed && draft.insulinU > 0 ? true : nil
            command = try await api.authorizeRemoteCommand(patientID: patientID, request: request)
        } catch {
            if error.isProposalExpired {
                return .stopped(.proposalExpired(error.remoteCommandRefusal ?? "Karta jest nieaktualna. Nic nie zostało wysłane."))
            }
            return .stopped(.notSent(error.remoteCommandRefusal ?? "Serwer nie potwierdził polecenia. Nic nie zostało wysłane."))
        }
        // The command the server recorded is this patient's (older servers do not say).
        if let commandPatient = command.patient_id, commandPatient.lowercased() != patientID.lowercased() {
            await reportSent(commandID: command.id, accepted: false, message: "Polecenie innego pacjenta. Nic nie zostało wysłane.")
            return .stopped(.notSent("Serwer zapisał polecenie dla innego pacjenta. Nic nie zostało wysłane."))
        }
        guard let deadline = ServerDate.parse(command.send_deadline), now() < deadline else {
            // Nothing left the phone: said explicitly, so the server frees the command (and the card).
            await reportSent(commandID: command.id, accepted: false, message: "Minął czas na wysłanie. Nic nie zostało wysłane.")
            return .stopped(.notSent("Minął czas na wysłanie. Nic nie zostało wysłane."))
        }
        return .authorized(command)
    }

    /// Retried a few times: a lost report must not leave the server guessing (it then assumes the push may have left).
    @discardableResult
    func reportSent(commandID: String, accepted: Bool, message: String?) async -> RemoteCommand? {
        for attempt in 0..<Self.reportAttempts {
            if let reported = try? await api.reportRemoteCommandSent(patientID: patientID, commandID: commandID, accepted: accepted, message: message) {
                return reported
            }
            if attempt < Self.reportAttempts - 1 {
                try? await Task.sleep(nanoseconds: UInt64(pow(3.0, Double(attempt))) * 1_000_000_000)
            }
        }
        return nil
    }
}

/// Trio's answer push: `command_status` success/failed, its text in aps.alert.body.
public struct TrioReply: Equatable {
    public let success: Bool
    public let message: String
    public let commandID: String?

    public static func parse(userInfo: [AnyHashable: Any]) -> TrioReply? {
        guard let status = userInfo["command_status"] as? String, status == "success" || status == "failed" else { return nil }
        let aps = userInfo["aps"] as? [String: Any]
        let alert = aps?["alert"]
        let body = (alert as? [String: Any])?["body"] as? String ?? (alert as? String) ?? ""
        return TrioReply(success: status == "success", message: body, commandID: userInfo["command_id"] as? String)
    }
}

/// Matches the loop's answers to this phone's pending command, reports them and tells the caregiver in Polish: Trio's
/// (one per command) and Loop's (one per push, handed to a sender waiting for a meal's carbs).
@MainActor
public final class TrioReplyHandler {
    private let api: RemoteCommandsAPI
    private let pendingStore: PendingRemoteCommandStore
    private let notifier: RemoteCommandNotifier
    private let loopReplies: LoopReplyWaiter
    private let now: () -> Date

    /// An answer this long after sending is not matched to the command any more.
    public nonisolated static let matchWindow: TimeInterval = 30 * 60

    public init(api: RemoteCommandsAPI, pendingStore: PendingRemoteCommandStore, notifier: RemoteCommandNotifier, loopReplies: LoopReplyWaiter? = nil, now: @escaping () -> Date = Date.init) {
        self.loopReplies = loopReplies ?? .shared
        self.api = api
        self.pendingStore = pendingStore
        self.notifier = notifier
        self.now = now
    }

    /// Returns true when the push was Trio's answer (the caller then hides Trio's English banner).
    /// `key` identifies the delivered notification and `deliveredAt` when it arrived: an answer from before the pending
    /// command was sent belongs to an earlier one, and one answer is reported only once, also across launches.
    @discardableResult
    public func handle(userInfo: [AnyHashable: Any], key: String?, deliveredAt: Date?) async -> Bool {
        if let loopReply = LoopReply.parse(userInfo: userInfo), pendingStore.pending?.isLoop == true {
            return await handleLoop(loopReply, key: key, deliveredAt: deliveredAt)
        }
        guard let reply = TrioReply.parse(userInfo: userInfo) else { return false }
        if let key, pendingStore.handledReplyKeys.contains(key) { return true }
        guard var pending = pendingStore.pending, now().timeIntervalSince(pending.sentAt) <= Self.matchWindow,
              reply.commandID == nil || reply.commandID == pending.commandID else {
            markHandled(key)
            return true
        }
        if let deliveredAt, deliveredAt < pending.sentAt.addingTimeInterval(-5) {
            markHandled(key)
            return true
        }
        // Sent while another patient's command had no answer: this answer may be that patient's Trio's.
        if pending.ignoresTrioReplies == true && reply.commandID == nil {
            markHandled(key)
            return true
        }

        let updated = try? await api.reportRemoteCommandReply(patientID: pending.patientID, commandID: pending.commandID, success: reply.success, message: reply.message)
        let isFinal: Bool
        let success: Bool
        let text: String
        if let updated {
            // The server's view decides: an intermediate answer keeps the command waiting.
            isFinal = updated.isSettled
            success = updated.isSuccess
            text = updated.status_message ?? reply.message
        } else {
            // The report failed: the caregiver is told now, the report is retried when the app is open again.
            isFinal = !reply.success || pending.insulinU == 0 || reply.message.range(of: "bolus started", options: .caseInsensitive) != nil
            success = reply.success
            text = reply.success ? (pending.insulinU > 0 ? "Bolus podany" : "Posiłek zapisany w Trio") : "Błąd: \(reply.message)"
        }
        guard isFinal else {
            if updated != nil { markHandled(key) }
            return true
        }
        notifier.cancelNoReply(commandID: pending.commandID)
        if !pending.finalNotified {
            let result = Self.resultNotification(success: success, text: text, pending: pending)
            notifier.commandFinished(commandID: pending.commandID, patientID: pending.patientID, title: result.title, body: result.body)
        }
        if updated != nil {
            markHandled(key)
            pendingStore.pending = nil
            if let key { notifier.removeDelivered(identifiers: [key]) }
        } else {
            pending.finalNotified = true
            pendingStore.pending = pending
        }
        return true
    }

    /// Loop answers each push: the carbs of a meal leave it waiting for its bolus (the sender sends it), a late
    /// confirmation of carbs whose bolus was withheld settles it as carbs without the bolus.
    private func handleLoop(_ reply: LoopReply, key: String?, deliveredAt: Date?) async -> Bool {
        if let key, pendingStore.handledReplyKeys.contains(key) { return true }
        guard var pending = pendingStore.pending, now().timeIntervalSince(pending.sentAt) <= Self.matchWindow, pending.ignoresTrioReplies != true else {
            markHandled(key)
            return true
        }
        if let deliveredAt, deliveredAt < pending.sentAt.addingTimeInterval(-5) {
            markHandled(key)
            return true
        }
        // Only an answer to the push this phone waits for: a late answer to an earlier command's bolus must never settle
        // this meal's bolus (not even sent yet while its carbs are waited for).
        if let expected = pending.loopStep, reply.step != expected {
            markHandled(key)
            return true
        }
        if let deliveredAt, let stepSentAt = pending.loopStepSentAt, deliveredAt < stepSentAt.addingTimeInterval(-5) {
            markHandled(key)
            return true
        }
        let withheld = reply.step == .carbs && reply.success && pending.bolusWithheld == true && pending.insulinU > 0
        let updated: RemoteCommand?
        if withheld {
            updated = try? await api.reportRemoteCommandReply(patientID: pending.patientID, commandID: pending.commandID, success: false, message: "Bolus nie został wysłany: Loop potwierdził węglowodany po czasie.", step: .bolus)
        } else {
            updated = try? await api.reportRemoteCommandReply(patientID: pending.patientID, commandID: pending.commandID, success: reply.success, message: reply.message, step: reply.step)
            loopReplies.deliver(reply, commandID: pending.commandID)
        }
        // The meal's carbs confirmed: its bolus is on its way (or withheld); nothing final to tell yet.
        let waitsForBolus = reply.step == .carbs && reply.success && pending.insulinU > 0 && !withheld
        let isFinal = updated?.isSettled ?? !waitsForBolus
        guard isFinal else {
            if updated != nil { markHandled(key) }
            return true
        }
        notifier.cancelNoReply(commandID: pending.commandID)
        if !pending.finalNotified {
            let success = updated?.isSuccess ?? (reply.success && !withheld)
            let text = updated?.status_message ?? (reply.success ? "Bolus podany" : "Błąd: \(reply.message)")
            let result = Self.resultNotification(success: success, text: text, pending: pending)
            notifier.commandFinished(commandID: pending.commandID, patientID: pending.patientID, title: result.title, body: result.body)
        }
        if updated != nil {
            markHandled(key)
            pendingStore.pending = nil
            if let key { notifier.removeDelivered(identifiers: [key]) }
        } else {
            pending.finalNotified = true
            pendingStore.pending = pending
        }
        return true
    }

    /// "✅ Bolus podany" / "❌ Bolus nie został podany" with what was given or why not, naming the command's loop.
    static func resultNotification(success: Bool, text: String, pending: PendingRemoteCommand) -> (title: String, body: String) {
        let units = RemoteCommandFormat.units(pending.insulinU)
        let who = pending.patientName.map { " · \($0)" } ?? ""
        let loop = pending.loopNames
        if success {
            return pending.insulinU > 0
                ? ("✅ Bolus podany\(who)", "\(loop.capitalized) \(loop.agree(m: "rozpoczął", f: "rozpoczęła", n: "rozpoczęło")) bolus \(units) j\(pending.carbsG > 0 ? " na \(pending.carbsG) g węglowodanów" : "").")
                : ("✅ Posiłek zapisany w \(loop.locative)\(who)", "\(pending.carbsG) g węglowodanów.")
        }
        let reason = text.hasPrefix("Błąd: ") ? String(text.dropFirst("Błąd: ".count)) : text
        return ((pending.insulinU > 0 ? "❌ Bolus nie został podany" : "❌ \(loop.capitalized) \(loop.agree(m: "odrzucił", f: "odrzuciła", n: "odrzuciło")) polecenie") + who, reason)
    }

    private func markHandled(_ key: String?) {
        guard let key else { return }
        pendingStore.handledReplyKeys.append(key)
    }
}

#if DEBUG
/// DEBUG ONLY (GLUCOMIND_REMOTE_DRY_RUN=1, simulator checks against a local server): the whole server side of a remote
/// command (one at a time, Face ID / the bolus key's signature, the server's authorization) and then nothing: no push
/// to APNs, no loop. The command is reported as not sent, so the server frees it at once.
public final class DryRunRemoteCommandSender: RemoteCommandSending {
    private let pipeline: RemoteCommandPipeline
    private let driver: String

    public static let message = "Próba bez wysyłania: serwer przyjął podpisane polecenie, do pętli nic nie wysłano."

    public init(patientID: String, patientName: String?, api: RemoteCommandsAPI, biometrics: BiometricGate, signer: RemoteCommandSigning?, deviceID: String, pendingStore: PendingRemoteCommandStore, notifier: RemoteCommandNotifier, driver: String, now: @escaping () -> Date = Date.init) {
        pipeline = RemoteCommandPipeline(patientID: patientID, patientName: patientName, api: api, biometrics: biometrics, signer: signer, deviceID: deviceID, pendingStore: pendingStore, notifier: notifier, loopNames: driver == "LOOP" ? LoopSystemKind.loop.names : LoopSystemKind.trio.names, now: now)
        self.driver = driver
    }

    public func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        if case let .refused(message) = await pipeline.waitForEarlierCommand() { return .notSent(message) }
        switch await pipeline.confirmAndAuthorize(draft, bolusStep: draft.pumpBolusStep ?? Decimal(string: "0.05")!, driver: driver) {
        case let .stopped(outcome):
            return outcome
        case let .authorized(command):
            NSLog("[REMOTE-DRY-RUN] authorized command=%@ status=%@", command.id, command.status)
            await pipeline.reportSent(commandID: command.id, accepted: false, message: Self.message)
            return .notSent(Self.message)
        }
    }
}
#endif
