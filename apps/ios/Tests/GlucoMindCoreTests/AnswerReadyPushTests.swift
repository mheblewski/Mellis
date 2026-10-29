import XCTest
@testable import GlucoMindCore

/// answer-ready-push.v1: "Odpowiedź gotowa" opens the conversation or the meal it answers, and the open app shows no
/// banner for it.
final class AnswerReadyPushTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"
    private let conversationID = "22222222-2222-4222-8222-222222222222"
    private let mealID = "44444444-4444-4444-8444-444444444444"

    func testConversationAnswerOpensItsConversation() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "conversation_answer",
            "patientId": patientID,
            "conversationId": conversationID,
            "routePath": "/patients/\(patientID)/conversations/\(conversationID)",
        ]]

        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .conversation(ConversationRoute(patientID: patientID, conversationID: conversationID, questionID: nil)))
        XCTAssertTrue(PushPayloadParser.isAnswerReady(userInfo: payload))
    }

    func testMealChatAnswerOpensItsMeal() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "meal_chat_answer",
            "patientId": patientID,
            "mealId": mealID,
            "routePath": "/patients/\(patientID)/meals/\(mealID)",
        ]]

        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .meal(MealRoute(patientID: patientID, mealID: mealID)))
        XCTAssertTrue(PushPayloadParser.isAnswerReady(userInfo: payload))
    }

    func testDoseGivenByTheOtherCaregiverOpensTheMeal() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "dose_given",
            "patientId": patientID,
            "mealId": mealID,
            "routePath": "/patients/\(patientID)/meals/\(mealID)",
        ]]

        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .meal(MealRoute(patientID: patientID, mealID: mealID)))
        XCTAssertFalse(PushPayloadParser.isAnswerReady(userInfo: payload))
    }

    func testOtherPushesStillShowABannerInTheOpenApp() {
        for type in ["conversation_question", "rescue_carbs", "wbt_reminder", "loop_action"] {
            XCTAssertFalse(PushPayloadParser.isAnswerReady(userInfo: ["gluco": ["type": type]]), type)
        }
        XCTAssertFalse(PushPayloadParser.isAnswerReady(userInfo: [:]))
    }

    func testTheSwitchIsOnWhenAnOlderServerDoesNotSendIt() throws {
        let json = #"{"device_id":"d1","rescue_carb_alerts_enabled":false,"hypo_report_push_enabled":true}"#
        let settings = try JSONDecoder().decode(DeviceNotificationSettings.self, from: Data(json.utf8))
        XCTAssertTrue(settings.answer_ready_push_enabled)

        let off = #"{"device_id":"d1","rescue_carb_alerts_enabled":false,"hypo_report_push_enabled":true,"answer_ready_push_enabled":false}"#
        XCTAssertFalse(try JSONDecoder().decode(DeviceNotificationSettings.self, from: Data(off.utf8)).answer_ready_push_enabled)
    }
}
