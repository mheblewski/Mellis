import Foundation

public struct MealWbtReminder: Decodable, Equatable {
    public let enabled: Bool
    /// AUTO (from the macros) or MANUAL (the caregiver's choice).
    public let source: String
    public let remind_at: String
    /// SCHEDULED, SENT or SKIPPED.
    public let status: String
}

public struct MealWbtInfo: Decodable, Equatable {
    public let fat_protein_units: Double?
    /// WBT x 10 / ICR x 30% with the ICR of the meal's time (absent on older servers).
    public var standard_dose_u: Double? = nil
    /// The macros reach the automatic threshold (>= 1.5 WBT, >= 18 g fat or >= 20 g protein).
    public let auto_threshold_met: Bool
    /// nil until the meal has macros or the caregiver sets the reminder.
    public let reminder: MealWbtReminder?
}

public struct MealWbtReminderRequest: Codable, Equatable {
    public let enabled: Bool
}

public struct WbtSuggestionResult: Decodable, Equatable {
    /// HISTORY (>= 3 personal cases) or STANDARD (WBT x (10 g / ICR) x 30%).
    public let basis: String
    public let dose_units: Double
    public let carbs_equivalent_g: Double?
    public let rationale: String
    // history_cases / history_cases_used (the personal cases behind a HISTORY dose) are still sent but not shown.
}

public struct WbtSuggestion: Decodable, Equatable {
    public let id: String
    /// PENDING, DONE or FAILED.
    public let status: String
    /// The answer when DONE; nil otherwise (a FAILED row carries only an error code).
    public let result: WbtSuggestionResult?

    enum CodingKeys: String, CodingKey { case id, status, result }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        status = try container.decode(String.self, forKey: .status)
        result = try? container.decodeIfPresent(WbtSuggestionResult.self, forKey: .result)
    }
}

public struct MealWbtSuggestionResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal: MealDetail
    public let suggestion: WbtSuggestion?
    /// The last WBT sent to Trio from this window (absent on older servers or before anything was sent).
    public var remote_command: ConversationBolusProposal.SentCommand? = nil
}

/// The meal a WBT conversation is about (wbt-chat.v1).
public struct ConversationWbt: Codable, Equatable {
    public let meal_id: String
}

/// A WBT dose an answer of the meal's WBT conversation proposed (wbt-chat.v1): given like the WBT screen's dose.
public struct ConversationWbtProposal: Codable, Equatable {
    public let suggestion_id: String
    public let meal_id: String
    public let dose_units: Double
    public let carbs_equivalent_g: Double?
    public let rationale: String
    public var warnings: [String]? = nil
    /// Only the conversation's newest dose can be given: an older one was replaced.
    public let newest: Bool
    /// The meal's WBT command once it was sent after this dose was proposed (newest dose only).
    public var command: ConversationBolusProposal.SentCommand? = nil
}

public struct MealWbtConversationResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal_id: String
    public let conversation_id: String
}

public protocol MealWbtAPI {
    func setMealWbtReminder(patientID: String, mealID: String, enabled: Bool) async throws -> MealResponse
    func requestMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse
    func getMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse
    func openMealWbtConversation(patientID: String, mealID: String) async throws -> MealWbtConversationResponse
}

extension APIClient: MealWbtAPI {}
