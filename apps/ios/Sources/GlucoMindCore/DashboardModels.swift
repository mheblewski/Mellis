import Foundation

/// GET /v1/patients/{patientId}/dashboard: the latest CGM reading, 24 h of readings with time in range, the pump and
/// when the infusion site and the sensor were changed. Nightscout is the only source for now.
public struct DashboardResponse: Codable, Equatable {
    public let patient_id: String
    public let generated_at: String
    public let glucose: DashboardGlucose?
    public let readings: [DashboardReading]
    public let time_in_range: DashboardTimeInRange?
    public let pump: DashboardPump?
    public let loop: DashboardLoop?
    /// Boluses, SMBs and delivered basal of the last 24 h (absent on older servers).
    public let insulin: DashboardInsulin?
    public let site_changed_at: String?
    public let sensor_started_at: String?

    public init(
        patient_id: String,
        generated_at: String,
        glucose: DashboardGlucose?,
        readings: [DashboardReading],
        time_in_range: DashboardTimeInRange?,
        pump: DashboardPump?,
        loop: DashboardLoop? = nil,
        insulin: DashboardInsulin? = nil,
        site_changed_at: String?,
        sensor_started_at: String?
    ) {
        self.patient_id = patient_id
        self.generated_at = generated_at
        self.glucose = glucose
        self.readings = readings
        self.time_in_range = time_in_range
        self.pump = pump
        self.loop = loop
        self.insulin = insulin
        self.site_changed_at = site_changed_at
        self.sensor_started_at = sensor_started_at
    }

    /// Equal apart from when the server generated it.
    public func hasSameData(as other: DashboardResponse?) -> Bool {
        guard let other else { return false }
        return glucose == other.glucose && readings == other.readings && time_in_range == other.time_in_range
            && pump == other.pump && loop == other.loop && insulin == other.insulin && site_changed_at == other.site_changed_at
            && sensor_started_at == other.sensor_started_at && patient_id == other.patient_id
    }

    public var siteChangedAt: Date? { site_changed_at.flatMap(DashboardDate.parse) }
    public var sensorStartedAt: Date? { sensor_started_at.flatMap(DashboardDate.parse) }
}

public struct DashboardGlucose: Codable, Equatable {
    public let value: Int
    public let unit: String
    /// Nightscout direction: Flat, FortyFiveUp, SingleUp, DoubleUp, FortyFiveDown, SingleDown, DoubleDown.
    public let direction: String?
    public let observed_at: String
    /// mg/dL per 5 minutes.
    public let delta: Int?

    public init(value: Int, unit: String, direction: String?, observed_at: String, delta: Int?) {
        self.value = value
        self.unit = unit
        self.direction = direction
        self.observed_at = observed_at
        self.delta = delta
    }

    public var observedAt: Date? { DashboardDate.parse(observed_at) }
}

public struct DashboardReading: Codable, Equatable {
    public let at: String
    public let value: Int

    public init(at: String, value: Int) {
        self.at = at
        self.value = value
    }
}

public struct DashboardTimeInRange: Codable, Equatable {
    public let hours: Int
    public let readings_count: Int
    public let low_percent: Int
    public let in_range_percent: Int
    public let high_percent: Int

    public init(hours: Int, readings_count: Int, low_percent: Int, in_range_percent: Int, high_percent: Int) {
        self.hours = hours
        self.readings_count = readings_count
        self.low_percent = low_percent
        self.in_range_percent = in_range_percent
        self.high_percent = high_percent
    }
}

/// GET /v1/patients/{patientId}/dashboard/time-in-range?days=1|7|14: the breakdown's readings in five bands over the
/// period (mg/dL: < 55, 55–69, 70–180, 181–250, > 250) and the share of it the sensor covered.
public struct DashboardTimeInRangePeriod: Codable, Equatable {
    public struct Counts: Codable, Equatable {
        public let very_low: Int
        public let low: Int
        public let in_range: Int
        public let high: Int
        public let very_high: Int

        public init(very_low: Int, low: Int, in_range: Int, high: Int, very_high: Int) {
            self.very_low = very_low
            self.low = low
            self.in_range = in_range
            self.high = high
            self.very_high = very_high
        }
    }

    public let patient_id: String
    public let days: Int
    public let from: String
    public let to: String
    public let readings_count: Int
    public let counts: Counts
    public let sensor_coverage_percent: Int

