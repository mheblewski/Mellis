import Foundation

/// The rescue carbs alert a conversation is about (rescue-carbs.v1): glucose may fall below 70 mg/dL, with the dose the
/// server computed (no AI) and the treatment once a caregiver logged it. Sent with the alert's conversation; nil for
/// other conversations and from older servers. Status, level and basis stay strings, so a value this build does not know
/// never breaks the conversation.
public struct ConversationRescueCarbs: Codable, Equatable {
    public let alert_id: String
    /// NOTIFIED, TREATED, RESOLVED or EXPIRED.
    public let status: String
    /// PREDICTED_LOW, LOW_NOW or URGENT_LOW.
    public let level: String
    /// TRIO_CARBS_REQ, TRIO_PREDICTION, CGM_TREND or CGM_LOW.
    public let trigger_source: String?
    public let detected_at: String?
    /// The reading the alert was raised on.
    public let glucose_mgdl: Double?
    public let glucose_at: String?
    public let delta_per_5min: Double?
    public let predicted_min_mgdl: Double?
    public let predicted_low_at: String?
    public let minutes_to_low: Double?
    public let proposal: RescueCarbsProposal?
    /// From 2 h before the alert until now (at most 3 h after it).
    public let glucose_readings: [RescueGlucosePoint]
    /// The curve the alert was evaluated on; may be empty.
    public let prediction: [RescueGlucosePoint]
    public let latest_glucose: RescueGlucosePoint?
    /// Set once a caregiver logged the rescue carbs.
    public let treatment: RescueCarbsTreatment?
    public let notified_at: String?
    public let reminder_sent_at: String?
    /// "Nie podaję": a caregiver decided not to give rescue carbs (no reminder follows); nil once carbs were logged.
    public let declined: RescueCarbsDecline?

    public init(
        alert_id: String,
        status: String,
        level: String,
        trigger_source: String? = nil,
        detected_at: String? = nil,
        glucose_mgdl: Double? = nil,
        glucose_at: String? = nil,
        delta_per_5min: Double? = nil,
        predicted_min_mgdl: Double? = nil,
        predicted_low_at: String? = nil,
        minutes_to_low: Double? = nil,
        proposal: RescueCarbsProposal? = nil,
        glucose_readings: [RescueGlucosePoint] = [],
        prediction: [RescueGlucosePoint] = [],
        latest_glucose: RescueGlucosePoint? = nil,
        treatment: RescueCarbsTreatment? = nil,
        notified_at: String? = nil,
        reminder_sent_at: String? = nil,
        declined: RescueCarbsDecline? = nil
    ) {
        self.alert_id = alert_id
        self.status = status
        self.level = level
        self.trigger_source = trigger_source
        self.detected_at = detected_at
        self.glucose_mgdl = glucose_mgdl
        self.glucose_at = glucose_at
        self.delta_per_5min = delta_per_5min
        self.predicted_min_mgdl = predicted_min_mgdl
        self.predicted_low_at = predicted_low_at
        self.minutes_to_low = minutes_to_low
        self.proposal = proposal
        self.glucose_readings = glucose_readings
        self.prediction = prediction
        self.latest_glucose = latest_glucose
        self.treatment = treatment
        self.notified_at = notified_at
        self.reminder_sent_at = reminder_sent_at
        self.declined = declined
    }

