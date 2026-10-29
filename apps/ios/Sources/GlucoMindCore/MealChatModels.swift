import Foundation

public struct MealChatProposalItem: Codable, Equatable, Identifiable {
    public let name: String
    public let grams: Double?
    public let carbs_g: Double
    public let protein_g: Double
    public let fat_g: Double
    /// DIABCALC (product database) or ESTIMATE (the model's own estimate).
    public let source: String

    public var id: String { "\(name)-\(grams ?? -1)-\(carbs_g)" }
}

public struct MealChatProposal: Decodable, Equatable {
    public let items: [MealChatProposalItem]
    public let carbs_g: Double
    public let protein_g: Double
    public let fat_g: Double
    /// HIGH, MEDIUM or LOW.
    public let confidence: String
    public let assumptions: String
    public let proposal_id: String?
}

public struct MealChatMessage: Decodable, Equatable, Identifiable {
    public let id: String
    /// USER or ASSISTANT.
    public let role: String
    public let content: String
    public let photo_ids: [String]
    public let proposal: MealChatProposal?
    public let question: String?
    public let author_display_name: String?
    public let reply_to_message_id: String?
    public let created_at: String
    /// Set on the note that a change of this meal was confirmed in a conversation (absent on older servers).
    public var origin_conversation_id: String? = nil

    public var isFromCaregiver: Bool { role == "USER" }
    public var isConversationNote: Bool { origin_conversation_id != nil }
}

public struct MealChatResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal: MealDetail
    public let messages: [MealChatMessage]
    public let reply_pending: Bool
    public let reply_failed: Bool
    /// The reply being written while reply_pending (live-updates.v1); absent on older servers.
    public var reply_draft: LiveReplyDraft? = nil
}

public struct MealChatPostRequest: Encodable, Equatable {
    public let content: String?
    public let photo_ids: [String]
}

public struct MealDescriptionUpdateRequest: Encodable, Equatable {
    public let description: String
    public var expected_revision: Int? = nil
}

public struct MealPhotoUploadRequest: Encodable, Equatable {
    public let content_type: String
    public let data_base64: String
}

public struct MealPhotoUploadResponse: Decodable, Equatable {
    public let patient_id: String
    public let photo_id: String
}

public protocol MealChatAPI: MealAPI {
    func getMealChat(patientID: String, mealID: String) async throws -> MealChatResponse
    func postMealChat(patientID: String, mealID: String, content: String?, photoIDs: [String], idempotencyKey: String) async throws -> MealChatResponse
    func uploadMealPhoto(patientID: String, mealID: String, jpegData: Data) async throws -> MealPhotoUploadResponse
    func mealPhotoData(patientID: String, mealID: String, photoID: String) async throws -> Data
    func acceptMealChatProposal(patientID: String, mealID: String, messageID: String) async throws -> MealChatResponse
    func acceptMealChatProposal(patientID: String, mealID: String, messageID: String, expectedRevision: Int?) async throws -> MealChatResponse
    func updateMealDescription(patientID: String, mealID: String, description: String) async throws -> MealResponse
    func updateMealDescription(patientID: String, mealID: String, description: String, expectedRevision: Int?) async throws -> MealResponse
    func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?, expectedRevision: Int?) async throws -> MealResponse
    func retryMealChatReply(patientID: String, mealID: String) async throws -> MealChatResponse
}

extension APIClient: MealChatAPI {}

public extension MealChatAPI {
    /// Saves naming the meal revision they were based on; refused (409 STALE_WRITE) when the other caregiver saved first.
    /// Clients without revisions (tests) fall back to the unchecked save.
    func acceptMealChatProposal(patientID: String, mealID: String, messageID: String, expectedRevision: Int?) async throws -> MealChatResponse {
        try await acceptMealChatProposal(patientID: patientID, mealID: mealID, messageID: messageID)
    }

    func updateMealDescription(patientID: String, mealID: String, description: String, expectedRevision: Int?) async throws -> MealResponse {
        try await updateMealDescription(patientID: patientID, mealID: mealID, description: description)
    }

    func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?, expectedRevision: Int?) async throws -> MealResponse {
        try await correctMeal(patientID: patientID, mealID: mealID, carbsG: carbsG, proteinG: proteinG, fatG: fatG)
    }
}
