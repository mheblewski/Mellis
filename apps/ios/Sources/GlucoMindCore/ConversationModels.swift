import Foundation

public struct ConversationProcessingTimeRange: Codable, Equatable {
    public let start: String?
    public let end: String?
}

public struct ConversationProcessingStep: Codable, Equatable {
    public let execution_id: String?
    public let sequence: Int?
    public let type: String
    public let status: String
    public let label: String
    public let tool: String?
    public let detail: String?
    public let time_range: ConversationProcessingTimeRange?
    public let started_at: String?
    public let completed_at: String?
}

public struct ConversationProcessing: Codable, Equatable {
    public let status: String
    public let current_step: ConversationProcessingStep?
    public let steps: [ConversationProcessingStep]
}

public struct ConversationResponse: Codable, Equatable {
    public let id: String
    public let patient_id: String
    public let origin: String?
    public let trigger_type: String?
    public let conversation_type: String?
    public let workflow_status: String?
    public let awaiting_user_answer: Bool
    public let pending_question: PendingQuestion?
    public let messages: [ConversationMessage]
    public let analysis_id: String?
    public let recommendation_id: String?
    public let processing: ConversationProcessing?
    /// The hypo this conversation is about; nil for other conversations.
    public var episode_id: String? = nil
    /// The hypo screen (episode, CGM curve, report form) of a conversation about a hypo; nil otherwise and from
    /// older servers.
    public var hypo: ConversationHypo? = nil
    /// The answer being written to the latest caregiver message (live-updates.v1); nil otherwise and from older servers.
    public var reply_draft: LiveReplyDraft? = nil
    /// The rescue carbs alert of an alert's conversation (rescue-carbs.v1): forecast, dose and treatment; nil for
    /// other conversations and from older servers.
    public var rescue_carbs: ConversationRescueCarbs? = nil
    /// The meal of a meal's WBT conversation (wbt-chat.v1); nil for other conversations and from older servers.
    public var wbt: ConversationWbt? = nil

    public init(
        id: String,
        patient_id: String,
        origin: String? = nil,
        trigger_type: String? = nil,
        conversation_type: String? = nil,
        workflow_status: String? = nil,
        awaiting_user_answer: Bool,
        pending_question: PendingQuestion?,
        messages: [ConversationMessage],
        analysis_id: String?,
        recommendation_id: String?,
        processing: ConversationProcessing? = nil,
        episode_id: String? = nil,
        hypo: ConversationHypo? = nil,
        reply_draft: LiveReplyDraft? = nil,
        rescue_carbs: ConversationRescueCarbs? = nil,
        wbt: ConversationWbt? = nil
    ) {
        self.id = id
        self.patient_id = patient_id
        self.origin = origin
        self.trigger_type = trigger_type
        self.conversation_type = conversation_type
        self.workflow_status = workflow_status
        self.awaiting_user_answer = awaiting_user_answer
        self.pending_question = pending_question
        self.messages = messages
        self.analysis_id = analysis_id
        self.recommendation_id = recommendation_id
        self.processing = processing
        self.episode_id = episode_id
        self.hypo = hypo
        self.reply_draft = reply_draft
        self.rescue_carbs = rescue_carbs
        self.wbt = wbt
    }
}

public extension ConversationResponse {
    /// The meals this conversation's bolus cards point at (the saved meal, its WBT reminder, its later parts).
    var bolusCardMealIDs: Set<String> {
        var ids: Set<String> = []
        for proposal in messages.flatMap({ $0.bolus_proposals ?? [] }) {
            if let id = proposal.command?.meal_record_id { ids.insert(id) }
            if let id = proposal.wbt_reminder?.meal_id { ids.insert(id) }
            for part in (proposal.planned_parts ?? []) + [proposal.planned_bolus].compactMap({ $0 }) {
                if let id = part.meal_record_id { ids.insert(id) }
            }
        }
        return ids
    }

