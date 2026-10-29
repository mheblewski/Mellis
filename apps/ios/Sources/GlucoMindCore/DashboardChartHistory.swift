import Foundation

/// GET /v1/patients/{patientId}/dashboard/history?from=&to=: the chart's readings, insulin and the loop's IOB/COB for
/// one window, so the chart can be scrolled back.
public struct DashboardHistoryResponse: Codable, Equatable {
    public struct LoopPoint: Codable, Equatable {
        public let at: String
        public let iob_units: Double?
        public let cob_grams: Double?

        public init(at: String, iob_units: Double?, cob_grams: Double?) {
            self.at = at
            self.iob_units = iob_units
            self.cob_grams = cob_grams
        }
    }

    public let patient_id: String
    public let from: String
    public let to: String
    public let readings: [DashboardReading]
    public let loop: [LoopPoint]
    public let insulin: DashboardInsulin?

    public init(patient_id: String, from: String, to: String, readings: [DashboardReading], loop: [LoopPoint], insulin: DashboardInsulin?) {
        self.patient_id = patient_id
        self.from = from
        self.to = to
        self.readings = readings
        self.loop = loop
        self.insulin = insulin
    }
}

/// Everything the chart has loaded, as sorted arrays of plain numbers (seconds since 1970), so a drag frame finds the
/// visible part by binary search and draws it without parsing or allocating.
public struct DashboardChartSeries: Equatable {
    public struct Reading: Equatable, Sendable { public let t: TimeInterval; public let value: Int }
    public struct Loop: Equatable, Sendable { public let t: TimeInterval; public let iob: Double?; public let cob: Double? }
    public struct Dose: Equatable, Sendable {
        public let t: TimeInterval
        public let units: Double
        public init(t: TimeInterval, units: Double) { self.t = t; self.units = units }
    }
    public struct Basal: Equatable, Sendable { public let start: TimeInterval; public let end: TimeInterval; public let rate: Double }

    public private(set) var readings: [Reading] = []
    public private(set) var loop: [Loop] = []
    public private(set) var boluses: [Dose] = []
    public private(set) var smbs: [Dose] = []
    public private(set) var basal: [Basal] = []

    public init() {}

    public init(readings: [Reading] = [], loop: [Loop] = [], boluses: [Dose] = [], smbs: [Dose] = [], basal: [Basal] = []) {
        self.readings = readings.sorted { $0.t < $1.t }
        self.loop = loop.sorted { $0.t < $1.t }
        self.boluses = boluses.sorted { $0.t < $1.t }
        self.smbs = smbs.sorted { $0.t < $1.t }
        self.basal = basal.sorted { $0.start < $1.start }
    }

    // MARK: Merging

    /// Readings, doses and loop points are added (a time already known keeps the newer copy); the basal of
    /// [from, to) is replaced, since a temp basal learnt later changes the runs around it.
    public mutating func merge(
        readings newReadings: [Reading],
        loop newLoop: [Loop] = [],
        boluses newBoluses: [Dose] = [],
        smbs newSmbs: [Dose] = [],
        basal newBasal: [Basal]? = nil,
        basalWindow: ClosedRange<TimeInterval>? = nil
    ) {
        readings = Self.union(readings, newReadings.sorted { $0.t < $1.t }, key: { $0.t })
        loop = Self.union(loop, newLoop.sorted { $0.t < $1.t }, key: { $0.t })
        boluses = Self.union(boluses, newBoluses.sorted { $0.t < $1.t }, key: { $0.t })
        smbs = Self.union(smbs, newSmbs.sorted { $0.t < $1.t }, key: { $0.t })
        if let newBasal, let window = basalWindow {
            var kept: [Basal] = []
            kept.reserveCapacity(basal.count + newBasal.count)
            for run in basal {
                if run.end <= window.lowerBound || run.start >= window.upperBound {
                    kept.append(run)
                    continue
                }
                if run.start < window.lowerBound { kept.append(.init(start: run.start, end: window.lowerBound, rate: run.rate)) }
                if run.end > window.upperBound { kept.append(.init(start: window.upperBound, end: run.end, rate: run.rate)) }
            }
            kept.append(contentsOf: newBasal.filter { $0.end > $0.start })
            basal = kept.sorted { $0.start < $1.start }
        }
    }

