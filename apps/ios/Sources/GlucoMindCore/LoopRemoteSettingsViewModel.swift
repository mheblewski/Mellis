import Foundation

/// The address of the patient's Loop as the server reads it from Nightscout.
public protocol LoopRemoteTargetAPI {
    func getLoopRemoteTarget(patientID: String) async throws -> LoopRemoteTargetResponse
}

extension APIClient: LoopRemoteTargetAPI {}

/// One step of setting up Loop's remote control on this phone, in the order the screen shows them. The same steps as
/// Trio's (TrioSetupStep): the Loop in Nightscout, its secret (the QR code), Loop's key, the key for its answer, limits.
public enum LoopSetupStep: String, CaseIterable, Identifiable, Sendable {
    case loop, secret, key, returnKey, limits
    public var id: String { rawValue }
}

/// The Loop section of the settings, as TrioRemoteSettingsViewModel is Trio's: the connection as Nightscout shows it,
/// the steps still to do, and the settings kept on this phone (saved as they are typed, in this phone's Keychain).
@MainActor
public final class LoopRemoteSettingsViewModel: ObservableObject {
    /// What could not be saved yet (a QR code another patient here has), per patient, for as long as the app runs.
    private static var unsavedDrafts: [String: LoopRemoteSettings] = [:]

    @Published public var settings: LoopRemoteSettings {
        didSet {
            if settings != oldValue && !isClearing { persist() }
        }
    }
    @Published public private(set) var target: LoopRemoteTarget?
    @Published public private(set) var targetError: String?
    @Published public private(set) var isLoading = false
    @Published public private(set) var saveError: String?
    @Published public private(set) var hasStoredSettings = false
    /// The pump's step Nightscout reports (then the setting is not asked for).
    @Published public private(set) var pumpBolusStep: Decimal?
    private var isClearing = false

    public let identity: GlucoMindPushIdentity
    public let patientName: String?
    private let patientID: String
    private let api: LoopRemoteTargetAPI
    private let store: LoopRemoteSettingsStore

    public init(patientID: String, patientName: String? = nil, api: LoopRemoteTargetAPI, store: LoopRemoteSettingsStore, identity: GlucoMindPushIdentity) {
        self.patientID = patientID
        self.patientName = patientName
        self.api = api
        self.store = store
        self.identity = identity
        let stored = (try? store.load(patientID: patientID)) ?? nil
        settings = Self.unsavedDrafts[patientID] ?? stored ?? LoopRemoteSettings()
        hasStoredSettings = stored != nil
    }

