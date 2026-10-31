import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// The glucose Live Activity's content, as the server pushes it (live-activity.v1,
/// modules/live-activity/application/live-activity-state.ts: the keys must match). Times are seconds since 1970.
public struct GlucoseActivityState: Codable, Hashable, Sendable {
    public var glucose: Int?
    public var direction: String?
    public var delta: Int?
    public var readingAt: Double?
    public var iob: Double?
    public var cob: Double?
    public var reservoir: Double?
    public var reservoirFull: Double?
    /// The server's reservoir colour ("normal", "warning", "alarm") and the hours the insulin lasts (reservoir-level.v1);
    /// nil from an older server (the fixed thresholds apply).
    public var reservoirLevel: String?
    public var reservoirHoursLeft: Double?
    public var battery: Double?
    public var siteChangedAt: Double?
    public var sensorStartedAt: Double?
    /// The last 2 h, [seconds since 1970, mg/dL].
    public var readings: [[Double]]
    /// Boluses of the last 2 h, [seconds since 1970, units].
    public var boluses: [[Double]]
    /// "Dynamic Island": true = "Glukoza i IOB" in the compact island, false = "Sama glukoza" (nil from an older
    /// server = with IOB). The server keeps it as island_enabled.
    public var islandEnabled: Bool?
    /// The patient the fields above belong to (two-patient activities, migration 094); nil: the activity's attributes.
    public var patientID: String?
    public var patientName: String?
    /// The second patient of a two-patient activity; nil or empty with one patient.
    public var others: [GlucoseActivityPatient]?
    /// Two patients: "both" or "closer" (LiveIslandMode); nil = "both".
    public var islandMode: String?
    /// "both": the id of the patient on the left of the island.
    public var islandLeft: String?

    public init(glucose: Int?, direction: String?, delta: Int?, readingAt: Double?, iob: Double?, cob: Double?, reservoir: Double?,
                reservoirFull: Double?, battery: Double?, siteChangedAt: Double?, sensorStartedAt: Double?, readings: [[Double]], boluses: [[Double]],
                islandEnabled: Bool? = nil, patientID: String? = nil, patientName: String? = nil, others: [GlucoseActivityPatient]? = nil,
                islandMode: String? = nil, islandLeft: String? = nil,
                reservoirLevel: String? = nil, reservoirHoursLeft: Double? = nil) {
        self.glucose = glucose
        self.direction = direction
        self.delta = delta
        self.readingAt = readingAt
        self.iob = iob
        self.cob = cob
        self.reservoir = reservoir
        self.reservoirFull = reservoirFull
        self.reservoirLevel = reservoirLevel
        self.reservoirHoursLeft = reservoirHoursLeft
        self.battery = battery
        self.siteChangedAt = siteChangedAt
        self.sensorStartedAt = sensorStartedAt
        self.readings = readings
        self.boluses = boluses
        self.islandEnabled = islandEnabled
        self.patientID = patientID
        self.patientName = patientName
        self.others = others
        self.islandMode = islandMode
        self.islandLeft = islandLeft
    }

    /// The same content from the dashboard the app has read (the activity it starts itself shows it at once).
    public init(dashboard: DashboardResponse, now: Date, islandEnabled: Bool = true) {
        let from = now.addingTimeInterval(-2 * 3_600).timeIntervalSince1970
        self.init(
            glucose: dashboard.glucose?.value,
            direction: dashboard.glucose?.direction,
            delta: dashboard.glucose?.delta,
            readingAt: dashboard.glucose?.observedAt?.timeIntervalSince1970,
            iob: dashboard.loop?.iob_units,
            cob: dashboard.loop?.cob_grams,
            reservoir: dashboard.pump?.reservoir_units,
            reservoirFull: dashboard.pump?.reservoir_full_units,
            battery: dashboard.pump?.battery_percent,
            siteChangedAt: dashboard.siteChangedAt?.timeIntervalSince1970,
            sensorStartedAt: dashboard.sensorStartedAt?.timeIntervalSince1970,
            readings: dashboard.readings.compactMap { reading in
                guard let at = DashboardDate.parse(reading.at)?.timeIntervalSince1970, at >= from else { return nil }
                return [at, Double(reading.value)]
            },
            boluses: (dashboard.insulin?.boluses ?? []).compactMap { dose in
                guard let at = DashboardDate.parse(dose.at)?.timeIntervalSince1970, at >= from, dose.units > 0 else { return nil }
                return [at, dose.units]
            },
            islandEnabled: islandEnabled,
            reservoirLevel: dashboard.pump?.reservoir_level,
            reservoirHoursLeft: dashboard.pump?.reservoir_hours_left
        )
    }

    public var islandShowsIOB: Bool { islandEnabled ?? true }

    public var mode: LiveIslandMode { islandMode.flatMap(LiveIslandMode.init(rawValue:)) ?? .both }

    /// The patients shown, the first one first (its id and name from the state when the server sent them, else from the
    /// activity's attributes); one or two.
    public func patients(attributesID: String, attributesName: String) -> [LivePatientGlance] {
        let first = LivePatientGlance(
            id: patientID ?? attributesID, name: patientName ?? attributesName,
            glucose: glucose, direction: direction, delta: delta, readingAt: readingAt, iob: iob
        )
        return [first] + (others ?? []).prefix(1).map(LivePatientGlance.init)
    }

