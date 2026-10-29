import XCTest
@testable import GlucoMindCore

/// The Bolus tab keeps what was typed until Trio's final answer: cleared when given, kept when refused or unanswered,
/// only the carbs cleared when Trio stored them and refused the bolus.
@MainActor
final class RemoteBolusOutcomeTests: XCTestCase {
    private final class HistoryAPI: RemoteCommandsAPI {
        var statuses: [(String, String?)] = []
        var listed = 0

        func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
            let insulin = insulinU.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbsG) / 10
            return RemoteCommandPreview(carbs_g: carbsG, insulin_u: insulin, icr_g_per_u: 10, icr_insulin_u: Double(carbsG) / 10,
                                        context: RemoteCommandContextView(now: "2026-10-23T12:00:00Z", glucose: .init(value: 140, observed_at: "2026-10-23T11:58:00Z", delta: 1), loop: nil, last_bolus: nil, icr_g_per_u: 10),
                                        blocks: [], warnings: [])
        }
        func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] {
            listed += 1
            guard let (status, message) = statuses.first else { return [] }
            if statuses.count > 1 { statuses.removeFirst() }
            return [RemoteBolusOutcomeTests.command(status: status, message: message)]
        }
        func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand { fatalError() }
        func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand { fatalError() }
        func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError() }
        func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { fatalError() }
        func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError() }
    }

    private struct SentSender: RemoteCommandSending {
        func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome { .sent(RemoteBolusOutcomeTests.command(status: "SENT", message: nil)) }
    }

    nonisolated static func command(status: String, message: String?) -> RemoteCommand {
        RemoteCommand(id: "rc1", status: status, status_message: message, source: "BOLUS_SCREEN", carbs_g: 30, insulin_u: 3, icr_g_per_u: 10, meal_description: nil, conversation_id: nil, proposal_id: nil, sent_by_me: true, authorized_at: "2026-10-23T12:00:00Z", send_deadline: "2026-10-23T12:02:00Z", sent_at: "2026-10-23T12:00:01Z", answered_at: nil, meal_record_id: nil, loop_action_id: nil, warnings: [])
    }

    private func sent(_ api: HistoryAPI, hold: TimeInterval = 0) async -> RemoteBolusViewModel {
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { SentSender() }
        let clock = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock })
        viewModel.outcomeHold = hold
        viewModel.carbsText = "30"
        await viewModel.refreshPreview()
        api.statuses = [("SENT", nil)]
        await viewModel.slideToGive()
        return viewModel
    }

    func testWhileTrioDosesTheFormIsLockedAndKeepsItsAmounts() async {
        let viewModel = await sent(HistoryAPI())
        XCTAssertTrue(viewModel.isLocked)
        XCTAssertEqual(viewModel.outcome?.step, 1)
        XCTAssertEqual(viewModel.carbsText, "30")
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertFalse(viewModel.canGive)
    }

    func testTheAnswerShowsOnTheStepsBeforeTheCardAndTheForm() async throws {
        let api = HistoryAPI()
        let viewModel = await sent(api, hold: 0.1)
        api.statuses = [("SUCCEEDED", "Bolus podany")]
        await viewModel.refreshRecent()
        XCTAssertEqual(viewModel.settling?.status, "SUCCEEDED")
        XCTAssertTrue(viewModel.isLocked)
        XCTAssertEqual(viewModel.carbsText, "30")
        try await Task.sleep(nanoseconds: 300_000_000)
        guard case .given? = viewModel.outcome else { return XCTFail("given expected") }
        XCTAssertNil(viewModel.settling)
        XCTAssertEqual(viewModel.carbsText, "")
        XCTAssertFalse(viewModel.isLocked)
    }

    func testAGivenBolusClearsTheForm() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        api.statuses = [("SUCCEEDED", "Bolus podany")]
        await viewModel.refreshRecent()
        guard case .given? = viewModel.outcome else { return XCTFail("given expected") }
        XCTAssertEqual(viewModel.carbsText, "")
        XCTAssertEqual(viewModel.insulinText, "")
        XCTAssertFalse(viewModel.isLocked)
    }

    func testARefusalKeepsBothAmountsWithAShortReason() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        api.statuses = [("REJECTED", "Błąd: bolus 3 j przekracza maksymalny bolus w Trio (2 j)")]
        await viewModel.refreshRecent()
        guard case let .refused(_, text)? = viewModel.outcome else { return XCTFail("refused expected") }
        XCTAssertEqual(text.short, "Za duży bolus dla Trio (max 2 j)")
        XCTAssertEqual(viewModel.carbsText, "30")
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertEqual(viewModel.retry?.followsCommandID, "rc1")
    }

    func testCarbsStoredButBolusRefusedClearsOnlyTheCarbs() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        api.statuses = [("PARTIAL", "Węglowodany zapisane w Trio, bolus odrzucony: Bolus failed: pump communication error")]
        await viewModel.refreshRecent()
        guard case let .carbsOnly(_, text)? = viewModel.outcome else { return XCTFail("carbs only expected") }
        XCTAssertEqual(text.short, "Brak łączności z pompą")
        XCTAssertEqual(viewModel.carbsText, "")
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertEqual(viewModel.retry?.carbsKept, true)
    }

    func testNoAnswerKeepsTheAmounts() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        api.statuses = [("NO_REPLY", nil)]
        await viewModel.refreshRecent()
        guard case .noReply? = viewModel.outcome else { return XCTFail("no reply expected") }
        XCTAssertEqual(viewModel.carbsText, "30")
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertFalse(viewModel.isLocked)
    }

    func testTypingAfterAFinishedOutcomeDismissesItsCard() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        api.statuses = [("REJECTED", "Błąd: Trio nie zna aktualnego IOB")]
        await viewModel.refreshRecent()
        XCTAssertNotNil(viewModel.outcome)
        viewModel.carbsText = "25"
        XCTAssertNil(viewModel.outcome)
    }
}
