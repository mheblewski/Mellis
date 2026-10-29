import Foundation

/// A block or warning of a remote command, with the server's Polish text.
public struct RemoteCommandNotice: Codable, Equatable, Hashable, Sendable {
    public let code: String
    /// Warnings only: the warning and the data it is about; this is what the caregiver acknowledges.
    public let key: String?
    public let message: String
    /// WARNING or DANGER (chat cards, card-advice.v1); absent: an ordinary warning.
    public var severity: String? = nil

    public init(code: String, key: String? = nil, message: String, severity: String? = nil) {
        self.code = code
        self.key = key
        self.message = message
        self.severity = severity
    }

    public var acknowledgementKey: String { key ?? code }
    /// A strong warning (a forecast below 54 mg/dL, a high despite insulin): red instead of orange.
    public var isDanger: Bool { severity == "DANGER" }
}

/// What the caregiver sees before confirming: glucose, the loop and the last bolus behind the checks.
public struct RemoteCommandContextView: Codable, Equatable, Sendable {
    public struct Glucose: Codable, Equatable, Sendable {
        public let value: Double
        public let observed_at: String
        public let delta: Double?
        /// Nightscout direction of the reading (Flat, FortyFiveUp, …); nil from servers before it was sent.
        public var direction: String? = nil
    }

    public struct Loop: Codable, Equatable, Sendable {
        public let iob_units: Double?
        public let cob_grams: Double?
        public let observed_at: String
    }

    public struct Bolus: Codable, Equatable, Sendable {
        public let at: String
        public let units: Double
    }

    public let now: String
    public let glucose: Glucose?
    public let loop: Loop?
    public let last_bolus: Bolus?
    /// The ICR at `carbs_at` when the meal is eaten later, else now.
    public let icr_g_per_u: Double?
    /// When the carbs would be dated in Trio ("+15 min"); nil: now (and from servers before it was sent).
    public var carbs_at: String? = nil
}

/// GET /v1/patients/{id}/remote-commands/preview
public struct RemoteCommandPreview: Codable, Equatable, Sendable {
    public let carbs_g: Int
    public let insulin_u: Double
    public let icr_g_per_u: Double?
    public let icr_insulin_u: Double?
    public let context: RemoteCommandContextView
    public let blocks: [RemoteCommandNotice]
    public let warnings: [RemoteCommandNotice]
    /// The step the server rounded to and checks against; absent on older servers.
    public var bolus_step: Double? = nil
    /// PUMP (Trio reports the pump's step) or SETTINGS (this phone's setting).
    public var bolus_step_source: String? = nil
    /// The chart above the form (bolus-forecast.v1); absent on older servers and without a fresh reading.
    public var forecast: BolusForecastChart? = nil

    /// The pump's own step when Trio reports it: it wins over this phone's setting.
    public var pumpBolusStep: Decimal? {
        guard bolus_step_source == "PUMP", let bolus_step, bolus_step > 0 else { return nil }
        return Decimal(string: String(format: "%.3f", bolus_step), locale: Locale(identifier: "en_US_POSIX"))
    }
}

/// The glucose 3 hours ahead without and with the dose on the form (bolus-forecast.v1): one value per step from `start`
/// (the newest reading). Without the dose: the loop's own forecast, or the CGM trend when Trio's is not fresh. By
/// default (bolus-forecast.v7, `dose_line` LOOP_ONLY) there is no line with the dose: the loop's forecast does not
/// include a dose not yet given, so the chart shows it labelled "bez tej dawki" and `total_with_dose` checks the dose.
public struct BolusForecastChart: Codable, Equatable, Sendable {
    public let start: String
    public let step_minutes: Int
    /// LOOP, CGM_TREND or FLAT.
    public let baseline_source: String
    public let baseline: [Int]
    /// Nil when nothing is typed or the ISF is unknown.
    public let with_dose: [Int]?
    /// Half-width of the uncertainty band around the line shown, mg/dL.
    public let band: [Int]
    /// The first point of `with_dose` below 70 mg/dL, and whether the line without the dose stays above it.
    public let low_at: String?
    public let low_from_dose: Bool
    public let carbs_g: Double
    public let insulin_u: Double
    /// When the carbs are eaten, minutes after the bolus (bolus-forecast.v3; absent before, when it was 10).
    public var meal_in_minutes: Int? = nil
    /// MODEL (a line with the dose may be drawn, FORECAST_CALIBRATION=fitted-v1) or LOOP_ONLY (bolus-forecast.v7);
    /// absent from older servers (MODEL).
    public var dose_line: String? = nil
    /// The line without the dose at its end plus the dose's full effect (carbs × ISF / ICR − insulin × ISF), mg/dL.
    public var total_with_dose: Int? = nil

