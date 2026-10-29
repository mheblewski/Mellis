import XCTest
@testable import GlucoMindApp
@testable import GlucoMindCore

@MainActor
final class AppContainerRoutingReactivityTests: XCTestCase {
    private let anna = AccessiblePatient(patient_id: "11111111-1111-4111-8111-111111111111", display_name: "Anna")
    private let kuba = AccessiblePatient(patient_id: "22222222-2222-4222-8222-222222222222", display_name: "Kuba")
    private let conversationID = "a0000001-0000-4000-8000-000000000001"
    private let mealID = "55555555-5555-4555-8555-555555555555"

    func testDashboardOpenConversationSelectsItAndOpensTheConversationsTab() {
        let container = AppContainer()

        container.openConversationFromDashboard(patientID: anna.patient_id, conversationID: conversationID)

        XCTAssertEqual(container.selectedConversationID, conversationID)
        XCTAssertEqual(container.selectedConversationPatientID, anna.patient_id)
        XCTAssertEqual(container.selectedTab, .conversations)
        // The tabs are not rebuilt for it: the root stays on the patient's tabs.
        XCTAssertEqual(PatientLaunchResolver.resolveRootPresentation(bootstrapped: true, hasBootstrapError: false, requiresSignIn: false), .patientEntry)
    }