    /// Two sorted arrays into one, one element per key; on a tie the new one wins.
    static func union<T>(_ old: [T], _ new: [T], key: (T) -> TimeInterval) -> [T] {
        if new.isEmpty { return old }
        if old.isEmpty { return Self.dedupe(new, key: key) }
        // The common cases: an older chunk before everything, or a newer tail after it.
        if let lastNew = new.last, key(lastNew) < key(old[0]) { return Self.dedupe(new, key: key) + old }
        var result: [T] = []
        result.reserveCapacity(old.count + new.count)
        var i = 0, j = 0
        while i < old.count || j < new.count {
            if j == new.count { result.append(old[i]); i += 1; continue }
            if i == old.count {
                if let last = result.last, key(last) == key(new[j]) { result[result.count - 1] = new[j] } else { result.append(new[j]) }
                j += 1
                continue
            }
            let a = key(old[i]), b = key(new[j])
            if a < b {
                result.append(old[i]); i += 1
            } else if b < a {
                if let last = result.last, key(last) == b { result[result.count - 1] = new[j] } else { result.append(new[j]) }
                j += 1
            } else {
                if let last = result.last, key(last) == b { result[result.count - 1] = new[j] } else { result.append(new[j]) }
                i += 1; j += 1
            }
        }
        return result
    }

    private static func dedupe<T>(_ items: [T], key: (T) -> TimeInterval) -> [T] {
        var result: [T] = []
        result.reserveCapacity(items.count)
        for item in items {
            if let last = result.last, key(last) == key(item) { result[result.count - 1] = item } else { result.append(item) }
        }
        return result
    }

    // MARK: Lookups

    /// The first index whose time is at or after `t`.
    public static func lowerBound<T>(_ items: [T], _ t: TimeInterval, key: (T) -> TimeInterval) -> Int {
        var low = 0, high = items.count
        while low < high {
            let mid = (low + high) / 2
            if key(items[mid]) < t { low = mid + 1 } else { high = mid }
        }
        return low
    }

    /// Readings from one before `from` to one after `to`, so the line runs off both edges.
    public func readingIndices(from: TimeInterval, to: TimeInterval) -> Range<Int> {
        let start = max(0, Self.lowerBound(readings, from, key: { $0.t }) - 1)
        let end = min(readings.count, Self.lowerBound(readings, to, key: { $0.t }) + 1)
        return start..<max(start, end)
    }

    public func doseIndices(_ doses: [Dose], from: TimeInterval, to: TimeInterval) -> Range<Int> {
        let start = Self.lowerBound(doses, from, key: { $0.t })
        let end = Self.lowerBound(doses, to, key: { $0.t })
        return start..<max(start, end)
    }

    /// The reading closest to `t`, within `tolerance` seconds.
    public func nearestReading(to t: TimeInterval, tolerance: TimeInterval = 15 * 60) -> Int? {
        guard !readings.isEmpty else { return nil }
        let index = Self.lowerBound(readings, t, key: { $0.t })
        var best: Int?
        for candidate in [index - 1, index] where candidate >= 0 && candidate < readings.count {
            if best == nil || abs(readings[candidate].t - t) < abs(readings[best!].t - t) { best = candidate }
        }
        guard let best, abs(readings[best].t - t) <= tolerance else { return nil }
        return best
    }

    /// What was on board at `t`: the loop's calculation closest to it, within ten minutes (the loop runs after every
    /// reading, so one is normally a few seconds to a minute away).
    public func loopValues(at t: TimeInterval, tolerance: TimeInterval = 10 * 60) -> Loop? {
        guard !loop.isEmpty else { return nil }
        let index = Self.lowerBound(loop, t, key: { $0.t })
        var best: Loop?
        for candidate in [index - 1, index] where candidate >= 0 && candidate < loop.count {
            let point = loop[candidate]
            if best == nil || abs(point.t - t) < abs(best!.t - t) { best = point }
        }
        guard let best, abs(best.t - t) <= tolerance else { return nil }
        return best
    }

