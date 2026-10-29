import XCTest
@testable import GlucoMindCore

@MainActor
final class RemoteBolusViewModelTests: XCTestCase {
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

    private func makeViewModel(api: PreviewAPI) -> RemoteBolusViewModel {
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { fatalError("no sending in these tests") }
        return RemoteBolusViewModel(patientID: "p1", api: api, flow: flow)
    }

    func testAReminderTicksSaveAsMealAndClearingItPutsTheBoxBack() {
        let api = PreviewAPI { carbs, insulin in self.preview(carbs: carbs, insulin: Double(carbs) / 10, icrInsulin: nil) }
        let viewModel = makeViewModel(api: api)
        XCTAssertFalse(viewModel.saveAsMeal)
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
        XCTAssertEqual(viewModel.slideNotice, "Dane pacjenta się zmieniły. Sprawdź i przesuń ponownie.")
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

private struct OfflineError: Error {}

// MARK: - DIY acknowledgement

private final class CountingSender: RemoteCommandSending {
    private(set) var sent: [RemoteCommandDraft] = []
    func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        sent.append(draft)
        return .notSent("test: nothing leaves the test")
    }
}

extension RemoteBolusViewModelTests {
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

    init(make: @escaping (Int, Decimal?) -> RemoteCommandPreview) {
        self.make = make
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
        lastInsulin = insulinU
        lastMealInMinutes = mealInMinutes
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
