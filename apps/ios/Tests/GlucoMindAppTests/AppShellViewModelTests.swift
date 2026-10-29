import XCTest
@testable import GlucoMindApp
@testable import GlucoMindCore

@MainActor
final class AppShellViewModelTests: XCTestCase {
    func testRefreshDataLoadsPendingAndHistorySections() async {
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: RoutingHTTPClient()
        )

        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()

        XCTAssertEqual(model.pendingConversationID, "conv-pending")
        XCTAssertEqual(model.pendingQuestions.count, 2)
        XCTAssertEqual(model.pendingQuestions.map(\.question_id), ["q-duplicate-2", "q-duplicate-1"])
        XCTAssertEqual(Set(model.pendingQuestions.map(\.id)).count, 2)
        XCTAssertFalse(model.historySections.isEmpty)
        XCTAssertTrue(model.allConversationIDs.contains("conv-user-history"))
        XCTAssertFalse(model.allConversationIDs.contains("conv-system-pending"))
        XCTAssertEqual(model.historySections.first?.entries.first?.origin, .user)
        XCTAssertEqual(model.historySections.first?.entries.first?.triggerType, ConversationTriggerType.none)
    }

    func testPendingQuestionsSectionExpandsForNewQuestionsAndKeepsUserCollapse() {
        var state = PendingQuestionsPresentationState()
        let items = [
            PendingQuestionListItem(
                id: "pending-1",
                investigation_id: "inv-1",
                state: "QUESTION_PENDING",
                question_id: "q-1",
                question_text: "Czy przed spadkiem była aktywność fizyczna?",
                question_type: "CONTEXT_QUESTION",
                conversation_id: "conv-1",
                event_id: "evt-1",
                created_at: "2026-10-06T08:01:00.000Z",
                status: "OPEN",
                origin: "SYSTEM",
                conversation_type: "TRIGGER_INITIATED",
                trigger_type: "HYPO_DETECTED"
            ),
            PendingQuestionListItem(
                id: "pending-2",
                investigation_id: "inv-2",
                state: "QUESTION_PENDING",
                question_id: "q-2",
                question_text: "Czy przed spadkiem była aktywność fizyczna?",
                question_type: "CONTEXT_QUESTION",
                conversation_id: "conv-2",
                event_id: "evt-2",
                created_at: "2026-10-06T08:02:00.000Z",
                status: "OPEN",
                origin: "SYSTEM",
                conversation_type: "TRIGGER_INITIATED",
                trigger_type: "HYPO_DETECTED"
            ),
        ]

        XCTAssertFalse(state.isExpanded)
        state.reconcile(with: [])
        XCTAssertFalse(state.isExpanded)

        // A new question is shown without an extra tap.
        state.reconcile(with: [items[0]])
        XCTAssertTrue(state.isExpanded)
        XCTAssertEqual(state.visibleQuestions(from: [items[0]]).count, 1)

        // The user's collapse is kept while nothing new arrives…
        state.toggle()
        state.reconcile(with: [items[0]])
        XCTAssertFalse(state.isExpanded)

        // …and a further new question expands the section again.
        state.reconcile(with: items)
        XCTAssertTrue(state.isExpanded)
        XCTAssertEqual(Set(state.visibleQuestions(from: items).map(\.id)).count, 2)
    }

    func testRefreshDataFiltersNonSystemPendingQuestions() async {
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: PendingQuestionOriginFilterHTTPClient()
        )

        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()

        XCTAssertEqual(model.pendingQuestions.count, 1)
        XCTAssertEqual(model.pendingQuestions.first?.origin, "SYSTEM")
        XCTAssertEqual(model.pendingQuestions.first?.conversation_id, "conv-system-pending")
    }

    func testAnsweredSystemPendingQuestionMovesFromPendingToHistory() async {
        let http = PendingQuestionResolutionHTTPClient()
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: http
        )

        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()

        XCTAssertEqual(model.pendingQuestions.count, 1)
        XCTAssertFalse(model.allConversationIDs.contains("conv-system-pending"))

        _ = try? await api.postAnswer(
            patientID: "patient-1",
            conversationID: "conv-system-pending",
            questionID: "q-system-1",
            answer: MessageAnswer(type: .yes),
            idempotencyKey: UUID().uuidString.lowercased()
        )

        await model.refreshData()

        XCTAssertEqual(model.pendingQuestions.count, 0)
        XCTAssertTrue(model.allConversationIDs.contains("conv-system-pending"))
    }

    func testHistoryFailureProducesError() async {
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: FailingHistoryHTTPClient()
        )

        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()

        XCTAssertEqual(model.historyError, "Nie udało się wczytać historii rozmów")
        XCTAssertTrue(model.historySections.isEmpty)
    }

    func testAnOlderSlowerHistoryDoesNotOverwriteTheNewerOne() async {
        let http = OrderedHistoryHTTPClient()
        let api = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: StubAuthProvider(), httpClient: http)
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")

        // The first list (read before a delete) is slow; the second (after it) comes back first.
        http.lists = [["conv-kept", "conv-deleted"], ["conv-kept"]]
        http.holdFirstList = true
        let older = Task { await model.refreshData() }
        while http.listRequests < 1 { await Task.yield() }
        await model.refreshData()
        XCTAssertEqual(model.allConversationIDs, ["conv-kept"])
        XCTAssertFalse(model.isLoadingHistory, "the loading state follows the newest refresh")

        http.releaseFirstList()
        await older.value

        XCTAssertEqual(model.allConversationIDs, ["conv-kept"])
        XCTAssertFalse(model.isLoadingHistory)
        XCTAssertNil(model.historyError)
    }

    func testACancelledRefreshKeepsTheHistoryWithoutAnError() async {
        let http = OrderedHistoryHTTPClient()
        let api = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: StubAuthProvider(), httpClient: http)
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        http.lists = [["conv-kept"]]
        await model.refreshData()

        http.cancelLists = true
        await model.refreshData()

        XCTAssertNil(model.historyError)
        XCTAssertEqual(model.allConversationIDs, ["conv-kept"])
        XCTAssertTrue(model.isHistoryLoaded)
    }

    func testACancelledFirstRefreshDoesNotCountAsAReadHistory() async {
        let http = OrderedHistoryHTTPClient()
        http.cancelLists = true
        let api = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: StubAuthProvider(), httpClient: http)
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")

        await model.refreshData()

        XCTAssertNil(model.historyError)
        XCTAssertFalse(model.isHistoryLoaded)
    }

    func testUserMessageComposerBehaviorAcrossGenericAndInvestigationStates() async {
        let api = ComposerBehaviorHTTPClient()
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: api
        )
        let model = ConversationViewModel(
            apiClient: client,
            patientID: "patient-1",
            conversationID: "conv-user",
            pollInterval: .milliseconds(1)
        )

        await model.loadConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertTrue(model.canSendUserMessage)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .userMessage = item { return true }
            return false
        })

        model.userMessageText = "   "
        await model.submitUserMessage()
        XCTAssertEqual(api.userMessagePostCount, 0)

        model.userMessageText = "Can you explain this trend?"
        async let firstSubmit: Void = model.submitUserMessage()
        try? await Task.sleep(for: .milliseconds(10))
        XCTAssertEqual(model.processingState, .sending)
        XCTAssertFalse(model.canSendUserMessage)

        model.userMessageText = "Second message should not post while busy"
        await model.submitUserMessage()

        _ = await firstSubmit
        XCTAssertEqual(api.userMessagePostCount, 1)
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertNil(model.statusMessage)

        await model.selectConversation("conv-investigation", forceReload: true)
        XCTAssertFalse(model.canSendUserMessage)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .question = item { return true }
            return false
        })

        await model.submitAnswer(.yes)
        XCTAssertEqual(api.answerPostCount, 1)
    }

    func testCreateConversationCallsEndpointAndReturnsConversationID() async throws {
        let http = CreateConversationHTTPClient()
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: http
        )
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")

        let conversationID = try await model.createConversation()

        XCTAssertEqual(conversationID, "conv-created-1")
        XCTAssertEqual(http.createConversationCallCount, 1)
        XCTAssertEqual(http.lastCreateConversationPath, "/v1/patients/patient-1/conversations")
        XCTAssertNotNil(http.lastCreateIdempotencyKey)
        XCTAssertFalse(http.lastCreateIdempotencyKey?.isEmpty ?? true)

        let secondConversationID = try await model.createConversation()
        XCTAssertEqual(secondConversationID, "conv-created-2")
        XCTAssertEqual(http.createConversationCallCount, 2)
        XCTAssertEqual(http.capturedCreateIdempotencyKeys.count, 2)
        XCTAssertNotEqual(http.capturedCreateIdempotencyKeys[0], http.capturedCreateIdempotencyKeys[1])
    }

    func testConcurrentCreateConversationDoesNotSendSecondRequest() async {
        let http = SlowCreateConversationHTTPClient()
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: http
        )
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")

        async let first = model.createConversation()
        try? await Task.sleep(for: .milliseconds(10))
        async let second = model.createConversation()

        _ = try? await first
        _ = try? await second

        XCTAssertEqual(http.createConversationCallCount, 1)
    }

    func testRefreshDataReadsOnlyTheListWithoutPerConversationRequests() async {
        let http = UserHistoryProgressHTTPClient()
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: http
        )

        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()

        XCTAssertEqual(model.allConversationIDs.count, 5)
        XCTAssertEqual(http.conversationDetailRequestCount, 0)
    }

    func testStaleSelectionFallsBackToTheWaitingQuestionThenTheLatest() {
        func resolve(pending: String?) -> String? {
            ConversationSelectionResolver.resolve(
                selectedConversationID: "conv-stale",
                openedFromNotification: nil,
                knownConversationIDs: ["conv-user-history"],
                historyLoaded: true,
                pendingConversationID: pending,
                firstConversationID: "conv-user-history"
            )
        }

        XCTAssertEqual(resolve(pending: nil), "conv-user-history")
        XCTAssertEqual(resolve(pending: "conv-pending"), "conv-pending")
    }

    func testConversationOpenedFromANotificationStaysEvenWhenTheListsDoNotHaveIt() {
        // An old conversation from the bell, or a deleted one (its screen says so instead of showing another one).
        let result = ConversationSelectionResolver.resolve(
            selectedConversationID: "conv-old",
            openedFromNotification: "conv-old",
            knownConversationIDs: ["conv-user-history"],
            historyLoaded: true,
            pendingConversationID: nil,
            firstConversationID: "conv-user-history"
        )

        XCTAssertEqual(result, "conv-old")
    }

    func testWaitingQuestionsCountAsKnownConversations() async {
        let api = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: RoutingHTTPClient()
        )
        let model = AppShellViewModel(apiClient: api, patientID: "patient-1")
        await model.refreshData()
        let questionConversation = try? XCTUnwrap(model.pendingQuestions.first?.conversation_id)

        // A question's conversation is left out of the history (the drawer lists it apart) but stays selected: a
        // second waiting hypo question opened from its push used to fall back to another conversation.
        XCTAssertTrue(model.isHistoryLoaded)
        XCTAssertFalse(model.allConversationIDs.contains(questionConversation ?? ""))
        XCTAssertTrue(model.knownConversationIDs.contains(questionConversation ?? "-"))
        XCTAssertEqual(
            ConversationSelectionResolver.resolve(
                selectedConversationID: questionConversation,
                openedFromNotification: nil,
                knownConversationIDs: model.knownConversationIDs,
                historyLoaded: model.isHistoryLoaded,
                pendingConversationID: model.pendingConversationID,
                firstConversationID: model.firstConversationID
            ),
            questionConversation
        )
    }

    func testSelectionStaysWhenTheHistoryCouldNotBeRead() {
        let result = ConversationSelectionResolver.resolve(
            selectedConversationID: "conv-a",
            openedFromNotification: nil,
            knownConversationIDs: [],
            historyLoaded: false,
            pendingConversationID: nil,
            firstConversationID: nil
        )

        XCTAssertEqual(result, "conv-a")
    }
}

