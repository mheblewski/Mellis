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

    func testTimelineRedrawsEveryMinuteUntilTheReadingIsTwentyMinutesOld() {
        let reading = now.addingTimeInterval(-3 * 60)
        let dates = HomeWidgetGlance.entryDates(dashboard(observedAt: reading), now: now)
        XCTAssertEqual(dates.first, now)
        XCTAssertEqual(dates.count, 1 + 18)
        XCTAssertEqual(dates.last, reading.addingTimeInterval(20 * 60 + 1))
        XCTAssertEqual(HomeWidgetGlance.readingAge(dashboard(observedAt: reading), now: reading.addingTimeInterval(11 * 60 + 1)), .warning)
        XCTAssertEqual(HomeWidgetGlance.readingAge(dashboard(observedAt: reading), now: reading.addingTimeInterval(16 * 60 + 1)), .alarm)
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

    private func dashboard(reservoir: Double = 120, siteHours: Double = 20, observedAt: Date? = nil) -> DashboardResponse {
        let iso = ISO8601DateFormatter()
        let reading = observedAt ?? now.addingTimeInterval(-120)
        return DashboardResponse(
            patient_id: patientID,
            generated_at: iso.string(from: now),
            glucose: DashboardGlucose(value: 142, unit: "mg/dL", direction: "Flat", observed_at: iso.string(from: reading), delta: 1),
            readings: [DashboardReading(at: iso.string(from: reading), value: 142)],
            time_in_range: nil,
            pump: DashboardPump(battery_percent: 70, reservoir_units: reservoir, last_read_at: iso.string(from: now)),
            site_changed_at: iso.string(from: now.addingTimeInterval(-siteHours * 3_600)),
            sensor_started_at: iso.string(from: now.addingTimeInterval(-100 * 3_600))
        )
    }
}
