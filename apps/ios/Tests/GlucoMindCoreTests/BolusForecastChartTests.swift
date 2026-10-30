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
        // No dose on the form, or the MODEL chart: none.
        XCTAssertNil(try excessChart(insulin: 0, excess: 0.9).excessLine)
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
}
