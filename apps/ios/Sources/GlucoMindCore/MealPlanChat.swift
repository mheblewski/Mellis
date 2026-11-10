import Foundation

/// The planned meal's chat as the server sends it: the entry after the change and the messages.
public struct MealPlanChatResponse: Decodable, Equatable {
    public struct Message: Decodable, Equatable {
        public let id: String
        public let accepted_at: String?
    }

    public let patient_id: String
    public let entry: MealPlanEntry
    public let messages: [MealChatMessage]
    public let reply_pending: Bool
    public let reply_failed: Bool
    /// The same messages again, for what the meal chat's model has no field for.
    public let acceptance: [Message]

    private enum CodingKeys: String, CodingKey { case patient_id, entry, messages, reply_pending, reply_failed }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        patient_id = try container.decode(String.self, forKey: .patient_id)
        entry = try container.decode(MealPlanEntry.self, forKey: .entry)
        messages = try container.decode([MealChatMessage].self, forKey: .messages)
        acceptance = try container.decode([Message].self, forKey: .messages)
        reply_pending = try container.decode(Bool.self, forKey: .reply_pending)
        reply_failed = try container.decode(Bool.self, forKey: .reply_failed)
    }

    /// Read as a meal chat, so the page shows it with the meal chat's thread and composer. The "meal" is the planned
    /// one; it counts as accepted (the card shows "Zatwierdzone") when its latest proposal was accepted.
    public var asMealChat: MealChatResponse {
        let latest = messages.last(where: { $0.proposal != nil })
        let accepted = latest.flatMap { latest in acceptance.first(where: { $0.id == latest.id })?.accepted_at } != nil
        let proposal = accepted ? latest?.proposal : nil
        let meal = MealDetail(
            meal_id: entry.id,
            status: "PLANNED",
            started_at: entry.planned_at,
            source_carbs_g: nil,
            description: entry.title,
            has_photo: false,
            macros: MealMacros(
                carbs: MealMacroValue(grams: proposal?.carbs_g, origin: nil),
                protein: MealMacroValue(grams: proposal?.protein_g, origin: nil),
                fat: MealMacroValue(grams: proposal?.fat_g, origin: nil)
            ),
            pending_proposal_id: nil,
            proposal_in_progress: false,
            proposal_failed: nil,
            trusted: accepted
        )
        return MealChatResponse(patient_id: patient_id, meal: meal, messages: messages, reply_pending: reply_pending, reply_failed: reply_failed)
    }
}

struct MealPlanChatPostRequest: Encodable {
    let content: String
    let photo_ids: [String]
    let plate_summary: String?
}

/// The planned meal's bolus card (card A, as in the chat): the card sent from this meal, or a new one; nil with the reason
/// when none can be made now.
public struct MealPlanBolusCardResponse: Decodable {
    public let proposal: ConversationBolusProposal?
    public var problem: String? = nil
}

struct MealPlanBolusCardRequest: Encodable {
    let items: [MealPlanItem]
}

struct MealPlanBolusVariantRequest: Encodable {
    let kind: String
}

struct MealPlanPlateRequest: Encodable {
    let plate: MealPlanPlate
}

public extension APIClient {
    func getMealPlanChat(patientID: String, entryID: String) async throws -> MealPlanChatResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/chat", method: "GET")
        return try await decode(request, as: MealPlanChatResponse.self)
    }

    func postMealPlanChat(patientID: String, entryID: String, content: String, photoIDs: [String], plateSummary: String?, idempotencyKey: String) async throws -> MealPlanChatResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/chat", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try jsonEncoder.encode(MealPlanChatPostRequest(content: content, photo_ids: photoIDs, plate_summary: plateSummary))
        return try await decode(request, as: MealPlanChatResponse.self)
    }

    /// One JPEG for the planned meal's chat (a product label); the next message lists the returned id.
    func uploadMealPlanPhoto(patientID: String, entryID: String, jpegData: Data) async throws -> MealPhotoUploadResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/photos", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = try jsonEncoder.encode(MealPhotoUploadRequest(content_type: "image/jpeg", data_base64: jpegData.base64EncodedString()))
        return try await decode(request, as: MealPhotoUploadResponse.self)
    }

    func mealPlanPhotoData(patientID: String, entryID: String, photoID: String) async throws -> Data {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/photos/\(photoID)", method: "GET")
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
        return data
    }

    func retryMealPlanChat(patientID: String, entryID: String) async throws -> MealPlanChatResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/chat/retry", method: "POST")
        return try await decode(request, as: MealPlanChatResponse.self)
    }

    func acceptMealPlanChat(patientID: String, entryID: String, messageID: String) async throws -> MealPlanChatResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/chat/\(messageID)/accept", method: "POST")
        return try await decode(request, as: MealPlanChatResponse.self)
    }

    func mealPlanBolusCard(patientID: String, entryID: String, items: [MealPlanItem]) async throws -> MealPlanBolusCardResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/bolus-card", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealPlanBolusCardRequest(items: items))
        return try await decode(request, as: MealPlanBolusCardResponse.self)
    }

    func chooseMealPlanBolusVariant(patientID: String, entryID: String, proposalID: String, kind: String) async throws -> MealPlanBolusCardResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/bolus-card/\(proposalID)/variant", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealPlanBolusVariantRequest(kind: kind))
        return try await decode(request, as: MealPlanBolusCardResponse.self)
    }

    func setMealPlanPlate(patientID: String, entryID: String, plate: MealPlanPlate) async throws -> MealPlanEntryResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meal-plan/entries/\(entryID)/plate", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealPlanPlateRequest(plate: plate))
        return try await decode(request, as: MealPlanEntryResponse.self)
    }
}

