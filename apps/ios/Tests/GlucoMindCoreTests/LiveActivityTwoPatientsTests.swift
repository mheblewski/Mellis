import XCTest
@testable import GlucoMindCore

/// Two-patient Live Activity (migration 094): content-state coding both ways, the danger rule and the island sides.
final class LiveActivityTwoPatientsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_095_200)
    private let zosia = "11111111-1111-4111-8111-111111111111"
    private let kuba = "22222222-2222-4222-8222-222222222222"

    /// The server's two-patient content (live-activity-state.ts, buildLiveActivityContentState with others).
    private var twoPatientJSON: String {
        """
        {"glucose":142,"direction":"FortyFiveUp","delta":4,"readingAt":1793095080,"iob":1.35,"cob":22,"reservoir":112.3,
         "reservoirFull":200,"battery":64,"siteChangedAt":1792922400,"sensorStartedAt":null,"readings":[],"boluses":[],
         "islandEnabled":true,"patientID":"\(zosia)","patientName":"Zosia",
         "others":[{"id":"\(kuba)","name":"Kuba","glucose":64,"direction":"SingleDown","delta":-6,"readingAt":1793095140,"iob":0.42}],
         "islandMode":"closer","islandLeft":"\(kuba)"}
        """
    }

    func testDecodesTheServersTwoPatientContent() throws {
        let state = try JSONDecoder().decode(GlucoseActivityState.self, from: Data(twoPatientJSON.utf8))
        XCTAssertEqual(state.mode, .closer)
        XCTAssertEqual(state.islandLeft, kuba)
        let patients = state.patients(attributesID: "ignored", attributesName: "ignored")
        XCTAssertEqual(patients.map(\.name), ["Zosia", "Kuba"])
        XCTAssertEqual(patients.map(\.id), [zosia, kuba])
        XCTAssertEqual(patients[1].glucose, 64)
        XCTAssertEqual(patients[1].iob, 0.42)
    }

    /// An activity started before the update (088 content, no new keys) still decodes: one patient from the attributes.
    func testOldOnePatientContentStillDecodes() throws {
        let json = """
        {"glucose":142,"direction":"FortyFiveUp","delta":4,"readingAt":1793095080,"iob":1.35,"cob":22,"reservoir":8,
         "reservoirFull":200,"battery":64,"siteChangedAt":1792922400,"sensorStartedAt":null,
         "readings":[[1793094780,138],[1793095080,142]],"boluses":[[1793091600,3.2]],"islandEnabled":false}
        """
        let state = try JSONDecoder().decode(GlucoseActivityState.self, from: Data(json.utf8))
        XCTAssertNil(state.others)
        XCTAssertEqual(state.mode, .both)
        XCTAssertFalse(state.islandShowsIOB)
        let patients = state.patients(attributesID: zosia, attributesName: "Zosia")
        XCTAssertEqual(patients.count, 1)
        XCTAssertEqual(patients[0].name, "Zosia")
    }

    /// The app before this change decodes the new content too (unknown keys are ignored by Codable).
    func testTheOneVersionOlderAppDecodesTwoPatientContent() throws {
        struct State088: Decodable {
            var glucose: Int?
            var direction: String?
            var readingAt: Double?
            var readings: [[Double]]
            var boluses: [[Double]]
            var islandEnabled: Bool?
        }
        let state = try JSONDecoder().decode(State088.self, from: Data(twoPatientJSON.utf8))
        XCTAssertEqual(state.glucose, 142)
        XCTAssertEqual(state.readings, [])
    }

    /// The app's own encoding (local updates) round-trips and stays far below ActivityKit's 4 KB.
    func testEncodesRoundTripAndSmall() throws {
        let one = GlucoseActivityState(glucose: 120, direction: "Flat", delta: 1, readingAt: 1_793_095_080, iob: 1, cob: 10, reservoir: nil,
                                       reservoirFull: nil, battery: nil, siteChangedAt: nil, sensorStartedAt: nil,
                                       readings: (0..<120).map { [1_793_088_000 + Double($0) * 60, 120] }, boluses: [])
        let second = GlucoseActivityPatient(id: kuba, name: "Kuba", glucose: 64, direction: "SingleDown", delta: -6, readingAt: 1_793_095_140, iob: 0.42)
        let two = one.adding(second: second, firstID: zosia, firstName: "Zosia", mode: .both, left: kuba)
        XCTAssertEqual(two.readings, [])
        XCTAssertEqual(two.islandLeft, kuba)
        let data = try JSONEncoder().encode(two)
        XCTAssertLessThan(data.count, 1_024)
        XCTAssertEqual(try JSONDecoder().decode(GlucoseActivityState.self, from: data), two)
        XCTAssertEqual(one.adding(second: nil, firstID: zosia, firstName: "Zosia", mode: .both, left: nil), one)
    }

    func testChangeCarriesPatientsAndIslandChoice() {
        let body = LiveActivityChange(patientIDs: [zosia, kuba], islandMode: .closer, islandLeftPatientID: .set(kuba)).body
        XCTAssertEqual(body["patient_ids"] as? [String], [zosia, kuba])
        XCTAssertEqual(body["island_mode"] as? String, "closer")
        XCTAssertEqual(body["island_left_patient_id"] as? String, kuba)
        XCTAssertTrue(LiveActivityChange(islandLeftPatientID: .clear).body["island_left_patient_id"] is NSNull)
    }

    // MARK: Danger

    private func glance(_ id: String, _ glucose: Int?, delta: Int? = 0, ageMinutes: Double = 3) -> LivePatientGlance {
        LivePatientGlance(id: id, name: id, glucose: glucose, direction: nil, delta: delta,
                          readingAt: now.addingTimeInterval(-ageMinutes * 60).timeIntervalSince1970, iob: nil)
    }

    func testLowBeatsHighAndTheLowerLowWins() {
        XCTAssertEqual(LiveDanger.closer([glance("a", 320), glance("b", 66)], now: now)?.id, "b")
        XCTAssertEqual(LiveDanger.closer([glance("a", 68), glance("b", 55)], now: now)?.id, "b")
        XCTAssertEqual(LiveDanger.closer([glance("a", 260), glance("b", 300)], now: now)?.id, "b")
    }

    func testAProjectedLowCountsAsLow() {
        // 85 falling 6 per 5 min → 67 in 15 min: low tier, beats a steady 290.
        XCTAssertEqual(LiveDanger.rank(glance("a", 85, delta: -6), now: now).tier, .low)
        XCTAssertEqual(LiveDanger.closer([glance("a", 290), glance("b", 85, delta: -6)], now: now)?.id, "b")
        // 230 rising 8 → 254: high tier.
        XCTAssertEqual(LiveDanger.rank(glance("a", 230, delta: 8), now: now).tier, .high)
    }

    func testInRangeASmallerMarginWinsAndLowSideCountsTwice() {
        // 90 (20 above 70) vs 220 ((250 − 220) / 2 = 15): the high side is closer by the rule.
        XCTAssertEqual(LiveDanger.closer([glance("a", 90), glance("b", 220)], now: now)?.id, "b")
        // 80 (10) vs 220 (15): the low side.
        XCTAssertEqual(LiveDanger.closer([glance("a", 220), glance("b", 80)], now: now)?.id, "b")
    }

    func testNoFreshReadingIsLastAndTiesKeepTheFirst() {
        XCTAssertEqual(LiveDanger.rank(glance("a", 50, ageMinutes: 20), now: now).tier, .noData)
        XCTAssertEqual(LiveDanger.closer([glance("a", 50, ageMinutes: 20), glance("b", 150)], now: now)?.id, "b")
        XCTAssertEqual(LiveDanger.closer([glance("a", 120), glance("b", 120)], now: now)?.id, "a")
        XCTAssertEqual(LiveDanger.closer([glance("a", nil), glance("b", nil)], now: now)?.id, "a")
    }

    // MARK: Sides

    func testSidesFollowTheChosenLeftPatient() {
        let a = glance(zosia, 120), b = glance(kuba, 140)
        XCTAssertEqual(LiveIslandSides.assign([a, b], left: nil)?.left.id, zosia)
        XCTAssertEqual(LiveIslandSides.assign([a, b], left: kuba.uppercased())?.left.id, kuba)
        XCTAssertEqual(LiveIslandSides.assign([a, b], left: kuba)?.right?.id, zosia)
        XCTAssertEqual(LiveIslandSides.assign([a, b], left: "someone-else")?.left.id, zosia)
        XCTAssertNil(LiveIslandSides.assign([a], left: kuba)?.right)
    }
}
