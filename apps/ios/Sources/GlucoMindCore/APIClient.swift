import Foundation

public enum APIAuthorizationMode {
    case bearer(AuthProvider)
    case none
}

public struct APIClient {
    public let baseURL: URL
    public let authorizationMode: APIAuthorizationMode
    public let httpClient: HTTPClient

    private let jsonDecoder = JSONDecoder()
    let jsonEncoder = JSONEncoder()

    public init(baseURL: URL, authProvider: AuthProvider, httpClient: HTTPClient) {
        self.baseURL = baseURL
        self.authorizationMode = .bearer(authProvider)
        self.httpClient = httpClient
    }

    public init(baseURL: URL, authorizationMode: APIAuthorizationMode, httpClient: HTTPClient) {
        self.baseURL = baseURL
        self.authorizationMode = authorizationMode
        self.httpClient = httpClient
    }

    public func getConversation(patientID: String, conversationID: String) async throws -> ConversationResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)", method: "GET")
        return try await decode(request, as: ConversationResponse.self)
    }

    public func getDashboard(patientID: String) async throws -> DashboardResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/dashboard", method: "GET")
        return try await decode(request, as: DashboardResponse.self)
    }

    /// The dashboard chart's history of [from, to) (at most 7 days).
    public func getDashboardHistory(patientID: String, from: Date, to: Date) async throws -> DashboardHistoryResponse {
        let format = ISO8601DateFormatter()
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/dashboard/history",
            method: "GET",
            queryItems: [URLQueryItem(name: "from", value: format.string(from: from)), URLQueryItem(name: "to", value: format.string(from: to))]
        )
        return try await decode(request, as: DashboardHistoryResponse.self)
    }

    /// The time-in-range breakdown of the last 1, 7 or 14 days.
    public func getDashboardTimeInRange(patientID: String, days: Int) async throws -> DashboardTimeInRangePeriod {
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/dashboard/time-in-range",
            method: "GET",
            queryItems: [URLQueryItem(name: "days", value: String(days))]
        )
        return try await decode(request, as: DashboardTimeInRangePeriod.self)
    }

    public func getPendingInvestigation(patientID: String) async throws -> PendingInvestigationResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/pending-investigation", method: "GET")
        return try await decode(request, as: PendingInvestigationResponse.self)
    }

    public func listPendingQuestions(patientID: String) async throws -> PendingQuestionsListResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/pending-questions", method: "GET")
        return try await decode(request, as: PendingQuestionsListResponse.self)
    }

    public func listNotifications(patientID: String, limit: Int = 50) async throws -> NotificationHistoryResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/notifications", method: "GET", queryItems: [URLQueryItem(name: "limit", value: String(limit))])
        return try await decode(request, as: NotificationHistoryResponse.self)
    }

    public func postAnswer(
        patientID: String,
        conversationID: String,
        questionID: String,
        answer: MessageAnswer,
        idempotencyKey: String
    ) async throws -> MessageSubmissionResponse {
        let payload = MessageSubmissionRequest(questionID: questionID, answer: answer)
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/messages", method: "POST")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(payload)
        return try await decode(request, as: MessageSubmissionResponse.self)
    }

    /// Deletes the conversation for every caregiver of the patient. Deleting one that is already gone succeeds too.
    public func deleteConversation(patientID: String, conversationID: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)", method: "DELETE")
        let (data, response) = try await httpClient.perform(request)
        if response.statusCode == 404 {
            return
        }
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    /// Renames and/or pins the conversation for every caregiver of the patient (nil leaves a field unchanged).
    public func updateConversation(patientID: String, conversationID: String, title: String? = nil, pinned: Bool? = nil) async throws {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)", method: "PATCH")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(ConversationUpdateRequest(title: title, pinned: pinned))
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    public func cancelMessageAnalysis(patientID: String, conversationID: String, messageID: String) async throws -> CancelAnalysisResponse {
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/conversations/\(conversationID)/messages/\(messageID)/cancel",
            method: "POST"
        )
        return try await decode(request, as: CancelAnalysisResponse.self)
    }

    /// Answers a caregiver message again after its answer failed (its failed job goes back to the queue).
    public func retryMessageAnalysis(patientID: String, conversationID: String, messageID: String) async throws -> RetryAnalysisResponse {
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/conversations/\(conversationID)/messages/\(messageID)/retry",
            method: "POST"
        )
        return try await decode(request, as: RetryAnalysisResponse.self)
    }

    public func postUserMessage(
        patientID: String,
        conversationID: String,
        content: String,
        photoIDs: [String] = [],
        bolusCards: Bool = false,
        phoneLimits: PhoneSendLimits? = nil,
        idempotencyKey: String
    ) async throws -> MessageSubmissionResponse {
        let payload = UserMessageSubmissionRequest(content: content, photoIDs: photoIDs, bolusCards: bolusCards, phoneLimits: phoneLimits)
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/messages", method: "POST")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(payload)
        return try await decode(request, as: MessageSubmissionResponse.self)
    }

    public func listConversations(
        patientID: String,
        limit: Int = 100,
        cursor: String? = nil
    ) async throws -> ConversationsListResponse {
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/conversations",
            method: "GET",
            queryItems: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor)
            ]
        )
        return try await decode(request, as: ConversationsListResponse.self)
    }

    public func createConversation(patientID: String, idempotencyKey: String) async throws -> CreateConversationResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations", method: "POST")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        return try await decode(request, as: CreateConversationResponse.self)
    }

    public func getRecommendation(patientID: String, recommendationID: String) async throws -> RecommendationResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/recommendations/\(recommendationID)", method: "GET")
        return try await decode(request, as: RecommendationResponse.self)
    }

    public func registerDevice(
        patientID: String,
        deviceID: String,
        pushToken: String,
        appVersion: String?,
        releaseSecret: String? = nil
    ) async throws -> DeviceRegistrationResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/devices", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(DeviceRegistrationRequest(
            platform: "ios",
            device_id: deviceID,
            push_token: pushToken,
            app_version: appVersion,
            release_secret: releaseSecret
        ))

        return try await decode(request, as: DeviceRegistrationResponse.self)
    }

    /// Sign-out: the server stops sending this phone's token the caregiver's notifications (204). Short timeout, since
    /// signing out must not wait for a slow server.
    public func signOutDevice(pushToken: String) async throws {
        var request = try await makeRequest(path: "/v1/me/devices/sign-out", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 5
        request.httpBody = try jsonEncoder.encode(DeviceSignOutRequest(push_token: pushToken, platform: "ios"))
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    /// Releases this phone's rows without a session (204): its sign-out could not be sent before (offline).
    public func releaseDevice(pushToken: String, releaseSecret: String) async throws {
        var request = try await makeRequest(path: "/v1/devices/release", method: "POST", authenticated: false)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = try jsonEncoder.encode(DeviceReleaseRequest(platform: "ios", push_token: pushToken, release_secret: releaseSecret))
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    public func updateMealDescription(patientID: String, mealID: String, description: String) async throws -> MealResponse {
        try await updateMealDescription(patientID: patientID, mealID: mealID, description: description, expectedRevision: nil)
    }

    public func updateMealDescription(patientID: String, mealID: String, description: String, expectedRevision: Int?) async throws -> MealResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/description", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealDescriptionUpdateRequest(description: description, expected_revision: expectedRevision))
        return try await decode(request, as: MealResponse.self)
    }

    public func getMealChat(patientID: String, mealID: String) async throws -> MealChatResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/chat", method: "GET")
        return try await decode(request, as: MealChatResponse.self)
    }

    public func postMealChat(patientID: String, mealID: String, content: String?, photoIDs: [String], idempotencyKey: String) async throws -> MealChatResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/chat", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try jsonEncoder.encode(MealChatPostRequest(content: content, photo_ids: photoIDs))
        return try await decode(request, as: MealChatResponse.self)
    }

    public func uploadMealPhoto(patientID: String, mealID: String, jpegData: Data) async throws -> MealPhotoUploadResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/photos", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = try jsonEncoder.encode(MealPhotoUploadRequest(content_type: "image/jpeg", data_base64: jpegData.base64EncodedString()))
        return try await decode(request, as: MealPhotoUploadResponse.self)
    }

    /// Stores one JPEG for the conversation; the next message lists the returned id in its photo_ids.
    public func uploadConversationPhoto(patientID: String, conversationID: String, jpegData: Data) async throws -> MealPhotoUploadResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/photos", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = try jsonEncoder.encode(MealPhotoUploadRequest(content_type: "image/jpeg", data_base64: jpegData.base64EncodedString()))
        return try await decode(request, as: MealPhotoUploadResponse.self)
    }

    /// A voice message recorded in a chat composer (.m4a) as text; the server keeps nothing.
    public func transcribeVoice(patientID: String, m4aData: Data) async throws -> VoiceTranscriptionResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/transcriptions", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 45
        request.httpBody = try jsonEncoder.encode(VoiceTranscriptionRequest(content_type: "audio/mp4", data_base64: m4aData.base64EncodedString()))
        return try await decode(request, as: VoiceTranscriptionResponse.self)
    }

    public func conversationPhotoData(patientID: String, conversationID: String, photoID: String) async throws -> Data {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/photos/\(photoID)", method: "GET")
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
        return data
    }

    public func mealPhotoData(patientID: String, mealID: String, photoID: String) async throws -> Data {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/photos/\(photoID)", method: "GET")
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
        return data
    }

    public func retryMealChatReply(patientID: String, mealID: String) async throws -> MealChatResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/chat/retry", method: "POST")
        return try await decode(request, as: MealChatResponse.self)
    }

    public func acceptMealChatProposal(patientID: String, mealID: String, messageID: String) async throws -> MealChatResponse {
        try await acceptMealChatProposal(patientID: patientID, mealID: mealID, messageID: messageID, expectedRevision: nil)
    }

    public func acceptMealChatProposal(patientID: String, mealID: String, messageID: String, expectedRevision: Int?) async throws -> MealChatResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/chat/\(messageID)/accept", method: "POST")
        if let expectedRevision {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try jsonEncoder.encode(MealRevisionRequest(expected_revision: expectedRevision))
        }
        return try await decode(request, as: MealChatResponse.self)
    }

    /// Confirms a meal change the AI prepared ("Zatwierdź"); `edited` holds the values changed with "Popraw". A change
    /// prepared on a meal that changed since comes back STALE (nothing written).
    public func applyMealAction(patientID: String, conversationID: String, actionID: String, edited: MealActionEdit?) async throws -> MealActionResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/meal-actions/\(actionID)/apply", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealActionApplyRequest(edited: edited))
        return try await decode(request, as: MealActionResponse.self)
    }

    public func rejectMealAction(patientID: String, conversationID: String, actionID: String) async throws -> MealActionResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/meal-actions/\(actionID)/reject", method: "POST")
        return try await decode(request, as: MealActionResponse.self)
    }

    /// "Cofnij": refused (409 STALE_WRITE) when the meal changed again after the change was saved.
    public func undoMealAction(patientID: String, conversationID: String, actionID: String) async throws -> MealActionResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/meal-actions/\(actionID)/undo", method: "POST")
        return try await decode(request, as: MealActionResponse.self)
    }

    /// "Podano dosłodzenie" in a rescue carbs alert's conversation: stores the carbs in GlucoMind only (not in Nightscout
    /// or the loop) as a hypo treatment. `proposalID`: the chat card it was confirmed from (nil: the alert's dose). 409
    /// RESCUE_ALREADY_LOGGED when the other caregiver logged it first, 404 when the conversation is not an alert's.
    public func logRescueCarbs(patientID: String, conversationID: String, carbsG: Double, givenAt: Date?, proposalID: String?) async throws -> RescueCarbsLogResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/rescue-carbs", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let givenAtText = givenAt.map { date -> String in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.string(from: date)
        }
        request.httpBody = try jsonEncoder.encode(RescueCarbsLogRequest(carbs_g: carbsG, given_at: givenAtText, proposal_id: proposalID))
        return try await decode(request, as: RescueCarbsLogResponse.self)
    }

    /// "Zatwierdź Y g" on a rescue carb card of an ordinary conversation (no alert): logged like "+" → "Dosłodzenie" in
    /// the meals tab (GlucoMind only). 409 RESCUE_ALREADY_LOGGED when the other caregiver confirmed it first, 404 for a
    /// card that is gone.
    public func acceptChatRescueCarbs(patientID: String, conversationID: String, proposalID: String, carbsG: Double, givenAt: Date) async throws -> ChatRescueCarbsAcceptResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/rescue-carb-proposals/\(proposalID)/accept", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        request.httpBody = try jsonEncoder.encode(RescueCarbsLogRequest(carbs_g: carbsG, given_at: formatter.string(from: givenAt), proposal_id: proposalID))
        return try await decode(request, as: ChatRescueCarbsAcceptResponse.self)
    }

    /// "Nie podaję" in a rescue carbs alert's conversation: no carbs for this alert, so no reminder push. 409
    /// RESCUE_ALREADY_LOGGED when carbs were already logged, 404 when the conversation is not an alert's.
    public func declineRescueCarbs(patientID: String, conversationID: String) async throws -> RescueCarbsLogResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/conversations/\(conversationID)/rescue-carbs/decline", method: "POST")
        return try await decode(request, as: RescueCarbsLogResponse.self)
    }

    /// What this phone is sent for the patient (rescue carbs alerts); 404 while the device is not registered.
    public func getDeviceNotificationSettings(patientID: String, deviceID: String) async throws -> DeviceNotificationSettings {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/devices/\(deviceID)/notification-settings", method: "GET")
        return try await decode(request, as: DeviceNotificationSettings.self)
    }

    /// Changes the switches given (nil = left as it is).
    public func setDeviceNotificationSettings(
        patientID: String,
        deviceID: String,
        rescueCarbAlertsEnabled: Bool? = nil,
        answerReadyPushEnabled: Bool? = nil,
        reservoirPushEnabled: Bool? = nil
    ) async throws -> DeviceNotificationSettings {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/devices/\(deviceID)/notification-settings", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(DeviceNotificationSettingsRequest(
            rescue_carb_alerts_enabled: rescueCarbAlertsEnabled,
            answer_ready_push_enabled: answerReadyPushEnabled,
            reservoir_push_enabled: reservoirPushEnabled
        ))
        return try await decode(request, as: DeviceNotificationSettings.self)
    }

    /// This phone's glucose Live Activity (live-activity.v1): the switch, the push-to-start token and the running
    /// activity. Only the fields given are sent; `.clear` sends null (the activity ended).
    public func setLiveActivity(patientID: String, deviceID: String, change: LiveActivityChange) async throws {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/devices/\(deviceID)/live-activity", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: change.body)
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    // MARK: Meals tab

    public func listMealJournal(patientID: String, before: String?, after: String?, limit: Int) async throws -> MealJournalResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/journal", method: "GET", queryItems: query)
        return try await decode(request, as: MealJournalResponse.self)
    }

    public func listMealJournalDays(patientID: String, from: String, to: String) async throws -> MealJournalDaysResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/journal/days", method: "GET", queryItems: [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to)])
        return try await decode(request, as: MealJournalDaysResponse.self)
    }

    public func searchMeals(patientID: String, query: String) async throws -> MealSearchResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/search", method: "GET", queryItems: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: "30")])
        return try await decode(request, as: MealSearchResponse.self)
    }

    public func getMealOverview(patientID: String, mealID: String) async throws -> MealOverviewResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/overview", method: "GET")
        return try await decode(request, as: MealOverviewResponse.self)
    }

    public func setMealReminder(patientID: String, mealID: String, reminderID: String, enabled: Bool) async throws -> MealReminderToggleResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/reminders/\(reminderID)", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealReminderToggleRequest(enabled: enabled))
        return try await decode(request, as: MealReminderToggleResponse.self)
    }

    public func getMeal(patientID: String, mealID: String) async throws -> MealResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)", method: "GET")
        return try await decode(request, as: MealResponse.self)
    }

    public func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse {
        try await correctMeal(patientID: patientID, mealID: mealID, carbsG: carbsG, proteinG: proteinG, fatG: fatG, expectedRevision: nil)
    }

    public func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?, expectedRevision: Int?) async throws -> MealResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/correct", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealCorrectionRequest(carbs_g: carbsG, protein_g: proteinG, fat_g: fatG, expected_revision: expectedRevision))
        return try await decode(request, as: MealResponse.self)
    }

    public func setMealWbtReminder(patientID: String, mealID: String, enabled: Bool) async throws -> MealResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/wbt-reminder", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(MealWbtReminderRequest(enabled: enabled))
        return try await decode(request, as: MealResponse.self)
    }

    public func requestMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/wbt-suggestion", method: "POST")
        return try await decode(request, as: MealWbtSuggestionResponse.self)
    }

    public func getMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/wbt-suggestion", method: "GET")
        return try await decode(request, as: MealWbtSuggestionResponse.self)
    }

    /// The meal's WBT conversation (wbt-chat.v1), created on first use.
    public func openMealWbtConversation(patientID: String, mealID: String) async throws -> MealWbtConversationResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/wbt-conversation", method: "POST")
        return try await decode(request, as: MealWbtConversationResponse.self)
    }

    /// The planned second part of a meal's split bolus, with the dose now.
    public func getMealPlannedBolus(patientID: String, mealID: String) async throws -> PlannedBolusResponse {
        try await getMealPlannedBolus(patientID: patientID, mealID: mealID, plannedBolusID: nil)
    }

    /// One part of the meal by its id (a push names it); the server returns the current part when it is absent or unknown.
    public func getMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String?) async throws -> PlannedBolusResponse {
        let request = try await makeRequest(
            path: "/v1/patients/\(patientID)/meals/\(mealID)/planned-bolus",
            method: "GET",
            queryItems: plannedBolusID.map { [URLQueryItem(name: "planned_bolus_id", value: $0)] } ?? []
        )
        return try await decode(request, as: PlannedBolusResponse.self)
    }

    public func skipMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String) async throws -> PlannedBolusResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/meals/\(mealID)/planned-bolus/skip", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(PlannedBolusSkipRequest(planned_bolus_id: plannedBolusID))
        return try await decode(request, as: PlannedBolusResponse.self)
    }

    /// Cancels a reminder the chat set (either caregiver).
    public func cancelCareReminder(patientID: String, reminderID: String) async throws -> CareReminderCancelResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/care-reminders/\(reminderID)/cancel", method: "POST")
        return try await decode(request, as: CareReminderCancelResponse.self)
    }

    /// The server's requirements for the app (minimum build); public, read before sign-in.
    public func getAppConfig() async throws -> AppConfigResponse {
        let request = try await makeRequest(path: "/v1/app-config", method: "GET", authenticated: false)
        return try await decode(request, as: AppConfigResponse.self)
    }

    public func getCapabilities(patientID: String) async throws -> PatientCapabilitiesResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/capabilities", method: "GET")
        return try await decode(request, as: PatientCapabilitiesResponse.self)
    }

    /// The patient's Trio as its newest Nightscout profile describes it; refused (403) when remote commands are off.
    public func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-control/trio", method: "GET")
        return try await decode(request, as: TrioRemoteTargetResponse.self)
    }

    public func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
        try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: mealInMinutes, proposalID: proposalID, source: nil)
    }

    /// dose_default=CALCULATOR: an empty dose starts from the loop-style calculator's default (dose-calculator.v1).
    public func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?, source: RemoteCommandSource?) async throws -> RemoteCommandPreview {
        try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: mealInMinutes, proposalID: proposalID, source: source, plannedBolusID: nil)
    }

    /// `plannedBolusID`: a planned part is checked against the server's own estimate for it (dose-calculator.v1 review M2).
    public func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?, source: RemoteCommandSource?, plannedBolusID: String?) async throws -> RemoteCommandPreview {
        var query = [URLQueryItem(name: "carbs_g", value: String(carbsG)), URLQueryItem(name: "bolus_step", value: "\(bolusStep)"), URLQueryItem(name: "dose_default", value: "CALCULATOR")]
        if let source {
            query.append(URLQueryItem(name: "source", value: source.rawValue))
        }
        if let plannedBolusID {
            query.append(URLQueryItem(name: "planned_bolus_id", value: plannedBolusID))
        }
        if let proposalID {
            query.append(URLQueryItem(name: "proposal_id", value: proposalID))
        }
        if let mealInMinutes {
            query.append(URLQueryItem(name: "meal_in_minutes", value: String(mealInMinutes)))
        }
        if let insulinU {
            query.append(URLQueryItem(name: "insulin_u", value: "\(insulinU)"))
        }
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/preview", method: "GET", queryItems: query)
        return try await decode(request, as: RemoteCommandPreview.self)
    }

    public func authorizeRemoteCommand(patientID: String, request body: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(body)
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/\(commandID)/sent", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(RemoteCommandSentReport(accepted: accepted, message: message))
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/\(commandID)/reply", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(RemoteCommandReplyReport(success: success, message: message))
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String, step: LoopCommandStep) async throws -> RemoteCommand {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/\(commandID)/reply", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(RemoteCommandReplyReport(success: success, message: message, step: step))
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func reportLoopBolusWithheld(patientID: String, commandID: String, message: String) async throws -> RemoteCommand {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/\(commandID)/reply", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(RemoteCommandReplyReport(success: false, message: message, step: .bolus, withheld: true))
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func getLoopRemoteTarget(patientID: String) async throws -> LoopRemoteTargetResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-control/loop", method: "GET")
        return try await decode(request, as: LoopRemoteTargetResponse.self)
    }

    public func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands/\(commandID)", method: "GET")
        return try await decode(request, as: RemoteCommandResponse.self).command
    }

    public func listRemoteCommands(patientID: String, limit: Int = 20) async throws -> [RemoteCommand] {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-commands", method: "GET", queryItems: [URLQueryItem(name: "limit", value: String(limit))])
        return try await decode(request, as: RemoteCommandListResponse.self).items
    }

    /// "Rok urodzenia" of the patient (PUT birth-year).
    public func setPatientBirthYear(patientID: String, birthYear: Int) async throws -> PatientBirthYearResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/birth-year", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(["birth_year": birthYear])
        return try await decode(request, as: PatientBirthYearResponse.self)
    }

    /// "Instrukcje dla Mellis" of the signed-in user (for every patient).
    public func getUserAiPreferences() async throws -> UserAiPreferences {
        let request = try await makeRequest(path: "/v1/me/ai-preferences", method: "GET")
        return try await decode(request, as: UserAiPreferences.self)
    }

    /// Replaces "Instrukcje dla Mellis"; the server answers with what it stored (trimmed).
    public func setUserAiPreferences(_ preferences: UserAiPreferences) async throws -> UserAiPreferences {
        var request = try await makeRequest(path: "/v1/me/ai-preferences", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(preferences)
        return try await decode(request, as: UserAiPreferences.self)
    }

    public func listAccessiblePatients() async throws -> AccessiblePatientsResponse {
        let request = try await makeRequest(path: "/v1/me/patients", method: "GET")
        return try await decode(request, as: AccessiblePatientsResponse.self)
    }

    func decode<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
        return try jsonDecoder.decode(T.self, from: data)
    }

    func makeRequest(path: String, method: String, queryItems: [URLQueryItem] = [], authenticated: Bool = true) async throws -> URLRequest {
        guard let rawURL = URL(string: path, relativeTo: baseURL) else {
            throw APIClientError.invalidResponse
        }

        var components = URLComponents(url: rawURL, resolvingAgainstBaseURL: true)
        let validQueryItems = queryItems.filter { item in
            if let value = item.value {
                return !value.isEmpty
            }

            return false
        }

        if !validQueryItems.isEmpty {
            components?.queryItems = validQueryItems
        }

        let url = components?.url ?? rawURL

        var request = URLRequest(url: url)
        request.httpMethod = method
        if authenticated, case let .bearer(authProvider) = authorizationMode {
            let token = try await authProvider.bearerToken()
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15
        return request
    }

    func mapErrorStatusIfNeeded(status: Int, body: Data) throws {
        if let error = Self.error(status: status, body: body) {
            throw error
        }
    }

    /// The error a non-2xx answer maps to (nil for 2xx); shared with the event stream.
    public static func error(status: Int, body: Data) -> APIClientError? {
        guard !(200...299).contains(status) else {
            return nil
        }

        let problem = try? JSONDecoder().decode(ProblemDetails.self, from: body)
        switch status {
        case 401:
            return .unauthenticated(problem)
        case 403:
            return .forbidden(problem)
        case 404:
            return .notFound(problem)
        case 409:
            return .conflict(problem)
        case 422:
            return .validation(problem)
        case 500:
            return .server(problem)
        default:
            return .unexpectedStatus(status, problem)
        }
    }

    /// The live event stream of a patient (text/event-stream). Heartbeats arrive every 15 s, so 45 s without any byte
    /// means the connection is dead.
    public func liveEventsRequest(patientID: String) async throws -> URLRequest {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/events", method: "GET")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 45
        return request
    }
}

extension APIClient: MealJournalAPI {}
