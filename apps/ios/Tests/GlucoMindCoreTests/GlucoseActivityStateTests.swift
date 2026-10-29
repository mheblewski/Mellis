import XCTest
@testable import GlucoMindCore

final class GlucoseActivityStateTests: XCTestCase {
    /// The server's content-state (live-activity-state.ts) decodes as the activity's ContentState.
    func testDecodesTheServersContentState() throws {
        let json = """
        {"glucose":142,"direction":"FortyFiveUp","delta":4,"readingAt":1793095080,"iob":1.35,"cob":22,"reservoir":8,
         "reservoirFull":200,"battery":64,"siteChangedAt":1792922400,"sensorStartedAt":null,
         "readings":[[1793094780,138],[1793095080,142]],"boluses":[[1793091600,3.2]]}
        """
        let state = try JSONDecoder().decode(GlucoseActivityState.self, from: Data(json.utf8))
        XCTAssertEqual(state.glucose, 142)
        XCTAssertEqual(state.readingDate, Date(timeIntervalSince1970: 1_793_095_080))
        XCTAssertEqual(state.readings.last, [1_793_095_080, 142])
        let due = DashboardGlance.attention(state.equipment(now: Date(timeIntervalSince1970: 1_793_095_200)))
        XCTAssertEqual(due.first?.kind, .reservoir)
        XCTAssertEqual(due.first?.hint, "wymień teraz")
    }

    func testChangeSendsOnlyTheFieldsGivenAndNullToClear() {
        let body = LiveActivityChange(activityID: .clear, updateToken: .set("abc")).body
        XCTAssertTrue(body["activity_id"] is NSNull)
        XCTAssertEqual(body["update_token"] as? String, "abc")
        XCTAssertNil(body["enabled"])
        XCTAssertNil(body["start_token"])
    }
}

final class GlucoseActivityIslandTests: XCTestCase {
    func testIslandDefaultsToShownAndFollowsTheServer() throws {
        let base = #"{"glucose":142,"direction":null,"delta":null,"readingAt":null,"iob":null,"cob":null,"reservoir":null,"reservoirFull":null,"battery":null,"siteChangedAt":null,"sensorStartedAt":null,"readings":[],"boluses":[]"#
        let older = try JSONDecoder().decode(GlucoseActivityState.self, from: Data((base + "}").utf8))
        XCTAssertTrue(older.islandShowsIOB)
        let iconOnly = try JSONDecoder().decode(GlucoseActivityState.self, from: Data((base + #","islandEnabled":false}"#).utf8))
        XCTAssertFalse(iconOnly.islandShowsIOB)
        XCTAssertEqual(LiveActivityChange(islandEnabled: false).body["island_enabled"] as? Bool, false)
    }
}
