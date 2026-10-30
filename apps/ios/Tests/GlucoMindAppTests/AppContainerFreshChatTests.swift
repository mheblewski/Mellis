import XCTest
@testable import GlucoMindApp
@testable import GlucoMindCore

/// fresh-chat.v1 in the app: a notification's (or the list's) conversation counts as opened on purpose, the tab's own
/// default does not, and a fresh conversation never replaces one a notification opened meanwhile.
@MainActor
final class AppContainerFreshChatTests: XCTestCase {
    private let anna = AccessiblePatient(patient_id: "11111111-1111-4111-8111-111111111111", display_name: "Anna")
    private let old = "a0000001-0000-4000-8000-000000000001"
    private let hypo = "a0000001-0000-4000-8000-000000000002"

    func testAPushOpensOnPurposeButTheTabsDefaultDoesNot() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)

        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        XCTAssertNil(container.conversationOpenedOnPurposeAt(patientID: anna.patient_id, conversationID: old))

        await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: hypo)))
        let opened = container.conversationOpenedOnPurposeAt(patientID: anna.patient_id, conversationID: hypo)
        XCTAssertNotNil(opened)
        XCTAssertLessThan(Date().timeIntervalSince(opened!), 5)
        // The protection makes the policy keep it, however old its messages are.
        let snapshot = FreshConversationPolicy.Snapshot(conversationID: hypo, lastActivity: Date().addingTimeInterval(-5 * 3_600))
        XCTAssertEqual(FreshConversationPolicy.decide(snapshot, openedOnPurposeAt: opened, now: Date()), .keep(.openedOnPurpose))
    }

    func testAFreshConversationNeverReplacesOneANotificationOpenedMeanwhile() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)

        await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: hypo)))
        container.showFreshConversation(patientID: anna.patient_id, replacing: old)
        XCTAssertEqual(container.selectedConversationID, hypo)

        container.showFreshConversation(patientID: anna.patient_id, replacing: hypo)
        XCTAssertNil(container.selectedConversationID)
        XCTAssertEqual(container.selectedConversationPatientID, anna.patient_id)
    }

    func testSwitchingToTheConversationsTabIsCounted() {
        let container = AppContainer()
        let before = container.conversationsTabShown
        container.selectedTab = .conversations
        container.selectedTab = .conversations
        XCTAssertEqual(container.conversationsTabShown, before + 1)
        container.selectedTab = .meals
        container.selectedTab = .conversations
        XCTAssertEqual(container.conversationsTabShown, before + 2)
    }
}