    /// Only the loop's own forecast is drawn (the dose is not on the chart).
    public var isLoopOnly: Bool { dose_line == "LOOP_ONLY" }
    /// The dose's full effect takes the loop's forecast below 70 mg/dL (only checked without a line with the dose).
    public var totalLowWithoutLine: Int? {
        guard isLoopOnly, let total = total_with_dose, total < 70, insulin_u > 0 else { return nil }
        return total
    }

    public init(start: String, step_minutes: Int, baseline_source: String, baseline: [Int], with_dose: [Int]?, band: [Int], low_at: String?, low_from_dose: Bool, carbs_g: Double, insulin_u: Double) {
        self.start = start
        self.step_minutes = step_minutes
        self.baseline_source = baseline_source
        self.baseline = baseline
        self.with_dose = with_dose
        self.band = band
        self.low_at = low_at
        self.low_from_dose = low_from_dose
        self.carbs_g = carbs_g
        self.insulin_u = insulin_u
    }

    public struct Point: Equatable, Sendable {
        public let date: Date
        public let value: Int
        public let band: Int
    }

    /// A series as dated points (empty when the start cannot be read).
    public func points(_ values: [Int]) -> [Point] {
        guard let startDate = ServerDate.parse(start) else { return [] }
        return values.enumerated().map { index, value in
            Point(date: startDate.addingTimeInterval(Double(index * step_minutes) * 60), value: value, band: index < band.count ? band[index] : 0)
        }
    }

    public var lowDate: Date? { low_at.flatMap(ServerDate.parse) }
}

/// The meal a command's carbs are for; GlucoMind creates it once Trio's carb entry is in Nightscout.
public struct RemoteCommandMeal: Codable, Equatable {
    public struct Macros: Codable, Equatable, Sendable {
        public let carbs_g: Double?
        public let protein_g: Double?
        public let fat_g: Double?

        public init(carbs_g: Double?, protein_g: Double?, fat_g: Double?) {
            self.carbs_g = carbs_g
            self.protein_g = protein_g
            self.fat_g = fat_g
        }
    }

    public let description: String?
    public let items: [MealChatProposalItem]?
    public let macros: Macros?

    public init(description: String?, items: [MealChatProposalItem]?, macros: Macros?) {
        self.description = description
        self.items = items
        self.macros = macros
    }
}

public enum RemoteCommandSource: String, Codable, Sendable {
    case bolusScreen = "BOLUS_SCREEN"
    case chatCard = "CHAT_CARD"
    case newMeal = "NEW_MEAL"
    /// The WBT window: the carbs-equivalent and bolus are the meal's WBT.
    case wbtScreen = "WBT_SCREEN"
    /// The planned second part of a split meal bolus.
    case plannedBolus = "PLANNED_BOLUS"
    /// Rescue carbs for a low (a hypo treatment in Trio: carbs alone, no meal).
    case rescueCarbs = "RESCUE_CARBS"
}

/// A reminder set with a Bolus tab bolus ("Przypomnij"). It only reminds: no dose is computed or sent with it.
public enum BolusReminder: Equatable, Hashable, Sendable, Encodable {
    /// The meal's WBT, 2,5 h after the bolus.
    case wbt
    /// A second dose once glucose has risen for 10 min (watched for at most an hour).
    case secondDoseWhenRising
    /// A second dose this many minutes after the bolus.
    case secondDoseAfter(minutes: Int)

    private enum CodingKeys: String, CodingKey { case kind, trigger, minutes }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .wbt:
            try container.encode("WBT", forKey: .kind)
        case .secondDoseWhenRising:
            try container.encode("SECOND_DOSE", forKey: .kind)
            try container.encode("GLUCOSE_RISING", forKey: .trigger)
        case let .secondDoseAfter(minutes):
            try container.encode("SECOND_DOSE", forKey: .kind)
            try container.encode("AFTER_MINUTES", forKey: .trigger)
            try container.encode(minutes, forKey: .minutes)
        }
    }
}