    /// A POST reply (send, answer, cancel, retry) as the screen keeps it: older servers return there only the
    /// conversation's messages and state, not what GET adds (the hypo screen, rescue carbs, the answer being written,
    /// the cards of each answer). What the reply lacks is kept from `current` until the next GET replaces it.
    func keepingViewFields(of current: ConversationResponse?) -> ConversationResponse {
        guard let current, current.id == id else { return self }
        // The answer being written stays only while it still answers the latest caregiver message.
        let latestUserMessageID = messages.last(where: { $0.message_type.uppercased() == "USER_MESSAGE" })?.id
        let keptDraft = current.reply_draft.flatMap { $0.reply_to_message_id == latestUserMessageID ? $0 : nil }
        let earlier = Dictionary(current.messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ConversationResponse(
            id: id,
            patient_id: patient_id,
            origin: origin,
            trigger_type: trigger_type,
            conversation_type: conversation_type,
            workflow_status: workflow_status,
            awaiting_user_answer: awaiting_user_answer,
            pending_question: pending_question,
            messages: messages.map { message in
                guard let old = earlier[message.id] else { return message }
                var kept = message
                if kept.meal_actions == nil { kept.meal_actions = old.meal_actions }
                if kept.bolus_proposals == nil { kept.bolus_proposals = old.bolus_proposals }
                if kept.rescue_carb_proposals == nil { kept.rescue_carb_proposals = old.rescue_carb_proposals }
                if kept.care_reminders == nil { kept.care_reminders = old.care_reminders }
                if kept.answer_options == nil { kept.answer_options = old.answer_options }
                if kept.wbt_proposal == nil { kept.wbt_proposal = old.wbt_proposal }
                return kept
            },
            analysis_id: analysis_id,
            recommendation_id: recommendation_id,
            processing: processing,
            episode_id: episode_id ?? current.episode_id,
            hypo: hypo ?? current.hypo,
            reply_draft: reply_draft ?? keptDraft,
            rescue_carbs: rescue_carbs ?? current.rescue_carbs,
            wbt: wbt ?? current.wbt
        )
    }
}

public struct ConversationsListResponse: Codable, Equatable {
    public let patient_id: String
    public let items: [ConversationListItem]
    public let next_cursor: String?
}

public struct ConversationListItem: Codable, Equatable, Identifiable {
    public let id: String
    public let patient_id: String
    public let episode_id: String?
    public let trigger_id: String?
    public let origin: String
    public let trigger_type: String?
    public let thread_state_version: String
    public let awaiting_user_answer: Bool
    public let conversation_type: String
    public let workflow_status: String
    public let analysis_id: String?
    public let recommendation_id: String?
    public let created_at: String
    public let updated_at: String
    /// Status snapshot taken with the list (AWAITING_ANSWER, PROCESSING, COMPLETED, FAILED, CANCELLED, NONE);
    /// nil from servers that do not report it.
    public let activity_status: String?
    public let activity_checked_at: String?
    /// The first question the user asked (shortened by the server); nil for conversations without one.
    public let title_preview: String?
    /// The conversation's name: written by the AI with the first answer or set by a caregiver; nil until there is one
    /// (and from older servers).
    public var title: String? = nil
    /// Set while the conversation is pinned to the top of the history; nil otherwise and from older servers.
    public var pinned_at: String? = nil
}

public struct CreateConversationResponse: Codable, Equatable {
    public let conversation: ConversationResponse
}

public struct PendingQuestion: Codable, Equatable {
    public let question_id: String
    public let question_type: String
    public let question_text: String
    public let expected_answer_types: [AnswerType]
    public let reason: String
    public let expected_information_gain: String
    public let status: String
    public let created_at: String
    /// One-tap answers chosen by the server (e.g. "2 g", "4 g" for carbohydrates); nil from older servers, then the
    /// app offers Tak / Nie / Nie wiem.
    public var answer_options: [QuestionAnswerOption]? = nil
}

/// A one-tap answer to a question; a TEXT option sends its answer_text as the caregiver's answer.
public struct QuestionAnswerOption: Codable, Equatable, Hashable {
    public let label: String
    public let answer_type: AnswerType
    public let answer_text: String?

