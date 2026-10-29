import Foundation

/// A meal bolus divided into a part given now and a part planned for later (split-bolus.v1): the card's own carbs_g
/// and insulin_u are the part now.
public struct SplitBolusPlan: Codable, Equatable {
    public let now_percent: Int
    public let later_after_minutes: Int
    public let total_carbs_g: Int
    public let total_insulin_u: Double
    public let later_carbs_g: Int
    /// The second part's dose as estimated when the card was made (recomputed when due).
    public let later_insulin_u: Double
    /// SPLIT (absent on older servers) or DEFERRED_INSULIN: the carbs now, the dose for them later.
    public var kind: String? = nil
    /// later-plan.v1 (absent on older plans): AFTER_MINUTES, GLUCOSE_STOPPED_FALLING, GLUCOSE_RISING or GLUCOSE_ABOVE.
    public var trigger: String? = nil
    public var threshold_mgdl: Int? = nil
    /// Glucose triggers: how long the condition is waited for before the reminder comes anyway.
    public var wait_minutes: Int? = nil
    /// A later dose the caregiver named (absent: computed when due).
    public var fixed_insulin_u: Double? = nil
    /// The carbs the later dose is for when more than its own (the carbs now that have no insulin now); nil: its own.
    public var dose_carbs_g: Int? = nil
    /// Further later parts of the same card, each with its own reminder (absent: one later part).
    public var more_parts: [SplitBolusPlan]? = nil

    public var isDeferred: Bool { kind == "DEFERRED_INSULIN" }
    /// The trigger, also for older plans (a split after a time, a deferred bolus when glucose stops falling).
    public var laterTrigger: String { trigger ?? (isDeferred ? "GLUCOSE_STOPPED_FALLING" : "AFTER_MINUTES") }

    public init(now_percent: Int, later_after_minutes: Int, total_carbs_g: Int, total_insulin_u: Double, later_carbs_g: Int, later_insulin_u: Double) {
        self.now_percent = now_percent
        self.later_after_minutes = later_after_minutes
        self.total_carbs_g = total_carbs_g
        self.total_insulin_u = total_insulin_u
        self.later_carbs_g = later_carbs_g
        self.later_insulin_u = later_insulin_u
    }
}

/// The planned second part of a meal's split bolus (meal JSON `planned_bolus`, a chat card's `planned_bolus`).
public struct PlannedBolusSummary: Codable, Equatable {
    public let id: String
    /// SCHEDULED, NOTIFIED (the reminder went out), GIVEN, SKIPPED, EXPIRED or CANCELLED
    public let status: String
    public let due_at: String
    public let delay_minutes: Int
    public let now_percent: Int
    public let carbs_g: Int
    public let planned_insulin_u: Double
    public let first_carbs_g: Int
    public let first_insulin_u: Double
    public let resolved_at: String?
    public let resolved_by_name: String?
    public let given_insulin_u: Double?
    /// A command for it is on its way to Trio (or unanswered): the button is hidden on both phones.
    public let sending: Bool
    /// SPLIT (absent on older servers) or DEFERRED_INSULIN (the meal's whole dose after its carbs).
    public var kind: String? = nil
    /// later-plan.v1 (absent on older servers): what the reminder waits for.
    public var trigger: String? = nil
    public var threshold_mgdl: Int? = nil
    public var wait_until: String? = nil
    /// The meal it belongs to and which part of its card it is (absent on older servers).
    public var meal_record_id: String? = nil
    public var part_index: Int? = nil
    /// A dose the caregiver named for it (absent: computed when due).
    public var fixed_insulin_u: Double? = nil
    /// The carbs its dose is for when more than its own (the card's carbs that had no insulin); nil: its own.
    public var dose_carbs_g: Int? = nil
    /// Cancelled because the meal's carbs were reduced (absent on older servers); it comes back when they are restored.
    public var cancelled_by_meal_change: Bool? = nil

