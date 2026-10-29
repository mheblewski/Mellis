import XCTest
@testable import GlucoMindCore

final class DashboardChartHistoryTests: XCTestCase {
    private typealias Series = DashboardChartSeries

    private static func t(_ iso: String) -> TimeInterval {
        ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970
    }

    // MARK: Series

    func testMergingAnOlderChunkAndAnOverlappingTailKeepsOneReadingPerTime() {
        var series = Series(readings: [.init(t: 100, value: 120), .init(t: 400, value: 130)])

        series.merge(readings: [.init(t: 10, value: 90), .init(t: 40, value: 95)])
        XCTAssertEqual(series.readings.map(\.t), [10, 40, 100, 400])

        series.merge(readings: [.init(t: 400, value: 131), .init(t: 700, value: 140), .init(t: 100, value: 121)])
        XCTAssertEqual(series.readings.map(\.t), [10, 40, 100, 400, 700])
        XCTAssertEqual(series.readings.map(\.value), [90, 95, 121, 131, 140], "the newer copy of a known time wins")

        series.merge(readings: [.init(t: 250, value: 125), .init(t: 250, value: 126)])
        XCTAssertEqual(series.readings.map(\.t), [10, 40, 100, 250, 400, 700])
    }

    func testMergingBasalReplacesTheRunsOfItsWindowOnly() {
        var series = Series(basal: [.init(start: 0, end: 1_000, rate: 0.5), .init(start: 1_000, end: 2_000, rate: 0.7)])

        series.merge(readings: [], basal: [.init(start: 500, end: 1_500, rate: 0)], basalWindow: 500...1_500)

        XCTAssertEqual(series.basal, [
            .init(start: 0, end: 500, rate: 0.5),
            .init(start: 500, end: 1_500, rate: 0),
            .init(start: 1_500, end: 2_000, rate: 0.7),
        ])

        series.merge(readings: [], basal: nil, basalWindow: 0...2_000)
        XCTAssertEqual(series.basal.count, 3, "insulin that could not be read keeps the basal shown")
    }

    func testVisibleRangeRunsOneReadingPastEachEdge() {
        let series = Series(readings: (0..<10).map { .init(t: Double($0) * 300, value: 100 + $0) })

        XCTAssertEqual(series.readingIndices(from: 700, to: 1_600), 2..<7)
        XCTAssertEqual(series.readingIndices(from: -1_000, to: -10), 0..<1)
        XCTAssertEqual(series.readingIndices(from: 5_000, to: 6_000), 9..<10)
        XCTAssertTrue(Series().readingIndices(from: 0, to: 10).isEmpty)
        XCTAssertEqual(series.maxValue(from: 700, to: 1_600), 106)
    }

    func testTheSelectionTakesTheNearestReadingWithinTheTolerance() {
        let series = Series(readings: [.init(t: 0, value: 100), .init(t: 300, value: 110), .init(t: 3_000, value: 150)])

        XCTAssertEqual(series.nearestReading(to: 140), 0)
        XCTAssertEqual(series.nearestReading(to: 160), 1)
        XCTAssertEqual(series.nearestReading(to: 2_900), 2)
        XCTAssertNil(series.nearestReading(to: 1_600, tolerance: 600), "a gap shows no reading")
    }

    func testBolusesWhoseLabelsWouldOverlapAreOneGroup() {
        XCTAssertEqual(DashboardChartSeries.clusters(at: [10, 20, 35, 40, 100], minimumGap: 26), [0..<3, 3..<4, 4..<5])
        XCTAssertEqual(DashboardChartSeries.clusters(at: [5], minimumGap: 26), [0..<1])
        XCTAssertEqual(DashboardChartSeries.clusters(at: [], minimumGap: 26), [])
    }

    func testTheBasalAtAMomentIsTheNewestRunCoveringIt() {
        let series = DashboardChartSeries(basal: [
            .init(start: 0, end: 3_600, rate: 0.6),
            .init(start: 1_200, end: 1_800, rate: 1.2),
            .init(start: 3_600, end: 7_200, rate: 0),
        ])
        XCTAssertEqual(series.basalRate(at: 600), 0.6)
        XCTAssertEqual(series.basalRate(at: 1_200), 1.2)
        XCTAssertEqual(series.basalRate(at: 2_000), 0.6)
        XCTAssertEqual(series.basalRate(at: 3_600), 0)
        XCTAssertNil(series.basalRate(at: 7_200))
        XCTAssertNil(DashboardChartSeries().basalRate(at: 0))
    }

    func testIOBAndCOBComeFromTheNearestLoopCalculation() {
        let series = Series(loop: [.init(t: 1_000, iob: 1.2, cob: 10), .init(t: 1_300, iob: 1.0, cob: nil)])

        XCTAssertEqual(series.loopValues(at: 1_020)?.iob, 1.2)
        XCTAssertEqual(series.loopValues(at: 1_200)?.iob, 1.0)
        XCTAssertNil(series.loopValues(at: 1_300)?.cob)
        XCTAssertNil(series.loopValues(at: 3_000), "nothing within ten minutes")
    }

