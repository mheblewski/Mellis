import Foundation

public struct MealMacroValue: Decodable, Equatable {
    public let grams: Double?
    /// NIGHTSCOUT_ENTRY, AI_PROPOSAL or CAREGIVER; nil when unknown.
    public let origin: String?

    public init(grams: Double?, origin: String?) {
        self.grams = grams
        self.origin = origin
    }
}

public struct MealMacros: Decodable, Equatable {
    public let carbs: MealMacroValue
    public let protein: MealMacroValue
    public let fat: MealMacroValue
}

public struct MealDetail: Decodable, Equatable {
    public let meal_id: String
    /// AWAITING_DESCRIPTION, DESCRIBED, AI_PROPOSED, CONFIRMED, CORRECTED, CANCELLED or INCOMPLETE.
    public let status: String
    public let started_at: String
    public let source_carbs_g: Double?
    public let description: String?
    public let has_photo: Bool
    public let macros: MealMacros
    public let pending_proposal_id: String?
    public let proposal_in_progress: Bool
    /// True when the macro proposal for a DESCRIBED meal failed for good. Older servers omit it.
    public let proposal_failed: Bool?
    public let trusted: Bool
    /// WBT (fat-protein units) and the insulin reminder 2.5 h after the meal (absent on older servers).
    public var wbt: MealWbtInfo? = nil
    /// Counts caregiver changes of the description and values; sent back with a save so it is refused when the other
    /// caregiver saved first (absent on older servers).
    public var content_revision: Int? = nil
}

public struct MealResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal: MealDetail
}

public protocol MealAPI {
    func getMeal(patientID: String, mealID: String) async throws -> MealResponse
    func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse
}

extension APIClient: MealAPI {}

public struct MealCorrectionRequest: Codable, Equatable {
    public let carbs_g: Double?
    public let protein_g: Double?
    public let fat_g: Double?
    public var expected_revision: Int? = nil

    public func encode(to encoder: Encoder) throws {
        // Explicit nulls: a cleared field means "unknown", not "unchanged".
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(carbs_g, forKey: .carbs_g)
        try container.encode(protein_g, forKey: .protein_g)
        try container.encode(fat_g, forKey: .fat_g)
        try container.encodeIfPresent(expected_revision, forKey: .expected_revision)
    }
}

/// Body of a save that only names the meal revision it was based on (accepting a chat proposal).
public struct MealRevisionRequest: Encodable, Equatable {
    public let expected_revision: Int
}