    /// The same content with another patient's dashboard as the second patient (the app builds it for an activity it
    /// starts or updates itself): no chart, as the server sends it.
    public func adding(second: GlucoseActivityPatient?, firstID: String, firstName: String, mode: LiveIslandMode, left: String?) -> GlucoseActivityState {
        guard let second else { return self }
        var state = self
        state.patientID = firstID
        state.patientName = firstName
        state.others = [second]
        state.readings = []
        state.boluses = []
        state.islandMode = mode.rawValue
        state.islandLeft = left.flatMap { [firstID.lowercased(), second.id.lowercased()].contains($0.lowercased()) ? $0 : nil } ?? firstID
        return state
    }

    public var readingDate: Date? { readingAt.map(Date.init(timeIntervalSince1970:)) }

    /// The newest reading of the patients shown (one or two).
    public var newestReadingDate: Date? {
        ([readingAt] + (others ?? []).map(\.readingAt)).compactMap { $0 }.max().map(Date.init(timeIntervalSince1970:))
    }

    /// The activity's stale date, as the server sends it: when the newest reading shown turns stale (StaleReading; each
    /// patient's half dims on its own). Always from this content, never an older activity's date.
    public var staleDate: Date? { StaleReading.staleDate(observedAt: newestReadingDate) }

    /// The equipment as the dashboard sees it (its thresholds and wording), from the raw values in the push.
    public func equipment(now: Date) -> [DashboardGlance.EquipmentItem] {
        let iso = ISO8601DateFormatter()
        let pump = (reservoir != nil || battery != nil)
            ? DashboardPump(battery_percent: battery, reservoir_units: reservoir, reservoir_full_units: reservoirFull,
                            reservoir_hours_left: reservoirHoursLeft, reservoir_level: reservoirLevel, last_read_at: iso.string(from: now))
            : nil
        let dashboard = DashboardResponse(
            patient_id: "",
            generated_at: iso.string(from: now),
            glucose: nil,
            readings: [],
            time_in_range: nil,
            pump: pump,
            site_changed_at: siteChangedAt.map { iso.string(from: Date(timeIntervalSince1970: $0)) },
            sensor_started_at: sensorStartedAt.map { iso.string(from: Date(timeIntervalSince1970: $0)) }
        )
        return DashboardGlance.equipment(dashboard, now: now)
    }
}

/// Another patient in a two-patient Live Activity (no chart: the two-patient layouts have none).
public struct GlucoseActivityPatient: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var glucose: Int?
    public var direction: String?
    public var delta: Int?
    public var readingAt: Double?
    public var iob: Double?

    public init(id: String, name: String, glucose: Int?, direction: String?, delta: Int?, readingAt: Double?, iob: Double?) {
        self.id = id
        self.name = name
        self.glucose = glucose
        self.direction = direction
        self.delta = delta
        self.readingAt = readingAt
        self.iob = iob
    }

    public init(id: String, name: String, dashboard: DashboardResponse) {
        self.init(
            id: id, name: name,
            glucose: dashboard.glucose?.value, direction: dashboard.glucose?.direction, delta: dashboard.glucose?.delta,
            readingAt: dashboard.glucose?.observedAt?.timeIntervalSince1970, iob: dashboard.loop?.iob_units
        )
    }
}

/// What the Dynamic Island shows with two patients (Ustawienia → Ekran blokady i Dynamic Island).
public enum LiveIslandMode: String, CaseIterable, Sendable {
    /// "Oboje": compact leading = one patient's glucose and arrow, trailing = the other's; no IOB.
    case both
    /// "Bliższe zagrożeniu": the patient closer to danger (LiveDanger), with IOB as with one patient.
    case closer
}

/// One patient as the two-patient layouts show them.
public struct LivePatientGlance: Equatable, Sendable {
    public var id: String
    public var name: String
    public var glucose: Int?
    public var direction: String?
    public var delta: Int?
    public var readingAt: Double?
    public var iob: Double?

    public init(id: String, name: String, glucose: Int?, direction: String?, delta: Int?, readingAt: Double?, iob: Double?) {
        self.id = id
        self.name = name
        self.glucose = glucose
        self.direction = direction
        self.delta = delta
        self.readingAt = readingAt
        self.iob = iob
    }

    init(_ patient: GlucoseActivityPatient) {
        self.init(id: patient.id, name: patient.name, glucose: patient.glucose, direction: patient.direction, delta: patient.delta,
                  readingAt: patient.readingAt, iob: patient.iob)
    }

    public var readingDate: Date? { readingAt.map(Date.init(timeIntervalSince1970:)) }

    /// No reading, or none for 15 min: greyed, without the trend (as with one patient).
    public func isOld(now: Date, activityStale: Bool = false) -> Bool {
        guard let readingDate else { return true }
        return activityStale || now.timeIntervalSince(readingDate) > LiveDanger.freshSeconds
    }

