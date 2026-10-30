import Foundation
import Combine

@MainActor
public final class ConversationViewModel: ObservableObject {
    public enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    public enum LoadFailure: Equatable {
        case missingConversation
        case unauthenticated
        case forbidden
        case server
        case network
        case decoding
        case unknown
    }

    public enum ProcessingState: Equatable {
        case idle
        case sending
        case processing
        case waitingForNextQuestion
        case complete
        /// The user cancelled the analysis and the server confirmed it.
        case cancelled(String)
        case error(String)

        var id: String {
            switch self {
            case .idle:
                return "idle"
            case .sending:
                return "sending"
            case .processing:
                return "processing"
            case .waitingForNextQuestion:
                return "waiting-for-next-question"
            case .complete:
                return "complete"
            case .cancelled:
                return "cancelled"
            case .error:
                return "error"
            }
        }
    }

    /// What the agent is doing right now, derived only from the local submission state and the backend's
    /// `conversation.processing` steps. Nothing here is estimated or animated progress.
    public struct AgentActivity: Equatable {
        public enum Phase: Equatable {
            case sending
            case waiting
            case analyzing
            case usingTool
            case generating
            case completed
            case cancelled
            case failed
        }

        public let phase: Phase
        public let title: String
        /// Backend step label (e.g. which evidence is being read), when it adds information to the title.
        public let detail: String?
        /// When the backend started this run (first step), for an honest elapsed-time display.
        public let startedAt: Date?

        /// The one line shown while work runs: the backend's specific step label when there is one.
        public var headline: String {
            detail ?? title
        }

        public var isActive: Bool {
            switch phase {
            case .sending, .waiting, .analyzing, .usingTool, .generating:
                return true
            case .completed, .cancelled, .failed:
                return false
            }
        }
    }

    public struct LocalEchoMessage: Identifiable, Equatable {
        public let id: String
        public let content: String
        public let createdAt: String
        /// JPEGs sent with the message, shown until the stored message replaces the echo.
        public var photos: [Data] = []
        /// The messages already in the conversation when it was sent: only a newer one with its text replaces the echo
        /// (a photo sent without text, or a question asked again, has the text of an earlier message).
        public var earlierMessageIDs: Set<String> = []
    }

    public enum TimelineItem: Identifiable, Equatable {
        case assistantMessage(ConversationMessage)
        case userMessage(ConversationMessage)
        case localEcho(LocalEchoMessage)
        case question(PendingQuestion)
        case processing(ProcessingState)
        case recommendation(RecommendationResponse)
        /// The answer while the model writes it (live-updates.v1); replaced by the stored message.
        case assistantDraft(LiveReplyDraft)

        public var id: String {
            switch self {
            case .assistantMessage(let message):
                return "assistant-message-\(message.id)"
            case .userMessage(let message):
                return "user-message-\(message.id)"
            case .localEcho(let localEcho):
                return "local-echo-\(localEcho.id)"
            case .question(let question):
                return "question-\(question.question_id)"
            case .processing(let state):
                return "processing-\(state.id)"
            case .recommendation(let recommendation):
                return "recommendation-\(recommendation.id)"
            case .assistantDraft(let draft):
                return "assistant-draft-\(draft.reply_to_message_id)"
            }
        }
    }

    @Published public private(set) var state: ViewState = .idle
    @Published public private(set) var selectedConversationID: String?
    @Published public private(set) var lastLoadFailure: LoadFailure?
    @Published public private(set) var conversation: ConversationResponse?
    @Published public private(set) var recommendation: RecommendationResponse?
    @Published public private(set) var processingState: ProcessingState = .idle
    @Published public private(set) var isSubmittingAnswer = false
    @Published public private(set) var isSubmittingUserMessage = false
    /// This phone can give a bolus to the patient (remote control set up on it): said with each message, so the answer
    /// prepares bolus cards only for a phone that shows them.
    public var bolusCardsAvailable = false
    /// Read from this phone's remote control settings at each send: the answer's cards warn above them.
    var phoneLimits: () -> PhoneSendLimits? = { nil }
    @Published public private(set) var isCancellingAnalysis = false
    /// Outcome of a cancel request that did not stop the analysis (already answered / not cancellable).
    @Published public private(set) var cancellationNotice: String?
    @Published public private(set) var localEchoMessage: LocalEchoMessage?
    /// The answer being written, as the live stream last reported it.
    @Published private var liveDraft: LiveReplyDraft?
    /// The last draft after the stream cleared it, shown until a read started after the clear has the stored answer
    /// (or shows there is none: a failed attempt). The answer is stored a moment before its draft is cleared, but read
    /// a moment after: without this the answer would vanish and the status line come back in between.
    @Published private var lingeringDraft: (draft: LiveReplyDraft, clearedAt: Date)?
    private var liveUpdates: LiveUpdates?
    private var liveSubscriptions: Set<AnyCancellable> = []
    private var pendingLiveRefresh: Task<Void, Never>?
    /// Bumped on every switch of thread: a load, send or cancel started for an earlier one writes nothing on return.
    private var selectionGeneration = 0
    /// The polling of the thread on screen (after a send, or resumed when a thread still being answered is opened);
    /// another thread stops it, so it never brings the previous thread back on screen.
    private var pollTask: Task<Void, Never>?
    /// The poll allowed to write: an older one (stopped, or replaced) ends without touching the screen.
    private var activePollID = 0
    private var isPolling = false
    private var pollPoked = false
    /// The load of the thread was cancelled with its screen (the tab left while it ran): selecting the same thread
    /// again loads it instead of keeping the spinner.
    private var reloadOnNextSelect = false
    @Published public private(set) var timelineUpdateVersion: Int = 0
    @Published public var textAnswer: String = ""
    @Published public var userMessageText: String = ""
    /// The option chosen under each answer (answered message id → key or AnswerOptionsPresentation.ownPlanKey); absent:
    /// the recommended one. Kept on this phone only.
    @Published public private(set) var answerOptionChoices: [String: String] = [:]
    /// JPEGs picked for the next message (at most 3), with the server id of each one already uploaded, so a retry
    /// after a failed send never uploads a photo twice.
    @Published public private(set) var draftPhotos: [Data] = []
    private var draftPhotoUploadIDs: [String?] = []
    /// Photos already shown or sent from this device, by server id.
    @Published public private(set) var photoCache: [String: Data] = [:]
    @Published public private(set) var isLoggingRescueCarbs = false
    @Published public private(set) var isDecliningRescueCarbs = false
    /// Why the last "Zapisz" in the rescue carbs sheet did not save (the sheet stays open); cleared by the next one.
    @Published public private(set) var rescueCarbsError: String?
    /// Shown in the alert block after the sheet closed without saving (e.g. the other caregiver logged it first).
    @Published public private(set) var rescueCarbsNotice: String?
    /// Meal change cards being confirmed, rejected or undone right now (their buttons show a spinner).
    @Published public private(set) var mealActionsInFlight: Set<String> = []
    /// Why the last tap on a meal change card did not work, by card.
    @Published public private(set) var mealActionErrors: [String: String] = [:]
    /// The latest CGM reading for the cards of an empty new conversation; kept between conversations, so the next
    /// empty one starts with it instead of changing its first card when the reading arrives.
    @Published public private(set) var starterGlucose: DashboardGlucose?
    /// The first dashboard read for the starter cards has ended (with or without a reading): the cards come in only
    /// then (or after a short wait), so the first card never changes right after it appears.
    @Published public private(set) var starterGlucoseSettled = false
    /// The dashboard read for the starter cards in flight (shared by callers that ask at the same time).
    private var starterGlucoseRead: Task<Void, Never>?
    private var starterGlucoseReadAt: Date?
    /// CGM readings come every 5 minutes: a reading this fresh is not read again for the next starter cards.
    static let starterGlucoseFreshness: TimeInterval = 15
    /// Conversations just created on this phone, shown when selected without reading them again.
    private var createdConversations: [String: ConversationResponse] = [:]

    private let apiClient: APIClient
    private let patientID: String
    private let pollInterval: Duration
    private var lastTimelineSignature = ""
    private var shouldExpectFollowUpQuestion = false
    /// Unsent composer text per conversation, so switching or starting a conversation never discards a draft.
    private var drafts: [String: String] = [:]

    // MARK: fresh-chat.v1

    /// An empty new conversation shown on its own (greeting, starter cards) that the server does not know yet: it is
    /// created with the first message sent (fresh-chat.v1). The previous conversation stays in the history.
    @Published public private(set) var isFreshDraft = false
    /// Called when a fresh draft replaced the conversation `previousID` on screen (the tab follows the selection).
    public var onFreshDraftStarted: ((_ previousID: String?) -> Void)?
    /// Called when the first send created the fresh draft's conversation (the tab selects it and reads its history).
    public var onFreshDraftCreated: ((ConversationResponse) -> Void)?
    /// When the tab opened this conversation on purpose (a notification, a link, the dashboard, the history list).
    public var openedOnPurposeAt: (String) -> Date? = { _ in nil }
    /// The draft's text kept here while another conversation is open.
    private static let freshDraftKey = "fresh-draft"
    /// One creation per fresh draft: a retried first send never creates a second conversation.
    private var freshDraftCreationKey = UUID().uuidString.lowercased()
    /// The tab came on screen: once the conversation on screen is read, it is checked for inactivity (dropped after
    /// a short while, so a much later read never replaces a conversation).
    private var freshCheckRequestedAt: Date?
    private static let freshCheckValidity: TimeInterval = 30
    /// A clock for tests.
    var now: () -> Date = Date.init