private final class StaleRouteHTTPClient: HTTPClient {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""

        if path.contains("pending-investigation") {
            let payload = """
            {
              "patient_id":"patient-1",
              "pending_investigation":null
            }
            """.data(using: .utf8)!
            return (payload, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }

        if path.contains("pending-questions") {
            let payload = """
            {
              "patient_id":"patient-1",
              "items":[]
            }
            """.data(using: .utf8)!
            return (payload, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }

        if path == "/v1/patients/patient-1/conversations" && request.httpMethod == "GET" {
            let payload = """
            {
              "patient_id":"patient-1",
              "items":[
                {
                  "id":"conv-user-history",
                  "patient_id":"patient-1",
                  "episode_id":null,
                  "trigger_id":null,
                  "origin":"USER",
                  "trigger_type":null,
                  "thread_state_version":"conv-v1",
                  "awaiting_user_answer":false,
                  "conversation_type":"USER_INITIATED",
                  "workflow_status":"ACTIVE",
                  "analysis_id":null,
                  "recommendation_id":null,
                  "created_at":"2026-10-06T08:04:00.000Z",
                  "updated_at":"2026-10-06T08:05:00.000Z"
                }
              ],
              "next_cursor":null
            }
            """.data(using: .utf8)!
            return (payload, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }

        return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
}

private struct StubAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "token" }
}

private final class RoutingHTTPClient: HTTPClient {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""

