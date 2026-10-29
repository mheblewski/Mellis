import XCTest
@testable import GlucoMindCore

@MainActor
final class ConversationUXTests: XCTestCase {
    func testToolStepIsReportedAsToolUseWithItsLabelAndBackendStartTime() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.conversationJSON(
            id: "conv-a",
            messages: [UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?")],
            processing: """
            {"status":"PROCESSING",
             "current_step":\(UXStubAPI.step(type: "REQUESTING_EVIDENCE", status: "STARTED", label: "Sprawdzam insulinę", startedAt: "2026-10-08T06:30:05.000Z")),
             "steps":[\(UXStubAPI.step(type: "ANALYZING_REQUEST", status: "SUCCEEDED", label: "Analizuję pytanie", startedAt: "2026-10-08T06:30:00.000Z")),
                      \(UXStubAPI.step(type: "REQUESTING_EVIDENCE", status: "STARTED", label: "Sprawdzam insulinę", startedAt: "2026-10-08T06:30:05.000Z"))]}
            """
        )
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))

        await model.loadConversation()

        let activity = try? XCTUnwrap(model.agentActivity)
        XCTAssertEqual(activity?.phase, .usingTool)
        XCTAssertEqual(activity?.title, "Pobieram dane")
        XCTAssertEqual(activity?.detail, "Sprawdzam insulinę")
        XCTAssertEqual(activity?.headline, "Sprawdzam insulinę")
        XCTAssertEqual(activity?.startedAt, ISO8601DateFormatter().date(from: "2026-10-08T06:30:00Z"))
        XCTAssertEqual(activity?.isActive, true)
    }

    func testAcceptedMessageWithoutBackendStepOnlySaysItIsWaiting() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.conversationJSON(
            id: "conv-a",
            messages: [UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?")]
        )
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))

        await model.loadConversation()

        XCTAssertEqual(model.agentActivity?.phase, .waiting)
        XCTAssertEqual(model.agentActivity?.title, "Czekam na rozpoczęcie analizy")
        XCTAssertNil(model.agentActivity?.detail)
    }

    func testFailedSendKeepsConversationVisibleAndTextForRetry() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        api.postStatus = 500
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        model.userMessageText = "Co z kolacją?"
        await model.submitUserMessage()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.userMessageText, "Co z kolacją?")
        XCTAssertFalse(model.timelineItems.contains { if case .localEcho = $0 { return true }; return false })
        XCTAssertEqual(model.agentActivity?.phase, .failed)
        XCTAssertEqual(model.agentActivity?.title, "Nie udało się wysłać wiadomości. Treść została zachowana.")
        XCTAssertTrue(model.canSendUserMessage)

        await model.retryAfterError()
        XCTAssertNil(model.agentActivity)
    }

    func testAnEditedResendAfterAFailedSendDoesNotDuplicateAMessageThatLanded() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        api.postStatus = 500
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()
        model.userMessageText = "Co z kolacja?"
        await model.submitUserMessage()
        XCTAssertEqual(api.messagePostKeys.count, 1)

        // The server stored it despite the error; the caregiver fixes a typo and sends again.
        let now = ISO8601DateFormatter().string(from: Date())
        api.conversations["conv-a"] = UXStubAPI.conversationJSON(id: "conv-a", messages: [
            UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?"),
            #"{"id":"u-2","role":"USER","message_type":"USER_MESSAGE","content":"Co z kolacja?","created_at":"\#(now)"}"#,
        ])
        api.postStatus = 200
        model.userMessageText = "Co z kolacją?"
        await model.submitUserMessage()

        XCTAssertEqual(api.messagePostKeys.count, 1, "the edit is not sent: the first version landed")
        XCTAssertEqual(model.userMessageText, "Co z kolacją?")
        XCTAssertEqual(model.agentActivity?.title, "Poprzednia wersja wiadomości dotarła i dostanie odpowiedź. Wyślij poprawioną jeszcze raz, jeśli nadal jej potrzebujesz.")
    }

    func testBackgroundRefreshFailureKeepsLoadedConversation() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        api.getStatus = 503
        await model.refreshActiveConversation()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertNotNil(model.conversation)
        XCTAssertEqual(model.agentActivity?.phase, .failed)
    }

    func testUnsentDraftSurvivesSwitchingConversations() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        api.conversations["conv-b"] = UXStubAPI.answeredConversation(id: "conv-b")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))

        await model.selectConversation("conv-a")
        model.userMessageText = "Niedokończone pytanie"
        await model.selectConversation("conv-b")
        XCTAssertEqual(model.userMessageText, "")

        await model.selectConversation("conv-a")
        XCTAssertEqual(model.userMessageText, "Niedokończone pytanie")
    }

    func testCancelIsOfferedOnlyForARunningAnalysisTheServerCanCancel() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        api.conversations["conv-b"] = UXStubAPI.pendingConversation(id: "conv-b", cancellable: false)
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))

        await model.selectConversation("conv-a")
        XCTAssertEqual(model.processingState, .processing)
        XCTAssertEqual(model.cancellableUserMessageID, "u-1")
        XCTAssertTrue(model.canCancelAnalysis)

        await model.selectConversation("conv-b")
        XCTAssertEqual(model.processingState, .processing)
        XCTAssertFalse(model.canCancelAnalysis)

        api.conversations["conv-c"] = UXStubAPI.answeredConversation(id: "conv-c")
        await model.selectConversation("conv-c")
        XCTAssertFalse(model.canCancelAnalysis)
    }

    func testFailedAnalysisOffersRetryThatRequeuesAndWaitsForTheAnswer() async {
        let api = UXStubAPI()
        let failed = #"{"status":"FAILED","current_step":{"type":"FAILED","status":"FAILED","label":"Nie udało się przygotować odpowiedzi"},"steps":[]}"#
        api.conversations["conv-a"] = UXStubAPI.conversationJSON(
            id: "conv-a",
            messages: [UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Co wywołało wzrost?")],
            processing: failed
        )
        api.conversationAfterRetry = UXStubAPI.conversationJSON(id: "conv-a", messages: [
            UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Co wywołało wzrost?"),
            UXStubAPI.message(id: "a-1", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Wzrost po obiedzie.", extra: #","metadata":{"user_message_id":"u-1"}"#),
        ])
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        XCTAssertEqual(model.failedAnalysisUserMessageID, "u-1")
        XCTAssertTrue(model.canRetryFailedAnalysis)
        XCTAssertFalse(model.canRetryFailedSubmission)

        await model.retryFailedAnalysis()

        XCTAssertEqual(api.retryPaths, ["/v1/patients/patient-1/conversations/conv-a/messages/u-1/retry"])
        XCTAssertNil(model.failedAnalysisUserMessageID)
        XCTAssertFalse(model.canRetryFailedAnalysis)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .assistantMessage(let message) = item { return message.id == "a-1" }
            return false
        })
    }

    func testNoAnalysisRetryWhenTheLastMessageIsAnswered() async {
        let api = UXStubAPI()
        api.conversations["conv-c"] = UXStubAPI.answeredConversation(id: "conv-c")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-c", pollInterval: .milliseconds(1))
        await model.loadConversation()
        XCTAssertNil(model.failedAnalysisUserMessageID)
    }

    func testCancelShowsServerConfirmedStateAndKeepsHistory() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.cancelAnalysis()

        XCTAssertEqual(api.cancelPaths, ["/v1/patients/patient-1/conversations/conv-a/messages/u-1/cancel"])
        XCTAssertEqual(model.agentActivity?.phase, .cancelled)
        XCTAssertEqual(model.agentActivity?.title, "Analiza przerwana. Historia rozmowy została zachowana.")
        XCTAssertFalse(model.canCancelAnalysis)
        XCTAssertTrue(model.timelineItems.contains { item in
            if case .userMessage(let message) = item { return message.id == "u-1" && message.isAnalysisCancelled }
            return false
        })

        // After a reload the durable state means "not pending", not "still processing".
        await model.refreshActiveConversation()
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertTrue(model.canSendUserMessage)
    }

    func testCancelThatLostTheRaceReportsItAndDoesNotPretend() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        api.cancelResult = "ALREADY_COMPLETED"
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.cancelAnalysis()

        XCTAssertEqual(model.cancellationNotice, "Odpowiedź była już zapisywana — nie przerwano.")
        XCTAssertNotEqual(model.agentActivity?.phase, .cancelled)
    }

    func testCancelRequestFailureShowsErrorWithRefresh() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        api.cancelStatus = 500
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.cancelAnalysis()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.agentActivity?.phase, .failed)
        XCTAssertEqual(model.agentActivity?.title, "Nie udało się przerwać analizy. Odśwież rozmowę, aby sprawdzić jej stan.")
    }

    func testSendingIsBlockedWhileAnAnalysisRuns() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        model.userMessageText = "Drugie pytanie"
        XCTAssertFalse(model.canSendUserMessage)
        await model.submitUserMessage()
        XCTAssertTrue(api.messagePostKeys.isEmpty)
        XCTAssertEqual(model.userMessageText, "Drugie pytanie")

        await model.cancelAnalysis()
        XCTAssertTrue(model.canSendUserMessage)
    }

    func testRetryAfterNetworkErrorReusesTheIdempotencyKey() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        api.postStatus = 503
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        model.userMessageText = "Co z kolacją?"
        await model.submitUserMessage()
        XCTAssertTrue(model.canRetryFailedSubmission)

        await model.retryFailedSubmission()
        // Pressing "Wyślij" with the unchanged text is the same request too.
        await model.submitUserMessage()
        XCTAssertEqual(api.messagePostKeys.count, 3)
        XCTAssertEqual(Set(api.messagePostKeys).count, 1)

        // Edited text is a new message with a new key.
        model.userMessageText = "Co z kolacją wczoraj?"
        await model.submitUserMessage()
        XCTAssertEqual(Set(api.messagePostKeys).count, 2)
    }

    func testRejectedMessageIsNotOfferedForRetry() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.answeredConversation(id: "conv-a")
        api.postStatus = 422
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        model.userMessageText = "Co z kolacją?"
        await model.submitUserMessage()
        XCTAssertFalse(model.canRetryFailedSubmission)
        XCTAssertEqual(model.agentActivity?.phase, .failed)
    }

    func testCancellationIsConfirmedOnceNotTwice() async {
        let api = UXStubAPI()
        api.conversations["conv-a"] = UXStubAPI.pendingConversation(id: "conv-a", cancellable: true)
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.cancelAnalysis()
        XCTAssertTrue(model.isShowingCancellationConfirmation)
        await model.refreshActiveConversation()
        XCTAssertFalse(model.isShowingCancellationConfirmation)
    }

    func testUnitsDoNotBreakAcrossLines() {
        let prepared = MessageContentSegment.preventUnitBreaks("od 70 do 180 mg/dl, 45 g i 5 godzin")
        XCTAssertEqual(prepared, "od 70 do 180\u{00A0}mg/\u{2060}dl, 45\u{00A0}g i 5 godzin")
    }

    func testMessageContentSplitsFencedCodeAndKeepsText() {
        let segments = MessageContentSegment.parse("Wynik:\n```json\n{\"a\": 1}\n```\nKoniec.")
        XCTAssertEqual(segments, [.text("Wynik:"), .code("{\"a\": 1}"), .text("Koniec.")])
        XCTAssertEqual(MessageContentSegment.parse("Zwykły tekst\n- punkt"), [.text("Zwykły tekst\n- punkt")])
    }

    func testBlockMarkupIsShownAsBulletsAndBoldHeadings() {
        XCTAssertEqual(
            MessageContentSegment.displayBlockMarkup("## Podsumowanie\n- rano: 110\n  * po obiedzie\n#hashtag\n5 - 3"),
            "**Podsumowanie**\n• rano: 110\n  • po obiedzie\n#hashtag\n5 - 3"
        )
    }

    func testElapsedTimeText() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(AgentStatusView.elapsedText(from: start, to: start.addingTimeInterval(7)), "7 s")
        XCTAssertEqual(AgentStatusView.elapsedText(from: start, to: start.addingTimeInterval(125)), "2 min 05 s")
        XCTAssertEqual(AgentStatusView.elapsedText(from: start, to: start.addingTimeInterval(-3)), "0 s")
    }
}

