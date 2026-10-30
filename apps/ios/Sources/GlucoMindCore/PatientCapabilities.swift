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

    public init(patient_id: String, loop_system: LoopSystemInfo? = nil, remote_commands: RemoteCommandsAccess, ai: AiLimitStatus? = nil) {
        self.patient_id = patient_id
        self.loop_system = loop_system
        self.remote_commands = remote_commands
        self.ai = ai
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
    @Published public private(set) var patientID: String?

    private var liveSubscription: AnyCancellable?

    public init() {}

    /// False when the server could not be asked (the caller may try again); true once it answered.
    @discardableResult
    public func refresh(api: PatientCapabilitiesAPI, patientID: String) async -> Bool {
        if self.patientID != patientID {
            // Another patient: nothing from the previous one may stay on while the new answer is on its way.
            self.patientID = patientID
            remoteCommands = .off
            loopSystem = .unknown
        }
        do {
            let response = try await api.getCapabilities(patientID: patientID)
            guard self.patientID == patientID, response.patient_id.lowercased() == patientID.lowercased() else { return true }
            remoteCommands = response.remote_commands
            loopSystem = response.loop_system ?? .unknown
            aiLimit = response.ai
            return true
        } catch {
            // A network error keeps the last answer: switching off goes through the server's own answer or a patient change.
            NSLog("[CAPABILITIES] fetch failed patientId=%@ error=%@", patientID, String(describing: error))
            return false
        }
    }

    public func reset() {
        patientID = nil
        remoteCommands = .off
        loopSystem = .unknown
        aiLimit = nil
        liveSubscription = nil
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
