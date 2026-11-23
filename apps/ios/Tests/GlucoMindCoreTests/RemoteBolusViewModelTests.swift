import XCTest
@testable import GlucoMindCore

@MainActor
final class RemoteBolusViewModelTests: XCTestCase {
    // These tests were written for carbs / ICR as the dose source (the default until 2026-11-14): kept explicit.
    override func setUp() {
        super.setUp()
        UserDefaults.standard.set("ICR", forKey: DoseBasisPreference.defaultsKey)
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("mellis.bolus.icr.") {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey)
        super.tearDown()
    }

    private func preview(carbs: Int, insulin: Double, icrInsulin: Double?, icr: Double = 10, carbsAt: String? = nil, blocks: [RemoteCommandNotice] = [], warnings: [RemoteCommandNotice] = []) -> RemoteCommandPreview {
        RemoteCommandPreview(
            carbs_g: carbs,
            insulin_u: insulin,
            icr_g_per_u: icr,
            icr_insulin_u: icrInsulin,
            context: RemoteCommandContextView(now: "2026-10-19T12:00:00Z", glucose: .init(value: 140, observed_at: "2026-10-19T11:58:00Z", delta: 1), loop: nil, last_bolus: nil, icr_g_per_u: icr, carbs_at: carbsAt),
            blocks: blocks,
            warnings: warnings
        )
    }

