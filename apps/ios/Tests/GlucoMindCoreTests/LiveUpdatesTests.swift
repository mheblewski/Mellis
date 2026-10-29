import Combine
import XCTest
@testable import GlucoMindCore

final class ServerSentEventParserTests: XCTestCase {
    func testFramesEndAtBlankLinesAndSkipCommentsAndRetry() {
        var parser = ServerSentEventParser()
        let lines = [":" + String(repeating: " ", count: 20), "retry: 3000", "", "event: change", #"data: {"kind":"meal","id":"M1"}"#, "", ": ping", "", "event: draft", "data: a", "data: b", ""]
        let frames = lines.compactMap { parser.consume($0) }
        XCTAssertEqual(frames, [
            ServerSentEvent(event: "change", data: #"{"kind":"meal","id":"M1"}"#),
            ServerSentEvent(event: "draft", data: "a\nb"),
        ])
    }

    func testLiveEventsDecodeFromFrames() {
        XCTAssertEqual(LiveEvent(ServerSentEvent(event: "ready", data: #"{"heartbeat_s":15,"live":false}"#)), .ready(live: false))
        XCTAssertEqual(LiveEvent(ServerSentEvent(event: "resync", data: "{}")), .resync)
        XCTAssertEqual(LiveEvent(ServerSentEvent(event: "change", data: #"{"kind":"meal","id":"ABC"}"#)), .change(kind: "meal", id: "abc"))
        XCTAssertEqual(LiveEvent(ServerSentEvent(event: "change", data: #"{"kind":"meals","id":null}"#)), .change(kind: "meals", id: nil))
        XCTAssertEqual(
            LiveEvent(ServerSentEvent(event: "draft", data: #"{"thread":"meal_chat","id":"M","reply_to":"U","offset":3,"delta":"kawałki"}"#)),
            .draft(key: ReplyDraftKey(thread: .mealChat, id: "m"), replyTo: "u", offset: 3, delta: "kawałki")
        )
        XCTAssertEqual(LiveEvent(ServerSentEvent(event: "draft", data: #"{"thread":"conversation","id":"c","cleared":true}"#)), .draftCleared(key: ReplyDraftKey(thread: .conversation, id: "c")))
        XCTAssertNil(LiveEvent(ServerSentEvent(event: "unknown", data: "{}")))
        XCTAssertNil(LiveEvent(ServerSentEvent(event: "change", data: "not json")))
    }

    func testAccumulatorAppendsResetsAndReportsMissedFrames() {
        var accumulator = ReplyDraftAccumulator()
        let key = ReplyDraftKey(thread: .conversation, id: "c")
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u", offset: 0, delta: "Gli"), .updated)
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u", offset: 3, delta: "kemia 🍕"), .updated)
        XCTAssertEqual(accumulator.drafts[key]?.content, "Glikemia 🍕")
        // Offsets count UTF-16 code units, like the server's JavaScript strings ("🍕" is two).
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u", offset: 11, delta: " ok"), .updated)
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u", offset: 14, delta: ""), .unchanged)
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u", offset: 40, delta: "x"), .outOfStep)
        XCTAssertNil(accumulator.drafts[key])
        XCTAssertEqual(accumulator.apply(key: key, replyTo: "u2", offset: 0, delta: "Nowa"), .updated)
        XCTAssertTrue(accumulator.clear(key))
        XCTAssertFalse(accumulator.clear(key))
    }
}

/// Serves scripted streams: each connection yields its lines, then ends (or fails).
private final class ScriptedEventStream: EventStreamTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var connections: [[String]]
    private(set) var opened = 0

    init(_ connections: [[String]]) {
        self.connections = connections
    }

    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let lines: [String]? = lock.withLock {
            opened += 1
            return connections.isEmpty ? nil : connections.removeFirst()
        }
        guard let lines else {
            // No more scripts: stay connected and silent.
            return AsyncThrowingStream { _ in }
        }
        return AsyncThrowingStream { continuation in
            for line in lines { continuation.yield(line) }
            continuation.finish()
        }
    }
}

@MainActor
final class LiveUpdatesTests: XCTestCase {
    private func frame(_ event: String, _ data: String) -> [String] {
        ["event: \(event)", "data: \(data)", ""]
    }

    private func makeLive(_ transport: ScriptedEventStream) -> LiveUpdates {
        LiveUpdates(
            patientID: "p",
            requestFactory: { URLRequest(url: URL(string: "https://api.example.com/v1/patients/p/events")!) },
            transport: transport,
            retryDelays: [.milliseconds(5)]
        )
    }

    func testForwardsChangesBuildsDraftsAndResyncsAfterAReconnect() async throws {
        let transport = ScriptedEventStream([
            frame("ready", #"{"live":true}"#)
                + frame("change", #"{"kind":"meal","id":"m1"}"#)
                + frame("draft", #"{"thread":"conversation","id":"c1","reply_to":"u1","offset":0,"delta":"Gli"}"#)
                + frame("draft", #"{"thread":"conversation","id":"c1","reply_to":"u1","offset":3,"delta":"kemia"}"#),
            frame("ready", #"{"live":true}"#),
        ])
        let live = makeLive(transport)
        var changes: [LiveChange] = []
        var drafts: [String] = []
        var cancellables: Set<AnyCancellable> = []
        live.changes.sink { changes.append($0) }.store(in: &cancellables)
        live.$drafts.sink { drafts.append($0[ReplyDraftKey(thread: .conversation, id: "c1")]?.content ?? "") }.store(in: &cancellables)

        live.start()
        for _ in 0..<200 where changes.count < 2 {
            try await Task.sleep(for: .milliseconds(5))
        }
        live.stop()

        // The first stream ended (server maximum age): drafts are dropped, the second connection asks for a resync.
        XCTAssertEqual(changes, [.changed(kind: "meal", id: "m1"), .resync])
        XCTAssertTrue(drafts.contains("Glikemia"))
        XCTAssertEqual(live.drafts, [:])
        XCTAssertFalse(live.isLive)
        XCTAssertGreaterThanOrEqual(transport.opened, 2)
    }

    func testAMissedDraftFrameAsksTheScreenToReread() {
        let live = makeLive(ScriptedEventStream([]))
        var changes: [LiveChange] = []
        let cancellable = live.changes.sink { changes.append($0) }
        live.handle(.draft(key: ReplyDraftKey(thread: .mealChat, id: "m"), replyTo: "u", offset: 5, delta: "x"))
        XCTAssertEqual(changes, [.changed(kind: "meal_chat", id: "m")])
        cancellable.cancel()
    }

    func testChangeMatching() {
        XCTAssertTrue(LiveChange.changed(kind: "conversation", id: "c1").concerns(kind: "conversation", id: "C1"))
        XCTAssertFalse(LiveChange.changed(kind: "conversation", id: "c2").concerns(kind: "conversation", id: "c1"))
        XCTAssertTrue(LiveChange.changed(kind: "meals", id: nil).concerns(anyOf: ["meal", "meals"]))
        XCTAssertTrue(LiveChange.resync.concerns(kind: "anything"))
    }
}

/// Request bodies of the stale-write guards: absent fields stay absent (older behaviour), explicit nulls are sent.
final class StaleWriteRequestTests: XCTestCase {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
    }

    func testRevisionFieldsAreSentOnlyWhenKnown() throws {
        XCTAssertNil(try json(MealDescriptionUpdateRequest(description: "Pizza"))["expected_revision"])
        XCTAssertEqual(try json(MealDescriptionUpdateRequest(description: "Pizza", expected_revision: 3))["expected_revision"] as? Int, 3)
        XCTAssertNil(try json(MealCorrectionRequest(carbs_g: 10, protein_g: nil, fat_g: nil))["expected_revision"])
        XCTAssertEqual(try json(MealCorrectionRequest(carbs_g: 10, protein_g: nil, fat_g: nil, expected_revision: 4))["expected_revision"] as? Int, 4)
    }

    func testStaleWriteIsRecognised() {
        let stale = APIClientError.conflict(ProblemDetails(type: "x", title: "MEAL_CHANGED", status: 409, code: "STALE_WRITE", instance: nil))
        XCTAssertTrue(stale.isStaleWrite)
        XCTAssertFalse(APIClientError.conflict(nil).isStaleWrite)
        XCTAssertEqual(MealEditOutcome(error: stale), .superseded(MealEditOutcome.supersededMessage))
        XCTAssertEqual(MealEditOutcome(error: MealEditError.nothingToSave), .failed("Wpisz opis albo co najmniej jedną wartość."))
    }
}

/// MealEdit.apply: the first write names the revision the sheet opened with, the second the one the first returned.
@MainActor
final class MealEditRevisionTests: XCTestCase {
    private final class RevisionAPI: MealChatAPI {
        var calls: [(String, Int?)] = []
        var nextRevision = 8
        var valuesFailure: Error?

        private func meal(revision: Int) -> MealResponse {
            let json = #"{"patient_id":"p","meal":{"meal_id":"m","status":"DESCRIBED","started_at":"2026-10-19T08:00:00Z","source_carbs_g":40,"description":"x","has_photo":false,"macros":{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}},"pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":false,"content_revision":\#(revision)}}"#
            return try! JSONDecoder().decode(MealResponse.self, from: Data(json.utf8))
        }

        func updateMealDescription(patientID: String, mealID: String, description: String, expectedRevision: Int?) async throws -> MealResponse {
            calls.append(("description", expectedRevision))
            return meal(revision: nextRevision)
        }
        func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?, expectedRevision: Int?) async throws -> MealResponse {
            calls.append(("values", expectedRevision))
            if let valuesFailure { throw valuesFailure }
            return meal(revision: nextRevision + 1)
        }
        func getMealChat(patientID: String, mealID: String) async throws -> MealChatResponse { throw APIClientError.invalidResponse }
        func postMealChat(patientID: String, mealID: String, content: String?, photoIDs: [String], idempotencyKey: String) async throws -> MealChatResponse { throw APIClientError.invalidResponse }
        func uploadMealPhoto(patientID: String, mealID: String, jpegData: Data) async throws -> MealPhotoUploadResponse { throw APIClientError.invalidResponse }
        func mealPhotoData(patientID: String, mealID: String, photoID: String) async throws -> Data { Data() }
        func acceptMealChatProposal(patientID: String, mealID: String, messageID: String) async throws -> MealChatResponse { throw APIClientError.invalidResponse }
        func updateMealDescription(patientID: String, mealID: String, description: String) async throws -> MealResponse { throw APIClientError.invalidResponse }
        func retryMealChatReply(patientID: String, mealID: String) async throws -> MealChatResponse { throw APIClientError.invalidResponse }
        func getMeal(patientID: String, mealID: String) async throws -> MealResponse { throw APIClientError.invalidResponse }
        func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse { throw APIClientError.invalidResponse }
    }

    func testRevisionsChainAcrossTheTwoWritesAndComeFromTheOpenedMeal() async throws {
        let api = RevisionAPI()
        // The sheet opened at revision 5 with description "x"; the meal on screen has since moved to 7 (live update).
        let edit = MealEdit(description: "Pizza", carbs: 60, protein: nil, fat: nil, saveValues: true, baseRevision: 5, baseDescription: "x")
        try await MealEdit.apply(edit, to: nil, api: api, route: MealRoute(patientID: "p", mealID: "m"))
        XCTAssertEqual(api.calls.map(\.0), ["description", "values"])
        XCTAssertEqual(api.calls.map(\.1), [5, 8])
    }

    func testARetryAfterAPartialSaveBuildsOnItsOwnFirstWrite() async throws {
        let api = RevisionAPI()
        api.valuesFailure = URLError(.notConnectedToInternet)
        var edit = MealEdit(description: "Pizza", carbs: 60, protein: nil, fat: nil, saveValues: true, baseRevision: 5, baseDescription: "x")
        do {
            try await MealEdit.apply(&edit, to: nil, api: api, route: MealRoute(patientID: "p", mealID: "m"))
            XCTFail("the values were not saved")
        } catch {}
        XCTAssertEqual(edit.baseRevision, 8, "based on the description just written")
        XCTAssertEqual(edit.baseDescription, "Pizza")

        api.valuesFailure = nil
        try await MealEdit.apply(&edit, to: nil, api: api, route: MealRoute(patientID: "p", mealID: "m"))
        XCTAssertEqual(api.calls.map(\.0), ["description", "values", "values"], "the description is not written twice")
        XCTAssertEqual(api.calls.map(\.1), [5, 8, 8])
        XCTAssertEqual(edit.baseRevision, 9)
    }
}

private struct LiveTestAuth: AuthProvider {
    func bearerToken() async throws -> String { "t" }
}

private final class LiveTestHTTPClient: HTTPClient, @unchecked Sendable {
    let body: () -> String
    init(body: @escaping () -> String) { self.body = body }
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(body().utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

/// The answer being written replaces the status line, comes from the live stream or the fetched thread, and disappears
/// once the stored answer is there.
@MainActor
final class ReplyDraftVisibilityTests: XCTestCase {
    private func conversationJSON(withAnswer: Bool, draft: String?) -> String {
        let answer = withAnswer ? #",{"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Glikemia OK.","created_at":"2026-10-19T08:00:05Z"}"# : ""
        let draftJSON = draft.map { #","reply_draft":{"reply_to_message_id":"u1","content":"\#($0)"}"# } ?? ""
        return #"{"id":"c1","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"messages":[{"id":"u1","role":"USER","message_type":"USER_MESSAGE","content":"Jak dziś?","created_at":"2026-10-19T08:00:00Z"}\#(answer)],"analysis_id":null,"recommendation_id":null,"processing":{"status":"PROCESSING","current_step":null,"steps":[]}\#(draftJSON)}"#
    }

    func testConversationShowsTheFetchedDraftInsteadOfTheStatusLine() async {
        var json = conversationJSON(withAnswer: false, draft: "Gliko")
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: LiveTestAuth(), httpClient: LiveTestHTTPClient { json })
        let model = ConversationViewModel(apiClient: client, patientID: "p", pollInterval: .milliseconds(1))
        await model.selectConversation("c1")

        XCTAssertEqual(model.visibleReplyDraft?.content, "Gliko")
        XCTAssertTrue(model.timelineItems.contains { if case .assistantDraft = $0 { return true } else { return false } })
        XCTAssertFalse(model.timelineItems.contains { if case .processing = $0 { return true } else { return false } })

        json = conversationJSON(withAnswer: true, draft: nil)
        await model.refreshActiveConversation()
        XCTAssertNil(model.visibleReplyDraft)
    }

    func testConversationPrefersTheLiveDraft() async throws {
        let json = conversationJSON(withAnswer: false, draft: nil)
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: LiveTestAuth(), httpClient: LiveTestHTTPClient { json })
        let model = ConversationViewModel(apiClient: client, patientID: "p", pollInterval: .milliseconds(1))
        let live = LiveUpdates(patientID: "p", requestFactory: { URLRequest(url: URL(string: "https://x")!) }, transport: ScriptedEventStream([]), retryDelays: [.seconds(60)])
        model.bindLiveUpdates(live)
        await model.selectConversation("c1")
        XCTAssertNil(model.visibleReplyDraft)

        live.handle(.draft(key: ReplyDraftKey(thread: .conversation, id: "c1"), replyTo: "u1", offset: 0, delta: "Glikemia"))
        XCTAssertEqual(model.visibleReplyDraft?.content, "Glikemia")
        // A draft of an older message is not this answer.
        live.handle(.draft(key: ReplyDraftKey(thread: .conversation, id: "c1"), replyTo: "u0", offset: 0, delta: "Stare"))
        XCTAssertNil(model.visibleReplyDraft)
    }

    func testMealChatShowsTheDraftOnlyWhileTheReplyIsPending() throws {
        func chat(pending: Bool, draft: String?) throws -> MealChatResponse {
            let draftJSON = draft.map { #","reply_draft":{"reply_to_message_id":"u1","content":"\#($0)"}"# } ?? ""
            let json = #"{"patient_id":"p","meal":{"meal_id":"m","status":"DESCRIBED","started_at":"2026-10-19T08:00:00Z","source_carbs_g":40,"description":"x","has_photo":false,"macros":{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}},"pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":false},"messages":[{"id":"u1","role":"USER","content":"Pizza","photo_ids":[],"proposal":null,"question":null,"author_display_name":null,"reply_to_message_id":null,"created_at":"x"}],"reply_pending":\#(pending),"reply_failed":false\#(draftJSON)}"#
            return try JSONDecoder().decode(MealChatResponse.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try chat(pending: true, draft: "Dwa").reply_draft?.content, "Dwa")
        XCTAssertNil(try chat(pending: true, draft: nil).reply_draft)
    }
}

@MainActor
final class LiveUpdatesReviewFixesTests: XCTestCase {
    func testAResyncFromTheServerMeansItDeliversEventsAgain() {
        let live = LiveUpdates(patientID: "p", requestFactory: { URLRequest(url: URL(string: "https://x")!) }, transport: ScriptedEventStream([]), retryDelays: [.seconds(60)])
        live.handle(.ready(live: false))
        XCTAssertFalse(live.isLive)
        live.handle(.resync)
        XCTAssertTrue(live.isLive)
    }

    func testAClearedDraftStaysUntilAReadStartedAfterTheClearSettlesIt() async {
        func json(answer: Bool, draft: Bool) -> String {
            let answerJSON = answer ? #",{"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Stara próba, dłużej.","created_at":"2026-10-19T08:00:05Z"}"# : ""
            let draftJSON = draft ? #","reply_draft":{"reply_to_message_id":"u1","content":"Stara próba"}"# : ""
            return #"{"id":"c1","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"messages":[{"id":"u1","role":"USER","message_type":"USER_MESSAGE","content":"?","created_at":"2026-10-19T08:00:00Z"}\#(answerJSON)],"analysis_id":null,"recommendation_id":null,"processing":{"status":"PROCESSING","current_step":null,"steps":[]}\#(draftJSON)}"#
        }
        var body = json(answer: false, draft: true)
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: LiveTestAuth(), httpClient: LiveTestHTTPClient { body })
        let model = ConversationViewModel(apiClient: client, patientID: "p", pollInterval: .milliseconds(1))
        let live = LiveUpdates(patientID: "p", requestFactory: { URLRequest(url: URL(string: "https://x")!) }, transport: ScriptedEventStream([]), retryDelays: [.seconds(60)])
        model.bindLiveUpdates(live)
        await model.selectConversation("c1")
        let key = ReplyDraftKey(thread: .conversation, id: "c1")
        live.handle(.draft(key: key, replyTo: "u1", offset: 0, delta: "Stara próba, dłużej"))
        XCTAssertEqual(model.visibleReplyDraft?.content, "Stara próba, dłużej")

        // The answer was stored and its draft cleared, but not read yet: the text stays (no status line in between).
        live.handle(.draftCleared(key: key))
        XCTAssertEqual(model.visibleReplyDraft?.content, "Stara próba, dłużej")
        XCTAssertFalse(model.timelineItems.contains { if case .processing = $0 { return true } else { return false } })

        // The next read has the stored answer: it takes the draft's place.
        body = json(answer: true, draft: false)
        await model.refreshActiveConversation()
        XCTAssertNil(model.visibleReplyDraft)
        XCTAssertTrue(model.timelineItems.contains { if case .assistantMessage = $0 { return true } else { return false } })

        // A failed attempt: the read after the clear has no answer and no draft, so the stale text goes too.
        body = json(answer: false, draft: false)
        await model.refreshActiveConversation()
        live.handle(.draft(key: key, replyTo: "u1", offset: 0, delta: "Próba"))
        live.handle(.draftCleared(key: key))
        XCTAssertEqual(model.visibleReplyDraft?.content, "Próba")
        await model.refreshActiveConversation()
        XCTAssertNil(model.visibleReplyDraft)
    }
}

@MainActor
final class TextRevealerTests: XCTestCase {
    func testRevealsAtAGentlyChangingPaceAndFadesTheNewestCharactersIn() {
        var clock: TimeInterval = 0
        let revealer = TextRevealer(now: { clock })
        let text = String(repeating: "Glikemia w normie. ", count: 10)
        // The first chunk arrives at once (as from the server), the rest a bit later.
        revealer.setTarget(String(text.prefix(60)))
        var shown: [Int] = []
        for frame in 0..<180 {
            if frame == 30 { revealer.setTarget(text) }
            clock += 1.0 / 60.0
            revealer.tick()
            shown.append(revealer.displayed.count)
        }
        let steps = zip(shown.dropFirst(), shown).map { $0 - $1 }
        XCTAssertTrue(steps.allSatisfy { $0 >= 0 }, "never goes back")
        // No jump: one frame never shows more than a few characters more than the frame before.
        XCTAssertLessThanOrEqual(steps.max() ?? 0, 8)
        XCTAssertEqual(revealer.displayed, text)
        XCTAssertFalse(revealer.isFinished, "not finished until the stored answer arrives")

        revealer.complete(with: text)
        for _ in 0..<30 {
            clock += 1.0 / 60.0
            revealer.tick()
        }
        XCTAssertTrue(revealer.tailOpacities.isEmpty)
        XCTAssertTrue(revealer.isFinished)
    }

    func testTheStoredAnswerContinuesFromTheDraftAndNewCharactersStartFaded() {
        var clock: TimeInterval = 0
        let revealer = TextRevealer(now: { clock })
        revealer.setTarget("Dwa kawałki")
        // The pace eases in from zero, so the first characters appear within a few frames.
        for _ in 0..<8 {
            clock += 1.0 / 60.0
            revealer.tick()
        }
        XCTAssertFalse(revealer.displayed.isEmpty)
        XCTAssertTrue(revealer.tailOpacities.allSatisfy { $0 < 1 })
        let before = revealer.displayed.count
        revealer.complete(with: "Dwa kawałki pizzy, ok. 62 g węglowodanów.")
        XCTAssertEqual(revealer.displayed.count, before, "goes on from where it was, not at once")
    }

    func testCutMarkupIsNotShownRaw() {
        XCTAssertEqual(StreamingMarkdown.displayable("Glikemia **86%"), "Glikemia **86%**")
        XCTAssertEqual(StreamingMarkdown.displayable("Podsumowanie\n##"), "Podsumowanie\n")
        XCTAssertEqual(StreamingMarkdown.displayable("Tekst *"), "Tekst ")
        XCTAssertEqual(StreamingMarkdown.displayable("**Gotowe**"), "**Gotowe**")
    }
}

@MainActor
final class TextRevealerPaceTests: XCTestCase {
    /// Chunks of 25 characters every 200 ms (as the server sends them), then the stored answer.
    func testStreamedChunksRevealSteadilyAndTheEndDoesNotSlowDown() {
        var clock: TimeInterval = 0
        let revealer = TextRevealer(now: { clock })
        let text = String((0..<400).map { _ in Character("a") })
        var arrived = 0
        var shown: [Int] = []
        var completed = false
        for frame in 0..<600 {
            if frame % 12 == 0, arrived < text.count {
                arrived = min(text.count, arrived + 25)
                revealer.setTarget(String(text.prefix(arrived)))
            }
            if arrived == text.count, !completed, frame % 12 == 6 {
                revealer.complete(with: text)
                completed = true
            }
            clock += 1.0 / 60.0
            revealer.tick()
            shown.append(revealer.displayed.count)
            if revealer.isFinished { break }
        }
        XCTAssertEqual(revealer.displayed, text)
        let steps = zip(shown.dropFirst(), shown).map { $0 - $1 }
        // While text keeps arriving (after the first second), the reveal never stops between chunks.
        let middle = Array(steps[60..<150])
        XCTAssertFalse(middle.contains(0), "no pauses between chunks: \(middle)")
        // The last characters come at least as fast as the steady middle part.
        let middlePace = Double(middle.reduce(0, +)) / Double(middle.count)
        let movingTail = steps.suffix(40).filter { $0 > 0 }
        let tailPace = Double(movingTail.reduce(0, +)) / Double(max(movingTail.count, 1))
        XCTAssertGreaterThanOrEqual(tailPace, middlePace * 0.9, "middle \(middlePace)/frame, end \(tailPace)/frame")
    }
}