    public init(patient_id: String, days: Int, from: String, to: String, readings_count: Int, counts: Counts, sensor_coverage_percent: Int) {
        self.patient_id = patient_id
        self.days = days
        self.from = from
        self.to = to
        self.readings_count = readings_count
        self.counts = counts
        self.sensor_coverage_percent = sensor_coverage_percent
    }
}

public struct DashboardPump: Codable, Equatable {
    public let battery_percent: Double?
    public let reservoir_units: Double?
    /// The level right after the last reservoir change; nil when the server could not tell.
    public let reservoir_full_units: Double?
    /// Hours the reservoir lasts at the patient's average daily insulin (reservoir-usage.v1); nil without an estimate
    /// or from an older server.
    public let reservoir_hours_left: Double?
    /// The server's colour for the reservoir ("normal", "warning", "alarm", reservoir-level.v1); nil from an older
    /// server, and the app's own fixed thresholds apply.
    public let reservoir_level: String?
    public let last_read_at: String

    public init(battery_percent: Double?, reservoir_units: Double?, reservoir_full_units: Double? = nil, reservoir_hours_left: Double? = nil,
                reservoir_level: String? = nil, last_read_at: String) {
        self.battery_percent = battery_percent
        self.reservoir_units = reservoir_units
        self.reservoir_full_units = reservoir_full_units
        self.reservoir_hours_left = reservoir_hours_left
        self.reservoir_level = reservoir_level
        self.last_read_at = last_read_at
    }

    /// The server's reservoir level when it sent one, else the fixed thresholds (older servers).
    public var reservoirLevel: DashboardLevel? {
        guard let units = reservoir_units else { return nil }
        switch reservoir_level {
        case "alarm": return .alarm
        case "warning": return .warning
        case "normal": return .normal
        default: return DashboardThresholds.reservoir(units: units)
        }
    }

    /// The reservoir bar's 100%: the level after the last change, else 200 U.
    public static let defaultReservoirCapacity = 200.0

    public var reservoirFraction: Double? {
        guard let units = reservoir_units else { return nil }
        let capacity = reservoir_full_units.flatMap { $0 > 0 ? $0 : nil } ?? Self.defaultReservoirCapacity
        return min(max(units / capacity, 0), 1)
    }

    public var lastReadAt: Date? { DashboardDate.parse(last_read_at) }
}

public struct DashboardInsulin: Codable, Equatable {
    public let boluses: [DashboardDose]
    public let smbs: [DashboardDose]
    public let basal: [DashboardBasalRun]

    public init(boluses: [DashboardDose], smbs: [DashboardDose], basal: [DashboardBasalRun]) {
        self.boluses = boluses
        self.smbs = smbs
        self.basal = basal
    }
}

public struct DashboardDose: Codable, Equatable {
    public let at: String
    public let units: Double

    public init(at: String, units: Double) {
        self.at = at
        self.units = units
    }
}

public struct DashboardBasalRun: Codable, Equatable {
    public let start: String
    public let end: String
    /// U/h; nil when unknown.
    public let rate: Double?

    public init(start: String, end: String, rate: Double?) {
        self.start = start
        self.end = end
        self.rate = rate
    }
}

/// Insulin (U) and carbs (g) on board from the loop app's newest calculation.
public struct DashboardLoop: Codable, Equatable {
    public let iob_units: Double?
    public let cob_grams: Double?
    public let observed_at: String

    public init(iob_units: Double?, cob_grams: Double?, observed_at: String) {
        self.iob_units = iob_units
        self.cob_grams = cob_grams
        self.observed_at = observed_at
    }
}

/// How a value is coloured: normal, yellow or red.
public enum DashboardLevel: Equatable {
    case normal
    case warning
    case alarm
}

/// The owner's thresholds for each tile (2026-10-17). Time in range follows the International Consensus on Time in
/// Range (Battelino et al., Diabetes Care 2019): target above 70% with under 4% below 70 mg/dL; 50% is the target for
/// people at high risk, so less than that is red.
public enum DashboardThresholds {
    public static func glucose(_ value: Int) -> DashboardLevel {
        if value > 250 || value < 70 { return .alarm }
        if value > 180 { return .warning }
        return .normal
    }

    public static func readingAge(minutes: Int) -> DashboardLevel {
        if minutes > 15 { return .alarm }
        if minutes > 10 { return .warning }
        return .normal
    }

    /// Since the loop's last calculation (Trio's device status): yellow after 15 min, red after 30 (2026-10-23).
    public static func loopAge(minutes: Int) -> DashboardLevel {
        if minutes > 30 { return .alarm }
        if minutes > 15 { return .warning }
        return .normal
    }

