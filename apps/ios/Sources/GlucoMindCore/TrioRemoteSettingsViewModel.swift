import Foundation

public protocol TrioRemoteTargetAPI {
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse
}

extension APIClient: TrioRemoteTargetAPI {}

/// This app's own identity, which Trio needs to answer a command (Info.plist GMTeamID / GMAPNSProduction).
public struct GlucoMindPushIdentity: Equatable, Sendable {
    public let bundleID: String
    public let teamID: String
    public let productionEnvironment: Bool

    public init(bundleID: String, teamID: String, productionEnvironment: Bool) {
        self.bundleID = bundleID
        self.teamID = teamID
        self.productionEnvironment = productionEnvironment
    }

    /// Info.plist gives a build setting as a string ("YES"/"NO").
    static func isTrue(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        if let text = value as? String { return ["yes", "true", "1"].contains(text.lowercased()) }
        return false
    }

    public static func current(bundle: Bundle = .main) -> GlucoMindPushIdentity {
        GlucoMindPushIdentity(
            bundleID: bundle.bundleIdentifier ?? "",
            teamID: (bundle.object(forInfoDictionaryKey: "GMTeamID") as? String) ?? "",
            productionEnvironment: isTrue(bundle.object(forInfoDictionaryKey: "GMAPNSProduction"))
        )
    }
}

/// One step of setting up remote control on this phone, in the order the screen shows them.
public enum TrioSetupStep: String, CaseIterable, Identifiable, Sendable {
    case trio, secret, key, returnKey, limits
    public var id: String { rawValue }
}

/// The Trio section of the settings: the connection as Nightscout shows it, the steps still to do, and the settings kept
/// on this phone (saved as they are typed, in this phone's Keychain).
@MainActor
public final class TrioRemoteSettingsViewModel: ObservableObject {
    /// What could not be saved yet (a Shared Secret another patient here has), per patient, for as long as the app runs.
    private static var unsavedDrafts: [String: TrioRemoteSettings] = [:]

    @Published public var settings: TrioRemoteSettings {
        didSet {
            if settings != oldValue && !isClearing { persist() }
        }
    }
    @Published public private(set) var target: TrioRemoteTarget?
    @Published public private(set) var targetError: String?
    @Published public private(set) var isLoading = false
    @Published public private(set) var savedMessage: String?
    @Published public private(set) var saveError: String?
    @Published public private(set) var hasStoredSettings = false
    /// The pump's step Trio reports (then the setting is not asked for).
    @Published public private(set) var pumpBolusStep: Decimal?
    /// The newest command of this patient, shown when everything is set.
    @Published public private(set) var lastCommand: RemoteCommand?
    private var isClearing = false

    public let identity: GlucoMindPushIdentity
    public let patientName: String?
    private let patientID: String
    private let api: TrioRemoteTargetAPI
    private let store: TrioRemoteSettingsStore
    private let recentCommand: (() async -> RemoteCommand?)?

    public init(patientID: String, patientName: String? = nil, api: TrioRemoteTargetAPI, store: TrioRemoteSettingsStore, identity: GlucoMindPushIdentity, recentCommand: (() async -> RemoteCommand?)? = nil) {
        self.patientID = patientID
        self.patientName = patientName
        self.api = api
        self.store = store
        self.identity = identity
        self.recentCommand = recentCommand
        let stored = (try? store.load(patientID: patientID)) ?? nil
        settings = Self.unsavedDrafts[patientID] ?? stored ?? TrioRemoteSettings()
        hasStoredSettings = stored != nil
    }

    /// Typed values not saved on this phone yet.
    public var hasUnsavedChanges: Bool { Self.unsavedDrafts[patientID] != nil }

