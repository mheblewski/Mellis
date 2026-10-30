import XCTest
@testable import GlucoMindCore

/// fresh-chat.v1: the Rozmowy tab shows an empty new conversation instead of one quiet for an hour, except a
/// conversation opened on purpose, one being answered, or one with an unsent draft; nothing is created on the server
/// until the first send.
@MainActor
final class FreshConversationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: Policy

    func testThresholdIsOneHourAndOnlyLongerInactivityStartsFresh() {
        XCTAssertEqual(FreshConversationPolicy.defaultInactivityThreshold, 3_600)
        let recent = FreshConversationPolicy.Snapshot(conversationID: "c", lastActivity: now.addingTimeInterval(-59 * 60))
        let old = FreshConversationPolicy.Snapshot(conversationID: "c", lastActivity: now.addingTimeInterval(-61 * 60))
        XCTAssertEqual(FreshConversationPolicy.decide(recent, openedOnPurposeAt: nil, now: now, threshold: 3_600), .keep(.recentActivity))
        XCTAssertEqual(FreshConversationPolicy.decide(old, openedOnPurposeAt: nil, now: now, threshold: 3_600), .startFresh)
        // The Debug override changes only the number.
        XCTAssertEqual(FreshConversationPolicy.decide(recent, openedOnPurposeAt: nil, now: now, threshold: 60), .startFresh)
    }

    func testOpenedOnPurposeBusyDraftAndWaitingQuestionAreKept() {
        let old = now.addingTimeInterval(-3 * 3_600)
        func decide(_ snapshot: FreshConversationPolicy.Snapshot, opened: Date? = nil) -> FreshConversationPolicy.Decision {
            FreshConversationPolicy.decide(snapshot, openedOnPurposeAt: opened, now: now, threshold: 3_600)
        }
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: old), opened: now.addingTimeInterval(-5)), .keep(.openedOnPurpose))
        // A notification tap long ago no longer protects it.
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: old), opened: now.addingTimeInterval(-2 * 3_600)), .startFresh)
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: old, isBusy: true)), .keep(.busy))
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: old, hasDraft: true)), .keep(.draft))
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: old, awaitsAnswer: true)), .keep(.awaitsAnswer))
        XCTAssertEqual(decide(.init(conversationID: "c", lastActivity: nil)), .keep(.noActivityKnown))
    }

    func testLastActivityIsTheNewestMessageAlertOrCreation() {
        let messages = [
            message(id: "u", role: "USER", at: "2026-10-30T08:00:00.000Z"),
            message(id: "a", role: "ASSISTANT", at: "2026-10-30T08:01:30.000Z"),
        ]
        let plain = ConversationResponse(id: "c", patient_id: "p", awaiting_user_answer: false, pending_question: nil, messages: messages, analysis_id: nil, recommendation_id: nil)
        XCTAssertEqual(plain.lastActivity(), ServerDate.parse("2026-10-30T08:01:30.000Z"))
        XCTAssertEqual(plain.lastActivity(createdAt: ServerDate.parse("2026-10-30T09:00:00.000Z")), ServerDate.parse("2026-10-30T09:00:00.000Z"))

        var alert = ConversationResponse(id: "r", patient_id: "p", awaiting_user_answer: false, pending_question: nil, messages: [], analysis_id: nil, recommendation_id: nil)
        alert.rescue_carbs = ConversationRescueCarbs(alert_id: "a1", status: "NOTIFIED", level: "PREDICTED_LOW", detected_at: "2026-10-30T07:55:00.000Z", glucose_readings: [], prediction: [], notified_at: "2026-10-30T07:56:00.000Z", reminder_sent_at: "2026-10-30T08:11:00.000Z")
        XCTAssertEqual(alert.lastActivity(), ServerDate.parse("2026-10-30T08:11:00.000Z"))

        let empty = ConversationResponse(id: "e", patient_id: "p", awaiting_user_answer: false, pending_question: nil, messages: [], analysis_id: nil, recommendation_id: nil)
        XCTAssertNil(empty.lastActivity())
    }

    // MARK: View model

    func testAnOldConversationGivesWayToAFreshDraftWithoutCreatingOne() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        let model = makeModel(api)
        var replaced: [String?] = []
        model.onFreshDraftStarted = { replaced.append($0) }
        await model.selectConversation("conv-old")
        model.requestFreshCheck()

        XCTAssertTrue(model.isFreshDraft)
        XCTAssertNil(model.selectedConversationID)
        XCTAssertEqual(replaced, ["conv-old"])
        XCTAssertEqual(model.state, .loaded)
        XCTAssertTrue(model.timelineItems.isEmpty, "the greeting and starter cards of a new conversation")
        XCTAssertNil(model.hypo)
        XCTAssertNil(model.rescueCarbs)
        XCTAssertTrue(model.canSendUserMessage)
        XCTAssertEqual(api.creations, 0, "nothing is created until something is sent")

        // The tab follows with no selection: the draft stays; the old conversation opens again from the list.
        await model.selectConversation(nil)
        XCTAssertTrue(model.isFreshDraft)
        await model.selectConversation("conv-old")
        XCTAssertFalse(model.isFreshDraft)
        XCTAssertEqual(model.conversation?.id, "conv-old")
    }

    func testARecentConversationStays() async {
        let api = FreshStubAPI()
        api.conversation("conv-recent", lastMessageAt: now.addingTimeInterval(-10 * 60))
        let model = makeModel(api)
        await model.selectConversation("conv-recent")
        model.requestFreshCheck()
        XCTAssertFalse(model.isFreshDraft)
        XCTAssertEqual(model.selectedConversationID, "conv-recent")
    }

    func testACheckAskedBeforeTheConversationIsReadWaitsForIt() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-90 * 60))
        let model = makeModel(api)
        model.requestFreshCheck()
        XCTAssertFalse(model.isFreshDraft)
        await model.selectConversation("conv-old")
        XCTAssertTrue(model.isFreshDraft)
    }

    func testAConversationOpenedOnPurposeStays() async {
        let api = FreshStubAPI()
        api.conversation("conv-hypo", lastMessageAt: now.addingTimeInterval(-5 * 3_600))
        let model = makeModel(api)
        let openedAt = now.addingTimeInterval(-3)
        model.openedOnPurposeAt = { $0 == "conv-hypo" ? openedAt : nil }
        await model.selectConversation("conv-hypo")
        model.requestFreshCheck()
        XCTAssertFalse(model.isFreshDraft)
        XCTAssertEqual(model.selectedConversationID, "conv-hypo")
    }

    func testADraftKeepsItsConversation() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        let model = makeModel(api)
        await model.selectConversation("conv-old")
        model.userMessageText = "Pisałem, że"
        model.requestFreshCheck()
        XCTAssertFalse(model.isFreshDraft)
        XCTAssertEqual(model.userMessageText, "Pisałem, że")
    }

    func testAConversationBeingAnsweredIsNeverReplaced() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        api.holdPosts = true
        let model = makeModel(api)
        await model.selectConversation("conv-old")
        model.userMessageText = "Ile teraz?"
        let send = Task { await model.submitUserMessage() }
        await waitUntil { api.isHoldingPost }
        model.requestFreshCheck()
        XCTAssertFalse(model.isFreshDraft, "a request in flight")
        api.releaseHeldPosts()
        await send.value
    }

    func testTheFirstSendCreatesTheConversationOnceAndSendsToIt() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        let model = makeModel(api)
        var created: [String] = []
        model.onFreshDraftCreated = { created.append($0.id) }
        await model.selectConversation("conv-old")
        model.requestFreshCheck()
        XCTAssertTrue(model.isFreshDraft)

        model.userMessageText = "Jak minęła noc?"
        await model.submitUserMessage()

        XCTAssertEqual(api.creations, 1)
        XCTAssertEqual(created, ["conv-new"])
        XCTAssertEqual(api.posts.map(\.conversationID), ["conv-new"])
        XCTAssertFalse(model.isFreshDraft)
        XCTAssertEqual(model.selectedConversationID, "conv-new")
        // The tab then selects it: nothing is read or reset again.
        await model.selectConversation("conv-new")
        XCTAssertEqual(model.selectedConversationID, "conv-new")
    }

    func testAFailedCreationKeepsTheDraftAndRetriesWithTheSameKey() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        api.failCreations = 1
        let model = makeModel(api)
        await model.selectConversation("conv-old")
        model.requestFreshCheck()
        model.userMessageText = "Pytanie"
        await model.submitUserMessage()
        XCTAssertTrue(model.isFreshDraft)
        XCTAssertEqual(model.userMessageText, "Pytanie")
        guard case .error = model.processingState else { return XCTFail("the error is shown") }

        await model.submitUserMessage()
        XCTAssertEqual(api.creationKeys.count, 2)
        XCTAssertEqual(Set(api.creationKeys).count, 1, "one idempotency key per fresh draft")
        XCTAssertEqual(api.posts.map(\.conversationID), ["conv-new"])
    }

    func testTheDraftOfTheReplacedConversationStaysWithIt() async {
        let api = FreshStubAPI()
        api.conversation("conv-old", lastMessageAt: now.addingTimeInterval(-2 * 3_600))
        let model = makeModel(api)
        await model.selectConversation("conv-old")
        model.startFreshDraft()
        model.userMessageText = "Nowe pytanie"
        await model.selectConversation("conv-old")
        XCTAssertEqual(model.userMessageText, "")
        model.startFreshDraft()
        XCTAssertEqual(model.userMessageText, "Nowe pytanie", "the fresh draft keeps its own text")
    }

    // MARK: Stale alerts (stale-alerts.v1)

    func testRescueAlertTurnsStaleAfterThirtyMinutesFromItsLastPush() {
        func rescue(notifiedMinutesAgo: Double, reminderMinutesAgo: Double? = nil) -> ConversationRescueCarbs {
            ConversationRescueCarbs(alert_id: "a", status: "NOTIFIED", level: "PREDICTED_LOW", glucose_readings: [], prediction: [],
                                    notified_at: iso(-notifiedMinutesAgo * 60), reminder_sent_at: reminderMinutesAgo.map { iso(-$0 * 60) })
        }
        XCTAssertNil(AlertStaleness.stale(rescue(notifiedMinutesAgo: 29), now: now))
        XCTAssertNotNil(AlertStaleness.stale(rescue(notifiedMinutesAgo: 31), now: now))
        XCTAssertNil(AlertStaleness.stale(rescue(notifiedMinutesAgo: 40, reminderMinutesAgo: 20), now: now), "its reminder is the latest alert")

        let twoHours = AlertStaleness.stale(rescue(notifiedMinutesAgo: 125), now: now)
        XCTAssertEqual(twoHours?.badge, "Nieaktualne · 2 godz. temu")
        XCTAssertEqual(twoHours?.alertReason(loop: LoopSystemKind.trio.names), "Alarm sprzed 2 godz. Do Trio nic nie wyślę; możesz zapisać, co podano.")
        XCTAssertEqual(twoHours?.alertReason(loop: LoopSystemKind.unknown.names), "Alarm sprzed 2 godz. Do pętli nic nie wyślę; możesz zapisać, co podano.")
        let fortyFive = AlertStaleness.stale(rescue(notifiedMinutesAgo: 45), now: now)
        XCTAssertEqual(fortyFive?.badge, "Nieaktualne · 45 min temu")
        XCTAssertEqual(fortyFive?.alertReason(loop: LoopSystemKind.trio.names), "Alarm sprzed 45 min. Do Trio nic nie wyślę; możesz zapisać, co podano.")
        XCTAssertEqual(AlertStaleness.stale(rescue(notifiedMinutesAgo: 26 * 60), now: now)?.alertReason(loop: LoopSystemKind.trio.names), "Alarm sprzed 1 dnia. Do Trio nic nie wyślę; możesz zapisać, co podano.")
        XCTAssertEqual(AlertStaleness.ago(3 * 86_400), "3 dni temu")
    }

    func testHypoIsStaleOnlyOnceEndedAndCardsCountFromTheirProposal() {
        let open = ConversationHypo(episode_id: "e", state: "OPEN", severity: "L1", started_at: iso(-3 * 3_600), ended_at: nil, duration_minutes: nil, minimum_glucose: 55, glucose_readings: [])
        XCTAssertNil(AlertStaleness.stale(open, now: now), "a hypo still going on is current")
        let ended = ConversationHypo(episode_id: "e", state: "CLOSED", severity: "L1", started_at: iso(-3 * 3_600), ended_at: iso(-2 * 3_600), duration_minutes: 60, minimum_glucose: 55, glucose_readings: [])
        XCTAssertEqual(AlertStaleness.stale(ended, now: now)?.badge, "Nieaktualne · 3 godz. temu")

        let freshCard = ConversationRescueCarbProposal(id: "c1", carbs_g: 6, status: "PROPOSED", created_at: iso(-5 * 60))
        let oldCard = ConversationRescueCarbProposal(id: "c2", carbs_g: 6, status: "PROPOSED", created_at: iso(-50 * 60))
        XCTAssertNil(AlertStaleness.stale(freshCard, now: now))
        XCTAssertEqual(AlertStaleness.stale(oldCard, now: now)?.cardReason(loop: LoopSystemKind.trio.names), "Propozycja sprzed 50 min. Do Trio nic nie wyślę; możesz zapisać, co podano.")
    }

    func testAStaleAlertStillLogsAndDeclines() async {
        // stale-alerts.v1: only sending to the loop is refused for an old alert; logging and "Nie podaję" go through.
        let api = FreshStubAPI()
        api.rescueAlert("conv-rescue", notifiedAt: Date().addingTimeInterval(-2 * 3_600))
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-rescue")
        XCTAssertNotNil(model.rescueCarbs)
        XCTAssertNotNil(AlertStaleness.stale(model.rescueCarbs!, now: Date()), "the alert is shown as stale")

        let closes = await model.logRescueCarbs(carbsG: 4, givenAt: nil)
        XCTAssertTrue(closes)
        XCTAssertNil(model.rescueCarbsNotice)
        XCTAssertNil(model.rescueCarbsError)
        await model.declineRescueCarbs()
        XCTAssertNil(model.rescueCarbsNotice)
        XCTAssertEqual(api.rescuePosts, 2, "both reached the server")
    }

    func testAStaleRefusalFromTheServerShowsALogOnlyNotice() async {
        let api = FreshStubAPI()
        api.rescueAlert("conv-rescue", notifiedAt: Date().addingTimeInterval(-2 * 3_600))
        api.rescueActionsStale = true
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        await model.selectConversation("conv-rescue")
        let closes = await model.logRescueCarbs(carbsG: 4, givenAt: nil)
        XCTAssertTrue(closes)
        XCTAssertEqual(model.rescueCarbsNotice, ConversationViewModel.staleAlertNotice)
        XCTAssertTrue(ConversationViewModel.staleAlertNotice.contains("zapisać, co podano"))
    }

    func testAStaleAlertShowsItsOwnReadingAsThen() {
        let rescue = ConversationRescueCarbs(alert_id: "a", status: "NOTIFIED", level: "PREDICTED_LOW", glucose_mgdl: 65, glucose_readings: [], prediction: [],
                                             latest_glucose: RescueGlucosePoint(time: iso(-60), value: 140), notified_at: iso(-2 * 3_600))
        XCTAssertEqual(rescue.alertGlucoseLine, "65 mg/dL", "the alert's reading, not the latest glucose")
        XCTAssertEqual(rescue.glucoseLine, "140 mg/dL")
    }

    // MARK: Helpers

    private func makeModel(_ api: FreshStubAPI) -> ConversationViewModel {
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", pollInterval: .milliseconds(1))
        let now = self.now
        model.now = { now }
        return model
    }

    private func iso(_ offset: TimeInterval) -> String {
        FreshStubAPI.iso(now.addingTimeInterval(offset))
    }

    private func message(id: String, role: String, at: String) -> ConversationMessage {
        ConversationMessage(id: id, role: role, message_type: role == "USER" ? "USER_MESSAGE" : "ASSISTANT_MESSAGE", content: "x", question_id: nil, answer_type: nil, answer_text: nil, ai_cost: nil, created_at: at, response_status: nil, analysis_cancellable: nil)
    }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 2) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out"); return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
}