    /// A send whose outcome is unknown (network/server error). Retrying reuses its idempotency key, so the server
    /// returns the already-stored message instead of creating a second one (and a second analysis).
    private enum FailedSubmission: Equatable {
        case message(content: String, photoIDs: [String], idempotencyKey: String)
        case answer(type: AnswerType, text: String?, idempotencyKey: String)
    }
    @Published private var failedSubmission: FailedSubmission?

    private enum PollGoal {
        case investigationFlow
        case directResponse(afterUserMessageID: String?)
    }

    public init(apiClient: APIClient, patientID: String, conversationID: String? = nil, pollInterval: Duration = .seconds(1)) {
        self.apiClient = apiClient
        self.patientID = patientID
        self.selectedConversationID = conversationID
        self.pollInterval = pollInterval
        self.phoneLimits = { PhoneSendLimits.load(patientID: patientID) }
    }

    public var timelineItems: [TimelineItem] {
        var items: [TimelineItem] = []

        if let conversation {
            items.append(contentsOf: conversation.messages.compactMap { message in
                guard !shouldSuppressMessageFromTimeline(message, in: conversation) else {
                    return nil
                }
                return timelineItem(for: message)
            })

            if let localEchoMessage,
               !conversation.messages.contains(where: { message in
                   message.role.uppercased() == "USER" && message.content == localEchoMessage.content
                       && !localEchoMessage.earlierMessageIDs.contains(message.id)
               }) {
                items.append(.localEcho(localEchoMessage))
            }

            if conversation.awaiting_user_answer, let question = conversation.pending_question {
                items.append(.question(question))
            }
        }

        // Once the answer starts to appear it replaces the status line ("Analizuję pytanie").
        if let draft = visibleReplyDraft {
            items.append(.assistantDraft(draft))
        } else if shouldRenderProcessingState {
            items.append(.processing(processingState))
        }

        if let recommendation, shouldRenderRecommendationCard(recommendation) {
            items.append(.recommendation(recommendation))
        }

        return items
    }

    private func shouldSuppressMessageFromTimeline(_ message: ConversationMessage, in conversation: ConversationResponse) -> Bool {
        guard conversation.awaiting_user_answer,
              let pendingQuestionId = conversation.pending_question?.question_id.trimmingCharacters(in: .whitespacesAndNewlines),
              !pendingQuestionId.isEmpty else {
            return false
        }

        let normalizedType = message.message_type.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard normalizedType == "CONTEXT_QUESTION" else {
            return false
        }

        let messageQuestionId = message.question_id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !messageQuestionId.isEmpty && messageQuestionId == pendingQuestionId
    }

    private func timelineItem(for message: ConversationMessage) -> TimelineItem? {
        let normalizedRole = message.role.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let normalizedType = message.message_type.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

        if normalizedRole == "USER" {
            return .userMessage(message)
        }

        if normalizedType == "CONTEXT_ANSWER" {
            return .userMessage(message)
        }

        if normalizedRole == "ASSISTANT" || normalizedType == "ASSISTANT_MESSAGE" || normalizedType == "CONTEXT_QUESTION" {
            return .assistantMessage(message)
        }

        return nil
    }

    public var isReadOnlyConversation: Bool {
        guard let conversation else {
            return true
        }

        return !conversation.awaiting_user_answer || conversation.pending_question == nil
    }

    public var activeProcessingMessage: String? {
        guard let currentStep = conversation?.processing?.current_step ?? conversation?.processing?.steps.last else {
            return nil
        }

        return currentStep.label.isEmpty ? nil : currentStep.label
    }

    public var statusMessage: String? {
        switch processingState {
        case .idle:
            if conversation?.awaiting_user_answer == true {
                return "Czeka na Twoją odpowiedź"
            }
            return nil
        case .sending:
            return "Wysyłam…"
        case .processing:
            return activeProcessingMessage ?? "Mellis pracuje nad odpowiedzią…"
        case .waitingForNextQuestion:
            return "Przygotowuję kolejne pytanie…"
        case .complete:
            return shouldShowInvestigationCompletionUI ? "Analiza zakończona" : nil
        case .cancelled(let message):
            return message
        case .error(let message):
            return message
        }
    }

    public var agentActivity: AgentActivity? {
        let steps = conversation?.processing?.steps ?? []
        let startedAt = steps.compactMap(\.started_at).compactMap(Self.parseTimestamp).min()

        func activity(_ phase: AgentActivity.Phase, _ title: String, detail: String? = nil) -> AgentActivity {
            AgentActivity(phase: phase, title: title, detail: detail, startedAt: startedAt)
        }

        switch processingState {
        case .idle:
            return nil
        case .sending:
            return AgentActivity(phase: .sending, title: isSubmittingAnswer ? "Wysyłam odpowiedź" : "Wysyłam wiadomość", detail: nil, startedAt: nil)
        case .waitingForNextQuestion:
            return activity(.waiting, "Przygotowuję kolejne pytanie")
        case .complete:
            return shouldShowInvestigationCompletionUI ? activity(.completed, "Analiza zakończona") : nil
        case .error(let message):
            return activity(.failed, message)
        case .cancelled(let message):
            return AgentActivity(phase: .cancelled, title: message, detail: nil, startedAt: nil)
        case .processing:
            guard let step = conversation?.processing?.current_step ?? steps.last else {
                // Accepted by the server, but no backend step reported yet: say only that.
                return activity(.waiting, "Czekam na rozpoczęcie analizy")
            }
            let label = step.label.isEmpty ? nil : step.label
            switch step.type.uppercased() {
            case "REQUESTING_EVIDENCE":
                return activity(.usingTool, "Pobieram dane", detail: label)
            case "ANALYZING_REQUEST":
                return activity(.analyzing, "Analizuję pytanie", detail: label == "Analizuję pytanie" ? nil : label)
            case "ANALYZING_EVIDENCE":
                return activity(.analyzing, "Analizuję dane", detail: label == "Analizuję dane" ? nil : label)
            case "GENERATING_RESPONSE":
                return activity(.generating, "Przygotowuję odpowiedź", detail: label == "Przygotowuję odpowiedź" ? nil : label)
            default:
                return activity(.analyzing, label ?? "Analizuję")
            }
        }
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        ServerDate.parse(value)
    }

    /// The user message whose analysis can be cancelled right now: the server marked it cancellable, it has no
    /// reply yet, and an analysis is actually running for it. Nil otherwise, so "Przerwij" is never offered for
    /// an operation the server cannot stop.
    public var cancellableUserMessageID: String? {
        guard processingState == .processing, let messages = conversation?.messages,
              let index = messages.lastIndex(where: { $0.message_type.uppercased() == "USER_MESSAGE" }) else {
            return nil
        }
        let message = messages[index]
        let answered = messages[(index + 1)...].contains { isAssistantTimelineMessage($0) }
        return message.analysis_cancellable == true && !message.isAnalysisCancelled && !answered ? message.id : nil
    }

    public var isShowingCancellationConfirmation: Bool {
        if case .cancelled = processingState { return true }
        return false
    }

    public var canCancelAnalysis: Bool {
        cancellableUserMessageID != nil && !isCancellingAnalysis
    }

    /// Asks the server to cancel; the UI state follows the server's answer, never a local assumption.
    public func cancelAnalysis() async {
        // The message must be of the thread on screen: "Przerwij" never stops another thread's analysis.
        guard let messageID = cancellableUserMessageID, let conversationID = selectedConversationID,
              conversation?.id == conversationID, !isCancellingAnalysis else {
            return
        }

        let generation = selectionGeneration
        isCancellingAnalysis = true
        cancellationNotice = nil
        defer {
            if generation == selectionGeneration {
                isCancellingAnalysis = false
                publishTimelineUpdateIfNeeded()
            }
        }

        do {
            let response = try await apiClient.cancelMessageAnalysis(patientID: patientID, conversationID: conversationID, messageID: messageID)
            guard generation == selectionGeneration else {
                return
            }
            conversation = response.conversation.keepingViewFields(of: conversation)
            switch response.result.uppercased() {
            case "CANCELLED", "ALREADY_CANCELLED":
                processingState = .cancelled(Self.cancelledMessage)
                // The cards and the hypo screen come with GET only: read again, the notice stays.
                await refreshActiveConversation()
                if generation == selectionGeneration, processingState == .idle {
                    processingState = .cancelled(Self.cancelledMessage)
                }
            case "ALREADY_COMPLETED":
                cancellationNotice = "Odpowiedź była już zapisywana — nie przerwano."
                await refreshActiveConversation()
            default:
                cancellationNotice = "Tej operacji nie można już przerwać."
                await refreshActiveConversation()
            }
        } catch {
            guard generation == selectionGeneration else { return }
            processingState = .error("Nie udało się przerwać analizy. Odśwież rozmowę, aby sprawdzić jej stan.")
        }
    }

    private static let cancelledMessage = "Analiza przerwana. Historia rozmowy została zachowana."

    /// Re-fetches after a failed load, refresh or send; the conversation and any draft stay in place.
    public func retryAfterError() async {
        await refreshActiveConversation()
    }