    /// Missing or malformed details (a curve, the proposal) are left out instead of failing the whole conversation.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        alert_id = (try? container.decodeIfPresent(String.self, forKey: .alert_id)) ?? ""
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "NOTIFIED"
        level = (try? container.decodeIfPresent(String.self, forKey: .level)) ?? "PREDICTED_LOW"
        trigger_source = try? container.decodeIfPresent(String.self, forKey: .trigger_source)
        detected_at = try? container.decodeIfPresent(String.self, forKey: .detected_at)
        glucose_mgdl = try? container.decodeIfPresent(Double.self, forKey: .glucose_mgdl)
        glucose_at = try? container.decodeIfPresent(String.self, forKey: .glucose_at)
        delta_per_5min = try? container.decodeIfPresent(Double.self, forKey: .delta_per_5min)
        predicted_min_mgdl = try? container.decodeIfPresent(Double.self, forKey: .predicted_min_mgdl)
        predicted_low_at = try? container.decodeIfPresent(String.self, forKey: .predicted_low_at)
        minutes_to_low = try? container.decodeIfPresent(Double.self, forKey: .minutes_to_low)
        proposal = try? container.decodeIfPresent(RescueCarbsProposal.self, forKey: .proposal)
        glucose_readings = (try? container.decodeIfPresent([RescueGlucosePoint].self, forKey: .glucose_readings)) ?? []
        prediction = (try? container.decodeIfPresent([RescueGlucosePoint].self, forKey: .prediction)) ?? []
        latest_glucose = try? container.decodeIfPresent(RescueGlucosePoint.self, forKey: .latest_glucose)
        treatment = try? container.decodeIfPresent(RescueCarbsTreatment.self, forKey: .treatment)
        notified_at = try? container.decodeIfPresent(String.self, forKey: .notified_at)
        reminder_sent_at = try? container.decodeIfPresent(String.self, forKey: .reminder_sent_at)
        declined = try? container.decodeIfPresent(RescueCarbsDecline.self, forKey: .declined)
    }

    public var levelKind: RescueCarbsLevel {
        RescueCarbsLevel(rawValue: level.uppercased()) ?? .predictedLow
    }

    public var isTreated: Bool {
        treatment != nil
    }

    public var isDeclined: Bool {
        treatment == nil && declined != nil
    }

    /// "Nie podaję" makes sense while the alert is open and nothing was logged or declined yet.
    public var canDecline: Bool {
        treatment == nil && declined == nil && !isClosedWithoutTreatment
    }

    /// The alert closed without a logged treatment (glucose recovered, or 2 h passed); late logging is still allowed.
    public var isClosedWithoutTreatment: Bool {
        treatment == nil && ["RESOLVED", "EXPIRED"].contains(status.uppercased())
    }

    /// The grams the sheet opens with; nil without a dose (no therapy profile).
    public var proposedGrams: Double? {
        guard let proposal, !proposal.hasNoProfile else { return nil }
        return proposal.carbs_g.flatMap { $0 > 0 ? $0 : nil }
    }
}

public enum RescueCarbsLevel: String, Equatable {
    case predictedLow = "PREDICTED_LOW"
    case lowNow = "LOW_NOW"
    case urgentLow = "URGENT_LOW"

    public var title: String {
        switch self {
        case .predictedLow: return "Możliwe niedocukrzenie"
        case .lowNow: return "Niedocukrzenie"
        case .urgentLow: return "Pilne: niedocukrzenie"
        }
    }
}

/// The dose of rescue-dose.v2: carbsReq from Trio, or the formula on ISF / ICR, at most one 20 g portion.
public struct RescueCarbsProposal: Codable, Equatable {
    /// nil with NO_PROFILE.
    public let carbs_g: Double?
    public let min_g: Double?
    public let max_g: Double?
    /// TRIO_CARBS_REQ, FORMULA, URGENT_MAX or NO_PROFILE.
    public let basis: String
    public let csf_mgdl_per_g: Double?
    public let isf_mgdl_per_u: Double?
    public let icr_g_per_u: Double?
    public let iob_u: Double?
    public let cob_g: Double?
    public let trio_carbs_req_g: Double?
    /// How the dose was computed, one line each (Polish, from the server).
    public let explanation: [String]
    /// Shown above the explanation: more than one portion needed, insulin no logged carbs cover (Polish, from the server).
    public let warnings: [String]

