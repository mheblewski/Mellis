import Combine
import Foundation

/// What this caregiver may do for the patient beyond reading and writing data (GET /v1/patients/{id}/capabilities).
public struct PatientCapabilitiesResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    /// The system running the patient's loop; absent from servers before loop-support.
    public let loop_system: LoopSystemInfo?
    public let remote_commands: RemoteCommandsAccess
    /// The server's monthly AI limit; nil without paid AI or from servers before the field.
    public var ai: AiLimitStatus? = nil
    /// The prediction experiment (Ustawienia → Funkcje eksperymentalne); nil from servers before it.
    public var prediction_experiment: PredictionExperimentAccess? = nil
    /// The forecast line on the charts; nil from servers before it was taken out of the experiment (then the line
    /// follows the experiment, as those servers serve it).
    public var prediction_line: PredictionLineAccess? = nil

    public init(patient_id: String, loop_system: LoopSystemInfo? = nil, remote_commands: RemoteCommandsAccess, ai: AiLimitStatus? = nil, prediction_experiment: PredictionExperimentAccess? = nil) {
        self.patient_id = patient_id
        self.loop_system = loop_system
        self.remote_commands = remote_commands
        self.ai = ai
        self.prediction_experiment = prediction_experiment
    }
}

/// The monthly AI limit set on the server (`mellis` → Zmień ustawienia → Limit AI).
public struct AiLimitStatus: Codable, Equatable, Sendable {
    public let limit_reached: Bool
    /// When the limit starts over (ISO 8601); nil for a one-off budget.
    public let resets_at: String?

    public init(limit_reached: Bool, resets_at: String?) {
        self.limit_reached = limit_reached
        self.resets_at = resets_at
    }

    /// Shown where AI answers would appear while the limit is used up; nil otherwise.
    public func notice(timeZone: TimeZone = .current) -> String? {
        guard limit_reached else { return nil }
        let renews: String
        if let resets_at, let date = ServerDate.parse(resets_at) {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "pl_PL")
            formatter.timeZone = timeZone
            formatter.dateFormat = "d MMMM"
            renews = " Odnowi się \(formatter.string(from: date))."
        } else {
            renews = ""
        }
        return "Limit AI na ten miesiąc wyczerpany.\(renews) Zmienisz go na serwerze: mellis → Zmień ustawienia → Limit AI."
    }
}

/// Remote commands to the patient's loop (Trio). On only when the server, the patient's loop, the patient and this
/// caregiver allow them.
public struct RemoteCommandsAccess: Codable, Equatable, Sendable {
    public let enabled: Bool
    /// How this phone sends to the patient's loop: TRIO or LOOP; nil from servers before loop-support (Trio's).
    public var driver: String? = nil
    /// ENABLED, SERVER_DISABLED, LOOP_SYSTEM_NOT_SUPPORTED, PATIENT_DISABLED or CAREGIVER_NOT_PERMITTED; an unknown value
    /// reads as off.
    public let reason: String

    public init(enabled: Bool, reason: String, driver: String? = nil) {
        self.enabled = enabled
        self.reason = reason
        self.driver = driver
    }

    /// Commands go to Loop (LoopRemoteCommandSender and Loop's settings), else to Trio.
    public var sendsToLoop: Bool { driver == "LOOP" }

    public static let off = RemoteCommandsAccess(enabled: false, reason: "UNKNOWN")

    /// The settings line explaining why remote commands are off.
    public var explanation: String {
        switch reason {
        case "ENABLED":
            return "Włączone dla Ciebie i tego pacjenta."
        case "SERVER_DISABLED":
            return "Wyłączone na serwerze."
        case "LOOP_SYSTEM_NOT_SUPPORTED":
            return "Pętla tego pacjenta nie przyjmuje jeszcze poleceń z aplikacji Mellis (na razie tylko Trio)."
        case "PATIENT_DISABLED":
            return "Wyłączone dla tego pacjenta."
        case "CAREGIVER_NOT_PERMITTED":
            return "Twoje konto nie ma uprawnienia do zdalnych poleceń dla tego pacjenta."
        default:
            return "Nie udało się sprawdzić uprawnień."
        }
    }
}

public protocol PatientCapabilitiesAPI {
    func getCapabilities(patientID: String) async throws -> PatientCapabilitiesResponse
}

extension APIClient: PatientCapabilitiesAPI {}

