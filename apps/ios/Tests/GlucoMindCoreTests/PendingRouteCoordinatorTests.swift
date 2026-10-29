import XCTest
@testable import GlucoMindCore

@MainActor
final class PendingRouteCoordinatorTests: XCTestCase {
    private let patientA = "11111111-1111-4111-8111-111111111111"
    private let patientB = "22222222-2222-4222-8222-222222222222"
    private let stranger = "33333333-3333-4333-8333-333333333333"
    private let conversationID = "44444444-4444-4444-8444-444444444444"
    private let mealID = "55555555-5555-4555-8555-555555555555"
    private let actionID = "66666666-6666-4666-8666-666666666666"
    private let planID = "77777777-7777-4777-8777-777777777777"

    // MARK: - Access and waiting

    func testRouteOfAPatientOnTheListOpensWithoutAskingTheServer() async {
        let env = Env(known: [patientA, patientB])
        let route = AppRoute.conversation(ConversationRoute(patientID: patientB, conversationID: conversationID))

        let outcome = await env.coordinator.receive(route)

        XCTAssertEqual(outcome, .delivered)
        XCTAssertEqual(env.delivered, [route])
        XCTAssertEqual(env.refreshCount, 0)
        XCTAssertNil(env.coordinator.pending)
    }

    func testPatientIDsAreComparedWithoutCase() async {
        let env = Env(known: [patientA.uppercased()])

        let outcome = await env.coordinator.receive(.remoteCommands(patientID: patientA))

        XCTAssertEqual(outcome, .delivered)
    }

    func testPatientMissingFromTheListIsCheckedWithTheServerOnce() async {
        let env = Env(known: [patientA])
        env.serverPatients = [patientA, patientB]
        let route = AppRoute.meal(MealRoute(patientID: patientB, mealID: mealID))

        let outcome = await env.coordinator.receive(route)

        XCTAssertEqual(outcome, .delivered)
        XCTAssertEqual(env.refreshCount, 1)
        XCTAssertEqual(env.delivered, [route])
    }

    func testRouteOfAPatientWithoutAccessIsDroppedAndNothingOpens() async {
        let env = Env(known: [patientA])
        env.serverPatients = [patientA]

        let outcome = await env.coordinator.receive(.conversation(ConversationRoute(patientID: stranger, conversationID: conversationID)))

        XCTAssertEqual(outcome, .rejected)
        XCTAssertTrue(env.delivered.isEmpty)
        XCTAssertNil(env.coordinator.pending)
    }

    func testNetworkFailureKeepsTheRouteAndTheNextAttemptOpensIt() async {
        let env = Env(known: [])
        env.refreshFails = true
        let route = AppRoute.conversation(ConversationRoute(patientID: patientA, conversationID: conversationID))

        let first = await env.coordinator.receive(route)
        XCTAssertEqual(first, .waitingForPatients)
        XCTAssertTrue(env.delivered.isEmpty)
        XCTAssertEqual(env.coordinator.pending, route)

        // The patient list loads later (retry, return to the app).
        env.refreshFails = false
        env.known = [patientA]
        let second = await env.coordinator.resume()

        XCTAssertEqual(second, .delivered)
        XCTAssertEqual(env.delivered, [route])
    }

    func testSignedOutRouteWaitsAndOpensAfterSignIn() async {
        let env = Env(known: [patientA])
        env.signedIn = false
        let route = AppRoute.meal(MealRoute(patientID: patientA, mealID: mealID, opensWbt: true))

        let first = await env.coordinator.receive(route)
        XCTAssertEqual(first, .waitingForSignIn)
        XCTAssertTrue(env.delivered.isEmpty)

        env.signedIn = true
        let second = await env.coordinator.resume()

        XCTAssertEqual(second, .delivered)
        XCTAssertEqual(env.delivered, [route])
    }

    func testRouteWaitsForThePatientListBeingReadWithoutAskingTheServer() async {
        let env = Env(known: nil)
        let route = AppRoute.conversation(ConversationRoute(patientID: patientA, conversationID: conversationID))

        let first = await env.coordinator.receive(route)
        XCTAssertEqual(first, .waitingForPatients)
        XCTAssertEqual(env.refreshCount, 0)

        env.known = [patientA]
        let second = await env.coordinator.resume()
        XCTAssertEqual(second, .delivered)
    }

    func testNewerNotificationReplacesOneStillWaiting() async {
        let env = Env(known: [patientA])
        env.signedIn = false
        let older = AppRoute.conversation(ConversationRoute(patientID: patientA, conversationID: conversationID))
        let newer = AppRoute.meal(MealRoute(patientID: patientA, mealID: mealID))

        await env.coordinator.receive(older)
        await env.coordinator.receive(newer)
        env.signedIn = true
        await env.coordinator.resume()

        XCTAssertEqual(env.delivered, [newer])
    }

    func testTwoAttemptsAtOnceOpenTheRouteOnce() async {
        let env = Env(known: [])
        env.serverPatients = [patientA]
        let route = AppRoute.conversation(ConversationRoute(patientID: patientA, conversationID: conversationID))

        async let first = env.coordinator.receive(route)
        async let second = env.coordinator.resume()
        _ = await (first, second)

        XCTAssertEqual(env.delivered, [route])
    }