/// POST /v1/patients/{id}/remote-commands
public struct RemoteCommandAuthorizeRequest: Encodable, Equatable {
    public let source: RemoteCommandSource
    public let carbs_g: Int
    public let insulin_u: Decimal
    public let bolus_step: Decimal
    public let device_id: String
    public let conversation_id: String?
    public let proposal_id: String?
    public let follows_command_id: String?
    public let meal: RemoteCommandMeal?
    /// The WBT window's meal (source WBT_SCREEN).
    public let wbt_meal_id: String?
    /// The planned second part of a split meal bolus (source PLANNED_BOLUS).
    public let planned_bolus_id: String?
    /// Rescue carbs (source RESCUE_CARBS): the alert or the chat card they answer.
    public var rescue_alert_id: String? = nil
    public var rescue_proposal_id: String? = nil
    /// "Przypomnij" (source BOLUS_SCREEN only); nil: none, the key is left out.
    public var reminders: [BolusReminder]? = nil
    /// "+15 min" (source BOLUS_SCREEN, with carbs): the meal is eaten this many minutes from now; the server checks the
    /// dose with the ICR of that time and answers with the carbs' date for Trio (`carbs_at`).
    public var meal_in_minutes: Int? = nil
    /// "Zapisz jako posiłek" (source BOLUS_SCREEN, with carbs): the dose becomes a meal of the Meals journal; nil: left out.
    public var create_meal: Bool? = nil
    public let acknowledged_warnings: [String]
    /// A chat card's confirmation previewed with its proposal_id, so the card's own warnings were in it and acknowledged.
    public var card_warnings_shown: Bool? = nil
    /// How this phone sends it: TRIO or LOOP (the server refuses a driver that does not fit the patient's loop).
    public var driver: String? = nil
    /// Device mode: the bolus key's signature over what the person confirmed (Face ID); nil: the key is left out.
    public var device_authorization: DeviceAuthorizationEnvelope? = nil

    public init(source: RemoteCommandSource, carbs_g: Int, insulin_u: Decimal, bolus_step: Decimal, device_id: String, conversation_id: String?, proposal_id: String?, follows_command_id: String? = nil, meal: RemoteCommandMeal?, wbt_meal_id: String? = nil, planned_bolus_id: String? = nil, acknowledged_warnings: [String]) {
        self.follows_command_id = follows_command_id
        self.wbt_meal_id = wbt_meal_id
        self.planned_bolus_id = planned_bolus_id
        self.source = source
        self.carbs_g = carbs_g
        self.insulin_u = insulin_u
        self.bolus_step = bolus_step
        self.device_id = device_id
        self.conversation_id = conversation_id
        self.proposal_id = proposal_id
        self.meal = meal
        self.acknowledged_warnings = acknowledged_warnings
    }
}

/// A command as the server records it (both caregivers see it).
public struct RemoteCommand: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// Whose command it is (absent on older servers).
    public var patient_id: String? = nil
    /// AUTHORIZED, EXPIRED, SENT, SEND_FAILED, TRIO_ACCEPTED, SUCCEEDED, PARTIAL, REJECTED, NO_REPLY
    public let status: String
    public let status_message: String?
    public let source: String
    public let carbs_g: Int
    public let insulin_u: Double
    public let icr_g_per_u: Double?
    public let meal_description: String?
    public let conversation_id: String?
    public let proposal_id: String?
    /// A retry of this refused command (absent on older servers).
    public var follows_command_id: String? = nil
    /// WBT (from the WBT window) or nil.
    public var purpose: String? = nil
    public let sent_by_me: Bool
    public let authorized_at: String
    public let send_deadline: String
    public let sent_at: String?
    public let answered_at: String?
    public let meal_record_id: String?
    public let loop_action_id: String?
    public let warnings: [RemoteCommandNotice]
    /// The carbs' date in Trio for a meal eaten later (sent as Trio's `scheduled_time`); nil: now.
    public var carbs_at: String? = nil

    public var isWaitingForTrio: Bool {
        ["AUTHORIZED", "SENT", "TRIO_ACCEPTED"].contains(status)
    }

    public var isSuccess: Bool {
        status == "SUCCEEDED"
    }

    public var isFailure: Bool {
        ["SEND_FAILED", "REJECTED", "EXPIRED", "PARTIAL"].contains(status)
    }

    /// Trio's final answer is known (or the command never left): this phone no longer waits for it.
    public var isSettled: Bool {
        ["SUCCEEDED", "PARTIAL", "REJECTED", "SEND_FAILED", "EXPIRED"].contains(status)
    }
}

