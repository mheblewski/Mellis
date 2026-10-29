import Foundation

/// What the dashboard says at a glance, with no scrolling: the "Teraz" strip (what is happening now, the most urgent
/// first) and the equipment tile (the item that needs attention most, then a count of the rest). The thresholds are
/// the owner's (DashboardThresholds); nothing here adds new ones.
public enum DashboardGlance {
    /// Where a strip item leads when tapped.
    public enum Action: Equatable {
        case meals
        case equipment
    }

    public struct NowItem: Equatable, Identifiable {
        public let id: String
        /// .warning or .alarm; the strip never lists normal things.
        public let level: DashboardLevel
        public let title: String
        public let detail: String?
        public let action: Action?
    }

    public struct EquipmentItem: Equatable, Identifiable {
        /// At the same level, the order of attention: what runs out soonest first. The pump's last reading is not here:
        /// the loop tile already says when Trio last talked to it. Raw values start at 1, so ids stay as they were.
        public enum Kind: Int, CaseIterable {
            case reservoir = 1, battery, sensor, site
        }

        public let kind: Kind
        public var id: Int { kind.rawValue }
        public let name: String
        public let value: String
        /// Under the name in the list: what the value is ("insuliny", "od 22 paź, 08:06").
        public let note: String
        public let level: DashboardLevel
        /// For the list's thin meter: what is left (reservoir, battery, and the sensor's and site's life).
        public let fraction: Double?
        /// The reservoir: how long the insulin lasts ("na ok. 2 dni"); nil without the server's estimate.
        public let duration: String?

        public init(kind: Kind, name: String, value: String, note: String, level: DashboardLevel, fraction: Double?, duration: String? = nil) {
            self.kind = kind
            self.name = name
            self.value = value
            self.note = note
            self.level = level
            self.fraction = fraction
            self.duration = duration
        }

        /// What to do, only when the item needs attention ("wymień dziś"); the reservoir says first how long it lasts
        /// ("na ok. 6 godz. · wymień teraz").
        public var hint: String? {
            switch (kind, level) {
            case (_, .normal): return nil
            case (.reservoir, .alarm): return duration.map { "\($0) · wymień teraz" } ?? "wymień teraz"
            case (.reservoir, _): return duration.map { "\($0) · wymień dziś" } ?? "wymień dziś"
            case (.battery, .alarm): return "wymień teraz"
            case (.battery, _): return "wymień dziś"
            case (.sensor, .alarm): return "do wymiany"
            case (.sensor, _): return "kończy się wkrótce"
            case (.site, .alarm): return "do zmiany"
            case (.site, _): return "zmień wkrótce"
            }
        }

        /// The tile's line for this item: "Zbiornik 18 j".
        public var headline: String { "\(name) \(value)" }
    }

    // MARK: Equipment

    /// Every item the dashboard has data for: the ones needing attention first (red before yellow, then by kind), the
    /// rest after them in kind order.
    public static func equipment(_ dashboard: DashboardResponse, now: Date) -> [EquipmentItem] {
        var items: [EquipmentItem] = []
        if let pump = dashboard.pump, let units = pump.reservoir_units {
            // "22 j" with "na ok. 2 dni" under the name (reservoir-level.v1); "insuliny" without the server's estimate.
            let duration = pump.reservoir_hours_left.map { DashboardFormat.reservoirDuration(hours: $0) }
            items.append(EquipmentItem(kind: .reservoir, name: "Zbiornik", value: "\(DashboardFormat.units(units)) j", note: duration ?? "insuliny",
                                       level: pump.reservoirLevel ?? DashboardThresholds.reservoir(units: units), fraction: pump.reservoirFraction,
                                       duration: duration))
        }
        if let percent = dashboard.pump?.battery_percent {
            items.append(EquipmentItem(kind: .battery, name: "Bateria", value: "\(Int(percent.rounded()))%", note: "pompy",
                                       level: DashboardThresholds.battery(percent: percent), fraction: percent / 100))
        }
        if let started = dashboard.sensorStartedAt {
            let hours = max(0, now.timeIntervalSince(started) / 3_600)
            items.append(EquipmentItem(kind: .sensor, name: "Sensor", value: age(hours: hours), note: DashboardFormat.since(started),
                                       level: DashboardThresholds.sensorAge(hours: hours),
                                       fraction: lifeLeft(hours: hours, of: DashboardThresholds.sensorLifeHours)))
        }
        if let changed = dashboard.siteChangedAt {
            let hours = max(0, now.timeIntervalSince(changed) / 3_600)
            items.append(EquipmentItem(kind: .site, name: "Wkłucie", value: age(hours: hours), note: DashboardFormat.since(changed),
                                       level: DashboardThresholds.siteAge(hours: hours),
                                       fraction: lifeLeft(hours: hours, of: DashboardThresholds.siteLifeHours)))
        }
        return items.sorted { a, b in
            let (ra, rb) = (rank(a.level), rank(b.level))
            return ra != rb ? ra > rb : a.kind.rawValue < b.kind.rawValue
        }
    }

