import XCTest
@testable import GlucoMindCore

/// The pill on Teraz naming another patient below 70 (2026-11-08): fresh low and below 54, two readings of 70 or above
/// to clear it, a grey "no reading" pill for at most 30 minutes, and the most pressing patient first.
final class OtherPatientLowTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func iso(_ minutesAgo: Double) -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    /// The newest reading `minutesAgo` old with `value`, and the one 5 minutes before it with `previous`.
    private func dashboard(_ value: Int, minutesAgo: Double = 2, previous: Int? = nil, direction: String? = "SingleDown") -> DashboardResponse {
        var readings = [DashboardReading(at: iso(minutesAgo), value: value)]
        if let previous { readings.insert(DashboardReading(at: iso(minutesAgo + 5), value: previous), at: 0) }
        return DashboardResponse(
            patient_id: "p",
            generated_at: iso(0),
            glucose: DashboardGlucose(value: value, unit: "mg/dL", direction: direction, observed_at: iso(minutesAgo), delta: -4),
            readings: readings,
            time_in_range: nil,
            pump: nil,
            site_changed_at: nil,
            sensor_started_at: nil
        )
    }

    private func signal(_ dashboard: DashboardResponse?) -> OtherPatientLow? {
        OtherPatientLow.evaluate(patientID: "p", name: "Ewa", dashboard: dashboard, now: now)
    }

    func testInRangeShowsNothing() {
        XCTAssertNil(signal(dashboard(132, previous: 128)))
        XCTAssertNil(signal(nil))
    }

    func testBelow70IsLowAndBelow54Urgent() {
        XCTAssertEqual(signal(dashboard(64, previous: 72))?.level, .low)
        XCTAssertEqual(signal(dashboard(64))?.value, 64)
        XCTAssertEqual(signal(dashboard(53, previous: 58))?.level, .urgent)
        XCTAssertEqual(signal(dashboard(54))?.level, .low)
        XCTAssertNil(signal(dashboard(70, previous: 74)))
    }

    func testOneReadingBackAbove70KeepsItSecondClears() {
        let first = signal(dashboard(72, previous: 66, direction: "FortyFiveUp"))
        XCTAssertEqual(first?.level, .low)
        XCTAssertEqual(first?.value, 72)
        XCTAssertNil(signal(dashboard(76, previous: 72)))
    }

    func testPreviousReadingAfterAGapDoesNotCount() {
        // 66 was 25 minutes before the newest reading: not the one just before it.
        var old = dashboard(74)
        old = DashboardResponse(
            patient_id: "p", generated_at: iso(0), glucose: old.glucose,
            readings: [DashboardReading(at: iso(27), value: 66), DashboardReading(at: iso(2), value: 74)],
            time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil
        )
        XCTAssertNil(signal(old))
    }

    func testOldReadingTurnsGreyForAtMost30Minutes() {
        XCTAssertEqual(signal(dashboard(60, minutesAgo: 10))?.level, .low)
        let grey = signal(dashboard(60, minutesAgo: 12))
        XCTAssertEqual(grey?.level, .noReading)
        XCTAssertEqual(grey?.minutesSinceReading, 12)
        XCTAssertEqual(signal(dashboard(60, minutesAgo: 40))?.level, .noReading)
        XCTAssertNil(signal(dashboard(60, minutesAgo: 41)))
        // An old reading that was in range: nothing, not a grey pill.
        XCTAssertNil(signal(dashboard(120, minutesAgo: 15)))
    }

    func testMostPressingFirst() {
        let ola = OtherPatientLow(patientID: "a", name: "Ewa", level: .low, value: 66, direction: nil, minutesSinceReading: 1)
        let kuba = OtherPatientLow(patientID: "b", name: "Kuba", level: .urgent, value: 52, direction: nil, minutesSinceReading: 1)
        let ania = OtherPatientLow(patientID: "c", name: "Ania", level: .low, value: 61, direction: nil, minutesSinceReading: 1)
        let zosia = OtherPatientLow(patientID: "d", name: "Zosia", level: .noReading, value: 40, direction: nil, minutesSinceReading: 20)
        XCTAssertEqual(OtherPatientLow.mostPressingFirst([ola, zosia, ania, kuba]).map(\.name), ["Kuba", "Ania", "Ewa", "Zosia"])
    }

    func testSpokenLabel() {
        XCTAssertEqual(signal(dashboard(64))?.spokenLabel, "Ewa: glukoza 64, spada.")
        XCTAssertEqual(signal(dashboard(60, minutesAgo: 12))?.spokenLabel, "Ewa: brak odczytu od 12 min.")
    }
}