private final class UXStubAPI {
    var conversations: [String: String] = [:]
    var getStatus = 200
    var postStatus = 200
    var cancelStatus = 200
    var cancelResult = "CANCELLED"
    private(set) var cancelPaths: [String] = []
    private(set) var retryPaths: [String] = []
    /// What the conversation looks like once the requeued answer is done (served by the next GET).
    var conversationAfterRetry: String?
    private(set) var messagePostKeys: [String] = []

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: UXClosureHTTPClient { [unowned self] request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path.hasSuffix("/retry") {
                self.retryPaths.append(path)
                let parts = path.split(separator: "/").map(String.init)
                let conversationID = parts[parts.count - 4]
                let inProgress = UXStubAPI.conversationJSON(
                    id: conversationID,
                    messages: [UXStubAPI.message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Co wywołało wzrost?")],
                    processing: #"{"status":"PROCESSING","current_step":{"type":"QUEUED","status":"STARTED","label":"Ponawiam analizę"},"steps":[]}"#
                )
                if let after = self.conversationAfterRetry { self.conversations[conversationID] = after }
                let body = #"{"result":"REQUEUED","message_id":""# + parts[parts.count - 2] + #"","conversation":"# + inProgress + "}"
                return (Data(body.utf8), 200)
            }
            if request.httpMethod == "POST", path.hasSuffix("/cancel") {
                self.cancelPaths.append(path)
                guard self.cancelStatus == 200 else { return (Data("{}".utf8), self.cancelStatus) }
                let parts = path.split(separator: "/").map(String.init)
                let conversationID = parts[parts.count - 4]
                if self.cancelResult == "CANCELLED" {
                    self.conversations[conversationID] = UXStubAPI.pendingConversation(id: conversationID, cancellable: false, cancelled: true)
                }
                let body = """
                {"result":"\(self.cancelResult)","message_id":"\(parts[parts.count - 2])","conversation":\(self.conversations[conversationID] ?? "{}")}
                """
                return (Data(body.utf8), 200)
            }
            if request.httpMethod == "POST" {
                self.messagePostKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
                return (Data("{}".utf8), self.postStatus)
            }
            let id = path.split(separator: "/").last.map(String.init) ?? ""
            guard self.getStatus == 200, let json = self.conversations[id] else {
                return (Data("{}".utf8), self.getStatus == 200 ? 404 : self.getStatus)
            }
            return (Data(json.utf8), 200)
        }
    )