    /// The basal running at `t` (the newest run that covers it, as a temp basal over the scheduled one); nil when no run
    /// covers it.
    public func basalRate(at t: TimeInterval) -> Double? {
        let end = Self.lowerBound(basal, t + 1, key: { $0.start })
        return basal[..<end].last { $0.start <= t && t < $0.end }?.rate
    }

    /// SMBs of [from, to) summed per hour or two (by the clock, as the old chart did), at each bucket's middle and
    /// rounded to 0,1 U: the labels of the longer ranges, where one per SMB would not fit.
    public func smbSums(from: TimeInterval, to: TimeInterval, bucket: TimeInterval) -> [Dose] {
        var sums: [Dose] = []
        for index in doseIndices(smbs, from: from, to: to) {
            let smb = smbs[index]
            let key = (smb.t / bucket).rounded(.down) * bucket + bucket / 2
            if let last = sums.last, last.t == key {
                sums[sums.count - 1] = Dose(t: key, units: last.units + smb.units)
            } else {
                sums.append(Dose(t: key, units: smb.units))
            }
        }
        return sums.map { Dose(t: $0.t, units: ($0.units * 10).rounded() / 10) }
    }

    /// For labels at these x positions (left to right): true for one that would touch the previous label left where it
    /// is, so it is drawn a row higher.
    public static func liftedLabels(at positions: [Double], minimumGap: Double) -> [Bool] {
        var lastUnlifted = -Double.infinity
        return positions.map { x in
            if x - lastUnlifted < minimumGap { return true }
            lastUnlifted = x
            return false
        }
    }

    /// Doses at these x positions (left to right) grouped where their labels would overlap: each group starts at a dose
    /// at least `minimumGap` right of the previous group's first dose. Index ranges into `positions`.
    public static func clusters(at positions: [Double], minimumGap: Double) -> [Range<Int>] {
        var groups: [Range<Int>] = []
        var start = 0
        for index in positions.indices.dropFirst() where positions[index] - positions[start] >= minimumGap {
            groups.append(start..<index)
            start = index
        }
        if !positions.isEmpty { groups.append(start..<positions.count) }
        return groups
    }

    /// The highest reading in [from, to], for the y scale.
    public func maxValue(from: TimeInterval, to: TimeInterval) -> Int? {
        let range = readingIndices(from: from, to: to)
        guard !range.isEmpty else { return nil }
        var value = Int.min
        for index in range { value = max(value, readings[index].value) }
        return value
    }
}

/// How far ahead of the finger the chart loads: plenty, so a fling never reaches the end of the data.
public enum DashboardChartPrefetch {
    /// No further back than this.
    public static let maxHistory: TimeInterval = 90 * 86_400

    /// More is loaded once the visible start comes this close to the oldest loaded data: three screens, at least 12 h.
    public static func margin(span: TimeInterval) -> TimeInterval {
        max(3 * span, 12 * 3_600)
    }

    /// The first request, when the chart appears.
    public static let firstChunk: TimeInterval = 2 * 86_400

    /// One request: four screens, between one and four days (the server allows seven).
    public static func chunk(span: TimeInterval) -> TimeInterval {
        min(max(4 * span, 86_400), 4 * 86_400)
    }
}

/// The chart's data: the dashboard's last 24 h plus history loaded in chunks as the chart is scrolled back, and the
/// loop's IOB/COB for every reading. Its own object, observed only by the chart card, so loading history never
/// re-renders the rest of the dashboard.
@MainActor
public final class DashboardChartStore: ObservableObject {
    public typealias Fetch = @Sendable (_ from: Date, _ to: Date) async throws -> DashboardHistoryResponse

    @Published public private(set) var series = DashboardChartSeries()
    /// A request for older data is running (the chart shows a spinner at its left edge when it gets there).
    @Published public private(set) var isLoadingOlder = false
    /// The oldest and newest moment history has been loaded for (nil before the first load).
    public private(set) var historyFrom: TimeInterval?
    public private(set) var historyTo: TimeInterval?
    public var reachedLimit: Bool {
        guard let historyFrom else { return false }
        return historyFrom <= now().timeIntervalSince1970 - DashboardChartPrefetch.maxHistory
    }

