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

    func testOlderServersSendNoChart() throws {
        let preview = try JSONDecoder().decode(RemoteCommandPreview.self, from: Data(#"""
        {"carbs_g":0,"insulin_u":0,"icr_g_per_u":null,"icr_insulin_u":null,
         "context":{"now":"2026-10-21T12:00:00.000Z","glucose":null,"lowest_recent_glucose":null,"loop":null,"last_bolus":null,"bolus_history_known":true,"recent_remote_bolus":null,"icr_g_per_u":null,"in_flight_command_id":null},
         "blocks":[],"warnings":[]}
        """#.utf8))
        XCTAssertNil(preview.forecast)
    }
}
