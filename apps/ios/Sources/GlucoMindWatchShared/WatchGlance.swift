import Foundation

public struct WatchPatient: Codable, Hashable, Identifiable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// One patient's latest reading as the server's dashboard has it: everything a complication shows.
public struct WatchGlance: Codable, Equatable {
    public let patient: WatchPatient
    public let value: Int?
    /// Nightscout direction (SingleUp, FortyFiveDown, …), or from the delta when Nightscout sent none.
    public let direction: String?
    /// mg/dL per 5 minutes.
    public let delta: Int?
    public let observedAt: Date?
    public let iob: Double?
    public let cob: Double?
    /// The last hours of readings, oldest first (the rectangular complication's chart); nil from older caches.
    public let history: [WatchPoint]?

    public init(patient: WatchPatient, value: Int?, direction: String?, delta: Int?, observedAt: Date?, iob: Double?, cob: Double?,
                history: [WatchPoint]? = nil) {
        self.patient = patient
        self.value = value
        self.direction = direction
        self.delta = delta
        self.observedAt = observedAt
        self.iob = iob
        self.cob = cob
        self.history = history
    }
}

/// One reading of the chart.
public struct WatchPoint: Codable, Equatable {
    public let at: Date
    public let value: Int

    public init(at: Date, value: Int) {
        self.at = at
        self.value = value
    }
}

/// How a glance looks at a given moment: the dashboard's thresholds (DashboardThresholds) and reading-age rules, with no
/// words for the level: the number's colour, the arrow and, under 54, a filled shape say it (owner, 2026-11-03).
public struct WatchReading: Equatable {
    public enum Kind: Equatable {
        /// A current reading (up to 15 min old).
        case value
        /// Older than 15 min: the value greyed and struck through, a clock instead of the arrow.
        case stale
        /// No reading in the last hour (or none at all).
        case noData
    }

    public enum Level: Equatable {
        case urgentLow, low, inRange, high, veryHigh
    }

    public let kind: Kind
    public let value: Int?
    public let level: Level
    public let ageMinutes: Int?
    public let direction: String?
    public let delta: Int?
    public let iob: Double?
    public let cob: Double?

    public init(_ glance: WatchGlance, now: Date) {
        let age = glance.observedAt.map { max(0, Int(now.timeIntervalSince($0) / 60)) }
        value = glance.value
        ageMinutes = age
        // "It is falling now" stops being true well before the number turns old: at 13 min the direction and the change
        // go. A change measured across a missed reading looks like a faster one, so it goes too.
        let trendIsCurrent = (age ?? 0) <= Self.trendMinutes
        direction = trendIsCurrent ? glance.direction : nil
        delta = trendIsCurrent && !Self.lastStepHasGap(glance) ? glance.delta : nil
        iob = glance.iob
        cob = glance.cob
        level = glance.value.map(Self.level(of:)) ?? .inRange
        if glance.value == nil || age == nil || age! > 60 {
            kind = .noData
        } else if age! > 15 {
            kind = .stale
        } else {
            kind = .value
        }
    }

    static let trendMinutes = 12
    /// The readings come every 5 minutes; more than this before the newest one means one is missing.
    static let longestStep: TimeInterval = 7.5 * 60

    private static func lastStepHasGap(_ glance: WatchGlance) -> Bool {
        guard let history = glance.history, history.count > 1 else { return false }
        return history[history.count - 1].at.timeIntervalSince(history[history.count - 2].at) > longestStep
    }

    public static func level(of value: Int) -> Level {
        if value < 54 { return .urgentLow }
        if value < 70 { return .low }
        if value > 250 { return .veryHigh }
        if value > 180 { return .high }
        return .inRange
    }

    /// Under 54 and current: the filled background (the one shape the owner kept).
    public var isUrgent: Bool { kind == .value && level == .urgentLow }
    /// 11–15 min old: the age turns yellow.
    public var ageIsLate: Bool { kind == .value && (ageMinutes ?? 0) > 10 }
    public var isDoubleArrow: Bool { direction == "DoubleUp" || direction == "DoubleDown" }
    public var showsArrow: Bool { kind == .value && direction != nil }

    public var valueText: String { value.map(String.init) ?? "– –" }
    public var arrowText: String { GlucoseTrend.arrowCharacter(direction) ?? "" }
    /// "+4", "−5" (a real minus), "±0".
    public var deltaText: String? {
        guard let delta else { return nil }
        if delta > 0 { return "+\(delta)" }
        if delta < 0 { return "\u{2212}\(-delta)" }
        return "±0"
    }
    public var ageText: String { "\(ageMinutes ?? 0) min" }
    /// "−5 · 3 min", or only the age when there is no change to show.
    public var changeAndAgeText: String { [deltaText, ageText].compactMap { $0 }.joined(separator: " · ") }
    public var iobText: String? { iob.map { "\(WatchFormat.decimal($0, maxFractionDigits: 2)) j" } }
    public var cobText: String? { cob.map { "\(Int($0.rounded())) g" } }

