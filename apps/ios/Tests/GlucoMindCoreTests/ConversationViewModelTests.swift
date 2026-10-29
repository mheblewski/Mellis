import XCTest
@testable import GlucoMindCore

@MainActor
final class ConversationViewModelTests: XCTestCase {
    func testLoadConversationRendersPendingQuestion() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.conversation?.pending_question?.question_id, "activity_before_drop")
        XCTAssertEqual(model.conversation?.awaiting_user_answer, true)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .question(let question) = item {
                return question.question_id == "activity_before_drop"
            }
            return false
        })
    }

    /// After a notification tap the first read often fails (iOS cut it off while the phone was locked): the refresh
    /// reads once more instead of flashing a red error over the answer.
    func testRefreshAfterUnlockReadsAgainInsteadOfShowingANetworkError() async {
        var reads = 0
        var failNextRead = false
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: ClosureHTTPClient { request in
                guard request.url?.path.contains("/conversations/conv-1") == true, request.httpMethod == "GET" else { return (Data(), 404) }
                reads += 1
                if failNextRead {
                    failNextRead = false
                    throw APIClientError.transport("The network connection was lost.")
                }
                return (Data(#"{"id":"conv-1","patient_id":"patient-1","awaiting_user_answer":false,"pending_question":null,"messages":[]}"#.utf8), 200)
            }
        )
        let model = ConversationViewModel(apiClient: client, patientID: "patient-1", conversationID: "conv-1", pollInterval: .milliseconds(1))
        await model.loadConversation()
        XCTAssertEqual(model.state, .loaded)

        failNextRead = true
        await model.refreshActiveConversation()

        XCTAssertEqual(reads, 3)
        XCTAssertNil(model.agentActivity)
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertNil(model.lastLoadFailure)
    }

    func testRefreshShowsTheNetworkErrorWhenTheSecondReadFailsToo() async {
        var failReads = false
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: ClosureHTTPClient { request in
                if failReads { throw APIClientError.transport("offline") }
                return (Data(#"{"id":"conv-1","patient_id":"patient-1","awaiting_user_answer":false,"pending_question":null,"messages":[]}"#.utf8), 200)
            }
        )
        let model = ConversationViewModel(apiClient: client, patientID: "patient-1", conversationID: "conv-1", pollInterval: .milliseconds(1))
        await model.loadConversation()

        failReads = true
        await model.refreshActiveConversation()

        XCTAssertEqual(model.agentActivity?.phase, .failed)
        XCTAssertEqual(model.lastLoadFailure, .network)
    }

    func testPendingQuestionIsNotDuplicatedAsAssistantMessageAfterReload() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.timelineItems.filter { item in
            if case .question(let question) = item {
                return question.question_id == "activity_before_drop"
            }
            return false
        }.count, 1)
        XCTAssertEqual(model.timelineItems.filter { item in
            if case .assistantMessage(let message) = item {
                return message.message_type == "CONTEXT_QUESTION" && message.question_id == "activity_before_drop"
            }
            return false
        }.count, 0)

        await model.refreshActiveConversation()

        XCTAssertEqual(model.timelineItems.filter { item in
            if case .question(let question) = item {
                return question.question_id == "activity_before_drop"
            }
            return false
        }.count, 1)
        XCTAssertEqual(model.timelineItems.filter { item in
            if case .assistantMessage(let message) = item {
                return message.message_type == "CONTEXT_QUESTION" && message.question_id == "activity_before_drop"
            }
            return false
        }.count, 0)
    }

    func testSameQuestionTextWithDifferentQuestionIDsRemainsDistinctMessages() async {
        let api = SameTextDifferentQuestionIDsAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-same-text",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        let assistantQuestionMessages = model.timelineItems.compactMap { item -> ConversationMessage? in
            if case .assistantMessage(let message) = item,
               message.message_type == "CONTEXT_QUESTION" {
                return message
            }

            return nil
        }

        XCTAssertEqual(assistantQuestionMessages.count, 2)
        XCTAssertEqual(Set(assistantQuestionMessages.compactMap(\.question_id)).count, 2)
    }

    func testCurrentBackendProcessingStepRendersFromConversationPayload() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.processingState, .processing)
        XCTAssertEqual(model.statusMessage, "Sprawdzam glikemię · 08.10 06:30-08:00")
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .processing = item {
                return true
            }
            return false
        })
    }

    func testSubmitShowsLocalUserMessageImmediately() async {
        let api = ScenarioConversationAPI(simulateSlowPost: true)
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        async let submit: Void = model.submitAnswer(.unknown)
        try? await Task.sleep(for: .milliseconds(15))

        XCTAssertEqual(model.processingState, .sending)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .localEcho(let message) = item {
                return message.content == "Nie wiem"
            }
            return false
        })

        _ = await submit
    }

    func testLocalEchoShowsWhenAnEarlierMessageHasTheSameText() async {
        // A photo sent without text, or a question asked again, has the text of an earlier message: the echo still
        // shows, or the chat scrolls to that earlier message instead of the one being sent.
        let api = ScenarioConversationAPI(simulateSlowPost: true)
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-repeat",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        async let submit: Void = model.submitAnswer(.unknown)
        try? await Task.sleep(for: .milliseconds(15))

        XCTAssertTrue(model.timelineItems.contains { item in
            if case .localEcho(let message) = item {
                return message.content == "Nie wiem"
            }
            return false
        })

        _ = await submit
    }

    func testPollingContinuesUntilRecommendationArrives() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        await model.submitAnswer(.unknown)

        XCTAssertEqual(model.processingState, .complete)
        XCTAssertNotNil(model.recommendation)
    }

    func testSwitchingConversationLoadsCorrectConversation() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        XCTAssertEqual(model.conversation?.id, "conv-1")

        await model.selectConversation("conv-2")
        XCTAssertEqual(model.conversation?.id, "conv-2")
        XCTAssertEqual(model.conversation?.pending_question?.question_id, "additional_carbohydrates")
    }

    func testCompletedConversationIsReadOnly() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-complete",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertTrue(model.isReadOnlyConversation)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .question = item {
                return true
            }
            return false
        })
    }

    func testForceReloadSameConversationPerformsRefresh() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        let before = api.getConversationCallCount["conv-1"] ?? 0

        await model.selectConversation("conv-1", forceReload: true)
        let after = api.getConversationCallCount["conv-1"] ?? 0

        XCTAssertGreaterThan(after, before)
    }

    func testTimelineVersionChangesWhenConversationUpdates() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        let versionBefore = model.timelineUpdateVersion

        await model.submitAnswer(.unknown)

        let versionAfter = model.timelineUpdateVersion
        XCTAssertGreaterThan(versionAfter, versionBefore)
    }

    func testSubmitUserMessagePollsUntilAssistantMessageArrives() async {
        let api = DirectResponseScenarioAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-direct",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        model.userMessageText = "What does this trend mean?"

        await model.submitUserMessage()

        XCTAssertEqual(model.processingState, .idle)
        XCTAssertNil(model.statusMessage)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .processing(.complete) = item {
                return true
            }
            return false
        })
        XCTAssertEqual(api.recordedUserMessage, "What does this trend mean?")
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item {
                return message.message_type == "ASSISTANT_MESSAGE"
            }
            return false
        })
    }

    func testSubmitUserMessageDoesNotFinishEarlyWhenConversationAlreadyHasAnalysisAndRecommendation() async {
        let api = DirectResponseExistingArtifactsScenarioAPI(queuedPollsBeforeAssistant: 3)
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-direct-artifacts",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        model.userMessageText = "Jaki był ostatni posiłek?"

        await model.submitUserMessage()

        XCTAssertGreaterThanOrEqual(api.getConversationCallCount, 4)
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertNil(model.statusMessage)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .processing(.complete) = item {
                return true
            }
            return false
        })
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item {
                return message.id == "assistant-new-1"
            }
            return false
        })
    }

    func testSubmitUserMessageTimeoutKeepsProcessingWhenNoNewAssistantArrives() async {
        let api = DirectResponseNoNewAssistantTimeoutAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-direct-timeout",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        model.userMessageText = "Czy był ostatni posiłek?"

        await model.submitUserMessage()

        // 1 load + 45 quick reads + 27 slower ones (about 3 minutes in all at the real interval).
        XCTAssertEqual(api.getConversationCallCount, 46 + ConversationViewModel.slowPollAttempts)
        XCTAssertEqual(model.processingState, .processing)
        XCTAssertNotEqual(model.processingState, .complete)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item {
                return message.id == "assistant-new-timeout"
            }
            return false
        })
    }

    func testExistingAssistantBeforeNewPromptIsNotMatchedAsNewDirectResponse() async {
        let api = DirectResponseExistingArtifactsScenarioAPI(queuedPollsBeforeAssistant: 2)
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-direct-artifacts",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        model.userMessageText = "A jaki był ostatni posiłek?"

        await model.submitUserMessage()

        XCTAssertGreaterThanOrEqual(api.getConversationCallCount, 3)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item {
                return message.id == "assistant-old-1"
            }
            return false
        })
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item {
                return message.id == "assistant-new-1"
            }
            return false
        })
    }

    func testEmptyUserConversationIsIdleAndComposerEligible() async {
        let api = EmptyUserConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-empty-user",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertTrue(model.canSendUserMessage)
        XCTAssertNil(model.statusMessage)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .question = item {
                return true
            }
            return false
        })
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .processing = item {
                return true
            }
            return false
        })
    }

    func testInvestigationCompletionStatusIsTransientAndClearsAfterRefresh() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-1",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()
        await model.submitAnswer(.unknown)

        XCTAssertEqual(model.processingState, .complete)
        XCTAssertEqual(model.statusMessage, "Analiza zakończona")
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .processing(.complete) = item {
                return true
            }
            return false
        })

        await model.refreshActiveConversation()

        XCTAssertEqual(model.processingState, .idle)
        XCTAssertNil(model.statusMessage)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .processing(.complete) = item {
                return true
            }
            return false
        })
    }

    func testLoadedConversationWithQueuedDirectResponseShowsProcessing() async {
        let api = PendingDirectResponseAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-pending-direct",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.processingState, .processing)
    }

    func testFailedBackendProcessingStepIsRenderedSafely() async {
        let api = ScenarioConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-failed",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.statusMessage, "Nie udało się pobrać danych sprawdzam glikemię")
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .processing = item {
                return true
            }
            return false
        })
    }

    func testInternalSystemArtifactsAreNotRenderedAsAssistantMessages() async {
        let api = InternalArtifactsConversationAPI()
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-internal-artifacts",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        let assistantTexts = model.timelineItems.compactMap { item -> String? in
            if case .assistantMessage(let message) = item {
                return message.content
            }

            return nil
        }

        XCTAssertFalse(assistantTexts.contains("Conversation-derived context is sufficient to close this user-origin investigation path."))
        XCTAssertTrue(assistantTexts.contains("Dziekuje za doprecyzowanie. Uwzglednilem te informacje w analizie dzisiejszych hipoglikemii."))
    }

    func testRecommendationCardHiddenForInsufficientDataStatus() async {
        let api = RecommendationVisibilityScenarioAPI(
            recommendationStatus: "INSUFFICIENT_DATA",
            recommendationType: "NO_ACTION",
            proposalType: "OBSERVATION",
            proposalTitle: "Insufficient data",
            proposalText: "Need more evidence to make a recommendation."
        )
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-visibility",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertNotNil(model.recommendation)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .recommendation = item {
                return true
            }
            return false
        })
    }

    func testRecommendationCardHiddenForNoActionableRecommendationStatus() async {
        let api = RecommendationVisibilityScenarioAPI(
            recommendationStatus: "NO_ACTIONABLE_RECOMMENDATION",
            recommendationType: "NO_ACTION",
            proposalType: "OBSERVATION",
            proposalTitle: "No actionable recommendation",
            proposalText: "No evidence-bound next step is currently recommended."
        )
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-visibility",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertNotNil(model.recommendation)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .recommendation = item {
                return true
            }
            return false
        })
    }

    func testRecommendationCardShownForReadyActionableRecommendation() async {
        let api = RecommendationVisibilityScenarioAPI(
            recommendationStatus: "READY",
            recommendationType: "CONSIDER_ACTION",
            proposalType: "PROPOSAL",
            proposalTitle: "Consider next step",
            proposalText: "Consider discussing this trend with your care team."
        )
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-visibility",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertTrue(model.timelineItems.contains { item in
            if case .recommendation(let recommendation) = item {
                return recommendation.status == "READY"
            }
            return false
        })
    }

    func testRecommendationIdAloneDoesNotForceCardRendering() async {
        let api = RecommendationVisibilityScenarioAPI(
            recommendationStatus: "INSUFFICIENT_DATA",
            recommendationType: "NO_ACTION",
            proposalType: "OBSERVATION",
            proposalTitle: "Insufficient data",
            proposalText: "Need more evidence to make a recommendation."
        )
        let model = ConversationViewModel(
            apiClient: api.client,
            patientID: "patient-1",
            conversationID: "conv-visibility",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.conversation?.recommendation_id, "rec-visibility")
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .recommendation = item {
                return true
            }
            return false
        })
        XCTAssertFalse(model.timelineItems.contains { item in
            if case .processing = item {
                return true
            }
            return false
        })
    }
}

