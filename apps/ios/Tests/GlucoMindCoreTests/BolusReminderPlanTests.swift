import XCTest
@testable import GlucoMindCore

final class BolusReminderPlanTests: XCTestCase {
    private var warsaw: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        return calendar
    }

    private let start = ServerDate.parse("2026-10-25T17:05:00.000Z")! // 18:05 in Warsaw

    func testEncodesEachReminderAsTheServerReadsIt() throws {
        let plan = BolusReminderPlan(wbt: true, secondDose: .after(minutes: 30))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan.reminders)) as? [[String: Any]]
        XCTAssertEqual(json?.count, 2)
        XCTAssertEqual(json?[0]["kind"] as? String, "SECOND_DOSE")
        XCTAssertEqual(json?[0]["trigger"] as? String, "AFTER_MINUTES")
        XCTAssertEqual(json?[0]["minutes"] as? Int, 30)
        XCTAssertEqual(json?[1]["kind"] as? String, "WBT")
        XCTAssertNil(json?[1]["trigger"])

        let rising = try JSONSerialization.jsonObject(with: JSONEncoder().encode([BolusReminder.secondDoseWhenRising])) as? [[String: Any]]
        XCTAssertEqual(rising?.first?["trigger"] as? String, "GLUCOSE_RISING")
    }

    func testLeavesTheKeyOutWithoutReminders() throws {
        let request = RemoteCommandAuthorizeRequest(source: .bolusScreen, carbs_g: 45, insulin_u: 4.5, bolus_step: 0.05, device_id: "d", conversation_id: nil, proposal_id: nil, meal: nil, acknowledged_warnings: [])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        XCTAssertNil(json?["reminders"])
        XCTAssertNil(json?["create_meal"])

        var asMeal = request
        asMeal.create_meal = true
        let ticked = try JSONSerialization.jsonObject(with: JSONEncoder().encode(asMeal)) as? [String: Any]
        XCTAssertEqual(ticked?["create_meal"] as? Bool, true)
    }

    func testTheChipSaysWhenItReminds() {
        let both = BolusReminderPlan(wbt: true, secondDose: .after(minutes: 30))
        XCTAssertEqual(both.chipText(from: start, calendar: warsaw), "18:35 · WBT 20:35")
        XCTAssertEqual(BolusReminderPlan(secondDose: .whenRising).chipText(from: start, calendar: warsaw), "Gdy rośnie")
    }

    func testRisingNeedsThreeHigherReadingsOverTenMinutes() {
        let now = ServerDate.parse("2026-10-25T17:20:00.000Z")!
        func reading(_ minutesAgo: Int, _ value: Int) -> DashboardReading {
            DashboardReading(at: ISO8601DateFormatter().string(from: now.addingTimeInterval(TimeInterval(-minutesAgo * 60))), value: value)
        }
        XCTAssertTrue(BolusReminderPlan.isRising([reading(10, 80), reading(5, 84), reading(0, 88)], now: now))
        // One reading lower in between: not rising yet.
        XCTAssertFalse(BolusReminderPlan.isRising([reading(10, 80), reading(5, 79), reading(0, 88)], now: now))
        // Two readings only (5 min): too early to say.
        XCTAssertFalse(BolusReminderPlan.isRising([reading(5, 80), reading(0, 88)], now: now))
        // Less than 3 mg/dL in all.
        XCTAssertFalse(BolusReminderPlan.isRising([reading(10, 80), reading(5, 81), reading(0, 82)], now: now))
        // Old readings say nothing about now.
        XCTAssertFalse(BolusReminderPlan.isRising([reading(40, 80), reading(35, 84), reading(30, 88)], now: now))
    }

    func testASecondDosePushOpensItsMealAndAChatReminderItsConversation() {
        let patient = "11111111-1111-4111-8111-111111111111"
        let meal = "22222222-2222-4222-8222-222222222222"
        let secondDose: [AnyHashable: Any] = ["gluco": ["type": "care_reminder", "patientId": patient, "mealId": meal, "reminderId": "33333333-3333-4333-8333-333333333333", "routePath": "/patients/\(patient)/meals/\(meal)"]]
        XCTAssertEqual(MealLinkParser.parsePushPayload(userInfo: secondDose)?.mealID, meal)

        let chat: [AnyHashable: Any] = ["gluco": ["type": "care_reminder", "patientId": patient, "conversationId": meal]]
        XCTAssertNil(MealLinkParser.parsePushPayload(userInfo: chat))
        XCTAssertEqual(PushPayloadParser.parseConversationRoute(userInfo: chat)?.conversationID, meal)
    }
}
