import XCTest
@testable import GlucoMindCore

final class QuietHoursTests: XCTestCase {
    private let night = QuietHoursSettings(enabled: true, start_minute: 22 * 60, end_minute: 7 * 60, time_zone: "Europe/Warsaw", low_warnings: true)

    private func warsaw(_ text: String) -> Date {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: text)!
    }

    func testSummaryAndNextDay() {
        XCTAssertEqual(night.summary, "22:00–7:00")
        XCTAssertEqual(night.spokenSummary, "od 22:00 do 7:00")
        XCTAssertTrue(night.endsNextDay)
        XCTAssertEqual(QuietHoursSettings(enabled: false).summary, "Wyłączone")
        XCTAssertFalse(QuietHoursSettings(enabled: true, start_minute: 13 * 60, end_minute: 15 * 60 + 30).endsNextDay)
        XCTAssertEqual(QuietHoursSettings.clock(7 * 60 + 5), "7:05")
    }

    func testContainsAcrossMidnightInTheStoredZone() {
        XCTAssertFalse(night.contains(warsaw("2026-11-22T20:59:00Z")))
        XCTAssertTrue(night.contains(warsaw("2026-11-22T21:00:00Z")))
        XCTAssertTrue(night.contains(warsaw("2026-11-23T05:59:00Z")))
        XCTAssertFalse(night.contains(warsaw("2026-11-23T06:00:00Z")))
        XCTAssertFalse(QuietHoursSettings(enabled: false).contains(warsaw("2026-11-22T23:00:00Z")))
    }

    func testDecodesTheServerAnswerAndSendsOnlyChangedFields() throws {
        let json = #"{"device_id":"d","enabled":true,"start_minute":1320,"end_minute":420,"time_zone":"Europe/Warsaw","low_warnings":false,"updated_at":null,"start":"22:00","end":"07:00"}"#
        let settings = try JSONDecoder().decode(QuietHoursSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings, QuietHoursSettings(enabled: true, start_minute: 1320, end_minute: 420, time_zone: "Europe/Warsaw", low_warnings: false))
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(QuietHoursChange(enabled: true, time_zone: "Europe/Warsaw"))) as! [String: Any]
        XCTAssertEqual(Set(body.keys), ["enabled", "time_zone"])
    }

    func testStoreRemembersTheLastSettingsAndTheIntro() {
        let defaults = UserDefaults(suiteName: "QuietHoursTests")!
        defaults.removePersistentDomain(forName: "QuietHoursTests")
        XCTAssertNil(QuietHoursStore.current(defaults: defaults))
        QuietHoursStore.remember(night, defaults: defaults)
        XCTAssertEqual(QuietHoursStore.current(defaults: defaults), night)
        XCTAssertFalse(QuietHoursStore.introShown(defaults: defaults))
        QuietHoursStore.markIntroShown(defaults: defaults)
        XCTAssertTrue(QuietHoursStore.introShown(defaults: defaults))
    }
}