    func testSMBsAreSummedPerHourAndBolusLabelsTooCloseAreLifted() {
        let series = Series(smbs: [
            .init(t: Self.t("2026-10-18T10:20:00Z"), units: 0.4),
            .init(t: Self.t("2026-10-18T10:45:00Z"), units: 0.3),
            .init(t: Self.t("2026-10-18T11:10:00Z"), units: 0.2),
        ])

        let hourly = series.smbSums(from: Self.t("2026-10-18T09:00:00Z"), to: Self.t("2026-10-18T12:00:00Z"), bucket: 3_600)
        XCTAssertEqual(hourly.map(\.units), [0.7, 0.2])
        XCTAssertEqual(hourly.first?.t, Self.t("2026-10-18T10:30:00Z"), "at the hour's middle")
        XCTAssertEqual(series.smbSums(from: Self.t("2026-10-18T09:00:00Z"), to: Self.t("2026-10-18T12:00:00Z"), bucket: 7_200).map(\.units), [0.9])

        XCTAssertEqual(Series.liftedLabels(at: [10, 30, 50, 90], minimumGap: 26), [false, true, false, false])
    }

    // MARK: Store

    @MainActor
    func testTheFirstLoadCoversTwoDaysAndTheNextOneComesWithinTheMargin() async throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let fetcher = HistoryFetcher()
        let store = DashboardChartStore(fetch: fetcher.fetch, now: { now })

        store.ensureLoaded(visibleStart: now.timeIntervalSince1970 - 3 * 3_600, span: 3 * 3_600)
        try await waitUntil { store.historyFrom != nil }

        let first = try XCTUnwrap(fetcher.windows.first)
        XCTAssertEqual(first.from.timeIntervalSince1970, now.timeIntervalSince1970 + 60 - 2 * 86_400, "two days: more than 3 h + 12 h of margin")
        XCTAssertEqual(store.series.readings.count, fetcher.readingsPerWindow)
        XCTAssertEqual(store.series.loop.count, fetcher.readingsPerWindow)
        XCTAssertFalse(store.isLoadingOlder)

        // Scrolled back to within the margin of the oldest data: the next day is loaded, and nothing more.
        store.ensureLoaded(visibleStart: now.timeIntervalSince1970 - 38 * 3_600, span: 3 * 3_600)
        try await waitUntil { fetcher.windows.count == 2 && !store.isLoadingOlder }
        XCTAssertEqual(fetcher.windows[1].to, first.from)
        XCTAssertEqual(fetcher.windows[1].to.timeIntervalSince(fetcher.windows[1].from), 86_400)
        store.ensureLoaded(visibleStart: now.timeIntervalSince1970 - 39 * 3_600, span: 3 * 3_600)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(fetcher.windows.count, 2)
    }

    @MainActor
    func testTheDashboardGoesOnTopOfTheHistory() async throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let store = DashboardChartStore(fetch: HistoryFetcher().fetch, now: { now })
        let dashboard = DashboardResponse(
            patient_id: "p",
            generated_at: "2027-01-15T08:00:00.000Z",
            glucose: nil,
            readings: [DashboardReading(at: "2027-01-15T07:55:00.000Z", value: 140)],
            time_in_range: nil,
            pump: nil,
            loop: DashboardLoop(iob_units: 2.25, cob_grams: 18, observed_at: "2027-01-15T07:55:20.000Z"),
            insulin: DashboardInsulin(boluses: [DashboardDose(at: "2027-01-15T07:00:00.000Z", units: 3)], smbs: [], basal: []),
            site_changed_at: nil,
            sensor_started_at: nil
        )

        store.apply(dashboard)
        try await waitUntil { !store.series.readings.isEmpty }

        XCTAssertEqual(store.series.readings.map(\.value), [140])
        XCTAssertEqual(store.series.boluses.map(\.units), [3])
        XCTAssertEqual(store.series.loopValues(at: Self.t("2027-01-15T07:55:00Z"))?.iob, 2.25)
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out"); return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

/// Answers every window with a reading and a loop point each hour.
private final class HistoryFetcher: @unchecked Sendable {
    let readingsPerWindow = 24
    private let lock = NSLock()
    private var recorded: [(from: Date, to: Date)] = []

    var windows: [(from: Date, to: Date)] {
        lock.withLock { recorded }
    }

    var fetch: DashboardChartStore.Fetch {
        { [self] from, to in
            lock.withLock { recorded.append((from, to)) }
            let format = ISO8601DateFormatter()
            let step = to.timeIntervalSince(from) / Double(readingsPerWindow)
            let times = (0..<readingsPerWindow).map { format.string(from: from.addingTimeInterval(Double($0) * step)) }
            return DashboardHistoryResponse(
                patient_id: "p",
                from: format.string(from: from),
                to: format.string(from: to),
                readings: times.map { DashboardReading(at: $0, value: 120) },
                loop: times.map { .init(at: $0, iob_units: 1, cob_grams: 0) },
                insulin: nil
            )
        }
    }
}