    public init(
        carbs_g: Double?,
        min_g: Double? = nil,
        max_g: Double? = nil,
        basis: String,
        csf_mgdl_per_g: Double? = nil,
        isf_mgdl_per_u: Double? = nil,
        icr_g_per_u: Double? = nil,
        iob_u: Double? = nil,
        cob_g: Double? = nil,
        trio_carbs_req_g: Double? = nil,
        explanation: [String] = [],
        warnings: [String] = []
    ) {
        self.carbs_g = carbs_g
        self.min_g = min_g
        self.max_g = max_g
        self.basis = basis
        self.csf_mgdl_per_g = csf_mgdl_per_g
        self.isf_mgdl_per_u = isf_mgdl_per_u
        self.icr_g_per_u = icr_g_per_u
        self.iob_u = iob_u
        self.cob_g = cob_g
        self.trio_carbs_req_g = trio_carbs_req_g
        self.explanation = explanation
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        carbs_g = try? container.decodeIfPresent(Double.self, forKey: .carbs_g)
        min_g = try? container.decodeIfPresent(Double.self, forKey: .min_g)
        max_g = try? container.decodeIfPresent(Double.self, forKey: .max_g)
        basis = (try? container.decodeIfPresent(String.self, forKey: .basis)) ?? (carbs_g == nil ? "NO_PROFILE" : "FORMULA")
        csf_mgdl_per_g = try? container.decodeIfPresent(Double.self, forKey: .csf_mgdl_per_g)
        isf_mgdl_per_u = try? container.decodeIfPresent(Double.self, forKey: .isf_mgdl_per_u)
        icr_g_per_u = try? container.decodeIfPresent(Double.self, forKey: .icr_g_per_u)
        iob_u = try? container.decodeIfPresent(Double.self, forKey: .iob_u)
        cob_g = try? container.decodeIfPresent(Double.self, forKey: .cob_g)
        trio_carbs_req_g = try? container.decodeIfPresent(Double.self, forKey: .trio_carbs_req_g)
        explanation = (try? container.decodeIfPresent([String].self, forKey: .explanation)) ?? []
        warnings = (try? container.decodeIfPresent([String].self, forKey: .warnings)) ?? []
    }

    /// No ISF / ICR: no dose, the caregiver checks the glucose.
    public var hasNoProfile: Bool {
        basis.uppercased() == "NO_PROFILE" || carbs_g == nil
    }
}

/// One CGM reading or prediction point; the server sends `observed_at` for readings and `at` for the prediction.
public struct RescueGlucosePoint: Codable, Equatable {
    public let time: String
    public let value: Double

    public init(time: String, value: Double) {
        self.time = time
        self.value = value
    }

    public var date: Date? {
        HypoFormat.date(time)
    }

    private enum CodingKeys: String, CodingKey {
        case observed_at, at, value, glucose_mgdl
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let time = try container.decodeIfPresent(String.self, forKey: .observed_at) ?? container.decodeIfPresent(String.self, forKey: .at) else {
            throw DecodingError.keyNotFound(CodingKeys.observed_at, .init(codingPath: decoder.codingPath, debugDescription: "observed_at or at"))
        }
        self.time = time
        guard let value = try container.decodeIfPresent(Double.self, forKey: .value) ?? container.decodeIfPresent(Double.self, forKey: .glucose_mgdl) else {
            throw DecodingError.keyNotFound(CodingKeys.value, .init(codingPath: decoder.codingPath, debugDescription: "value"))
        }
        self.value = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(time, forKey: .observed_at)
        try container.encode(value, forKey: .value)
    }
}

/// The rescue carbs a caregiver gave for the alert: sent to Trio (in_loop) or stored in GlucoMind only.
public struct RescueCarbsTreatment: Codable, Equatable {
    public let event_id: String?
    /// Sent to Trio as a hypo treatment (absent on older servers: GlucoMind only).
    public var in_loop: Bool? = nil
    public let carbs_g: Double
    public let given_at: String
    public let logged_by: String?
    public let logged_at: String?
    /// ALERT (the alert's card), CHAT_CARD (a card of a conversation) or MANUAL ("+" → "Dosłodzenie" in the meals tab).
    public let source: String?
    public let proposal_id: String?

