import XCTest
@testable import GlucoMindCore

/// One screen shows one thread: what was started in another thread (its send, polling, cancel or load) never comes
/// back on screen, never blocks this thread's composer, and is shown when that thread is opened again.
@MainActor
final class ConversationThreadSwitchTests: XCTestCase {
    func testSendInAThenOpeningBShowsOnlyBAndBCanSend() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.empty("conv-b")
        api.autoReply = ["conv-b"]
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")

        model.userMessageText = "Pytanie w A"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { api.gets["conv-a", default: 0] >= 3 }
        XCTAssertEqual(model.processingState, .processing)

        await model.selectConversation("conv-b")
        let readsOfA = api.gets["conv-a", default: 0]
        await sendA.value
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(api.gets["conv-a", default: 0], readsOfA, "the poll of A stopped with the switch")
        XCTAssertEqual(model.conversation?.id, "conv-b")
        XCTAssertEqual(model.selectedConversationID, "conv-b")
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertFalse(model.isSubmittingUserMessage)
        XCTAssertFalse(model.timelineItems.contains { if case .userMessage(let message) = $0 { return message.content == "Pytanie w A" }; return false })
        XCTAssertTrue(model.canSendUserMessage)

        model.userMessageText = "Pytanie w B"
        await model.submitUserMessage()
        XCTAssertEqual(api.posts.map(\.conversationID), ["conv-a", "conv-b"])
        XCTAssertEqual(model.conversation?.id, "conv-b")
        XCTAssertTrue(model.timelineItems.contains { if case .assistantMessage(let message) = $0 { return message.content == "Odpowiedź" }; return false })
    }

    func testStopInAThenNewThreadNeverReturnsToAEvenBeforeTheServerMarksTheCancel() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.empty("conv-new")
        api.marksCancelledOnCancel = false
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")

        model.userMessageText = "Policz dzień"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { model.canCancelAnalysis }
        await model.cancelAnalysis()
        XCTAssertEqual(api.cancels, ["conv-a"])

        await model.selectConversation("conv-new")
        await sendA.value
        let readsOfA = api.gets["conv-a", default: 0]
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(api.gets["conv-a", default: 0], readsOfA)
        XCTAssertEqual(model.conversation?.id, "conv-new")
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertTrue(model.timelineItems.isEmpty)
        XCTAssertTrue(model.canSendUserMessage)
    }

    func testQuickSwitchingKeepsTheLastThreadWhenAnEarlierLoadAnswersLate() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        api.answered("conv-c")
        api.holdGets(of: "conv-a")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))

        let openA = Task { await model.selectConversation("conv-a") }
        await waitUntil { api.isHoldingGet }
        await model.selectConversation("conv-b")
        await model.selectConversation("conv-c")
        api.releaseHeldGets()
        await openA.value

        XCTAssertEqual(model.selectedConversationID, "conv-c")
        XCTAssertEqual(model.conversation?.id, "conv-c")
        XCTAssertEqual(model.state, .loaded)
    }

    func testMessageSentInALandsInAWhenBWasOpenedDuringTheSend() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        api.holdPosts = true
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")

        model.userMessageText = "Wysłane z A"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { api.isHoldingPost }
        await model.selectConversation("conv-b")
        XCTAssertTrue(model.canSendUserMessage, "the send in A does not block B")
        api.releaseHeldPosts()
        await sendA.value

        XCTAssertEqual(model.conversation?.id, "conv-b")
        XCTAssertEqual(model.userMessageText, "")
        XCTAssertNil(model.localEchoMessage)

        await model.selectConversation("conv-a")
        XCTAssertEqual(model.userMessageText, "", "the sent text is not offered again")
        XCTAssertTrue(model.timelineItems.contains { if case .userMessage(let message) = $0 { return message.content == "Wysłane z A" }; return false })
    }

    func testStopInBNeverCancelsTheAnalysisOfA() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")
        model.userMessageText = "Długa analiza"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { model.canCancelAnalysis }

        await model.selectConversation("conv-b")
        await sendA.value
        try? await Task.sleep(for: .milliseconds(20))

        XCTAssertFalse(model.canCancelAnalysis)
        await model.cancelAnalysis()
        XCTAssertTrue(api.cancels.isEmpty)
    }

    func testLiveChangeOfBDoesNotWakeThePollingOfA() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        let live = LiveUpdates(patientID: "patient-1", requestFactory: { URLRequest(url: URL(string: "https://x")!) }, transport: ThreadsSilentStream(), retryDelays: [.seconds(60)])
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        model.bindLiveUpdates(live)
        await model.selectConversation("conv-a")
        model.userMessageText = "Pytanie w A"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { api.gets["conv-a", default: 0] >= 2 }

        // The change comes while A would still be polled (its answer is not there yet).
        await model.selectConversation("conv-b")
        let readsOfA = api.gets["conv-a", default: 0]
        let readsOfB = api.gets["conv-b", default: 0]
        api.setReply("conv-b", "Nowa wiadomość drugiej osoby")
        live.changes.send(.changed(kind: "conversation", id: "conv-b"))
        await waitUntil { api.gets["conv-b", default: 0] > readsOfB }
        await waitUntil { model.timelineItems.contains { if case .assistantMessage(let message) = $0 { return message.content == "Nowa wiadomość drugiej osoby" }; return false } }

        XCTAssertEqual(api.gets["conv-a", default: 0], readsOfA)
        XCTAssertEqual(model.conversation?.id, "conv-b")
        await sendA.value
    }

    func testReturningToAThreadStillBeingAnsweredShowsTheAnswerWithoutLiveUpdates() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")
        model.userMessageText = "Pytanie w A"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { model.processingState == .processing }
        await model.selectConversation("conv-b")
        await sendA.value

        await model.selectConversation("conv-a")
        XCTAssertEqual(model.processingState, .processing, "A is still being answered")
        api.setReply("conv-a", "Odpowiedź na A")
        await model.waitForPolling()

        XCTAssertEqual(model.conversation?.id, "conv-a")
        XCTAssertEqual(model.processingState, .idle)
        XCTAssertTrue(model.timelineItems.contains { if case .assistantMessage(let message) = $0 { return message.content == "Odpowiedź na A" }; return false })
        XCTAssertTrue(model.canSendUserMessage)
    }

    func testReturningToAThreadAnsweredMeanwhileShowsTheAnswer() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.answered("conv-b")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-a")
        model.userMessageText = "Pytanie w A"
        let sendA = Task { await model.submitUserMessage() }
        await waitUntil { model.processingState == .processing }
        await model.selectConversation("conv-b")
        await sendA.value
        api.setReply("conv-a", "Odpowiedź na A")

        await model.selectConversation("conv-a")

        XCTAssertEqual(model.processingState, .idle)
        XCTAssertTrue(model.timelineItems.contains { if case .assistantMessage(let message) = $0 { return message.content == "Odpowiedź na A" }; return false })
    }

    func testCancelledLoadLoadsAgainWhenTheSameThreadIsSelectedAgain() async {
        let api = ThreadsStubAPI()
        api.answered("conv-a")
        api.holdGets(of: "conv-a")
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))

        // The screen's task is cancelled while the thread loads (the tab left).
        let screen = Task { await model.selectConversation("conv-a") }
        await waitUntil { api.isHoldingGet }
        screen.cancel()
        api.releaseHeldGets(failing: true)
        await screen.value
        XCTAssertNotEqual(model.state, .loaded)

        await model.selectConversation("conv-a")
        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.conversation?.id, "conv-a")
    }

    private func waitUntil(timeout: Duration = .seconds(2), _ condition: () -> Bool) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition(), clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertTrue(condition(), "condition not met in time")
    }
}

