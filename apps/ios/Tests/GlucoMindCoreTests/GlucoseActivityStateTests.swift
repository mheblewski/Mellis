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

/// The activity's stale date: when the newest reading shown turns stale by the widgets' rule (StaleReading), computed
/// from the content every time (an app-side update never keeps an older activity's date).
final class GlucoseActivityStaleDateTests: XCTestCase {
    private func state(readingAt: Double?, others: [GlucoseActivityPatient]? = nil) -> GlucoseActivityState {
        GlucoseActivityState(glucose: 120, direction: nil, delta: nil, readingAt: readingAt, iob: nil, cob: nil, reservoir: nil,
                             reservoirFull: nil, battery: nil, siteChangedAt: nil, sensorStartedAt: nil, readings: [], boluses: [],
                             others: others)
    }

    func testStaleDateIsWhenTheWidgetsDimTheReading() throws {
        let reading = Date(timeIntervalSince1970: 1_793_095_080)
        let staleDate = try XCTUnwrap(state(readingAt: reading.timeIntervalSince1970).staleDate)
        XCTAssertEqual(staleDate, reading.addingTimeInterval(16 * 60))
        // The widgets' check flips exactly there: fresh a second before, stale at it.
        XCTAssertFalse(StaleReading.isStale(observedAt: reading, now: staleDate.addingTimeInterval(-1)))
        XCTAssertTrue(StaleReading.isStale(observedAt: reading, now: staleDate))
        XCTAssertEqual(StaleReading.staleDate(observedAt: reading), staleDate)
    }

    func testStaleDateFollowsTheNewestReadingOfTwoPatients() {
        let second = GlucoseActivityPatient(id: "b", name: "Kuba", glucose: 90, direction: nil, delta: nil, readingAt: 1_793_095_380, iob: nil)
        XCTAssertEqual(state(readingAt: 1_793_095_080, others: [second]).staleDate, Date(timeIntervalSince1970: 1_793_095_380 + 960))
        XCTAssertEqual(state(readingAt: nil, others: [second]).staleDate, Date(timeIntervalSince1970: 1_793_095_380 + 960))
    }

    func testStaleDateIsRecomputedWhenTheReadingChanges() {
        var changed = state(readingAt: 1_793_095_080)
        changed.readingAt = 1_793_095_380
        XCTAssertEqual(changed.staleDate, Date(timeIntervalSince1970: 1_793_095_380 + 960))
        XCTAssertNil(state(readingAt: nil).staleDate)
    }
}
