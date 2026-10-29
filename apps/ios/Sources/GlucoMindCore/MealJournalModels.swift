import Foundation

/// The Meals tab (meal-journal): meals from the chat and Bolus tab boluses with a reminder, nothing else. Nobody is
/// asked to describe a meal after the fact.

/// A reminder of a meal: the WBT, a second dose ("Przypomnij" in the Bolus tab) or a planned part of a split bolus.
public struct MealJournalReminder: Decodable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case wbt = "WBT"
        case secondDose = "SECOND_DOSE"
        case plannedPart = "PLANNED_PART"
        /// A kind this build does not know yet: shown as a plain reminder rather than failing the whole page.
        case unknown

        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    public enum Status: String, Decodable, Sendable {
        case waiting = "WAITING"
        case dueNow = "DUE_NOW"
        case sent = "SENT"
        case expired = "EXPIRED"
        case off = "OFF"
        case given = "GIVEN"
        /// WBT only: switched on (protein or fat added) long after its time; no push came (audit 2026-10-26).
        case missed = "MISSED"
        /// A state this build does not know yet: shown without a switch rather than failing the whole page.
        case unknown

        public init(from decoder: Decoder) throws {
            self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    /// "wbt" for the WBT reminder, else the reminder's or the part's id.
    public let id: String
    public let kind: Kind
    /// AFTER_MINUTES, GLUCOSE_RISING, or a planned part's trigger.
    public let trigger: String?
    public let due_at: String
    public let wait_until: String?
    public let status: Status
    public let enabled: Bool
    public var fired_at: String? = nil
    /// Why it never came, said under it on the meal's page ("Przypomnienie o WBT minęło — sprawdź, …"); nil otherwise.
    public var note: String? = nil

    public var dueDate: Date? { ServerDate.parse(due_at) }
    public var waitUntilDate: Date? { wait_until.flatMap(ServerDate.parse) }
    public var isRising: Bool { trigger == "GLUCOSE_RISING" }
    /// Still to come: the switch can turn it off.
    public var isPending: Bool { status == .waiting }

    public var title: String {
        switch kind {
        case .wbt: return "WBT"
        case .secondDose: return isRising ? "Druga dawka, gdy zacznie rosnąć" : "Druga dawka"
        case .plannedPart: return "Druga część bolusa"
        case .unknown: return "Przypomnienie"
        }
    }
}

public struct MealJournalItem: Decodable, Equatable, Identifiable, Sendable {
    public enum Source: String, Decodable, Sendable {
        case chat = "CHAT"
        case bolusScreen = "BOLUS_SCREEN"
        /// Also a source this build does not know yet (the meal still shows).
        case other = "OTHER"

        public init(from decoder: Decoder) throws {
            self = Source(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public let meal_id: String
    public let started_at: String
    /// The description; nil for a Bolus tab meal (named by its carbs and insulin).
    public let title: String?
    public let carbs_g: Double?
    public let insulin_total_u: Double?
    public let source: Source
    public let conversation_id: String?
    public let has_macros: Bool
    public let reminders: [MealJournalReminder]
    /// Search results only: the glucose within 4 h of the start.
    public var glucose_peak_mgdl: Double? = nil
    public var glucose_min_mgdl: Double? = nil

    public var id: String { meal_id }
    public var startedDate: Date? { ServerDate.parse(started_at) }

    /// "Pizza margherita", or "Nowy posiłek" until it is described (its carbs and insulin are on the line below).
    public var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        return "Nowy posiłek"
    }

    /// "13:10 · 60 g · 7,2 j razem · z czatu", "18:05 · zakładka Bolus · 2 przypomnienia".
    public func subtitle(timeZone: TimeZone = .current) -> String {
        var parts: [String] = []
        if let start = startedDate { parts.append(MealJournalFormat.clock(start, timeZone: timeZone)) }
        if title != nil {
            if let carbs = carbs_g { parts.append("\(MealJournalFormat.number(carbs)) g") }
            if let insulin = insulin_total_u, insulin > 0 { parts.append("\(MealJournalFormat.number(insulin)) j razem") }
        }
        switch source {
        case .chat: parts.append("z czatu")
        case .bolusScreen: parts.append("zakładka Bolus")
        case .other: break
        }
        let shown = reminders.filter { $0.status != .off }
        if title == nil, !shown.isEmpty {
            parts.append(shown.count == 1 ? (shown[0].kind == .wbt ? "WBT" : "przypomnienie") : "\(shown.count) przypomnienia")
        }
        return parts.joined(separator: " · ")
    }

    /// Search: "szczyt 212 · najniżej 118".
    public var glucoseRange: String? {
        let parts = [glucose_peak_mgdl.map { "szczyt \(Int($0.rounded()))" }, glucose_min_mgdl.map { "najniżej \(Int($0.rounded()))" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public struct MealJournalResponse: Decodable, Equatable {
    public let patient_id: String
    public let items: [MealJournalItem]
    public let next_before: String?
}

public struct MealSearchResponse: Decodable, Equatable {
    public let patient_id: String
    public let query: String
    public let items: [MealJournalItem]
}

public struct MealOverview: Decodable, Equatable {
    /// A CGM reading: the server sends {observed_at, glucose_mgdl} (as the meal timeline does); {at, value} is read too.
    public struct Reading: Decodable, Equatable {
        public let at: String
        public let value: Double
        public var date: Date? { ServerDate.parse(at) }

        private enum CodingKeys: String, CodingKey { case at, value, observed_at, glucose_mgdl }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            at = try container.decodeIfPresent(String.self, forKey: .observed_at) ?? container.decode(String.self, forKey: .at)
            value = try container.decodeIfPresent(Double.self, forKey: .glucose_mgdl) ?? container.decode(Double.self, forKey: .value)
        }
    }

    public struct Bolus: Decodable, Equatable {
        public let at: String
        public let insulin_u: Double?
        public let carbs_g: Double?
        /// MEAL, WBT, PART or OTHER.
        public let kind: String
        /// GLUCOMIND or LOOP.
        public let source: String?
        public let author_name: String?
        public var date: Date? { ServerDate.parse(at) }

        /// "Mellis · Ewa" or the loop's name ("Trio", "Loop") for a dose entered in the loop.
        public func detail(loopSystem: LoopSystemKind) -> String {
            let place = source == "GLUCOMIND" ? "Mellis" : loopSystem.names.nominative
            return [place, author_name].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// Insulin given by hand since the meal's bolus (another phone, Trio): shown next to a reminder that has come.
    public struct GivenSince: Decodable, Equatable {
        public struct Dose: Decodable, Equatable {
            public let at: String
            public let insulin_u: Double
            public let by: String
        }

        public let since: String
        public let total_u: Double
        public let doses: [Dose]
        /// "⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa)."; nothing given: "Żaden z opiekunów nie podał jeszcze tej dawki."
        /// with several caregivers, else empty.
        public let line: String

        public var anyGiven: Bool { !doses.isEmpty }
    }

    // The server also sends the meal's status, trust, revision, photo flag and a merged timeline: the page does not
    // show them (the edit sheet reads the full meal), so they are not decoded.
    public let item: MealJournalItem
    public let description: String?
    public let macros: MealMacros?
    public let glucose: [Reading]
    public let boluses: [Bolus]
    /// Boluses on no meal (given without "Zapisz jako posiłek", or from Trio) in the chart's window: drawn beside the
    /// meal's own, not counted in its insulin (absent on older servers).
    public let other_boluses: [Bolus]
    public let given_since_start: GivenSince?
    /// Carbs removed beyond the later parts: the insulin given was too much (audit 2026-10-26; absent on older servers).
    public let dose_excess: DoseExcess?

    public struct DoseExcess: Decodable, Equatable {
        public let grams: Int
        public let insulin_u: Double?
        /// "Posiłek zmniejszono o 10 g więcej, niż zostało w kolejnych częściach bolusa: …"
        public let message: String
    }

    public init(from decoder: Decoder) throws {
        item = try MealJournalItem(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        macros = try? container.decodeIfPresent(MealMacros.self, forKey: .macros)
        // The chart is extra: readings it cannot read leave it empty, never the whole page unreadable.
        glucose = (try? container.decodeIfPresent([Reading].self, forKey: .glucose)) ?? []
        boluses = (try? container.decodeIfPresent([Bolus].self, forKey: .boluses)) ?? []
        other_boluses = (try? container.decodeIfPresent([Bolus].self, forKey: .other_boluses)) ?? []
        given_since_start = try? container.decodeIfPresent(GivenSince.self, forKey: .given_since_start)
        dose_excess = try? container.decodeIfPresent(DoseExcess.self, forKey: .dose_excess)
    }

    private enum CodingKeys: String, CodingKey {
        case description, macros, glucose, boluses, other_boluses, given_since_start, dose_excess
    }

    public var peakGlucose: Double? { glucose.map(\.value).max() }
}

public struct MealOverviewResponse: Decodable, Equatable {
    public let patient_id: String
    public let overview: MealOverview
}

public struct MealReminderToggleResponse: Decodable, Equatable {
    public let patient_id: String
    public let item: MealJournalItem
}

struct MealReminderToggleRequest: Encodable {
    let enabled: Bool
}

/// When the journal's meals of a range started (the calendar's dots).
public struct MealJournalDaysResponse: Decodable, Equatable, Sendable {
    public let starts: [String]
}

public protocol MealJournalAPI {
    func listMealJournal(patientID: String, before: String?, after: String?, limit: Int) async throws -> MealJournalResponse
    func listMealJournalDays(patientID: String, from: String, to: String) async throws -> MealJournalDaysResponse
    func searchMeals(patientID: String, query: String) async throws -> MealSearchResponse
    func getMealOverview(patientID: String, mealID: String) async throws -> MealOverviewResponse
    func setMealReminder(patientID: String, mealID: String, reminderID: String, enabled: Bool) async throws -> MealReminderToggleResponse
}

/// Formatters made once per format and time zone: making one is costly, and a list of meals formats many times as
/// it scrolls. Used under one lock (a formatter is not safe to share across threads).
private enum PolishFormatters {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var dates: [String: DateFormatter] = [:]
    nonisolated(unsafe) private static let numbers: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        return formatter
    }()

    static func string(_ date: Date, format key: String, timeZone: TimeZone, setUp: (DateFormatter) -> Void) -> String {
        lock.lock()
        defer { lock.unlock() }
        let id = "\(key)|\(timeZone.identifier)"
        let formatter = dates[id] ?? {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "pl_PL")
            formatter.timeZone = timeZone
            setUp(formatter)
            dates[id] = formatter
            return formatter
        }()
        return formatter.string(from: date)
    }

    static func number(_ value: Double) -> String {
        lock.lock()
        defer { lock.unlock() }
        return numbers.string(from: NSNumber(value: value)) ?? String(value)
    }
}

public enum MealJournalFormat {
    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        PolishFormatters.string(date, format: "HH:mm", timeZone: timeZone) { $0.dateFormat = "HH:mm" }
    }

    /// "4,5", "45", "0,25".
    public static func number(_ value: Double) -> String {
        PolishFormatters.number(value)
    }

    /// "23 października".
    public static func shortDay(_ day: Date, calendar: Calendar = .current) -> String {
        PolishFormatters.string(day, format: "dMMMM", timeZone: calendar.timeZone) { $0.setLocalizedDateFormatFromTemplate("dMMMM") }
    }

    /// "Dziś", "Wczoraj", "Piątek, 24 października".
    public static func dayTitle(_ day: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Dziś" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) { return "Wczoraj" }
        let label = PolishFormatters.string(day, format: "EEEEdMMMM", timeZone: calendar.timeZone) { $0.setLocalizedDateFormatFromTemplate("EEEEdMMMM") }
        return label.prefix(1).uppercased() + label.dropFirst()
    }
}

/// A meal's time line on the Meals tab, in the bolus card's design (CardDoseTimeline): its boluses and carb entries,
/// then its reminders, each with its state and "Wyłącz" / "Włącz" while it can still come.
public enum MealJournalTimeline {
    public static func steps(item: MealJournalItem, boluses: [MealOverview.Bolus]? = nil, loopSystem: LoopSystemKind, now: Date = Date(), timeZone: TimeZone = .current) -> [CardTimelineStep] {
        let clock = { (date: Date) in MealJournalFormat.clock(date, timeZone: timeZone) }
        var steps: [CardTimelineStep] = []
        if let boluses, !boluses.isEmpty {
            for (index, bolus) in boluses.enumerated() {
                steps.append(entryStep(id: "bolus-\(index)", time: bolus.date.map(clock) ?? "", insulin: bolus.insulin_u, carbs: bolus.carbs_g, kind: bolus.kind, note: bolus.detail(loopSystem: loopSystem), loopSystem: loopSystem))
            }
        } else {
            // The list has no bolus list: the meal's start with its totals.
            steps.append(entryStep(id: "start", time: item.startedDate.map(clock) ?? "", insulin: item.insulin_total_u, carbs: item.carbs_g, kind: "MEAL", note: nil, loopSystem: loopSystem))
        }
        for reminder in item.reminders {
            steps.append(reminderStep(reminder, mealID: item.meal_id, hasMacros: item.has_macros, now: now, clock: clock))
        }
        return steps
    }

    /// Still to come or come just now: the tile on the list opens with its time line unfolded.
    public static func isOpen(_ item: MealJournalItem) -> Bool {
        item.reminders.contains { $0.status == .waiting || $0.status == .dueNow }
    }

    private static func entryStep(id: String, time: String, insulin: Double?, carbs: Double?, kind: String, note: String?, loopSystem: LoopSystemKind) -> CardTimelineStep {
        let carbsText = carbs.flatMap { $0 > 0 ? "\(MealJournalFormat.number($0)) g" : nil }
        guard let insulin, insulin > 0 else {
            // Carbs alone are an entry for the loop, not a dose.
            return CardTimelineStep(id: id, time: time, detail: "Wpis \(carbsText ?? "0 g") do \(loopSystem.names.genitive)", note: note ?? "bez insuliny", state: .done, isWbt: false, actionTitle: nil, action: nil, symbol: "square.and.pencil")
        }
        let units = "\(MealJournalFormat.number(insulin)) j"
        let detail = [kind == "WBT" ? "WBT \(units)" : kind == "PART" ? "Druga część \(units)" : units, carbsText].compactMap { $0 }.joined(separator: " · ")
        return CardTimelineStep(id: id, time: time, detail: detail, note: note, state: .done, isWbt: kind == "WBT", actionTitle: nil, action: nil)
    }

    private static func reminderStep(_ reminder: MealJournalReminder, mealID: String, hasMacros: Bool, now: Date, clock: (Date) -> String) -> CardTimelineStep {
        let due = reminder.dueDate
        let time: String
        if reminder.isRising, reminder.status == .waiting || reminder.status == .expired || reminder.status == .off {
            time = "gdy rośnie"
        } else {
            time = (reminder.fired_at.flatMap(ServerDate.parse) ?? due).map(clock) ?? ""
        }
        let detail: String
        switch reminder.kind {
        case .wbt: detail = hasMacros ? "WBT" : "WBT: dawka przy przypomnieniu"
        case .secondDose: detail = "Druga dawka"
        case .plannedPart: detail = "Druga część bolusa"
        case .unknown: detail = reminder.title
        }
        let state: CardTimelineStep.State
        let note: String
        switch reminder.status {
        case .waiting:
            state = .planned
            if reminder.isRising, let until = reminder.waitUntilDate { note = "przypomnienie, gdy glukoza zacznie rosnąć, do \(clock(until))" }
            else { note = due.map { "przypomnienie o \(clock($0))" } ?? "przypomnienie" }
        case .dueNow, .sent:
            state = .due
            note = "przypomnienie przyszło"
        case .given:
            state = .done
            note = "podano"
        case .expired:
            state = .off
            note = reminder.isRising ? "glukoza nie wzrosła w ciągu 1 h" : reminder.kind == .wbt && reminder.note != nil ? "nie wysłano (przerwa serwera)" : "wygasło"
        case .missed:
            state = .off
            note = "minęło, sprawdź, czy WBT jest potrzebne"
        case .off:
            state = .off
            note = "wyłączone"
        case .unknown:
            state = .off
            note = "przypomnienie"
        }
        let canTurnOn = reminder.status == .off && (reminder.isRising ? (reminder.waitUntilDate.map { $0 > now } ?? false) : (due.map { $0 > now } ?? false))
        let canSwitch = reminder.status == .waiting || canTurnOn
        return CardTimelineStep(
            id: "reminder-\(reminder.id)", time: time, detail: detail, note: note, state: state, isWbt: reminder.kind == .wbt,
            actionTitle: canSwitch ? (reminder.status == .waiting ? "Wyłącz" : "Włącz") : nil,
            action: canSwitch ? .setMealReminder(mealID: mealID, reminderID: reminder.id, enabled: reminder.status != .waiting) : nil,
            symbol: reminder.kind == .secondDose && reminder.isRising && reminder.status == .waiting ? "arrow.up.right.circle.fill" : nil
        )
    }
}

/// The "Przypomnij o WBT" switch on a meal's page: on while the reminder is to come (or came), offered until 2.5 h
/// after the meal, after that only what happened to it.
public struct MealWbtReminderState: Equatable {
    public static let delay: TimeInterval = 150 * 60

    public let isOn: Bool
    public let canSwitch: Bool
    public let note: String?

    public init(reminder: MealJournalReminder?, mealStart: Date?, now: Date) {
        let due = reminder?.dueDate ?? mealStart.map { $0.addingTimeInterval(Self.delay) }
        let at = due.map { "o \(MealJournalFormat.clock($0)) · 2,5 h po posiłku" }
        switch reminder?.status {
        case .waiting?:
            (isOn, canSwitch, note) = (true, true, at)
        case .dueNow?, .sent?:
            let fired = reminder?.fired_at.flatMap(ServerDate.parse) ?? due
            (isOn, canSwitch, note) = (true, false, fired.map { "Przypomnienie przyszło o \(MealJournalFormat.clock($0))" })
        case .given?:
            (isOn, canSwitch, note) = (false, false, "WBT podane")
        case .expired?:
            (isOn, canSwitch, note) = (false, false, reminder?.note ?? "Przypomnienie wygasło")
        case .missed?:
            // Protein or fat came after the time had long passed: no push, the caregiver checks.
            (isOn, canSwitch, note) = (false, false, reminder?.note ?? "Przypomnienie o WBT minęło — sprawdź, czy WBT jest jeszcze potrzebne.")
        case .unknown?:
            // Not a state the switch can act on: nothing is offered.
            (isOn, canSwitch, note) = (false, false, nil)
        case .off?, nil:
            if let due, due > now {
                (isOn, canSwitch, note) = (false, true, at)
            } else {
                (isOn, canSwitch, note) = (false, false, "Minęło już 2,5 h od posiłku")
            }
        }
    }
}