    public init(event_id: String? = nil, carbs_g: Double, given_at: String, logged_by: String? = nil, logged_at: String? = nil, source: String? = nil, proposal_id: String? = nil) {
        self.event_id = event_id
        self.carbs_g = carbs_g
        self.given_at = given_at
        self.logged_by = logged_by
        self.logged_at = logged_at
        self.source = source
        self.proposal_id = proposal_id
    }
}

/// "Nie podaję" on the alert: when and by whom.
public struct RescueCarbsDecline: Codable, Equatable {
    public let declined_at: String
    public let declined_by: String?

    public init(declined_at: String, declined_by: String? = nil) {
        self.declined_at = declined_at
        self.declined_by = declined_by
    }
}

/// A rescue dose the AI proposed in the alert's chat ("Zatwierdź Y g" opens the same sheet with Y g).
public struct ConversationRescueCarbProposal: Codable, Equatable, Identifiable {
    public let id: String
    public let carbs_g: Double
    public let reason: String?
    /// PROPOSED, ACCEPTED or SUPERSEDED.
    public let status: String
    public let created_at: String?
    /// A confirmed card of an ordinary conversation (no alert): what was logged (an alert's card shows the alert's
    /// treatment instead).
    public let logged: Logged?
    /// The answer's option the card belongs to (A-C; absent without options and on older servers).
    public var option_key: String? = nil

    public struct Logged: Codable, Equatable {
        public let carbs_g: Double
        public let given_at: String
        /// Sent to Trio (absent on older servers: GlucoMind only).
        public var in_loop: Bool? = nil
    }

    public init(id: String, carbs_g: Double, reason: String? = nil, status: String, created_at: String? = nil, logged: Logged? = nil, option_key: String? = nil) {
        self.id = id
        self.carbs_g = carbs_g
        self.reason = reason
        self.status = status
        self.created_at = created_at
        self.logged = logged
        self.option_key = option_key
    }

    /// A card this build cannot read fully still decodes (and shows what it has), so the answer above it stays.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decodeIfPresent(String.self, forKey: .id)) ?? ""
        carbs_g = (try? container.decodeIfPresent(Double.self, forKey: .carbs_g)) ?? 0
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "PROPOSED"
        created_at = try? container.decodeIfPresent(String.self, forKey: .created_at)
        logged = try? container.decodeIfPresent(Logged.self, forKey: .logged)
        option_key = try? container.decodeIfPresent(String.self, forKey: .option_key)
    }

    public var isAccepted: Bool { status.uppercased() == "ACCEPTED" }
    public var isSuperseded: Bool { status.uppercased() == "SUPERSEDED" }
}

/// Body of POST …/conversations/{id}/rescue-carbs.
public struct RescueCarbsLogRequest: Encodable, Equatable {
    public let carbs_g: Double
    public let given_at: String?
    public let proposal_id: String?

    public init(carbs_g: Double, given_at: String?, proposal_id: String?) {
        self.carbs_g = carbs_g
        self.given_at = given_at
        self.proposal_id = proposal_id
    }

    /// proposal_id is sent as an explicit null when the dose comes from the alert block, not from a chat card.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(carbs_g, forKey: .carbs_g)
        try container.encodeIfPresent(given_at, forKey: .given_at)
        try container.encode(proposal_id, forKey: .proposal_id)
    }

    private enum CodingKeys: String, CodingKey { case carbs_g, given_at, proposal_id }
}

public struct RescueCarbsLogResponse: Decodable, Equatable {
    /// nil when the server answered without the block or with one missing its alert (e.g. an empty `rescue_carbs`,
    /// which the tolerant block decoder would turn into a blank alert): the write still happened, the block is read again.
    public let rescue_carbs: ConversationRescueCarbs?

    public init(rescue_carbs: ConversationRescueCarbs?) {
        self.rescue_carbs = rescue_carbs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let block = try? container.decodeIfPresent(ConversationRescueCarbs.self, forKey: .rescue_carbs)
        rescue_carbs = block?.alert_id.isEmpty == false ? block : nil
    }