    private let fetch: Fetch
    private let now: () -> Date
    private var wanted: (start: TimeInterval, span: TimeInterval)?
    private var olderTask: Task<Void, Never>?
    private var tailTask: Task<Void, Never>?
    private var failures = 0
    private var applyGeneration = 0

    public init(fetch: @escaping Fetch, now: @escaping () -> Date = Date.init) {
        self.fetch = fetch
        self.now = now
    }

    public convenience init(apiClient: APIClient, patientID: String) {
        self.init(fetch: { from, to in try await apiClient.getDashboardHistory(patientID: patientID, from: from, to: to) })
    }

    deinit {
        olderTask?.cancel()
        tailTask?.cancel()
    }

    /// The dashboard's last 24 h (readings, insulin and the newest IOB/COB) on top of the history; history that has
    /// fallen behind (the app was in the background) is caught up. Dates are parsed off the main thread, so a refresh
    /// during a drag costs the drag nothing.
    public func apply(_ dashboard: DashboardResponse) {
        applyGeneration += 1
        let generation = applyGeneration
        Task { [weak self] in
            let parsed = await Task.detached(priority: .userInitiated) { Self.parse(dashboard) }.value
            guard let self, generation == self.applyGeneration else { return }
            self.merge(parsed)
            self.catchUpTail()
        }
    }

    /// The chart shows [start, start + span): loads older history once the start comes within the margin.
    public func ensureLoaded(visibleStart: TimeInterval, span: TimeInterval) {
        wanted = (visibleStart, span)
        loadOlderIfNeeded()
    }

