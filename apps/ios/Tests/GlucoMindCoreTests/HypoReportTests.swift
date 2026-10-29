import XCTest
@testable import GlucoMindCore

@MainActor
final class HypoReportTests: XCTestCase {
    func testDecodesTheHypoScreenOfAConversation() throws {
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: HypoConversationAPI.conversationData(report: nil))

        XCTAssertEqual(conversation.episode_id, "episode-1")
        let hypo = try XCTUnwrap(conversation.hypo)
        XCTAssertEqual(hypo.minimum_glucose, 58)
        XCTAssertEqual(hypo.duration_minutes, 25)
        XCTAssertEqual(hypo.glucose_readings.count, 2)
        // The old report form's fields still come with it: they are not read, and do not break the decoding.
        XCTAssertEqual(hypo.state, "CLOSED")
    }

    func testConversationsWithoutAHypoStillDecode() throws {
        let json = """
        {"id":"c","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"messages":[],"analysis_id":null,"recommendation_id":null}
        """
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: Data(json.utf8))
        XCTAssertNil(conversation.episode_id)
        XCTAssertNil(conversation.hypo)
    }

    func testAHypoConversationOpensWithItsChat() async {
        let api = HypoConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-hypo", pollInterval: .milliseconds(1))
        await model.loadConversation()
        XCTAssertEqual(model.hypo?.minimum_glucose, 58)
        XCTAssertTrue(model.canSendUserMessage)
    }

    func testGramsAreWrittenWithAComma() {
        XCTAssertEqual(HypoFormat.grams(7.5), "7,5")
        XCTAssertEqual(HypoFormat.grams(8), "8")
    }
}

@MainActor
private final class HypoConversationAPI {
    lazy var client: APIClient = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authProvider: HypoStubAuthProvider(),
        httpClient: HypoClosureHTTPClient { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/conversations/conv-hypo") && request.httpMethod == "GET" {
                return (Self.conversationData(report: nil), 200)
            }
            return (Data(), 404)
        }
    )

    static func conversationData(report: String?) -> Data {
        let reportJSON = report ?? #"{"activity":null,"activity_note":null,"rescue_carbs":null,"rescue_carbs_g":null,"rescue_carbs_entry_event_id":null,"note":null}"#
        let updatedAt = report == nil ? "null" : #""2026-10-17T09:00:00.000Z""#
        let json = """
        {
            "id":"conv-hypo",
            "patient_id":"patient-1",
            "episode_id":"episode-1",
            "origin":"SYSTEM",
            "trigger_type":"HYPO_DETECTED",
            "conversation_type":"TRIGGER_INITIATED",
            "awaiting_user_answer":false,
            "pending_question":null,
            "messages":[],
            "analysis_id":null,
            "recommendation_id":null,
            "hypo":{
                "episode_id":"episode-1",
                "state":"CLOSED",
                "severity":"L1",
                "started_at":"2026-10-17T08:00:00.000Z",
                "ended_at":"2026-10-17T08:25:00.000Z",
                "duration_minutes":25,
                "minimum_glucose":58,
                "glucose_readings":[
                    {"observed_at":"2026-10-17T07:55:00.000Z","glucose_mgdl":74},
                    {"observed_at":"2026-10-17T08:10:00.000Z","glucose_mgdl":58}
                ],
                "logged_carb_entries":[{"event_id":"entry-1","occurred_at":"2026-10-17T08:05:00.000Z","carbs_g":10,"kind":"MEAL"}],
                "report":\(reportJSON),
                "report_updated_at":\(updatedAt),
                "report_options":{
                    "activity":[
                        {"value":"NONE","label":"Nie było"},
                        {"value":"LAST_HOUR","label":"W ostatniej godzinie"},
                        {"value":"ONE_TO_THREE_HOURS","label":"1–3 h przed"},
                        {"value":"EARLIER_TODAY","label":"Wcześniej tego dnia"},
                        {"value":"UNKNOWN","label":"Nie wiem"}
                    ],
                    "rescue_carb_amounts_g":[2,4,6,8,10,15]
                }
            }
        }
        """
        return Data(json.utf8)
    }
}

private struct HypoStubAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "user-1" }
}

private final class HypoClosureHTTPClient: HTTPClient {
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