    private enum CodingKeys: String, CodingKey {
        case rescue_carbs
    }
}

/// Answer of POST …/conversations/{id}/rescue-carb-proposals/{proposalId}/accept: the card with what was logged.
public struct ChatRescueCarbsAcceptResponse: Decodable, Equatable {
    public let proposal: ConversationRescueCarbProposal
}

/// The other caregiver logged the rescue carbs first (409 RESCUE_ALREADY_LOGGED); `message` names them.
public extension APIClientError {
    static let rescueAlreadyLoggedCode = "RESCUE_ALREADY_LOGGED"

    var rescueAlreadyLoggedMessage: String? {
        guard case let .conflict(problem) = self, problem?.code == Self.rescueAlreadyLoggedCode else { return nil }
        let title = problem?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? "Dosłodzenie już wpisane" : title
    }
}

/// GET/PUT /v1/patients/{p}/devices/{deviceId}/notification-settings: what this phone is sent.
public struct DeviceNotificationSettings: Codable, Equatable {
    public let device_id: String?
    public let rescue_carb_alerts_enabled: Bool
    /// "Gotowa odpowiedź": the push when GlucoMind's answer to this phone's question is ready. On when the server does
    /// not send it yet.
    public let answer_ready_push_enabled: Bool

    public init(device_id: String?, rescue_carb_alerts_enabled: Bool, answer_ready_push_enabled: Bool = true) {
        self.device_id = device_id
        self.rescue_carb_alerts_enabled = rescue_carb_alerts_enabled
        self.answer_ready_push_enabled = answer_ready_push_enabled
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        device_id = try container.decodeIfPresent(String.self, forKey: .device_id)
        rescue_carb_alerts_enabled = try container.decode(Bool.self, forKey: .rescue_carb_alerts_enabled)
        answer_ready_push_enabled = try container.decodeIfPresent(Bool.self, forKey: .answer_ready_push_enabled) ?? true
    }
}

/// Only the switches set are sent: the server keeps the others.
public struct DeviceNotificationSettingsRequest: Encodable, Equatable {
    public var rescue_carb_alerts_enabled: Bool?
    public var answer_ready_push_enabled: Bool?
}

// MARK: - Presentation

public enum RescueCarbsFormat {
    /// Grams the server accepts: 1–50 g in steps of 0.5 g.
    public static let gramsRange: ClosedRange<Double> = 1...50

    public static func isValidGrams(_ value: Double) -> Bool {
        gramsRange.contains(value) && (value * 2).rounded() == value * 2
    }

    /// "4", "7,5".
    public static func grams(_ value: Double) -> String {
        HypoFormat.grams(value)
    }

    /// "7,5" or "7.5" → 7.5; nil unless 1–50 g in whole or half grams.
    public static func parseGrams(_ text: String) -> Double? {
        let normalized = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), isValidGrams(value) else { return nil }
        return value
    }

    public static func time(_ iso: String) -> String {
        HypoFormat.time(iso)
    }

    /// "−6", "+3", "0".
    public static func signed(_ value: Double) -> String {
        let rounded = Int(value.rounded())
        if rounded > 0 { return "+\(rounded)" }
        if rounded < 0 { return "−\(-rounded)" }
        return "0"
    }
}

public extension ConversationRescueCarbs {
    var title: String {
        levelKind.title
    }

    /// The glucose shown now: the latest reading, else the one the alert was raised on.
    var currentGlucose: RescueGlucosePoint? {
        if let latest_glucose { return latest_glucose }
        guard let glucose_mgdl else { return nil }
        return RescueGlucosePoint(time: glucose_at ?? detected_at ?? "", value: glucose_mgdl)
    }

