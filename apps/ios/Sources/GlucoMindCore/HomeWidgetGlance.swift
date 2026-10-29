import Foundation

/// What the home-screen widget shows, from the dashboard's own response and thresholds (DashboardThresholds,
/// DashboardGlance): the widget adds no rules of its own, only when to read again and when its reading turns old.
public enum HomeWidgetGlance {
    public struct Point: Equatable {
        public let at: Date
        public let value: Int
    }

    public struct Dose: Equatable {
        public let at: Date
        public let units: Double
    }

    /// The medium widget's one equipment field: the item needing attention most, as the dashboard's equipment tile.
    public struct EquipmentSummary: Equatable {
        public let level: DashboardLevel
        /// "Sprzęt OK", "Wkłucie 2 d 20 h".
        public let title: String
        /// What to do ("zmień wkrótce"); nil when all is well.
        public let hint: String?
        /// How many more items need attention.
        public let more: Int
        /// The dashboard has no equipment data at all.
        public let hasData: Bool
    }

    public static func equipmentSummary(_ items: [DashboardGlance.EquipmentItem]) -> EquipmentSummary {
        let attention = DashboardGlance.attention(items)
        guard let first = attention.first else {
            return EquipmentSummary(level: .normal, title: items.isEmpty ? "Sprzęt" : "Sprzęt OK", hint: items.isEmpty ? "brak danych" : nil,
                                    more: 0, hasData: !items.isEmpty)
        }
        return EquipmentSummary(level: first.level, title: first.headline, hint: first.hint, more: attention.count - 1, hasData: true)
    }

    /// The large widget's two equipment tiles: what needs attention first (reservoir and battery included), then the
    /// sensor and the site, so a low reservoir is never hidden behind a fine sensor.
    public static func equipmentTiles(_ items: [DashboardGlance.EquipmentItem]) -> [DashboardGlance.EquipmentItem] {
        let attention = DashboardGlance.attention(items)
        let fine = [DashboardGlance.EquipmentItem.Kind.sensor, .site].compactMap { kind in
            items.first { $0.kind == kind && $0.level == .normal }
        }
        return Array((attention + fine).prefix(2))
    }

    /// Readings of the last `hours`, oldest first.
    public static func points(_ dashboard: DashboardResponse, hours: Double, now: Date) -> [Point] {
        let from = now.addingTimeInterval(-hours * 3_600)
        return dashboard.readings.compactMap { reading in
            guard let at = DashboardDate.parse(reading.at), at >= from, at <= now.addingTimeInterval(60) else { return nil }
            return Point(at: at, value: reading.value)
        }
        .sorted { $0.at < $1.at }
    }

    /// The top of the glucose scale, as the dashboard's chart: 220 mg/dL unless a reading goes past it, then above the
    /// highest reading in steps of 25.
    public static func scaleTop(_ points: [Point]) -> Double {
        let highest = points.map(\.value).max() ?? 0
        return max(220, ((Double(highest) + 10) / 25).rounded(.up) * 25)
    }

    public static func boluses(_ dashboard: DashboardResponse, hours: Double, now: Date) -> [Dose] {
        doses(dashboard.insulin?.boluses ?? [], hours: hours, now: now)
    }

    public static func smbs(_ dashboard: DashboardResponse, hours: Double, now: Date) -> [Dose] {
        doses(dashboard.insulin?.smbs ?? [], hours: hours, now: now)
    }

    private static func doses(_ doses: [DashboardDose], hours: Double, now: Date) -> [Dose] {
        let from = now.addingTimeInterval(-hours * 3_600)
        return doses.compactMap { dose in
            guard let at = DashboardDate.parse(dose.at), at >= from, dose.units > 0 else { return nil }
            return Dose(at: at, units: dose.units)
        }
    }

    /// How old the reading looks at `now`: the dashboard's reading-age thresholds (yellow after 10 min, red after 15).
    public static func readingAge(_ dashboard: DashboardResponse?, now: Date) -> DashboardLevel {
        guard let observedAt = dashboard?.glucose?.observedAt else { return .alarm }
        return DashboardThresholds.readingAge(minutes: DashboardFormat.wholeMinutes(since: observedAt, now: now))
    }

    /// The widget's own timeline: drawn now and then every minute until 20 min after the reading, so "X min temu" stays
    /// right and the value turns yellow and red on time (after 10 and 15 min) even when iOS does not let the widget read
    /// again. These redraws cost nothing: no network and no reload from the daily budget.
    public static func entryDates(_ dashboard: DashboardResponse?, now: Date) -> [Date] {
        guard let observedAt = dashboard?.glucose?.observedAt else { return [now] }
        let ticks = (1...20).map { observedAt.addingTimeInterval(TimeInterval($0 * 60) + 1) }.filter { $0 > now }
        return [now] + ticks
    }

    /// When to read again: just after the next expected CGM reading (5 min after the last, a little later for the loop
    /// app to upload it), never sooner than 5 min. iOS treats it as a wish: it spends a daily budget and may come later.
    public static func nextReload(after dashboard: DashboardResponse?, now: Date) -> Date {
        let earliest = now.addingTimeInterval(5 * 60)
        guard let observedAt = dashboard?.glucose?.observedAt else { return earliest }
        let expected = observedAt.addingTimeInterval(5 * 60 + 30)
        return max(expected, earliest)
    }
}