    static func step(type: String, status: String, label: String, startedAt: String) -> String {
        """
        {"execution_id":"exec-1","sequence":1,"type":"\(type)","status":"\(status)","label":"\(label)",
         "tool":null,"detail":null,"time_range":null,"started_at":"\(startedAt)","completed_at":null}
        """
    }

    static func message(id: String, role: String, type: String, content: String, extra: String = "") -> String {
        """
        {"id":"\(id)","role":"\(role)","message_type":"\(type)","content":"\(content)","created_at":"2026-10-08T06:00:00.000Z"\(extra)}
        """
    }

    /// A user message still waiting for its analysis, with the server's cancellation fields.
    static func pendingConversation(id: String, cancellable: Bool, cancelled: Bool = false) -> String {
        let extra = #","analysis_cancellable":\#(cancellable),"response_status":\#(cancelled ? "\"CANCELLED\"" : "null")"#
        return conversationJSON(id: id, messages: [
            message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?", extra: extra),
        ])
    }

    static func conversationJSON(id: String, messages: [String], processing: String = "null") -> String {
        """
        {"id":"\(id)","patient_id":"patient-1","origin":"USER","awaiting_user_answer":false,
         "messages":[\(messages.joined(separator: ","))],"processing":\(processing)}
        """
    }

    static func answeredConversation(id: String) -> String {
        conversationJSON(id: id, messages: [
            message(id: "u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?"),
            message(id: "a-1", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Spokojnie."),
        ])
    }
}

private final class UXClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
