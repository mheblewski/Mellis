import XCTest
@testable import GlucoMindCore

final class CareReminderTests: XCTestCase {
    func testAnAnswerCarriesItsRemindersAndTheirState() throws {
        let json = """
        {"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Przypomnę.","created_at":"2026-10-22T12:00:00Z",
         "care_reminders":[
          {"id":"r1","note":"Sprawdź glukozę po basenie","trigger":"AT_TIME","due_at":"2026-10-22T14:00:00Z","threshold_mgdl":null,"wait_until":null,"status":"ACTIVE","fired_at":null,"fired_reason":null,"cancelled_by_name":null,"described":"czw., 16:00"},
          {"id":"r2","note":"Bolus na resztę","trigger":"GLUCOSE_RISING","due_at":"2026-10-22T12:15:00Z","threshold_mgdl":null,"wait_until":"2026-10-22T15:15:00Z","status":"CANCELLED","fired_at":null,"fired_reason":null,"cancelled_by_name":"Ewa","described":"gdy glukoza zacznie rosnąć (najpóźniej czw., 17:15)"}]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ConversationMessage.self, from: json)
        let reminders = try XCTUnwrap(message.care_reminders)
        XCTAssertEqual(reminders.first?.statusLine, "Przyjdzie: czw., 16:00")
        XCTAssertTrue(reminders.first?.isActive == true)
        XCTAssertEqual(reminders.last?.statusLine, "Anulowane (Ewa)")
    }

    func testAReminderPushOpensItsConversation() {
        let patient = "33333333-3333-4333-8333-333333333333"
        let conversation = "44444444-4444-4444-8444-444444444444"
        let route = PushPayloadParser.parseConversationRoute(userInfo: ["gluco": ["type": "care_reminder", "patientId": patient, "conversationId": conversation, "reminderId": "r1"]])
        XCTAssertEqual(route?.conversationID, conversation)
    }

    func testRescueCarbsGoToTrioAsCarbsAloneForTheirAlertOrCard() throws {
        let base = RemoteBolusDraftBase.rescueCarbs(grams: 8, conversationID: "c1", alertID: "a1", proposalID: "p1")
        XCTAssertTrue(base.isRescue)
        XCTAssertEqual(base.insulinU, 0)
        XCTAssertNil(base.meal)
        let changed = base.with(carbsG: 10, insulinU: 0)
        XCTAssertEqual(changed.rescueAlertID, "a1")
        XCTAssertEqual(changed.rescueProposalID, "p1")
        var request = RemoteCommandAuthorizeRequest(source: .rescueCarbs, carbs_g: 10, insulin_u: 0, bolus_step: Decimal(string: "0.05")!, device_id: "d", conversation_id: "c1", proposal_id: nil, meal: nil, acknowledged_warnings: [])
        request.rescue_alert_id = "a1"
        let json = String(data: try JSONEncoder().encode(request), encoding: .utf8)!
        XCTAssertTrue(json.contains(#""source":"RESCUE_CARBS""#))
        XCTAssertTrue(json.contains(#""rescue_alert_id":"a1""#))
    }
}
