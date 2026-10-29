import XCTest
@testable import GlucoMindCore

@MainActor
final class PushInboxTests: XCTestCase {
    private let allowedPatientID = "11111111-1111-4111-8111-111111111111"
    private let conversationID = "22222222-2222-4222-8222-222222222222"
    private let questionID = "activity_before_drop"

    override func setUp() {
        super.setUp()
        RemoteNotificationInbox.shared.resetForTesting()
    }

    override func tearDown() {
        RemoteNotificationInbox.shared.resetForTesting()
        super.tearDown()
    }

    func testColdLaunchPayloadArrivesBeforeNavigatorAndOpensConversationAfterBinding() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.receivePushPayload(makePayload())

        inbox.bind(
            onPushPayload: { userInfo in
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        XCTAssertEqual(
            navigator.route,
            ConversationRoute(
                patientID: allowedPatientID,
                conversationID: conversationID,
                questionID: questionID
            )
        )
    }

    func testColdLaunchAndDelegateDuplicatePayloadOpensExactlyOnce() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        var deliveryCount = 0

        inbox.receiveLaunchPayload(makePayload())

        inbox.bind(
            onPushPayload: { userInfo in
                deliveryCount += 1
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload(makePayload())
        inbox.flushLaunchCopy()

        XCTAssertEqual(deliveryCount, 1)
        XCTAssertEqual(
            navigator.route,
            ConversationRoute(patientID: allowedPatientID, conversationID: conversationID, questionID: questionID)
        )
    }

    func testColdLaunchTapCapturedBeforeBindIsReplayedOnceAfterBind() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        var deliveryCount = 0

        // Simulate cold launch: launch options and tap callback can both arrive before UI binds.
        inbox.receiveLaunchPayload(makePayload())
        inbox.receivePushPayload(makePayload())

        inbox.bind(
            onPushPayload: { userInfo in
                deliveryCount += 1
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )
        inbox.flushLaunchCopy()

        XCTAssertEqual(deliveryCount, 1)
        XCTAssertEqual(
            navigator.route,
            ConversationRoute(patientID: allowedPatientID, conversationID: conversationID, questionID: questionID)
        )
    }

    func testLaunchCopyOpensWhenTheDelegateCopyNeverComes() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        inbox.launchCopyDelay = 3_600

        inbox.receiveLaunchPayload(makePayload())
        inbox.bind(onPushPayload: { navigator.handle($0) }, onDeviceToken: { _ in })
        XCTAssertNil(navigator.route)

        inbox.flushLaunchCopy()

        XCTAssertEqual(navigator.routes.count, 1)
        XCTAssertEqual(navigator.route?.conversationID, conversationID)
    }

    func testLateLaunchCopyAfterTheDelegateCopyIsIgnored() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        inbox.launchCopyDelay = 3_600
        inbox.bind(onPushPayload: { navigator.handle($0) }, onDeviceToken: { _ in })
        inbox.receivePushPayload(makePayload())
        inbox.receiveLaunchPayload(makePayload())
        inbox.flushLaunchCopy()

        XCTAssertEqual(navigator.routes.count, 1)
    }

    func testSameNotificationOpensAgainAfterTheDuplicateWindow() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        var clock = Date(timeIntervalSince1970: 1_000_000)
        inbox.now = { clock }

        inbox.bind(onPushPayload: { navigator.handle($0) }, onDeviceToken: { _ in })
        inbox.receivePushPayload(makePayload())
        clock.addTimeInterval(2)
        inbox.receivePushPayload(makePayload())
        XCTAssertEqual(navigator.routes.count, 1)