    public static func battery(percent: Double) -> DashboardLevel {
        if percent < 20 { return .alarm }
        if percent < 30 { return .warning }
        return .normal
    }

    /// The fallback when the server sends no level (older servers): fixed units for everyone. The server's level
    /// (reservoir-level.v1) is by the hours the insulin lasts at the patient's own use.
    public static func reservoir(units: Double) -> DashboardLevel {
        if units < 10 { return .alarm }
        if units < 25 { return .warning }
        return .normal
    }

    /// A site's and a sensor's life: red once it is over, so the list's meter empties then.
    public static let siteLifeHours: Double = 72
    public static let sensorLifeHours: Double = 240

    public static func siteAge(hours: Double) -> DashboardLevel {
        if hours > siteLifeHours { return .alarm }
        if hours > 48 { return .warning }
        return .normal
    }

    public static func sensorAge(hours: Double) -> DashboardLevel {
        if hours > sensorLifeHours { return .alarm }
        if hours > 216 { return .warning }
        return .normal
    }

    public static func timeInRange(percent: Int) -> DashboardLevel {
        if percent < 50 { return .alarm }
        if percent < 70 { return .warning }
        return .normal
    }

    /// Time below 70 mg/dL: the consensus target is under 4%.
    public static func timeBelowRange(percent: Int) -> DashboardLevel {
        percent > 4 ? .alarm : .normal
    }
}

public enum DashboardChartRange: String, CaseIterable, Identifiable {
    case threeHours = "3h"
    case twelveHours = "12h"
    case day = "24h"

    public var id: String { rawValue }

    public var hours: Int {
        switch self {
        case .threeHours: return 3
        case .twelveHours: return 12
        case .day: return 24
        }
    }

    /// Hours between the labels on the time axis.
    public var axisStrideHours: Int {
        switch self {
        case .threeHours: return 1
        case .twelveHours: return 3
        case .day: return 6
        }
    }
}

public enum DashboardFormat {
    /// "1 d 4 h" for ages; under a day only hours.
    public static func dayHourParts(hours: Double) -> (days: Int, hours: Int) {
        let total = max(0, Int(hours.rounded(.down)))
        return (total / 24, total % 24)
    }

    public static func wholeMinutes(since date: Date, now: Date) -> Int {
        max(0, Int(now.timeIntervalSince(date) / 60))
    }

    /// "+4", "−12", "0": a real minus sign, as on the mockup.
    public static func signedDelta(_ delta: Int) -> String {
        if delta > 0 { return "+\(delta)" }
        if delta < 0 { return "\u{2212}\(abs(delta))" }
        return "0"
    }

    /// How long the reservoir lasts, as the server's push says it (reservoir-level.v1): "na ok. 2 dni" from 48 h on
    /// (whole days, rounded down), "na ok. 14 godz." below, "na mniej niż 1 godz." under an hour.
    public static func reservoirDuration(hours: Double) -> String {
        guard hours.isFinite, hours >= 1 else { return "na mniej niż 1 godz." }
        if hours >= 48 {
            let days = Int((hours / 24).rounded(.down))
            return "na ok. \(days) \(polishDays(days))"
        }
        return "na ok. \(Int(hours.rounded(.down))) godz."
    }

    /// "dzień" for 1, "dni" for every other count (2 dni, 5 dni, 22 dni).
    public static func polishDays(_ count: Int) -> String {
        count == 1 ? "dzień" : "dni"
    }

    /// One decimal only below 10 U and only when there is one (8,5 j, 6 j); whole units above.
    public static func units(_ value: Double) -> String {
        let tenths = (value * 10).rounded() / 10
        guard value < 10, tenths != tenths.rounded() else { return String(Int(value.rounded())) }
        return String(format: "%.1f", tenths).replacingOccurrences(of: ".", with: ",")
    }

    /// "0,3", "0,25", "3" (doses on the chart: up to two decimals, as the pump steps and everywhere else in the app).
    public static func dose(_ units: Double) -> String {
        RemoteCommandFormat.units(units)
    }

    /// "1,85" (insulin on board, two decimals like the loop apps).
    public static func iob(_ units: Double) -> String {
        String(format: "%.2f", units).replacingOccurrences(of: ".", with: ",")
    }

    private static let shortDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter
    }()

    /// "od 16 paź, 09:10"
    public static func since(_ date: Date) -> String {
        "od \(shortDate.string(from: date).replacingOccurrences(of: ".", with: ""))"
    }
}

enum DashboardDate {
    static func parse(_ value: String) -> Date? {
        ServerDate.parse(value)
    }
}