    /// The caregiver message whose answer failed on the server (the message itself was stored): Ponów próbę asks again.
    public var failedAnalysisUserMessageID: String? {
        guard case .error = processingState, conversation?.processing?.status.uppercased() == "FAILED",
              let messages = conversation?.messages,
              let index = messages.lastIndex(where: { $0.message_type.uppercased() == "USER_MESSAGE" }) else {
            return nil
        }
        let answered = messages[(index + 1)...].contains { isAssistantTimelineMessage($0) }
        return answered ? nil : messages[index].id
    }

    public var canRetryFailedAnalysis: Bool {
        failedAnalysisUserMessageID != nil && !isRetryingAnalysis
    }

    @Published public private(set) var isRetryingAnalysis = false

    /// Ponów próbę: the server puts the failed answer back in the queue; then the answer is awaited like after sending.
    public func retryFailedAnalysis() async {
        guard let messageID = failedAnalysisUserMessageID, let conversationID = selectedConversationID, !isRetryingAnalysis else {
            return
        }
        let generation = selectionGeneration
        isRetryingAnalysis = true
        processingState = .processing
        publishTimelineUpdateIfNeeded()
        defer {
            if generation == selectionGeneration {
                isRetryingAnalysis = false
                publishTimelineUpdateIfNeeded()
            }
        }
        do {
            let response = try await apiClient.retryMessageAnalysis(patientID: patientID, conversationID: conversationID, messageID: messageID)
            guard generation == selectionGeneration else {
                return
            }
            conversation = response.conversation.keepingViewFields(of: conversation)
            if response.result.uppercased() == "REQUEUED" {
                // The button is free again once the answer is requeued; the polling only shows it arrive.
                isRetryingAnalysis = false
                await pollForConversationUpdate(maxAttempts: 45, goal: .directResponse(afterUserMessageID: messageID))
            } else {
                await refreshActiveConversation()
            }
        } catch {
            guard generation == selectionGeneration else { return }
            processingState = .error("Nie udało się ponowić analizy. Spróbuj jeszcze raz.")
        }
    }

    var shouldShowInvestigationCompletionUI: Bool {
        guard processingState == .complete else {
            return false
        }

        guard let conversation else {
            return false
        }

        return isInvestigationConversation(conversation)
    }

    /// Reads the dashboard for the empty conversation's first card; a failure keeps the last reading (the card then
    /// falls back to the time of day once it is too old).
    /// Opening an empty conversation asks twice (the chat and its starter cards): a read in flight or just finished
    /// serves both.
    public func refreshStarterGlucose() async {
        if let inFlight = starterGlucoseRead {
            await inFlight.value
            return
        }
        if let last = starterGlucoseReadAt, Date().timeIntervalSince(last) < Self.starterGlucoseFreshness {
            return
        }
        let read = Task { [weak self] in
            guard let self else { return }
            let dashboard = try? await self.apiClient.getDashboard(patientID: self.patientID)
            if let dashboard {
                self.starterGlucose = dashboard.glucose
                self.starterGlucoseReadAt = Date()
            }
            self.starterGlucoseSettled = true
            self.starterGlucoseRead = nil
        }
        starterGlucoseRead = read
        await read.value
    }

    /// A conversation this phone has just created; selecting it shows it at once, then reads it quietly.
    public func preloadCreatedConversation(_ conversation: ConversationResponse) {
        createdConversations[conversation.id] = conversation
    }

    public func selectConversation(_ conversationID: String?, forceReload: Bool = false) async {
        // The tab follows a fresh draft with no selection: the draft stays on screen.
        if conversationID == nil, isFreshDraft {
            return
        }
        if selectedConversationID == conversationID, !forceReload, !reloadOnNextSelect {
            return
        }

        keepComposerDraft()
        isFreshDraft = false
        resetForNewThread()

        selectedConversationID = conversationID
        userMessageText = conversationID.flatMap { drafts[$0] } ?? ""

        guard let conversationID else {
            state = .idle
            publishTimelineUpdateIfNeeded()
            return
        }

        if let created = createdConversations.removeValue(forKey: conversationID) {
            conversation = created
            lastLoadFailure = nil
            deriveProcessingStateForLoadedConversation()
            state = .loaded
            publishTimelineUpdateIfNeeded()
            await loadConversation(showLoading: false)
        } else {
            await loadConversation(showLoading: true)
        }
        resumePollingIfAnswerPending()
    }

    /// The composer's text stays with the conversation (or fresh draft) it was typed in.
    private func keepComposerDraft() {
        let key = isFreshDraft ? Self.freshDraftKey : selectedConversationID
        if let key {
            let draft = userMessageText.trimmingCharacters(in: .whitespacesAndNewlines)
            drafts[key] = draft.isEmpty ? nil : userMessageText
        }
    }

    /// Nothing of the previous thread reaches the next one (a conversation or a fresh draft).
    private func resetForNewThread() {

        // Nothing of the previous thread may reach this one: its polling stops, its pending sends, cancels and loads
        // write nothing when they return, and its busy flags do not block this thread's composer.
        selectionGeneration += 1
        reloadOnNextSelect = false
        stopPolling()
        pendingLiveRefresh?.cancel()
        pendingLiveRefresh = nil
        isSubmittingUserMessage = false
        isSubmittingAnswer = false
        isCancellingAnalysis = false
        isRetryingAnalysis = false

        // Another thread: the previous one's draft is not carried over.
        liveDraft = nil
        lingeringDraft = nil
        updateLiveDraft(from: liveUpdates?.drafts ?? [:])
        cancellationNotice = nil
        rescueCarbsError = nil
        rescueCarbsNotice = nil
        failedSubmission = nil
        conversation = nil
        recommendation = nil
        localEchoMessage = nil
        textAnswer = ""
        draftPhotos = []
        draftPhotoUploadIDs = []
        processingState = .idle
        shouldExpectFollowUpQuestion = false
    }

    /// Shows an empty new conversation (greeting and starter cards) in place of the one on screen, which stays in the
    /// history with its draft. Nothing is created on the server until something is sent.
    public func startFreshDraft() {
        guard !isFreshDraft else { return }
        let previousID = selectedConversationID
        keepComposerDraft()
        resetForNewThread()
        isFreshDraft = true
        freshCheckRequestedAt = nil
        selectedConversationID = nil
        conversation = Self.freshDraftConversation(patientID: patientID)
        lastLoadFailure = nil
        userMessageText = drafts[Self.freshDraftKey] ?? ""
        state = .loaded
        publishTimelineUpdateIfNeeded()
        onFreshDraftStarted?(previousID)
    }

    /// What a fresh draft shows: an empty conversation of nobody (no id until the server creates it).
    private static func freshDraftConversation(patientID: String) -> ConversationResponse {
        ConversationResponse(id: "", patient_id: patientID, awaiting_user_answer: false, pending_question: nil, messages: [], analysis_id: nil, recommendation_id: nil)
    }

    /// The tab came on screen (launch, a tab switch, a return to the foreground): the conversation on screen is replaced
    /// by a fresh draft if it has been quiet longer than FreshConversationPolicy's threshold, checked as soon as it is read.
    public func requestFreshCheck() {
        guard !isFreshDraft else { return }
        freshCheckRequestedAt = now()
        evaluateFreshCheckIfReady()
    }

    /// The conversation on screen as the inactivity rule sees it; nil until it is read.
    public var freshnessSnapshot: FreshConversationPolicy.Snapshot? {
        guard !isFreshDraft, state == .loaded, let selectedConversationID, let conversation, conversation.id == selectedConversationID else {
            return nil
        }
        let busy = isSubmittingUserMessage || isSubmittingAnswer || isAnalysisActive || isCancellingAnalysis || isRetryingAnalysis
            || liveDraft != nil || lingeringDraft != nil || conversation.reply_draft != nil || localEchoMessage != nil
            || isLoggingRescueCarbs || isDecliningRescueCarbs || !mealActionsInFlight.isEmpty || pollTask != nil
        return FreshConversationPolicy.Snapshot(
            conversationID: selectedConversationID,
            lastActivity: conversation.lastActivity(),
            isBusy: busy,
            hasDraft: hasComposerContent || !textAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            awaitsAnswer: conversation.awaiting_user_answer || conversation.pending_question != nil
        )
    }

    private func evaluateFreshCheckIfReady() {
        guard let requestedAt = freshCheckRequestedAt else { return }
        let current = now()
        guard current.timeIntervalSince(requestedAt) < Self.freshCheckValidity else {
            freshCheckRequestedAt = nil
            return
        }
        guard let snapshot = freshnessSnapshot else { return }
        freshCheckRequestedAt = nil
        let decision = FreshConversationPolicy.decide(snapshot, openedOnPurposeAt: openedOnPurposeAt(snapshot.conversationID), now: current)
        if decision == .startFresh {
            startFreshDraft()
        }
    }

    /// The fresh draft's conversation, created by its first send; false (with the error shown) when it could not be.
    private func ensureConversationForSend() async -> Bool {
        guard isFreshDraft else { return selectedConversationID != nil }
        guard !isSubmittingUserMessage else { return false }
        let generation = selectionGeneration
        isSubmittingUserMessage = true
        processingState = .sending
        publishTimelineUpdateIfNeeded()
        do {
            let created = try await apiClient.createConversation(patientID: patientID, idempotencyKey: freshDraftCreationKey).conversation
            guard generation == selectionGeneration, isFreshDraft else { return false }
            isFreshDraft = false
            freshDraftCreationKey = UUID().uuidString.lowercased()
            drafts[Self.freshDraftKey] = nil
            selectedConversationID = created.id
            conversation = created
            isSubmittingUserMessage = false
            processingState = .idle
            onFreshDraftCreated?(created)
            return true
        } catch {
            guard generation == selectionGeneration else { return false }
            isSubmittingUserMessage = false
            processingState = .error("Nie udało się rozpocząć rozmowy. Sprawdź połączenie i spróbuj ponownie.")
            publishTimelineUpdateIfNeeded()
            return false
        }
    }

