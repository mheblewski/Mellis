import XCTest
@testable import GlucoMindCore

final class HomeWidgetGlanceTests: XCTestCase {
    private let patientID = "8d2b1f0e-6a3c-4c1e-9f57-2a1b3c4d5e6f"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testWidgetLinksOpenTheBolusTabAndTheEquipmentList() {
        let bolus = HomeWidgetLink.bolus(patientID: patientID.uppercased())
        XCTAssertEqual(bolus.url.absoluteString, "https://app.mellis.invalid/patients/\(patientID)/bolus")
        XCTAssertEqual(AppRoute.parse(universalLink: bolus.url), .remoteCommands(patientID: patientID))
        let equipment = HomeWidgetLink.equipment(patientID: patientID)
        XCTAssertEqual(AppRoute.parse(universalLink: equipment.url), .equipment(patientID: patientID))
        XCTAssertNil(HomeWidgetLink.parse(URL(string: "https://app.mellis.invalid/patients/not-a-uuid/bolus")!))
        XCTAssertNil(HomeWidgetLink.parse(URL(string: "https://example.com/patients/\(patientID)/bolus")!))
        // The patient link alone still opens the patient.
        XCTAssertEqual(AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patientID)")!), .patient(patientID: patientID))
    }

    func testEquipmentSummaryShowsTheMostUrgentItemAndCountsTheRest() {
        let fine = HomeWidgetGlance.equipmentSummary(DashboardGlance.equipment(dashboard(reservoir: 120, siteHours: 20), now: now))
        XCTAssertEqual(fine.title, "Sprzęt OK")
        XCTAssertNil(fine.hint)
        XCTAssertEqual(fine.level, .normal)

        let due = HomeWidgetGlance.equipmentSummary(DashboardGlance.equipment(dashboard(reservoir: 8, siteHours: 60), now: now))
        XCTAssertEqual(due.level, .alarm)
        XCTAssertEqual(due.title, "Zbiornik 8 j")
        XCTAssertEqual(due.hint, "wymień teraz")
        XCTAssertEqual(due.more, 1)

        let none = HomeWidgetGlance.equipmentSummary([])
        XCTAssertFalse(none.hasData)
        XCTAssertEqual(none.hint, "brak danych")
    }

    func testLargeTilesPutAttentionFirstThenSensorAndSite() {
        let fine = HomeWidgetGlance.equipmentTiles(DashboardGlance.equipment(dashboard(reservoir: 120, siteHours: 20), now: now))
        XCTAssertEqual(fine.map(\.kind), [.sensor, .site])
        let lowReservoir = HomeWidgetGlance.equipmentTiles(DashboardGlance.equipment(dashboard(reservoir: 8, siteHours: 20), now: now))
        XCTAssertEqual(lowReservoir.map(\.kind), [.reservoir, .sensor])
    }

    func testTimelineRedrawsEveryMinuteUntilTheReadingIsAnHourOld() {
        let reading = now.addingTimeInterval(-3 * 60)
        let dates = HomeWidgetGlance.entryDates(dashboard(observedAt: reading), now: now)
        XCTAssertEqual(dates.first, now)
        XCTAssertEqual(dates.count, 1 + 58)
        XCTAssertEqual(dates.last, reading.addingTimeInterval(60 * 60 + 1))
        // Stale entries keep ticking: the red age is right minute by minute.
        XCTAssertTrue(dates.contains(reading.addingTimeInterval(23 * 60 + 1)))
        XCTAssertEqual(HomeWidgetGlance.readingAge(dashboard(observedAt: reading), now: reading.addingTimeInterval(11 * 60 + 1)), .warning)
        XCTAssertEqual(HomeWidgetGlance.readingAge(dashboard(observedAt: reading), now: reading.addingTimeInterval(16 * 60 + 1)), .alarm)
    }