    private func loadOlderIfNeeded() {
        guard olderTask == nil, let wanted else { return }
        let current = now().timeIntervalSince1970
        let limit = current - DashboardChartPrefetch.maxHistory
        let to = historyFrom ?? current + 60
        guard to > limit else { return }
        guard historyFrom == nil || wanted.start - DashboardChartPrefetch.margin(span: wanted.span) < to else { return }
        // The first load reaches far enough for the margin at once, and two days at least: the 24 h range then
        // starts with a day behind it while the next chunk loads.
        let chunk = historyFrom == nil
            ? max(DashboardChartPrefetch.firstChunk, DashboardChartPrefetch.chunk(span: wanted.span), current - wanted.start + DashboardChartPrefetch.margin(span: wanted.span))
            : DashboardChartPrefetch.chunk(span: wanted.span)
        let from = max(limit, to - min(chunk, 7 * 86_400 - 120))
        isLoadingOlder = true
        olderTask = Task { [weak self, fetch] in
            let result: Result<Parsed, Error>
            do {
                let response = try await fetch(Date(timeIntervalSince1970: from), Date(timeIntervalSince1970: to))
                result = .success(await Task.detached(priority: .userInitiated) { Self.parse(response, from: from, to: to) }.value)
            } catch {
                result = .failure(error)
            }
            guard let self, !Task.isCancelled else { return }
            self.olderTask = nil
            switch result {
            case let .success(parsed):
                self.failures = 0
                self.merge(parsed)
                self.historyFrom = min(self.historyFrom ?? from, from)
                if self.historyTo == nil { self.historyTo = to }
                self.isLoadingOlder = false
                self.loadOlderIfNeeded()
            case let .failure(error):
                if error.isRequestCancellation { self.isLoadingOlder = false; return }
                NSLog("[DASHBOARD] chart history failed: %@", String(describing: error))
                self.failures += 1
                // Retried while the chart still wants it: 2, 4, 8… s, at most 30 s.
                let delay = min(30.0, pow(2.0, Double(self.failures)))
                self.olderTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard let self, !Task.isCancelled else { return }
                    self.olderTask = nil
                    self.loadOlderIfNeeded()
                }
            }
        }
    }

    /// History stopped where it was loaded; IOB/COB since then come from the dashboard only while the screen is on.
    /// After 10 minutes without that, the gap is loaded.
    private func catchUpTail() {
        guard tailTask == nil, let historyTo else { return }
        let current = now().timeIntervalSince1970
        guard current - historyTo > 10 * 60 else { return }
        let from = max(historyTo - 10 * 60, current - 7 * 86_400 + 120)
        tailTask = Task { [weak self, fetch] in
            var parsed: Parsed?
            if let response = try? await fetch(Date(timeIntervalSince1970: from), Date(timeIntervalSince1970: current + 60)) {
                parsed = await Task.detached(priority: .userInitiated) { Self.parse(response, from: from, to: current + 60) }.value
            }
            guard let self, !Task.isCancelled else { return }
            self.tailTask = nil
            if let parsed {
                self.merge(parsed)
                self.historyTo = current
            }
        }
    }

    /// The chart's numbers of one payload, parsed once.
    struct Parsed: Sendable {
        var readings: [DashboardChartSeries.Reading] = []
        var loop: [DashboardChartSeries.Loop] = []
        var boluses: [DashboardChartSeries.Dose] = []
        var smbs: [DashboardChartSeries.Dose] = []
        /// Nil when the insulin could not be read: the basal already shown stays.
        var basal: [DashboardChartSeries.Basal]?
        var basalWindow: ClosedRange<TimeInterval>?
    }

    private func merge(_ parsed: Parsed) {
        var next = series
        next.merge(readings: parsed.readings, loop: parsed.loop, boluses: parsed.boluses, smbs: parsed.smbs, basal: parsed.basal, basalWindow: parsed.basalWindow)
        if next != series { series = next }
    }

    nonisolated static func parse(_ dashboard: DashboardResponse) -> Parsed {
        var parsed = Parsed()
        parsed.readings = readings(dashboard.readings)
        if let status = dashboard.loop, let at = DashboardDate.parse(status.observed_at) {
            parsed.loop = [.init(t: at.timeIntervalSince1970, iob: status.iob_units, cob: status.cob_grams)]
        }
        let insulin = Self.insulin(dashboard.insulin)
        parsed.boluses = insulin.boluses
        parsed.smbs = insulin.smbs
        if dashboard.insulin != nil, let generated = DashboardDate.parse(dashboard.generated_at) {
            parsed.basal = insulin.basal
            parsed.basalWindow = (generated.timeIntervalSince1970 - 24 * 3_600)...generated.timeIntervalSince1970
        }
        return parsed
    }

    nonisolated static func parse(_ response: DashboardHistoryResponse, from: TimeInterval, to: TimeInterval) -> Parsed {
        var parsed = Parsed()
        parsed.readings = readings(response.readings)
        parsed.loop = response.loop.compactMap { point in
            DashboardDate.parse(point.at).map { DashboardChartSeries.Loop(t: $0.timeIntervalSince1970, iob: point.iob_units, cob: point.cob_grams) }
        }
        let insulin = Self.insulin(response.insulin)
        parsed.boluses = insulin.boluses
        parsed.smbs = insulin.smbs
        if response.insulin != nil {
            let windowTo = DashboardDate.parse(response.to)?.timeIntervalSince1970 ?? to
            parsed.basal = insulin.basal
            parsed.basalWindow = from...max(from, windowTo)
        }
        return parsed
    }

    nonisolated private static func readings(_ readings: [DashboardReading]) -> [DashboardChartSeries.Reading] {
        readings.compactMap { reading in
            DashboardDate.parse(reading.at).map { DashboardChartSeries.Reading(t: $0.timeIntervalSince1970, value: reading.value) }
        }
    }

    nonisolated private static func insulin(_ insulin: DashboardInsulin?) -> (boluses: [DashboardChartSeries.Dose], smbs: [DashboardChartSeries.Dose], basal: [DashboardChartSeries.Basal]) {
        guard let insulin else { return ([], [], []) }
        let dose = { (item: DashboardDose) in
            DashboardDate.parse(item.at).map { DashboardChartSeries.Dose(t: $0.timeIntervalSince1970, units: item.units) }
        }
        return (
            insulin.boluses.compactMap(dose),
            insulin.smbs.compactMap(dose),
            insulin.basal.compactMap { run in
                guard let start = DashboardDate.parse(run.start), let end = DashboardDate.parse(run.end), let rate = run.rate else { return nil }
                return .init(start: start.timeIntervalSince1970, end: end.timeIntervalSince1970, rate: rate)
            }
        )
    }
}