    /// A thread opened while its answer is still being written (left during a send, or asked on the other phone): the
    /// answer appears on screen also without live updates. Started in the background; the poll ends with the answer.
    private func resumePollingIfAnswerPending() {
        guard pollTask == nil, state == .loaded, let conversation else {
            return
        }
        switch processingState {
        case .processing where hasPendingDirectResponse(in: conversation, afterUserMessageID: nil):
            startPolling(maxAttempts: 45, goal: .directResponse(afterUserMessageID: nil))
        case .waitingForNextQuestion:
            startPolling(maxAttempts: 45, goal: .investigationFlow)
        default:
            break
        }
    }

    public func loadConversation() async {
        await loadConversation(showLoading: true)
    }

    public func refreshActiveConversation() async {
        await loadConversation(showLoading: false)
    }

    private func loadConversation(showLoading: Bool, isRetryOfFailedRead: Bool = false) async {
        if isFreshDraft {
            // Nothing to read yet: an error of the first send clears with "Spróbuj ponownie".
            if case .error = processingState { processingState = .idle }
            publishTimelineUpdateIfNeeded()
            return
        }
        guard let conversationID = selectedConversationID else {
            state = .idle
            processingState = .idle
            lastLoadFailure = nil
            publishTimelineUpdateIfNeeded()
            return
        }

        if showLoading {
            state = .loading
        }

        let generation = selectionGeneration
        do {
            let readStartedAt = Date()
            let loaded = try await apiClient.getConversation(patientID: patientID, conversationID: conversationID)
            let artifact = await recommendationArtifact(for: loaded)
            // A late answer for a thread left in the meantime (quick A → B → C) never replaces the one on screen.
            guard generation == selectionGeneration else {
                return
            }
            // Shown together with the state they imply: a stored answer never appears under a stale "analysis running".
            conversation = loaded
            recommendation = artifact
            settleLingeringDraft(readStartedAt: readStartedAt)
            lastLoadFailure = nil
            deriveProcessingStateForLoadedConversation()
            state = .loaded
            evaluateFreshCheckIfReady()
        } catch {
            guard generation == selectionGeneration else {
                return
            }
            if Task.isCancelled {
                // The screen that asked went away (another tab): no error for a read nobody waits for.
                if showLoading {
                    reloadOnNextSelect = true
                }
                return
            }
            let failure = Self.loadFailure(for: error)
            if !showLoading, conversation != nil, failure == .network, !isRetryOfFailedRead {
                // Right after the phone is unlocked (a notification tap) the first read often fails: iOS cut it off
                // while the app was suspended, or the network is not back yet. Read once more before saying so.
                try? await Task.sleep(for: Self.networkRetryDelay)
                guard generation == selectionGeneration, !Task.isCancelled else { return }
                await loadConversation(showLoading: false, isRetryOfFailedRead: true)
                return
            }
            lastLoadFailure = failure
            if !showLoading, conversation != nil, failure == .network || failure == .server || failure == .unknown {
                // A background refresh failed: keep the loaded conversation and report it in the status instead.
                processingState = .error(Self.userMessage(for: failure))
                publishTimelineUpdateIfNeeded()
                return
            }
            if failure == .missingConversation {
                selectedConversationID = nil
                conversation = nil
            }
            state = Self.viewState(for: failure)
            processingState = .error(Self.userMessage(for: failure))
        }

        publishTimelineUpdateIfNeeded()
    }

    private static func loadFailure(for error: Error) -> LoadFailure {
        switch error {
        case APIClientError.notFound:
            return .missingConversation
        case APIClientError.unauthenticated:
            return .unauthenticated
        case APIClientError.forbidden:
            return .forbidden
        case APIClientError.server:
            return .server
        case APIClientError.transport:
            return .network
        case APIClientError.invalidResponse:
            return .decoding
        case APIClientError.unexpectedStatus:
            return .server
        default:
            if error is DecodingError {
                return .decoding
            }
            return .unknown
        }
    }

    private static func userMessage(for failure: LoadFailure) -> String {
        switch failure {
        case .missingConversation, .forbidden:
            return "Ta rozmowa jest niedostępna"
        case .unauthenticated:
            return "Sesja wygasła. Zaloguj się ponownie."
        case .network:
            return "Brak połączenia. Sprawdź internet i spróbuj ponownie."
        case .server, .decoding, .unknown:
            return "Nie udało się wczytać rozmowy"
        }
    }

    private static func viewState(for failure: LoadFailure) -> ViewState {
        .error(userMessage(for: failure))
    }

    /// The hypo screen of the conversation (episode, CGM curve, report form); nil for other conversations.
    public var hypo: ConversationHypo? {
        conversation?.hypo
    }

    /// The meal of a meal's WBT conversation (wbt-chat.v1); nil for other conversations.
    public var wbt: ConversationWbt? {
        conversation?.wbt
    }

    /// The rescue carbs alert of the conversation (forecast, dose, treatment); nil for other conversations.
    public var rescueCarbs: ConversationRescueCarbs? {
        conversation?.rescue_carbs
    }

    /// "Zapisz" in the rescue carbs sheet (from the alert block, or a chat card's `proposalID`). True when the sheet
    /// should close: saved, or refused because the other caregiver logged it first (the block then says so and shows
    /// theirs). False keeps the sheet open with `rescueCarbsError`.
    @discardableResult
    public func logRescueCarbs(carbsG: Double, givenAt: Date?, proposalID: String? = nil) async -> Bool {
        if rescueCarbs == nil, let proposalID {
            return await acceptChatRescueCarbs(carbsG: carbsG, givenAt: givenAt ?? Date(), proposalID: proposalID)
        }
        guard !isLoggingRescueCarbs, let conversationID = selectedConversationID, rescueCarbs != nil else {
            return false
        }
        guard RescueCarbsFormat.isValidGrams(carbsG) else {
            rescueCarbsError = "Podaj od 1 do 50 g."
            return false
        }

        isLoggingRescueCarbs = true
        rescueCarbsError = nil
        rescueCarbsNotice = nil
        defer {
            isLoggingRescueCarbs = false
            publishTimelineUpdateIfNeeded()
        }

        do {
            let response = try await apiClient.logRescueCarbs(patientID: patientID, conversationID: conversationID, carbsG: carbsG, givenAt: givenAt, proposalID: proposalID)
            guard selectedConversationID == conversationID else {
                return true
            }
            // The block shows the treatment at once; the refresh brings the cards and messages it changed.
            if let block = response.rescue_carbs { conversation?.rescue_carbs = block }
            announceMealsChanged()
            await refreshActiveConversation()
            return true
        } catch let error as APIClientError where error.rescueAlreadyLoggedMessage != nil {
            rescueCarbsNotice = error.rescueAlreadyLoggedMessage
            await refreshActiveConversation()
            return true
        } catch let error as APIClientError where error.isRescueAlertStale {
            rescueCarbsNotice = Self.staleAlertNotice
            await refreshActiveConversation()
            return true
        } catch APIClientError.notFound {
            rescueCarbsNotice = "Ta rozmowa nie jest już alarmem dosłodzenia. Nic nie zapisano."
            await refreshActiveConversation()
            return true
        } catch APIClientError.conflict {
            // Changed on the other phone in the meantime: the refreshed block shows how.
            rescueCarbsNotice = "Alarm zmienił się w międzyczasie. Sprawdź, czy dosłodzenie nie jest już wpisane."
            await refreshActiveConversation()
            return true
        } catch APIClientError.validation {
            rescueCarbsError = "Sprawdź ilość (1–50 g) i godzinę (najwyżej 2 h temu)."
        } catch APIClientError.transport {
            rescueCarbsError = "Brak połączenia — nic nie zapisano. Spróbuj ponownie."
        } catch {
            rescueCarbsError = "Nie udało się zapisać. Spróbuj ponownie."
        }
        return false
    }

    /// "Zatwierdź Y g" on a rescue carb card of an ordinary conversation (no alert): GlucoMind only, never Trio. True
    /// when the sheet should close: saved, or the card was confirmed or removed meanwhile (the refreshed card shows it).
    private func acceptChatRescueCarbs(carbsG: Double, givenAt: Date, proposalID: String) async -> Bool {
        guard !isLoggingRescueCarbs, let conversationID = selectedConversationID else {
            return false
        }
        guard RescueCarbsFormat.isValidGrams(carbsG) else {
            rescueCarbsError = "Podaj od 1 do 50 g."
            return false
        }

        isLoggingRescueCarbs = true
        rescueCarbsError = nil
        defer {
            isLoggingRescueCarbs = false
            publishTimelineUpdateIfNeeded()
        }

        do {
            _ = try await apiClient.acceptChatRescueCarbs(patientID: patientID, conversationID: conversationID, proposalID: proposalID, carbsG: carbsG, givenAt: givenAt)
            announceMealsChanged()
            await refreshActiveConversation()
            return true
        } catch let error as APIClientError where error.rescueAlreadyLoggedMessage != nil {
            await refreshActiveConversation()
            return true
        } catch let error as APIClientError where error.isRescueAlertStale {
            rescueCarbsError = Self.staleAlertNotice
            await refreshActiveConversation()
        } catch APIClientError.notFound {
            await refreshActiveConversation()
            return true
        } catch APIClientError.validation {
            rescueCarbsError = "Sprawdź ilość (1–50 g) i godzinę (najwyżej 2 h temu)."
        } catch APIClientError.transport {
            rescueCarbsError = "Brak połączenia — nic nie zapisano. Spróbuj ponownie."
        } catch {
            rescueCarbsError = "Nie udało się zapisać. Spróbuj ponownie."
        }
        return false
    }