    public init(label: String, answer_type: AnswerType, answer_text: String? = nil) {
        self.label = label
        self.answer_type = answer_type
        self.answer_text = answer_text
    }
}

public struct ConversationMessage: Codable, Equatable, Identifiable {
    public let id: String
    public let role: String
    public let message_type: String
    public let content: String
    public let question_id: String?
    public let answer_type: AnswerType?
    public let answer_text: String?
    public let ai_cost: AIResponseCost?
    public let created_at: String
    /// USER_MESSAGE only: "CANCELLED" when the analysis for this message was cancelled (durable server state).
    public let response_status: String?
    /// USER_MESSAGE only: the server can still cancel the analysis answering this message.
    public let analysis_cancellable: Bool?
    /// AI answers only: short next questions the caregiver can tap (absent on older messages and servers).
    public var suggested_follow_ups: [String]? = nil
    /// AI answers only: the one suggestion the model marked as most worth tapping, shown highlighted (absent on older
    /// messages and servers, and when no suggestion was marked).
    public var hot_suggested_follow_up: String? = nil
    /// AI answers only: the knowledge-base fragments the answer cites as [S1], [S2]... (absent on older messages and
    /// servers, and when the answer cites no source).
    public var knowledge_sources: [KnowledgeSource]? = nil
    /// Caregiver messages only: who wrote it, in a conversation shared by both caregivers (absent on older messages,
    /// system/AI messages and older servers).
    public var author_display_name: String? = nil
    /// Caregiver messages only: photos attached to the message (absent on older messages and servers).
    public var photo_ids: [String]? = nil
    /// AI answers only: meal changes the answer prepared, each confirmed on its own card (absent on older servers).
    public var meal_actions: [ConversationMealAction]? = nil
    /// AI answers only: bolus cards the answer prepared (absent on older servers and without remote commands).
    public var bolus_proposals: [ConversationBolusProposal]? = nil
    /// AI answers in a rescue carbs alert's conversation only: other rescue doses the answer proposed (absent on older
    /// servers).
    public var rescue_carb_proposals: [ConversationRescueCarbProposal]? = nil
    /// AI answers only: reminders the answer set (absent on older servers).
    public var care_reminders: [ConversationCareReminder]? = nil
    /// AI answers only: the options the answer offers, each with its cards (absent without options and on older
    /// servers).
    public var answer_options: [AnswerOption]? = nil
    /// AI answers in a meal's WBT conversation only: the WBT dose the answer proposed (absent otherwise).
    public var wbt_proposal: ConversationWbtProposal? = nil

    public var isAnalysisCancelled: Bool {
        response_status?.uppercased() == "CANCELLED"
    }

    /// The text shown in the bubble: answers given with a button read "Tak" / "Nie" / "Nie wiem", also on older
    /// messages the server stored as YES / NO / UNKNOWN.
    public var displayContent: String {
        guard message_type.uppercased() == "CONTEXT_ANSWER" else {
            return content
        }

        switch answer_type {
        case .yes:
            return "Tak"
        case .no:
            return "Nie"
        case .unknown:
            return "Nie wiem"
        case .text, nil:
            return content
        }
    }
}

/// One guideline or manual fragment an AI answer cites; `ref` is the marker in the answer text ("S1").
public struct KnowledgeSource: Codable, Equatable, Hashable {
    public let ref: String
    public let title: String
    public let section: String?
    public let page: Int?
    public let page_end: Int?
    /// The original (guideline, article, documentation page) the reader can open; nil for sources without a link.
    public let url: String?

    public init(ref: String, title: String, section: String? = nil, page: Int? = nil, page_end: Int? = nil, url: String? = nil) {
        self.ref = ref
        self.title = title
        self.section = section
        self.page = page
        self.page_end = page_end
        self.url = url
    }

    /// The link to open: http(s) only, anything else is ignored.
    public var originalURL: URL? {
        guard let url, let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http", parsed.host != nil else {
            return nil
        }
        return parsed
    }

