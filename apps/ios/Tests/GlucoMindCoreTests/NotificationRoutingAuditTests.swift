import XCTest
@testable import GlucoMindCore

/// Audit 2026-10-26: a reminder with only a patient still opens the patient; two reminders of one conversation are two taps.
@MainActor
final class NotificationRoutingAuditTests: XCTestCase {
    private let patient = "11111111-1111-4111-8111-111111111111"
    private let conversation = "22222222-2222-4222-8222-222222222222"

    override func setUp() {
        super.setUp()
        RemoteNotificationInbox.shared.resetForTesting()
    }

    override func tearDown() {
        RemoteNotificationInbox.shared.resetForTesting()
        super.tearDown()
    }

    func testACareReminderWithOnlyThePatientOpensThePatient() {
        let payload: [AnyHashable: Any] = ["gluco": ["type": "care_reminder", "patientId": patient, "reminderId": "r1", "routePath": "/patients/\(patient)"]]
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .patient(patientID: patient))
        // Without a routePath too.
        XCTAssertEqual(AppRoute.parse(pushPayload: ["gluco": ["type": "care_reminder", "patientId": patient]]), .patient(patientID: patient))
        XCTAssertEqual(AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patient)")!), .patient(patientID: patient))
    }

    func testRicherRoutesStillWin() {
        let withConversation: [AnyHashable: Any] = ["gluco": ["type": "care_reminder", "patientId": patient, "conversationId": conversation, "routePath": "/patients/\(patient)/conversations/\(conversation)"]]
        XCTAssertEqual(AppRoute.parse(pushPayload: withConversation), .conversation(ConversationRoute(patientID: patient, conversationID: conversation)))
        // An unknown push type with only a patient id leads nowhere; a bad id neither.
        XCTAssertNil(AppRoute.parse(pushPayload: ["gluco": ["type": "something_new", "patientId": patient]]))
        XCTAssertNil(AppRoute.parse(pushPayload: ["gluco": ["type": "care_reminder", "patientId": "nope"]]))
        XCTAssertNil(PatientLinkParser.parsePath("/patients/\(patient)/meals"))
    }

    func testTwoRemindersOfOneConversationAreTwoTaps() {
        let inbox = RemoteNotificationInbox.shared
        var delivered: [String] = []
        inbox.bind(onPushPayload: { userInfo in
            delivered.append(((userInfo["gluco"] as? [String: Any])?["reminderId"] as? String) ?? "")
        }, onDeviceToken: { _ in })
        let reminder = { (id: String) -> [AnyHashable: Any] in
            ["gluco": ["type": "care_reminder", "patientId": self.patient, "conversationId": self.conversation, "reminderId": id]]
        }
        inbox.receivePushPayload(reminder("r1"))
        inbox.receivePushPayload(reminder("r2"))
        // The same reminder twice (a copy of one tap) is still one.
        inbox.receivePushPayload(reminder("r2"))
        XCTAssertEqual(delivered, ["r1", "r2"])
    }

    func testTwoAnswersOfOneConversationAreTwoTaps() {
        let inbox = RemoteNotificationInbox.shared
        var count = 0
        inbox.bind(onPushPayload: { _ in count += 1 }, onDeviceToken: { _ in })
        let answer = { (body: String) -> [AnyHashable: Any] in
            ["aps": ["alert": ["title": "Odpowiedź gotowa", "body": body]], "gluco": ["type": "conversation_answer", "patientId": self.patient, "conversationId": self.conversation]]
        }
        inbox.receivePushPayload(answer("Pierwsza"))
        inbox.receivePushPayload(answer("Druga"))
        inbox.receivePushPayload(answer("Druga"))
        XCTAssertEqual(count, 2)
    }

    func testAMissedWbtReminderSaysToCheckAndOffersNoSwitch() throws {
        let json = #"{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-10-26T10:30:00Z","wait_until":null,"status":"MISSED","enabled":true,"fired_at":null,"note":"Przypomnienie o WBT minęło — sprawdź, czy WBT jest jeszcze potrzebne."}"#
        let reminder = try JSONDecoder().decode(MealJournalReminder.self, from: Data(json.utf8))
        XCTAssertEqual(reminder.status, .missed)
        let state = MealWbtReminderState(reminder: reminder, mealStart: nil, now: Date())
        XCTAssertEqual(state.note, "Przypomnienie o WBT minęło — sprawdź, czy WBT jest jeszcze potrzebne.")
        XCTAssertFalse(state.canSwitch)
        XCTAssertFalse(state.isOn)
        // A skip after a server outage says so instead of "wygasło".
        let stale = try JSONDecoder().decode(MealJournalReminder.self, from: Data(#"{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-10-26T10:30:00Z","wait_until":null,"status":"EXPIRED","enabled":true,"fired_at":null,"note":"Przypomnienie o WBT nie zostało wysłane (przerwa serwera)."}"#.utf8))
        XCTAssertEqual(MealWbtReminderState(reminder: stale, mealStart: nil, now: Date()).note, "Przypomnienie o WBT nie zostało wysłane (przerwa serwera).")
    }
}