    /// "Nie podaję" in the alert block: no rescue carbs for this alert, so no reminder. Problems show as the block's notice.
    public func declineRescueCarbs() async {
        guard !isDecliningRescueCarbs, !isLoggingRescueCarbs, let conversationID = selectedConversationID, rescueCarbs != nil else {
            return
        }
        isDecliningRescueCarbs = true
        rescueCarbsNotice = nil
        defer {
            isDecliningRescueCarbs = false
            publishTimelineUpdateIfNeeded()
        }

        do {
            let response = try await apiClient.declineRescueCarbs(patientID: patientID, conversationID: conversationID)
            guard selectedConversationID == conversationID else {
                return
            }
            if let block = response.rescue_carbs {
                conversation?.rescue_carbs = block
            } else {
                // Saved, but the answer lacks the block: read it again.
                await refreshActiveConversation()
            }
        } catch let error as APIClientError where error.rescueAlreadyLoggedMessage != nil {
            rescueCarbsNotice = error.rescueAlreadyLoggedMessage
            await refreshActiveConversation()
        } catch let error as APIClientError where error.isRescueAlertStale {
            rescueCarbsNotice = Self.staleAlertNotice
            await refreshActiveConversation()
        } catch APIClientError.notFound {
            rescueCarbsNotice = "Ta rozmowa nie jest już alarmem dosłodzenia. Nic nie zapisano."
            await refreshActiveConversation()
        } catch APIClientError.transport {
            rescueCarbsNotice = "Brak połączenia — nic nie zapisano. Spróbuj ponownie."
        } catch {
            rescueCarbsNotice = "Nie udało się zapisać. Spróbuj ponownie."
        }
    }

    /// The server refused an action on an alert or card over 30 min old (RESCUE_ALERT_STALE; it only refuses the loop
    /// send now, so this is for older servers).
    static let staleAlertNotice = "Alarm jest nieaktualny — nic nie wysłano. Możesz zapisać, co podano."

    public func clearRescueCarbsError() {
        rescueCarbsError = nil
    }

    /// The saved rescue carbs are a new entry in the meals tab: its screens re-read now, as on the server's live
    /// `meals` change (which may come later, or not at all without live updates).
    private func announceMealsChanged() {
        liveUpdates?.changes.send(.changed(kind: "meals", id: nil))
    }

    /// "Zatwierdź" on a meal change card (`edited`: the values changed with "Popraw"). The card then shows the stored
    /// outcome: saved, or stale when the meal changed after the change was prepared.
    public func applyMealAction(_ action: ConversationMealAction, edited: MealActionEdit? = nil) async {
        await runMealAction(action) { api, patientID, conversationID in
            _ = try await api.applyMealAction(patientID: patientID, conversationID: conversationID, actionID: action.id, edited: edited)
        }
    }

    public func rejectMealAction(_ action: ConversationMealAction) async {
        await runMealAction(action) { api, patientID, conversationID in
            _ = try await api.rejectMealAction(patientID: patientID, conversationID: conversationID, actionID: action.id)
        }
    }

    /// "Cofnij" on a saved card; refused when the meal changed again since.
    public func undoMealAction(_ action: ConversationMealAction) async {
        await runMealAction(action) { api, patientID, conversationID in
            _ = try await api.undoMealAction(patientID: patientID, conversationID: conversationID, actionID: action.id)
        }
    }

    /// Card timeline switches being saved (a later part's id, "wbt:<meal id>" for a WBT reminder): their buttons wait.
    @Published public private(set) var cardSwitchesInFlight: Set<String> = []

    /// "Wyłącz" on a bolus card's planned part: skipped for both caregivers (a part already on its way is refused).
    public func skipPlannedPart(_ part: PlannedBolusSummary) async {
        guard let mealID = part.meal_record_id, !cardSwitchesInFlight.contains(part.id) else { return }
        cardSwitchesInFlight.insert(part.id)
        defer { cardSwitchesInFlight.remove(part.id) }
        do {
            _ = try await apiClient.skipMealPlannedBolus(patientID: patientID, mealID: mealID, plannedBolusID: part.id)
        } catch {
            // Given, skipped or sent meanwhile: the refreshed card shows it.
        }
        await refreshActiveConversation()
    }

    /// An option under an answer: its cards unfold; "Własny plan" folds them (the view opens the keyboard).
    public func chooseAnswerOption(messageID: String, key: String) {
        answerOptionChoices[messageID] = key
    }

    /// "Wyłącz" / "Włącz" on a bolus card's WBT reminder (the meal's reminder, for both caregivers).
    public func setCardWbtReminder(mealID: String, enabled: Bool) async {
        let switchID = CardTimelineStep.Action.setWbtReminder(mealID: mealID, enabled: enabled).switchID
        guard !cardSwitchesInFlight.contains(switchID) else { return }
        cardSwitchesInFlight.insert(switchID)
        defer { cardSwitchesInFlight.remove(switchID) }
        do {
            _ = try await apiClient.setMealWbtReminder(patientID: patientID, mealID: mealID, enabled: enabled)
        } catch {
            // The refreshed card shows the reminder as it is.
        }
        await refreshActiveConversation()
    }

    /// Reminders being cancelled, and the error of the last failed cancel per reminder.
    @Published public private(set) var careRemindersInFlight: Set<String> = []
    @Published public private(set) var careReminderErrors: [String: String] = [:]

    /// "Anuluj przypomnienie" on a reminder card; a reminder already sent or cancelled on the other phone just refreshes.
    public func cancelCareReminder(_ reminder: ConversationCareReminder) async {
        guard !careRemindersInFlight.contains(reminder.id) else { return }
        careRemindersInFlight.insert(reminder.id)
        careReminderErrors[reminder.id] = nil
        defer { careRemindersInFlight.remove(reminder.id) }
        do {
            _ = try await apiClient.cancelCareReminder(patientID: patientID, reminderID: reminder.id)
        } catch APIClientError.conflict {
            // Sent or cancelled meanwhile: the refreshed card shows it.
        } catch APIClientError.transport {
            careReminderErrors[reminder.id] = "Brak połączenia — przypomnienie nadal aktywne. Spróbuj ponownie."
            return
        } catch {
            careReminderErrors[reminder.id] = "Nie udało się anulować. Spróbuj ponownie."
            return
        }
        await refreshActiveConversation()
    }

    private func runMealAction(_ action: ConversationMealAction, _ call: (APIClient, String, String) async throws -> Void) async {
        guard !mealActionsInFlight.contains(action.id), let conversationID = selectedConversationID else {
            return
        }
        mealActionsInFlight.insert(action.id)
        mealActionErrors[action.id] = nil
        defer {
            mealActionsInFlight.remove(action.id)
            publishTimelineUpdateIfNeeded()
        }
        do {
            try await call(apiClient, patientID, conversationID)
        } catch APIClientError.transport {
            mealActionErrors[action.id] = "Brak połączenia — nic nie zapisano. Spróbuj ponownie."
            return
        } catch where error.isStaleWrite {
            mealActionErrors[action.id] = "Posiłek zmienił się od tej zmiany, więc jej nie cofam. Popraw go w zakładce Posiłki."
        } catch APIClientError.conflict {
            // Decided on the other phone in the meantime: the refreshed card shows how.
        } catch {
            mealActionErrors[action.id] = "Nie udało się. Spróbuj ponownie."
            return
        }
        guard selectedConversationID == conversationID else {
            return
        }
        await refreshActiveConversation()
    }

    public func submitAnswer(_ type: AnswerType) async {
        guard !isSubmittingAnswer, !isSubmittingUserMessage else {
            return
        }

        guard selectedConversationID != nil else {
            return
        }

        guard let questionID = conversation?.pending_question?.question_id else {
            return
        }

        let answerText = type == .text ? textAnswer.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if type == .text && (answerText?.isEmpty ?? true) {
            return
        }

        await sendAnswer(type: type, text: answerText, idempotencyKey: UUID().uuidString.lowercased())
    }

    /// A one-tap answer such as "4 g": sent as is, without touching the text the caregiver may be typing.
    public func submitAnswerOption(_ option: QuestionAnswerOption) async {
        guard !isSubmittingAnswer, !isSubmittingUserMessage, selectedConversationID != nil,
              conversation?.pending_question != nil else {
            return
        }

        let answerText = option.answer_type == .text ? option.answer_text?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if option.answer_type == .text && (answerText?.isEmpty ?? true) {
            return
        }

        await sendAnswer(type: option.answer_type, text: answerText, idempotencyKey: UUID().uuidString.lowercased())
    }