public struct RemoteCommandResponse: Codable, Equatable, Sendable {
    public let command: RemoteCommand
}

public struct RemoteCommandListResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let items: [RemoteCommand]
}

struct RemoteCommandSentReport: Encodable {
    let accepted: Bool
    let message: String?
}

struct RemoteCommandReplyReport: Encodable {
    let success: Bool
    let message: String
    /// Loop's answers: which push (carbs or bolus) it answers; nil for Trio's.
    var step: LoopCommandStep? = nil
    /// Loop: the meal's bolus was not sent (Loop did not confirm its carbs).
    var withheld: Bool? = nil
}

public protocol RemoteCommandsAPI {
    /// `mealInMinutes`: when the carbs will be eaten, for the chart only (bolus-forecast.v3; nil: the usual pre-bolus).
    /// The command is unchanged.
    /// `proposalID`: a chat card's confirmation; the server adds the card's own warnings while the amounts are the card's.
    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview
    func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand
    func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand
    func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand]
    func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse
    /// Loop (loop-support-plan.md, stage 3): its address, and its answers, one per push.
    func getLoopRemoteTarget(patientID: String) async throws -> LoopRemoteTargetResponse
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String, step: LoopCommandStep) async throws -> RemoteCommand
    /// Loop: this phone did not send the meal's bolus (no confirmation of its carbs).
    func reportLoopBolusWithheld(patientID: String, commandID: String, message: String) async throws -> RemoteCommand
}

extension APIClient: RemoteCommandsAPI {}

public extension RemoteCommandsAPI {
    func reportLoopBolusWithheld(patientID: String, commandID: String, message: String) async throws -> RemoteCommand {
        throw TrioRemoteError.invalidTarget("LOOP_UNSUPPORTED")
    }

    /// Stand-ins for an API that knows only Trio (offline doubles): nothing about Loop can be read or reported.
    func getLoopRemoteTarget(patientID: String) async throws -> LoopRemoteTargetResponse {
        throw TrioRemoteError.invalidTarget("LOOP_UNSUPPORTED")
    }

    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String, step: LoopCommandStep) async throws -> RemoteCommand {
        throw TrioRemoteError.invalidTarget("LOOP_UNSUPPORTED")
    }

    /// The check of a command about to be sent: its chart has the meal at the usual time.
    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal) async throws -> RemoteCommandPreview {
        try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: nil, proposalID: nil)
    }

    /// Not a chat card's confirmation.
    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?) async throws -> RemoteCommandPreview {
        try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: mealInMinutes, proposalID: nil)
    }
}

public extension Error {
    /// The server refused a chat card past its validity (409 "PROPOSAL_EXPIRED: …").
    var isProposalExpired: Bool {
        guard case let .conflict(problem)? = self as? APIClientError, let problem else { return false }
        return problem.code == "PROPOSAL_EXPIRED" || problem.title.hasPrefix("PROPOSAL_EXPIRED")
    }

    /// The server's reason for refusing a remote command (blocked, warnings changed, another command in flight).
    var remoteCommandRefusal: String? {
        guard let error = self as? APIClientError else { return nil }
        let problem: ProblemDetails?
        switch error {
        case let .conflict(details), let .forbidden(details), let .validation(details):
            problem = details
        default:
            return nil
        }
        // Device auth refusals have English titles: the app's own words for them.
        if let code = problem?.code, ["BOLUS_KEY_REQUIRED", "REMOTE_BOLUS_NOT_PERMITTED", "REMOTE_COMMAND_SIGNATURE_INVALID", "REMOTE_COMMAND_SIGNATURE_REQUIRED"].contains(code) {
            return DeviceAuthErrorText.message(for: error)
        }
        guard let title = problem?.title else { return nil }
        // "REMOTE_COMMAND_BLOCKED: Glukoza …" → "Glukoza …"
        if let range = title.range(of: #"^[A-Z_]+: "#, options: .regularExpression) {
            return String(title[range.upperBound...])
        }
        return title
    }
}
