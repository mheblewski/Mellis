import XCTest
@testable import GlucoMindCore

final class DashboardBasalCapsuleTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-11-03T12:00:00Z")!

    private func iso(minutesAgo: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    private func capsule(rate: Double?, plan: Double?, source: String = "TEMP", sinceMinutes: Double? = 25, loopMinutes: Int = 2,
                         override: DashboardBasalNow.Override? = nil, smb: Double = 0) -> DashboardBasalCapsule {
        let basal = DashboardBasalNow(rate: rate, source: source, since: sinceMinutes.map { iso(minutesAgo: $0) }, plan_rate: plan,
                                      profile_rate: override == nil ? plan : 0.2, override: override, smb_last_hour_units: smb)
        return DashboardBasalCapsule.make(basal, loopMinutes: loopMinutes, now: now)
    }

    func testAsPlannedShowsOneNumber() {
        let c = capsule(rate: 0.2, plan: 0.2, source: "PROFILE")
        XCTAssertEqual(c.value, "0,2 j/h")
        XCTAssertNil(c.plan)
        XCTAssertEqual(c.details, ["Baza 0,2 j/h, zgodnie z planem."])
    }

    func testZeroFromTheLoopShowsThePlanAndHowLongInTheBubble() {
        let c = capsule(rate: 0, plan: 0.2, sinceMinutes: 70, smb: 0.6)
        XCTAssertEqual(c.title, "Baza")
        XCTAssertEqual(c.value, "0 j/h")
        XCTAssertEqual(c.plan, "z 0,2")
        XCTAssertFalse(c.dimmed)
        XCTAssertEqual(c.details, [
            "Pętla ustawiła bazę na 0 j/h. W planie jest 0,2 j/h.",
            "Tak jest od 1 godz. 10 min.",
            "Mikrobolusy w ostatniej godzinie: 0,6 j.",
            "Pętla sama zmienia bazę według prognozy glikemii.",
        ])
    }

    func testRaisedRateAndAJustStartedChange() {
        let c = capsule(rate: 0.45, plan: 0.2, sinceMinutes: 2)
        XCTAssertEqual(c.value, "0,45 j/h")
        XCTAssertEqual(c.plan, "z 0,2")
        XCTAssertTrue(c.details.contains("Tak jest od chwili."))
    }

    func testOverrideScalesThePlan() {
        let c = capsule(rate: 0.16, plan: 0.16, override: .init(name: "Aktywność", percentage: 80))
        XCTAssertEqual(c.value, "0,16 j/h")
        XCTAssertNil(c.plan)
        XCTAssertEqual(c.details, ["Baza 0,16 j/h, zgodnie z planem.", "Plan uwzględnia nadpisanie: Aktywność, 80% (w profilu 0,2 j/h)."])
    }

    func testOldLoopDataIsNeverShownAsNow() {
        let c = capsule(rate: 0, plan: 0.2, loopMinutes: 22)
        XCTAssertEqual(c.value, "—")
        XCTAssertTrue(c.dimmed)
        XCTAssertEqual(c.details, ["Brak świeżych danych z pętli od 22 min."])
    }

    func testSuspendedPump() {
        let c = capsule(rate: 0, plan: 0.2, source: "SUSPENDED", sinceMinutes: 40)
        XCTAssertEqual(c.title, "Pompa wstrzymana")
        XCTAssertNil(c.value)
        XCTAssertEqual(c.details, ["Pompa jest wstrzymana od 40 min. Insulina nie jest podawana."])
    }

    func testNoPlanInTheProfile() {
        let c = capsule(rate: 0.1, plan: nil, sinceMinutes: 10)
        XCTAssertEqual(c.value, "0,1 j/h")
        XCTAssertNil(c.plan)
        XCTAssertEqual(c.details, ["Pętla ustawiła bazę na 0,1 j/h.", "Tak jest od 10 min.", "Brak planu bazy w profilu."])
    }

    func testDurationWords() {
        XCTAssertEqual(DashboardBasalCapsule.duration(minutes: 4), "chwili")
        XCTAssertEqual(DashboardBasalCapsule.duration(minutes: 25), "25 min")
        XCTAssertEqual(DashboardBasalCapsule.duration(minutes: 120), "2 godz.")
        XCTAssertEqual(DashboardBasalCapsule.duration(minutes: 130), "2 godz. 10 min")
    }
}
