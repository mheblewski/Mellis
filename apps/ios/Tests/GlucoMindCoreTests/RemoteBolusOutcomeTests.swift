import XCTest
@testable import GlucoMindCore

/// The Bolus tab keeps what was typed until Trio's final answer: cleared when given, kept when refused or unanswered,
/// only the carbs cleared when Trio stored them and refused the bolus.
@MainActor
final class RemoteBolusOutcomeTests: XCTestCase {
    private final class HistoryAPI: RemoteCommandsAPI {
        var statuses: [(String, String?)] = []
        var listed = 0
        /// The meal the server linked the command to (after the loop's entry is in Nightscout).
        var mealRecordID: String?
        /// The whole history, when a test needs more than one command.
        var commands: [RemoteCommand]?

        func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
            let insulin = insulinU.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbsG) / 10
            return RemoteCommandPreview(carbs_g: carbsG, insulin_u: insulin, icr_g_per_u: 10, icr_insulin_u: Double(carbsG) / 10,
                                        context: RemoteCommandContextView(now: "2026-10-23T12:00:00Z", glucose: .init(value: 140, observed_at: "2026-10-23T11:58:00Z", delta: 1), loop: nil, last_bolus: nil, icr_g_per_u: 10),
                                        blocks: [], warnings: [])
        }
        func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] {
            listed += 1
            if let commands { return commands }
            guard let (status, message) = statuses.first else { return [] }
            if statuses.count > 1 { statuses.removeFirst() }
            return [RemoteBolusOutcomeTests.command(status: status, message: message, mealRecordID: mealRecordID)]
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

    nonisolated static func command(status: String, message: String?, mealRecordID: String? = nil, id: String = "rc1", insulin: Double = 3, authorizedAt: String = "2026-10-23T12:00:00Z") -> RemoteCommand {
        RemoteCommand(id: id, status: status, status_message: message, source: "BOLUS_SCREEN", carbs_g: 30, insulin_u: insulin, icr_g_per_u: 10, meal_description: nil, conversation_id: nil, proposal_id: nil, sent_by_me: true, authorized_at: authorizedAt, send_deadline: "2026-10-23T12:02:00Z", sent_at: "2026-10-23T12:00:01Z", answered_at: nil, meal_record_id: mealRecordID, loop_action_id: nil, warnings: [])
    }

    private func sent(_ api: HistoryAPI, hold: TimeInterval = 0, saveAsMeal: Bool = true) async -> RemoteBolusViewModel {
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { SentSender() }
        let clock = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock })
        viewModel.outcomeHold = hold
        viewModel.carbsText = "30"
        viewModel.saveAsMeal = saveAsMeal
        await viewModel.refreshPreview()
        api.statuses = [("SENT", nil)]
        await viewModel.slideToGive()
        return viewModel
    }

    /// A form holding the retry of a PARTIAL command of 12:00; `clock` is the time the form sees.
    private func formRetrying(_ api: HistoryAPI, clock: @escaping () -> Date) async -> (RemoteBolusViewModel, RemoteCommand) {
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { SentSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: clock)
        let refused = Self.command(status: "PARTIAL", message: "Węglowodany zapisane w Trio, bolus odrzucony")
        viewModel.prepareRetry(of: refused)
        XCTAssertNotNil(viewModel.retry)
        XCTAssertEqual(viewModel.insulinText, "3")
        return (viewModel, refused)
    }

    private func at(_ time: String) -> Date { ISO8601DateFormatter().date(from: "2026-10-23T\(time):00Z")! }

    func testABolusGivenElsewhereAfterARefusalEndsTheRetryAndTheDoseFillsAgain() async {
        let api = HistoryAPI()
        let (viewModel, refused) = await formRetrying(api) { self.at("12:05") }
        api.commands = [Self.command(status: "SUCCEEDED", message: nil, id: "rc2", authorizedAt: "2026-10-23T12:04:00Z"), refused]
        await viewModel.refreshRecent()
        XCTAssertNil(viewModel.retry)
        XCTAssertFalse(viewModel.insulinEdited)
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4")
    }

    func testTheRetryEndsWhenTheServersWindowPasses() async {
        let api = HistoryAPI()
        var now = at("12:29")
        let (viewModel, refused) = await formRetrying(api) { now }
        api.commands = [refused]
        await viewModel.refreshRecent()
        XCTAssertNotNil(viewModel.retry, "still within 30 min")
        XCTAssertEqual(viewModel.insulinText, "3")
        now = at("12:30")
        await viewModel.refreshRecent()
        XCTAssertNil(viewModel.retry)
        XCTAssertFalse(viewModel.insulinEdited)
    }

    func testOnlyALaterGivenBolusEndsTheRetry() async {
        let api = HistoryAPI()
        let (viewModel, refused) = await formRetrying(api) { self.at("12:05") }
        api.commands = [
            Self.command(status: "SUCCEEDED", message: nil, id: "carbs-only", insulin: 0, authorizedAt: "2026-10-23T12:03:00Z"),
            Self.command(status: "REJECTED", message: nil, id: "refused-later", authorizedAt: "2026-10-23T12:02:00Z"),
            refused,
            Self.command(status: "SUCCEEDED", message: nil, id: "older", authorizedAt: "2026-10-23T11:50:00Z"),
        ]
        await viewModel.refreshRecent()
        XCTAssertNotNil(viewModel.retry)
        XCTAssertEqual(viewModel.insulinText, "3")
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

    /// 2026-11-10: "Bolus mógł się nie udać" kept the dose on the form with "Podaj ponownie" and it was given twice.
    func testAnUncertainAnswerChecksThenSaysNotKnownWithNothingToSendAgainAndTurnsGivenLater() async {
        final class Clock { var date = ISO8601DateFormatter().date(from: "2026-10-23T12:00:05Z")! }
        let clock = Clock()
        let api = HistoryAPI()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { SentSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock.date })
        viewModel.outcomeHold = 0
        viewModel.carbsText = "30"
        await viewModel.refreshPreview()
        api.statuses = [("SENT", nil)]
        await viewModel.slideToGive()
        let unknown = "Nie wiadomo, czy bolus został podany: pompa odpowiedziała niewyraźnie. Sprawdź historię bolusów w pompie."

        // Checking: the steps stay, the form stays locked.
        api.statuses = [("UNCERTAIN", unknown)]
        await viewModel.refreshRecent()
        guard case .waiting? = viewModel.outcome else { return XCTFail("checking expected") }
        XCTAssertTrue(viewModel.isLocked)

        // The check ended without the bolus in Nightscout: not known, nothing kept to send again.
        clock.date = clock.date.addingTimeInterval(40)
        await viewModel.refreshRecent()
        guard case .uncertain? = viewModel.outcome else { return XCTFail("uncertain expected") }
        XCTAssertNil(viewModel.retry)
        XCTAssertEqual(viewModel.carbsText, "")
        XCTAssertEqual(viewModel.insulinText, "")
        XCTAssertFalse(viewModel.isLocked)

        // The loop's bolus reached Nightscout later: the card says it was given.
        api.statuses = [("SUCCEEDED", "Bolus podany: pompa odpowiedziała niewyraźnie, ale bolus jest w Nightscout")]
        await viewModel.refreshRecent()
        guard case let .given(command)? = viewModel.outcome else { return XCTFail("given expected") }
        XCTAssertTrue(command.givenAfterUncertainAnswer)
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

    func testADoseGivenAsAMealOffersItsDescriptionOnceTheMealIsLinked() async {
        let api = HistoryAPI()
        let viewModel = await sent(api)
        XCTAssertFalse(viewModel.offersMealDescription, "not before Trio's answer")
        api.statuses = [("SUCCEEDED", "Bolus podany")]
        await viewModel.refreshRecent()
        XCTAssertTrue(viewModel.offersMealDescription)
        XCTAssertNil(viewModel.describableMealID, "the button waits for the meal")
        api.mealRecordID = "m1"
        await viewModel.refreshRecent()
        XCTAssertEqual(viewModel.describableMealID, "m1")
        viewModel.carbsText = "25"
        XCTAssertFalse(viewModel.offersMealDescription, "gone with the card")
    }

    func testADoseNotSavedAsAMealOffersNoDescription() async {
        let api = HistoryAPI()
        api.mealRecordID = "m1"
        let viewModel = await sent(api, saveAsMeal: false)
        api.statuses = [("SUCCEEDED", "Bolus podany")]
        await viewModel.refreshRecent()
        guard case .given? = viewModel.outcome else { return XCTFail("given expected") }
        XCTAssertFalse(viewModel.offersMealDescription)
        XCTAssertNil(viewModel.describableMealID)
    }
}