    public init(id: String, status: String, due_at: String, delay_minutes: Int, now_percent: Int, carbs_g: Int, planned_insulin_u: Double, first_carbs_g: Int, first_insulin_u: Double, resolved_at: String? = nil, resolved_by_name: String? = nil, given_insulin_u: Double? = nil, sending: Bool = false, kind: String? = nil, trigger: String? = nil, threshold_mgdl: Int? = nil, wait_until: String? = nil) {
        self.kind = kind
        self.trigger = trigger
        self.threshold_mgdl = threshold_mgdl
        self.wait_until = wait_until
        self.id = id
        self.status = status
        self.due_at = due_at
        self.delay_minutes = delay_minutes
        self.now_percent = now_percent
        self.carbs_g = carbs_g
        self.planned_insulin_u = planned_insulin_u
        self.first_carbs_g = first_carbs_g
        self.first_insulin_u = first_insulin_u
        self.resolved_at = resolved_at
        self.resolved_by_name = resolved_by_name
        self.given_insulin_u = given_insulin_u
        self.sending = sending
    }

    public var isDeferred: Bool { kind == "DEFERRED_INSULIN" }
    public var laterTrigger: String { trigger ?? (isDeferred ? "GLUCOSE_STOPPED_FALLING" : "AFTER_MINUTES") }
    /// The grams the dose is for: the deferred carbs, or the whole meal's for a deferred bolus.
    public var doseCarbsG: Int { isDeferred ? first_carbs_g : carbs_g }

    /// Still to give (the clock on the rail and chart; the reminder may have gone out already).
    public var isOpen: Bool { status == "SCHEDULED" || status == "NOTIFIED" }
    /// Either caregiver may give it now.
    public var canGive: Bool { isOpen && !sending }
    public var dueDate: Date? { ServerDate.parse(due_at) }

    /// "Zaplanowana na 14:40", "Podana o 14:42 (Ewa)", "Wyłączona" … for the card and the meal page.
    public var statusLine: String {
        let due = dueDate.map(LoopFormat.clock) ?? ""
        let who = resolved_by_name.map { " (\($0))" } ?? ""
        let at = resolved_at.flatMap(ServerDate.parse).map { " o \(LoopFormat.clock($0))" } ?? ""
        switch status {
        case "GIVEN":
            let units = given_insulin_u.map { ": \(RemoteCommandFormat.units($0)) j" } ?? ""
            return "Podana\(at)\(who)\(units)"
        case "SKIPPED": return "Wyłączona\(at)\(who)"
        case "EXPIRED": return "Nie podano do 2 h po terminie"
        case "CANCELLED": return cancelled_by_meal_change == true ? "Anulowana (posiłek zmniejszono)" : "Anulowana (posiłek usunięty)"
        default:
            if sending { return "Wysyłanie…" }
            let condition = LaterTriggerText.condition(trigger: laterTrigger, thresholdMgdl: threshold_mgdl)
            if isDeferred { return status == "NOTIFIED" ? "Czas na bolus" : condition.map { "\($0.prefix(1).uppercased())\($0.dropFirst()) (najwcześniej \(due))" } ?? "Zaplanowany na \(due)" }
            if let condition, status != "NOTIFIED" { return "\(condition.prefix(1).uppercased())\(condition.dropFirst()) (najwcześniej \(due))" }
            return status == "NOTIFIED" ? "Czas na drugą część (od \(due))" : "Zaplanowana na \(due)"
        }
    }
}

/// The second part's dose now: deferred carbs / ICR now, minus what the loop added above the basal since the meal.
public struct PlannedBolusEstimate: Codable, Equatable {
    public let as_of: String
    public let icr_g_per_u: Double?
    public let insulin_for_carbs_u: Double?
    public let loop_extra_u: Double?
    /// True when the basal profile is missing: `loop_extra_u` holds the SMBs only (older servers omit it).
    public let loop_extra_partial: Bool?
    public let smb_u: Double?
    public let temp_basal_extra_u: Double?
    /// The dose to give now; nil without an ICR.
    public let insulin_u: Double?
    /// later-plan.v1 (absent on older servers): the carbs the dose is for, the grams taken off for a drop, the card's
    /// insulin taken off, a dose the caregiver named.
    public var dose_carbs_g: Int? = nil
    public var drop_cover_g: Int? = nil
    public var first_insulin_subtracted_u: Double? = nil
    /// Insulin given by hand since the meal's bolus, taken off the dose (audit 2026-10-26; absent on older servers).
    public var manual_insulin_subtracted_u: Double? = nil
    public var fixed_insulin_u: Double? = nil

