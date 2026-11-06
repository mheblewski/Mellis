import XCTest
@testable import GlucoMindCore

final class DashboardGlanceTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!

    private func iso(minutesAgo: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    private func dashboard(
        glucose: Int? = 124, direction: String = "Flat", delta: Int = -1, readingMinutesAgo: Double = 3,
        battery: Double = 68, reservoir: Double = 112, pumpMinutesAgo: Double = 2,
        siteHours: Double = 28, sensorHours: Double = 122
    ) -> DashboardResponse {
        DashboardResponse(
            patient_id: "p",
            generated_at: iso(minutesAgo: 0),
            glucose: glucose.map { DashboardGlucose(value: $0, unit: "mg/dL", direction: direction, observed_at: iso(minutesAgo: readingMinutesAgo), delta: delta) },
            readings: [],
            time_in_range: DashboardTimeInRange(hours: 24, readings_count: 288, low_percent: 2, in_range_percent: 81, high_percent: 17),
            pump: DashboardPump(battery_percent: battery, reservoir_units: reservoir, reservoir_full_units: 160, last_read_at: iso(minutesAgo: pumpMinutesAgo)),
            site_changed_at: iso(minutesAgo: siteHours * 60),
            sensor_started_at: iso(minutesAgo: sensorHours * 60)
        )
    }

    func testAllWellMeansAnEmptyStripAndNoEquipmentNeedingAttention() throws {
        let d = dashboard()
        let equipment = DashboardGlance.equipment(d, now: now)
        XCTAssertEqual(equipment.map(\.kind), [.reservoir, .battery, .sensor, .site])
        XCTAssertEqual(try XCTUnwrap(equipment.first { $0.kind == .sensor }?.fraction), 1 - 122.0 / 240, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(equipment.first { $0.kind == .site }?.fraction), 1 - 28.0 / 72, accuracy: 0.0001)
        XCTAssertTrue(DashboardGlance.attention(equipment).isEmpty)
        XCTAssertTrue(DashboardGlance.now(d, equipment: equipment, mealsWaiting: 0, now: now).isEmpty)
    }

    func testEquipmentPutsRedBeforeYellowThenTheKindOrder() {
        // Battery 15% (red), reservoir 18 U (yellow), site 77 h (red); the pump's 8-min-old reading is the loop tile's business.
        let d = dashboard(battery: 15, reservoir: 18, pumpMinutesAgo: 8, siteHours: 77)
        let attention = DashboardGlance.attention(DashboardGlance.equipment(d, now: now))
        XCTAssertEqual(attention.map(\.kind), [.battery, .site, .reservoir])
        XCTAssertEqual(attention.first?.headline, "Bateria 15%")
        XCTAssertEqual(attention.first?.hint, "wymień teraz")
        XCTAssertEqual(attention.last?.hint, "wymień dziś")
    }

    func testStripListsRedFirstAndKeepsYellowEquipmentInTheTile() {
        let d = dashboard(glucose: 58, direction: "DoubleDown", delta: -9, readingMinutesAgo: 12, reservoir: 18, siteHours: 77)
        let equipment = DashboardGlance.equipment(d, now: now)
        let items = DashboardGlance.now(d, equipment: equipment, mealsWaiting: 2, now: now)
        XCTAssertEqual(items.map(\.id), ["glucose", "equipment-4", "reading-age", "meals"])
        XCTAssertEqual(items[0].title, "Nisko · 58 mg/dL")
        XCTAssertEqual(items[0].detail, "szybko spada")
        XCTAssertEqual(items[1].title, "Wkłucie 3 d 5 h")
        XCTAssertEqual(items[1].action, .equipment)
        XCTAssertEqual(items[3].title, "2 posiłki czekają na opis")
        XCTAssertEqual(items[3].action, .meals)
        XCTAssertFalse(items.contains { $0.id == "equipment-1" }, "a yellow reservoir stays in the tile")
    }

    func testFallingTowardsALowWhileStillInRangeIsYellow() {
        let d = dashboard(glucose: 92, direction: "SingleDown", delta: -6)
        let items = DashboardGlance.now(d, equipment: [], mealsWaiting: 0, now: now)
        XCTAssertEqual(items.map(\.title), ["Spada · 92 mg/dL"])
        XCTAssertEqual(items.first?.level, .warning)
        XCTAssertEqual(items.first?.detail, "\u{2212}6 na 5 min")
    }

    func testHighGlucoseLevels() {
        XCTAssertEqual(DashboardGlance.now(dashboard(glucose: 203), equipment: [], mealsWaiting: 0, now: now).first?.title, "Powyżej zakresu · 203 mg/dL")
        XCTAssertEqual(DashboardGlance.now(dashboard(glucose: 262), equipment: [], mealsWaiting: 0, now: now).first?.level, .alarm)
    }

    func testMealsLinePlurals() {
        XCTAssertEqual(DashboardGlance.mealsLine(1), "1 posiłek czeka na opis")
        XCTAssertEqual(DashboardGlance.mealsLine(3), "3 posiłki czekają na opis")
        XCTAssertEqual(DashboardGlance.mealsLine(5), "5 posiłków czeka na opis")
        XCTAssertEqual(DashboardGlance.mealsLine(12), "12 posiłków czeka na opis")
        XCTAssertEqual(DashboardGlance.mealsLine(22), "22 posiłki czekają na opis")
    }
}

