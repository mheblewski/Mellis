import XCTest
@testable import GlucoMindCore

final class SettingsTextTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testRelativeReadingTimesInPolish() {
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(-20), now: now), "przed chwilą")
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(-3 * 60), now: now), "3 min temu")
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(-2 * 3600 - 60), now: now), "2 godz. temu")
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(-26 * 3600), now: now), "1 dzień temu")
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(-5 * 86400), now: now), "5 dni temu")
        // A reading stamped a little ahead of this phone's clock is "przed chwilą", never negative.
        XCTAssertEqual(SettingsText.relative(now.addingTimeInterval(30), now: now), "przed chwilą")
        XCTAssertEqual(SettingsText.relativeCapitalized(now.addingTimeInterval(-10), now: now), "Przed chwilą")
    }

    func testThePatientRowSaysWhatIsKnown() {
        let trio = LoopSystemInfo(kind: "TRIO", version: "0.5")
        XCTAssertEqual(SettingsText.patientSubtitle(birthYear: 2019, loop: trio, lastReadingAt: now.addingTimeInterval(-180), now: now), "2019 · Trio · ostatni odczyt 3 min temu")
        XCTAssertEqual(SettingsText.patientSubtitle(birthYear: nil, loop: .unknown, lastReadingAt: nil, now: now), "")
        XCTAssertEqual(SettingsText.patientSubtitle(birthYear: 2015, loop: nil, lastReadingAt: nil, now: now), "2015")
    }

    func testAReadingOlderThanFifteenMinutesIsStale() {
        XCTAssertFalse(SettingsText.isStale(now.addingTimeInterval(-14 * 60), now: now))
        XCTAssertTrue(SettingsText.isStale(now.addingTimeInterval(-16 * 60), now: now))
        XCTAssertTrue(SettingsText.isStale(nil, now: now))
    }
}
