import XCTest
@testable import GlucoMindCore

final class BolusForecastChartTests: XCTestCase {
    func testDecodesThePreviewChartAndDatesItsPoints() throws {
        let chart = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v1","start":"2026-10-21T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "baseline":[140,139,138],"with_dose":[140,136,131],"band":[0,10,14],"low_at":"2026-10-21T12:10:00.000Z",
         "low_from_dose":true,"carbs_g":0,"insulin_u":3}
        """#.utf8))
        let points = chart.points(chart.with_dose ?? [])
        XCTAssertEqual(points.map(\.value), [140, 136, 131])
        XCTAssertEqual(points.map(\.band), [0, 10, 14])
        XCTAssertEqual(points[2].date.timeIntervalSince(points[0].date), 600)
        XCTAssertEqual(chart.lowDate, points[2].date)
    }

    func testDecodesTheLoopOnlyChartAndItsDoseCheck() throws {
        let chart = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-21T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":[140,139,138],"with_dose":null,"total_with_dose":52,"band":[0,10,14],"low_at":null,
         "low_from_dose":false,"carbs_g":0,"insulin_u":2}
        """#.utf8))
        XCTAssertTrue(chart.isLoopOnly)
        XCTAssertNil(chart.with_dose)
        XCTAssertEqual(chart.totalLowWithoutLine, 52)
        XCTAssertNil(chart.lowDate)
    }

    func testOlderChartsDrawTheDoseLineAndHaveNoTotalCheck() throws {
        let chart = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"start":"2026-10-21T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP","baseline":[140],"with_dose":[140],
         "band":[0],"low_at":null,"low_from_dose":false,"carbs_g":0,"insulin_u":2}
        """#.utf8))
        XCTAssertFalse(chart.isLoopOnly)
        XCTAssertNil(chart.totalLowWithoutLine)
    }

    func testOlderServersSendNoChart() throws {
        let preview = try JSONDecoder().decode(RemoteCommandPreview.self, from: Data(#"""
        {"carbs_g":0,"insulin_u":0,"icr_g_per_u":null,"icr_insulin_u":null,
         "context":{"now":"2026-10-21T12:00:00.000Z","glucose":null,"lowest_recent_glucose":null,"loop":null,"last_bolus":null,"bolus_history_known":true,"recent_remote_bolus":null,"icr_g_per_u":null,"in_flight_command_id":null},
         "blocks":[],"warnings":[]}
        """#.utf8))
        XCTAssertNil(preview.forecast)
    }

    // MARK: - The dashed "z tą dawką" line (excess-insulin.v1)

    private func excessChart(insulin: Double, excess: Double?, line: String? = "[111,100,80,48]", step: Double? = 0.05, doseLine: String = "LOOP_ONLY", total: Int? = 23, min: Int? = 48) throws -> BolusForecastChart {
        let excessJSON = excess.map { String($0) } ?? "null"
        let stepJSON = step.map { #","excess_step_u":\#($0)"# } ?? ""
        return try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-30T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"\#(doseLine)","baseline":[111,111,111,111],"with_dose":null,"total_with_dose":\#(total.map(String.init) ?? "null"),"band":[0,5,7,9],
         "low_at":null,"low_from_dose":false,"carbs_g":1,"insulin_u":\#(insulin),"excess_policy":"excess-insulin.v1",
         "excess_insulin_u":\#(excessJSON)\#(stepJSON),"with_excess":\#(line ?? "null"),"with_excess_min":\#(min.map(String.init) ?? "null")}
        """#.utf8))
    }

    func testTheOwnersCaseDrawsTheDashedLineAndTheWarningIsItsLowestPoint() throws {
        let chart = try excessChart(insulin: 1, excess: 0.9)
        XCTAssertEqual(chart.excessLine, [111, 100, 80, 48])
        XCTAssertEqual(chart.excessLineMin, 48)
        // Not the old full-effect arithmetic (total_with_dose 23): the dashed line's own lowest point.
        XCTAssertEqual(chart.totalLowWithoutLine, 48)
        XCTAssertEqual(chart.totalLowWithoutLine, chart.excessLine?.min())
        let summary = BolusCheckSummary.make(forecastLowAt: nil, totalLowWithoutLine: chart.totalLowWithoutLine, totalFromDashedLine: chart.hasExcessModel)
        XCTAssertEqual(summary.headline?.headline, "Po tej dawce ok. 48 mg/dL")
        XCTAssertTrue(summary.headline?.fullText.contains("linia przerywana") == true)
    }

    func testNoDashedLineAtTheICRDoseOrWithinOneStep() throws {
        XCTAssertNil(try excessChart(insulin: 5, excess: 0, line: "null", min: nil).excessLine)
        // Less than one pump step off (a server that drew it anyway): one line.
        XCTAssertNil(try excessChart(insulin: 5.05, excess: 0.05, step: 0.1).excessLine)
        XCTAssertNotNil(try excessChart(insulin: 5.1, excess: 0.1, step: 0.1).excessLine)
        // No step from the server: 0,05 j.
        XCTAssertNotNil(try excessChart(insulin: 5.05, excess: 0.05, step: nil).excessLine)
        XCTAssertNil(try excessChart(insulin: 5.05, excess: 0.04, step: nil).excessLine)
        // The MODEL chart: none. (No dose with carbs on the form draws it since excess-insulin.v2: the carbs' rise.)
        XCTAssertNotNil(try excessChart(insulin: 0, excess: -0.13).excessLine)
        XCTAssertNil(try excessChart(insulin: 1, excess: 0.9, doseLine: "MODEL").excessLine)
        XCTAssertNil(try excessChart(insulin: 1, excess: nil).excessLine)
    }

    func testADoseBelowTheICRDoseDrawsTheLineButNeverWarns() throws {
        let chart = try excessChart(insulin: 4.5, excess: -0.5, line: "[111,113,118,124]", min: 111)
        XCTAssertEqual(chart.excessLine, [111, 113, 118, 124])
        XCTAssertNil(chart.totalLowWithoutLine)
    }

    func testTheDashedLineAboveSeventyHasNoWarningEvenWhenTheOldArithmeticWouldWarn() throws {
        let chart = try excessChart(insulin: 1, excess: 0.3, line: "[111,105,95,88]", total: 40, min: 88)
        XCTAssertNotNil(chart.excessLine)
        XCTAssertNil(chart.totalLowWithoutLine)
    }

    func testAPreviewFromAServerBeforeTheDashedLineDecodesAndKeepsTheOldCheck() throws {
        let chart = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-21T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":[111,111,111],"with_dose":null,"total_with_dose":24,"band":[0,10,14],"low_at":null,
         "low_from_dose":false,"carbs_g":1,"insulin_u":1}
        """#.utf8))
        XCTAssertFalse(chart.hasExcessModel)
        XCTAssertNil(chart.excessLine)
        XCTAssertNil(chart.with_excess)
        XCTAssertEqual(chart.totalLowWithoutLine, 24)
        let summary = BolusCheckSummary.make(forecastLowAt: nil, totalLowWithoutLine: chart.totalLowWithoutLine, totalFromDashedLine: chart.hasExcessModel)
        XCTAssertTrue(summary.headline?.fullText.hasPrefix("Po pełnym działaniu") == true)
    }

    // MARK: - Carbs with the dose field empty (excess-insulin.v2)

    func testCarbsWithAnEmptyDoseDrawTheRisingLineLabelledWithTheCarbsAndNeverWarn() throws {
        let chart = try excessChart(insulin: 0, excess: -1.25, line: "[111,112,130,180]", total: 236, min: 111)
        XCTAssertEqual(chart.excessLine, [111, 112, 130, 180])
        XCTAssertTrue(chart.excessLineIsCarbsOnly)
        XCTAssertEqual(chart.excessLegend, "z węglami")
        XCTAssertNil(chart.totalLowWithoutLine)
        // A dose typed: "z tą dawką".
        XCTAssertEqual(try excessChart(insulin: 1, excess: 0.9).excessLegend, "z tą dawką")
        XCTAssertFalse(try excessChart(insulin: 1, excess: 0.9).excessLineIsCarbsOnly)
    }

    func testNothingTypedOrTheICRDoseDrawsNoSecondLine() throws {
        let nothing = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-30T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":[111,111,111],"with_dose":null,"total_with_dose":null,"band":[0,5,7],"low_at":null,
         "low_from_dose":false,"carbs_g":0,"insulin_u":0,"excess_policy":"excess-insulin.v2","excess_insulin_u":0,"excess_step_u":0.05,
         "with_excess":null,"with_excess_min":null}
        """#.utf8))
        XCTAssertNil(nothing.excessLine)
        XCTAssertNil(nothing.excessLegend)
        XCTAssertNil(try excessChart(insulin: 5, excess: 0, line: "null", min: nil).excessLegend)
    }

    // MARK: - The insulin curve (insulin-curve.v1)

    func testTheInsulinCurveLineForTheInfoPopover() throws {
        var chart = try excessChart(insulin: 1, excess: 0.9)
        XCTAssertNil(chart.insulinCurveDescription, "an older server sends no curve")
        chart.insulin_peak_min = 75
        chart.insulin_curve = "rapid-acting"
        chart.insulin_curve_source = "DEFAULT"
        chart.insulin_dia_hours = 6
        XCTAssertEqual(chart.insulinCurveDescription, "Krzywa insuliny: rapid-acting (szczyt 75 min, domyślnie), DIA 6 h")
        chart.insulin_peak_min = 55
        chart.insulin_curve = "ultra-rapid"
        chart.insulin_curve_source = "LOOP_INSULIN_TYPE"
        chart.insulin_type = "Fiasp"
        chart.insulin_dia_hours = 6.5
        XCTAssertEqual(chart.insulinCurveDescription, "Krzywa insuliny: ultra-rapid · Fiasp (szczyt 55 min), DIA 6,5 h")
    }

    func testANewPreviewDecodesTheCurveFields() throws {
        let chart = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-30T12:00:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":[111,111],"with_dose":null,"total_with_dose":null,"band":[0,5],"low_at":null,
         "low_from_dose":false,"carbs_g":10,"insulin_u":0,"excess_policy":"excess-insulin.v2","excess_insulin_u":-1.25,"excess_step_u":0.05,
         "with_excess":[111,113],"with_excess_min":111,"insulin_peak_min":75,"insulin_curve":"rapid-acting","insulin_curve_source":"DEFAULT",
         "insulin_type":null,"insulin_dia_hours":10}
        """#.utf8))
        XCTAssertEqual(chart.insulin_peak_min, 75)
        XCTAssertEqual(chart.insulin_dia_hours, 10)
        XCTAssertEqual(chart.insulinCurveDescription, "Krzywa insuliny: rapid-acting (szczyt 75 min, domyślnie), DIA 10 h")
        XCTAssertEqual(chart.excessLegend, "z węglami")
    }

    // MARK: - One red marker (2026-10-30)

    /// The owner's case: 78 ↘ −8, IOB 1,41; Trio's line down to ~50 and staying; 10 g + 0,3 j typed (0,95 j under carbs /
    /// ICR 8): the dashed line follows Trio's down, then rises. Built as the server builds it (oref's curve, DIA 6 h,
    /// peak 75, the dose 3 min after the newest reading).
    private func ownersMarkerCase() throws -> BolusForecastChart {
        let minutes = stride(from: 0.0, through: 180, by: 5).map { $0 }
        let (dia, peak) = (360.0, 75.0)
        let tau = peak * (1 - peak / dia) / (1 - 2 * peak / dia), a = 2 * tau / dia, s = 1 / (1 - a + (1 + a) * exp(-dia / tau))
        let onBoard = { (t: Double) -> Double in t <= 0 ? 1 : t >= dia ? 0 : 1 - s * (1 - a) * ((t * t / (tau * dia * (1 - a)) - t / tau - 1) * exp(-t / tau) + 1) }
        let baseline = minutes.map { Int((50 + 28 * exp(-$0 / 17.5)).rounded()) }
        let dashed = minutes.enumerated().map { index, t in Int((Double(baseline[index]) + 0.95 * 100 * (1 - onBoard(t - 3))).rounded()) }
        let ints = { (values: [Int]) in "[" + values.map(String.init).joined(separator: ",") + "]" }
        return try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-30T20:57:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":\#(ints(baseline)),"with_dose":null,"total_with_dose":145,"band":\#(ints(minutes.map { _ in 0 })),
         "low_at":"2026-10-30T21:07:00.000Z","low_from_dose":false,"carbs_g":10,"insulin_u":0.3,"excess_policy":"excess-insulin.v2",
         "excess_insulin_u":-0.95,"excess_step_u":0.05,"with_excess":\#(ints(dashed)),"with_excess_min":\#(dashed.min()!)}
        """#.utf8))
    }

    func testTheOwnersCaseHasOneMarkerAtTheDashedLinesLowestPointNotWhereTheLoopLineCrosses70() throws {
        let chart = try ownersMarkerCase()
        let dashed = try XCTUnwrap(chart.excessLine)
        let marker = try XCTUnwrap(chart.lowMarker)
        let lowest = dashed.min()!
        XCTAssertLessThan(lowest, 70)
        XCTAssertEqual(marker.value, lowest)
        // At the dashed line's first lowest point, not at the loop line's crossing of 70 (low_at) nor at its 50.
        let index = dashed.firstIndex(of: lowest)!
        XCTAssertEqual(marker.date, ServerDate.parse(chart.start)!.addingTimeInterval(Double(index * 5) * 60))
        XCTAssertNotEqual(marker.date, chart.lowDate)
        XCTAssertGreaterThan(marker.value, chart.baseline.min()!)
        XCTAssertEqual(BolusForecastChart.lowMarkerLabel(marker), "\(lowest) · \(RemoteCommandFormat.time(marker.date))")
        XCTAssertEqual(BolusForecastChart.lowMarkerSpoken(marker), "najniżej \(lowest) mg/dL o \(RemoteCommandFormat.time(marker.date))")
        // A dose below the ICR dose: "Po tej dawce" stays only for insulin above the carbs; the warnings row is unchanged.
        XCTAssertNil(chart.totalLowWithoutLine)
        XCTAssertEqual(chart.excessLegend, "z tą dawką")
    }

    func testWithoutTheDashedLineTheMarkerIsTheLoopLinesLowestPointAndNoneAbove70() throws {
        let loopOnly = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7","start":"2026-10-30T20:57:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"LOOP_ONLY","baseline":[78,68,60,54,51,50,50,50],"with_dose":null,"total_with_dose":null,"band":[0,0,0,0,0,0,0,0],
         "low_at":"2026-10-30T21:02:00.000Z","low_from_dose":false,"carbs_g":0,"insulin_u":0}
        """#.utf8))
        let marker = try XCTUnwrap(loopOnly.lowMarker)
        XCTAssertEqual(marker.value, 50)
        // The first time it gets there (21:22), not later on the flat part.
        XCTAssertEqual(marker.date, ServerDate.parse("2026-10-30T21:22:00.000Z"))
        let high = try excessChart(insulin: 1, excess: 0.3, line: "[111,105,95,88]", total: 40, min: 88)
        XCTAssertNil(high.lowMarker, "the dashed line stays above 70: no marker, even if the loop's line were lower")
        // The MODEL chart: the line with the dose.
        let model = try JSONDecoder().decode(BolusForecastChart.self, from: Data(#"""
        {"policy_version":"bolus-forecast.v7+fitted-v1","start":"2026-10-30T20:57:00.000Z","step_minutes":5,"baseline_source":"LOOP",
         "dose_line":"MODEL","baseline":[100,90,80],"with_dose":[100,80,65],"total_with_dose":null,"band":[0,0,0],
         "low_at":null,"low_from_dose":true,"carbs_g":0,"insulin_u":1}
        """#.utf8))
        XCTAssertEqual(model.lowMarker?.value, 65)
    }

    // MARK: - dose-calculator.v3 (T4b): the forecast nudge needs no new UI

    func testAForecastNudgedDefaultIsALoweredDoseWithItsOneShortLineAndNoHigherOffer() throws {
        let calculation = try JSONDecoder().decode(DoseCalculation.self, from: Data(#"""
        {"reason_code":"ACTIVE_INSULIN","default_u":0.6,"icr_dose_u":1.4,"calculator_u":0.3,"limited_by":"FORECAST",
         "summary":"0,6 j zamiast 1,4 j z przelicznika: połowa drogi od kalkulatora pętli (0,3 j — IOB 1,1 j, glukoza 90 i rośnie) do 1 j, przy której prognoza pętli z tą dawką nie schodzi poniżej 90 mg/dL.",
         "short_summary":"↓ 0,8 j mniej niż z przelicznika (1,4 j): IOB i prognoza pętli","calculated":true,"higher_u":1.6}
        """#.utf8))
        XCTAssertTrue(calculation.lowersDose)
        XCTAssertFalse(calculation.carbsFirst)
        XCTAssertFalse(calculation.offersHigher)
        XCTAssertEqual(calculation.line, "↓ 0,8 j mniej niż z przelicznika (1,4 j): IOB i prognoza pętli")
        XCTAssertTrue(calculation.details?.contains("połowa drogi") == true)
    }
}