final class DashboardRangeBandsTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!

    private func readings(_ values: [Int]) -> [DashboardReading] {
        values.enumerated().map { index, value in
            DashboardReading(at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-Double(index) * 300)), value: value)
        }
    }

    func testFiveBandsAtTheOwnersBoundariesAddUpTo100() throws {
        // 1 very low (54), 2 low (55, 69), 4 in range (70, 120, 180, 150), 2 high (181, 250), 1 very high (251).
        let bands = try XCTUnwrap(DashboardGlance.rangeBands(readings([54, 55, 69, 70, 120, 180, 150, 181, 250, 251]), hours: 24, now: now))
        XCTAssertEqual(bands.map(\.kind), [.veryHigh, .high, .inRange, .low, .veryLow])
        XCTAssertEqual(bands.map(\.percent), [10, 20, 40, 20, 10])
        XCTAssertEqual(bands.map(\.percent).reduce(0, +), 100)
        XCTAssertEqual(bands[2].minutes, 576)
        XCTAssertEqual(bands[2].targetMet, false)
    }

    func testRoundingStillSumsTo100() throws {
        // Thirds: 33.3% each of in range, high and very high.
        let bands = try XCTUnwrap(DashboardGlance.rangeBands(readings([100, 200, 300]), hours: 24, now: now))
        XCTAssertEqual(bands.map(\.percent).reduce(0, +), 100)
    }

    func testReadingsOutsideTheWindowAreLeftOutAndNoneMeansNil() {
        let old = [DashboardReading(at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-30 * 3_600)), value: 40)]
        XCTAssertNil(DashboardGlance.rangeBands(old, hours: 24, now: now))
    }

    func testAServerPeriodGivesTheSameBandsWithTheTimeADayAveraged() throws {
        // 14 days, 71% in range: 71% of a day is 17 h 2 min, whatever the period's length.
        let period = DashboardTimeInRangePeriod(
            patient_id: "p", days: 14, from: "2026-10-09T12:00:00Z", to: "2026-10-23T12:00:00Z", readings_count: 1_000,
            counts: .init(very_low: 10, low: 20, in_range: 710, high: 200, very_high: 60), sensor_coverage_percent: 25
        )
        let bands = try XCTUnwrap(DashboardGlance.rangeBands(period))
        XCTAssertEqual(bands.map(\.percent), [6, 20, 71, 2, 1])
        XCTAssertEqual(bands[2].minutes, 1_022)
        XCTAssertEqual(bands[0].targetMet, false)
        XCTAssertEqual(bands[3].targetMet, true)
        XCTAssertEqual(bands[4].targetMet, false)
    }

    func testAServerPeriodWithoutReadingsIsNil() {
        let period = DashboardTimeInRangePeriod(
            patient_id: "p", days: 7, from: "", to: "", readings_count: 0,
            counts: .init(very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0), sensor_coverage_percent: 0
        )
        XCTAssertNil(DashboardGlance.rangeBands(period))
    }

    func testRangeArcsRunFromInRangeThroughHighsToLowsAndFillTheCircle() {
        let arcs = DashboardGlance.rangeArcs(percents: [.inRange: 75, .high: 20, .veryHigh: 2, .low: 3, .veryLow: 0], minimumShare: 0)
        XCTAssertEqual(arcs.map(\.kind), [.inRange, .high, .veryHigh, .veryLow, .low])
        XCTAssertEqual(arcs[0].start, 0)
        XCTAssertEqual(arcs[0].end, 0.75, accuracy: 0.0001)
        XCTAssertEqual(arcs[1].end, 0.95, accuracy: 0.0001)
        XCTAssertTrue(arcs[3].isEmpty)
        XCTAssertEqual(arcs[4].start, 0.97, accuracy: 0.0001)
        XCTAssertEqual(arcs[4].end, 1, accuracy: 0.0001)
    }

    func testRangeArcsKeepOnePercentVisibleAtTheLargestBandsCost() {
        let arcs = DashboardGlance.rangeArcs(percents: [.inRange: 90, .high: 8, .veryLow: 1, .low: 1], minimumShare: 4)
        let veryLow = try! XCTUnwrap(arcs.first { $0.kind == .veryLow })
        let low = try! XCTUnwrap(arcs.first { $0.kind == .low })
        XCTAssertEqual(veryLow.end - veryLow.start, 0.04, accuracy: 0.0001)
        XCTAssertEqual(low.end - low.start, 0.04, accuracy: 0.0001)
        XCTAssertEqual(arcs[0].end, 0.84, accuracy: 0.0001)
        XCTAssertEqual(arcs.last?.end ?? 0, 1, accuracy: 0.0001)
    }

    func testTargetsJudgeTheNumberEachRowShows() throws {
        // 6% very high, 22% high, 67% in range, 3% low, 2% very low.
        let bands = try XCTUnwrap(DashboardGlance.rangeBands(counts: [6, 22, 67, 3, 2]))
        XCTAssertEqual(bands.map(\.targetMet), [false, true, false, true, false])
        // 4.6% is shown as 5%, which is not below 5%.
        let rounded = try XCTUnwrap(DashboardGlance.rangeBands(counts: [46, 0, 954, 0, 0]))
        XCTAssertEqual(rounded[0].percent, 5)
        XCTAssertEqual(rounded[0].targetMet, false)
    }

    func testVeryLowBelowOnePercentSaysSoInsteadOfZero() throws {
        let few = try XCTUnwrap(DashboardGlance.rangeBands(counts: [0, 0, 999, 0, 1]))
        XCTAssertEqual(few.first { $0.kind == .veryLow }?.percentText, "< 1%")
        let none = try XCTUnwrap(DashboardGlance.rangeBands(counts: [0, 0, 1000, 0, 0]))
        XCTAssertEqual(none.first { $0.kind == .veryLow }?.percentText, "0%")
        // Only very low: other bands keep their number.
        let high = try XCTUnwrap(DashboardGlance.rangeBands(counts: [0, 1, 999, 0, 0]))
        XCTAssertEqual(high.first { $0.kind == .high }?.percentText, "0%")
    }

    func testRangeArcsKeepABandRoundedDownToZero() throws {
        // 1 very low reading in 1000 rounds to 0%, but it happened.
        let bands = try XCTUnwrap(DashboardGlance.rangeBands(counts: [0, 0, 999, 0, 1]))
        XCTAssertEqual(bands.first { $0.kind == .veryLow }?.percent, 0)
        let arcs = DashboardGlance.rangeArcs(bands, minimumShare: 1.5)
        XCTAssertFalse(try XCTUnwrap(arcs.first { $0.kind == .veryLow }).isEmpty)
        XCTAssertEqual(arcs.last?.end ?? 0, 1, accuracy: 0.0001)
    }

    func testRangeArcsOfOneBandAreTheWholeCircleAndOfNoneAreEmpty() {
        let whole = DashboardGlance.rangeArcs(percents: [.inRange: 100], minimumShare: 4)
        XCTAssertEqual(whole[0].end, 1, accuracy: 0.0001)
        XCTAssertEqual(whole.filter { !$0.isEmpty }.count, 1)
        XCTAssertTrue(DashboardGlance.rangeArcs(percents: [:], minimumShare: 4).allSatisfy(\.isEmpty))
    }

    func testSensorCoverageCountsFiveMinuteSlots() {
        // Every minute for 6 h fills 72 of the day's 288 slots.
        let everyMinute = (0..<360).map { index in
            DashboardReading(at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-Double(index) * 60)), value: 120)
        }
        XCTAssertEqual(DashboardGlance.sensorCoverage(everyMinute, hours: 24, now: now), 25)
        XCTAssertEqual(DashboardGlance.sensorCoverage([], hours: 24, now: now), 0)
    }

    func testPeriods() {
        XCTAssertEqual(DashboardGlance.RangePeriod.allCases.map(\.title), ["24 h", "7 dni", "14 dni"])
        XCTAssertEqual(DashboardGlance.RangePeriod.week.caption, "ostatnie 7 dni")
    }

    func testDurations() {
        XCTAssertEqual(DashboardGlance.duration(minutes: 45), "45 min")
        XCTAssertEqual(DashboardGlance.duration(minutes: 70), "1 h 10 min")
        XCTAssertEqual(DashboardGlance.duration(minutes: 120), "2 h")
    }
}