private final class FreshStubAPI {
    private var conversations: [String: String] = [:]
    private var messages: [String: [String]] = [:]
    private(set) var creations = 0
    private(set) var creationKeys: [String] = []
    var failCreations = 0
    private(set) var posts: [(conversationID: String, content: String)] = []
    var holdPosts = false
    var rescueActionsStale = false
    var rescuePosts = 0
    private var heldPosts: [CheckedContinuation<Void, Never>] = []
    var isHoldingPost: Bool { !heldPosts.isEmpty }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    func conversation(_ id: String, lastMessageAt: Date) {
        messages[id] = [
            Self.message(id: "\(id)-u0", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzień?", at: lastMessageAt.addingTimeInterval(-60)),
            Self.message(id: "\(id)-a0", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Spokojnie.", at: lastMessageAt),
        ]
        conversations[id] = ""
    }

    func rescueAlert(_ id: String, notifiedAt: Date) {
        messages[id] = []
        let at = Self.iso(notifiedAt)
        conversations[id] = #","trigger_type":"RESCUE_CARBS","rescue_carbs":{"alert_id":"alert-1","status":"NOTIFIED","level":"PREDICTED_LOW","detected_at":"\#(at)","notified_at":"\#(at)","glucose_readings":[],"prediction":[],"proposal":{"carbs_g":4,"basis":"FORMULA","explanation":[],"warnings":[]}}"#
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
        httpClient: FreshHTTPClient { [unowned self] request in
            try await self.handle(request)
        }
    )

    private func handle(_ request: URLRequest) async throws -> (Data, Int) {
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init)
        guard let index = parts.firstIndex(of: "conversations") else {
            return (Data("{}".utf8), 404)
        }
        if request.httpMethod == "POST", index == parts.count - 1 {
            creations += 1
            creationKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
            if failCreations > 0 {
                failCreations -= 1
                throw URLError(.notConnectedToInternet)
            }
            messages["conv-new"] = []
            conversations["conv-new"] = ""
            return (Data(#"{"conversation":\#(conversationJSON("conv-new"))}"#.utf8), 200)
        }
        guard index + 1 < parts.count else { return (Data("{}".utf8), 404) }
        let conversationID = parts[index + 1]

        if request.httpMethod == "POST", parts.contains("rescue-carbs") {
            rescuePosts += 1
            if rescueActionsStale {
                return (Data(#"{"type":"https://mellis.invalid/problems/rescue_alert_stale","title":"Alarm jest nieaktualny","status":409,"code":"RESCUE_ALERT_STALE"}"#.utf8), 409)
            }
            return (Data("{}".utf8), 200)
        }

        if request.httpMethod == "POST" {
            let payload = try JSONDecoder().decode(UserMessageSubmissionRequest.self, from: request.httpBody ?? Data())
            if holdPosts {
                await withCheckedContinuation { heldPosts.append($0) }
            }
            let message = Self.message(id: "\(conversationID)-u\(posts.count + 1)", role: "USER", type: "USER_MESSAGE", content: payload.content, at: Date())
            messages[conversationID, default: []].append(message)
            posts.append((conversationID, payload.content))
            messages[conversationID, default: []].append(Self.message(id: "\(conversationID)-a\(posts.count)", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Odpowiedź", at: Date()))
            let body = #"{"message":"# + message + #","conversation":"# + conversationJSON(conversationID) + #","decision":"DIRECT_RESPONSE"}"#
            return (Data(body.utf8), 200)
        }

        guard messages[conversationID] != nil else {
            return (Data("{}".utf8), 404)
        }
        return (Data(conversationJSON(conversationID).utf8), 200)
    }

    private func conversationJSON(_ id: String) -> String {
        #"{"id":"\#(id)","patient_id":"patient-1","origin":"USER","awaiting_user_answer":false,"messages":[\#((messages[id] ?? []).joined(separator: ","))],"processing":null\#(conversations[id] ?? "")}"#
    }

    static func message(id: String, role: String, type: String, content: String, at: Date) -> String {
        #"{"id":"\#(id)","role":"\#(role)","message_type":"\#(type)","content":"\#(content)","created_at":"\#(iso(at))"}"#
    }
}

private final class FreshHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