    private func sendAnswer(type: AnswerType, text answerText: String?, idempotencyKey: String) async {
        guard let questionID = conversation?.pending_question?.question_id, let conversationID = selectedConversationID else {
            return
        }

        let generation = selectionGeneration
        failedSubmission = nil
        isSubmittingAnswer = true
        processingState = .sending
        localEchoMessage = LocalEchoMessage(
            id: UUID().uuidString.lowercased(),
            content: localEchoText(for: type, answerText: answerText),
            createdAt: ISO8601DateFormatter().string(from: Date()),
            earlierMessageIDs: Set(conversation?.messages.map(\.id) ?? [])
        )
        publishTimelineUpdateIfNeeded()

        let pollAttempts: Int
        do {
            let response = try await apiClient.postAnswer(
                patientID: patientID,
                conversationID: conversationID,
                questionID: questionID,
                answer: MessageAnswer(type: type, text: answerText),
                idempotencyKey: idempotencyKey
            )
            // Another thread is on screen: the answer is stored, and its thread shows it when opened again.
            guard generation == selectionGeneration else {
                return
            }

            conversation = response.conversation.keepingViewFields(of: conversation)
            shouldExpectFollowUpQuestion = true
            processingState = .processing
            state = .loaded
            pollAttempts = 45
        } catch APIClientError.conflict {
            guard generation == selectionGeneration else {
                return
            }
            localEchoMessage = nil
            processingState = .processing
            pollAttempts = 15
        } catch {
            guard generation == selectionGeneration else {
                return
            }
            // The timeline stays visible and the input is kept. Whether the server stored the answer is unknown
            // after a network/server error, so a retry reuses the same idempotency key.
            localEchoMessage = nil
            processingState = .error(Self.submissionFailureMessage(for: error, subject: "odpowiedzi"))
            if Self.isRetryableSubmissionError(error) {
                failedSubmission = .answer(type: type, text: answerText, idempotencyKey: idempotencyKey)
            }
            shouldExpectFollowUpQuestion = false
            isSubmittingAnswer = false
            publishTimelineUpdateIfNeeded()
            return
        }

        // Stored: the send is over; the polling only shows the next step arrive (another thread may be opened meanwhile).
        isSubmittingAnswer = false
        publishTimelineUpdateIfNeeded()
        await pollForConversationUpdate(maxAttempts: pollAttempts, goal: .investigationFlow)
        guard generation == selectionGeneration else {
            return
        }
        if case .error = processingState {
            shouldExpectFollowUpQuestion = false
        }
        publishTimelineUpdateIfNeeded()
    }

    public var canSendUserMessage: Bool {
        guard let conversation else {
            return false
        }

        return !conversation.awaiting_user_answer && !isSubmittingAnswer && !isSubmittingUserMessage && !isAnalysisActive
    }

    /// One analysis per conversation at a time: the backend has no guard for parallel analyses in one
    /// conversation, and status and cancellation assume a single active one.
    private var isAnalysisActive: Bool {
        switch processingState {
        case .sending, .processing, .waitingForNextQuestion:
            return true
        case .idle, .complete, .cancelled, .error:
            return false
        }
    }

    /// True when the last failed send can be repeated without creating a duplicate.
    public var canRetryFailedSubmission: Bool {
        failedSubmission != nil && !isSubmittingAnswer && !isSubmittingUserMessage
    }

    /// Repeats the failed send exactly (same content, same idempotency key). Only on explicit user action.
    public func retryFailedSubmission() async {
        guard canRetryFailedSubmission, let submission = failedSubmission else {
            return
        }
        switch submission {
        case .message(let content, let photoIDs, let idempotencyKey):
            await sendUserMessage(content: content, photoIDs: photoIDs, idempotencyKey: idempotencyKey)
        case .answer(let type, let text, let idempotencyKey):
            await sendAnswer(type: type, text: text, idempotencyKey: idempotencyKey)
        }
    }

    /// Sends a suggested follow-up as a new message; the draft in the composer is left as it is.
    public func submitSuggestedFollowUp(_ text: String) async {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSendUserMessage, !content.isEmpty, await ensureConversationForSend() else {
            return
        }
        await sendUserMessage(content: content, idempotencyKey: UUID().uuidString.lowercased())
    }

    /// True when the composer has something to send: text, photos or both.
    public var hasComposerContent: Bool {
        !userMessageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftPhotos.isEmpty
    }

    public var canAddPhoto: Bool {
        draftPhotos.count < Self.maxPhotosPerMessage && !isSubmittingUserMessage
    }

    public static let maxPhotosPerMessage = 3

    public func addPhoto(_ jpeg: Data) {
        guard canAddPhoto else { return }
        draftPhotos.append(jpeg)
        draftPhotoUploadIDs.append(nil)
    }

    public func removeDraftPhoto(at index: Int) {
        guard draftPhotos.indices.contains(index), !isSubmittingUserMessage else { return }
        draftPhotos.remove(at: index)
        draftPhotoUploadIDs.remove(at: index)
    }

    /// The composer's mic: a voice message as text for this patient's chat (the server's or the phone's speech to text).
    public var voiceTranscribe: VoiceTranscribe {
        routedVoiceTranscribe(server: { [apiClient, patientID] audio in
            try await apiClient.transcribeVoice(patientID: patientID, m4aData: audio).text
        })
    }

    /// A photo of a message in this conversation: sent from this device (cached) or downloaded once.
    public func photo(_ photoID: String) async -> Data? {
        if let cached = photoCache[photoID] {
            return cached
        }
        guard let conversationID = selectedConversationID,
              let data = try? await apiClient.conversationPhotoData(patientID: patientID, conversationID: conversationID, photoID: photoID) else {
            return nil
        }
        photoCache[photoID] = data
        return data
    }

    public func submitUserMessage() async {
        guard canSendUserMessage, hasComposerContent, await ensureConversationForSend() else {
            return
        }

        let content = userMessageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let photoIDs = await uploadDraftPhotos() else {
            return
        }

        // Sending the unchanged text and photos of a failed send again is the same request: keep its idempotency key.
        if case .message(let failedContent, let failedPhotoIDs, let failedKey) = failedSubmission, failedContent == content, failedPhotoIDs == photoIDs {
            await sendUserMessage(content: content, photoIDs: photoIDs, idempotencyKey: failedKey)
            return
        }
        // An edited text after a failed send: the first version may have reached the server anyway (a timeout after it
        // was stored), and sending the edit would start a second paid answer. Checked first; if it landed, the edit
        // waits for the caregiver to send it again on purpose.
        if case .message(let failedContent, _, _) = failedSubmission, await failedMessageLanded(content: failedContent) {
            failedSubmission = nil
            processingState = .error("Poprzednia wersja wiadomości dotarła i dostanie odpowiedź. Wyślij poprawioną jeszcze raz, jeśli nadal jej potrzebujesz.")
            publishTimelineUpdateIfNeeded()
            return
        }
        await sendUserMessage(content: content, photoIDs: photoIDs, idempotencyKey: UUID().uuidString.lowercased())
    }

    /// The conversation read again has a caregiver message with this text, written in the last 10 minutes.
    private func failedMessageLanded(content: String) async -> Bool {
        guard let conversationID = selectedConversationID,
              let loaded = try? await apiClient.getConversation(patientID: patientID, conversationID: conversationID) else {
            return false
        }
        let since = Date().addingTimeInterval(-600)
        let landed = loaded.messages.contains { message in
            message.role.uppercased() == "USER"
                && message.content.trimmingCharacters(in: .whitespacesAndNewlines) == content
                && (ConversationViewModel.parseServerDate(message.created_at).map { $0 >= since } ?? true)
        }
        if landed {
            conversation = loaded
        }
        return landed
    }

    private static func parseServerDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// Uploads the draft photos not uploaded yet; nil (with the error shown) when one fails, the draft stays as it is.
    private func uploadDraftPhotos() async -> [String]? {
        guard !draftPhotos.isEmpty else {
            return []
        }
        guard let conversationID = selectedConversationID else {
            return nil
        }
        let generation = selectionGeneration
        isSubmittingUserMessage = true
        processingState = .sending
        defer {
            if generation == selectionGeneration {
                isSubmittingUserMessage = false
            }
        }
        do {
            for index in draftPhotos.indices where draftPhotoUploadIDs[index] == nil {
                let photo = draftPhotos[index]
                let uploaded = try await apiClient.uploadConversationPhoto(patientID: patientID, conversationID: conversationID, jpegData: photo)
                // Another thread opened meanwhile: its composer has its own (empty) photos; nothing is sent.
                guard generation == selectionGeneration else { return nil }
                // The draft may only change between sends (editing is disabled while sending).
                guard draftPhotoUploadIDs.indices.contains(index) else { return nil }
                draftPhotoUploadIDs[index] = uploaded.photo_id
                photoCache[uploaded.photo_id] = photo
            }
            return draftPhotoUploadIDs.compactMap { $0 }
        } catch {
            guard generation == selectionGeneration else { return nil }
            processingState = .error(Self.submissionFailureMessage(for: error, subject: "zdjęcia"))
            publishTimelineUpdateIfNeeded()
            return nil
        }
    }