final class DashboardLoopTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z")!
    private func iso(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60)) }

    private func dashboard(loopMinutesAgo: Double?, basal: [DashboardBasalRun] = [], boluses: [DashboardDose] = []) -> DashboardResponse {
        DashboardResponse(
            patient_id: "p", generated_at: iso(0),
            glucose: DashboardGlucose(value: 124, unit: "mg/dL", direction: "Flat", observed_at: iso(3), delta: -1),
            readings: [], time_in_range: nil, pump: nil,
            loop: loopMinutesAgo.map { DashboardLoop(iob_units: 1.2, cob_grams: 0, observed_at: iso($0)) },
            insulin: DashboardInsulin(boluses: boluses, smbs: [DashboardDose(at: iso(5), units: 0.1)], basal: basal),
            site_changed_at: nil, sensor_started_at: nil
        )
    }

    func testLoopAgeLevelsAndTheBasalRunningNow() throws {
        let basal = [DashboardBasalRun(start: iso(120), end: iso(30), rate: 0.4), DashboardBasalRun(start: iso(30), end: iso(-30), rate: 0.6)]
        let fresh = try XCTUnwrap(DashboardGlance.loop(dashboard(loopMinutesAgo: 2, basal: basal), now: now))
        XCTAssertEqual(fresh.level, .normal)
        XCTAssertEqual(fresh.basalRate, 0.6)
        XCTAssertEqual(DashboardGlance.loop(dashboard(loopMinutesAgo: 22), now: now)?.level, .warning)
        XCTAssertEqual(DashboardGlance.loop(dashboard(loopMinutesAgo: 31), now: now)?.level, .alarm)
        XCTAssertNil(DashboardGlance.loop(dashboard(loopMinutesAgo: nil), now: now))
    }

    func testAStalledLoopGoesToTheStrip() {
        let d = dashboard(loopMinutesAgo: 22)
        let items = DashboardGlance.now(d, equipment: [], mealsWaiting: 0, now: now)
        XCTAssertEqual(items.map(\.title), ["Pętla nie liczy od 22 min"])
        XCTAssertEqual(items.first?.level, .warning)
        XCTAssertTrue(DashboardGlance.now(dashboard(loopMinutesAgo: 3), equipment: [], mealsWaiting: 0, now: now).isEmpty)
    }

    private func loopStatus(_ minutes: Int) -> DashboardGlance.LoopStatus {
        DashboardGlance.LoopStatus(minutes: minutes, level: DashboardThresholds.loopAge(minutes: minutes), basalRate: nil)
    }

    private func item(_ kind: DashboardGlance.EquipmentItem.Kind, name: String, value: String, level: DashboardLevel) -> DashboardGlance.EquipmentItem {
        DashboardGlance.EquipmentItem(kind: kind, name: name, value: value, note: "", level: level, fraction: nil)
    }

    func testNoRowsWhenAllIsWellAndTheTileSaysSo() {
        let equipment = [item(.reservoir, name: "Zbiornik", value: "112 j", level: .normal)]
        XCTAssertEqual(DashboardGlance.attentionRows(equipment: equipment, loop: loopStatus(2), loopSystem: .trio), [])
        let summary = DashboardGlance.statusSummary(equipment: equipment, loop: loopStatus(2))
        XCTAssertEqual(summary.title, "Pętla i sprzęt OK")
        XCTAssertEqual(summary.caption, "pętla 2 min temu")
    }

    func testRedRowComesBeforeAYellowLoopAndTheLoopLeadsAtTheSameLevel() {
        let red = [item(.reservoir, name: "Zbiornik", value: "6 j", level: .alarm), item(.battery, name: "Bateria", value: "15%", level: .alarm)]
        let rows = DashboardGlance.attentionRows(equipment: red, loop: loopStatus(21), loopSystem: .trio)
        XCTAssertEqual(rows.map(\.text), ["W zbiorniku zostało 6 j", "Pętla nie liczy od 21 min. Sprawdź Trio."])
        XCTAssertEqual(rows[0].more, "jeszcze bateria")
        let yellow = [item(.site, name: "Wkłucie", value: "2 d 9 h", level: .warning)]
        let same = DashboardGlance.attentionRows(equipment: yellow, loop: loopStatus(21), loopSystem: .trio)
        XCTAssertEqual(same.map(\.source), [.loop, .equipment])
        XCTAssertEqual(same[1].text, "Wkłucie jest założone od 2 d 9 h")
    }

    func testMoreCountsTheRestOfTheEquipment() {
        let items = [item(.reservoir, name: "Zbiornik", value: "6 j", level: .alarm), item(.battery, name: "Bateria", value: "15%", level: .alarm),
                     item(.sensor, name: "Sensor", value: "10 d", level: .alarm), item(.site, name: "Wkłucie", value: "3 d", level: .alarm)]
        XCTAssertEqual(DashboardGlance.attentionRows(equipment: items, loop: nil, loopSystem: .trio).first?.more, "jeszcze 3")
    }

    func testTileSaysWhatStillWorksWhenARowNamesTheProblem() {
        let bad = [item(.reservoir, name: "Zbiornik", value: "6 j", level: .alarm)]
        let good = [item(.reservoir, name: "Zbiornik", value: "112 j", level: .normal)]
        XCTAssertEqual(DashboardGlance.statusSummary(equipment: bad, loop: loopStatus(8)).title, "Pętla działa")
        XCTAssertEqual(DashboardGlance.statusSummary(equipment: good, loop: loopStatus(21)).title, "Sprzęt OK")
        let both = DashboardGlance.statusSummary(equipment: bad, loop: loopStatus(21))
        XCTAssertEqual(both.title, "Pętla i sprzęt ›")
        XCTAssertEqual(both.caption, "")
        XCTAssertTrue(both.isQuiet)
        XCTAssertEqual(DashboardGlance.statusSummary(equipment: [], loop: nil).caption, "brak danych")
    }

    func testSpanHasNoTimeWordsAndAgeTextAddsThem() {
        XCTAssertEqual(StaleReading.span(minutes: 17), "17 min")
        XCTAssertEqual(StaleReading.span(minutes: 65), "1 h 5 min")
        XCTAssertEqual(StaleReading.ageText(minutes: 65), "1 h 5 min temu")
        XCTAssertEqual(StaleReading.ageText(minutes: 0), "teraz")
    }

    func testLastBolusIsTheNewestAndSMBsAreLeftOut() {
        let d = dashboard(loopMinutesAgo: 2, boluses: [DashboardDose(at: iso(300), units: 5), DashboardDose(at: iso(130), units: 3.5)])
        XCTAssertEqual(DashboardGlance.lastBolus(d)?.units, 3.5)
        XCTAssertNil(DashboardGlance.lastBolus(dashboard(loopMinutesAgo: 2)))
        XCTAssertEqual(DashboardGlance.ago(minutes: 0), "teraz")
        XCTAssertEqual(DashboardGlance.ago(minutes: 35), "35 min temu")
        XCTAssertEqual(DashboardGlance.ago(minutes: 130), "2 h temu")
    }
}