    private func makeViewModel(api: PreviewAPI, retries: [Duration] = []) -> RemoteBolusViewModel {
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        return RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, previewRetryDelays: retries)
    }

    private func waitUntil(_ condition: @autoclosure () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
    }

    func testAFailedCheckIsTriedAgainWithoutAnErrorAndRecovers() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let viewModel = makeViewModel(api: api, retries: [.milliseconds(10), .milliseconds(10)])
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertNotNil(viewModel.preview)

        api.offline = true
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.previewError, "no error on the first failure")
        XCTAssertNotNil(viewModel.preview, "the last check stays")

        api.offline = false
        await waitUntil(api.calls >= 3)
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.previewError)
    }

    func testTheErrorShowsOnlyOnceTheRetriesAreUsedUp() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        api.offline = true
        let viewModel = makeViewModel(api: api, retries: [.milliseconds(5), .milliseconds(5)])
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.previewError)
        await waitUntil(viewModel.previewError != nil)
        XCTAssertEqual(viewModel.previewError, "Nie udało się wczytać danych pacjenta.")
        XCTAssertEqual(api.calls, 3)
    }

    func testARefusalShowsAtOnceAndLeavingStopsTheRetries() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        api.offline = true
        let viewModel = makeViewModel(api: api, retries: [.milliseconds(30)])
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        viewModel.stopRetrying()
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(api.calls, 1, "nothing is tried again behind a left tab")
    }

    func testTheReadAheadCheckOpensTheTabWithItsDataAndCarbsReplaceItsCheck() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let entry = BolusCheckPrefetch.Entry(preview: preview(carbs: 0, insulin: 0, icrInsulin: 0), at: Date())
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, previewRetryDelays: [], prefetched: entry)
        XCTAssertEqual(viewModel.preview?.context.glucose?.value, 140, "the glucose before any check of the tab")
        XCTAssertEqual(api.calls, 0)
        // The opening's check and a typed amount: the typing replaces the opening's check, one answer wins.
        let opening = Task { await viewModel.load() }
        viewModel.carbsText = "30"
        await opening.value
        await waitUntil(viewModel.preview?.carbs_g == 30)
        XCTAssertEqual(viewModel.preview?.carbs_g, 30)
    }

    func testOnlyTheEmptyFormsCheckIsKeptForTheNextOpening() {
        let store = BolusCheckPrefetch()
        store.store(preview(carbs: 30, insulin: 3, icrInsulin: 3), patientID: "P1")
        XCTAssertNil(store.fresh(patientID: "p1"))
        let at = Date()
        store.store(preview(carbs: 0, insulin: 0, icrInsulin: 0), patientID: "P1", at: at)
        XCTAssertNotNil(store.fresh(patientID: "p1", now: at.addingTimeInterval(60)))
        XCTAssertNil(store.fresh(patientID: "p1", now: at.addingTimeInterval(RemoteBolusViewModel.previewMaxAge + 1)), "older than the slider allows")
    }

    func testSavedReadingsDrawTheChartAtOnceButNotAnOldGlucose() {
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600))
        let old = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-5 * 3600))
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 1, icrInsulin: 1) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, savedReadings: [DashboardReading(at: at, value: 120), DashboardReading(at: old, value: 90)])
        XCTAssertEqual(viewModel.readings.map(\.value), [120], "only the chart's 3 h")
        XCTAssertTrue(viewModel.chartIsLoading, "the forecast and the glucose are still on their way")
        XCTAssertNil(viewModel.shownContext(now: Date()))
    }

    private func formWithDose(_ dose: @escaping () -> Double) async -> (RemoteBolusViewModel, PreviewAPI) {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? dose(), icrInsulin: dose()) }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "30"
        await viewModel.refreshPreview()
        return (viewModel, api)
    }

    /// Owner 2026-11-13 (replaces "the dose follows new data on the open form"): once the dose is on the form, a check
    /// with new data never changes it; it is checked as it is.
    func testNewDataOnTheOpenFormNeverChangeTheDose() async {
        var dose = 3.0
        let (viewModel, api) = await formWithDose { dose }
        XCTAssertEqual(viewModel.insulinText, "3")
        dose = 2.5
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertEqual(api.lastInsulin, 3, "checked as shown")
    }

    func testTheDoseStaysWhileTheCommandWaitsForTheLoop() async {
        var dose = 3.0
        let (viewModel, api) = await formWithDose { dose }
        viewModel.follow(RemoteBolusOutcomeTests.command(status: "SENT", message: nil))
        XCTAssertTrue(viewModel.isLocked)
        dose = 2.5
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3")
        XCTAssertEqual(api.lastInsulin, 3, "checked as sent")
        XCTAssertTrue(viewModel.previewMatchesScreen)
    }

    /// 2026-11-15: a check during the send counted the command itself ("Ten posiłek mógł już być wysłany" for a moment).
    func testNoWarningShowsWhileTheFormsOwnCommandIsOnItsWay() async {
        var sent = false
        let alreadySent = RemoteCommandNotice(code: "ALREADY_SENT_FOR_MEAL", message: "0 min temu wysłano z zakładki Bolus 30 g i 3 j.")
        let api = PreviewAPI { carbs, insulin in
            self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 3, icrInsulin: 3, warnings: sent ? [alreadySent] : [])
        }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "30"
        await viewModel.refreshPreview()
        viewModel.follow(RemoteBolusOutcomeTests.command(status: "SENT", message: nil))
        sent = true
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.isLocked)
        XCTAssertEqual(viewModel.preview?.warnings.count, 1)
        XCTAssertTrue(viewModel.visibleWarnings.isEmpty)
        XCTAssertTrue(viewModel.visibleBlocks.isEmpty)
    }

    func testACheckStartedBeforeTheLockDoesNotChangeTheDose() async {
        var dose = 3.0
        let (viewModel, api) = await formWithDose { dose }
        dose = 2.5
        api.beforeAnswer = { await MainActor.run { viewModel.follow(RemoteBolusOutcomeTests.command(status: "SENT", message: nil)) } }
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3")
    }

    func testTheDoseStaysWhileTheFingerIsOnTheSliderAndAfterwards() async {
        var dose = 3.0
        let (viewModel, _) = await formWithDose { dose }
        viewModel.sliderHoldsDose = true
        dose = 2.5
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3")
        viewModel.sliderHoldsDose = false
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3", "letting go does not change it either (owner 2026-11-13)")
    }

    func testAClearedFormFillsTheDoseAgainEvenIfTheSliderNeverReportedItsEnd() async {
        let (viewModel, _) = await formWithDose { 3.0 }
        viewModel.sliderHoldsDose = true
        viewModel.clearForm()
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4", "40 g / ICR 10, filled again")
    }

    func testGivingEndsTheSlidersOwnHold() async {
        // No check yet: the slide stops before sending anything.
        let viewModel = makeViewModel(api: PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 3, icrInsulin: 3) })
        viewModel.sliderHoldsDose = true
        viewModel.give()
        XCTAssertFalse(viewModel.sliderHoldsDose)
    }

    func testEmptyingARefusedFormStartsOverWhicheverFieldGoesLast() async {
        for insulinLast in [true, false] {
            let (viewModel, _) = await formWithDose { 3.0 }
            viewModel.prepareRetry(of: RemoteBolusOutcomeTests.command(status: "REJECTED", message: "Brak łączności z pompą"))
            XCTAssertNotNil(viewModel.retry)
            XCTAssertTrue(viewModel.insulinEdited)
            if insulinLast {
                viewModel.carbsText = ""
                viewModel.insulinText = ""
            } else {
                viewModel.insulinText = ""
                viewModel.carbsText = ""
            }
            XCTAssertNil(viewModel.retry)
            XCTAssertFalse(viewModel.insulinEdited)
            viewModel.carbsText = "40"
            await viewModel.refreshPreview()
            XCTAssertEqual(viewModel.insulinText, "4", "40 g / ICR 10, filled again")
        }
    }

    func testARetryKeepsItsDoseWhileOnlyTheCarbsChange() async {
        let (viewModel, _) = await formWithDose { 2.0 }
        viewModel.prepareRetry(of: RemoteBolusOutcomeTests.command(status: "REJECTED", message: "Brak łączności z pompą"))
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3", "the refused command's dose stays")
        XCTAssertNotNil(viewModel.retry)
    }

    func testACheckAnsweringAfterTheFormWasClearedDoesNotFillIt() async {
        let (viewModel, api) = await formWithDose { 3.0 }
        api.beforeAnswer = { await MainActor.run { viewModel.clearForm() } }
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "")
    }

    func testTheCheckBringsTheChartsReadingsAndTheDashboardIsNotRead() async {
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600))
        let api = PreviewAPI { carbs, _ in
            var answer = self.preview(carbs: carbs, insulin: 1, icrInsulin: 1)
            answer.chart_readings = [DashboardReading(at: at, value: 133)]
            return answer
        }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        var dashboardReads = 0
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, glucoseHistory: {
            dashboardReads += 1
            return []
        })
        await viewModel.load()
        XCTAssertEqual(viewModel.readings.map(\.value), [133])
        XCTAssertTrue(viewModel.readingsLoaded)
        XCTAssertEqual(dashboardReads, 0)
    }

    func testAnOlderServerStillGetsItsReadingsFromTheDashboard() async {
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600))
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 1, icrInsulin: 1) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, glucoseHistory: { [DashboardReading(at: at, value: 120)] })
        await viewModel.load()
        XCTAssertEqual(viewModel.readings.map(\.value), [120])
    }

    func testTheSavedGlucoseShowsUntilTheFirstCheckAndOnlyUnderFiveMinutes() async {
        let start = Date()
        let observed = ISO8601DateFormatter().string(from: start.addingTimeInterval(-120))
        let saved = DashboardResponse(patient_id: "p1", generated_at: observed, glucose: DashboardGlucose(value: 111, unit: "mg/dL", direction: "Flat", observed_at: observed, delta: 2), readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 1, icrInsulin: 1) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, savedRead: saved)
        XCTAssertEqual(viewModel.provisionalGlucose(now: start)?.value, 111)
        XCTAssertNil(viewModel.provisionalGlucose(now: start.addingTimeInterval(181)), "from 5 minutes only the loader")
        XCTAssertFalse(viewModel.canGive, "the slider waits for the check")
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.provisionalGlucose(now: start), "the check's glucose takes over")
    }

    func testTheTabsOpeningIsReportedWithTheNextCheck() async {
        let api = PreviewAPI { carbs, _ in
            var answer = self.preview(carbs: carbs, insulin: 1, icrInsulin: 1)
            answer.server_ms = 950
            return answer
        }
        let viewModel = makeViewModel(api: api)
        await viewModel.load()
        XCTAssertNil(api.lastTiming, "nothing to report on the first check")
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastTiming?.serverMs, 950)
        XCTAssertEqual(api.lastTiming?.attempts, 1)
        await viewModel.refreshPreview()
        XCTAssertNil(api.lastTiming, "reported once")
    }

    func testAReminderTicksSaveAsMealAndClearingItPutsTheBoxBack() {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: nil) }
        let viewModel = makeViewModel(api: api)
        XCTAssertTrue(viewModel.saveAsMeal, "ticked by default")
        viewModel.clearForm()
        XCTAssertTrue(viewModel.saveAsMeal, "ticked again after the form is cleared")
        viewModel.saveAsMeal = false
        viewModel.reminderPlan = BolusReminderPlan(wbt: true)
        XCTAssertTrue(viewModel.saveAsMeal)
        XCTAssertTrue(viewModel.saveAsMealLocked)
        viewModel.reminderPlan = BolusReminderPlan(wbt: true, secondDose: .whenRising)
        viewModel.reminderPlan = BolusReminderPlan()
        XCTAssertFalse(viewModel.saveAsMeal, "back to the unticked box from before the reminder")
        XCTAssertFalse(viewModel.saveAsMealLocked)

        viewModel.saveAsMeal = true
        viewModel.reminderPlan = BolusReminderPlan(wbt: true)
        viewModel.reminderPlan = BolusReminderPlan()
        XCTAssertTrue(viewModel.saveAsMeal, "a box ticked by hand stays ticked")
    }

    func testAnEmptiedDoseStaysEmptyUntilTheICRDoseIsAskedForAgain() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: carbs > 0 ? Double(carbs) / 10 : nil) }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "46"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4,6")

        viewModel.insulinText = ""
        XCTAssertTrue(viewModel.insulinEdited, "an emptied field is the caregiver's: no ICR dose comes back by itself")
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "")
        XCTAssertEqual(api.lastInsulin, 0)
        viewModel.insulinText = "3"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "3")

        viewModel.useICRDose()
        XCTAssertEqual(viewModel.insulinText, "4,6")
        XCTAssertFalse(viewModel.insulinEdited)

        // With both fields emptied the form starts over: the next carbs fill the dose again.
        viewModel.insulinText = ""
        viewModel.carbsText = ""
        XCTAssertFalse(viewModel.insulinEdited)
        viewModel.carbsText = "20"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "2")
    }

    func testTheChartSaysItIsUpdatingUntilTheCheckMatchesTheForm() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let viewModel = makeViewModel(api: api)
        XCTAssertTrue(viewModel.chartIsUpdating, "nothing checked yet")
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.chartIsUpdating)
        viewModel.carbsText = "30"
        XCTAssertTrue(viewModel.chartIsUpdating)
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.chartIsUpdating)
        viewModel.insulinText = "abc"
        XCTAssertFalse(viewModel.chartIsUpdating, "no loader for amounts that cannot be read")
    }

    func testTheChartLoadsUntilTheCheckAndTheReadingsAreIn() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, glucoseHistory: { [DashboardReading(at: "2026-10-21T12:00:00Z", value: 120)] })
        XCTAssertTrue(viewModel.chartIsLoading)
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.chartIsLoading, "the readings are still on their way")
        await viewModel.refreshReadings()
        XCTAssertFalse(viewModel.chartIsLoading)
    }

    func testLeavingTheTabKeepsTheReadingsAndTheCheck() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        var answer = [DashboardReading(at: ISO8601DateFormatter().string(from: Date()), value: 120)]
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, glucoseHistory: { answer })
        await viewModel.load()
        XCTAssertEqual(viewModel.readings.map(\.value), [120])

        // A failed or cut-short read answers nothing: what is on screen stays.
        answer = []
        await viewModel.refreshReadings()
        XCTAssertEqual(viewModel.readings.map(\.value), [120])

        api.failure = CancellationError()
        let task = Task { await viewModel.refreshPreview() }
        task.cancel()
        await task.value
        XCTAssertNil(viewModel.previewError, "a cancelled read is not shown as a failure")
        XCTAssertNotNil(viewModel.preview)
    }

    func testAMealLaterTakesTheICROfItsTime() async {
        // ICR 10 now, 8 in 15 minutes (the server answers for the time it is asked about).
        var api: PreviewAPI!
        api = PreviewAPI { carbs, insulin in
            let later = api.lastMealInMinutes == .some(15)
            let icr = later ? 8.0 : 10.0
            return self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / icr, icrInsulin: Double(carbs) / icr, icr: icr, carbsAt: later ? "2026-10-19T12:15:00Z" : nil)
        }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "40"
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastMealInMinutes, .some(nil), "the usual pre-bolus unless the form says otherwise")
        XCTAssertEqual(viewModel.insulinText, "4")
        viewModel.mealLater = true
        XCTAssertFalse(viewModel.canGive, "the slider waits for the dose of the later ICR")
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastMealInMinutes, .some(15))
        XCTAssertEqual(viewModel.insulinText, "5", "the ICR dose of the meal's time")
        let clock = BolusReminderPlan.clock(ServerDate.parse("2026-10-19T12:15:00Z")!, calendar: .current)
        XCTAssertEqual(viewModel.icrHint, "Z ICR 8 o \(clock) · stuknij liczbę, żeby zmienić")
        XCTAssertTrue(viewModel.canGive)
        viewModel.clearForm()
        XCTAssertFalse(viewModel.mealLater)
    }

    func testCarbsFillTheDoseFromTheICRUntilTheCaregiverChangesIt() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "46"
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4,6")
        XCTAssertFalse(viewModel.insulinEdited)
        XCTAssertEqual(viewModel.icrHint, "Z ICR 10 · stuknij liczbę, żeby zmienić")
        XCTAssertNil(api.lastInsulin, "the server is asked for the ICR dose")
        XCTAssertTrue(viewModel.canGive)

        viewModel.insulinText = "4"
        XCTAssertTrue(viewModel.insulinEdited)
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastInsulin, 4)
        XCTAssertEqual(viewModel.insulinText, "4", "a typed dose is kept")
        XCTAssertEqual(viewModel.icrHint, "Zmieniono ręcznie · z ICR 10: 4,6 j")

        viewModel.useICRDose()
        XCTAssertEqual(viewModel.insulinText, "4,6")
        XCTAssertFalse(viewModel.insulinEdited)
    }

    func testTheConfirmationUsesThePumpStepTrioReports() async throws {
        // The card says 3,85 j (0,05 step); Trio reports a 0,1 pump: the confirmation opens with 3,8 j, checked again.
        var asked: [Decimal?] = []
        let api = PreviewAPI { carbs, insulin in
            asked.append(insulin)
            var result = self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0, icrInsulin: 3.8)
            result.bolus_step = 0.1
            result.bolus_step_source = "PUMP"
            return result
        }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: Decimal(string: "3.85")!))
        let confirmation = try XCTUnwrap(flow.confirmation)
        XCTAssertEqual(confirmation.insulinU, Decimal(string: "3.8"))
        XCTAssertEqual(asked, [Decimal(string: "3.85"), Decimal(string: "3.8")])
        XCTAssertEqual(flow.bolusStep, Decimal(string: "0.1"))
        XCTAssertEqual(confirmation.draft.pumpBolusStep, Decimal(string: "0.1"))

        // An older server (no step in the check): this phone's setting.
        let old = RemoteBolusFlow(patientID: "p1", api: PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: 3.85, icrInsulin: 3.85) }, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await old.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: Decimal(string: "3.85")!))
        XCTAssertEqual(old.confirmation?.insulinU, Decimal(string: "3.85"))
        XCTAssertNil(old.confirmation?.draft.pumpBolusStep)
    }

    func testTheWBTWindowSendsTheCarbsEquivalentAndTheDoseAsTheMealsWBT() async throws {
        let result = WbtSuggestionResult(basis: "STANDARD", dose_units: 1.25, carbs_equivalent_g: 9.6, rationale: "")
        let base = try XCTUnwrap(MealWbtView.wbtBase(result, mealID: "meal-1"))
        XCTAssertEqual(base.source, .wbtScreen)
        XCTAssertEqual(base.carbsG, 10)
        XCTAssertEqual(base.insulinU, Decimal(string: "1.25"))
        XCTAssertEqual(base.wbtMealID, "meal-1")
        XCTAssertNil(MealWbtView.wbtBase(WbtSuggestionResult(basis: "STANDARD", dose_units: 0, carbs_equivalent_g: 0, rationale: ""), mealID: "meal-1"))

        // Changing the amounts in the confirmation keeps it the meal's WBT, and the command says so.
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0, icrInsulin: nil) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await flow.prepare(base)
        await flow.update(carbsG: 12, insulinU: Decimal(string: "1.5")!)
        let draft = try XCTUnwrap(flow.confirmation?.draft)
        XCTAssertEqual(draft.carbsG, 12)
        XCTAssertEqual(draft.wbtMealID, "meal-1")
        XCTAssertEqual(draft.source, .wbtScreen)
    }

    func testTheWBTWindowShowsTheBolusCardWithItsProgress() throws {
        let meal = try JSONDecoder().decode(MealDetail.self, from: Data(#"""
        {"meal_id":"meal-1","status":"CORRECTED","started_at":"2026-10-19T15:06:00.000Z","source_carbs_g":30,"description":"Małe frytki","has_photo":false,
         "macros":{"carbs":{"grams":30,"origin":"CAREGIVER"},"protein":{"grams":3,"origin":"CAREGIVER"},"fat":{"grams":12,"origin":"CAREGIVER"}},
         "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true}
        """#.utf8))
        let result = WbtSuggestionResult(basis: "STANDARD", dose_units: 1.25, carbs_equivalent_g: 9.6, rationale: "Dawka standardowa.")
        let proposed = try XCTUnwrap(MealWbtView.wbtCard(result, meal: meal, command: nil))
        XCTAssertEqual(proposed.state, "PROPOSED")
        XCTAssertEqual(proposed.carbs_g, 10)
        XCTAssertEqual(proposed.reason, "Dawka standardowa.")

        let response = try JSONDecoder().decode(MealWbtSuggestionResponse.self, from: Data(#"""
        {"patient_id":"p1","meal":{"meal_id":"meal-1","status":"CORRECTED","started_at":"2026-10-19T15:06:00.000Z","source_carbs_g":30,"description":"Małe frytki","has_photo":false,
         "macros":{"carbs":{"grams":30,"origin":"CAREGIVER"},"protein":{"grams":3,"origin":"CAREGIVER"},"fat":{"grams":12,"origin":"CAREGIVER"}},
         "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true},
         "suggestion":null,
         "remote_command":{"id":"rc1","status":"SUCCEEDED","status_message":"Bolus podany","carbs_g":10,"insulin_u":1.25,"meal_record_id":null,"sent_by_me":true,"retry_until":null,"meal_state":"SAVING"}}
        """#.utf8))
        let sent = try XCTUnwrap(MealWbtView.wbtCard(result, meal: meal, command: response.remote_command))
        XCTAssertEqual(sent.state, "SENT")
        XCTAssertEqual(sent.progressSteps(loop: LoopSystemKind.trio.names).map(\.title), ["Wysłano", "Podano", "Zapisano"])
        XCTAssertEqual(sent.progressSteps(loop: LoopSystemKind.trio.names).map(\.state), [.done, .done, .active])
        XCTAssertNil(MealWbtView.wbtRetryBase(response.remote_command, mealID: "meal-1"))

        // Trio kept the carbs and refused the bolus: the insulin alone, still the meal's WBT.
        let partial = ConversationBolusProposal.SentCommand(id: "rc2", status: "PARTIAL", status_message: nil, carbs_g: 10, insulin_u: 1.25, meal_record_id: "meal-1", sent_by_me: true, retry_until: "2026-10-19T19:00:00Z", meal_state: "SAVED")
        let retry = try XCTUnwrap(MealWbtView.wbtRetryBase(partial, mealID: "meal-1"))
        XCTAssertEqual(retry.carbsG, 0)
        XCTAssertEqual(retry.wbtMealID, "meal-1")
        XCTAssertNil(MealWbtView.wbtCard(WbtSuggestionResult(basis: "STANDARD", dose_units: 0, carbs_equivalent_g: 0, rationale: ""), meal: meal, command: nil))
    }

    func testADoseOverThisPhonesLimitTurnsTheSliderOffWithTheReason() async throws {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0, icrInsulin: nil) }
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(TrioRemoteSettings(maxBolusUnits: 5, maxCarbsGrams: 100), patientID: "p1")
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: store) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        viewModel.carbsText = "0"
        viewModel.insulinText = "6"
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.canGive)
        XCTAssertEqual(viewModel.limitProblem, "6 j to więcej niż limit bolusa na tym telefonie (5 j). Zmień dawkę albo limit w ustawieniach.")
        viewModel.insulinText = "5"
        await viewModel.refreshPreview()
        XCTAssertNil(viewModel.limitProblem)
        XCTAssertTrue(viewModel.canGive)
        XCTAssertEqual(flow.limitProblem(carbsG: 120, insulinU: 1), "120 g to więcej niż limit węglowodanów na tym telefonie (100 g). Zmień ilość albo limit w ustawieniach.")
    }

    func testTheEmptyFormsCheckDoesNotFlashUnderTypedAmounts() async {
        let invalid = RemoteCommandNotice(code: "INVALID_AMOUNTS", message: "Podaj węglowodany (pełne gramy) i/lub insulinę w krokach pompy (0,05 j).")
        let api = PreviewAPI { carbs, insulin in
            let units = insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10
            return self.preview(carbs: carbs, insulin: units, icrInsulin: Double(carbs) / 10, blocks: carbs == 0 && units == 0 ? [invalid] : [])
        }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = ""
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.visibleBlocks.isEmpty, "an empty form says nothing")
        // Typed, the new check not back yet: the old one is not shown under the new amounts.
        viewModel.carbsText = "46"
        XCTAssertFalse(viewModel.previewMatchesScreen)
        XCTAssertTrue(viewModel.visibleBlocks.isEmpty)
        XCTAssertTrue(viewModel.visibleWarnings.isEmpty)
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.previewMatchesScreen)
    }

    func testTheTopCardKeepsThreeHoursAndTheDoseSaysWhereItComesFrom() async {
        let clock = ISO8601DateFormatter().date(from: "2026-10-19T12:00:00Z")!
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10, icrInsulin: Double(carbs) / 10) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock }, glucoseHistory: {
            [DashboardReading(at: "2026-10-19T08:30:00Z", value: 90), DashboardReading(at: "2026-10-19T09:30:00Z", value: 120), DashboardReading(at: "2026-10-19T11:55:00Z", value: 142)]
        })
        viewModel.carbsText = "46"
        await viewModel.load()
        XCTAssertEqual(viewModel.readings.map(\.value), [120, 142], "only the last 3 hours")
        XCTAssertEqual(viewModel.icrLine, "46 g ÷ ICR 10 = 4,6 j")
        viewModel.carbsText = "50"
        XCTAssertEqual(viewModel.icrLine, "50 g ÷ ICR 10 = 5 j", "by ICR: the dose counted on the phone, not an older check's")
        viewModel.insulinText = "4"
        XCTAssertNil(viewModel.icrLine, "not for the amounts of an older check")
    }

    func testABlockedDoseCannotBeGiven() async {
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 4.6, icrInsulin: 4.6, blocks: [RemoteCommandNotice(code: "LOW_GLUCOSE", message: "Glukoza poniżej 70")]) }
        let viewModel = makeViewModel(api: api)
        viewModel.carbsText = "46"
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.canGive)
    }


    func testASlideOnDataThatNoLongerMatchesTheScreenReadsThemAgainInsteadOfSending() async {
        var clock = ISO8601DateFormatter().date(from: "2026-10-19T12:00:00Z")!
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 4.6, icrInsulin: 4.6) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("nothing may be sent in this test") }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock })
        viewModel.carbsText = "46"
        await viewModel.refreshPreview()
        // Three minutes on screen: the data are read again and the caregiver slides again.
        clock = clock.addingTimeInterval(180)
        await viewModel.slideToGive()
        // bolus-not-sent.v1: a line, not the sheet: nothing got worse, the data were only old.
        XCTAssertNotNil(viewModel.notSent)
        XCTAssertEqual(viewModel.notSent?.dataChanged, false)
        XCTAssertEqual(viewModel.flow.state, .idle)
    }

    func testARetryFromTheHistorySendsTheInsulinAloneWhenTrioKeptTheCarbs() {
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 2, icrInsulin: nil) }
        let viewModel = makeViewModel(api: api)
        let refused = RemoteCommand(id: "rc1", status: "PARTIAL", status_message: "Węglowodany zapisane w Trio, bolus odrzucony", source: "CHAT_CARD", carbs_g: 20, insulin_u: 2.4, icr_g_per_u: 8, meal_description: nil, conversation_id: "c1", proposal_id: "b1", sent_by_me: true, authorized_at: "2026-10-19T12:00:00Z", send_deadline: "2026-10-19T12:02:00Z", sent_at: nil, answered_at: nil, meal_record_id: "m1", loop_action_id: nil, warnings: [])
        viewModel.prepareRetry(of: refused)
        XCTAssertEqual(viewModel.retry, RemoteBolusRetryTarget(followsCommandID: "rc1", proposalID: "b1", conversationID: "c1", carbsKept: true))
        XCTAssertEqual(viewModel.carbsG, 0)
        XCTAssertEqual(viewModel.insulinText, "2,4")
        XCTAssertTrue(viewModel.insulinEdited)
        viewModel.cancelRetry()
        XCTAssertNil(viewModel.retry)
        XCTAssertEqual(viewModel.insulinText, "")
    }

    func testTheSliderFollowsTheCheckOfWhatIsOnScreen() async {
        let invalid = RemoteCommandNotice(code: "INVALID_AMOUNTS", message: "Podaj węglowodany (pełne gramy) i/lub insulinę w krokach pompy.")
        let api = PreviewAPI { carbs, insulin in
            let units = insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? Double(carbs) / 10
            return self.preview(carbs: carbs, insulin: units, icrInsulin: Double(carbs) / 10, blocks: carbs == 0 && units == 0 ? [invalid] : [])
        }
        let viewModel = makeViewModel(api: api)
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.canGive)
        XCTAssertTrue(viewModel.visibleBlocks.isEmpty, "no message on an empty form")
        viewModel.carbsText = "46"
        XCTAssertTrue(viewModel.canGive, "by ICR: the dose counted on the phone, before its check (owner 2026-11-13)")
        viewModel.insulinText = "4"
        XCTAssertFalse(viewModel.canGive, "typed, not checked yet")
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.canGive)
    }

    func testTypedAmountsKeepOnlyWhatTheFieldTakes() {
        XCTAssertEqual(RemoteCommandFormat.sanitizedAmount("4.567", decimal: true), "4,56")
        XCTAssertEqual(RemoteCommandFormat.sanitizedAmount(",5", decimal: true), "0,5")
        XCTAssertEqual(RemoteCommandFormat.sanitizedAmount("4,5,6", decimal: true), "4,56")
        XCTAssertEqual(RemoteCommandFormat.sanitizedAmount("46,5 g", decimal: false), "465")
        XCTAssertEqual(RemoteCommandFormat.sanitizedAmount("1234567", decimal: false), "123456")
    }

    func testABlockedConfirmationIsShownButNotSent() async {
        let api = PreviewAPI { carbs, _ in self.preview(carbs: carbs, insulin: 4.6, icrInsulin: 4.6, blocks: [RemoteCommandNotice(code: "COMMAND_IN_FLIGHT", message: "Poprzednie polecenie czeka na odpowiedź Trio.")]) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 46, insulinU: Decimal(string: "4.6")!))
        XCTAssertEqual(flow.confirmation?.canConfirm, false)
        await flow.confirm()
        XCTAssertNotNil(flow.confirmation, "a blocked confirmation is not sent")
    }

    func testValuesChangedInTheConfirmationAreCheckedAgainInTheSameSheet() async {
        let api = PreviewAPI { carbs, insulin in
            let units = insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0
            return self.preview(carbs: carbs, insulin: units, icrInsulin: Double(carbs) / 10, warnings: units > 6 ? [RemoteCommandNotice(code: "DOSE_DIFFERS_FROM_ICR", message: "Dawka różni się od przelicznika")] : [])
        }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 46, insulinU: Decimal(string: "4.57")!, conversationID: "c1", proposalID: "b1"))
        let first = flow.confirmation
        XCTAssertEqual(first?.insulinU, Decimal(string: "4.55"), "rounded down to the phone's step")
        await flow.update(carbsG: 60, insulinU: 7)
        XCTAssertEqual(flow.confirmation?.id, first?.id)
        XCTAssertEqual(flow.confirmation?.carbsG, 60)
        XCTAssertEqual(flow.confirmation?.draft.proposalID, "b1")
        XCTAssertEqual(flow.confirmation?.draft.acknowledgedWarnings, ["DOSE_DIFFERS_FROM_ICR"])
    }

    func testAFailedCheckOfATypedDoseKeepsTheOldDoseFromBeingSent() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0, icrInsulin: 5) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("the old dose may not be sent") }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 50, insulinU: 5, conversationID: "c1", proposalID: "b1"))
        XCTAssertTrue(flow.confirmationIsCurrent)

        // The card proposed 5 U, the caregiver types 2 U and the check fails.
        api.offline = true
        await flow.update(carbsG: 50, insulinU: 2)
        XCTAssertEqual(flow.confirmation?.insulinU, 5, "the confirmation still holds the old dose")
        XCTAssertEqual(flow.typedAmounts, RemoteBolusAmounts(carbsG: 50, insulinU: 2))
        XCTAssertNotNil(flow.checkError, "the sheet says why")
        XCTAssertFalse(flow.confirmationIsCurrent, "so the slider stays off")
        XCTAssertEqual(flow.state, .idle, "the failure stays in the sheet")
        await flow.confirm()
        XCTAssertNotNil(flow.confirmation, "nothing is sent")

        // Back online: the check of what was typed makes the confirmation current, with the typed dose.
        api.offline = false
        await flow.recheck()
        XCTAssertNil(flow.checkError)
        XCTAssertTrue(flow.confirmationIsCurrent)
        XCTAssertEqual(flow.confirmation?.insulinU, 2)
        XCTAssertEqual(flow.confirmation?.draft.insulinU, 2)
    }

    func testATypedDoseIsConfirmedRoundedToTheStepAndAnOlderCheckNeverWins() async {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: insulin.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 0, icrInsulin: 5) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 50, insulinU: 5))
        await flow.update(carbsG: 50, insulinU: Decimal(string: "2.37")!)
        XCTAssertEqual(flow.confirmation?.insulinU, Decimal(string: "2.35"), "rounded down to the step, as the slider says")
        XCTAssertTrue(flow.confirmationIsCurrent)

        // Typed again while an earlier check was on its way: until the newest check is back the old values are not current.
        let id = flow.confirmation?.id
        flow.confirmation = RemoteBolusConfirmation(id: id!, draftBase: RemoteBolusDraftBase(source: .chatCard, carbsG: 50, insulinU: 4), preview: preview(carbs: 50, insulin: 4, icrInsulin: 5))
        XCTAssertFalse(flow.confirmationIsCurrent, "a confirmation for other values than typed last")

        // A new confirmation starts with nothing typed.
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 10, insulinU: 1))
        XCTAssertNil(flow.typedAmounts)
        XCTAssertTrue(flow.confirmationIsCurrent)
    }
}

// MARK: - ICR schedule kept on the phone (owner 2026-11-13: no ICR dose after a break)

extension RemoteBolusViewModelTests {
    private static let schedule = IcrSchedule(time_zone: "UTC", entries: [.init(from: "00:00", gramsPerUnit: 10), .init(from: "12:10", gramsPerUnit: 8)])
    private static func at(_ hhmm: String) -> Date { ISO8601DateFormatter().date(from: "2026-11-13T\(hhmm):00Z")! }

    func testTheScheduleGivesTheICROfTheMinuteAsTheServerDoes() throws {
        XCTAssertEqual(Self.schedule.gramsPerUnit(at: Self.at("12:09")), 10)
        XCTAssertEqual(Self.schedule.gramsPerUnit(at: Self.at("12:10")), 8)
        XCTAssertEqual(Self.schedule.gramsPerUnit(at: Self.at("23:59")), 8)
        let late = IcrSchedule(time_zone: "UTC", entries: [.init(from: "06:00", gramsPerUnit: 9), .init(from: "18:00", gramsPerUnit: 7)])
        XCTAssertEqual(late.gramsPerUnit(at: Self.at("03:00")), 7, "before the first entry: the day's last one")
        let decoded = try JSONDecoder().decode(IcrSchedule.self, from: Data(#"{"time_zone":"Europe/Warsaw","entries":[["00:00",10],["09:30",8.3]]}"#.utf8))
        XCTAssertEqual(decoded.entries.last, .init(from: "09:30", gramsPerUnit: 8.3))
        XCTAssertNil(IcrSchedule(time_zone: "Nowhere/City", entries: [.init(from: "00:00", gramsPerUnit: 10)]).gramsPerUnit(at: Self.at("12:00")))
    }

    func testAfterABreakTheDoseComesFromTheKeptScheduleBeforeAnyCheck() async {
        UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey)
        let store = InMemoryIcrScheduleStore()
        store.save(.init(schedule: Self.schedule, pumpBolusStep: Decimal(string: "0.1"), savedAt: Self.at("08:00")), patientID: "p1")
        let api = PreviewAPI { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }
        let sender = CountingSender()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { sender }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { Self.at("12:30") }, icrSchedules: store)
        XCTAssertNil(viewModel.preview, "the tab's first check has not answered")
        viewModel.carbsText = "45"
        XCTAssertEqual(viewModel.insulinText, "5,6", "45 g / ICR 8 of 12:30, down to the pump's 0,1 step")
        XCTAssertEqual(viewModel.icrLine, "45 g ÷ ICR 8 = 5,6 j")
        XCTAssertTrue(viewModel.canGive)
        viewModel.sliderHoldsDose = true
        viewModel.give()
        await waitUntil(sender.sent.count == 1)
        XCTAssertEqual(sender.sent.first?.insulinU, Decimal(string: "5.6"))
        XCTAssertEqual(sender.sent.first?.acknowledgedWarnings, [])
        XCTAssertEqual(sender.sent.first?.pumpBolusStep, Decimal(string: "0.1"))
    }

    func testACheckKeepsItsScheduleAndAMealLaterTakesTheICRInFifteenMinutes() async {
        UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey)
        let store = InMemoryIcrScheduleStore()
        let api = PreviewAPI { carbs, insulin in
            var preview = Self.icrPreview(carbs: carbs, insulin: insulin)
            preview.icr_schedule = Self.schedule
            return preview
        }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { CountingSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { Self.at("12:00") }, icrSchedules: store)
        await viewModel.refreshPreview()
        XCTAssertEqual(store.load(patientID: "p1")?.schedule, Self.schedule, "kept for the next opening")
        viewModel.carbsText = "40"
        XCTAssertEqual(viewModel.insulinText, "4", "12:00: ICR 10")
        viewModel.mealLater = true
        XCTAssertEqual(viewModel.insulinText, "5", "eaten at 12:15: ICR 8, at once")
        XCTAssertTrue(viewModel.canGive)
        viewModel.mealLater = false
        XCTAssertEqual(viewModel.insulinText, "4")
    }

    func testAKeptScheduleOlderThanAWeekIsNotUsed() async {
        UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey)
        let store = InMemoryIcrScheduleStore()
        store.save(.init(schedule: Self.schedule, pumpBolusStep: nil, savedAt: Self.at("12:00").addingTimeInterval(-8 * 24 * 3600)), patientID: "p1")
        let api = PreviewAPI { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { CountingSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { Self.at("12:00") }, icrSchedules: store)
        viewModel.carbsText = "40"
        XCTAssertEqual(viewModel.insulinText, "")
        XCTAssertFalse(viewModel.canGive)
    }
}

// MARK: - Dose by ICR before the check (owner 2026-11-13)

extension RemoteBolusViewModelTests {
    private func quickViewModel(_ make: @escaping (Int, Decimal?) -> RemoteCommandPreview, sender: CountingSender? = nil) async -> (RemoteBolusViewModel, PreviewAPI) {
        let sender = sender ?? CountingSender()
        UserDefaults.standard.set("ICR", forKey: DoseBasisPreference.defaultsKey)
        let api = PreviewAPI(make: make)
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { sender }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        // The tab's first check, of the empty form: it brings the ICR.
        await viewModel.refreshPreview()
        return (viewModel, api)
    }

    private static func icrPreview(carbs: Int, insulin: Decimal?, warnings: [RemoteCommandNotice] = [], carbsFirst: Bool = false) -> RemoteCommandPreview {
        var preview = plainPreview(carbs: carbs, insulin: insulin ?? Decimal(carbs) / 10)
        preview = RemoteCommandPreview(carbs_g: preview.carbs_g, insulin_u: preview.insulin_u, icr_g_per_u: 10, icr_insulin_u: carbs > 0 ? Double(carbs) / 10 : nil, context: preview.context, blocks: carbs == 0 && (insulin ?? 0) == 0 ? [RemoteCommandNotice(code: "INVALID_AMOUNTS", message: "Podaj węglowodany.")] : [], warnings: warnings)
        if carbsFirst {
            preview.dose_calculation = DoseCalculation(default_u: 0, icr_dose_u: nil, calculator_u: nil, limited_by: "CARBS_FIRST", summary: "Najpierw węgle")
        }
        return preview
    }

    func testTheICRDoseIsCountedOnThePhoneAsTheServerCountsIt() {
        XCTAssertEqual(RemoteBolusViewModel.icrDose(carbsG: 77, icr: 7.7, step: Decimal(string: "0.05")!), 10)
        XCTAssertEqual(RemoteBolusViewModel.icrDose(carbsG: 46, icr: 10, step: Decimal(string: "0.1")!), Decimal(string: "4.6"))
        XCTAssertEqual(RemoteBolusViewModel.icrDose(carbsG: 10, icr: 3, step: Decimal(string: "0.05")!), Decimal(string: "3.3"))
        XCTAssertEqual(RemoteBolusViewModel.icrDose(carbsG: 10, icr: 6, step: Decimal(string: "0.1")!), Decimal(string: "1.6"))
        XCTAssertNil(RemoteBolusViewModel.icrDose(carbsG: 0, icr: 10, step: Decimal(string: "0.05")!))
    }

    func testCarbsByICRPutTheDoseOnTheFormAndTheSliderOnBeforeTheirCheck() async {
        let (viewModel, api) = await quickViewModel { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }
        let calls = api.calls
        viewModel.carbsText = "46"
        XCTAssertEqual(viewModel.insulinText, "4,6", "at once, no check yet")
        XCTAssertEqual(api.calls, calls)
        XCTAssertFalse(viewModel.insulinEdited)
        XCTAssertTrue(viewModel.quickDoseOnScreen)
        XCTAssertTrue(viewModel.canGive)
        XCTAssertEqual(viewModel.icrLine, "46 g ÷ ICR 10 = 4,6 j")
        XCTAssertTrue(viewModel.visibleWarnings.isEmpty)

        // The check answers: the same dose, now checked; the check was for the dose on screen.
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastInsulin, Decimal(string: "4.6"))
        XCTAssertEqual(viewModel.insulinText, "4,6")
        XCTAssertTrue(viewModel.previewMatchesScreen)
        XCTAssertTrue(viewModel.canGive)

        // A dose typed over it is the caregiver's: the slider waits for its check.
        viewModel.insulinText = "4"
        XCTAssertFalse(viewModel.quickDoseOnScreen)
        XCTAssertFalse(viewModel.canGive)
    }

    func testICRDoseAtOnceAlsoByCalculatorButNotWhenCarbsComeFirst() async {
        UserDefaults.standard.set("CALCULATOR", forKey: DoseBasisPreference.defaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey) }
        let api = PreviewAPI { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { CountingSender() }
        let byCalculator = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        await byCalculator.refreshPreview()
        byCalculator.carbsText = "46"
        // Owner 2026-11-14: carbs / ICR at once on the Bolus tab whatever the dose source.
        XCTAssertEqual(byCalculator.insulinText, "4,6", "carbs / ICR at once, also with the calculator chosen")
        XCTAssertTrue(byCalculator.canGive)

        let (carbsFirst, _) = await quickViewModel { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin, carbsFirst: true) }
        carbsFirst.carbsText = "46"
        XCTAssertEqual(carbsFirst.insulinText, "", "carbs first: the calculator's dose, after the check")
        XCTAssertFalse(carbsFirst.canGive)

        let (later, _) = await quickViewModel { carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }
        later.mealLater = true
        later.carbsText = "46"
        XCTAssertEqual(later.insulinText, "", "\"+15 min\": the ICR of that time comes with the check")
    }

    func testALowForecastAfterTheICRDoseNeverChangesTheDoseOnlyWarns() async {
        let low = RemoteCommandNotice(code: "INSULIN_WHILE_LOW", key: "INSULIN_WHILE_LOW:65", message: "Prognoza poniżej 70.")
        // The server's own default would be the calculator's 0 j (carbs first); the dose on screen is checked as it is.
        let (viewModel, api) = await quickViewModel { carbs, insulin in
            guard carbs > 0 else { return Self.icrPreview(carbs: carbs, insulin: insulin) }
            return insulin == nil
                ? Self.icrPreview(carbs: carbs, insulin: 0, warnings: [low], carbsFirst: true)
                : Self.icrPreview(carbs: carbs, insulin: insulin, warnings: [low])
        }
        viewModel.carbsText = "46"
        XCTAssertEqual(viewModel.insulinText, "4,6")
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastInsulin, Decimal(string: "4.6"), "the check is for the dose on screen")
        XCTAssertEqual(viewModel.insulinText, "4,6", "the number stays")
        XCTAssertEqual(viewModel.visibleWarnings.map(\.code), ["INSULIN_WHILE_LOW"], "the news comes as a warning")
        // Later checks (new readings, live updates, the minute loop) leave it too.
        await viewModel.refreshPreview()
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4,6")
        // New carbs while a low is forecast: not counted on the phone, the slider waits for the check (as before).
        viewModel.carbsText = "30"
        XCTAssertFalse(viewModel.canGive)
    }

    func testADoseFilledByTheCheckIsNotReplacedByALaterCheck() async {
        UserDefaults.standard.set("CALCULATOR", forKey: DoseBasisPreference.defaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: DoseBasisPreference.defaultsKey) }
        var calculatorDose = 2.0
        let api = PreviewAPI { carbs, insulin in
            var result = Self.icrPreview(carbs: carbs, insulin: insulin ?? Decimal(calculatorDose))
            if carbs > 0 { result.dose_calculation = DoseCalculation(default_u: calculatorDose, icr_dose_u: Double(carbs) / 10, calculator_u: calculatorDose, limited_by: "CALCULATOR", summary: "Kalkulator") }
            return result
        }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { CountingSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        await viewModel.refreshPreview()
        viewModel.carbsText = "46"
        await viewModel.refreshPreview()
        // Owner 2026-11-14: carbs / ICR at once (4,6), the calculator's 2 j is the segment's other dose.
        XCTAssertEqual(viewModel.insulinText, "4,6", "the first fill is carbs / ICR, at once")
        XCTAssertEqual(viewModel.doseSwitchValues?.calculator, 2)
        calculatorDose = 1
        await viewModel.refreshPreview()
        XCTAssertEqual(api.lastInsulin, 4.6)
        XCTAssertEqual(viewModel.insulinText, "4,6", "a later check with new data does not touch it")
    }

    func testASlideBeforeTheCheckSendsTheICRDoseWithNothingAcknowledged() async {
        let sender = CountingSender()
        let (viewModel, _) = await quickViewModel({ carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin) }, sender: sender)
        viewModel.carbsText = "46"
        viewModel.sliderHoldsDose = true
        viewModel.give()
        await waitUntil(sender.sent.count == 1)
        let draft = sender.sent.first
        XCTAssertEqual(draft?.carbsG, 46)
        XCTAssertEqual(draft?.insulinU, Decimal(string: "4.6"))
        XCTAssertEqual(draft?.acknowledgedWarnings, [], "the server checks the warnings again and refuses any not seen")
        XCTAssertEqual(draft?.lowGlucoseConfirmed, false)
    }

    func testAWarningThatCameDuringTheSlideStaysOutOfTheFieldsAndStopsTheSlide() async {
        let warning = RemoteCommandNotice(code: "ACTIVE_INSULIN", key: "ACTIVE_INSULIN:2", message: "Aktywna insulina 2 j.")
        let sender = CountingSender()
        let (viewModel, api) = await quickViewModel({ carbs, insulin in Self.icrPreview(carbs: carbs, insulin: insulin, warnings: carbs > 0 ? [warning] : []) }, sender: sender)
        viewModel.carbsText = "46"
        viewModel.sliderHoldsDose = true
        let line = viewModel.icrLine
        // The check answers while the finger is on the slider.
        await viewModel.refreshPreview()
        XCTAssertEqual(viewModel.insulinText, "4,6")
        XCTAssertTrue(viewModel.visibleWarnings.isEmpty, "nothing new in or under the fields while giving")
        XCTAssertNil(viewModel.calculatorLine)
        XCTAssertNil(viewModel.doseSwitch)
        XCTAssertEqual(viewModel.icrLine, line, "the line under the dose stays as it was")

        // The slide sends nothing past a warning nobody saw; the form is free again and shows it, at once (no new check).
        let calls = api.calls
        viewModel.give()
        await waitUntil(viewModel.notSent != nil)
        XCTAssertEqual(viewModel.notSent?.dataChanged, true, "a new warning: the sheet")
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertEqual(api.calls, calls, "the check that came during the slide is the one shown")
        XCTAssertEqual(viewModel.visibleWarnings.map(\.code), ["ACTIVE_INSULIN"])
    }
}

private struct OfflineError: Error {}

// MARK: - DIY acknowledgement

private final class CountingSender: RemoteCommandSending {
    private(set) var sent: [RemoteCommandDraft] = []
    func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        sent.append(draft)
        return .notSent("test: nothing leaves the test")
    }
}

private final class SentCount {
    var count = 0
}

private struct RateLimitedSender: RemoteCommandSending {
    let retryAt: Date
    let sent: SentCount
    func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        sent.count += 1
        return .rateLimited("Apple", retryAt: retryAt)
    }
}

extension RemoteBolusViewModelTests {
    func testAppleRateLimitWaitEndsWithTheFailureGone() async {
        let api = PreviewAPI { carbs, insulin in RemoteBolusViewModelTests.plainPreview(carbs: carbs, insulin: insulin ?? 0) }
        let store = InMemoryDIYAcknowledgementStore()
        let retryAt = Date().addingTimeInterval(60)
        let sent = SentCount()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), acknowledgement: store) { RateLimitedSender(retryAt: retryAt, sent: sent) }
        flow.acceptBolusAcknowledgement()
        await flow.send(RemoteCommandDraft(source: .bolusScreen, carbsG: 20, insulinU: 2, acknowledgedWarnings: [], confirmedAt: Date()))
        XCTAssertEqual(flow.retryAt, retryAt)
        XCTAssertEqual(flow.retryFailure, "Bolus nie został wysłany")
        XCTAssertEqual(flow.state, .failed("Apple"))

        // Nothing goes out during the wait, whichever way it is asked for.
        sent.count = 0
        await flow.send(RemoteCommandDraft(source: .bolusScreen, carbsG: 20, insulinU: 2, acknowledgedWarnings: [], confirmedAt: Date()))
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 20, insulinU: 2))
        await flow.confirm()
        XCTAssertEqual(sent.count, 0)
        flow.cancel()

        // A wait that is not the current one changes nothing.
        flow.retryWaitEnded(retryAt.addingTimeInterval(-5))
        XCTAssertEqual(flow.retryAt, retryAt)

        flow.retryWaitEnded(retryAt)
        XCTAssertNil(flow.retryAt)
        XCTAssertEqual(flow.state, .idle)
        await flow.send(RemoteCommandDraft(source: .bolusScreen, carbsG: 20, insulinU: 2, acknowledgedWarnings: [], confirmedAt: Date()))
        XCTAssertEqual(sent.count, 1, "the wait over, the next try goes out")
    }

    func testNothingIsSentBeforeTheDIYAcknowledgementAndItIsRememberedOnThePhone() async {
        let api = PreviewAPI { carbs, insulin in RemoteBolusViewModelTests.plainPreview(carbs: carbs, insulin: insulin ?? 0) }
        let sender = CountingSender()
        let store = InMemoryDIYAcknowledgementStore()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), acknowledgement: store) { sender }
        XCTAssertFalse(flow.bolusAcknowledged)

        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 20, insulinU: 2))
        XCTAssertEqual(flow.confirmation?.canConfirm, true)
        await flow.confirm()
        XCTAssertTrue(sender.sent.isEmpty, "the confirmation without the acknowledgement sends nothing")
        XCTAssertNotNil(flow.confirmation, "the sheet stays for the acknowledgement")

        // The Bolus tab path (no sheet) is guarded too.
        await flow.send(RemoteCommandDraft(source: .bolusScreen, carbsG: 20, insulinU: 2, acknowledgedWarnings: [], confirmedAt: Date()))
        XCTAssertTrue(sender.sent.isEmpty)
        XCTAssertEqual(flow.state, .failed(DIYAcknowledgement.requiredMessage))

        flow.acceptBolusAcknowledgement()
        XCTAssertTrue(flow.bolusAcknowledged)
        XCTAssertTrue(store.isAccepted(.remoteBolus))
        XCTAssertFalse(store.isAccepted(.pairing), "pairing has its own acceptance")
        await flow.confirm()
        XCTAssertEqual(sender.sent.count, 1)

        // Another flow on the same phone (another patient, another screen) starts accepted.
        let other = RemoteBolusFlow(patientID: "p2", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), acknowledgement: store) { sender }
        XCTAssertTrue(other.bolusAcknowledged)
    }

    func testTheBolusTabSliderStaysOffUntilTheDIYAcknowledgement() async throws {
        let api = PreviewAPI { carbs, insulin in RemoteBolusViewModelTests.plainPreview(carbs: carbs, insulin: insulin ?? 0) }
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), acknowledgement: InMemoryDIYAcknowledgementStore()) { CountingSender() }
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        viewModel.carbsText = "20"
        viewModel.insulinText = "2"
        await viewModel.refreshPreview()
        XCTAssertFalse(viewModel.canGive)
        flow.acceptBolusAcknowledgement()
        XCTAssertTrue(viewModel.canGive)
    }

    /// The Bolus tour's samples (± switch, warnings row) are drawn from BolusTour alone: walking the whole tour over a
    /// sendable form changes none of its values, and the slider is off for every step, on again after the tour.
    func testTheBolusTourSamplesNeverReachTheFormAndTheSliderStaysOff() async {
        let api = PreviewAPI { carbs, insulin in RemoteBolusViewModelTests.plainPreview(carbs: carbs, insulin: insulin ?? 0) }
        let sender = CountingSender()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore(), acknowledgement: InMemoryDIYAcknowledgementStore()) { sender }
        flow.acceptBolusAcknowledgement()
        let viewModel = RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
        viewModel.carbsText = "20"
        viewModel.insulinText = "2"
        await viewModel.refreshPreview()
        XCTAssertTrue(viewModel.canGive)
        XCTAssertNil(viewModel.doseSwitch, "no real switch: the tour shows a sample")
        let before = [viewModel.carbsText, viewModel.insulinText, "\(viewModel.mealLater)", "\(viewModel.saveAsMeal)", "\(viewModel.reminderPlan)", "\(viewModel.insulinEdited)"]

        var tour: SpotlightTour? = BolusTour.start()
        var samples: [BolusTourStage] = []
        while tour?.isActive == true {
            let stage = BolusTour.stage(tour: tour, realRemindersShown: false, realDoseSourceShown: viewModel.doseSwitch != nil, realChecksShown: false)
            samples.append(stage)
            XCTAssertFalse(BolusTour.slideEnabled(viewModel.canGive, tour: tour))
            tour?.next()
        }
        XCTAssertEqual(samples.filter(\.isSample).count, 3, "the alarm clock, the switch and the warnings row")
        let after = [viewModel.carbsText, viewModel.insulinText, "\(viewModel.mealLater)", "\(viewModel.saveAsMeal)", "\(viewModel.reminderPlan)", "\(viewModel.insulinEdited)"]
        XCTAssertEqual(before, after)
        XCTAssertNil(viewModel.doseSwitch)
        XCTAssertTrue(BolusTour.slideEnabled(viewModel.canGive, tour: tour), "the real state is back")
        XCTAssertTrue(sender.sent.isEmpty, "nothing was sent")
    }

    nonisolated static func plainPreview(carbs: Int, insulin: Decimal) -> RemoteCommandPreview {
        RemoteCommandPreview(
            carbs_g: carbs,
            insulin_u: NSDecimalNumber(decimal: insulin).doubleValue,
            icr_g_per_u: 10,
            icr_insulin_u: Double(carbs) / 10,
            context: RemoteCommandContextView(now: ServerDate.string(Date()), glucose: .init(value: 140, observed_at: ServerDate.string(Date()), delta: 1), loop: nil, last_bolus: nil, icr_g_per_u: 10, carbs_at: nil),
            blocks: [],
            warnings: []
        )
    }
}

private final class PreviewAPI: RemoteCommandsAPI {
    let make: (Int, Decimal?) -> RemoteCommandPreview
    var lastInsulin: Decimal?
    var lastMealInMinutes: Int??
    var failure: Error?
    /// The next checks fail (no network).
    var offline = false
    private(set) var calls = 0
    private(set) var lastTiming: RemoteCommandPreviewTiming?

    /// Runs while the check is on its way.
    var beforeAnswer: (() async -> Void)?

    init(make: @escaping (Int, Decimal?) -> RemoteCommandPreview) {
        self.make = make
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?, source: RemoteCommandSource?, plannedBolusID: String?, timing: RemoteCommandPreviewTiming?) async throws -> RemoteCommandPreview {
        lastTiming = timing
        return try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: mealInMinutes, proposalID: proposalID)
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
        calls += 1
        lastInsulin = insulinU
        lastMealInMinutes = mealInMinutes
        if let beforeAnswer {
            self.beforeAnswer = nil
            await beforeAnswer()
        }
        if let failure { throw failure }
        if offline { throw OfflineError() }
        return make(carbsG, insulinU)
    }
    func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand { fatalError() }
    func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand { fatalError() }
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError() }
    func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
    func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { fatalError() }
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError() }
}