    private func sendUserMessage(content: String, photoIDs: [String] = [], idempotencyKey: String) async {
        guard !isSubmittingAnswer, !isSubmittingUserMessage, let conversationID = selectedConversationID else {
            return
        }

        let generation = selectionGeneration
        failedSubmission = nil
        isSubmittingUserMessage = true
        cancellationNotice = nil
        processingState = .sending
        localEchoMessage = LocalEchoMessage(
            id: UUID().uuidString.lowercased(),
            content: content,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            photos: photoIDs.compactMap { photoCache[$0] },
            earlierMessageIDs: Set(conversation?.messages.map(\.id) ?? [])
        )
        publishTimelineUpdateIfNeeded()

        let pollAttempts: Int
        let pollGoal: PollGoal
        do {
            let response = try await apiClient.postUserMessage(
                patientID: patientID,
                conversationID: conversationID,
                content: content,
                photoIDs: photoIDs,
                bolusCards: bolusCardsAvailable,
                phoneLimits: bolusCardsAvailable ? phoneLimits() : nil,
                idempotencyKey: idempotencyKey
            )

            guard generation == selectionGeneration else {
                // Another thread was opened during the send: the message is stored in its own thread, which shows it
                // (and its answer) when opened again; the text kept for that thread is not offered a second time.
                if drafts[conversationID]?.trimmingCharacters(in: .whitespacesAndNewlines) == content {
                    drafts[conversationID] = nil
                }
                return
            }

            // Keep anything typed while the message was being sent.
            if userMessageText.trimmingCharacters(in: .whitespacesAndNewlines) == content {
                userMessageText = ""
            }
            if !photoIDs.isEmpty, draftPhotoUploadIDs.compactMap({ $0 }) == photoIDs {
                draftPhotos = []
                draftPhotoUploadIDs = []
            }
            drafts[conversationID] = nil
            conversation = response.conversation.keepingViewFields(of: conversation)
            shouldExpectFollowUpQuestion = response.decision == "INVESTIGATION_REQUIRED"
            processingState = .processing
            state = .loaded
            pollAttempts = 45
            pollGoal = .directResponse(afterUserMessageID: response.message.id)
        } catch APIClientError.conflict {
            guard generation == selectionGeneration else {
                return
            }
            localEchoMessage = nil
            processingState = .processing
            pollAttempts = 15
            pollGoal = .directResponse(afterUserMessageID: nil)
        } catch {
            guard generation == selectionGeneration else {
                return
            }
            // Remove the echo and keep the text. After a network/server error the server may or may not have stored
            // the message, so "Spróbuj ponownie" resends it with the same idempotency key (no duplicate).
            localEchoMessage = nil
            processingState = .error(Self.submissionFailureMessage(for: error, subject: "wiadomości"))
            if Self.isRetryableSubmissionError(error) {
                failedSubmission = .message(content: content, photoIDs: photoIDs, idempotencyKey: idempotencyKey)
            }
            shouldExpectFollowUpQuestion = false
            isSubmittingUserMessage = false
            publishTimelineUpdateIfNeeded()
            return
        }

        // Stored: the send is over. The polling only shows the answer arrive; another thread can be opened (and used)
        // meanwhile, which stops it.
        isSubmittingUserMessage = false
        publishTimelineUpdateIfNeeded()
        await pollForConversationUpdate(maxAttempts: pollAttempts, goal: pollGoal)
        guard generation == selectionGeneration else {
            return
        }
        if case .error = processingState {
            shouldExpectFollowUpQuestion = false
        }
        publishTimelineUpdateIfNeeded()
    }

    /// Only failures where repeating the identical request can help; a rejected or unauthorized send cannot.
    private static func isRetryableSubmissionError(_ error: Error) -> Bool {
        switch error {
        case APIClientError.validation, APIClientError.notFound, APIClientError.forbidden, APIClientError.unauthenticated:
            return false
        default:
            return true
        }
    }

    private static func submissionFailureMessage(for error: Error, subject: String) -> String {
        switch error {
        case APIClientError.validation:
            return "Serwer odrzucił treść \(subject). Popraw ją i spróbuj ponownie."
        case APIClientError.notFound, APIClientError.forbidden:
            return "Ta rozmowa jest niedostępna."
        case APIClientError.unauthenticated:
            return "Sesja wygasła. Zaloguj się ponownie."
        case APIClientError.transport:
            return "Brak połączenia — nie wysłano \(subject). Treść została zachowana."
        default:
            return "Nie udało się wysłać \(subject). Treść została zachowana."
        }
    }

    /// The recommendation a conversation links to (nil when it links none or it cannot be read). The linked analysis is
    /// not read: the worker stores it without the fields the app once decoded, so it never decoded and only cost a
    /// request on every poll.
    private func recommendationArtifact(for conversation: ConversationResponse) async -> RecommendationResponse? {
        guard let recommendationID = conversation.recommendation_id else { return nil }
        return try? await apiClient.getRecommendation(patientID: patientID, recommendationID: recommendationID)
    }

    /// Polls the thread on screen and waits for the poll to end (an answer, or another thread opened, which stops it).
    private func pollForConversationUpdate(maxAttempts: Int, goal: PollGoal) async {
        await startPolling(maxAttempts: maxAttempts, goal: goal)?.value
    }

    /// The poll belongs to the thread on screen now: it replaces this thread's earlier poll and stops when another
    /// thread is selected.
    @discardableResult
    private func startPolling(maxAttempts: Int, goal: PollGoal) -> Task<Void, Never>? {
        guard let conversationID = selectedConversationID else {
            return nil
        }
        stopPolling()
        let pollID = activePollID
        let task = Task { [weak self] () -> Void in
            await self?.poll(conversationID: conversationID, pollID: pollID, maxAttempts: maxAttempts, goal: goal)
        }
        pollTask = task
        return task
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        activePollID += 1
        isPolling = false
        pollPoked = false
    }

    private func poll(conversationID: String, pollID: Int, maxAttempts: Int, goal: PollGoal) async {
        // A stopped or replaced poll ends without writing: what it read belongs to a thread no longer on screen.
        func isActive() -> Bool { pollID == activePollID && !Task.isCancelled }
        guard isActive() else {
            return
        }
        isPolling = true
        defer {
            if pollID == activePollID {
                isPolling = false
                pollTask = nil
            }
        }

        var networkFailures = 0
        // After the quick reads, slower ones until about 3 minutes: an answer with tools can take longer than the quick
        // reads, and without live updates nothing else would show it.
        let totalAttempts = maxAttempts + Self.slowPollAttempts
        for attempt in 0..<totalAttempts {
            guard isActive() else {
                return
            }

            do {
                let readStartedAt = Date()
                let loaded = try await apiClient.getConversation(patientID: patientID, conversationID: conversationID)
                networkFailures = 0
                let artifact = await recommendationArtifact(for: loaded)
                guard isActive() else {
                    return
                }
                // Shown together with the state they imply (see loadConversation).
                conversation = loaded
                recommendation = artifact
                settleLingeringDraft(readStartedAt: readStartedAt)
                localEchoMessage = nil
                let shouldStop = deriveProcessingStateForPollingUpdate(goal: goal)
                state = .loaded
                publishTimelineUpdateIfNeeded()

                if shouldStop {
                    shouldExpectFollowUpQuestion = false
                    return
                }
            } catch {
                guard isActive() else {
                    return
                }
                // A read cut off while the phone was locked fails the moment the app is back, just before the
                // foreground refresh shows the answer: the next poll reads again instead of flashing a red error.
                networkFailures += 1
                if Self.loadFailure(for: error) != .network || networkFailures > Self.pollNetworkRetries {
                    // What is already shown stays; the status offers a retry.
                    processingState = .error("Nie udało się odświeżyć rozmowy. Odpowiedź mogła już powstać.")
                    publishTimelineUpdateIfNeeded()
                    return
                }
            }

            if attempt < totalAttempts - 1 {
                await sleepUntilNextPoll(slow: attempt >= maxAttempts - 1)
            }
        }

        guard isActive() else {
            return
        }
        if recommendation == nil, conversation?.awaiting_user_answer == false {
            processingState = .processing
            publishTimelineUpdateIfNeeded()
        }
    }

    #if DEBUG
    /// Tests: waits for the polling of the thread on screen (resumed in the background when a thread is opened).
    func waitForPolling() async {
        await pollTask?.value
    }
    #endif

    // MARK: - Live updates

    /// Connects the screen to the patient's live updates: the other caregiver's messages, progress and the answer being
    /// written appear without polling. Without them (nil, or not connected) the screen polls as before.
    public func bindLiveUpdates(_ live: LiveUpdates?) {
        guard live !== liveUpdates else { return }
        liveSubscriptions.removeAll()
        liveUpdates = live
        guard let live else {
            updateLiveDraft(from: [:])
            return
        }
        live.changes
            .sink { [weak self] change in self?.handleLiveChange(change) }
            .store(in: &liveSubscriptions)
        live.$drafts
            .sink { [weak self] drafts in self?.updateLiveDraft(from: drafts) }
            .store(in: &liveSubscriptions)
    }

    /// The answer being written to the latest caregiver message, from the live stream or the last fetched conversation.
    public var visibleReplyDraft: LiveReplyDraft? {
        guard let conversation else { return nil }
        switch processingState {
        case .cancelled, .error:
            return nil
        default:
            break
        }
        guard let draft = liveDraft ?? lingeringDraft?.draft ?? conversation.reply_draft,
              !draft.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let userIndex = conversation.messages.lastIndex(where: { $0.role.uppercased() == "USER" }),
              conversation.messages[userIndex].id.lowercased() == draft.reply_to_message_id.lowercased(),
              !conversation.messages[(userIndex + 1)...].contains(where: isAssistantTimelineMessage) else {
            return nil
        }
        return draft
    }