/// The capabilities of the patient on screen. Anything that sends a command reads `remoteCommands`; it stays off until
/// the server says otherwise, and a failed refresh never turns it on.
@MainActor
public final class PatientCapabilitiesStore: ObservableObject {
    @Published public private(set) var remoteCommands: RemoteCommandsAccess = .off
    /// The patient's loop (texts name it); unknown until the server says.
    @Published public private(set) var loopSystem: LoopSystemInfo = .unknown
    /// The server's monthly AI limit (nil while unknown or without paid AI).
    @Published public private(set) var aiLimit: AiLimitStatus?
    @Published public private(set) var predictionExperiment: PredictionExperimentAccess = .unavailable
    /// The server serves the forecast line for the patient on screen (the phone's own switch decides whether it shows).
    @Published public private(set) var predictionLineAvailable = false
    @Published public private(set) var patientID: String?

    private var liveSubscription: AnyCancellable?
    /// The last answer about each patient: their tabs open with the right tabs instead of gaining one a moment later.
    /// Published: a patient's page beside the one on screen names their loop from here as soon as the answer comes.
    @Published private var known: [String: PatientCapabilitiesResponse] = [:]

    public init() {}

    /// False when the server could not be asked (the caller may try again); true once it answered.
    @discardableResult
    public func refresh(api: PatientCapabilitiesAPI, patientID: String) async -> Bool {
        show(patientID: patientID)
        do {
            let response = try await api.getCapabilities(patientID: patientID)
            guard response.patient_id.lowercased() == patientID.lowercased() else { return true }
            known[patientID] = response
            if self.patientID == patientID { apply(response) }
            return true
        } catch {
            // A network error keeps the last answer: switching off goes through the server's own answer or a patient change.
            NSLog("[CAPABILITIES] fetch failed patientId=%@ error=%@", patientID, String(describing: error))
            return false
        }
    }

    /// Reads a patient's answer before their tabs open; the patient on screen does not change.
    public func readAhead(api: PatientCapabilitiesAPI, patientID: String) async {
        guard let response = try? await api.getCapabilities(patientID: patientID),
              response.patient_id.lowercased() == patientID.lowercased() else { return }
        known[patientID] = response
        if self.patientID == patientID { apply(response) }
    }

    /// Another patient: nothing from the previous one stays on. Their own last answer shows until the new one is in.
    public func show(patientID: String) {
        guard self.patientID != patientID else { return }
        self.patientID = patientID
        if let answer = known[patientID] {
            apply(answer)
        } else {
            remoteCommands = .off
            loopSystem = .unknown
            predictionExperiment = .unavailable
            predictionLineAvailable = false
        }
    }

    /// The loop of any patient, also one who is not on screen; unknown until the server has answered about them.
    public func loopSystem(of patientID: String) -> LoopSystemKind {
        guard let answer = known[patientID] else { return .unknown }
        return LoopSystemKind.named(by: answer.loop_system ?? .unknown, commands: answer.remote_commands)
    }

    /// "Prognoza glukozy" of any patient, also one who is not on screen; off until the server has answered about them.
    public func predictionExperiment(of patientID: String) -> PredictionExperimentAccess {
        known[patientID]?.prediction_experiment ?? .unavailable
    }

    /// The forecast line of any patient, also one who is not on screen; off until the server has answered about them.
    public func predictionLineAvailable(of patientID: String) -> Bool {
        known[patientID].map(Self.lineAvailable) ?? false
    }

    private static func lineAvailable(_ response: PatientCapabilitiesResponse) -> Bool {
        response.prediction_line?.available ?? (response.prediction_experiment?.isOn ?? false)
    }

    private func apply(_ response: PatientCapabilitiesResponse) {
        remoteCommands = response.remote_commands
        loopSystem = response.loop_system ?? .unknown
        aiLimit = response.ai
        predictionExperiment = response.prediction_experiment ?? .unavailable
        predictionLineAvailable = Self.lineAvailable(response)
    }

    public func reset() {
        known = [:]
        patientID = nil
        remoteCommands = .off
        loopSystem = .unknown
        aiLimit = nil
        predictionExperiment = .unavailable
        predictionLineAvailable = false
        liveSubscription = nil
    }

    /// The prediction experiment was just switched on this phone: the chart follows at once.
    public func setPredictionExperimentEnabled(_ enabled: Bool, patientID: String) {
        guard self.patientID?.lowercased() == patientID.lowercased() else { return }
        predictionExperiment = PredictionExperimentAccess(available: predictionExperiment.available, enabled: predictionExperiment.available && enabled, can_change: predictionExperiment.can_change)
        if let current = self.patientID {
            known[current]?.prediction_experiment = predictionExperiment
            if let answer = known[current] { predictionLineAvailable = Self.lineAvailable(answer) }
        }
    }

    /// A switch turned on or off on the server reaches the screen at once.
    public func bindLiveUpdates(_ live: LiveUpdates?, api: PatientCapabilitiesAPI, patientID: String) {
        liveSubscription = live?.changes
            .filter { $0.concerns(kind: "capabilities") }
            .sink { [weak self] _ in
                Task { await self?.refresh(api: api, patientID: patientID) }
            }
    }
}
