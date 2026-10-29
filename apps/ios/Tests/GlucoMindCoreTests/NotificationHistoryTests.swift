import XCTest
@testable import GlucoMindCore

final class NotificationHistoryTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"
    private let conversationID = "22222222-2222-4222-8222-222222222222"
    private let mealID = "33333333-3333-4333-8333-333333333333"

    private var json: Data {
        """
        {
          "patient_id":"\(patientID)",
          "items":[
            {"id":"n2","type":"wbt_reminder","title":"Przypomnienie o WBT","body":"Pizza o 18:00","sent_at":"2026-10-17T16:30:00.000Z",
             "payload":{"type":"wbt_reminder","patientId":"\(patientID)","mealId":"\(mealID)","routePath":"/patients/\(patientID)/meals/\(mealID)/wbt","universalLink":"https://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)/wbt"}},
            {"id":"n3","type":"rescue_carbs","title":"Możliwe niedocukrzenie","body":"Ok. 14:20 może spaść poniżej 70 · proponuję 4 g","sent_at":"2026-10-17T07:00:00.000Z",
             "payload":{"type":"rescue_carbs","patientId":"\(patientID)","conversationId":"\(conversationID)","alertId":"\(mealID)","routePath":"/patients/\(patientID)/conversations/\(conversationID)","universalLink":"https://app.mellis.invalid/patients/\(patientID)/conversations/\(conversationID)"}},
            {"id":"n1","type":"conversation_question","title":"Hipo o 10:00","body":"Opisz, co się działo.","sent_at":"2026-10-17T08:00:00.000Z",
             "payload":{"type":"conversation_question","patientId":"\(patientID)","conversationId":"\(conversationID)","questionId":"hypo_report","routePath":"/x","universalLink":"https://app.mellis.invalid/x"}}
          ]
        }
        """.data(using: .utf8)!
    }

    @MainActor
    func testBellOpensLikeTheTappedPush() async throws {
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: FixedHTTPClient(data: json))
        let items = try await client.listNotifications(patientID: patientID).items

        let wbt = MealLinkParser.parsePushPayload(userInfo: items[0].payload.pushUserInfo)
        XCTAssertEqual(wbt, MealRoute(patientID: patientID, mealID: mealID, opensWbt: true))

        let rescue = PushPayloadParser.parseConversationRoute(userInfo: items[1].payload.pushUserInfo)
        XCTAssertEqual(rescue, ConversationRoute(patientID: patientID, conversationID: conversationID))
        XCTAssertEqual((items[1].payload.pushUserInfo["gluco"] as? [String: Any])?["alertId"] as? String, mealID)

        let hypo = PushPayloadParser.parseConversationRoute(userInfo: items[2].payload.pushUserInfo)
        XCTAssertEqual(hypo, ConversationRoute(patientID: patientID, conversationID: conversationID, questionID: "hypo_report"))
    }

    @MainActor
    func testRowsStayNewUntilOpenedOrAllAreMarkedRead() async throws {
        let defaults = UserDefaults(suiteName: "NotificationHistoryTests")!
        defaults.removePersistentDomain(forName: "NotificationHistoryTests")
        let store = NotificationSeenStore(defaults: defaults)
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: FixedHTTPClient(data: json))
        // Everything up to 12:00 was read on an earlier build (the bell's last opening): only the WBT reminder is new.
        store.setLastSeen(ISO8601DateFormatter().date(from: "2026-10-17T12:00:00Z")!, patientID: patientID)
        let viewModel = NotificationHistoryViewModel(apiClient: client, patientID: patientID, seenStore: store)

        await viewModel.refresh()
        XCTAssertTrue(viewModel.hasUnseen)
        XCTAssertEqual(viewModel.items.map(viewModel.isNew), [true, false, false])

        // Opening the row reads it; the read survives the next list and a new view model (another launch).
        viewModel.markRead(viewModel.items[0])
        XCTAssertFalse(viewModel.hasUnseen)
        await viewModel.refresh()
        XCTAssertFalse(viewModel.hasUnseen)
        let relaunched = NotificationHistoryViewModel(apiClient: client, patientID: patientID, seenStore: store)
        await relaunched.refresh()
        XCTAssertFalse(relaunched.hasUnseen)

        // Never read on this phone: every row is new until "Oznacz wszystkie jako przeczytane".
        defaults.removePersistentDomain(forName: "NotificationHistoryTests")
        let fresh = NotificationHistoryViewModel(apiClient: client, patientID: patientID, seenStore: store)
        await fresh.refresh()
        XCTAssertEqual(fresh.items.map(fresh.isNew), [true, true, true])
        fresh.markRead(fresh.items[1])
        XCTAssertEqual(fresh.items.map(fresh.isNew), [true, false, true])
        fresh.markAllRead(now: ISO8601DateFormatter().date(from: "2026-10-17T17:00:00Z")!)
        XCTAssertFalse(fresh.hasUnseen)
        XCTAssertEqual(fresh.items.map(fresh.isNew), [false, false, false])
        XCTAssertEqual(store.readIDs(patientID: patientID), [])
    }

    @MainActor
    func testEveryTabsBellSharesOneRead() async {
        let http = FixedHTTPClient(data: json, delayNanoseconds: 20_000_000)
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: http)
        let viewModel = NotificationHistoryViewModel(apiClient: client, patientID: patientID)

        // Four tabs appear (or the app comes back) at once.
        async let first: Void = viewModel.refreshIfStale()
        async let second: Void = viewModel.refreshIfStale()
        async let third: Void = viewModel.refresh()
        async let fourth: Void = viewModel.refreshIfStale()
        _ = await (first, second, third, fourth)
        XCTAssertEqual(http.reads, 1)
        XCTAssertEqual(viewModel.items.count, 3)
        XCTAssertFalse(viewModel.isLoading)

        // A tab opened a moment later uses the fresh list; a stale one or the bell tap reads again.
        await viewModel.refreshIfStale()
        XCTAssertEqual(http.reads, 1)
        await viewModel.refreshIfStale(now: Date().addingTimeInterval(60))
        XCTAssertEqual(http.reads, 2)
        await viewModel.refresh()
        XCTAssertEqual(http.reads, 3)
    }
}

private final class FixedHTTPClient: HTTPClient, @unchecked Sendable {
    let data: Data
    let delayNanoseconds: UInt64
    private(set) var reads = 0

    init(data: Data, delayNanoseconds: UInt64 = 0) {
        self.data = data
        self.delayNanoseconds = delayNanoseconds
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        reads += 1
        if delayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }
        XCTAssertEqual(request.url?.path.hasSuffix("/notifications"), true)
        XCTAssertEqual(request.url?.query, "limit=50")
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