    public func refreshTarget() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await api.getLoopRemoteTarget(patientID: patientID)
            guard response.patient_id.lowercased() == patientID.lowercased() else {
                target = nil
                targetError = "Serwer podał Loopa innego pacjenta."
                return
            }
            target = response.loop
            pumpBolusStep = response.pump_bolus_step
            targetError = nil
            // Setting up this patient's remote control: the Loop in their Nightscout is theirs from now on.
            if pin == .needsConfirmation, let first = PinnedLoop(target: response.loop, teamID: loopTeamID, at: Date()) {
                settings.pinnedLoop = first
            }
        } catch {
            targetError = "Nie udało się sprawdzić Loopa w Nightscout."
        }
    }

    /// The team that built Loop: Nightscout's (a LoopWorkspace bundle id) or the one typed here.
    public var loopTeamID: String? { settings.loopTeamID(target: target) }

    /// Nightscout cannot tell the team (another bundle id than LoopWorkspace's): the caregiver types it.
    public var needsTeamID: Bool { target != nil && target?.team_id == nil }

    /// Loop built by another Apple team than this app needs a second key so Loop can answer.
    public var needsReturnKey: Bool {
        guard let loopTeamID, !identity.teamID.isEmpty else { return false }
        return loopTeamID != identity.teamID
    }

    public var pin: TrioPatientGuard.Pin {
        LoopPatientGuard.pin(settings: settings, target: target, patientID: patientID, store: store)
    }

    public var secretUsedByOtherPatient: Bool {
        LoopPatientGuard.secretUsedByOtherPatient(settings.otpURL, patientID: patientID, store: store)
    }

    /// Nightscout shows another Loop than the one remembered: the caregiver confirms it is the patient's new Loop.
    public func confirmLoop() {
        guard let target, pin == .needsConfirmation || pin == .changed, let pinned = PinnedLoop(target: target, teamID: loopTeamID, at: Date()) else { return }
        settings.pinnedLoop = pinned
    }

    // MARK: Steps

    public var steps: [LoopSetupStep] {
        LoopSetupStep.allCases.filter { $0 != .returnKey || needsReturnKey }
    }

    public func isDone(_ step: LoopSetupStep) -> Bool {
        switch step {
        case .loop:
            return pin == .confirmed
        case .secret:
            return settings.otp != nil && !secretUsedByOtherPatient
        case .key:
            return loopTeamID != nil && Self.keyWorks(id: settings.apnsKeyID, p8: settings.apnsKeyP8, team: loopTeamID)
        case .returnKey:
            return Self.keyWorks(id: settings.returnKeyID ?? "", p8: settings.returnKeyP8 ?? "", team: identity.teamID)
        case .limits:
            return settings.limitsReviewed == true && settings.maxBolusUnits > 0 && settings.maxBolusUnits <= (target?.max_bolus_u ?? 30) && settings.maxCarbsGrams > 0 && settings.maxCarbsGrams <= 300
        }
    }

    public var doneCount: Int { steps.filter(isDone).count }
    public var nextStep: LoopSetupStep? { steps.first { !isDone($0) } }
    public var isReady: Bool { nextStep == nil && problems.isEmpty }

    private static func keyWorks(id: String, p8: String, team: String?) -> Bool {
        guard APNsAuthToken.isKeyID(id), !p8.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return (try? APNsAuthToken(keyID: id, teamID: team ?? "AAAAAAAAAA", p8: p8)) != nil
    }

    public var problems: [String] {
        var problems = settings.problems(loop: target)
        if needsReturnKey, settings.returnKeyID == nil {
            problems.append("Loop jest zbudowany na innym koncie Apple niż Mellis: dodaj klucz APNs konta aplikacji Mellis (\(identity.teamID)), żeby Loop mógł odpowiedzieć.")
        }
        if let message = LoopPatientGuard.message(pin, patientName: patientName), target != nil {
            problems.append(message)
        }
        if secretUsedByOtherPatient {
            problems.append(LoopPatientGuard.secretMessage)
        }
        return problems
    }

    public func markLimitsReviewed() {
        if settings.limitsReviewed != true { settings.limitsReviewed = true }
    }

    // MARK: Saving

    private func persist() {
        var normalized = settings
        normalized.otpURL = normalized.otpURL.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized.apnsKeyID = normalized.apnsKeyID.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        normalized.apnsKeyP8 = normalized.apnsKeyP8.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized.teamID = normalized.teamID.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }.flatMap { $0.isEmpty ? nil : $0 }
        if target != nil && !needsReturnKey {
            normalized.returnKeyID = nil
            normalized.returnKeyP8 = nil
        }
        if LoopPatientGuard.secretUsedByOtherPatient(normalized.otpURL, patientID: patientID, store: store) {
            Self.unsavedDrafts[patientID] = settings
            saveError = LoopPatientGuard.secretMessage
            return
        }
        do {
            try store.save(normalized, patientID: patientID)
            Self.unsavedDrafts[patientID] = nil
            hasStoredSettings = true
            saveError = nil
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
        } catch {
            Self.unsavedDrafts[patientID] = settings
            saveError = "Nie udało się zapisać w pęku kluczy."
        }
    }

    public func clear() {
        isClearing = true
        settings = LoopRemoteSettings()
        isClearing = false
        try? store.clear(patientID: patientID)
        Self.unsavedDrafts[patientID] = nil
        hasStoredSettings = false
        saveError = nil
        NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
    }
}