    func testSessionEndingWhileOpenShowsSignIn() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: anna, authMode: .cognito)
        container.isSettingsPresented = true

        container.sessionEnded()

        XCTAssertTrue(container.requiresSignIn)
        XCTAssertNil(container.patientEntryDestination)
        XCTAssertNil(container.liveUpdates)
        XCTAssertFalse(container.isSettingsPresented)
        XCTAssertEqual(PatientLaunchResolver.resolveRootPresentation(bootstrapped: true, hasBootstrapError: false, requiresSignIn: container.requiresSignIn), .signIn)
    }

    func testEveryTabSharesThePatientsNotificationList() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: anna, authMode: .cognito)
        let api = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: URLSessionHTTPClient())

        let dashboardBell = container.notificationHistory(apiClient: api, patientID: anna.patient_id)
        let mealsBell = container.notificationHistory(apiClient: api, patientID: anna.patient_id)
        XCTAssertTrue(dashboardBell === mealsBell)
        XCTAssertFalse(dashboardBell === container.notificationHistory(apiClient: api, patientID: kuba.patient_id))

        container.sessionEnded()
        XCTAssertFalse(dashboardBell === container.notificationHistory(apiClient: api, patientID: anna.patient_id), "a new sign-in starts a new list")
    }

    func testSessionEndedIsIgnoredWithoutCognito() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)

        container.sessionEnded()

        XCTAssertFalse(container.requiresSignIn)
        XCTAssertNotNil(container.patientEntryDestination)
    }

    func testSelectingSameConversationCanTriggerRefreshNonce() {
        let patientID = "11111111-1111-4111-8111-111111111111"
        let conversationID = "a0000001-0000-4000-8000-000000000001"
        let container = AppContainer()

        container.setSelectedConversation(patientID: patientID, conversationID: conversationID, triggerRefreshIfSame: false)
        let initialNonce = container.selectedConversationRefreshNonce

        container.setSelectedConversation(patientID: patientID, conversationID: conversationID, triggerRefreshIfSame: true)

        XCTAssertEqual(container.selectedConversationRefreshNonce, initialNonce + 1)
    }

    func testConversationPushOpensItsConversationAtOnce() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: anna)

        let outcome = await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: conversationID)))

        XCTAssertEqual(outcome, PendingRouteCoordinator.Outcome.delivered)
        XCTAssertEqual(container.selectedTab, .conversations)
        XCTAssertEqual(container.selectedConversationID, conversationID)
        XCTAssertEqual(container.conversationOpenedFromNotification, conversationID)
    }

    func testPushOfAnotherPatientSwitchesToThatPatientFirst() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: anna)
        container.setSelectedConversation(patientID: anna.patient_id, conversationID: "anna-conversation", triggerRefreshIfSame: false)

        await container.routes.receive(.conversation(ConversationRoute(patientID: kuba.patient_id, conversationID: conversationID)))

        XCTAssertEqual(container.currentPatient, kuba)
        XCTAssertEqual(container.selectedTab, .conversations)
        XCTAssertEqual(container.selectedConversationPatientID, kuba.patient_id)
        XCTAssertEqual(container.selectedConversationID, conversationID)
    }

    func testPushWhileThePatientListIsShownOpensThatPatient() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: nil)
        XCTAssertNil(container.currentPatient)

        await container.routes.receive(.meal(MealRoute(patientID: kuba.patient_id, mealID: mealID, opensWbt: true)))

        XCTAssertEqual(container.currentPatient, kuba)
        XCTAssertEqual(container.selectedTab, .meals)
        XCTAssertEqual(container.mealsFocus, MealRoute(patientID: kuba.patient_id, mealID: mealID, opensWbt: true))
    }

    func testMealPushOpensTheMealsTabWithTheMeal() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)

        await container.routes.receive(.meal(MealRoute(patientID: anna.patient_id, mealID: mealID)))

        XCTAssertEqual(container.selectedTab, .meals)
        XCTAssertEqual(container.mealsFocus, MealRoute(patientID: anna.patient_id, mealID: mealID))
    }

    func testNotificationClosesTheSettingsAndEverySheet() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.presentSettings(refresh: nil)
        let dismissal = container.notificationDismissal

        await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: conversationID)))

        XCTAssertFalse(container.isSettingsPresented)
        XCTAssertEqual(container.notificationDismissal, dismissal + 1)
    }

    func testMealBehindAClosingSheetOpensOnceTheSheetIsGone() async throws {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.presentSettings(refresh: nil)

        await container.routes.receive(.meal(MealRoute(patientID: anna.patient_id, mealID: mealID, opensPlannedBolus: true)))

        XCTAssertEqual(container.selectedTab, .meals)
        XCTAssertNil(container.mealsFocus)
        try await Task.sleep(nanoseconds: 900_000_000)
        XCTAssertEqual(container.mealsFocus, MealRoute(patientID: anna.patient_id, mealID: mealID, opensPlannedBolus: true))
    }

    func testPushOfAPatientWithoutAccessOpensNothing() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        let stranger = "33333333-3333-4333-8333-333333333333"

        // Not on the list: the server is asked (no API in tests: the route keeps waiting, nothing opens).
        let outcome = await container.routes.receive(.conversation(ConversationRoute(patientID: stranger, conversationID: conversationID)))

        XCTAssertEqual(outcome, PendingRouteCoordinator.Outcome.waitingForPatients)
        XCTAssertEqual(container.currentPatient, anna)
        XCTAssertEqual(container.selectedTab, .dashboard)
        XCTAssertNil(container.selectedConversationID)
    }

    func testRemoteCommandNotificationWithoutRemoteControlLandsOnTheDashboard() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, kuba], current: anna)
        container.selectedTab = .meals

        await container.routes.receive(.remoteCommands(patientID: kuba.patient_id))

        XCTAssertEqual(container.currentPatient, kuba)
        XCTAssertEqual(container.selectedTab, .dashboard)
    }

    func testTabsDefaultChoiceNeverReplacesAConversationChosenMeanwhile() {
        let container = AppContainer()
        container.setSelectedConversation(patientID: anna.patient_id, conversationID: "old", triggerRefreshIfSame: false)

        // The tab read the lists while a notification opened another conversation.
        container.setSelectedConversation(patientID: anna.patient_id, conversationID: conversationID, triggerRefreshIfSame: true)
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: "latest", ifSelectionStill: "old")
        XCTAssertEqual(container.selectedConversationID, conversationID)

        // Nothing changed meanwhile: the default applies.
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: "latest", ifSelectionStill: conversationID)
        XCTAssertEqual(container.selectedConversationID, "latest")
    }
}