    /// stale-ui.v1: a stale reading (over 15 min) never tints the widget red, whatever its value; a fresh low or high does.
    func testStaleReadingKeepsTheNormalBackgroundAndOnlyAFreshAlarmTintsIt() {
        let freshLow = dashboard(observedAt: now.addingTimeInterval(-3 * 60), value: 62)
        XCTAssertFalse(HomeWidgetGlance.isStale(freshLow, now: now))
        XCTAssertTrue(HomeWidgetGlance.tintsAlarm(freshLow, now: now))

        let staleInRange = dashboard(observedAt: now.addingTimeInterval(-23 * 60), value: 142)
        XCTAssertTrue(HomeWidgetGlance.isStale(staleInRange, now: now))
        XCTAssertFalse(HomeWidgetGlance.tintsAlarm(staleInRange, now: now), "no red wash for a missing reading")

        let staleLow = dashboard(observedAt: now.addingTimeInterval(-23 * 60), value: 62)
        XCTAssertFalse(HomeWidgetGlance.tintsAlarm(staleLow, now: now), "an old low is shown dimmed, not as an alarm")

        let freshInRange = dashboard(observedAt: now.addingTimeInterval(-3 * 60), value: 142)
        XCTAssertFalse(HomeWidgetGlance.tintsAlarm(freshInRange, now: now))
        XCTAssertTrue(HomeWidgetGlance.isStale(nil, now: now), "no data at all counts as stale")
        // The threshold is the dashboard's red reading age: 15 min is still current, 16 is stale.
        XCTAssertFalse(HomeWidgetGlance.isStale(dashboard(observedAt: now.addingTimeInterval(-15 * 60)), now: now))
        XCTAssertTrue(HomeWidgetGlance.isStale(dashboard(observedAt: now.addingTimeInterval(-16 * 60)), now: now))
    }

    func testStaleAgeText() {
        XCTAssertEqual(StaleReading.ageText(minutes: 0), "teraz")
        XCTAssertEqual(StaleReading.ageText(minutes: 23), "23 min temu")
        XCTAssertEqual(StaleReading.ageText(minutes: 60), "1 h temu")
        XCTAssertEqual(StaleReading.ageText(minutes: 65), "1 h 5 min temu")
        XCTAssertEqual(StaleReading.ageText(minutes: 3 * 24 * 60 + 5), "3 d temu")
        XCTAssertFalse(StaleReading.isStale(minutes: 15))
        XCTAssertTrue(StaleReading.isStale(minutes: 16))
    }

    func testNextReloadIsJustAfterTheNextReadingButNotSoonerThanFiveMinutes() {
        let fresh = dashboard(observedAt: now.addingTimeInterval(-60))
        XCTAssertEqual(HomeWidgetGlance.nextReload(after: fresh, now: now), now.addingTimeInterval(5 * 60))
        let late = dashboard(observedAt: now.addingTimeInterval(-30 * 60))
        XCTAssertEqual(HomeWidgetGlance.nextReload(after: late, now: now), now.addingTimeInterval(5 * 60))
        let justNow = dashboard(observedAt: now)
        XCTAssertEqual(HomeWidgetGlance.nextReload(after: justNow, now: now), now.addingTimeInterval(5 * 60 + 30))
    }

    func testScaleTopFollowsTheDashboardChart() {
        let low = [HomeWidgetGlance.Point(at: now, value: 150)]
        XCTAssertEqual(HomeWidgetGlance.scaleTop(low), 220)
        let high = [HomeWidgetGlance.Point(at: now, value: 263)]
        XCTAssertEqual(HomeWidgetGlance.scaleTop(high), 275)
    }

    private func dashboard(reservoir: Double = 120, siteHours: Double = 20, observedAt: Date? = nil, value: Int = 142) -> DashboardResponse {
        let iso = ISO8601DateFormatter()
        let reading = observedAt ?? now.addingTimeInterval(-120)
        return DashboardResponse(
            patient_id: patientID,
            generated_at: iso.string(from: now),
            glucose: DashboardGlucose(value: value, unit: "mg/dL", direction: "Flat", observed_at: iso.string(from: reading), delta: 1),
            readings: [DashboardReading(at: iso.string(from: reading), value: 142)],
            time_in_range: nil,
            pump: DashboardPump(battery_percent: 70, reservoir_units: reservoir, last_read_at: iso.string(from: now)),
            site_changed_at: iso.string(from: now.addingTimeInterval(-siteHours * 3_600)),
            sensor_started_at: iso.string(from: now.addingTimeInterval(-100 * 3_600))
        )
    }
}