/// What the planned meal's chat needs from the server, so a fixture can stand in for it.
public protocol MealPlanChatAPI: Sendable {
    func getMealPlanChat(patientID: String, entryID: String) async throws -> MealPlanChatResponse
    func postMealPlanChat(patientID: String, entryID: String, content: String, photoIDs: [String], plateSummary: String?, idempotencyKey: String) async throws -> MealPlanChatResponse
    func uploadMealPlanPhoto(patientID: String, entryID: String, jpegData: Data) async throws -> MealPhotoUploadResponse
    func mealPlanPhotoData(patientID: String, entryID: String, photoID: String) async throws -> Data
    func retryMealPlanChat(patientID: String, entryID: String) async throws -> MealPlanChatResponse
    func acceptMealPlanChat(patientID: String, entryID: String, messageID: String) async throws -> MealPlanChatResponse
}

extension APIClient: MealPlanChatAPI {}

/// The planned meal's chat behind the meal chat's interface: the page reuses its thread, composer and proposal card.
/// The meal id is the entry id. Words and photos (a product label); no edits by hand: a change is accepted from the card
/// or written again.
public final class MealPlanChatBridge: MealChatAPI, VoiceTranscriptionAPI, @unchecked Sendable {
    private let api: MealPlanChatAPI
    private let lock = NSLock()
    private var _plateSummary: String?
    private let onEntry: @MainActor @Sendable (MealPlanEntry) -> Void

    /// `onEntry` is told the entry after each read, so the plan shows the changed dishes at once.
    public init(api: MealPlanChatAPI, onEntry: @escaping @MainActor @Sendable (MealPlanEntry) -> Void = { _ in }) {
        self.api = api
        self.onEntry = onEntry
    }

    /// The plate as the page shows it, sent with each message so Mellis builds on the portions already set.
    public var plateSummary: String? {
        get { lock.withLock { _plateSummary } }
        set { lock.withLock { _plateSummary = newValue } }
    }

    private func read(_ response: MealPlanChatResponse) async -> MealChatResponse {
        await onEntry(response.entry)
        return response.asMealChat
    }

    public func getMealChat(patientID: String, mealID: String) async throws -> MealChatResponse {
        await read(try await api.getMealPlanChat(patientID: patientID, entryID: mealID))
    }

    public func postMealChat(patientID: String, mealID: String, content: String?, photoIDs: [String], idempotencyKey: String) async throws -> MealChatResponse {
        await read(try await api.postMealPlanChat(patientID: patientID, entryID: mealID, content: content ?? "", photoIDs: photoIDs, plateSummary: plateSummary, idempotencyKey: idempotencyKey))
    }

    public func retryMealChatReply(patientID: String, mealID: String) async throws -> MealChatResponse {
        await read(try await api.retryMealPlanChat(patientID: patientID, entryID: mealID))
    }

    public func acceptMealChatProposal(patientID: String, mealID: String, messageID: String) async throws -> MealChatResponse {
        await read(try await api.acceptMealPlanChat(patientID: patientID, entryID: mealID, messageID: messageID))
    }

    /// The mic, as in the meal chat: the server's speech to text when the client has one.
    public func transcribeVoice(patientID: String, m4aData: Data) async throws -> VoiceTranscriptionResponse {
        guard let voice = api as? VoiceTranscriptionAPI else { throw MealPlanChatUnsupported() }
        return try await voice.transcribeVoice(patientID: patientID, m4aData: m4aData)
    }

    public func uploadMealPhoto(patientID: String, mealID: String, jpegData: Data) async throws -> MealPhotoUploadResponse {
        try await api.uploadMealPlanPhoto(patientID: patientID, entryID: mealID, jpegData: jpegData)
    }

    public func mealPhotoData(patientID: String, mealID: String, photoID: String) async throws -> Data {
        try await api.mealPlanPhotoData(patientID: patientID, entryID: mealID, photoID: photoID)
    }

    public func updateMealDescription(patientID: String, mealID: String, description: String) async throws -> MealResponse { throw MealPlanChatUnsupported() }
    public func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?, expectedRevision: Int?) async throws -> MealResponse { throw MealPlanChatUnsupported() }
    public func getMeal(patientID: String, mealID: String) async throws -> MealResponse { throw MealPlanChatUnsupported() }
    public func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse { throw MealPlanChatUnsupported() }
}

struct MealPlanChatUnsupported: Error {}