    private func handleLiveChange(_ change: LiveChange) {
        guard let selectedConversationID, state == .loaded || state == .idle else { return }
        let concernsThis = change.concerns(kind: "conversation", id: selectedConversationID)
            || (conversation?.hypo != nil && change.concerns(kind: "hypo"))
            // A card's meal (its WBT reminder, later parts, the save after a bolus) changed on the other phone.
            || (conversation?.bolusCardMealIDs ?? []).contains { change.concerns(kind: "meal", id: $0) }
        guard concernsThis else { return }
        if isPolling {
            // The running poll reads it now instead of after its interval.
            pollPoked = true
            return
        }
        pendingLiveRefresh?.cancel()
        pendingLiveRefresh = Task { [weak self] in
            // Several changes of one save arrive together: read once.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.refreshActiveConversation()
        }
    }

    private func updateLiveDraft(from drafts: [ReplyDraftKey: LiveReplyDraft]) {
        let draft = selectedConversationID.flatMap { drafts[ReplyDraftKey(thread: .conversation, id: $0)] }
        if draft != liveDraft {
            if draft == nil, let cleared = liveDraft {
                // Stored, failed or cancelled: the copy from the last read is stale, the cleared text stays on screen
                // until the next read settles it (see settleLingeringDraft).
                conversation?.reply_draft = nil
                lingeringDraft = (cleared, Date())
            }
            if draft != nil {
                lingeringDraft = nil
            }
            liveDraft = draft
        }
    }

    /// A read that started after the draft was cleared knows the outcome: the stored answer is there (it replaces the
    /// draft in place) or it is not (a failed or cancelled attempt), either way the lingering draft goes.
    private func settleLingeringDraft(readStartedAt: Date) {
        guard let lingeringDraft else { return }
        if readStartedAt >= lingeringDraft.clearedAt || Date().timeIntervalSince(lingeringDraft.clearedAt) > 15 {
            self.lingeringDraft = nil
        }
    }

    /// While the live stream is up a poll only backs it up, so it waits longer; a live change wakes it at once.
    private func sleepUntilNextPoll(slow: Bool = false) async {
        let base = slow ? pollInterval * Self.slowPollFactor : pollInterval
        let interval = liveUpdates?.isLive == true ? max(base, Self.livePollInterval) : base
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: interval)
        while !pollPoked, !Task.isCancelled, clock.now < deadline {
            try? await Task.sleep(for: min(.milliseconds(100), clock.now.duration(to: deadline)))
        }
        pollPoked = false
    }

    private static let livePollInterval: Duration = .seconds(4)
    /// The slower reads after the quick ones: this many, each this many quick intervals apart (27 × 5 s ≈ 2 more min).
    static let slowPollAttempts = 27
    static let slowPollFactor = 5
    /// Network failures in a row a poll reads through before it shows an error (the phone was locked, a lift).
    static let pollNetworkRetries = 2
    /// The pause before a failed background read is tried once more.
    static let networkRetryDelay: Duration = .seconds(1)

    private var shouldRenderProcessingState: Bool {
        switch processingState {
        case .idle:
            return false
        case .complete:
            return shouldShowInvestigationCompletionUI
        case .sending, .processing, .waitingForNextQuestion, .cancelled, .error:
            return true
        }
    }

    private func localEchoText(for type: AnswerType, answerText: String?) -> String {
        switch type {
        case .yes:
            return "Tak"
        case .no:
            return "Nie"
        case .unknown:
            return "Nie wiem"
        case .text:
            return answerText ?? ""
        }
    }

    private func deriveProcessingStateForLoadedConversation() {
        guard let conversation else {
            processingState = .idle
            return
        }

        if conversation.processing?.status.uppercased() == "FAILED" {
            processingState = .error(activeProcessingMessage ?? "Nie udało się przygotować odpowiedzi")
            return
        }

        if conversation.processing?.status.uppercased() == "PROCESSING" {
            processingState = .processing
            return
        }

        if conversation.awaiting_user_answer {
            processingState = shouldExpectFollowUpQuestion ? .waitingForNextQuestion : .idle
            return
        }

        if recommendation != nil {
            processingState = .idle
            return
        }

        if hasPendingDirectResponse(in: conversation, afterUserMessageID: nil) {
            processingState = .processing
            return
        }

        if hasCompletedDirectResponse(in: conversation) {
            processingState = .idle
            return
        }

        processingState = .idle
    }

    private func deriveProcessingStateForPollingUpdate(goal: PollGoal) -> Bool {
        guard let conversation else {
            processingState = .processing
            return false
        }

        if conversation.processing?.status.uppercased() == "FAILED" {
            processingState = .error(activeProcessingMessage ?? "Nie udało się przygotować odpowiedzi")
            return true
        }

        if conversation.awaiting_user_answer {
            processingState = .waitingForNextQuestion
            return true
        }

        switch goal {
        case .investigationFlow:
            if recommendation != nil {
                processingState = .complete
                return true
            }

            processingState = .processing
            return false
        case .directResponse(let userMessageID):
            if let index = latestUserMessageIndex(in: conversation.messages, afterUserMessageID: userMessageID),
               conversation.messages[index].isAnalysisCancelled {
                // Cancelled (possibly from another device): stop polling and keep the confirmation visible.
                if case .cancelled = processingState {} else {
                    processingState = .cancelled(Self.cancelledMessage)
                }
                return true
            }

            if hasPendingDirectResponse(in: conversation, afterUserMessageID: userMessageID) {
                processingState = .processing
                return false
            }

            processingState = .idle
            return true
        }
    }

    private func hasPendingDirectResponse(in conversation: ConversationResponse, afterUserMessageID: String?) -> Bool {
        guard let latestUserIndex = latestUserMessageIndex(in: conversation.messages, afterUserMessageID: afterUserMessageID) else {
            return afterUserMessageID != nil
        }

        if conversation.messages[latestUserIndex].isAnalysisCancelled {
            return false
        }

        let trailingMessages = conversation.messages.dropFirst(latestUserIndex + 1)
        return !trailingMessages.contains { message in
            isAssistantTimelineMessage(message)
        }
    }

    private func hasCompletedDirectResponse(in conversation: ConversationResponse, afterUserMessageID: String? = nil) -> Bool {
        guard let latestUserIndex = latestUserMessageIndex(in: conversation.messages, afterUserMessageID: afterUserMessageID) else {
            return false
        }

        let trailingMessages = conversation.messages.dropFirst(latestUserIndex + 1)
        return trailingMessages.contains { message in
            isAssistantTimelineMessage(message)
        }
    }

    private func latestUserMessageIndex(in messages: [ConversationMessage], afterUserMessageID: String?) -> Int? {
        guard !messages.isEmpty else {
            return nil
        }

        if let afterUserMessageID {
            return messages.lastIndex(where: { message in message.id == afterUserMessageID })
        }

        return messages.lastIndex(where: { message in
            message.role.uppercased() == "USER" && message.message_type.uppercased() == "USER_MESSAGE"
        })
    }

    private func isAssistantTimelineMessage(_ message: ConversationMessage) -> Bool {
        message.role.uppercased() == "ASSISTANT" || message.message_type.uppercased() == "ASSISTANT_MESSAGE"
    }

    private func shouldRenderRecommendationCard(_ recommendation: RecommendationResponse) -> Bool {
        if recommendation.status.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() != "READY" {
            return false
        }

        let proposalType = recommendation.proposal.type.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let allowedProposalTypes = Set(["FOLLOW_UP_QUESTION", "PROPOSAL", "OBSERVATION"])
        if !allowedProposalTypes.contains(proposalType) {
            return false
        }

        let normalizedTitle = recommendation.proposal.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedText = recommendation.proposal.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedTitle.isEmpty || normalizedText.isEmpty {
            return false
        }

        if let recommendationTypeRaw = recommendation.proposal.recommendation_type?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
           !recommendationTypeRaw.isEmpty {
            if recommendationTypeRaw == "NO_ACTION" {
                return false
            }

            let userFacingTypes = Set(["CLARIFY", "OBSERVE", "CONSIDER_ACTION"])
            return userFacingTypes.contains(recommendationTypeRaw)
        }

        return true
    }

    private func isInvestigationConversation(_ conversation: ConversationResponse) -> Bool {
        if conversation.awaiting_user_answer || conversation.pending_question != nil {
            return true
        }

        if recommendation != nil {
            return true
        }

        let origin = conversation.origin?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        if origin == "SYSTEM" {
            return true
        }

        let triggerType = conversation.trigger_type?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        if triggerType.contains("HYPO") {
            return true
        }

        let conversationType = conversation.conversation_type?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        if conversationType == "TRIGGER_INITIATED" {
            return true
        }

        return conversation.messages.contains { message in
            let normalizedType = message.message_type.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            return normalizedType == "CONTEXT_QUESTION" || normalizedType == "CONTEXT_ANSWER"
        }
    }

    private func publishTimelineUpdateIfNeeded() {
        let signature = timelineItems.map(\.id).joined(separator: "|") + "::" + processingState.id
        if signature != lastTimelineSignature {
            lastTimelineSignature = signature
            timelineUpdateVersion += 1
        }
    }
}