    /// "ISPAD 2022: Sick day management · 8.3.2 Ketones · s. 5–6": the last part of a section path (at most 80
    /// characters), pages when known.
    public var displayDetail: String {
        var parts = [title]
        if let section, let last = section.components(separatedBy: " > ").last?.trimmingCharacters(in: .whitespaces), !last.isEmpty {
            // Table captions can be long: one line is enough to recognise the place in the source.
            parts.append(last.count > 80 ? String(last.prefix(79)).trimmingCharacters(in: .whitespaces) + "…" : last)
        }
        if let page {
            if let page_end, page_end != page {
                parts.append("s. \(page)–\(page_end)")
            } else {
                parts.append("s. \(page)")
            }
        }
        return parts.joined(separator: " · ")
    }
}

public struct RetryAnalysisResponse: Codable, Equatable {
    /// REQUEUED or NOT_FAILED (nothing failed for that message: already answered or already retried).
    public let result: String
    public let message_id: String
    public let conversation: ConversationResponse
}

public struct CancelAnalysisResponse: Codable, Equatable {
    /// CANCELLED, ALREADY_CANCELLED, ALREADY_COMPLETED or NOT_CANCELLABLE.
    public let result: String
    public let message_id: String
    public let conversation: ConversationResponse
}

public struct AIResponseCost: Codable, Equatable {
    public let status: String
    public let amount: Double?
    public let currency: String?
    public let pricing_version: String?
    public let provider: String?
    public let model: String?
}

public enum AnswerType: String, Codable, CaseIterable {
    case yes = "YES"
    case no = "NO"
    case unknown = "UNKNOWN"
    case text = "TEXT"
}

public struct MessageSubmissionRequest: Codable {
    public let question_id: String
    public let message_type: String
    public let answer: MessageAnswer

    public init(questionID: String, answer: MessageAnswer) {
        self.question_id = questionID
        self.message_type = "CONTEXT_ANSWER"
        self.answer = answer
    }
}

public struct UserMessageSubmissionRequest: Codable {
    public let message_type: String
    public let content: String
    /// Photos uploaded to the conversation first; left out of the body when there are none.
    public let photo_ids: [String]?
    /// This phone can give a bolus to the patient (remote control set up): the answer may prepare bolus cards. Left out
    /// otherwise.
    public let bolus_cards: Bool?
    /// This build can confirm rescue carb cards outside an alert's chat, so the answer may prepare them.
    public let rescue_cards: Bool
    /// This phone's own send limits, with bolus_cards: a card above them gets a warning instead of being refused at send.
    public let phone_limits: PhoneSendLimits?

    public init(content: String, photoIDs: [String] = [], bolusCards: Bool = false, phoneLimits: PhoneSendLimits? = nil) {
        self.message_type = "USER_MESSAGE"
        self.content = content
        self.photo_ids = photoIDs.isEmpty ? nil : photoIDs
        self.bolus_cards = bolusCards ? true : nil
        self.rescue_cards = true
        self.phone_limits = bolusCards ? phoneLimits : nil
    }
}

/// The remote control limits set on this phone for one patient (max bolus, max carbs).
public struct PhoneSendLimits: Codable, Equatable, Sendable {
    public let max_bolus_u: Double
    public let max_carbs_g: Int

    public init(maxBolusUnits: Decimal, maxCarbsGrams: Int) {
        self.max_bolus_u = NSDecimalNumber(decimal: maxBolusUnits).doubleValue
        self.max_carbs_g = maxCarbsGrams
    }

    /// The limits saved for this patient on this phone; nil when remote control is not set up here.
    public static func load(patientID: String, store: TrioRemoteSettingsStore = KeychainTrioRemoteSettingsStore()) -> PhoneSendLimits? {
        guard let settings = try? store.load(patientID: patientID) else { return nil }
        return PhoneSendLimits(maxBolusUnits: settings.maxBolusUnits, maxCarbsGrams: settings.maxCarbsGrams)
    }
}

/// Body of PATCH /conversations/{id}; a nil field is left out and stays unchanged on the server.
public struct ConversationUpdateRequest: Encodable, Equatable {
    public let title: String?
    public let pinned: Bool?