    /// The part of a sensor's or site's life still ahead, as the reservoir's and battery's meters show what is left.
    private static func lifeLeft(hours: Double, of life: Double) -> Double {
        max(0, 1 - hours / life)
    }

    /// The items needing attention, in the order the tile shows them.
    public static func attention(_ items: [EquipmentItem]) -> [EquipmentItem] {
        items.filter { $0.level != .normal }
    }

    // MARK: "Teraz"

    /// What is happening now, red before yellow. Empty when all is well: the dashboard then shows no strip.
    public static func now(_ dashboard: DashboardResponse, equipment: [EquipmentItem], mealsWaiting: Int, now: Date, loopSystem: LoopSystemKind = .unknown) -> [NowItem] {
        var items: [NowItem] = []
        if let glucose = dashboard.glucose {
            let level = DashboardThresholds.glucose(glucose.value)
            let trend = GlucoseTrend.label(glucose.direction)
            let falling = glucose.direction == "SingleDown" || glucose.direction == "DoubleDown"
            if level == .alarm, glucose.value < 70 {
                items.append(NowItem(id: "glucose", level: .alarm, title: "Nisko · \(glucose.value) mg/dL", detail: trend?.lowercased(), action: nil))
            } else if level == .alarm {
                items.append(NowItem(id: "glucose", level: .alarm, title: "Wysoko · \(glucose.value) mg/dL", detail: trend?.lowercased(), action: nil))
            } else if level == .warning {
                items.append(NowItem(id: "glucose", level: .warning, title: "Powyżej zakresu · \(glucose.value) mg/dL", detail: trend?.lowercased(), action: nil))
            } else if falling, glucose.value < 100 {
                // Still in range but heading for a low.
                let change = glucose.delta.map { "\(DashboardFormat.signedDelta($0)) na 5 min" }
                items.append(NowItem(id: "glucose", level: .warning, title: "Spada · \(glucose.value) mg/dL", detail: change, action: nil))
            }
            if let observedAt = glucose.observedAt {
                let minutes = DashboardFormat.wholeMinutes(since: observedAt, now: now)
                let ageLevel = DashboardThresholds.readingAge(minutes: minutes)
                if ageLevel != .normal {
                    items.append(NowItem(id: "reading-age", level: ageLevel, title: "Brak nowego odczytu", detail: "od \(minutes) min", action: nil))
                }
            }
        } else {
            items.append(NowItem(id: "reading-age", level: .alarm, title: "Brak odczytu glukozy", detail: nil, action: nil))
        }
        if let loop = loop(dashboard, now: now), loop.level != .normal {
            items.append(NowItem(id: "loop", level: loop.level, title: "Pętla nie liczy od \(loop.minutes) min", detail: "sprawdź \(loopSystem.names.accusative) na telefonie", action: nil))
        }
        // Red equipment is happening now; yellow waits in the tile.
        for item in equipment where item.level == .alarm {
            items.append(NowItem(id: "equipment-\(item.kind.rawValue)", level: .alarm, title: item.headline, detail: item.hint, action: .equipment))
        }
        if mealsWaiting > 0 {
            items.append(NowItem(id: "meals", level: .warning, title: mealsLine(mealsWaiting), detail: nil, action: .meals))
        }
        // Stable: within a level the order above (glucose, reading, loop, equipment, meals).
        return items.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element.level), rank(b.element.level))
            return ra != rb ? ra > rb : a.offset < b.offset
        }.map(\.element)
    }

    // MARK: Loop and last bolus

    /// The loop: how long since its last calculation and the basal rate running now.
    public struct LoopStatus: Equatable {
        public let minutes: Int
        public let level: DashboardLevel
        /// U/h of the basal run covering now (else the latest run); nil without insulin data.
        public let basalRate: Double?
    }

    public static func loop(_ dashboard: DashboardResponse, now: Date) -> LoopStatus? {
        guard let observed = dashboard.loop.flatMap({ DashboardDate.parse($0.observed_at) }) else { return nil }
        let minutes = DashboardFormat.wholeMinutes(since: observed, now: now)
        let runs = (dashboard.insulin?.basal ?? []).compactMap { run -> (start: Date, end: Date, rate: Double)? in
            guard let start = DashboardDate.parse(run.start), let end = DashboardDate.parse(run.end), let rate = run.rate else { return nil }
            return (start, end, rate)
        }
        let current = runs.first { $0.start <= now && now < $0.end } ?? runs.max { $0.end < $1.end }
        return LoopStatus(minutes: minutes, level: DashboardThresholds.loopAge(minutes: minutes), basalRate: current?.rate)
    }

    public struct LastBolus: Equatable {
        public let units: Double
        public let at: Date
    }

    /// The newest bolus of the last 24 h (SMBs are the loop's own and stay on the chart).
    public static func lastBolus(_ dashboard: DashboardResponse) -> LastBolus? {
        (dashboard.insulin?.boluses ?? [])
            .compactMap { dose in DashboardDate.parse(dose.at).map { LastBolus(units: dose.units, at: $0) } }
            .max { $0.at < $1.at }
    }

    /// "teraz", "35 min temu", "2 h temu".
    public static func ago(minutes: Int) -> String {
        if minutes < 1 { return "teraz" }
        return minutes < 60 ? "\(minutes) min temu" : "\(minutes / 60) h temu"
    }

    // MARK: Time in range, five bands

    /// One band of the time-in-range breakdown, top to bottom as on an AGP report.
    public struct RangeBand: Equatable, Identifiable {
        public enum Kind: Int, CaseIterable {
            case veryHigh, high, inRange, low, veryLow
        }

        public let kind: Kind
        public var id: Int { kind.rawValue }
        public let percent: Int
        /// Of a day ("1 h 10 min"; the daily average over a longer period).
        public let minutes: Int
        /// Whether the consensus target for this band (or its side) is met; nil where there is none.
        public let targetMet: Bool?

        public var title: String {
            switch kind {
            case .veryHigh: return "Bardzo wysoko"
            case .high: return "Wysoko"
            case .inRange: return "W zakresie"
            case .low: return "Nisko"
            case .veryLow: return "Bardzo nisko"
            }
        }

        /// mg/dL, as the owner set the bands (2026-10-23): under 55 very low, 55–69 low, 70–180, 181–250, over 250.
        public var range: String {
            switch kind {
            case .veryHigh: return "> 250"
            case .high: return "181–250"
            case .inRange: return "70–180"
            case .low: return "55–69"
            case .veryLow: return "< 55"
            }
        }

        /// The International Consensus on Time in Range (Battelino 2019) targets, for adults with type 1.
        public var target: String {
            switch kind {
            case .veryHigh: return "cel < 5%"
            case .high: return "cel < 25% powyżej 180"
            case .inRange: return "cel > 70%"
            case .low: return "cel < 4% poniżej 70"
            case .veryLow: return "cel < 1%"
            }
        }
    }

    /// The periods the breakdown offers: 24 h (the tile's, from the dashboard's own readings), 7 and 14 days.
    public enum RangePeriod: Int, CaseIterable, Identifiable {
        case day = 1, week = 7, twoWeeks = 14

        public var id: Int { rawValue }
        public var days: Int { rawValue }

        /// The picker's label.
        public var title: String {
            switch self {
            case .day: return "24 h"
            case .week: return "7 dni"
            case .twoWeeks: return "14 dni"
            }
        }

        /// Under the headline: "ostatnie 24 h", "ostatnie 7 dni".
        public var caption: String { "ostatnie \(title)" }
    }

    /// The readings of the last `hours` split into the five bands; percentages sum to 100 (largest remainder). Nil
    /// without readings in the window.
    public static func rangeBands(_ readings: [DashboardReading], hours: Int, now: Date) -> [RangeBand]? {
        let from = now.addingTimeInterval(-Double(hours) * 3_600)
        let values = readings.compactMap { reading -> Int? in
            guard let at = DashboardDate.parse(reading.at), at >= from, at <= now.addingTimeInterval(300) else { return nil }
            return reading.value
        }
        var counts = [Int](repeating: 0, count: RangeBand.Kind.allCases.count)
        for value in values {
            let kind: RangeBand.Kind = value < 55 ? .veryLow : value < 70 ? .low : value <= 180 ? .inRange : value <= 250 ? .high : .veryHigh
            counts[kind.rawValue] += 1
        }
        return rangeBands(counts: counts)
    }

    /// The share of the last `hours` with a reading, in 5-minute slots (a 1-minute CGM fills a slot five times over).
    public static func sensorCoverage(_ readings: [DashboardReading], hours: Int, now: Date) -> Int {
        let from = now.addingTimeInterval(-Double(hours) * 3_600)
        var slots = Set<Int>()
        for reading in readings {
            guard let at = DashboardDate.parse(reading.at), at >= from, at <= now else { continue }
            slots.insert(Int(at.timeIntervalSince(from) / 300))
        }
        return min(100, Int((Double(slots.count) * 100 / (Double(hours) * 12)).rounded()))
    }

    /// The server's counts for a longer period split the same way.
    public static func rangeBands(_ period: DashboardTimeInRangePeriod) -> [RangeBand]? {
        let c = period.counts
        var counts = [Int](repeating: 0, count: RangeBand.Kind.allCases.count)
        counts[RangeBand.Kind.veryHigh.rawValue] = c.very_high
        counts[RangeBand.Kind.high.rawValue] = c.high
        counts[RangeBand.Kind.inRange.rawValue] = c.in_range
        counts[RangeBand.Kind.low.rawValue] = c.low
        counts[RangeBand.Kind.veryLow.rawValue] = c.very_low
        return rangeBands(counts: counts)
    }

    /// Readings per band (indexed by `Kind`) as bands with percentages, the targets and the time a day (an average
    /// over a longer period). Nil without readings.
    static func rangeBands(counts: [Int]) -> [RangeBand]? {
        let total = Double(counts.reduce(0, +))
        guard total > 0 else { return nil }
        let exact = counts.map { Double($0) * 100 / total }
        var percents = exact.map { Int($0.rounded(.down)) }
        // Hand the points lost to rounding down to the largest remainders, so the bands add up to 100.
        let missing = 100 - percents.reduce(0, +)
        for index in exact.indices.sorted(by: { exact[$0] - Double(percents[$0]) > exact[$1] - Double(percents[$1]) }).prefix(missing) {
            percents[index] += 1
        }
        let share = { (kinds: [RangeBand.Kind]) in kinds.map { Double(counts[$0.rawValue]) * 100 / total }.reduce(0, +) }
        return RangeBand.Kind.allCases.map { kind in
            let met: Bool
            switch kind {
            case .veryHigh: met = share([.veryHigh]) < 5
            case .high: met = share([.high, .veryHigh]) < 25
            case .inRange: met = share([.inRange]) > 70
            case .low: met = share([.low, .veryLow]) < 4
            case .veryLow: met = share([.veryLow]) < 1
            }
            let minutes = Int((Double(counts[kind.rawValue]) / total * 24 * 60).rounded())
            return RangeBand(kind: kind, percent: percents[kind.rawValue], minutes: minutes, targetMet: met)
        }
    }

    /// "1 h 10 min", "45 min", "0 min".
    public static func duration(minutes: Int) -> String {
        let (h, m) = (minutes / 60, minutes % 60)
        if h == 0 { return "\(m) min" }
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }

    /// "1 posiłek czeka na opis", "2 posiłki czekają…", "5 posiłków czeka…".
    public static func mealsLine(_ count: Int) -> String {
        let lastTwo = count % 100, last = count % 10
        if count == 1 { return "1 posiłek czeka na opis" }
        if (2...4).contains(last) && !(12...14).contains(lastTwo) { return "\(count) posiłki czekają na opis" }
        return "\(count) posiłków czeka na opis"
    }

    /// "1 d 4 h", or "4 h" under a day.
    static func age(hours: Double) -> String {
        let parts = DashboardFormat.dayHourParts(hours: hours)
        return parts.days > 0 ? "\(parts.days) d \(parts.hours) h" : "\(parts.hours) h"
    }

    private static func rank(_ level: DashboardLevel) -> Int {
        switch level {
        case .alarm: return 2
        case .warning: return 1
        case .normal: return 0
        }
    }
}
