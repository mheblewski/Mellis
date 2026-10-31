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

    // MARK: fresh-chat-revert: the old conversation never comes back by itself

    private let bob = AccessiblePatient(patient_id: "22222222-2222-4222-8222-222222222222", display_name: "Bob")
    private let created = "a0000001-0000-4000-8000-000000000003"

    /// The tab re-runs its default choice each time it comes back on screen (a tab switch restarts its task) and
    /// whenever it is built again (the patient list read again, another patient and back): with a fresh chat on
    /// screen that default used to select the old, quiet conversation again.
    func testTheTabsDefaultNeverBringsBackTheConversationAFreshChatReplaced() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        container.showFreshConversation(patientID: anna.patient_id, replacing: old)
        XCTAssertTrue(container.isShowingFreshConversation(patientID: anna.patient_id))

        // Back on the tab: its default (the newest conversation) for the selection it saw (none).
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        XCTAssertNil(container.selectedConversationID)
        XCTAssertTrue(container.isShowingFreshConversation(patientID: anna.patient_id))
    }

    func testTheHistoryListEndsTheFreshChat() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.showFreshConversation(patientID: anna.patient_id, replacing: nil)

        // ☰ → the old conversation: chosen on purpose.
        container.setSelectedConversation(patientID: anna.patient_id, conversationID: old, triggerRefreshIfSame: true)
        XCTAssertEqual(container.selectedConversationID, old)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: anna.patient_id))
    }

    func testTheFirstSendEndsTheFreshChat() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.showFreshConversation(patientID: anna.patient_id, replacing: nil)

        // The first send created the fresh chat's conversation (onFreshDraftCreated).
        container.setSelectedConversation(patientID: anna.patient_id, conversationID: created, triggerRefreshIfSame: false)
        XCTAssertEqual(container.selectedConversationID, created)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: anna.patient_id))
    }

    func testANotificationEndsTheFreshChat() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.showFreshConversation(patientID: anna.patient_id, replacing: nil)

        await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: hypo)))
        XCTAssertEqual(container.selectedConversationID, hypo)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: anna.patient_id))
    }

    func testTheDashboardLinkEndsTheFreshChat() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.showFreshConversation(patientID: anna.patient_id, replacing: nil)

        container.openConversationFromDashboard(patientID: anna.patient_id, conversationID: hypo)
        XCTAssertEqual(container.selectedConversationID, hypo)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: anna.patient_id))
    }

    /// Another patient and back builds the tab again with nothing selected: the fresh chat is shown again, not the
    /// old conversation.
    func testTheFreshChatSurvivesAnotherPatientAndBack() {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna, bob], current: anna)
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        container.showFreshConversation(patientID: anna.patient_id, replacing: old)

        container.selectPatient(bob)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: bob.patient_id))
        container.selectPatient(anna)
        XCTAssertTrue(container.isShowingFreshConversation(patientID: anna.patient_id))
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        XCTAssertNil(container.selectedConversationID)
    }

    /// A fresh chat that could not replace a conversation a notification opened meanwhile is not remembered.
    func testAFreshChatSkippedForANotificationIsNotRemembered() async {
        let container = AppContainer()
        container.prepareForTesting(patients: [anna], current: anna)
        container.selectDefaultConversation(patientID: anna.patient_id, conversationID: old, ifSelectionStill: nil)
        await container.routes.receive(.conversation(ConversationRoute(patientID: anna.patient_id, conversationID: hypo)))

        container.showFreshConversation(patientID: anna.patient_id, replacing: old)
        XCTAssertEqual(container.selectedConversationID, hypo)
        XCTAssertFalse(container.isShowingFreshConversation(patientID: anna.patient_id))
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