        clock.addTimeInterval(RemoteNotificationInbox.duplicateWindow)
        inbox.receivePushPayload(makePayload())
        XCTAssertEqual(navigator.routes.count, 2)
    }

    func testTwoSplitBolusRemindersOfOneMealAreBothDelivered() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        let mealID = "44444444-4444-4444-8444-444444444444"
        func plan(_ id: String) -> [AnyHashable: Any] {
            ["gluco": ["type": "planned_bolus", "patientId": allowedPatientID, "mealId": mealID, "plannedBolusId": id]]
        }

        inbox.bind(onPushPayload: { navigator.handle($0) }, onDeviceToken: { _ in })
        inbox.receivePushPayload(plan("99999999-9999-4999-8999-999999999991"))
        inbox.receivePushPayload(plan("99999999-9999-4999-8999-999999999992"))

        XCTAssertEqual(navigator.routes.count, 2)
        // The latest tap opens its own part.
        XCTAssertEqual(navigator.mealRoute, MealRoute(patientID: allowedPatientID, mealID: mealID, opensPlannedBolus: true, plannedBolusID: "99999999-9999-4999-8999-999999999992"))
    }

    func testRemoteCommandNotificationsOpenThePatientsBolusTab() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.bind(onPushPayload: { navigator.handle($0) }, onDeviceToken: { _ in })
        inbox.receivePushPayload(AppRoute.remoteCommandPayload(patientID: allowedPatientID))
        inbox.receivePushPayload(AppRoute.remoteCommandPayload(patientID: allowedPatientID))

        XCTAssertEqual(navigator.routes, [.remoteCommands(patientID: allowedPatientID), .remoteCommands(patientID: allowedPatientID)])
    }

    func testBackgroundTapOpensConversationWhenInboxIsAlreadyBound() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.bind(
            onPushPayload: { userInfo in
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload(makePayload())

        XCTAssertEqual(
            navigator.route,
            ConversationRoute(patientID: allowedPatientID, conversationID: conversationID, questionID: questionID)
        )
    }

    func testForegroundFlowUsingRoutePathStillOpensConversation() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.bind(
            onPushPayload: { userInfo in
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload([
            "gluco": [
                "type": "conversation_question",
                "routePath": "/patients/\(allowedPatientID)/conversations/\(conversationID)"
            ]
        ])

        XCTAssertEqual(
            navigator.route,
            ConversationRoute(
                patientID: allowedPatientID,
                conversationID: conversationID
            )
        )
    }

    func testValidPayloadForDifferentPatientStillRoutesInInboxLayer() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.bind(
            onPushPayload: { userInfo in
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        let patientID = "33333333-3333-4333-8333-333333333333"
        inbox.receivePushPayload(makePayload(patientID: patientID))

        XCTAssertEqual(
            navigator.route,
            ConversationRoute(patientID: patientID, conversationID: conversationID, questionID: questionID)
        )
    }

    func testMalformedPayloadDoesNotCrashOrNavigate() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()

        inbox.bind(
            onPushPayload: { userInfo in
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload([
            "gluco": [
                "type": "conversation_question",
                "patientId": "not-a-uuid",
                "conversationId": "also-not-a-uuid"
            ]
        ])

        XCTAssertNil(navigator.route)
    }

    func testRepeatedSameNotificationDoesNotTriggerSecondNavigationEvent() {
        let inbox = RemoteNotificationInbox.shared
        let navigator = RouteRecorder()
        var deliveryCount = 0

        inbox.bind(
            onPushPayload: { userInfo in
                deliveryCount += 1
                navigator.handle(userInfo)
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload(makePayload())
        inbox.receivePushPayload(makePayload())

        XCTAssertEqual(deliveryCount, 1)
        XCTAssertEqual(
            navigator.route,
            ConversationRoute(patientID: allowedPatientID, conversationID: conversationID, questionID: questionID)
        )
    }

    func testWbtRemindersForDifferentMealsAreBothDelivered() {
        let inbox = RemoteNotificationInbox.shared
        var deliveredMeals: [String] = []

        inbox.bind(
            onPushPayload: { userInfo in
                if let route = MealLinkParser.parsePushPayload(userInfo: userInfo) {
                    deliveredMeals.append(route.mealID)
                }
            },
            onDeviceToken: { _ in }
        )

        let firstMeal = "44444444-4444-4444-8444-444444444444"
        let secondMeal = "55555555-5555-4555-8555-555555555555"
        inbox.receivePushPayload(makeWbtPayload(mealID: firstMeal))
        inbox.receivePushPayload(makeWbtPayload(mealID: firstMeal))
        inbox.receivePushPayload(makeWbtPayload(mealID: secondMeal))

        XCTAssertEqual(deliveredMeals, [firstMeal, secondMeal])
    }

    func testRescueCarbsReminderIsDeliveredAfterTheFirstPushButColdLaunchCopiesAreNot() {
        let inbox = RemoteNotificationInbox.shared
        var titles: [String] = []

        inbox.bind(
            onPushPayload: { userInfo in
                if PushPayloadParser.parseConversationRoute(userInfo: userInfo) != nil {
                    titles.append(((userInfo["aps"] as? [String: Any])?["alert"] as? [String: Any])?["title"] as? String ?? "")
                }
            },
            onDeviceToken: { _ in }
        )

        inbox.receivePushPayload(makeRescuePayload(title: "Możliwe niedocukrzenie"))
        inbox.receivePushPayload(makeRescuePayload(title: "Możliwe niedocukrzenie"))
        inbox.receivePushPayload(makeRescuePayload(title: "Możliwe niedocukrzenie (przypomnienie)"))

        XCTAssertEqual(titles, ["Możliwe niedocukrzenie", "Możliwe niedocukrzenie (przypomnienie)"])
    }

    private func makeRescuePayload(title: String) -> [AnyHashable: Any] {
        [
            "aps": ["alert": ["title": title, "body": "Ok. 14:20 może spaść poniżej 70 · proponuję 4 g"], "interruption-level": "time-sensitive"],
            "gluco": [
                "type": "rescue_carbs",
                "patientId": allowedPatientID,
                "conversationId": conversationID,
                "alertId": "66666666-6666-4666-8666-666666666666",
                "routePath": "/patients/\(allowedPatientID)/conversations/\(conversationID)",
                "universalLink": "https://app.mellis.invalid/patients/\(allowedPatientID)/conversations/\(conversationID)"
            ]
        ]
    }

    private func makeWbtPayload(mealID: String) -> [AnyHashable: Any] {
        [
            "gluco": [
                "type": "wbt_reminder",
                "patientId": allowedPatientID,
                "mealId": mealID,
                "routePath": "/patients/\(allowedPatientID)/meals/\(mealID)/wbt",
                "universalLink": "https://app.mellis.invalid/patients/\(allowedPatientID)/meals/\(mealID)/wbt"
            ]
        ]
    }

    private func makePayload(
        patientID: String? = nil,
        conversationID: String? = nil,
        questionID: String? = nil
    ) -> [AnyHashable: Any] {
        [
            "gluco": [
                "type": "conversation_question",
                "patientId": patientID ?? allowedPatientID,
                "conversationId": conversationID ?? self.conversationID,
                "questionId": questionID ?? self.questionID,
                "routePath": "/patients/\(patientID ?? allowedPatientID)/conversations/\(conversationID ?? self.conversationID)",
                "universalLink": "https://app.mellis.invalid/patients/\(patientID ?? allowedPatientID)/conversations/\(conversationID ?? self.conversationID)"
            ]
        ]
    }
}