    /// "82 mg/dL · −6 / 5 min".
    var glucoseLine: String? {
        guard let current = currentGlucose else { return nil }
        var line = "\(Int(current.value.rounded())) mg/dL"
        if let delta_per_5min {
            line += " · \(RescueCarbsFormat.signed(delta_per_5min)) / 5 min"
        }
        return line
    }

    /// The newest reading time, from the curve or the latest glucose.
    private var latestReadingDate: Date? {
        (glucose_readings.compactMap(\.date) + [currentGlucose?.date].compactMap { $0 }).max()
    }

    /// The forecast still says something: glucose is at or above 70 and the forecast drop below 70 is ahead of the
    /// newest reading. An ongoing low needs no forecast, and a passed one was wrong.
    private var forecastLowAt: String? {
        guard let current = currentGlucose, current.value >= 70,
              let predicted_low_at, let lowDate = HypoFormat.date(predicted_low_at) else { return nil }
        if let latest = latestReadingDate, lowDate <= latest { return nil }
        return predicted_low_at
    }

    /// "ok. 14:20 może spaść poniżej 70 mg/dL"; nil when the forecast says nothing new. The loop's minimum is left
    /// out: oref's curves run far below what happens (their floor is 39).
    var predictionLine: String? {
        guard let forecastLowAt else { return nil }
        return "ok. \(RescueCarbsFormat.time(forecastLowAt)) może spaść poniżej 70 mg/dL"
    }

    /// The dashed forecast on the chart: after the newest reading and only down to its first point below 70 (the
    /// depth of the curve is not realistic); empty whenever there is no prediction line.
    var chartForecast: [RescueGlucosePoint] {
        guard forecastLowAt != nil else { return [] }
        let latestDate = latestReadingDate
        var points: [RescueGlucosePoint] = []
        for point in prediction.sorted(by: { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }) {
            guard let date = point.date, latestDate.map({ date > $0 }) ?? true else { continue }
            points.append(point)
            if point.value < 70 { break }
        }
        return points
    }

    /// "Proponuję 4 g węglowodanów", or the no-profile note.
    var proposalLine: String {
        guard let grams = proposedGrams else {
            return "Brak profilu terapii — sprawdź glukozę"
        }
        return "Proponuję \(RescueCarbsFormat.grams(grams)) g węglowodanów"
    }

    /// "Podano 6 g o 14:05 · Ewa · w Trio".
    func treatmentLine(loop: LoopSystemNames) -> String? {
        guard let treatment else { return nil }
        var line = "Podano \(RescueCarbsFormat.grams(treatment.carbs_g)) g o \(RescueCarbsFormat.time(treatment.given_at))"
        if let name = treatment.logged_by?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            line += " · \(name)"
        }
        line += treatment.in_loop == true ? " · w \(loop.locative)" : " · tylko w Mellisie"
        return line
    }

    /// "Bez dosłodzenia · 14:10 · Piotr".
    var declinedLine: String? {
        guard isDeclined, let declined else { return nil }
        var line = "Bez dosłodzenia · \(RescueCarbsFormat.time(declined.declined_at))"
        if let name = declined.declined_by?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            line += " · \(name)"
        }
        return line
    }

    /// What follows "Nie podaję": no reminder, and a new alert only for a worse level than this one.
    var declineFollowUpLine: String {
        switch levelKind {
        case .predictedLow: return "Przypomnienie nie przyjdzie. Nowe ostrzeżenie — jeśli glukoza spadnie poniżej 70."
        case .lowNow: return "Przypomnienie nie przyjdzie. Nowe ostrzeżenie — jeśli glukoza spadnie poniżej 55."
        case .urgentLow: return "Przypomnienie nie przyjdzie."
        }
    }

    /// What became of an alert nobody logged rescue carbs for.
    var closedLine: String? {
        guard isClosedWithoutTreatment else { return nil }
        return status.uppercased() == "RESOLVED"
            ? "Alarm zamknięty: glukoza się ustabilizowała. Dosłodzenie można jeszcze wpisać."
            : "Alarm wygasł. Dosłodzenie można jeszcze wpisać."
    }
}