    public init(as_of: String, icr_g_per_u: Double?, insulin_for_carbs_u: Double?, loop_extra_u: Double?, smb_u: Double?, temp_basal_extra_u: Double?, insulin_u: Double?, loop_extra_partial: Bool? = nil) {
        self.as_of = as_of
        self.icr_g_per_u = icr_g_per_u
        self.insulin_for_carbs_u = insulin_for_carbs_u
        self.loop_extra_u = loop_extra_u
        self.loop_extra_partial = loop_extra_partial
        self.smb_u = smb_u
        self.temp_basal_extra_u = temp_basal_extra_u
        self.insulin_u = insulin_u
    }
}

public extension SplitBolusPlan {
    /// "za 60 min: 12 g, ok. 1,55 j" for each further part (the card lists them under its timeline).
    var furtherPartLines: [String] {
        (more_parts ?? []).map { part in
            let when = LaterTriggerText.condition(trigger: part.laterTrigger, thresholdMgdl: part.threshold_mgdl) ?? "za \(part.later_after_minutes) min"
            let dose = part.fixed_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "ok. \(RemoteCommandFormat.units(part.later_insulin_u)) j"
            return part.later_carbs_g > 0 ? "\(when): \(part.later_carbs_g) g, \(dose)" : "\(when): \(dose)"
        }
    }
}

/// The words for a later part's condition (later-plan.v1), shared by the chat card, the meal page and the reminder card.
public enum LaterTriggerText {
    /// "gdy glukoza zacznie rosnąć"; nil for a time (AFTER_MINUTES / AT_TIME).
    public static func condition(trigger: String, thresholdMgdl: Int?) -> String? {
        switch trigger {
        case "GLUCOSE_STOPPED_FALLING": return "gdy glukoza przestanie spadać"
        case "GLUCOSE_RISING": return "gdy glukoza zacznie rosnąć"
        case "GLUCOSE_ABOVE": return "gdy glukoza przekroczy \(thresholdMgdl.map(String.init) ?? "próg") mg/dL"
        case "GLUCOSE_BELOW": return "gdy glukoza spadnie poniżej \(thresholdMgdl.map(String.init) ?? "progu") mg/dL"
        default: return nil
        }
    }

    /// The timeline's short label: "za 60 min", "po spadku", "gdy rośnie", "> 180".
    public static func short(trigger: String, afterMinutes: Int, thresholdMgdl: Int?) -> String {
        switch trigger {
        case "GLUCOSE_STOPPED_FALLING": return "po spadku"
        case "GLUCOSE_RISING": return "gdy rośnie"
        case "GLUCOSE_ABOVE": return "> \(thresholdMgdl.map(String.init) ?? "próg")"
        default: return "za \(afterMinutes) min"
        }
    }
}

/// GET /v1/patients/{id}/meals/{mealId}/planned-bolus: the plan with the dose now and the command sent for it.
public struct PlannedBolusDetail: Codable, Equatable {
    public let id: String
    public let status: String
    public let due_at: String
    public let delay_minutes: Int
    public let now_percent: Int
    public let carbs_g: Int
    public let planned_insulin_u: Double
    public let first_carbs_g: Int
    public let first_insulin_u: Double
    public let resolved_at: String?
    public let resolved_by_name: String?
    public let given_insulin_u: Double?
    public let sending: Bool
    public let meal_started_at: String?
    public let estimate: PlannedBolusEstimate?
    public let command: ConversationBolusProposal.SentCommand?
    public var kind: String? = nil
    public var trigger: String? = nil
    public var threshold_mgdl: Int? = nil
    public var wait_until: String? = nil
    /// Grams of meal changes this part took since it was planned (absent on older servers; negative: carbs removed).
    public var meal_change_g: Int? = nil
    public var fixed_insulin_u: Double? = nil
    public var cancelled_by_meal_change: Bool? = nil