    public var colour: PatientColor { PatientColor.forPatient(id: id) }
}

/// "Bliższe zagrożeniu": which of two patients is closer to danger.
///
/// Each patient's glucose in 15 minutes is projected from the last change (`glucose + 3 × delta`, delta in mg/dL per 5
/// min; without a delta the glucose itself). Tiers, most urgent first:
/// 1. low: the current or the projected glucose under 70; the lower of the two values first;
/// 2. high: the current or the projected glucose over 250; the higher first;
/// 3. in range: the smaller margin first, margin = min(projected − 70, (250 − projected) / 2) (a step towards a low
///    counts twice as much as one towards a high);
/// 4. no fresh reading (none, or older than 15 min): last, since nothing is known.
/// A low always beats a high. A tie keeps the first patient (the caregiver's order), so the island does not flip.
public enum LiveDanger {
    public static let low = 70
    public static let high = 250
    public static let freshSeconds: TimeInterval = 15 * 60

    public enum Tier: Int, Comparable, Sendable {
        case low = 0, high, inRange, noData
        public static func < (a: Tier, b: Tier) -> Bool { a.rawValue < b.rawValue }
    }

    /// Lower is more urgent: the tier, then a value within it.
    public static func rank(_ patient: LivePatientGlance, now: Date) -> (tier: Tier, score: Double) {
        guard let glucose = patient.glucose, !patient.isOld(now: now) else { return (.noData, 0) }
        let current = Double(glucose)
        let projected = current + 3 * Double(patient.delta ?? 0)
        let lowest = min(current, projected)
        let highest = max(current, projected)
        if lowest < Double(low) { return (.low, lowest) }
        if highest > Double(high) { return (.high, -highest) }
        return (.inRange, min(projected - Double(low), (Double(high) - projected) / 2))
    }

    /// The patient closer to danger; the first on a tie.
    public static func closer(_ patients: [LivePatientGlance], now: Date) -> LivePatientGlance? {
        guard var best = patients.first else { return nil }
        var bestRank = rank(best, now: now)
        for patient in patients.dropFirst() {
            let candidate = rank(patient, now: now)
            if candidate.tier < bestRank.tier || (candidate.tier == bestRank.tier && candidate.score < bestRank.score) {
                best = patient
                bestRank = candidate
            }
        }
        return best
    }
}

/// "Oboje": which patient is on the left and which on the right of the island (the chosen left one, else the first).
public enum LiveIslandSides {
    public static func assign(_ patients: [LivePatientGlance], left: String?) -> (left: LivePatientGlance, right: LivePatientGlance?)? {
        guard let first = patients.first else { return nil }
        guard patients.count > 1 else { return (first, nil) }
        let second = patients[1]
        if let left, second.id.lowercased() == left.lowercased() { return (second, first) }
        return (first, second)
    }
}

#if canImport(ActivityKit) && os(iOS)
/// The glucose Live Activity (lock screen and Dynamic Island). The server starts it by this type's name
/// (LIVE_ACTIVITY_ATTRIBUTES_TYPE), so the name must not change.
public struct GlucoseActivityAttributes: ActivityAttributes {
    public typealias ContentState = GlucoseActivityState

    public var patientID: String
    public var patientName: String

    public init(patientID: String, patientName: String) {
        self.patientID = patientID
        self.patientName = patientName
    }
}
#endif

/// One change of the phone's Live Activity row on the server; fields left nil are not sent.
public struct LiveActivityChange: Equatable, Sendable {
    public enum Token: Equatable, Sendable {
        case set(String)
        case clear
    }

    public var enabled: Bool?
    public var islandEnabled: Bool?
    public var startToken: Token?
    public var activityID: Token?
    public var updateToken: Token?
    /// The patients shown, the path's patient first (1 or 2).
    public var patientIDs: [String]?
    public var islandMode: LiveIslandMode?
    public var islandLeftPatientID: Token?

    public init(enabled: Bool? = nil, islandEnabled: Bool? = nil, startToken: Token? = nil, activityID: Token? = nil, updateToken: Token? = nil,
                patientIDs: [String]? = nil, islandMode: LiveIslandMode? = nil, islandLeftPatientID: Token? = nil) {
        self.enabled = enabled
        self.islandEnabled = islandEnabled
        self.startToken = startToken
        self.activityID = activityID
        self.updateToken = updateToken
        self.patientIDs = patientIDs
        self.islandMode = islandMode
        self.islandLeftPatientID = islandLeftPatientID
    }

    public var body: [String: Any] {
        var body: [String: Any] = [:]
        if let enabled { body["enabled"] = enabled }
        if let islandEnabled { body["island_enabled"] = islandEnabled }
        if let patientIDs { body["patient_ids"] = patientIDs }
        if let islandMode { body["island_mode"] = islandMode.rawValue }
        for (key, token) in [("start_token", startToken), ("activity_id", activityID), ("update_token", updateToken), ("island_left_patient_id", islandLeftPatientID)] {
            switch token {
            case let .set(value): body[key] = value
            case .clear: body[key] = NSNull()
            case nil: break
            }
        }
        return body
    }
}
