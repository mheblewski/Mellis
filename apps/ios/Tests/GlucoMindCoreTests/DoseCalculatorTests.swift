import XCTest
@testable import GlucoMindCore

/// The Bolus tab starts from the loop-style calculator's dose (dose-calculator.v1), explains it in one line, and asks
/// separately before insulin while glucose is low.
@MainActor
final class DoseCalculatorTests: XCTestCase {
    private final class CalculatorAPI: RemoteCommandsAPI {
        var calculation: DoseCalculation?
        /// The calculation at 0 g (dose-calculator.v2's correction alone).
        var zeroCalculation: DoseCalculation?
        var warnings: [RemoteCommandNotice] = []
        var sources: [RemoteCommandSource?] = []

        func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview {
            try await previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: mealInMinutes, proposalID: proposalID, source: nil)
        }
        func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?, source: RemoteCommandSource?) async throws -> RemoteCommandPreview {
            sources.append(source)
            // As the server: with an empty dose it answers the calculator's default (or carbs / ICR without one).
            let icr = carbsG > 0 ? Double(carbsG) / 10 : nil
            let insulin = insulinU.map { NSDecimalNumber(decimal: $0).doubleValue } ?? (calculation?.default_u ?? icr ?? 0)
            var preview = RemoteCommandPreview(carbs_g: carbsG, insulin_u: insulin, icr_g_per_u: 10, icr_insulin_u: icr,
                                               context: RemoteCommandContextView(now: "2026-10-29T12:00:00Z", glucose: .init(value: 120, observed_at: "2026-10-29T11:58:00Z", delta: 0), loop: nil, last_bolus: nil, icr_g_per_u: 10),
                                               blocks: [], warnings: insulin > 0 ? warnings : [])
            preview.dose_calculation = carbsG > 0 ? calculation : zeroCalculation
            return preview
        }
        func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand { fatalError() }
        func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand { fatalError() }
        func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError() }
        func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
        func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { fatalError() }
        func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError() }
    }

    private final class CountingSender: RemoteCommandSending, @unchecked Sendable {
        var drafts: [RemoteCommandDraft] = []
        func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
            drafts.append(draft)
            return .notSent("test")
        }
    }

    private let lowered = DoseCalculation(default_u: 1.2, icr_dose_u: 3, calculator_u: 1.2, limited_by: "CALCULATOR", summary: "Kalkulator pętli: 1,2 j zamiast 3 j z przelicznika — IOB 2 j, glukoza 120.")

    private func viewModel(_ api: CalculatorAPI, sender: CountingSender? = nil) -> RemoteBolusViewModel {
        let sender = sender ?? CountingSender()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { sender }
        let clock = ISO8601DateFormatter().date(from: "2026-10-29T12:00:00Z")!
        return RemoteBolusViewModel(patientID: "p1", api: api, flow: flow, now: { clock })
    }

    func testAnEmptyDoseStartsFromTheCalculatorAndSaysWhy() async {
        let api = CalculatorAPI()
        api.calculation = lowered
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "1,2", "the calculator's default, not carbs / ICR (3 j)")
        XCTAssertEqual(model.calculatorLine, "Kalkulator pętli: 1,2 j zamiast 3 j z przelicznika — IOB 2 j, glukoza 120.")
        XCTAssertTrue(model.calculatorLowersDose)
        XCTAssertEqual(api.sources.last, .bolusScreen)

        // Typed over, "Przywróć" brings back the calculator's dose.
        model.insulinText = "3"
        await model.refreshPreview()
        XCTAssertEqual(model.defaultDose, 1.2)
        model.useICRDose()
        XCTAssertEqual(model.insulinText, "1,2")
        XCTAssertFalse(model.insulinEdited)
    }

    func testAnOlderServerStillFillsCarbsOverICR() async {
        let model = viewModel(CalculatorAPI())
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "3")
        XCTAssertNil(model.calculatorLine)
        XCTAssertFalse(model.calculatorLowersDose)
    }

    func testInsulinWhileGlucoseIsLowNeedsTheSeparateConfirmation() async {
        let api = CalculatorAPI()
        api.calculation = DoseCalculation(default_u: 0, icr_dose_u: 3, calculator_u: 2.4, limited_by: "CARBS_FIRST", summary: "Najpierw węglowodany: glukoza 64 mg/dL, insulina 0 j (z przelicznika 3 j).")
        api.warnings = [RemoteCommandNotice(code: "INSULIN_WHILE_LOW", key: "INSULIN_WHILE_LOW:BELOW_70:64", message: "Glukoza 64 mg/dL: najpierw węglowodany.", severity: "DANGER")]
        let sender = CountingSender()
        let model = viewModel(api, sender: sender)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "0", "carbs first: no insulin pre-filled")
        XCTAssertTrue(api.calculation!.carbsFirst)

        model.insulinText = "1"
        await model.refreshPreview()
        await model.slideToGive()
        XCTAssertTrue(model.pendingLowGlucoseConfirmation, "the slide opens the separate step")
        XCTAssertTrue(sender.drafts.isEmpty, "nothing sent before it is confirmed")

        await model.slideToGive(lowGlucoseConfirmed: true)
        XCTAssertFalse(model.pendingLowGlucoseConfirmation)
        XCTAssertEqual(sender.drafts.count, 1)
        XCTAssertEqual(sender.drafts.first?.acknowledgedWarnings, ["INSULIN_WHILE_LOW:BELOW_70:64"])
        XCTAssertEqual(sender.drafts.first?.lowGlucoseConfirmed, true, "the server needs low_glucose_confirmed (review H1)")
    }

    func testOnlyTheSeparateStepMarksTheCommandLowGlucoseConfirmed() async {
        // Without INSULIN_WHILE_LOW nothing is marked, even if the caller passes the flag.
        let api = CalculatorAPI()
        let sender = CountingSender()
        let model = viewModel(api, sender: sender)
        model.carbsText = "30"
        await model.refreshPreview()
        await model.slideToGive(lowGlucoseConfirmed: true)
        XCTAssertEqual(sender.drafts.first?.lowGlucoseConfirmed, false)
    }

    func testTheLineIsShortWithTheWholeExplanationBehindIt() async {
        let api = CalculatorAPI()
        api.calculation = DoseCalculation(default_u: 2.25, icr_dose_u: 4, calculator_u: 2.25, limited_by: "CALCULATOR",
                                          summary: "Kalkulator pętli: 2,25 j zamiast 4 j z przelicznika — IOB 1,85 j, glukoza 124 i spada · Trio: prognoza 92 mg/dL, poniżej celu 100.",
                                          short_summary: "↓ 1,75 j mniej niż z przelicznika (4 j): aktywna insulina",
                                          formula: "40 g / ICR 10 + (124 − 18 − 100) / 50 − IOB 1,85 j = 2,25 j")
        let model = viewModel(api)
        model.carbsText = "40"
        await model.refreshPreview()
        XCTAssertEqual(model.calculatorLine, "↓ 1,75 j mniej niż z przelicznika (4 j): aktywna insulina")
        XCTAssertFalse(model.calculatorLine!.contains("IOB"), "values shown elsewhere stay out of the line (owner 2026-10-29)")
        XCTAssertEqual(model.calculatorDetails, "Kalkulator pętli: 2,25 j zamiast 4 j z przelicznika — IOB 1,85 j, glukoza 124 i spada · Trio: prognoza 92 mg/dL, poniżej celu 100.\n\nWzór: 40 g / ICR 10 + (124 − 18 − 100) / 50 − IOB 1,85 j = 2,25 j")
        // An older server: the long line, nothing behind it.
        XCTAssertNil(lowered.details)
        XCTAssertEqual(lowered.line, lowered.summary)
    }

    func testTheConfirmationAsksSeparatelyBeforeInsulinWhileLow() async {
        let api = CalculatorAPI()
        api.warnings = [RemoteCommandNotice(code: "INSULIN_WHILE_LOW", key: "INSULIN_WHILE_LOW:BELOW_70:64", message: "Glukoza 64 mg/dL", severity: "DANGER")]
        let sender = CountingSender()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { sender }
        await flow.prepare(RemoteBolusDraftBase(source: .chatCard, carbsG: 30, insulinU: 2, conversationID: "c1", proposalID: "b1"))
        XCTAssertTrue(flow.confirmationNeedsLowGlucoseStep)
        XCTAssertEqual(api.sources.last, .chatCard)
        await flow.confirm()
        XCTAssertTrue(sender.drafts.isEmpty)
        XCTAssertNotNil(flow.confirmation, "the sheet stays open")
        await flow.confirm(lowGlucoseConfirmed: true)
        XCTAssertEqual(sender.drafts.count, 1)
        XCTAssertEqual(sender.drafts.first?.lowGlucoseConfirmed, true)
    }

    func testAPlannedPartIsCheckedWithItsID() async {
        final class PlannedAPI: RemoteCommandsAPI {
            var plannedIDs: [String?] = []
            func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview { fatalError() }
            func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?, source: RemoteCommandSource?, plannedBolusID: String?) async throws -> RemoteCommandPreview {
                plannedIDs.append(plannedBolusID)
                return RemoteCommandPreview(carbs_g: carbsG, insulin_u: 2.4, icr_g_per_u: 10, icr_insulin_u: nil,
                                            context: RemoteCommandContextView(now: "2026-10-29T12:00:00Z", glucose: nil, loop: nil, last_bolus: nil, icr_g_per_u: 10), blocks: [], warnings: [])
            }
            func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand { fatalError() }
            func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand { fatalError() }
            func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError() }
            func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
            func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { fatalError() }
            func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError() }
        }
        let api = PlannedAPI()
        let flow = RemoteBolusFlow(patientID: "p1", api: api, settingsStore: InMemoryTrioRemoteSettingsStore()) { CountingSender() }
        await flow.prepare(RemoteBolusDraftBase(source: .plannedBolus, carbsG: 0, insulinU: Decimal(string: "2.4")!, plannedBolusID: "plan-1"))
        XCTAssertEqual(api.plannedIDs, ["plan-1"])
    }

    func testThePreviewAndTheCardDecodeTheCalculation() throws {
        let json = #"{"carbs_g":30,"insulin_u":1.2,"icr_g_per_u":10,"icr_insulin_u":3,"context":{"now":"2026-10-29T12:00:00Z","glucose":null,"loop":null,"last_bolus":null,"icr_g_per_u":10},"blocks":[],"warnings":[{"code":"DOSE_ABOVE_CALCULATOR","key":"DOSE_ABOVE_CALCULATOR:3:1.2","message":"3 j to o 1,8 j więcej","severity":"DANGER"}],"dose_calculation":{"policy_version":"dose-calculator.v1","carbs_g":30,"default_u":1.2,"icr_dose_u":3,"calculator_u":1.2,"limited_by":"CALCULATOR","summary":"Kalkulator pętli: 1,2 j","calculated":true,"fallback_reason":null,"breakdown":{"carbs_u":3},"drop":null,"carbs_first":null,"loop_signal":null,"reference_u":1.2}}"#
        let preview = try JSONDecoder().decode(RemoteCommandPreview.self, from: Data(json.utf8))
        XCTAssertEqual(preview.dose_calculation?.default_u, 1.2)
        XCTAssertTrue(preview.dose_calculation?.lowersDose ?? false)
        XCTAssertTrue(preview.warnings[0].isDanger)
        XCTAssertFalse(preview.warnings[0].needsSeparateConfirmation)
    }

    // MARK: The calculator switch (icon) in the insulin field's corner

    func testTheCornerButtonSwitchesBetweenTheLowerDefaultAndCarbsOverICR() async {
        let api = CalculatorAPI()
        var calculation = lowered
        calculation.reason_code = "ACTIVE_INSULIN"
        api.calculation = calculation
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "1,2")
        XCTAssertEqual(model.doseSourceOffer, .icr, "the calculator lowered the dose: carbs / ICR is offered")
        XCTAssertEqual(model.doseSwitch, .init(selected: .calculator, addsCorrection: false), "the calculator segment filled: the calculator's dose is on")
        XCTAssertFalse(model.icrDoseChosen)

        model.useDoseSource(.icr)
        XCTAssertEqual(model.insulinText, "3", "carbs / ICR on the form")
        XCTAssertTrue(model.insulinEdited, "checked and sent as the caregiver's dose")
        XCTAssertEqual(model.doseSourceOffer, .calculator, "the switch goes off at once (no blink while checked)")
        XCTAssertEqual(model.doseSwitch, .init(selected: .icr, addsCorrection: false), "the ICR segment filled at once (no blink while checked)")
        await model.refreshPreview()
        XCTAssertTrue(model.icrDoseChosen)
        XCTAssertEqual(model.calculatorLine, "Z przelicznika: 1,8\u{00A0}j więcej niż kalkulator (aktywna insulina)")
        XCTAssertTrue(model.calculatorLowersDose, "the line in the warning colour")

        model.useDoseSource(.calculator)
        XCTAssertEqual(model.insulinText, "1,2", "back to the calculator's lower default")
        XCTAssertFalse(model.insulinEdited)
        await model.refreshPreview()
        XCTAssertEqual(model.doseSourceOffer, .icr)
        XCTAssertEqual(model.doseSwitch, .init(selected: .calculator, addsCorrection: false))
        XCTAssertFalse(model.icrDoseChosen)
        XCTAssertEqual(model.calculatorLine, lowered.summary, "the calculator's own line again")
    }

    func testATypedDoseKeepsTheButtonAndItBringsBackTheCalculator() async {
        let api = CalculatorAPI()
        api.calculation = lowered
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        model.insulinText = "2"
        XCTAssertEqual(model.doseSourceOffer, .calculator, "a dose typed over: the switch stays, off, offering the calculator's dose")
        XCTAssertEqual(model.doseSwitch, .init(selected: nil, addsCorrection: false), "a typed dose: neither segment filled")
        await model.refreshPreview()
        XCTAssertFalse(model.icrDoseChosen)
        XCTAssertEqual(model.calculatorLine, "Kalkulator: 1,2\u{00A0}j", "the calculator's dose, not its explanation")
        model.useDoseSource(.calculator)
        XCTAssertEqual(model.insulinText, "1,2")
        await model.refreshPreview()
        model.useDoseSource(.icr)
        XCTAssertEqual(model.insulinText, "3")

        // A dose typed over carbs / ICR: the button offers the calculator again.
        await model.refreshPreview()
        model.insulinText = "3,5"
        XCTAssertEqual(model.doseSourceOffer, .calculator)
    }

    func testTheTwoSegmentSwitchTogglesAndATypedDosePicksTheTappedSegment() async {
        let api = CalculatorAPI()
        api.calculation = lowered
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.doseSwitch?.selected, .calculator)
        XCTAssertEqual(model.doseSwitch?.accessibilityValue, "kalkulator")

        // A tap anywhere switches, also on the segment already filled.
        model.tapDoseSwitch(.calculator)
        XCTAssertEqual(model.insulinText, "3")
        XCTAssertEqual(model.doseSwitch?.selected, .icr)
        XCTAssertEqual(model.doseSwitch?.accessibilityValue, "przelicznik")
        await model.refreshPreview()
        model.tapDoseSwitch(.icr)
        XCTAssertEqual(model.insulinText, "1,2")
        await model.refreshPreview()
        model.tapDoseSwitch(nil)
        XCTAssertEqual(model.insulinText, "3", "VoiceOver's adjustable action switches too")
        await model.refreshPreview()

        // Typed by hand: neither filled; the tapped segment's dose goes on the form.
        model.insulinText = "2"
        XCTAssertEqual(model.doseSwitch, .init(selected: nil, addsCorrection: false))
        XCTAssertEqual(model.doseSwitch?.accessibilityValue, "wpisana ręcznie")
        model.tapDoseSwitch(.icr)
        XCTAssertEqual(model.insulinText, "3")
        await model.refreshPreview()
        model.insulinText = "2"
        await model.refreshPreview()
        model.tapDoseSwitch(.calculator)
        XCTAssertEqual(model.insulinText, "1,2")
        XCTAssertFalse(model.insulinEdited)
    }

    func testTheSwitchInTheHigherModeIsICRAndTheCalculatorWithTheCorrection() async {
        let api = CalculatorAPI()
        api.calculation = mealTopUp()
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.doseSwitch, .init(selected: .icr, addsCorrection: true), "the higher dose is never pre-filled")
        model.tapDoseSwitch(.icr)
        XCTAssertEqual(model.insulinText, "3,4", "a tap anywhere: the calculator with the correction")
        await model.refreshPreview()
        model.tapDoseSwitch(.icr)
        XCTAssertEqual(model.insulinText, "3")
        await model.refreshPreview()
        model.insulinText = "5"
        XCTAssertEqual(model.doseSwitch, .init(selected: nil, addsCorrection: true))
        model.tapDoseSwitch(.calculator)
        XCTAssertEqual(model.insulinText, "3,4")
    }

    func testNoCornerButtonWhenTheCalculatorDidNotLowerTheDose() async {
        let api = CalculatorAPI()
        api.calculation = DoseCalculation(default_u: 3, icr_dose_u: 3, calculator_u: 3.4, limited_by: "ICR", summary: "Z przelicznika 3 j.", short_summary: "Z przelicznika")
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "3")
        XCTAssertNil(model.doseSourceOffer)
        XCTAssertNil(model.doseSwitch)
        model.insulinText = "2"
        await model.refreshPreview()
        XCTAssertNil(model.doseSourceOffer, "a typed dose has \"Przywróć\" in the footer instead")
        XCTAssertEqual(model.defaultDose, 3)

        // An older server (no calculation) and an empty form: no button either.
        let older = viewModel(CalculatorAPI())
        older.carbsText = "30"
        await older.refreshPreview()
        XCTAssertNil(older.doseSourceOffer)
        let empty = viewModel(api)
        await empty.refreshPreview()
        XCTAssertNil(empty.doseSourceOffer)
    }

    // MARK: The opt-in higher dose (dose-calculator.v2)

    private func mealTopUp() -> DoseCalculation {
        var calculation = DoseCalculation(default_u: 3, icr_dose_u: 3, calculator_u: 3.8, limited_by: "ICR", summary: "Z przelicznika 3 j · kalkulator pętli 3,8 j (IOB 0,1 j, glukoza 190).", short_summary: "Z przelicznika")
        calculation.higher_u = 3.4
        calculation.higher_reason_code = "MEAL_TOP_UP"
        calculation.higher_summary = "+0,4\u{00A0}j korekty do przelicznika (glukoza 190, aktywna insulina 0,1\u{00A0}j)"
        calculation.higher_formula = "30 g / ICR 10 = 3 j; korekta: 0,5 × ((190 − 100) / 100 − IOB 0,1 j) = 0,4 j → 0,4 j; razem 3,4 j"
        return calculation
    }

    func testAMealTopUpIsOffWithTheDefaultAndOnWithTheHigherDose() async {
        let api = CalculatorAPI()
        api.calculation = mealTopUp()
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "3", "the default stays carbs / ICR: the higher dose is never pre-filled")
        XCTAssertEqual(model.doseSourceOffer, .higher)
        XCTAssertEqual(model.doseSwitch, .init(selected: .icr, addsCorrection: true), "ICR (the default) by default")
        XCTAssertTrue(model.doseSwitchAddsCorrection)
        XCTAssertEqual(model.calculatorLine, "Korekta do wyboru: +0,4\u{00A0}j (±)", "short: one line of the Insulina tile")
        XCTAssertTrue(model.calculatorDetails?.hasPrefix("Z przelicznika 3 j · kalkulator pętli 3,8 j") ?? false, "the default's own explanation stays behind ⓘ")
        XCTAssertTrue(model.calculatorDetails?.contains("glukoza 190, aktywna insulina 0,1\u{00A0}j") ?? false)

        model.useDoseSource(.higher)
        XCTAssertEqual(model.insulinText, "3,4")
        XCTAssertTrue(model.insulinEdited)
        XCTAssertEqual(model.doseSwitch, .init(selected: .calculator, addsCorrection: true))
        await model.refreshPreview()
        XCTAssertTrue(model.higherDoseChosen)
        XCTAssertEqual(model.calculatorLine, "+0,4\u{00A0}j korekty do przelicznika (połowa)")
        XCTAssertTrue(model.calculatorDetails?.hasPrefix("+0,4\u{00A0}j korekty do przelicznika (glukoza 190, aktywna insulina 0,1\u{00A0}j)") ?? false, "glucose and IOB behind ⓘ")
        XCTAssertFalse(model.calculatorLowersDose, "not the warning colour")
        XCTAssertTrue(model.calculatorDetails?.contains("Wzór: 30 g / ICR 10 = 3 j; korekta") ?? false)
        XCTAssertTrue(model.calculatorDetails?.contains("Połowa wyliczonej korekty") ?? false)

        model.useDoseSource(.withoutHigher)
        XCTAssertEqual(model.insulinText, "3", "back to the default")
        XCTAssertFalse(model.insulinEdited)
        await model.refreshPreview()
        XCTAssertEqual(model.doseSwitch, .init(selected: .icr, addsCorrection: true))
    }

    func testTheCorrectionAloneAtZeroGrams() async {
        let api = CalculatorAPI()
        var zero = DoseCalculation(default_u: 0, icr_dose_u: nil, calculator_u: 0.6, limited_by: "ICR", summary: "Kalkulator pętli: 0,6 j (IOB 0,3 j, glukoza 210 i rośnie).", short_summary: "Kalkulator: 0,6 j")
        zero.higher_u = 0.4
        zero.higher_reason_code = "CORRECTION_ONLY"
        zero.higher_summary = "Korekta: +0,4\u{00A0}j (połowa wyliczenia: glukoza 210 i rośnie, aktywna insulina 0,3\u{00A0}j)"
        api.zeroCalculation = zero
        let model = viewModel(api)
        await model.refreshPreview()
        XCTAssertEqual(model.insulinText, "", "nothing pre-filled at 0 g")
        XCTAssertEqual(model.doseSourceOffer, .higher, "the switch shows at 0 g")
        XCTAssertEqual(model.doseSwitch, .init(selected: .icr, addsCorrection: true), "the empty default at 0 g counts as ICR")
        XCTAssertEqual(model.calculatorLine, "Korekta do wyboru: +0,4\u{00A0}j (±)")

        model.useDoseSource(.higher)
        XCTAssertEqual(model.insulinText, "0,4")
        await model.refreshPreview()
        XCTAssertEqual(model.doseSwitch, .init(selected: .calculator, addsCorrection: true))
        XCTAssertEqual(model.calculatorLine, "+0,4\u{00A0}j korekty (połowa)")
        XCTAssertTrue(model.calculatorDetails?.hasPrefix("Korekta: +0,4\u{00A0}j (połowa wyliczenia: glukoza 210 i rośnie, aktywna insulina 0,3\u{00A0}j)") ?? false, "glucose, trend and IOB behind ⓘ")
        XCTAssertTrue(model.calculatorDetails?.contains("Połowa wyliczonej korekty") ?? false)
        XCTAssertTrue(model.canGive, "an insulin-only dose is sent as before")

        model.useDoseSource(.withoutHigher)
        XCTAssertEqual(model.insulinText, "", "back to no dose")
        XCTAssertFalse(model.insulinEdited)
        await model.refreshPreview()
        XCTAssertEqual(model.doseSourceOffer, .higher)
    }

    func testTheLowerModeWinsOverAHigherDose() async {
        let api = CalculatorAPI()
        var calculation = lowered
        calculation.higher_u = 3.4
        api.calculation = calculation
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        XCTAssertEqual(model.doseSourceOffer, .icr, "the calculator lowered the dose: only the lower mode")
        XCTAssertFalse(model.doseSwitchAddsCorrection)
        XCTAssertNil(RemoteBolusViewModel.higherDose(model.preview!))
    }

    func testAnOlderServerOrATypedDoseKeepsTheSwitchOff() async throws {
        // An older server: no higher fields, nothing changes.
        let json = #"{"default_u":3,"icr_dose_u":3,"calculator_u":3.8,"limited_by":"ICR","summary":"Z przelicznika 3 j."}"#
        let older = try JSONDecoder().decode(DoseCalculation.self, from: Data(json.utf8))
        XCTAssertFalse(older.offersHigher)
        // v2's fields decode.
        let v2 = #"{"default_u":3,"icr_dose_u":3,"calculator_u":3.8,"limited_by":"ICR","summary":"","higher_u":3.4,"higher_reason_code":"MEAL_TOP_UP","higher_breakdown":{"base_u":3,"glucose_mgdl":190,"trend_mgdl":null,"target_mgdl":100,"isf_mgdl_per_u":100,"iob_subtracted_u":0.1,"full_correction_u":0.8,"fraction":0.5,"half_u":0.4,"cap_u":1,"capped":false,"extra_u":0.4},"higher_gate":null}"#
        let decoded = try JSONDecoder().decode(DoseCalculation.self, from: Data(v2.utf8))
        XCTAssertEqual(decoded.higherExtraU, 0.4)
        XCTAssertEqual(decoded.higher_breakdown?.extra_u, 0.4)

        let api = CalculatorAPI()
        api.calculation = mealTopUp()
        let model = viewModel(api)
        model.carbsText = "30"
        await model.refreshPreview()
        model.insulinText = "5"
        await model.refreshPreview()
        XCTAssertEqual(model.doseSourceOffer, .higher, "a typed dose: off, offering the higher dose")
        XCTAssertEqual(model.calculatorLine, "Kalkulator: 3\u{00A0}j", "a typed dose: the calculator's dose")
    }

    // MARK: The line under the dose per source (1.0.5)

    func testTheLineUnderTheDosePerSource() async {
        // The owner's case: glucose falling, the calculator gives 0 j instead of 1,2 j (12 g, ICR 10).
        let api = CalculatorAPI()
        var falling = DoseCalculation(default_u: 0, icr_dose_u: 1.2, calculator_u: 0, limited_by: "DROP", summary: "Kalkulator pętli: 0 j zamiast 1,2 j z przelicznika — glukoza 110 i spada.", short_summary: "0\u{00A0}j zamiast 1,2\u{00A0}j z przelicznika: glukoza spada")
        falling.reason_code = "FALLING"
        falling.lowered_by_u = 1.2
        api.calculation = falling
        let model = viewModel(api)
        model.carbsText = "12"
        await model.refreshPreview()

        // Default: the calculator's own line.
        XCTAssertFalse(model.insulinEdited)
        XCTAssertEqual(model.calculatorLine, "0\u{00A0}j zamiast 1,2\u{00A0}j z przelicznika: glukoza spada")

        // ICR by the ± button: how much more than the calculator.
        model.useDoseSource(.icr)
        await model.refreshPreview()
        XCTAssertEqual(model.calculatorLine, "Z przelicznika: 1,2\u{00A0}j więcej niż kalkulator (glukoza spada)")

        // Typed: the calculator's dose and its short reason, never "↓ … mniej niż z przelicznika".
        model.insulinText = "1"
        await model.refreshPreview()
        XCTAssertEqual(model.calculatorLine, "Kalkulator: 0\u{00A0}j (glukoza spada)")
        XCTAssertEqual(model.doseSourceOffer, .calculator, "the ± button still brings the calculator back")
        XCTAssertNotNil(model.calculatorDetails, "the whole explanation stays behind ⓘ")

        // Typed equal to the calculator: nothing.
        model.insulinText = "0"
        await model.refreshPreview()
        XCTAssertNil(model.calculatorLine)

        // Higher by the ± button: what the correction adds; typed over it: the calculator's dose.
        let higherAPI = CalculatorAPI()
        higherAPI.calculation = mealTopUp()
        let higher = viewModel(higherAPI)
        higher.carbsText = "30"
        await higher.refreshPreview()
        higher.useDoseSource(.higher)
        await higher.refreshPreview()
        XCTAssertEqual(higher.calculatorLine, "+0,4\u{00A0}j korekty do przelicznika (połowa)")
        higher.insulinText = "3,2"
        await higher.refreshPreview()
        XCTAssertEqual(higher.calculatorLine, "Kalkulator: 3\u{00A0}j")
    }

    func testTheTypedDoseLineWordsPerReason() {
        func line(_ code: String?, default u: Double = 0.5) -> String? {
            var calculation = DoseCalculation(default_u: u, icr_dose_u: 2, calculator_u: u, limited_by: "CALCULATOR", summary: "x")
            calculation.reason_code = code
            return RemoteBolusViewModel.typedDoseLine(calculation, insulin: 1)
        }
        XCTAssertEqual(line("ACTIVE_INSULIN"), "Kalkulator: 0,5\u{00A0}j (aktywna insulina)")
        XCTAssertEqual(line("BELOW_TARGET"), "Kalkulator: 0,5\u{00A0}j (glukoza poniżej celu)")
        XCTAssertEqual(line("LOW_CARBS_FIRST", default: 0), "Kalkulator: 0\u{00A0}j (niska glukoza — najpierw węglowodany)")
        XCTAssertEqual(line("LOOP_FORECAST_LOW"), "Kalkulator: 0,5\u{00A0}j (prognoza poniżej celu)")
        XCTAssertEqual(line(nil), "Kalkulator: 0,5\u{00A0}j")
        XCTAssertNil(line("FALLING", default: 1), "the calculator gives the typed dose")
        // 0 g: the calculator's correction.
        let zero = DoseCalculation(default_u: 0, icr_dose_u: nil, calculator_u: 0.6, limited_by: "ICR", summary: "x")
        XCTAssertEqual(RemoteBolusViewModel.typedDoseLine(zero, insulin: 1), "Kalkulator: 0,6\u{00A0}j")
    }
}