/// Several threads of one patient on a fake server: a sent message waits for its answer until `setReply` (or at once
/// for `autoReply` threads); reads and posts are counted and can be held.
@MainActor
private final class ThreadsStubAPI {
    private var messages: [String: [String]] = [:]
    var autoReply: Set<String> = []
    var marksCancelledOnCancel = true
    private(set) var gets: [String: Int] = [:]
    private(set) var posts: [(conversationID: String, content: String)] = []
    private(set) var cancels: [String] = []
    private var heldGetIDs: Set<String> = []
    private var heldGets: [CheckedContinuation<Bool, Never>] = []
    var holdPosts = false
    private var heldPosts: [CheckedContinuation<Void, Never>] = []
    private var counter = 0
    var isHoldingGet: Bool { !heldGets.isEmpty }
    var isHoldingPost: Bool { !heldPosts.isEmpty }

    func answered(_ id: String) {
        messages[id] = [
            Self.message(id: "\(id)-u0", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?"),
            Self.message(id: "\(id)-a0", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Spokojnie."),
        ]
    }

    func empty(_ id: String) {
        messages[id] = []
    }

    func setReply(_ id: String, _ content: String) {
        counter += 1
        messages[id, default: []].append(Self.message(id: "\(id)-a\(counter)", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: content))
    }

    func holdGets(of id: String) {
        heldGetIDs.insert(id)
    }

    func releaseHeldGets(failing: Bool = false) {
        heldGetIDs.removeAll()
        let held = heldGets
        heldGets.removeAll()
        held.forEach { $0.resume(returning: failing) }
    }

    func releaseHeldPosts() {
        holdPosts = false
        let held = heldPosts
        heldPosts.removeAll()
        held.forEach { $0.resume() }
    }

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: ThreadsHTTPClient { [unowned self] request in
            try await self.handle(request)
        }
    )

    private func handle(_ request: URLRequest) async throws -> (Data, Int) {
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init)
        guard let index = parts.firstIndex(of: "conversations"), index + 1 < parts.count else {
            return (Data("{}".utf8), 404)
        }
        let conversationID = parts[index + 1]

        if request.httpMethod == "POST", parts.last == "cancel" {
            cancels.append(conversationID)
            if marksCancelledOnCancel, var thread = messages[conversationID], let last = thread.indices.last {
                thread[last] = thread[last].replacingOccurrences(of: #""analysis_cancellable":true"#, with: #""analysis_cancellable":false,"response_status":"CANCELLED""#)
                messages[conversationID] = thread
            }
            let body = #"{"result":"CANCELLED","message_id":""# + parts[parts.count - 2] + #"","conversation":"# + conversationJSON(conversationID) + "}"
            return (Data(body.utf8), 200)
        }

        if request.httpMethod == "POST" {
            let payload = try JSONDecoder().decode(UserMessageSubmissionRequest.self, from: request.httpBody ?? Data())
            let content = payload.content
            if holdPosts {
                await withCheckedContinuation { heldPosts.append($0) }
            }
            counter += 1
            let message = Self.message(id: "\(conversationID)-u\(counter)", role: "USER", type: "USER_MESSAGE", content: content, extra: #","analysis_cancellable":true"#)
            messages[conversationID, default: []].append(message)
            posts.append((conversationID, content))
            if autoReply.contains(conversationID) {
                setReply(conversationID, "Odpowiedź")
            }
            let body = #"{"message":"# + message + #","conversation":"# + conversationJSON(conversationID) + #","decision":"DIRECT_RESPONSE"}"#
            return (Data(body.utf8), 200)
        }

        gets[conversationID, default: 0] += 1
        if heldGetIDs.contains(conversationID) {
            let failing = await withCheckedContinuation { heldGets.append($0) }
            if failing {
                throw URLError(.cancelled)
            }
        }
        guard messages[conversationID] != nil else {
            return (Data("{}".utf8), 404)
        }
        return (Data(conversationJSON(conversationID).utf8), 200)
    }

    private func conversationJSON(_ id: String) -> String {
        """
        {"id":"\(id)","patient_id":"patient-1","origin":"USER","awaiting_user_answer":false,
         "messages":[\((messages[id] ?? []).joined(separator: ","))],"processing":null}
        """
    }

    static func message(id: String, role: String, type: String, content: String, extra: String = "") -> String {
        """
        {"id":"\(id)","role":"\(role)","message_type":"\(type)","content":"\(content)","created_at":"2026-10-20T06:00:00.000Z"\(extra)}
        """
    }
}

private final class ThreadsHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// A live stream that never connects: changes are sent by the test itself.
private struct ThreadsSilentStream: EventStreamTransport {
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { _ in }
    }
}