final class MetricCardContentTests: XCTestCase {
    func testTimeInRangeUsesTheScreensPercentagesAndKeepsATraceOfLows() throws {
        let card = ConversationMetricCard(kind: "TIME_IN_RANGE", period_label: "ostatnie 14 dni", counts: .init(very_low: 1, low: 0, in_range: 999, high: 0, very_high: 0))
        let content = try XCTUnwrap(MetricCardContent(card: card))
        XCTAssertEqual(content.value, "100")
        XCTAssertEqual(content.caption, "w zakresie · ostatnie 14 dni")
        XCTAssertEqual(content.parts.map(\.value), ["100%", "0%", "< 1%"])
    }

    func testDailyInsulinShowsTheTotalAndItsParts() throws {
        let card = ConversationMetricCard(kind: "DAILY_INSULIN", period_label: "średnio na dobę · 14 pełnych dni", total_units: 14.2, bolus_units: 5.6, smb_units: 2.6, basal_units: 6)
        let content = try XCTUnwrap(MetricCardContent(card: card))
        XCTAssertEqual(content.value, "14,2")
        XCTAssertEqual(content.parts.map(\.value), ["5,6 j", "2,6 j", "6,0 j"])
    }

    func testACardThisVersionCannotReadIsNoCard() {
        XCTAssertNil(MetricCardContent(card: ConversationMetricCard(kind: "NEW_KIND", period_label: "x")))
        XCTAssertNil(MetricCardContent(card: ConversationMetricCard(kind: "TIME_IN_RANGE", period_label: "x")))
    }
}