    public var isDeferred: Bool { kind == "DEFERRED_INSULIN" }

    /// The meal was changed after the part was planned: its dose follows (or, named in the plan, must be checked).
    public var mealChangeNotice: RemoteCommandNotice? {
        guard let change = meal_change_g, change != 0 else { return nil }
        let grams = "\(change > 0 ? "+" : "−")\(abs(change)) g"
        let message = fixed_insulin_u != nil
            ? "Posiłek zmieniono po zaplanowaniu (\(grams)), a dawka tej części była ustalona z góry: przelicz ją."
            : "Posiłek zmieniono po zaplanowaniu (\(grams)): węglowodany i dawka tej części są już przeliczone."
        return RemoteCommandNotice(code: "MEAL_CHANGED", message: message, severity: "DANGER")
    }

    public var summary: PlannedBolusSummary {
        var summary = PlannedBolusSummary(id: id, status: status, due_at: due_at, delay_minutes: delay_minutes, now_percent: now_percent, carbs_g: carbs_g, planned_insulin_u: planned_insulin_u, first_carbs_g: first_carbs_g, first_insulin_u: first_insulin_u, resolved_at: resolved_at, resolved_by_name: resolved_by_name, given_insulin_u: given_insulin_u, sending: sending, kind: kind, trigger: trigger, threshold_mgdl: threshold_mgdl, wait_until: wait_until)
        summary.cancelled_by_meal_change = cancelled_by_meal_change
        return summary
    }

    /// The dose the card offers: the estimate now, or the planned one when it could not be computed.
    public var doseNow: Double { estimate?.insulin_u ?? planned_insulin_u }

    /// "Podaj" is offered: the part is open, nobody is sending it, and no command for it is on its way or answered.
    public var canGiveNow: Bool {
        summary.canGive && (command.map { ["EXPIRED", "SEND_FAILED"].contains($0.status) } ?? true)
    }

    /// The estimate is recent enough to give from (new SMBs and basal changes move the dose): the Bolus tab's limit.
    public func estimateIsFresh(at now: Date) -> Bool {
        guard let asOf = estimate.flatMap({ ServerDate.parse($0.as_of) }) else { return false }
        return now.timeIntervalSince(asOf) <= RemoteBolusViewModel.previewMaxAge
    }

    /// The confirmation's values: the deferred carbs and the dose now, as this meal's second part.
    public func draftBase() -> RemoteBolusDraftBase {
        RemoteBolusDraftBase(
            source: .plannedBolus,
            carbsG: carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", doseNow), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(doseNow),
            plannedBolusID: id
        )
    }

    /// Trio refused it: the insulin alone when it kept the carbs (PARTIAL), both otherwise.
    public func retryBase() -> RemoteBolusDraftBase? {
        guard let command, command.retry_until != nil, command.status == "PARTIAL" || command.status == "REJECTED" else { return nil }
        let carbsKept = command.status == "PARTIAL"
        return RemoteBolusDraftBase(
            source: .plannedBolus,
            carbsG: carbsKept ? 0 : command.carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", command.insulin_u), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(command.insulin_u),
            followsCommandID: command.id,
            plannedBolusID: id
        )
    }
}

public struct PlannedBolusResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal: MealDetail
    public let planned_bolus: PlannedBolusDetail?
}

public struct PlannedBolusSkipRequest: Encodable, Equatable {
    public let planned_bolus_id: String
}

public protocol PlannedBolusAPI {
    func getMealPlannedBolus(patientID: String, mealID: String) async throws -> PlannedBolusResponse
    /// One part of the meal (`plannedBolusID`; the server falls back to the current part when it is absent or unknown).
    func getMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String?) async throws -> PlannedBolusResponse
    func skipMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String) async throws -> PlannedBolusResponse
}

public extension PlannedBolusAPI {
    func getMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String?) async throws -> PlannedBolusResponse {
        try await getMealPlannedBolus(patientID: patientID, mealID: mealID)
    }
}

extension APIClient: PlannedBolusAPI {}
