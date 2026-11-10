import Foundation

/// Another patient than the one on screen whose glucose is below 70: the pill under the name on Teraz names them, with
/// their value and arrow, and a tap opens their screen. Only from that patient's own dashboard read; no forecast (the
/// predicted-low push covers that) and no state labels.
///
/// - Below 70 in a reading up to `freshMinutes` old: `.low`; below 54: `.urgent`.
/// - It stays until two readings in a row are 70 or above, so a value at the edge does not make it blink.
/// - No new reading for longer than `freshMinutes` while it was on: `.noReading` (grey) for at most `noReadingMinutes`,
///   then nothing.
public struct OtherPatientLow: Equatable, Sendable, Identifiable {
    public enum Level: Int, Comparable, Sendable {
        case noReading = 0
        case low = 1
        case urgent = 2

        public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    public let patientID: String
    public let name: String
    public let level: Level
    /// mg/dL of the newest reading.
    public let value: Int
    /// Nightscout direction of the newest reading.
    public let direction: String?
    /// How old the newest reading is, in whole minutes.
    public let minutesSinceReading: Int

    public var id: String { patientID }

    public static let lowBelow = 70
    public static let urgentBelow = 54
    /// A reading this old still speaks for now (one missed 5-minute CGM reading and a little).
    public static let freshMinutes = 10.0
    /// The grey "no reading" pill stays at most this long after the reading went old (owner, 2026-11-08).
    public static let noReadingMinutes = 30.0

    public init(patientID: String, name: String, level: Level, value: Int, direction: String?, minutesSinceReading: Int) {
        self.patientID = patientID
        self.name = name
        self.level = level
        self.value = value
        self.direction = direction
        self.minutesSinceReading = minutesSinceReading
    }

    /// The signal for one patient from their dashboard, or nil when there is nothing to show.
    public static func evaluate(patientID: String, name: String, dashboard: DashboardResponse?, now: Date) -> OtherPatientLow? {
        guard let glucose = dashboard?.glucose, let observedAt = glucose.observedAt else { return nil }
        let minutes = now.timeIntervalSince(observedAt) / 60
        guard minutes >= -5, minutes <= freshMinutes + noReadingMinutes else { return nil }
        // Below 70 now, or the reading before this one was (the second reading of 70 or above clears it).
        let previous = previousValue(before: observedAt, in: dashboard?.readings ?? [])
        guard glucose.value < lowBelow || (previous.map { $0 < lowBelow } ?? false) else { return nil }
        let level: Level = minutes > freshMinutes ? .noReading : glucose.value < urgentBelow ? .urgent : .low
        return OtherPatientLow(
            patientID: patientID,
            name: name,
            level: level,
            value: glucose.value,
            direction: glucose.direction,
            minutesSinceReading: max(0, Int(minutes.rounded(.down)))
        )
    }

    /// The most pressing first: below 54, then below 70, then no reading; the lower value first within a level.
    public static func mostPressingFirst(_ signals: [OtherPatientLow]) -> [OtherPatientLow] {
        signals.sorted { lhs, rhs in
            if lhs.level != rhs.level { return lhs.level > rhs.level }
            if lhs.value != rhs.value { return lhs.value < rhs.value }
            return lhs.name < rhs.name
        }
    }

    /// The value of the reading before `observedAt` (at least a minute earlier, at most 15 minutes): the one CGM
    /// interval back, not an old value from before a gap.
    static func previousValue(before observedAt: Date, in readings: [DashboardReading]) -> Int? {
        readings
            .compactMap { reading -> (Date, Int)? in
                guard let at = DashboardDate.parse(reading.at) else { return nil }
                let gap = observedAt.timeIntervalSince(at)
                return gap >= 60 && gap <= 15 * 60 ? (at, reading.value) : nil
            }
            .max { $0.0 < $1.0 }?
            .1
    }

    /// What the pill says (VoiceOver), as one sentence.
    public var spokenLabel: String {
        switch level {
        case .noReading:
            return "\(name): brak odczytu od \(minutesSinceReading) min."
        case .low, .urgent:
            let trend = GlucoseTrend.label(direction).map { ", \($0.lowercased())" } ?? ""
            return "\(name): glukoza \(value)\(trend)."
        }
    }
}