@MainActor
private final class ScenarioConversationAPI {
    var recordedAnswerTypes: [AnswerType] = []
    var recordedTextAnswer: String?
    var getConversationCallCount: [String: Int] = [:]

    private enum Conv1Stage {
        case pendingQuestion
        case analysisReady
        case recommendationReady
    }

    private var conv1Stage: Conv1Stage = .pendingQuestion
    private let simulateSlowPost: Bool

    init(simulateSlowPost: Bool = false) {
        self.simulateSlowPost = simulateSlowPost
    }

    lazy var client: APIClient = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authProvider: StubAuthProvider(),
        httpClient: ClosureHTTPClient { request in
            let path = request.url?.path ?? ""

            if path.contains("/conversations/") && request.httpMethod == "GET" {
                let conversationID = path.split(separator: "/").last.map(String.init) ?? ""
                self.getConversationCallCount[conversationID, default: 0] += 1
                return (self.getConversationResponseData(conversationID: conversationID), 200)
            }

            if path.contains("/analyses/") {
                return (Self.analysisResponseData(), 200)
            }

            if path.contains("/recommendations/") {
                return (Self.recommendationResponseData(), 200)
            }

            if request.httpMethod == "POST" {
                if self.simulateSlowPost {
                    try await Task.sleep(for: .milliseconds(80))
                }

                let body = request.httpBody ?? Data()
                let payload = try JSONDecoder().decode(MessageSubmissionRequest.self, from: body)
                self.recordedAnswerTypes.append(payload.answer.type)
                self.recordedTextAnswer = payload.answer.text
                self.conv1Stage = .analysisReady
                return (Self.messageSubmissionResponseData(), 200)
            }

            return (Data(), 404)
        }
    )

    private func getConversationResponseData(conversationID: String) -> Data {
        switch conversationID {
        case "conv-1":
            switch conv1Stage {
            case .pendingQuestion:
                return Self.pendingConversationData(conversationID: "conv-1", questionID: "activity_before_drop")
            case .analysisReady:
                conv1Stage = .recommendationReady
                return Self.analysisReadyConversationData(conversationID: "conv-1")
            case .recommendationReady:
                return Self.recommendationReadyConversationData(conversationID: "conv-1")
            }
        case "conv-2":
            return Self.pendingConversationData(conversationID: "conv-2", questionID: "additional_carbohydrates")
        case "conv-repeat":
            return Self.pendingConversationData(conversationID: "conv-repeat", questionID: "activity_before_drop", earlierUserText: "Nie wiem")
        case "conv-complete":
            return Self.recommendationReadyConversationData(conversationID: "conv-complete")
        case "conv-failed":
            return Self.failedConversationData(conversationID: "conv-failed")
        default:
            return Self.pendingConversationData(conversationID: conversationID, questionID: "activity_before_drop")
        }
    }

    private static func pendingConversationData(conversationID: String, questionID: String, earlierUserText: String? = nil) -> Data {
        let earlierUserMessage = earlierUserText.map { text in
            #"{"id":"user-earlier","role":"USER","message_type":"USER_MESSAGE","content":"\#(text)","created_at":"2025-12-31T23:00:00.000Z"},"#
        } ?? ""
        let json = """
        {
          "id":"\(conversationID)",
          "patient_id":"patient-1",
          "awaiting_user_answer":true,
          "processing": {
            "status":"PROCESSING",
            "current_step": {
              "execution_id":"exec-100",
              "sequence":1,
              "type":"REQUESTING_EVIDENCE",
              "status":"STARTED",
              "label":"Sprawdzam glikemię · 08.10 06:30-08:00",
              "tool":"get_glucose_evidence",
              "detail":"TARGETED_DETAIL",
              "time_range":{"start":"2026-10-08T06:30:00.000Z","end":"2026-10-08T08:00:00.000Z"},
              "started_at":"2026-10-08T06:30:00.000Z",
              "completed_at":null
            },
            "steps":[{
              "execution_id":"exec-100",
              "sequence":1,
              "type":"REQUESTING_EVIDENCE",
              "status":"STARTED",
              "label":"Sprawdzam glikemię · 08.10 06:30-08:00",
              "tool":"get_glucose_evidence",
              "detail":"TARGETED_DETAIL",
              "time_range":{"start":"2026-10-08T06:30:00.000Z","end":"2026-10-08T08:00:00.000Z"},
              "started_at":"2026-10-08T06:30:00.000Z",
              "completed_at":null
            }]
          },
          "pending_question":{
            "question_id":"\(questionID)",
            "question_type":"CONTEXT_QUESTION",
            "question_text":"Was there activity?",
            "expected_answer_types":["YES","NO","UNKNOWN","TEXT"],
            "reason":"missing context",
            "expected_information_gain":"HIGH",
            "status":"OPEN",
            "created_at":"2026-01-01T00:00:00.000Z"
          },
          "messages":[\(earlierUserMessage)
            {
              "id":"assistant-1",
              "role":"ASSISTANT",
              "message_type":"CONTEXT_QUESTION",
              "content":"Was there activity before the glucose drop?",
              "question_id":"\(questionID)",
              "answer_type":null,
              "answer_text":null,
              "created_at":"2026-01-01T00:00:00.000Z"
            }
          ],
          "analysis_id":null,
          "recommendation_id":null
        }
        """

        return json.data(using: .utf8)!
    }

    private static func analysisReadyConversationData(conversationID: String) -> Data {
        let json = """
        {
          "id":"\(conversationID)",
          "patient_id":"patient-1",
          "awaiting_user_answer":false,
          "pending_question":null,
          "messages":[
            {
              "id":"assistant-1",
              "role":"ASSISTANT",
              "message_type":"CONTEXT_QUESTION",
              "content":"Was there activity before the glucose drop?",
              "question_id":"activity_before_drop",
              "answer_type":null,
              "answer_text":null,
              "created_at":"2026-01-01T00:00:00.000Z"
            },
            {
              "id":"user-1",
              "role":"USER",
              "message_type":"CONTEXT_ANSWER",
              "content":"UNKNOWN",
              "question_id":"activity_before_drop",
              "answer_type":"UNKNOWN",
              "answer_text":null,
              "created_at":"2026-01-01T00:00:01.000Z"
            }
          ],
          "analysis_id":"an-1",
          "recommendation_id":null
        }
        """

        return json.data(using: .utf8)!
    }

        private static func failedConversationData(conversationID: String) -> Data {
                let json = """
                {
                    "id":"\(conversationID)",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "processing": {
                        "status":"FAILED",
                        "current_step": {
                            "execution_id":"exec-404",
                            "sequence":3,
                            "type":"FAILED",
                            "status":"FAILED",
                            "label":"Nie udało się pobrać danych sprawdzam glikemię",
                            "tool":"get_glucose_evidence",
                            "detail":null,
                            "time_range":{"start":"2026-10-08T06:30:00.000Z","end":"2026-10-08T08:00:00.000Z"},
                            "started_at":"2026-10-08T06:30:00.000Z",
                            "completed_at":"2026-10-08T06:31:00.000Z"
                        },
                        "steps":[]
                    },
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Przeanalizuj ten zakres",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }

    private static func recommendationReadyConversationData(conversationID: String) -> Data {
        let json = """
        {
          "id":"\(conversationID)",
          "patient_id":"patient-1",
          "awaiting_user_answer":false,
          "pending_question":null,
          "messages":[
            {
              "id":"assistant-1",
              "role":"ASSISTANT",
              "message_type":"CONTEXT_QUESTION",
              "content":"Was there activity before the glucose drop?",
              "question_id":"activity_before_drop",
              "answer_type":null,
              "answer_text":null,
              "created_at":"2026-01-01T00:00:00.000Z"
            },
            {
              "id":"user-1",
              "role":"USER",
              "message_type":"CONTEXT_ANSWER",
              "content":"UNKNOWN",
              "question_id":"activity_before_drop",
              "answer_type":"UNKNOWN",
              "answer_text":null,
              "created_at":"2026-01-01T00:00:01.000Z"
            }
          ],
          "analysis_id":"an-1",
          "recommendation_id":"rec-1"
        }
        """

        return json.data(using: .utf8)!
    }

    private static func messageSubmissionResponseData() -> Data {
        let json = """
        {
          "message": {
            "id":"msg-1",
            "role":"USER",
            "message_type":"CONTEXT_ANSWER",
            "content":"UNKNOWN",
            "question_id":"activity_before_drop",
            "answer_type":"UNKNOWN",
            "answer_text":null,
            "created_at":"2026-01-01T00:00:00.000Z"
          },
          "conversation": {
            "id":"conv-1",
            "patient_id":"patient-1",
            "awaiting_user_answer":false,
            "pending_question":null,
            "messages":[
              {
                "id":"assistant-1",
                "role":"ASSISTANT",
                "message_type":"CONTEXT_QUESTION",
                "content":"Was there activity before the glucose drop?",
                "question_id":"activity_before_drop",
                "answer_type":null,
                "answer_text":null,
                "created_at":"2026-01-01T00:00:00.000Z"
              },
              {
                "id":"user-1",
                "role":"USER",
                "message_type":"CONTEXT_ANSWER",
                "content":"UNKNOWN",
                "question_id":"activity_before_drop",
                "answer_type":"UNKNOWN",
                "answer_text":null,
                "created_at":"2026-01-01T00:00:01.000Z"
              }
            ],
            "analysis_id":null,
            "recommendation_id":null
          }
        }
        """

        return json.data(using: .utf8)!
    }

    private static func analysisResponseData() -> Data {
        let json = """
        {
          "id":"an-1",
          "status":"COMPLETED",
          "facts":[{"fact_id":"f1","statement":"fact","source_refs":["s1"]}],
          "unknowns":[{"unknown_id":"u1","statement":"unknown","status":"UNKNOWN"}],
          "calculations":[{"calculation_id":"c1","name":"calc","result":"1","deterministic":true}],
          "hypotheses":[{"hypothesis_id":"h1","statement":"hyp","confidence":"LOW","status":"ACTIVE","supporting_evidence_refs":[],"opposing_evidence_refs":[]}],
          "assumptions":[{"text":"assumption"}],
          "uncertainty":{"level":"LOW","summary":"summary"},
          "rationale":"rationale"
        }
        """

        return json.data(using: .utf8)!
    }

    private static func recommendationResponseData() -> Data {
        let json = """
        {
          "id":"rec-1",
          "status":"READY",
          "proposal":{"type":"PROPOSAL","title":"title","text":"text"}
        }
        """

        return json.data(using: .utf8)!
    }
}

private struct StubAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "user-1" }
}

private final class ClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}

@MainActor
private final class SameTextDifferentQuestionIDsAPI {
        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-same-text") && request.httpMethod == "GET" {
                                return (Self.conversationData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func conversationData() -> Data {
                let json = """
                {
                    "id":"conv-same-text",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"assistant-q-1",
                            "role":"ASSISTANT",
                            "message_type":"CONTEXT_QUESTION",
                            "content":"Czy przed spadkiem byla aktywnosc fizyczna?",
                            "question_id":"q-episode-a",
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-q-2",
                            "role":"ASSISTANT",
                            "message_type":"CONTEXT_QUESTION",
                            "content":"Czy przed spadkiem byla aktywnosc fizyczna?",
                            "question_id":"q-episode-b",
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:01:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class DirectResponseScenarioAPI {
        enum Stage {
                case initial
                case queued
                case responded
        }

        var recordedUserMessage: String?

        private var stage: Stage = .initial
        private var emittedQueuedSnapshot = false

        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-direct") && request.httpMethod == "GET" {
                                switch self.stage {
                                case .initial:
                                        return (Self.initialConversationData(), 200)
                                case .queued:
                                        if self.emittedQueuedSnapshot {
                                                self.stage = .responded
                                                return (Self.respondedConversationData(), 200)
                                        }

                                        self.emittedQueuedSnapshot = true
                                        return (Self.queuedConversationData(), 200)
                                case .responded:
                                        return (Self.respondedConversationData(), 200)
                                }
                        }

                        if path.contains("/conversations/conv-direct/messages") && request.httpMethod == "POST" {
                                let body = request.httpBody ?? Data()
                                let payload = try JSONDecoder().decode(UserMessageSubmissionRequest.self, from: body)
                                self.recordedUserMessage = payload.content
                                self.stage = .queued
                                self.emittedQueuedSnapshot = false
                                return (Self.directResponseSubmissionData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func initialConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }

        private static func queuedConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-direct-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"What does this trend mean?",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }

        private static func respondedConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-direct-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"What does this trend mean?",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-direct-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"The trend is currently stable.",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:01.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }

        private static func directResponseSubmissionData() -> Data {
                let json = """
                {
                    "message": {
                        "id":"user-direct-1",
                        "role":"USER",
                        "message_type":"USER_MESSAGE",
                        "content":"What does this trend mean?",
                        "question_id":null,
                        "answer_type":null,
                        "answer_text":null,
                        "created_at":"2026-01-01T00:00:00.000Z"
                    },
                    "conversation": {
                        "id":"conv-direct",
                        "patient_id":"patient-1",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[
                            {
                                "id":"user-direct-1",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"What does this trend mean?",
                                "question_id":null,
                                "answer_type":null,
                                "answer_text":null,
                                "created_at":"2026-01-01T00:00:00.000Z"
                            }
                        ],
                        "analysis_id":null,
                        "recommendation_id":null
                    },
                    "decision":"DIRECT_RESPONSE"
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class DirectResponseExistingArtifactsScenarioAPI {
        private enum Stage {
                case initial
                case queued
                case responded
        }

        var getConversationCallCount = 0

        private let queuedPollsBeforeAssistant: Int
        private var stage: Stage = .initial
        private var queuedPollCount = 0

        init(queuedPollsBeforeAssistant: Int) {
                self.queuedPollsBeforeAssistant = queuedPollsBeforeAssistant
        }

        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-direct-artifacts") && request.httpMethod == "GET" {
                                self.getConversationCallCount += 1
                                switch self.stage {
                                case .initial:
                                        return (Self.initialConversationData(), 200)
                                case .queued:
                                        self.queuedPollCount += 1
                                        if self.queuedPollCount > self.queuedPollsBeforeAssistant {
                                                self.stage = .responded
                                                return (Self.respondedConversationData(), 200)
                                        }
                                        return (Self.queuedConversationData(), 200)
                                case .responded:
                                        return (Self.respondedConversationData(), 200)
                                }
                        }

                        if path.contains("/conversations/conv-direct-artifacts/messages") && request.httpMethod == "POST" {
                                self.stage = .queued
                                self.queuedPollCount = 0
                                return (Self.submissionData(), 200)
                        }

                        if path.contains("/analyses/") && request.httpMethod == "GET" {
                                return (Self.analysisData(), 200)
                        }

                        if path.contains("/recommendations/") && request.httpMethod == "GET" {
                                return (Self.recommendationData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func initialConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct-artifacts",
                    "patient_id":"patient-1",
                    "origin":"USER",
                    "conversation_type":"USER_INITIATED",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-old-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Co było dzisiaj największym problemem?",
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-old-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Największym problemem była hipoglikemia.",
                            "created_at":"2026-01-01T00:00:01.000Z"
                        }
                    ],
                    "analysis_id":"an-existing",
                    "recommendation_id":"rec-existing"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func queuedConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct-artifacts",
                    "patient_id":"patient-1",
                    "origin":"USER",
                    "conversation_type":"USER_INITIATED",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-old-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Co było dzisiaj największym problemem?",
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-old-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Największym problemem była hipoglikemia.",
                            "created_at":"2026-01-01T00:00:01.000Z"
                        },
                        {
                            "id":"user-new-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Jaki był ostatni posiłek?",
                            "created_at":"2026-01-01T00:00:02.000Z"
                        }
                    ],
                    "analysis_id":"an-existing",
                    "recommendation_id":"rec-existing"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func respondedConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct-artifacts",
                    "patient_id":"patient-1",
                    "origin":"USER",
                    "conversation_type":"USER_INITIATED",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-old-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Co było dzisiaj największym problemem?",
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-old-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Największym problemem była hipoglikemia.",
                            "created_at":"2026-01-01T00:00:01.000Z"
                        },
                        {
                            "id":"user-new-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Jaki był ostatni posiłek?",
                            "created_at":"2026-01-01T00:00:02.000Z"
                        },
                        {
                            "id":"assistant-new-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"W danych nie ma jednoznacznego wpisu posiłku.",
                            "created_at":"2026-01-01T00:00:03.000Z"
                        }
                    ],
                    "analysis_id":"an-existing",
                    "recommendation_id":"rec-existing"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func submissionData() -> Data {
                let json = """
                {
                    "message": {
                        "id":"user-new-1",
                        "role":"USER",
                        "message_type":"USER_MESSAGE",
                        "content":"Jaki był ostatni posiłek?",
                        "created_at":"2026-01-01T00:00:02.000Z"
                    },
                    "conversation": {
                        "id":"conv-direct-artifacts",
                        "patient_id":"patient-1",
                        "origin":"USER",
                        "conversation_type":"USER_INITIATED",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[
                            {
                                "id":"user-old-1",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Co było dzisiaj największym problemem?",
                                "created_at":"2026-01-01T00:00:00.000Z"
                            },
                            {
                                "id":"assistant-old-1",
                                "role":"ASSISTANT",
                                "message_type":"ASSISTANT_MESSAGE",
                                "content":"Największym problemem była hipoglikemia.",
                                "created_at":"2026-01-01T00:00:01.000Z"
                            },
                            {
                                "id":"user-new-1",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Jaki był ostatni posiłek?",
                                "created_at":"2026-01-01T00:00:02.000Z"
                            }
                        ],
                        "analysis_id":"an-existing",
                        "recommendation_id":"rec-existing"
                    },
                    "decision":"DIRECT_RESPONSE"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func analysisData() -> Data {
                let json = """
                {
                  "id":"an-existing",
                  "status":"COMPLETED",
                  "facts":[],
                  "unknowns":[],
                  "calculations":[],
                  "hypotheses":[],
                  "assumptions":[],
                  "uncertainty":{"level":"LOW","summary":"summary"},
                  "rationale":"rationale"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func recommendationData() -> Data {
                let json = """
                {
                    "id":"rec-existing",
                    "status":"READY",
                    "proposal":{"type":"OBSERVATION","title":"Observation","text":"Observation text","recommendation_type":"OBSERVE"}
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class DirectResponseNoNewAssistantTimeoutAPI {
        var getConversationCallCount = 0

        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-direct-timeout") && request.httpMethod == "GET" {
                                self.getConversationCallCount += 1
                                return (Self.queuedConversationData(), 200)
                        }

                        if path.contains("/conversations/conv-direct-timeout/messages") && request.httpMethod == "POST" {
                                return (Self.submissionData(), 200)
                        }

                        if path.contains("/analyses/") && request.httpMethod == "GET" {
                                return (Self.analysisData(), 200)
                        }

                        if path.contains("/recommendations/") && request.httpMethod == "GET" {
                                return (Self.recommendationData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func queuedConversationData() -> Data {
                let json = """
                {
                    "id":"conv-direct-timeout",
                    "patient_id":"patient-1",
                    "origin":"USER",
                    "conversation_type":"USER_INITIATED",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-old-timeout",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Wczoraj problem?",
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-old-timeout",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Wczoraj dominowały spadki.",
                            "created_at":"2026-01-01T00:00:01.000Z"
                        },
                        {
                            "id":"user-new-timeout",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Czy był ostatni posiłek?",
                            "created_at":"2026-01-01T00:00:02.000Z"
                        }
                    ],
                    "analysis_id":"an-existing",
                    "recommendation_id":"rec-existing"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func submissionData() -> Data {
                let json = """
                {
                    "message": {
                        "id":"user-new-timeout",
                        "role":"USER",
                        "message_type":"USER_MESSAGE",
                        "content":"Czy był ostatni posiłek?",
                        "created_at":"2026-01-01T00:00:02.000Z"
                    },
                    "conversation": {
                        "id":"conv-direct-timeout",
                        "patient_id":"patient-1",
                        "origin":"USER",
                        "conversation_type":"USER_INITIATED",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[
                            {
                                "id":"user-old-timeout",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Wczoraj problem?",
                                "created_at":"2026-01-01T00:00:00.000Z"
                            },
                            {
                                "id":"assistant-old-timeout",
                                "role":"ASSISTANT",
                                "message_type":"ASSISTANT_MESSAGE",
                                "content":"Wczoraj dominowały spadki.",
                                "created_at":"2026-01-01T00:00:01.000Z"
                            },
                            {
                                "id":"user-new-timeout",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Czy był ostatni posiłek?",
                                "created_at":"2026-01-01T00:00:02.000Z"
                            }
                        ],
                        "analysis_id":"an-existing",
                        "recommendation_id":"rec-existing"
                    },
                    "decision":"DIRECT_RESPONSE"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func analysisData() -> Data {
                let json = """
                {
                  "id":"an-existing",
                  "status":"COMPLETED",
                  "facts":[],
                  "unknowns":[],
                  "calculations":[],
                  "hypotheses":[],
                  "assumptions":[],
                  "uncertainty":{"level":"LOW","summary":"summary"},
                  "rationale":"rationale"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func recommendationData() -> Data {
                let json = """
                {
                    "id":"rec-existing",
                    "status":"READY",
                    "proposal":{"type":"OBSERVATION","title":"Observation","text":"Observation text","recommendation_type":"OBSERVE"}
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class PendingDirectResponseAPI {
        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-pending-direct") && request.httpMethod == "GET" {
                                return (Self.pendingDirectConversationData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func pendingDirectConversationData() -> Data {
                let json = """
                {
                    "id":"conv-pending-direct",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-direct-pending-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Can you explain this pattern?",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class RecommendationVisibilityScenarioAPI {
        private let recommendationStatus: String
        private let recommendationType: String
        private let proposalType: String
        private let proposalTitle: String
        private let proposalText: String

        init(
                recommendationStatus: String,
                recommendationType: String,
                proposalType: String,
                proposalTitle: String,
                proposalText: String
        ) {
                self.recommendationStatus = recommendationStatus
                self.recommendationType = recommendationType
                self.proposalType = proposalType
                self.proposalTitle = proposalTitle
                self.proposalText = proposalText
        }

        lazy var client: APIClient = APIClient(
                baseURL: URL(string: "https://api.example.com")!,
                authProvider: StubAuthProvider(),
                httpClient: ClosureHTTPClient { request in
                        let path = request.url?.path ?? ""

                        if path.contains("/conversations/conv-visibility") && request.httpMethod == "GET" {
                                return (Self.conversationData(), 200)
                        }

                        if path.contains("/analyses/") && request.httpMethod == "GET" {
                                return (Self.analysisResponseData(), 200)
                        }

                        if path.contains("/recommendations/") && request.httpMethod == "GET" {
                                return (self.recommendationResponseData(), 200)
                        }

                        return (Data(), 404)
                }
        )

        private static func conversationData() -> Data {
                let json = """
                {
                    "id":"conv-visibility",
                    "patient_id":"patient-1",
                    "origin":"SYSTEM",
                    "trigger_type":"HYPO_DETECTED",
                    "conversation_type":"TRIGGER_INITIATED",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"assistant-visibility-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Największym problemem bezpieczeństwa był dziś epizod znacznej hipoglikemii.",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:01.000Z"
                        }
                    ],
                    "analysis_id":"an-visibility",
                    "recommendation_id":"rec-visibility"
                }
                """

                return json.data(using: .utf8)!
        }

        private static func analysisResponseData() -> Data {
                let json = """
                {
                    "id":"an-visibility",
                    "status":"INSUFFICIENT_DATA",
                    "facts":[],
                    "unknowns":[],
                    "calculations":[],
                    "hypotheses":[],
                    "assumptions":[],
                    "uncertainty":{"level":"LOW","summary":"summary"},
                    "rationale":"Rationale"
                }
                """

                return json.data(using: .utf8)!
        }

        private func recommendationResponseData() -> Data {
                let json = """
                {
                    "id":"rec-visibility",
                    "status":"\(recommendationStatus)",
                    "proposal":{
                        "type":"\(proposalType)",
                        "title":"\(proposalTitle)",
                        "text":"\(proposalText)",
                        "recommendation_type":"\(recommendationType)"
                    }
                }
                """

                return json.data(using: .utf8)!
        }
}

@MainActor
private final class EmptyUserConversationAPI {
    lazy var client: APIClient = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authProvider: StubAuthProvider(),
        httpClient: ClosureHTTPClient { request in
            let path = request.url?.path ?? ""

            if path.contains("/conversations/conv-empty-user") && request.httpMethod == "GET" {
                return (Self.emptyConversationData(), 200)
            }

            return (Data(), 404)
        }
    )

    private static func emptyConversationData() -> Data {
        let json = """
        {
            "id":"conv-empty-user",
            "patient_id":"patient-1",
            "origin":"USER",
            "trigger_type":null,
            "conversation_type":"USER_INITIATED",
            "workflow_status":"ACTIVE",
            "awaiting_user_answer":false,
            "pending_question":null,
            "messages":[],
            "analysis_id":null,
            "recommendation_id":null
        }
        """

        return json.data(using: .utf8)!
    }
}

@MainActor
private final class InternalArtifactsConversationAPI {
    lazy var client: APIClient = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authProvider: StubAuthProvider(),
        httpClient: ClosureHTTPClient { request in
            let path = request.url?.path ?? ""

            if path.contains("/conversations/conv-internal-artifacts") && request.httpMethod == "GET" {
                return (Self.conversationData(), 200)
            }

            return (Data(), 404)
        }
    )

    private static func conversationData() -> Data {
        let json = """
        {
            "id":"conv-internal-artifacts",
            "patient_id":"patient-1",
            "awaiting_user_answer":false,
            "pending_question":null,
            "messages":[
                {
                    "id":"user-1",
                    "role":"USER",
                    "message_type":"CONTEXT_ANSWER",
                    "content":"Dzisiaj hipoglikemie",
                    "question_id":"time_window_context",
                    "answer_type":"TEXT",
                    "answer_text":"Dzisiaj hipoglikemie",
                    "created_at":"2026-01-01T00:00:00.000Z"
                },
                {
                    "id":"assistant-1",
                    "role":"ASSISTANT",
                    "message_type":"ASSISTANT_MESSAGE",
                    "content":"Dziekuje za doprecyzowanie. Uwzglednilem te informacje w analizie dzisiejszych hipoglikemii.",
                    "question_id":null,
                    "answer_type":null,
                    "answer_text":null,
                    "created_at":"2026-01-01T00:00:01.000Z"
                },
                {
                    "id":"system-1",
                    "role":"SYSTEM",
                    "message_type":"ANALYSIS_SUMMARY",
                    "content":"Conversation-derived context is sufficient to close this user-origin investigation path.",
                    "question_id":"time_window_context",
                    "answer_type":null,
                    "answer_text":null,
                    "created_at":"2026-01-01T00:00:02.000Z"
                },
                {
                    "id":"system-2",
                    "role":"SYSTEM",
                    "message_type":"RECOMMENDATION",
                    "content":"Conversation-derived context is sufficient to close this user-origin investigation path.",
                    "question_id":null,
                    "answer_type":null,
                    "answer_text":null,
                    "created_at":"2026-01-01T00:00:03.000Z"
                }
            ],
            "analysis_id":"an-1",
            "recommendation_id":"rec-1"
        }
        """

        return json.data(using: .utf8)!
    }
}
