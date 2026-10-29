import XCTest
@testable import GlucoMindCore

final class RoutingTests: XCTestCase {
    func testUniversalLinkParsing() {
        let url = URL(string: "https://app.mellis.invalid/patients/11111111-1111-4111-8111-111111111111/conversations/22222222-2222-4222-8222-222222222222")!
        let route = UniversalLinkParser.parse(url)
        XCTAssertEqual(route, ConversationRoute(patientID: "11111111-1111-4111-8111-111111111111", conversationID: "22222222-2222-4222-8222-222222222222"))
    }

    func testInvalidUniversalLinkFailsSafely() {
        let url = URL(string: "https://evil.example.com/patients/11111111-1111-4111-8111-111111111111/conversations/22222222-2222-4222-8222-222222222222")!
        XCTAssertNil(UniversalLinkParser.parse(url))
    }

    func testPushPayloadParsing() {
        let payload: [AnyHashable: Any] = [
            "gluco": [
                "type": "conversation_question",
                "patientId": "11111111-1111-4111-8111-111111111111",
                "conversationId": "22222222-2222-4222-8222-222222222222"
            ]
        ]

        let route = PushPayloadParser.parseConversationRoute(userInfo: payload)
        XCTAssertEqual(route, ConversationRoute(patientID: "11111111-1111-4111-8111-111111111111", conversationID: "22222222-2222-4222-8222-222222222222"))
    }

    func testPushPayloadParsingFromRouteMetadata() {
        let payload: [AnyHashable: Any] = [
            "gluco": [
                "type": "conversation_question",
                "routePath": "/patients/11111111-1111-4111-8111-111111111111/conversations/22222222-2222-4222-8222-222222222222"
            ]
        ]

        let route = PushPayloadParser.parseConversationRoute(userInfo: payload)
        XCTAssertEqual(route, ConversationRoute(patientID: "11111111-1111-4111-8111-111111111111", conversationID: "22222222-2222-4222-8222-222222222222"))
    }

    func testMalformedPushPayloadFailsSafely() {
        let payload: [AnyHashable: Any] = [
            "gluco": [
                "type": "conversation_question",
                "patientId": "not-a-uuid",
                "conversationId": "also-not-a-uuid"
            ]
        ]

        XCTAssertNil(PushPayloadParser.parseConversationRoute(userInfo: payload))
    }

    @MainActor
    func testNavigatorOpensConversationFromPush() {
        let navigator = RouteRecorder()
        navigator.handle([
            "gluco": [
                "type": "conversation_question",
                "patientId": "11111111-1111-4111-8111-111111111111",
                "conversationId": "22222222-2222-4222-8222-222222222222"
            ]
        ])

        XCTAssertEqual(navigator.route, ConversationRoute(patientID: "11111111-1111-4111-8111-111111111111", conversationID: "22222222-2222-4222-8222-222222222222"))
    }

    func testRescueCarbsPushOpensTheAlertsConversation() {
        let patientID = "11111111-1111-4111-8111-111111111111"
        let conversationID = "22222222-2222-4222-8222-222222222222"
        let expected = ConversationRoute(patientID: patientID, conversationID: conversationID)

        XCTAssertEqual(PushPayloadParser.parseConversationRoute(userInfo: [
            "gluco": ["type": "rescue_carbs", "patientId": patientID, "conversationId": conversationID, "alertId": "33333333-3333-4333-8333-333333333333"]
        ]), expected)
        XCTAssertEqual(PushPayloadParser.parseConversationRoute(userInfo: [
            "gluco": ["type": "rescue_carbs", "universalLink": "https://app.mellis.invalid/patients/\(patientID)/conversations/\(conversationID)"]
        ]), expected)
        XCTAssertEqual(PushPayloadParser.parseConversationRoute(userInfo: [
            "gluco": ["type": "rescue_carbs", "routePath": "/patients/\(patientID)/conversations/\(conversationID)"]
        ]), expected)
        XCTAssertNil(MealLinkParser.parsePushPayload(userInfo: ["gluco": ["type": "rescue_carbs", "patientId": patientID, "conversationId": conversationID]]))
        XCTAssertNil(PushPayloadParser.parseConversationRoute(userInfo: ["gluco": ["type": "rescue_carbs", "patientId": "nope", "conversationId": "nope"]]))
    }

    @MainActor
    func testNavigatorOpensTheRescueConversationFromPush() {
        let navigator = RouteRecorder()
        navigator.handle([
            "gluco": [
                "type": "rescue_carbs",
                "patientId": "11111111-1111-4111-8111-111111111111",
                "conversationId": "22222222-2222-4222-8222-222222222222"
            ]
        ])

        XCTAssertEqual(navigator.route, ConversationRoute(patientID: "11111111-1111-4111-8111-111111111111", conversationID: "22222222-2222-4222-8222-222222222222"))
    }
}
