import Combine
import XCTest
@testable import GlucoMindCore

/// Doses are given from data at most 2 min old everywhere (the Bolus tab's previewMaxAge), and an older check's answer
/// never replaces a newer one.
@MainActor
final class RemoteDoseFreshnessTests: XCTestCase {
    private let start = ISO8601DateFormatter().date(from: "2026-10-21T12:00:00Z")!

    private func preview(carbs: Int, insulin: Double, iob: Double = 1) -> RemoteCommandPreview {
        RemoteCommandPreview(
            carbs_g: carbs,
            insulin_u: insulin,
            icr_g_per_u: 10,
            icr_insulin_u: Double(carbs) / 10,
            context: RemoteCommandContextView(now: "2026-10-21T12:00:00Z", glucose: .init(value: 140, observed_at: "2026-10-21T11:58:00Z", delta: 1), loop: nil, last_bolus: nil, icr_g_per_u: 10),
            blocks: [],
            warnings: []
        )
    }

    // MARK: - The confirmation sheet (chat card, WBT, planned part)

    func testAConfirmationOlderThanTwoMinutesIsCheckedAgainInsteadOfSent() async {
        var clock = start
        let api = FreshnessPreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), makeSender: { fatalError("nothing may be sent in this test") }, now: { clock })
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: 3))
        let first = flow.confirmation
        XCTAssertEqual(api.calls, 1)
        XCTAssertEqual(first?.checkedAt, start)

        clock = start.addingTimeInterval(RemoteBolusViewModel.previewMaxAge + 1)
        await flow.confirm()
        XCTAssertEqual(api.calls, 2, "the data were read again")
        XCTAssertEqual(flow.confirmation?.id, first?.id, "the same sheet stays open")
        XCTAssertEqual(flow.confirmation?.notice, RemoteBolusFlow.recheckedNotice)
        XCTAssertEqual(flow.confirmation?.checkedAt, clock)
        XCTAssertEqual(flow.confirmation?.canConfirm, true, "the caregiver slides again on what is shown")
        XCTAssertEqual(flow.state, .idle)
    }

    func testAFailedRecheckSendsNothingAndSaysSo() async {
        var clock = start
        let api = FreshnessPreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), makeSender: { fatalError("nothing may be sent in this test") }, now: { clock })
        await flow.prepare(RemoteBolusDraftBase(source: .plannedBolus, carbsG: 0, insulinU: 2, plannedBolusID: "plan-1"))
        clock = start.addingTimeInterval(600)
        api.failure = URLError(.notConnectedToInternet)
        await flow.confirm()
        XCTAssertEqual(flow.confirmation?.notice, RemoteBolusFlow.recheckFailedNotice)
        XCTAssertEqual(flow.confirmation?.checkedAt, start, "still old: the next slide checks again")
    }

    func testAnExpiredCardNeverOpensOrSendsAndTheChatReadsItAgain() async {
        var clock = start
        let api = FreshnessPreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), makeSender: { fatalError("nothing may be sent in this test") }, now: { clock })
        var expired: [String] = []
        let subscription = flow.proposalExpired.sink { expired.append($0) }
        defer { subscription.cancel() }
        var base = RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: 3, proposalID: "bp-1")
        base.proposalExpiresAt = start.addingTimeInterval(60)

        // Opened while valid, confirmed after the card expired: nothing sent.
        await flow.prepare(base)
        XCTAssertNotNil(flow.confirmation)
        clock = start.addingTimeInterval(61)
        await flow.confirm()
        XCTAssertNil(flow.confirmation)
        XCTAssertEqual(flow.state, .failed(RemoteBolusFlow.expiredNotice))
        XCTAssertEqual(expired, ["bp-1"])

        // Opened after it expired: no check, no sheet.
        flow.reset()
        await flow.prepare(base)
        XCTAssertNil(flow.confirmation)
        XCTAssertEqual(api.calls, 1)
        XCTAssertEqual(expired, ["bp-1", "bp-1"])
    }

    func testACardPastItsValidityIsShownExpired() throws {
        let json = #"""
        {"id":"bp","purpose":"MEAL","carbs_g":30,"insulin_u":3,"icr_g_per_u":10,"icr_insulin_u":3,"meal_description":null,"meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-21T12:15:00Z","state":"PROPOSED","command":null}
        """#
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: Data(json.utf8))
        XCTAssertEqual(card.state(at: start), "PROPOSED")
        XCTAssertEqual(card.state(at: start.addingTimeInterval(15 * 60)), "EXPIRED")
        XCTAssertEqual(card.draftBase(conversationID: "c").proposalExpiresAt, start.addingTimeInterval(15 * 60))
    }

    func testTheSliderWaitsWhileTheDataAreReadAgain() {
        let rechecking = RemoteBolusConfirmation(draftBase: RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: 3), preview: preview(carbs: 30, insulin: 3), isRechecking: true)
        XCTAssertFalse(rechecking.canConfirm)
    }

    // MARK: - The Bolus tab's checks

    func testAnOlderCheckAnsweringLateDoesNotReplaceTheNewerOne() async {
        let api = FreshnessPreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        viewModel.carbsText = "10"
        api.holdNext = true
        let older = Task { await viewModel.refreshPreview() }
        await api.waitUntilHeld()
        viewModel.carbsText = "20"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.preview?.carbs_g, 20)
        api.release()
        await older.value
        XCTAssertEqual(viewModel.preview?.carbs_g, 20, "the 10 g answer came last but is older")
        XCTAssertEqual(viewModel.insulinText, "2")
    }

    func testACancelledCheckIsNotAnError() async {
        let api = FreshnessPreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 0) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        api.failure = URLError(.cancelled)
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.previewError)
        api.failure = CancellationError()
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.previewError)
        api.failure = URLError(.notConnectedToInternet)
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.previewError, "Nie udało się wczytać danych pacjenta.")
    }

    // MARK: - The planned part

    private func plannedJSON(asOf: String, insulin: Double, given: Double? = nil) -> String {
        """
        {"patient_id":"p1","meal":{"meal_id":"m1","status":"CONFIRMED","started_at":"2026-10-21T10:30:00.000Z","source_carbs_g":36,"description":"Pizza",
         "has_photo":false,"macros":{"carbs":{"grams":60,"origin":"CAREGIVER"},"protein":{"grams":28,"origin":"CAREGIVER"},"fat":{"grams":32,"origin":"CAREGIVER"}},
         "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true,"planned_bolus":null},
         "planned_bolus":{"id":"plan-1","status":"\(given == nil ? "NOTIFIED" : "GIVEN")","due_at":"2026-10-21T12:00:00.000Z","delay_minutes":90,"now_percent":60,"carbs_g":24,
           "planned_insulin_u":2.4,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":\(given.map { "\($0)" } ?? "null"),"sending":false,
           "meal_started_at":"2026-10-21T10:30:00.000Z","icr_at_plan":10,
           "estimate":{"as_of":"\(asOf)","icr_g_per_u":8,"insulin_for_carbs_u":3,"loop_extra_u":0.4,"smb_u":0.4,"temp_basal_extra_u":0,"insulin_u":\(insulin)},
           "command":null}}
        """
    }

    func testPodajUsesAFreshEstimateAndReadsAnOlderOneAgain() async throws {
        var clock = start
        let api = FreshnessPlannedAPI(responses: [plannedJSON(asOf: "2026-10-21T12:00:00.000Z", insulin: 2.6), plannedJSON(asOf: "2026-10-21T12:05:00.000Z", insulin: 2.1)])
        let viewModel = PlannedBolusViewModel(route: MealRoute(patientID: "p1", mealID: "m1", opensPlannedBolus: true), api: api, now: { clock })
        await viewModel.load()
        XCTAssertEqual(api.calls, 1)

        clock = start.addingTimeInterval(60)
        let fresh = await viewModel.giveBase()
        XCTAssertEqual(fresh?.insulinU, Decimal(string: "2.6"))
        XCTAssertEqual(api.calls, 1, "a 1-minute-old estimate is used as it is")

        // Five minutes on screen: an SMB since then lowers the dose.
        clock = start.addingTimeInterval(300)
        let base = await viewModel.giveBase()
        XCTAssertEqual(api.calls, 2)
        XCTAssertEqual(base?.insulinU, Decimal(string: "2.1"))
        XCTAssertEqual(base?.plannedBolusID, "plan-1")
    }

    func testPodajGivesNothingWhenTheEstimateCannotBeReadAgain() async {
        var clock = start
        let api = FreshnessPlannedAPI(responses: [plannedJSON(asOf: "2026-10-21T12:00:00.000Z", insulin: 2.6)])
        let viewModel = PlannedBolusViewModel(route: MealRoute(patientID: "p1", mealID: "m1", opensPlannedBolus: true), api: api, now: { clock })
        await viewModel.load()
        clock = start.addingTimeInterval(300)
        let base = await viewModel.giveBase()
        XCTAssertNil(base)
        XCTAssertEqual(viewModel.errorMessage, "Nie udało się przeliczyć dawki. Spróbuj ponownie.")
    }

    func testPlannedDosesAreWrittenToThePumpStep() throws {
        let response = try JSONDecoder().decode(PlannedBolusResponse.self, from: Data(plannedJSON(asOf: "2026-10-21T12:00:00.000Z", insulin: 2.6, given: 2.25).utf8))
        XCTAssertTrue(try XCTUnwrap(response.planned_bolus).summary.statusLine.hasSuffix(": 2,25 j"))
    }
}

private final class FreshnessPreviewAPI: RemoteCommandsAPI {
    let make: (Int, Decimal?) -> RemoteCommandPreview
    var calls = 0
    var failure: Error?
    var holdNext = false
    private var held: CheckedContinuation<Void, Never>?
    private var heldWaiter: CheckedContinuation<Void, Never>?

    init(make: @escaping (Int, Decimal?) -> RemoteCommandPreview) {
        self.make = make
    }

    func waitUntilHeld() async {
        if held != nil { return }
        await withCheckedContinuation { heldWaiter = $0 }
    }

    func release() {
        held?.resume()
        held = nil
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
        calls += 1
        if let failure { throw failure }
        let result = make(carbsG, insulinU)
        if holdNext {
            holdNext = false
            await withCheckedContinuation { continuation in
                held = continuation
                heldWaiter?.resume()
                heldWaiter = nil
            }
        }
        return result
    }
    func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand { fatalError() }
    func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand { fatalError() }
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError() }
    func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
    func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { fatalError() }
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError() }
}

private final class FreshnessPlannedAPI: PlannedBolusAPI {
    var responses: [String]
    var calls = 0

    init(responses: [String]) {
        self.responses = responses
    }

    func getMealPlannedBolus(patientID: String, mealID: String) async throws -> PlannedBolusResponse {
        calls += 1
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return try JSONDecoder().decode(PlannedBolusResponse.self, from: Data(responses.removeFirst().utf8))
    }

    func skipMealPlannedBolus(patientID: String, mealID: String, plannedBolusID: String) async throws -> PlannedBolusResponse { fatalError() }
}