    public init(title: String? = nil, pinned: Bool? = nil) {
        self.title = title
        self.pinned = pinned
    }
}

public struct MessageAnswer: Codable {
    public let type: AnswerType
    public let text: String?

    public init(type: AnswerType, text: String? = nil) {
        self.type = type
        self.text = text
    }
}

public struct MessageSubmissionResponse: Codable, Equatable {
    public let message: ConversationMessage
    public let conversation: ConversationResponse
    public let decision: String?
}

public struct RecommendationResponse: Codable, Equatable {
    public let id: String
    public let status: String
    public let proposal: RecommendationProposal
}

public struct RecommendationProposal: Codable, Equatable {
    public let type: String
    public let title: String
    public let text: String
    public let recommendation_type: String?
}

public struct DeviceRegistrationRequest: Codable {
    public let platform: String
    public let device_id: String
    public let push_token: String
    public let app_version: String?
    /// The phone's release secret (DeviceReleaseSecret); left out by older builds.
    public var release_secret: String? = nil
}

/// POST /v1/devices/release (no session): the phone's sign-out that could not be sent, later.
public struct DeviceReleaseRequest: Codable, Equatable {
    public let platform: String
    public let push_token: String
    public let release_secret: String
}

/// POST /v1/me/devices/sign-out: this phone stops getting the signed-in caregiver's notifications.
public struct DeviceSignOutRequest: Codable, Equatable {
    public let push_token: String
    public let platform: String
}

public struct DeviceRegistrationResponse: Codable, Equatable {
    public let device: RegisteredDevice
}

public struct RegisteredDevice: Codable, Equatable {
    public let id: String
    public let patient_id: String
    public let platform: String
    public let device_id: String
    public let push_token: String
    public let active: Bool
}

public struct AccessiblePatientsResponse: Codable, Equatable {
    public let user_id: String
    /// The caregiver's own name (absent on older servers, null when the account has none).
    public var user_display_name: String? = nil
    public let patients: [AccessiblePatient]
}

public struct AccessiblePatient: Codable, Equatable {
    public let patient_id: String
    public let display_name: String
    /// The patient's year of birth ("Rok urodzenia"); null until a caregiver has set it.
    public var birth_year: Int?
    /// The server knows the year of birth (it sends the field, null or not): only then does the app ask for it. An older
    /// server has no way to save it.
    public var supportsBirthYear: Bool

    /// The app asks for the year of birth before anything else (the AI states the patient's age from it).
    public var needsBirthYear: Bool {
        supportsBirthYear && birth_year == nil
    }

    public init(patient_id: String, display_name: String, birth_year: Int? = nil, supportsBirthYear: Bool = false) {
        self.patient_id = patient_id
        self.display_name = display_name
        self.birth_year = birth_year
        self.supportsBirthYear = supportsBirthYear
    }

    private enum CodingKeys: String, CodingKey {
        case patient_id, display_name, birth_year
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        patient_id = try container.decode(String.self, forKey: .patient_id)
        display_name = try container.decode(String.self, forKey: .display_name)
        birth_year = try container.decodeIfPresent(Int.self, forKey: .birth_year)
        supportsBirthYear = container.contains(.birth_year)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(patient_id, forKey: .patient_id)
        try container.encode(display_name, forKey: .display_name)
        if supportsBirthYear {
            try container.encode(birth_year, forKey: .birth_year)
        }
    }
}

/// The year of birth typed in the app: four digits, from 1900 to this year.
public enum PatientBirthYear {
    public static let earliest = 1900

    public static func parse(_ text: String, now: Date = Date(), calendar: Calendar = Calendar(identifier: .gregorian)) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 4, trimmed.allSatisfy(\.isASCII), let year = Int(trimmed) else { return nil }
        guard year >= earliest, year <= calendar.component(.year, from: now) else { return nil }
        return year
    }
}

public struct PatientBirthYearResponse: Codable, Equatable {
    public let patient_id: String
    public let birth_year: Int
}