    /// Degrees from "right": up is −90.
    public var arrowAngle: Double {
        switch direction {
        case "DoubleUp", "SingleUp": return -90
        case "FortyFiveUp": return -45
        case "FortyFiveDown": return 45
        case "DoubleDown", "SingleDown": return 90
        default: return 0
        }
    }

    /// The inline complication's sentence: "112 ↗ +4 · 3 min", "48‼ ⇊ −12 · 2 min", "◷ brak odczytu 23 min".
    public var inlineText: String {
        switch kind {
        case .noData: return "◷ brak odczytu"
        case .stale: return "◷ brak odczytu \(ageText)"
        case .value:
            let mark = isUrgent ? "‼" : ""
            let parts = ["\(valueText)\(mark)", arrowText, deltaText].compactMap { $0 }.filter { !$0.isEmpty }
            return parts.joined(separator: " ") + " · " + ageText
        }
    }

    /// One patient's part of the two-patient inline line: "112↗", "48⇊‼", "◷23 min", "brak".
    public var compactText: String {
        switch kind {
        case .noData: return "brak"
        case .stale: return "◷\(ageText)"
        case .value: return "\(valueText)\(arrowText)\(isUrgent ? "‼" : "")"
        }
    }
}

public enum WatchFormat {
    /// "1,4", "3,45", "0,65": Polish decimal comma, no trailing zeros.
    public static func decimal(_ value: Double, maxFractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = maxFractionDigits
        formatter.minimumIntegerDigits = 1
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Each patient's letter on a two-patient complication: the first letter, two when two patients start alike.
    public static func initials(_ patients: [WatchPatient]) -> [String: String] {
        var result: [String: String] = [:]
        let firsts = patients.map { String($0.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased() }
        for (index, patient) in patients.enumerated() {
            let clash = firsts.enumerated().contains { $0.offset != index && $0.element == firsts[index] }
            let trimmed = patient.name.trimmingCharacters(in: .whitespaces)
            result[patient.id] = clash ? String(trimmed.prefix(2)).capitalized : firsts[index]
        }
        return result
    }
}

/// When a complication redraws and reads again (the same rules as the phone's widget, HomeWidgetGlance).
public enum WatchTimeline {
    /// Now, then every minute until 20 min after the reading (the age and the stale look stay right without a network
    /// read), then once more at 61 min when it turns into "brak odczytu". Redraws cost no reload budget.
    public static func entryDates(_ glances: [WatchGlance], now: Date) -> [Date] {
        guard let observedAt = glances.compactMap(\.observedAt).max() else { return [now] }
        var ticks = (1...20).map { observedAt.addingTimeInterval(TimeInterval($0 * 60) + 1) }
        ticks.append(observedAt.addingTimeInterval(61 * 60 + 1))
        return [now] + ticks.filter { $0 > now }
    }

    /// Just after the next expected reading (every 5 min from the last, plus time for the upload), at least 4 min away:
    /// one read per reading, whose lateness does not carry over to the next one as a "5 min after this read" would.
    /// watchOS treats it as a wish; the server's WidgetKit push is what brings a new reading sooner.
    public static func nextReload(_ glances: [WatchGlance], now: Date) -> Date {
        guard let observedAt = glances.compactMap(\.observedAt).max() else { return now.addingTimeInterval(15 * 60) }
        let first = observedAt.addingTimeInterval(5 * 60 + 30)
        let earliest = now.addingTimeInterval(4 * 60)
        guard first < earliest else { return first }
        let missed = (earliest.timeIntervalSince(first) / (5 * 60)).rounded(.up)
        return first.addingTimeInterval(missed * 5 * 60)
    }
}

/// The last glance read per patient and the caregiver's patients, in this process's own defaults: shown (greyed by its
/// age) when the next read fails, and the patients the complication gallery offers.
public enum WatchCache {
    private static let defaults = UserDefaults.standard

    public static func save(_ glance: WatchGlance) {
        guard let data = try? JSONEncoder().encode(glance) else { return }
        defaults.set(data, forKey: "watch.glance.\(glance.patient.id.lowercased())")
    }

    public static func glance(patientID: String) -> WatchGlance? {
        defaults.data(forKey: "watch.glance.\(patientID.lowercased())").flatMap { try? JSONDecoder().decode(WatchGlance.self, from: $0) }
    }

    /// True when the list changed (the complication gallery should be rebuilt).
    @discardableResult
    public static func savePatients(_ patients: [WatchPatient]) -> Bool {
        let changed = ordered(patients) != self.patients
        if changed, let data = try? JSONEncoder().encode(patients) {
            defaults.set(data, forKey: "watch.patients")
        }
        return changed
    }

    /// The caregiver's patients: those of the phone's hand-over (the watch Keychain group, shared with the watch app,
    /// so the face editor lists every patient before any complication has read), else the last read.
    /// Always in one order: the phone and the server may list them differently, and a complication's name and its
    /// readings both come from a place in this list.
    public static var patients: [WatchPatient] {
        let listed: [WatchPatient]
        if let handed = WatchSession.credentialStore.load()?.patients, !handed.isEmpty {
            listed = handed.map { WatchPatient(id: $0.id, name: $0.name) }
        } else {
            listed = defaults.data(forKey: "watch.patients").flatMap { try? JSONDecoder().decode([WatchPatient].self, from: $0) } ?? []
        }
        return ordered(listed)
    }

    private static func ordered(_ patients: [WatchPatient]) -> [WatchPatient] {
        patients.sorted {
            let names = $0.name.localizedCaseInsensitiveCompare($1.name)
            return names == .orderedSame ? $0.id < $1.id : names == .orderedAscending
        }
    }

    public static func clear() {
        for patient in patients {
            defaults.removeObject(forKey: "watch.glance.\(patient.id.lowercased())")
        }
        defaults.removeObject(forKey: "watch.patients")
    }
}

/// Sample data for the simulator (GM_WIDGET_FIXTURES) and the complication gallery.
public enum WatchSample {
    public static let first = WatchPatient(id: "00000000-0000-0000-0000-00000000000a", name: "Ania")
    public static let second = WatchPatient(id: "00000000-0000-0000-0000-00000000000b", name: "Tomek")

    /// 2 h of 5-minute readings easing from `from` to `ending`, with a little wobble.
    public static func sampleHistory(ending: Int, at last: Date, from: Int) -> [WatchPoint] {
        (0..<24).map { i in
            let t = Double(i) / 23
            let value = Double(from) + (Double(ending) - Double(from)) * (t * t * (3 - 2 * t)) + 6 * sin(Double(i) * 0.9)
            return WatchPoint(at: last.addingTimeInterval(-Double(23 - i) * 300), value: i == 23 ? ending : Int(value))
        }
    }

    public static func glance(_ patient: WatchPatient = first, now: Date) -> WatchGlance {
        if patient == second {
            return WatchGlance(patient: patient, value: 87, direction: "FortyFiveDown", delta: -3, observedAt: now.addingTimeInterval(-4 * 60),
                               iob: 0.9, cob: 10, history: sampleHistory(ending: 87, at: now.addingTimeInterval(-4 * 60), from: 140))
        }
        return WatchGlance(patient: patient, value: 112, direction: "FortyFiveUp", delta: 4, observedAt: now.addingTimeInterval(-3 * 60),
                           iob: 1.4, cob: 18, history: sampleHistory(ending: 112, at: now.addingTimeInterval(-3 * 60), from: 160))
    }
}

#if DEBUG
public extension WatchSample {
    /// Every state the complications draw, for the simulator gallery (GM_WIDGET_FIXTURES).
    static func states(now: Date) -> [(label: String, glance: WatchGlance)] {
        func g(_ value: Int?, _ direction: String?, _ delta: Int?, age: Double?, iob: Double? = 1.4, cob: Double? = 18) -> WatchGlance {
            WatchGlance(patient: first, value: value, direction: direction, delta: delta,
                        observedAt: age.map { now.addingTimeInterval(-$0 * 60) }, iob: iob, cob: cob,
                        history: value.flatMap { v in age.map { sampleHistory(ending: v, at: now.addingTimeInterval(-$0 * 60), from: 150) } })
        }
        func gaps(_ value: Int, age: Double, missing: ClosedRange<Int>) -> WatchGlance {
            var glance = g(value, "Flat", 2, age: age)
            let history = (glance.history ?? []).enumerated().filter { !missing.contains($0.offset) }.map(\.element)
            glance = WatchGlance(patient: first, value: value, direction: "Flat", delta: 2, observedAt: glance.observedAt, iob: 1.4, cob: 18, history: history)
            return glance
        }
        return [
            ("w zakresie", g(112, "FortyFiveUp", 4, age: 3)),
            ("jeden brak", gaps(143, age: 4, missing: 11...11)),
            ("brak przed ostatnim", gaps(143, age: 4, missing: 22...22)),
            ("przerwa 20 min", gaps(143, age: 4, missing: 11...13)),
            ("przerwa 40 min", gaps(143, age: 4, missing: 10...16)),
            ("wysoko", g(214, "SingleUp", 7, age: 2, iob: 2.6, cob: 35)),
            ("powyżej 250", g(312, "FortyFiveUp", 12, age: 4, iob: 3.45, cob: 120)),
            ("nisko", g(64, "FortyFiveDown", -5, age: 1, iob: 0.8, cob: 0)),
            ("poniżej 54", g(48, "DoubleDown", -12, age: 2, iob: 0.65, cob: 0)),
            ("12 min", g(131, "Flat", 2, age: 12, iob: 1.1, cob: 4)),
            ("14 min", g(131, "FortyFiveDown", -6, age: 14, iob: 1.1, cob: 4)),
            ("stary", g(128, "Flat", 1, age: 23, iob: 1.0, cob: 4)),
            ("brak", g(nil, nil, nil, age: nil)),
        ]
    }
}
#endif