        if path.contains("pending-investigation") {
            let payload = """
            {
              "patient_id":"patient-1",
              "pending_investigation":{
                "investigation_id":"inv-1",
                "state":"QUESTION_PENDING",
                "question":"Was there activity?",
                "question_id":"activity_before_drop",
                "conversation_id":"conv-pending",
                "event_id":"evt-1"
              }
            }
            """.data(using: .utf8)!
            return (payload, response(for: request, status: 200))
        }

                if path.contains("pending-questions") {
                        let payload = """
                        {
                            "patient_id":"patient-1",
                            "items":[
                                {
                                    "id":"pending-q-2",
                                    "investigation_id":"inv-2",
                                    "state":"QUESTION_PENDING",
                                    "question_id":"q-duplicate-2",
                                    "question_text":"Czy przed spadkiem była aktywność fizyczna?",
                                    "question_type":"CONTEXT_QUESTION",
                                    "conversation_id":"conv-system-pending",
                                    "event_id":"evt-2",
                                    "created_at":"2026-10-06T08:03:00.000Z",
                                    "status":"OPEN",
                                    "origin":"SYSTEM",
                                    "conversation_type":"TRIGGER_INITIATED",
                                    "trigger_type":"HYPO_DETECTED"
                                },
                                {
                                    "id":"pending-q-1",
                                    "investigation_id":"inv-1",
                                    "state":"QUESTION_PENDING",
                                    "question_id":"q-duplicate-1",
                                    "question_text":"Czy przed spadkiem była aktywność fizyczna?",
                                    "question_type":"CONTEXT_QUESTION",
                                    "conversation_id":"conv-system-pending-2",
                                    "event_id":"evt-1",
                                    "created_at":"2026-10-06T08:01:00.000Z",
                                    "status":"OPEN",
                                    "origin":"SYSTEM",
                                    "conversation_type":"TRIGGER_INITIATED",
                                    "trigger_type":"HYPO_DETECTED"
                                }
                            ]
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
            let payload = """
            {
              "patient_id":"patient-1",
              "items":[
                {
                                    "id":"conv-user-history",
                  "patient_id":"patient-1",
                                    "episode_id":null,
                                    "trigger_id":null,
                                    "origin":"USER",
                                    "trigger_type":null,
                  "thread_state_version":"conv-v1",
                                    "awaiting_user_answer":false,
                                    "conversation_type":"USER_INITIATED",
                                    "workflow_status":"ACTIVE",
                                    "analysis_id":null,
                                    "recommendation_id":null,
                                    "created_at":"2026-10-06T08:04:00.000Z",
                                    "updated_at":"2026-10-06T08:05:00.000Z"
                                },
                                {
                                    "id":"conv-system-pending",
                                    "patient_id":"patient-1",
                                    "episode_id":"ep-1",
                                    "trigger_id":"tr-1",
                                    "origin":"SYSTEM",
                                    "trigger_type":"HYPO_DETECTED",
                                    "thread_state_version":"conv-v1",
                                    "awaiting_user_answer":true,
                                    "conversation_type":"TRIGGER_INITIATED",
                                    "workflow_status":"QUESTION_PENDING",
                  "analysis_id":null,
                  "recommendation_id":null,
                  "created_at":"2026-10-06T08:00:00.000Z",
                  "updated_at":"2026-10-06T08:02:00.000Z"
                }
              ],
              "next_cursor":null
            }
            """.data(using: .utf8)!
            return (payload, response(for: request, status: 200))
        }

        return (Data(), response(for: request, status: 404))
    }

    private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

private final class PendingQuestionOriginFilterHTTPClient: HTTPClient {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let path = request.url?.path ?? ""

                if path.contains("pending-investigation") {
                        let payload = """
                        {"patient_id":"patient-1","pending_investigation":null}
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path.contains("pending-questions") {
                        let payload = """
                        {
                            "patient_id":"patient-1",
                            "items":[
                                {
                                    "id":"pending-system-1",
                                    "investigation_id":"inv-system",
                                    "state":"QUESTION_PENDING",
                                    "question_id":"q-system-1",
                                    "question_text":"Czy przed spadkiem była aktywność fizyczna?",
                                    "question_type":"CONTEXT_QUESTION",
                                    "conversation_id":"conv-system-pending",
                                    "event_id":"evt-system",
                                    "created_at":"2026-10-06T08:03:00.000Z",
                                    "status":"OPEN",
                                    "origin":"SYSTEM",
                                    "conversation_type":"TRIGGER_INITIATED",
                                    "trigger_type":"HYPO_DETECTED"
                                },
                                {
                                    "id":"pending-user-1",
                                    "investigation_id":"inv-user",
                                    "state":"QUESTION_PENDING",
                                    "question_id":"q-user-1",
                                    "question_text":"Czy przed spadkiem była aktywność fizyczna?",
                                    "question_type":"CONTEXT_QUESTION",
                                    "conversation_id":"conv-user-pending",
                                    "event_id":null,
                                    "created_at":"2026-10-06T08:02:00.000Z",
                                    "status":"OPEN",
                                    "origin":"USER",
                                    "conversation_type":"USER_INITIATED",
                                    "trigger_type":null
                                }
                            ]
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
                        let payload = """
                        {
                            "patient_id":"patient-1",
                            "items":[
                                {
                                    "id":"conv-user-history",
                                    "patient_id":"patient-1",
                                    "episode_id":null,
                                    "trigger_id":null,
                                    "origin":"USER",
                                    "trigger_type":null,
                                    "thread_state_version":"conv-v1",
                                    "awaiting_user_answer":false,
                                    "conversation_type":"USER_INITIATED",
                                    "workflow_status":"ACTIVE",
                                    "analysis_id":null,
                                    "recommendation_id":null,
                                    "created_at":"2026-10-06T08:01:00.000Z",
                                    "updated_at":"2026-10-06T08:02:00.000Z"
                                }
                            ],
                            "next_cursor":null
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations/conv-user-history", request.httpMethod == "GET" {
                        let payload = """
                        {
                                "id":"conv-user-history",
                                "patient_id":"patient-1",
                                "origin":"USER",
                                "trigger_type":null,
                                "conversation_type":"USER_INITIATED",
                                "workflow_status":"ACTIVE",
                                "awaiting_user_answer":false,
                                "pending_question":null,
                                "messages":[
                                        {
                                                "id":"msg-user-1",
                                                "role":"USER",
                                                "message_type":"USER_MESSAGE",
                                                "content":"Co oznacza trend glikemii?",
                                                "question_id":null,
                                                "answer_type":null,
                                                "answer_text":null,
                                                "created_at":"2026-10-06T08:01:01.000Z"
                                        },
                                        {
                                                "id":"msg-assistant-1",
                                                "role":"ASSISTANT",
                                                "message_type":"ASSISTANT_MESSAGE",
                                                "content":"Wyjasniam trend.",
                                                "question_id":null,
                                                "answer_type":null,
                                                "answer_text":null,
                                                "created_at":"2026-10-06T08:01:05.000Z"
                                        }
                                ],
                                "analysis_id":null,
                                "recommendation_id":null
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                return (Data(), response(for: request, status: 404))
        }

        private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
}

private final class PendingQuestionResolutionHTTPClient: HTTPClient {
        private var answered = false

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let path = request.url?.path ?? ""

                if path.contains("pending-investigation") {
                        let payload = answered
                        ? "{\"patient_id\":\"patient-1\",\"pending_investigation\":null}"
                                : """
                                {
                                    "patient_id":"patient-1",
                                    "pending_investigation":{
                                        "investigation_id":"inv-1",
                                        "state":"QUESTION_PENDING",
                                        "question":"Was there activity?",
                                        "question_id":"q-system-1",
                                        "conversation_id":"conv-system-pending",
                                        "event_id":"evt-1"
                                    }
                                }
                                """
                        return (payload.data(using: .utf8)!, response(for: request, status: 200))
                }

                if path.contains("pending-questions") {
                        let payload = answered
                        ? "{\"patient_id\":\"patient-1\",\"items\":[]}"
                                : """
                                {
                                    "patient_id":"patient-1",
                                    "items":[
                                        {
                                            "id":"pending-system-1",
                                            "investigation_id":"inv-system",
                                            "state":"QUESTION_PENDING",
                                            "question_id":"q-system-1",
                                            "question_text":"Czy przed spadkiem była aktywność fizyczna?",
                                            "question_type":"CONTEXT_QUESTION",
                                            "conversation_id":"conv-system-pending",
                                            "event_id":"evt-system",
                                            "created_at":"2026-10-06T08:03:00.000Z",
                                            "status":"OPEN",
                                            "origin":"SYSTEM",
                                            "conversation_type":"TRIGGER_INITIATED",
                                            "trigger_type":"HYPO_DETECTED"
                                        }
                                    ]
                                }
                                """
                        return (payload.data(using: .utf8)!, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
                        let payload = answered
                                ? """
                                {
                                    "patient_id":"patient-1",
                                    "items":[
                                        {
                                            "id":"conv-system-pending",
                                            "patient_id":"patient-1",
                                            "episode_id":"ep-1",
                                            "trigger_id":"tr-1",
                                            "origin":"SYSTEM",
                                            "trigger_type":"HYPO_DETECTED",
                                            "thread_state_version":"conv-v1",
                                            "awaiting_user_answer":false,
                                            "conversation_type":"TRIGGER_INITIATED",
                                            "workflow_status":"RECOMMENDATION_READY",
                                            "analysis_id":"analysis-1",
                                            "recommendation_id":"rec-1",
                                            "created_at":"2026-10-06T08:00:00.000Z",
                                            "updated_at":"2026-10-06T08:05:00.000Z"
                                        }
                                    ],
                                    "next_cursor":null
                                }
                                """
                                : """
                                {
                                    "patient_id":"patient-1",
                                    "items":[],
                                    "next_cursor":null
                                }
                                """
                        return (payload.data(using: .utf8)!, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations/conv-system-pending/messages", request.httpMethod == "POST" {
                        answered = true
                        let payload = """
                        {
                                "message": {
                                        "id":"answer-1",
                                        "role":"USER",
                                        "message_type":"CONTEXT_ANSWER",
                                        "content":"YES",
                                        "question_id":"q-system-1",
                                        "answer_type":"YES",
                                        "answer_text":null,
                                        "created_at":"2026-10-06T08:04:00.000Z"
                                },
                                "conversation": {
                                        "id":"conv-system-pending",
                                        "patient_id":"patient-1",
                                        "origin":"SYSTEM",
                                        "trigger_type":"HYPO_DETECTED",
                                        "conversation_type":"TRIGGER_INITIATED",
                                        "workflow_status":"ANALYSIS_RUNNING",
                                        "awaiting_user_answer":false,
                                        "pending_question":null,
                                        "messages":[],
                                        "analysis_id":null,
                                        "recommendation_id":null
                                },
                                "decision":"ANSWER_ACCEPTED"
                        }
                        """.data(using: .utf8)!

                        return (payload, response(for: request, status: 200))
                }

                return (Data(), response(for: request, status: 404))
        }

        private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
}

private final class FailingHistoryHTTPClient: HTTPClient {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""

        if path.contains("pending-investigation") {
            let payload = """
            {"patient_id":"patient-1","pending_investigation":null}
            """.data(using: .utf8)!
            return (payload, response(for: request, status: 200))
        }

        if path.contains("/conversations") {
            let payload = """
            {
              "type":"https://api.example.com/problems/server",
              "title":"Server error",
              "status":500,
              "code":"SERVER_ERROR"
            }
            """.data(using: .utf8)!
            return (payload, response(for: request, status: 500))
        }

        return (Data(), response(for: request, status: 404))
    }

    private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

private final class CreateConversationHTTPClient: HTTPClient {
        private(set) var createConversationCallCount = 0
        private(set) var lastCreateIdempotencyKey: String?
        private(set) var lastCreateConversationPath: String?
    private(set) var capturedCreateIdempotencyKeys: [String] = []

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let path = request.url?.path ?? ""

                if path.contains("pending-investigation") {
                        let payload = """
                        {"patient_id":"patient-1","pending_investigation":null}
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "POST" {
                        createConversationCallCount += 1
                        lastCreateIdempotencyKey = request.value(forHTTPHeaderField: "Idempotency-Key")
                        lastCreateConversationPath = path
                        if let lastCreateIdempotencyKey {
                                capturedCreateIdempotencyKeys.append(lastCreateIdempotencyKey)
                        }

                        let payload = """
                        {
                            "conversation": {
                                "id":"conv-created-\(createConversationCallCount)",
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
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 201))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
                        let payload = """
                        {
                            "patient_id":"patient-1",
                            "items":[],
                            "next_cursor":null
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                return (Data(), response(for: request, status: 404))
        }

        private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
}

@MainActor
private final class SlowCreateConversationHTTPClient: HTTPClient {
        private(set) var createConversationCallCount = 0

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let path = request.url?.path ?? ""

                if path.contains("pending-investigation") {
                        let payload = """
                        {"patient_id":"patient-1","pending_investigation":null}
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "POST" {
                        createConversationCallCount += 1
                        try await Task.sleep(for: .milliseconds(80))

                        let payload = """
                        {
                            "conversation": {
                                "id":"conv-created-slow",
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
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 201))
                }

                if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
                        let payload = """
                        {
                            "patient_id":"patient-1",
                            "items":[],
                            "next_cursor":null
                        }
                        """.data(using: .utf8)!
                        return (payload, response(for: request, status: 200))
                }

                return (Data(), response(for: request, status: 404))
        }

        private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
}

private final class UserHistoryProgressHTTPClient: HTTPClient {
    private(set) var conversationDetailRequestCount = 0

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""

        if path.contains("pending-investigation") {
            return (Data(#"{"patient_id":"patient-1","pending_investigation":null}"#.utf8), response(for: request, status: 200))
        }

        if path.contains("pending-questions") {
            return (Data(#"{"patient_id":"patient-1","items":[]}"#.utf8), response(for: request, status: 200))
        }

        if path == "/v1/patients/patient-1/conversations", request.httpMethod == "GET" {
            func item(_ id: String, _ minute: Int, _ status: String?) -> String {
                let activity = status.map { #","activity_status":"\#($0)","activity_checked_at":"2026-10-06T08:10:00.000Z""# } ?? ""
                return """
                {"id":"\(id)","patient_id":"patient-1","episode_id":null,"trigger_id":null,"origin":"USER","trigger_type":null,
                 "thread_state_version":"conv-v1","awaiting_user_answer":false,"conversation_type":"USER_INITIATED",
                 "workflow_status":"ACTIVE","analysis_id":null,"recommendation_id":null,
                 "created_at":"2026-10-06T08:0\(minute):00.000Z","updated_at":"2026-10-06T08:0\(minute):30.000Z"\(activity)}
                """
            }
            let items = [
                item("conv-user-pending", 0, "PROCESSING"),
                item("conv-user-complete", 1, "COMPLETED"),
                item("conv-user-failed", 2, "FAILED"),
                item("conv-user-cancelled", 3, "CANCELLED"),
                item("conv-user-legacy", 4, nil),
            ].joined(separator: ",")
            return (Data(#"{"patient_id":"patient-1","items":[\#(items)],"next_cursor":null}"#.utf8), response(for: request, status: 200))
        }

        if path.hasPrefix("/v1/patients/patient-1/conversations/") {
            conversationDetailRequestCount += 1
        }
        return (Data(), response(for: request, status: 404))
    }

    private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

@MainActor
private final class ComposerBehaviorHTTPClient: HTTPClient {
        private enum UserConversationStage {
                case baseline
                case submittedQueued
                case submittedResponded
        }

        private var userStage: UserConversationStage = .baseline
        private var emittedQueuedSnapshot = false
        private(set) var userMessagePostCount = 0
        private(set) var answerPostCount = 0

        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let path = request.url?.path ?? ""

                if path.contains("/conversations/conv-user") && request.httpMethod == "GET" {
                        let data: Data
                        switch userStage {
                        case .baseline:
                                data = Self.userConversationBaseline()
                        case .submittedQueued:
                                if emittedQueuedSnapshot {
                                        userStage = .submittedResponded
                                        data = Self.userConversationResponded()
                                } else {
                                        emittedQueuedSnapshot = true
                                        data = Self.userConversationQueued()
                                }
                        case .submittedResponded:
                                data = Self.userConversationResponded()
                        }
                        return (data, response(for: request, status: 200))
                }

                if path.contains("/conversations/conv-investigation") && request.httpMethod == "GET" {
                        return (Self.investigationConversationPendingQuestion(), response(for: request, status: 200))
                }

                if path.contains("/conversations/conv-user/messages") && request.httpMethod == "POST" {
                        let body = request.httpBody ?? Data()
                        let payload = try JSONDecoder().decode(UserMessageSubmissionRequest.self, from: body)
                        if payload.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                let problem = """
                                {"type":"https://api.example.com/problems/validation","title":"Validation error","status":422,"code":"VALIDATION_ERROR"}
                                """.data(using: .utf8)!
                                return (problem, response(for: request, status: 422))
                        }

                        userMessagePostCount += 1
                        try await Task.sleep(for: .milliseconds(60))
                        userStage = .submittedQueued
                        emittedQueuedSnapshot = false
                        return (Self.userMessageSubmissionResponse(), response(for: request, status: 200))
                }

                if path.contains("/conversations/conv-investigation/messages") && request.httpMethod == "POST" {
                        answerPostCount += 1
                        return (Self.answerSubmissionResponse(), response(for: request, status: 200))
                }

                return (Data(), response(for: request, status: 404))
        }

        private func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }

        private static func userConversationBaseline() -> Data {
                """
                {
                    "id":"conv-user",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-seed-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Hello",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"assistant-seed-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Hi",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:01.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """.data(using: .utf8)!
        }

        private static func userConversationQueued() -> Data {
                """
                {
                    "id":"conv-user",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-seed-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Hello",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"user-new-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Can you explain this trend?",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:01:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """.data(using: .utf8)!
        }

        private static func userConversationResponded() -> Data {
                """
                {
                    "id":"conv-user",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"user-seed-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Hello",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        },
                        {
                            "id":"user-new-1",
                            "role":"USER",
                            "message_type":"USER_MESSAGE",
                            "content":"Can you explain this trend?",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:01:00.000Z"
                        },
                        {
                            "id":"assistant-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"This looks stable over the last hour.",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:01:05.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """.data(using: .utf8)!
        }

        private static func investigationConversationPendingQuestion() -> Data {
                """
                {
                    "id":"conv-investigation",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":true,
                    "pending_question":{
                        "question_id":"q-1",
                        "question_type":"CONTEXT_QUESTION",
                        "question_text":"Was there activity?",
                        "expected_answer_types":["YES","NO","UNKNOWN","TEXT"],
                        "reason":"missing context",
                        "expected_information_gain":"HIGH",
                        "status":"OPEN",
                        "created_at":"2026-01-01T00:00:00.000Z"
                    },
                    "messages":[
                        {
                            "id":"assistant-q-1",
                            "role":"ASSISTANT",
                            "message_type":"CONTEXT_QUESTION",
                            "content":"Was there activity before the drop?",
                            "question_id":"q-1",
                            "answer_type":null,
                            "answer_text":null,
                            "created_at":"2026-01-01T00:00:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """.data(using: .utf8)!
        }

        private static func userMessageSubmissionResponse() -> Data {
                """
                {
                    "message": {
                        "id":"user-new-1",
                        "role":"USER",
                        "message_type":"USER_MESSAGE",
                        "content":"Can you explain this trend?",
                        "question_id":null,
                        "answer_type":null,
                        "answer_text":null,
                        "created_at":"2026-01-01T00:01:00.000Z"
                    },
                    "conversation": {
                        "id":"conv-user",
                        "patient_id":"patient-1",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[
                            {
                                "id":"user-seed-1",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Hello",
                                "question_id":null,
                                "answer_type":null,
                                "answer_text":null,
                                "created_at":"2026-01-01T00:00:00.000Z"
                            },
                            {
                                "id":"user-new-1",
                                "role":"USER",
                                "message_type":"USER_MESSAGE",
                                "content":"Can you explain this trend?",
                                "question_id":null,
                                "answer_type":null,
                                "answer_text":null,
                                "created_at":"2026-01-01T00:01:00.000Z"
                            }
                        ],
                        "analysis_id":null,
                        "recommendation_id":null
                    },
                    "decision":"DIRECT_RESPONSE"
                }
                """.data(using: .utf8)!
        }

        private static func answerSubmissionResponse() -> Data {
                """
                {
                    "message": {
                        "id":"answer-1",
                        "role":"USER",
                        "message_type":"CONTEXT_ANSWER",
                        "content":"YES",
                        "question_id":"q-1",
                        "answer_type":"YES",
                        "answer_text":null,
                        "created_at":"2026-01-01T00:00:05.000Z"
                    },
                    "conversation": {
                        "id":"conv-investigation",
                        "patient_id":"patient-1",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[],
                        "analysis_id":null,
                        "recommendation_id":null
                    },
                    "decision":"ANSWER_RECEIVED"
                }
                """.data(using: .utf8)!
        }
}

/// Conversation lists in order of request; the first can be held back, and lists can fail as cancelled.
@MainActor
private final class OrderedHistoryHTTPClient: HTTPClient {
    var lists: [[String]] = []
    var holdFirstList = false
    var cancelLists = false
    private(set) var listRequests = 0
    private var held: CheckedContinuation<Void, Never>?

    func releaseFirstList() {
        held?.resume()
        held = nil
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path.contains("pending-investigation") {
            return (Data(#"{"patient_id":"patient-1","pending_investigation":null}"#.utf8), response(for: request))
        }
        if path.contains("pending-questions") {
            return (Data(#"{"patient_id":"patient-1","items":[]}"#.utf8), response(for: request))
        }
        if cancelLists {
            throw URLError(.cancelled)
        }
        let index = listRequests
        listRequests += 1
        if index == 0, holdFirstList {
            await withCheckedContinuation { held = $0 }
        }
        let ids = lists[min(index, lists.count - 1)]
        let items = ids.enumerated().map { offset, id in
            """
            {"id":"\(id)","patient_id":"patient-1","episode_id":null,"trigger_id":null,"origin":"USER","trigger_type":null,
             "thread_state_version":"conv-v1","awaiting_user_answer":false,"conversation_type":"USER_INITIATED",
             "workflow_status":"ACTIVE","analysis_id":null,"recommendation_id":null,
             "created_at":"2026-10-06T08:0\(offset):00.000Z","updated_at":"2026-10-06T08:0\(offset):30.000Z"}
            """
        }.joined(separator: ",")
        return (Data(#"{"patient_id":"patient-1","items":[\#(items)],"next_cursor":null}"#.utf8), response(for: request))
    }

    private func response(for request: URLRequest) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    }
}