    public func refreshTarget() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await api.getTrioRemoteTarget(patientID: patientID)
            guard response.patient_id.lowercased() == patientID.lowercased() else {
                target = nil
                targetError = "Serwer podał Trio innego pacjenta."
                return
            }
            target = response.trio
            pumpBolusStep = response.pump_bolus_step.flatMap { Decimal(string: String(format: "%.2f", $0), locale: Locale(identifier: "en_US_POSIX")) }
            targetError = nil
            // Setting up this patient's remote control: the Trio in their Nightscout is theirs from now on. Asked again
            // only when Nightscout later shows another Trio.
            if pin == .needsConfirmation, let first = PinnedTrio(target: response.trio, at: Date()) {
                settings.pinnedTrio = first
            }
        } catch {
            targetError = "Nie udało się sprawdzić Trio w Nightscout."
        }
        if let recentCommand { lastCommand = await recentCommand() }
    }

    /// Trio built by another Apple team than this app needs a second key so Trio can answer.
    public var needsReturnKey: Bool {
        guard let trioTeam = target?.team_id, !identity.teamID.isEmpty else { return false }
        return trioTeam != identity.teamID
    }

    // MARK: Guards against the wrong patient

    /// Whether Nightscout's Trio is the one confirmed for this patient.
    public var pin: TrioPatientGuard.Pin {
        TrioPatientGuard.pin(settings: settings, target: target, patientID: patientID, store: store)
    }

    /// Another patient on this phone has this Shared Secret: it is not saved.
    public var secretUsedByOtherPatient: Bool {
        TrioPatientGuard.secretUsedByOtherPatient(settings.sharedSecret, patientID: patientID, store: store)
    }

    /// Nightscout shows another Trio than the one remembered: the caregiver confirms it is the patient's new Trio.
    public func confirmTrio() {
        guard let target, pin == .needsConfirmation || pin == .changed, let pinned = PinnedTrio(target: target, at: Date()) else { return }
        settings.pinnedTrio = pinned
    }

    // MARK: Steps

    public var steps: [TrioSetupStep] {
        TrioSetupStep.allCases.filter { $0 != .returnKey || needsReturnKey }
    }

    public func isDone(_ step: TrioSetupStep) -> Bool {
        switch step {
        case .trio:
            return pin == .confirmed
        case .secret:
            return !settings.sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !secretUsedByOtherPatient
        case .key:
            return Self.keyWorks(id: settings.apnsKeyID, p8: settings.apnsKeyP8, team: target?.team_id)
        case .returnKey:
            return Self.keyWorks(id: settings.returnKeyID ?? "", p8: settings.returnKeyP8 ?? "", team: identity.teamID)
        case .limits:
            return settings.limitsReviewed == true && settings.maxBolusUnits > 0 && settings.maxBolusUnits <= 30 && settings.maxCarbsGrams > 0 && settings.maxCarbsGrams <= 300
        }
    }

    public var doneCount: Int { steps.filter(isDone).count }
    /// The first step still to do (the screen opens it); nil when everything is set.
    public var nextStep: TrioSetupStep? { steps.first { !isDone($0) } }
    public var isReady: Bool { nextStep == nil && problems.isEmpty }

    private static func keyWorks(id: String, p8: String, team: String?) -> Bool {
        guard APNsAuthToken.isKeyID(id), !p8.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return (try? APNsAuthToken(keyID: id, teamID: team ?? "AAAAAAAAAA", p8: p8)) != nil
    }

    public var problems: [String] {
        var problems = settings.problems(trio: target)
        if needsReturnKey, settings.returnKeyID == nil {
            problems.append("Trio jest zbudowane na innym koncie Apple niż Mellis: dodaj klucz APNs konta aplikacji Mellis (\(identity.teamID)), żeby Trio mogło odpowiedzieć.")
        }
        if let message = TrioPatientGuard.message(pin, patientName: patientName), target != nil {
            problems.append(message)
        }
        if secretUsedByOtherPatient {
            problems.append(TrioPatientGuard.secretMessage)
        }
        return problems
    }

    /// "Limity są w porządku": the caregiver checked the limits for this patient.
    public func markLimitsReviewed() {
        if settings.limitsReviewed != true { settings.limitsReviewed = true }
    }

    // MARK: Saving

    /// Saved as typed (trimmed copy; the field keeps what was typed). A Shared Secret another patient here has is not.
    private func persist() {
        var normalized = settings
        normalized.sharedSecret = normalized.sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized.apnsKeyID = normalized.apnsKeyID.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        normalized.apnsKeyP8 = normalized.apnsKeyP8.trimmingCharacters(in: .whitespacesAndNewlines)
        // The same team as GlucoMind needs no second key (known only once Nightscout's Trio was read).
        if target != nil && !needsReturnKey {
            normalized.returnKeyID = nil
            normalized.returnKeyP8 = nil
        }
        if TrioPatientGuard.secretUsedByOtherPatient(normalized.sharedSecret, patientID: patientID, store: store) {
            Self.unsavedDrafts[patientID] = settings
            saveError = TrioPatientGuard.secretMessage
            savedMessage = nil
            return
        }
        do {
            try store.save(normalized, patientID: patientID)
            Self.unsavedDrafts[patientID] = nil
            hasStoredSettings = true
            saveError = nil
            savedMessage = "Zapisano na tym telefonie."
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
        } catch {
            Self.unsavedDrafts[patientID] = settings
            saveError = "Nie udało się zapisać w pęku kluczy."
        }
    }

    /// Kept for callers that save explicitly; the screen saves as values change.
    public func save() {
        persist()
    }

    public func clear() {
        isClearing = true
        settings = TrioRemoteSettings()
        isClearing = false
        try? store.clear(patientID: patientID)
        Self.unsavedDrafts[patientID] = nil
        hasStoredSettings = false
        saveError = nil
        NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
        savedMessage = "Usunięto ustawienia Trio z tego telefonu."
    }
}