    func testTheSameNotificationOpenedAgainOpensAgain() async {
        let env = Env(known: [patientA])
        let route = AppRoute.meal(MealRoute(patientID: patientA, mealID: mealID))

        await env.coordinator.receive(route)
        await env.coordinator.receive(route)

        XCTAssertEqual(env.delivered, [route, route])
    }

    func testClearDropsTheWaitingRoute() async {
        let env = Env(known: [patientA])
        env.signedIn = false
        await env.coordinator.receive(.remoteCommands(patientID: patientA))

        env.coordinator.clear()
        env.signedIn = true

        let outcome = await env.coordinator.resume()
        XCTAssertEqual(outcome, .nothingPending)
        XCTAssertTrue(env.delivered.isEmpty)
    }

    // MARK: - What each notification opens

    func testEveryPushTypeOpensItsScreen() {
        func payload(_ fields: [String: Any]) -> [AnyHashable: Any] { ["gluco": fields] }

        XCTAssertEqual(
            AppRoute.parse(pushPayload: payload(["type": "conversation_question", "patientId": patientA, "conversationId": conversationID, "questionId": "q-1"])),
            .conversation(ConversationRoute(patientID: patientA, conversationID: conversationID, questionID: "q-1"))
        )
        XCTAssertEqual(
            AppRoute.parse(pushPayload: payload(["type": "rescue_carbs", "patientId": patientA, "conversationId": conversationID, "alertId": actionID])),
            .conversation(ConversationRoute(patientID: patientA, conversationID: conversationID))
        )
        XCTAssertEqual(
            AppRoute.parse(pushPayload: payload(["type": "meal_description", "patientId": patientA, "mealId": mealID])),
            .meal(MealRoute(patientID: patientA, mealID: mealID))
        )
        XCTAssertEqual(
            AppRoute.parse(pushPayload: payload(["type": "wbt_reminder", "patientId": patientA, "mealId": mealID])),
            .meal(MealRoute(patientID: patientA, mealID: mealID, opensWbt: true))
        )
        XCTAssertEqual(
            AppRoute.parse(pushPayload: payload(["type": "planned_bolus", "patientId": patientA, "mealId": mealID, "plannedBolusId": planID])),
            .meal(MealRoute(patientID: patientA, mealID: mealID, opensPlannedBolus: true, plannedBolusID: planID))
        )
        XCTAssertEqual(
            AppRoute.parse(pushPayload: AppRoute.remoteCommandPayload(patientID: patientA)),
            .remoteCommands(patientID: patientA)
        )
    }

    /// The loop action push is retired: an old one (or its link) in the bell leads nowhere, not to the Meals tab.
    func testALoopActionPushLeadsNowhere() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "loop_action",
            "patientId": patientA,
            "actionId": actionID,
            "suggestions": [["purpose": "NEW_MEAL", "meal_id": NSNull()], ["purpose": "MEAL_ADDITION", "meal_id": mealID]],
        ] as [String: Any]]

        XCTAssertNil(AppRoute.parse(pushPayload: payload))
        XCTAssertNil(AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patientA)/loop-actions/\(actionID)")!))
    }

    func testUniversalLinksOpenConversationsAndMeals() {
        XCTAssertEqual(
            AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patientA)/conversations/\(conversationID)?questionId=q-2")!),
            .conversation(ConversationRoute(patientID: patientA, conversationID: conversationID, questionID: "q-2"))
        )
        XCTAssertEqual(
            AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patientA)/meals/\(mealID)/wbt")!),
            .meal(MealRoute(patientID: patientA, mealID: mealID, opensWbt: true))
        )
        XCTAssertNil(AppRoute.parse(universalLink: URL(string: "https://evil.example.com/patients/\(patientA)/meals/\(mealID)")!))
    }

    func testMalformedPayloadsOpenNothing() {
        XCTAssertNil(AppRoute.parse(pushPayload: [:]))
        XCTAssertNil(AppRoute.parse(pushPayload: ["gluco": ["type": "conversation_question", "patientId": "nope", "conversationId": "nope"]]))
        XCTAssertNil(AppRoute.parse(pushPayload: ["gluco": ["type": "unknown_type", "patientId": patientA]]))
        XCTAssertNil(AppRoute.parse(pushPayload: [AppRoute.localNotificationKey: AppRoute.localRemoteCommand]))
        XCTAssertEqual(AppRoute.conversation(ConversationRoute(patientID: patientB, conversationID: conversationID)).patientID, patientB)
    }
}

@MainActor
private final class Env {
    var known: [String]?
    var serverPatients: [String] = []
    var refreshFails = false
    var signedIn = true
    private(set) var refreshCount = 0
    private(set) var delivered: [AppRoute] = []
    private(set) lazy var coordinator = PendingRouteCoordinator(
        isSignedIn: { [unowned self] in signedIn },
        knownPatientIDs: { [unowned self] in known },
        refreshPatientIDs: { [unowned self] in
            refreshCount += 1
            await Task.yield()
            if refreshFails { throw APIClientError.transport("offline") }
            known = serverPatients
            return serverPatients
        },
        deliver: { [unowned self] in delivered.append($0) }
    )

    init(known: [String]?) {
        self.known = known
    }
}
