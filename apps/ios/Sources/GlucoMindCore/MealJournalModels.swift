import Combine
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

    /// The action card's sentence when its moment came.
    public var dueTitle: String {
        switch kind {
        case .wbt: return "Czas na WBT"
        case .secondDose: return "Czas na drugą dawkę"
        case .plannedPart: return "Czas na drugą część bolusa"
        case .unknown: return "Przypomnienie przyszło"
        }
    }

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

    /// Not described yet (a Bolus tab dose saved as a meal): the tile offers "Opisz", the meal's chat.
    public var needsDescription: Bool {
        !has_macros && (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    /// Every dose for this meal in one line, its own and any on no meal in the 3 hours after it (review 2026-11-10: the
    /// 12:09 push said 0,6 j after 1,2 j): "Do tego posiłku: 0,7 j o 11:16 (Ewa) · 0,6 j o 11:54 · 0,6 j o 11:55. Razem
    /// 1,9 j." Nil with fewer than two doses (the list below says it).
    public var doseAxisLine: String? {
        guard let start = item.startedDate else { return nil }
        let end = start.addingTimeInterval(3 * 3600)
        let own = boluses.filter { ($0.insulin_u ?? 0) > 0 }
        let loose = other_boluses.filter { bolus in
            guard (bolus.insulin_u ?? 0) > 0, let at = bolus.date else { return false }
            return at >= start && at <= end
        }
        let doses = (own + loose).compactMap { bolus in bolus.date.map { (at: $0, units: bolus.insulin_u ?? 0, by: bolus.author_name) } }
            .sorted { $0.at < $1.at }
        guard doses.count >= 2 else { return nil }
        let total = doses.reduce(0) { $0 + $1.units }
        let listed = doses.count <= 4
            ? doses.map { dose in "\(LoopFormat.number(dose.units)) j o \(LoopFormat.clock(dose.at))\(dose.by.map { " (\($0))" } ?? "")" }.joined(separator: " · ") + ". "
            : ""
        return "Do tego posiłku: \(listed)Razem \(LoopFormat.number(total)) j w \(doses.count) dawkach."
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

        /// The line for the page's action card, which draws its own warning sign.
        public var cardLine: String {
            let text = line.replacingOccurrences(of: "⚠️", with: "").trimmingCharacters(in: .whitespaces)
            return anyGiven && !text.contains("Sprawdź") ? "\(text) Sprawdź, zanim podasz." : text
        }
    }

    // The server also sends the meal's status, trust, revision, photo flag and a merged timeline: the page does not
    // show them (the edit sheet reads the full meal), so they are not decoded.
    public let item: MealJournalItem
    /// The AI's 1–3 words for the page's title (absent on older servers and on meals it did not name).
    public let short_name: String?
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
        short_name = try? container.decodeIfPresent(String.self, forKey: .short_name)
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
        case short_name, description, macros, glucose, boluses, other_boluses, given_since_start, dose_excess
    }

    public var peakGlucose: Double? { glucose.map(\.value).max() }

    /// The lowest reading since the meal started (a low before it is not the meal's).
    public var lowestGlucose: Double? {
        guard let start = item.startedDate else { return glucose.map(\.value).min() }
        return glucose.filter { ($0.date ?? start) >= start }.map(\.value).min()
    }

    public var pageTitle: String {
        let name = (short_name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? item.displayTitle : name
    }

    /// The description under the title's short name; nil when it would only repeat the title.
    public var descriptionLine: String? {
        let text = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || text == pageTitle ? nil : text
    }

    /// Nothing known about the food yet: the page leads with "Opisz posiłek".
    public var isUndescribed: Bool {
        let text = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let anyMacro = macros.map { [$0.carbs.grams, $0.protein.grams, $0.fat.grams].contains { $0 != nil } } ?? false
        return text.isEmpty && !anyMacro
    }
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

/// "Scal" asked first (meal-merge.v1): what merging the selected meals would do, or why it cannot be done.
public struct MealMergePreview: Decodable, Equatable, Sendable {
    public struct Carbs: Decodable, Equatable, Sendable {
        public let kept_g: Double
        public let added_g: Double
        /// What the loop has for the kept meal ("a w Trio wpisano 20 g"); nil or 0: not said.
        public var loop_g: Double? = nil

        public init(kept_g: Double, added_g: Double, loop_g: Double? = nil) {
            self.kept_g = kept_g
            self.added_g = added_g
            self.loop_g = loop_g
        }

        /// The meal's carbs after the answer: included, the larger of the two; extra, their sum.
        public func result(_ choice: MealMergeCarbsChoice) -> Double {
            switch choice {
            case .included: max(kept_g, added_g)
            case .extra: kept_g + added_g
            }
        }
    }

    public enum Content: String, Decodable, Sendable {
        /// None of the meals has a description or values.
        case none = "NONE"
        /// One has them: the merged meal keeps them.
        case kept = "KEPT"
        /// Several have their own: they are reset and entered again.
        case reset = "RESET"
    }

    public let ok: Bool
    /// The meal the others join (it keeps its page).
    public var meal_id: String? = nil
    public var content: Content? = nil
    /// One of the meals has a later part or second dose still to come.
    public var split: Bool? = nil
    /// The kept meal has carbs of its own and the others would add some: the caregiver chooses.
    public var carbs: Carbs? = nil
    public var code: String? = nil
    /// Why it cannot be done, in the app's words.
    public var message: String? = nil
}

public struct MealMergePreviewResponse: Decodable, Equatable, Sendable {
    public let patient_id: String
    public let merge: MealMergePreview
}

/// "Usuń": the meal left the journal.
public struct MealDeleteResponse: Decodable, Equatable, Sendable {
    public let patient_id: String
    public let meal_id: String
}

/// "Zostaw podział" or "Nowy podział w czacie" for the one split meal of a merge.
public enum MealMergeSplitChoice: String, Encodable, Sendable {
    case keep = "KEEP"
    case resplit = "RESPLIT"
}

/// Whether the grams joining a meal were already counted in its carbs, or are extra.
public enum MealMergeCarbsChoice: String, Encodable, Sendable {
    case included = "INCLUDED"
    case extra = "EXTRA"
}

/// The words of the question in both places that ask it: the given card's "Do posiłku" and "Scal" in the Meals tab.
public struct MealMergeCarbsText: Equatable, Sendable {
    public let context: String
    public let question: String
    public let includedTitle: String
    public let includedResult: String
    public let extraTitle: String
    public let extraResult: String

    /// `loopLocative`: "Trio" or "Loopie"; `others`: how many entries join the meal.
    public init(_ carbs: MealMergePreview.Carbs, others: Int = 1, loopLocative: String) {
        let kept = Self.grams(carbs.kept_g)
        let added = Self.grams(carbs.added_g)
        // The entry is bigger than the meal: "already counted in" makes no sense, the meal simply has more.
        if carbs.added_g > carbs.kept_g {
            let entry = others == 1 ? "ten wpis ma \(added)" : "pozostałe wpisy mają razem \(added)"
            context = "Posiłek ma \(kept), a \(entry)."
            question = "Ile węglowodanów ma mieć posiłek?"
            includedTitle = "Razem \(Self.grams(carbs.result(.included)))"
            includedResult = "wpis obejmuje posiłek"
            extraTitle = "Razem \(Self.grams(carbs.result(.extra)))"
            extraResult = "to dwie różne rzeczy"
            return
        }
        if let loop = carbs.loop_g, loop > 0 {
            context = "Posiłek ma \(kept), a w \(loopLocative) wpisano \(Self.grams(loop))."
        } else {
            context = "Posiłek ma \(kept)."
        }
        question = "Czy te \(added) było już wliczone w \(kept)?"
        includedTitle = "Tak, wliczone"
        includedResult = "zostaje \(Self.grams(carbs.result(.included)))"
        extraTitle = "Nie, dodatkowe"
        extraResult = "razem \(Self.grams(carbs.result(.extra)))"
    }

    /// With a no-break space: the number and its unit never part at a line's end.
    public static func grams(_ value: Double) -> String {
        "\(MealJournalFormat.number(value))\u{00A0}g"
    }
}

struct MealMergeRequest: Encodable {
    let meal_ids: [String]
    var reset_confirmed: Bool? = nil
    var split: MealMergeSplitChoice? = nil
    var carbs: MealMergeCarbsChoice? = nil
}

public struct MealMergeResponse: Decodable, Equatable, Sendable {
    public let patient_id: String
    public let meal_id: String
    public let item: MealJournalItem
}

public protocol MealJournalAPI {
    func listMealJournal(patientID: String, before: String?, after: String?, limit: Int) async throws -> MealJournalResponse
    func listMealJournalDays(patientID: String, from: String, to: String) async throws -> MealJournalDaysResponse
    func searchMeals(patientID: String, query: String) async throws -> MealSearchResponse
    func getMealOverview(patientID: String, mealID: String) async throws -> MealOverviewResponse
    func setMealReminder(patientID: String, mealID: String, reminderID: String, enabled: Bool) async throws -> MealReminderToggleResponse
    func previewMealMerge(patientID: String, mealIDs: [String]) async throws -> MealMergePreviewResponse
    func mergeMeals(patientID: String, mealIDs: [String], resetConfirmed: Bool, split: MealMergeSplitChoice?, carbs: MealMergeCarbsChoice?) async throws -> MealMergeResponse
    func deleteMeal(patientID: String, mealID: String) async throws -> MealDeleteResponse
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

    /// A dose waits now: its reminder is due, or came within the last 3 hours and the dose was not given. The tile stays
    /// unfolded only then; an older unanswered reminder no longer asks for anything on the list.
    public static func isDue(_ item: MealJournalItem, now: Date = Date()) -> Bool {
        item.reminders.contains { reminder in
            switch reminder.status {
            case .dueNow:
                return true
            case .sent:
                let cameAt = reminder.fired_at.flatMap(ServerDate.parse) ?? reminder.dueDate
                return cameAt.map { now.timeIntervalSince($0) < 3 * 3_600 } ?? false
            default:
                return false
            }
        }
    }

    /// The one line a folded tile shows while a reminder is to come: "Następnie: druga dawka o 14:02".
    public static func nextLine(_ item: MealJournalItem, timeZone: TimeZone = .current) -> String? {
        let waiting = item.reminders.filter { $0.status == .waiting }
        guard let next = waiting.min(by: { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }) else { return nil }
        let name: String
        switch next.kind {
        case .wbt: name = "WBT"
        case .secondDose: name = "druga dawka"
        case .plannedPart: name = "druga część bolusa"
        case .unknown: name = next.title
        }
        if next.isRising { return "Następnie: \(name), gdy glukoza zacznie rosnąć" }
        guard let due = next.dueDate else { return "Następnie: \(name)" }
        return "Następnie: \(name) o \(MealJournalFormat.clock(due, timeZone: timeZone))"
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

/// One line of "Przebieg" on a meal's page: what was given, what waits and what is still to come. WBT's reminder, its
/// switch and its dose are one row.
public struct MealPageRow: Equatable, Identifiable {
    public let id: String
    public let title: String
    public let note: String?
    public let state: CardTimelineStep.State
    /// The reminder its switch saves; nil: nothing to switch.
    public var switchReminderID: String? = nil
    public var isOn = false
    /// Opens the planned part's card (where it can be given earlier or switched off).
    public var plannedPartID: String? = nil
    public var offersWbtDose = false
}

public enum MealPageProgress {
    public static func rows(_ overview: MealOverview, loopSystem: LoopSystemKind, now: Date = Date(), timeZone: TimeZone = .current) -> [MealPageRow] {
        let item = overview.item
        let clock = { (date: Date) in MealJournalFormat.clock(date, timeZone: timeZone) }
        let steps = MealJournalTimeline.steps(item: item, boluses: overview.boluses, loopSystem: loopSystem, now: now, timeZone: timeZone)
        var rows = steps.filter { !$0.id.hasPrefix("reminder-") }.map { step in
            let verb = step.symbol == nil ? "Podano" : "Zapisano"
            return MealPageRow(id: step.id, title: step.detail, note: ["\(verb) o \(step.time)", step.note].compactMap { $0 }.joined(separator: " · "), state: .done)
        }
        for reminder in item.reminders where reminder.kind != .wbt {
            // A part given is already on the list as its bolus.
            if reminder.status == .given, reminder.kind == .plannedPart, overview.boluses.contains(where: { $0.kind == "PART" }) { continue }
            guard let step = steps.first(where: { $0.id == "reminder-\(reminder.id)" }) else { continue }
            let opensCard = reminder.kind == .plannedPart && (reminder.status == .waiting || reminder.status == .dueNow)
            let canSwitch = !opensCard && step.action != nil
            rows.append(MealPageRow(
                id: step.id, title: step.detail, note: note(reminder, step: step, clock: clock), state: step.state,
                switchReminderID: canSwitch ? reminder.id : nil, isOn: reminder.status == .waiting,
                plannedPartID: opensCard ? reminder.id : nil
            ))
        }
        if let row = wbtRow(overview, now: now, clock: clock) { rows.append(row) }
        return rows
    }

    private static func note(_ reminder: MealJournalReminder, step: CardTimelineStep, clock: (Date) -> String) -> String? {
        let due = reminder.dueDate.map(clock)
        switch reminder.status {
        case .waiting:
            let condition = LaterTriggerText.condition(trigger: reminder.trigger ?? "", thresholdMgdl: nil)
            var line = condition.map { "Przypomnę, \($0)" } ?? due.map { "Przypomnę o \($0)" } ?? "Przypomnę"
            if reminder.kind == .plannedPart {
                line += ". Możesz ją podać wcześniej albo wyłączyć."
            } else if reminder.isRising, let until = reminder.waitUntilDate {
                line += ", do \(clock(until))"
            }
            return line
        case .dueNow:
            return "Czeka na podanie od \((reminder.fired_at.flatMap(ServerDate.parse) ?? reminder.dueDate).map(clock) ?? step.time)"
        case .sent:
            return "Przypomnienie przyszło o \(step.time)"
        default:
            return step.note.map { $0.prefix(1).uppercased() + $0.dropFirst() }
        }
    }

    private static func wbtRow(_ overview: MealOverview, now: Date, clock: (Date) -> String) -> MealPageRow? {
        let item = overview.item
        let reminder = item.reminders.first { $0.kind == .wbt }
        // Given: the dose is on the list as its bolus.
        if reminder?.status == .given, overview.boluses.contains(where: { $0.kind == "WBT" }) { return nil }
        let state = MealWbtReminderState(reminder: reminder, mealStart: item.startedDate, now: now)
        // Long after a meal without values or a reminder there is nothing to say about WBT.
        if reminder == nil, !state.canSwitch, !item.has_macros { return nil }
        let given = reminder?.status == .given
        let rowState: CardTimelineStep.State
        switch reminder?.status {
        case .waiting?: rowState = .planned
        case .dueNow?, .sent?: rowState = .due
        case .given?: rowState = .done
        default: rowState = .off
        }
        var note = state.note
        if state.canSwitch, let due = reminder?.dueDate ?? item.startedDate.map({ $0.addingTimeInterval(MealWbtReminderState.delay) }) {
            note = "\(state.isOn ? "Przypomnę" : "Mogę przypomnieć") o \(clock(due)), 2,5 h po posiłku."
        }
        if !item.has_macros, !given {
            let hint = overview.isUndescribed ? "Dawkę policzę, gdy opiszesz posiłek." : "Do policzenia dawki uzupełnij białko i tłuszcz."
            note = [note, hint].compactMap { $0 }.joined(separator: " ")
        }
        return MealPageRow(
            id: "wbt", title: "WBT", note: note, state: rowState,
            switchReminderID: state.canSwitch ? "wbt" : nil, isOn: state.isOn,
            offersWbtDose: item.has_macros && !given
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

// MARK: - Meal plan (meal-plan.v1)

public struct MealPlanItem: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let carbs_g: Double?
    public let protein_g: Double?
    public let fat_g: Double?
    public var id: String { name }

    public init(name: String, carbs_g: Double?, protein_g: Double? = nil, fat_g: Double? = nil) {
        self.name = name
        self.carbs_g = carbs_g
        self.protein_g = protein_g
        self.fat_g = fat_g
    }
}

/// A meal or a movement known ahead. It is not a meal record: it has no dose (computed when its page opens).
public struct MealPlanEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let plan_id: String
    public let kind: String
    public let title: String
    public let planned_at: String
    public let items: [MealPlanItem]
    /// PLANNED, SKIPPED or REMOVED.
    public let status: String
    public let lead_minutes: Int
    /// The bolus near the meal, while it can matter (absent on older servers).
    public var given: MealPlanGiven? = nil
    /// THIS_MEAL or OTHER: what a caregiver said about that bolus.
    public var dose_answer: String? = nil
    /// The server asked whether the meal was eaten.
    public var eaten_asked_at: String? = nil
    /// YES, PART, NO or UNKNOWN.
    public var eaten_answer: String? = nil
    /// Skipped by "Bez przypomnień do…".
    public var paused: Bool? = nil
    /// The portions a phone set, for both phones (absent: none yet, or an older server).
    public var plate: MealPlanStoredPlate? = nil
    /// The dishes were changed in the planned meal's chat.
    public var menu_changed: Bool? = nil

    public init(id: String, plan_id: String, kind: String, title: String, planned_at: String, items: [MealPlanItem], status: String = "PLANNED", lead_minutes: Int = 20) {
        self.id = id
        self.plan_id = plan_id
        self.kind = kind
        self.title = title
        self.planned_at = planned_at
        self.items = items
        self.status = status
        self.lead_minutes = lead_minutes
    }

    public var plannedDate: Date? { ServerDate.parse(planned_at) }
    public var isMeal: Bool { kind == "MEAL" }
    public var isSkipped: Bool { status == "SKIPPED" }

    /// The menu's grams; nil when the plan says nothing about them (a timetable without a menu).
    public func carbs() -> Int? {
        MealPlanPlate().carbs(of: self)
    }

    /// "Kotlet, ziemniaki · około 73 g"; a movement says when it is shown; a plan without a menu asks.
    public var rowSubtitle: String {
        if isSkipped { return isMeal ? "Pominięty" : "Pominięte" }
        if !isMeal { return "Przypomnę, jeśli cukier będzie niski" }
        let names = items.prefix(3).map(\.name).joined(separator: ", ")
        guard let carbs = carbs() else { return names.isEmpty ? "Bez jadłospisu" : names }
        return names.isEmpty ? "około \(carbs) g" : "\(names) · około \(carbs) g"
    }
}

public struct MealPlanListResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let entries: [MealPlanEntry]
}

public struct MealPlanGiven: Codable, Equatable, Sendable {
    public let insulin_u: Double
    public let at: String
    public var date: Date? { ServerDate.parse(at) }

    public init(insulin_u: Double, at: String) {
        self.insulin_u = insulin_u
        self.at = at
    }
}

/// An activity soon after a meal: its bolus works during the activity, so the page offers a smaller one.
public struct MealPlanMovementAhead: Equatable {
    public static let window: TimeInterval = 3 * 3_600
    public static let reduction = 0.25

    public let title: String
    public let minutes: Int

    public static func of(_ entry: MealPlanEntry, in entries: [MealPlanEntry]) -> MealPlanMovementAhead? {
        guard entry.isMeal, let planned = entry.plannedDate else { return nil }
        let next = entries
            .filter { !$0.isMeal && !$0.isSkipped && $0.status == "PLANNED" }
            .compactMap { movement in movement.plannedDate.map { (movement, $0.timeIntervalSince(planned)) } }
            .filter { $0.1 > 0 && $0.1 <= window }
            .min { $0.1 < $1.1 }
        return next.map { MealPlanMovementAhead(title: $0.0.title, minutes: Int($0.1 / 60)) }
    }

    /// "1 h 15 min", "40 min".
    public var timeLabel: String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest) min" }
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }

    /// Rounded down to the pump's 0,05 j, never up.
    public static func reduced(_ dose: Double) -> Double {
        (dose * (1 - reduction) * 20 + 1e-9).rounded(.down) / 20
    }
}

/// What the meal's page says about a bolus given near the meal. Never closes the meal on a guess: a bolus may be for
/// something else, so a caregiver says which.
public enum MealPlanDoseState: Equatable {
    case none
    case asks(MealPlanGiven)
    case forThisMeal(MealPlanGiven)
    case forSomethingElse(MealPlanGiven)

    public static func of(_ entry: MealPlanEntry) -> MealPlanDoseState {
        guard let given = entry.given else { return .none }
        switch entry.dose_answer {
        case "THIS_MEAL": return .forThisMeal(given)
        case "OTHER": return .forSomethingElse(given)
        default: return .asks(given)
        }
    }
}

public struct PatientNote: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// PLAN_RULE or FOOD.
    public let kind: String
    public let text: String
    public let food_name: String?
    /// NONE or HALF, for a food.
    public let portion: String?
    public let created_by_name: String?
    public let created_at: String

    public init(id: String, kind: String, text: String, food_name: String? = nil, portion: String? = nil, created_by_name: String? = nil, created_at: String = "2026-11-05T12:00:00Z") {
        self.id = id
        self.kind = kind
        self.text = text
        self.food_name = food_name
        self.portion = portion
        self.created_by_name = created_by_name
        self.created_at = created_at
    }

    /// The note about this food of a later menu; only suggests. The same word in another form still matches ("Buraczki",
    /// "buraczki na ciepło").
    public static func about(_ item: MealPlanItem, in notes: [PatientNote]) -> PatientNote? {
        let name = fold(item.name)
        return notes.first { note in
            guard note.kind == "FOOD", let food = note.food_name.map(fold), !food.isEmpty else { return false }
            return name.contains(food) || food.contains(name)
        }
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pl_PL")).trimmingCharacters(in: .whitespaces)
    }
}

public struct PatientNotesResponse: Codable, Equatable, Sendable {
    public let notes: [PatientNote]
}

public struct MealPlanEntryResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let entry: MealPlanEntry
}

/// One plan in Settings: its days, for "Usuń plan na 9–13 listopada".
public struct MealPlanSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let range: String

    public static func of(_ entries: [MealPlanEntry], calendar: Calendar = .polish) -> [MealPlanSummary] {
        let planned = entries.filter { $0.status == "PLANNED" }
        var order: [String] = []
        var days: [String: [Date]] = [:]
        for entry in planned {
            guard let date = ServerDate.parse(entry.planned_at) else { continue }
            if days[entry.plan_id] == nil { order.append(entry.plan_id) }
            days[entry.plan_id, default: []].append(date)
        }
        return order.compactMap { id in
            guard let first = days[id]?.min(), let last = days[id]?.max() else { return nil }
            return MealPlanSummary(id: id, range: range(first, last, calendar: calendar))
        }
    }

    private static func range(_ first: Date, _ last: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "d MMMM"
        if calendar.isDate(first, inSameDayAs: last) { return formatter.string(from: first) }
        if calendar.isDate(first, equalTo: last, toGranularity: .month) {
            return "\(calendar.component(.day, from: first))–\(formatter.string(from: last))"
        }
        return "\(formatter.string(from: first)) – \(formatter.string(from: last))"
    }
}

/// The calculator lowered this dose for low or falling glucose (not only for active insulin).
public struct MealPlanLoweredDose: Equatable {
    public let dose: Double
    /// Carbs / ICR, when higher: the whole dose, chosen with its warning.
    public let icrDose: Double?
    public let line: String

    public static func of(_ preview: RemoteCommandPreview?) -> MealPlanLoweredDose? {
        guard let calculation = preview?.dose_calculation, let reason = calculation.reason_code,
              ["FALLING", "BELOW_TARGET", "LOW_CARBS_FIRST", "LOOP_FORECAST_LOW"].contains(reason) else { return nil }
        let icr = calculation.icr_dose_u.flatMap { $0 > calculation.default_u ? $0 : nil }
        return MealPlanLoweredDose(dose: calculation.default_u, icrDose: icr, line: calculation.short_summary ?? calculation.summary)
    }
}

/// "Jadłospis kończy się w piątek, 13 listopada": on a plan's last day, so nobody counts on reminders after it.
public enum MealPlanEnd {
    public static func line(entries: [MealPlanEntry], selectedDay: Date, calendar: Calendar = .polish) -> String? {
        let dates = entries.filter { $0.isMeal && $0.status != "REMOVED" }.compactMap(\.plannedDate)
        guard let last = dates.max(), calendar.isDate(last, inSameDayAs: selectedDay) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "EEEE, d MMMM"
        return "Plan kończy się w dniu: \(formatter.string(from: last)). Po nim nie będzie przypomnień."
    }
}

public enum MealPlanDayText {
    /// "2026-11-09" as the start of that day here.
    public static func date(_ text: String, calendar: Calendar = .polish) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

/// What a plan's card can still promise: a meal whose hour has already passed today gets no reminder.
public enum MealPlanCardCount {
    public static func reminders(days: [ConversationMealPlanProposal.Day], clock: (ConversationMealPlanProposal.Entry) -> String?, now: Date, calendar: Calendar = .polish) -> Int {
        let today = calendar.dateComponents([.year, .month, .day], from: now)
        let todayText = String(format: "%04d-%02d-%02d", today.year ?? 0, today.month ?? 0, today.day ?? 0)
        let parts = calendar.dateComponents([.hour, .minute], from: now)
        let nowClock = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return days.reduce(0) { sum, day in
            guard day.date >= todayText else { return sum }
            return sum + day.entries.filter { entry in
                guard entry.kind == "MEAL" else { return false }
                guard day.date == todayText, let time = clock(entry) else { return true }
                return time > nowClock
            }.count
        }
    }

    /// "Włącz 4 przypomnienia: Ania".
    public static func title(count: Int, patientName: String?) -> String {
        let units = count % 10
        let tens = count % 100
        let noun = count == 1 ? "przypomnienie" : (2...4).contains(units) && !(12...14).contains(tens) ? "przypomnienia" : "przypomnień"
        let name = patientName?.trimmingCharacters(in: .whitespaces) ?? ""
        return "Włącz \(count) \(noun)\(name.isEmpty ? "" : ": \(name)")"
    }
}

public struct MealPlanPauseResponse: Codable, Equatable, Sendable {
    public let paused: Int?
    public let resumed: Int?
}

public struct MealPlanRemoveResponse: Codable, Equatable, Sendable {
    public let removed: Int
}

/// The plate as the server keeps it; one this app cannot read counts as none, so the entry still reads.
public struct MealPlanStoredPlate: Codable, Equatable, Sendable {
    public let value: MealPlanPlate?

    public init(_ value: MealPlanPlate?) { self.value = value }

    public init(from decoder: Decoder) throws {
        value = try? MealPlanPlate(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try value.encode(to: encoder)
    }
}

public protocol MealPlanAPI {
    func listMealPlan(patientID: String, from: String, to: String) async throws -> MealPlanListResponse
    /// The portions set on this phone, for both phones.
    func setMealPlanPlate(patientID: String, entryID: String, plate: MealPlanPlate) async throws -> MealPlanEntryResponse
    func setMealPlanEntryStatus(patientID: String, entryID: String, status: String) async throws -> MealPlanEntryResponse
    func setMealPlanDoseAnswer(patientID: String, entryID: String, answer: String?) async throws -> MealPlanEntryResponse
    func setMealPlanEatenAnswer(patientID: String, entryID: String, answer: String) async throws -> MealPlanEntryResponse
    func setMealPlanEntryTime(patientID: String, entryID: String, plannedAt: Date) async throws -> MealPlanEntryResponse
}

public extension MealPlanAPI {
    func setMealPlanPlate(patientID: String, entryID: String, plate: MealPlanPlate) async throws -> MealPlanEntryResponse {
        throw CancellationError()
    }

    func setMealPlanEntryTime(patientID: String, entryID: String, plannedAt: Date) async throws -> MealPlanEntryResponse {
        throw CancellationError()
    }

    func setMealPlanDoseAnswer(patientID: String, entryID: String, answer: String?) async throws -> MealPlanEntryResponse {
        throw CancellationError()
    }

    func setMealPlanEatenAnswer(patientID: String, entryID: String, answer: String) async throws -> MealPlanEntryResponse {
        throw CancellationError()
    }
}

/// What this caregiver changed about a planned meal's foods: a portion, or another food. Kept on the phone until the dose
/// is given; only the grams go on, to the Bolus tab.
public struct MealPlanPlate: Equatable, Sendable, Codable {
    public enum Portion: Equatable, Sendable, Codable {
        case whole, half, none
        case grams(Double)
    }

    public struct Food: Equatable, Sendable, Codable {
        public var portion: Portion = .whole
        /// Eaten instead of the menu's food.
        public var replacedBy: String?
        /// Another food has no grams of its own yet: the menu's grams say nothing about it.
        public var needsGrams: Bool {
            guard replacedBy != nil else { return false }
            if case .grams = portion { return false }
            return true
        }

        public init(portion: Portion = .whole, replacedBy: String? = nil) {
            self.portion = portion
            self.replacedBy = replacedBy
        }
    }

    public static let maxGrams: Double = 500

    private var foods: [String: Food] = [:]
    /// Foods the menu does not have.
    public private(set) var added: [MealPlanItem] = []

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case foods, added, smallerBeforeMovement, wholeFromICR
    }

    /// Every field may be missing: the server's empty plate (after a change from the chat) is a plate with nothing set.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        foods = try container.decodeIfPresent([String: Food].self, forKey: .foods) ?? [:]
        added = try container.decodeIfPresent([MealPlanItem].self, forKey: .added) ?? []
        smallerBeforeMovement = try container.decodeIfPresent(Bool.self, forKey: .smallerBeforeMovement) ?? false
        wholeFromICR = try container.decodeIfPresent(Bool.self, forKey: .wholeFromICR) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(foods, forKey: .foods)
        try container.encode(added, forKey: .added)
        try container.encode(smallerBeforeMovement, forKey: .smallerBeforeMovement)
        try container.encode(wholeFromICR, forKey: .wholeFromICR)
    }

    /// Chosen on the page: a smaller dose because an activity follows.
    public var smallerBeforeMovement = false
    /// Chosen on the page: carbs / ICR although the calculator lowered the dose, with its warning.
    public var wholeFromICR = false

    public var isEdited: Bool { !foods.isEmpty || !added.isEmpty || smallerBeforeMovement || wholeFromICR }

    public mutating func add(name: String, grams: Double) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        added.append(MealPlanItem(name: trimmed, carbs_g: min(max(0, grams), Self.maxGrams)))
    }

    public mutating func removeAdded(_ item: MealPlanItem) {
        added.removeAll { $0.name == item.name }
    }

    public func food(_ item: MealPlanItem) -> Food { foods[item.name] ?? Food() }

    public mutating func set(_ food: Food, for item: MealPlanItem) {
        foods[item.name] = food == Food() ? nil : food
    }

    /// The grams counted for one food; nil when neither the menu nor the caregiver gave any.
    public func carbs(of item: MealPlanItem) -> Double? {
        if food(item).needsGrams { return nil }
        switch food(item).portion {
        case .whole: return item.carbs_g
        case .half: return item.carbs_g.map { $0 / 2 }
        case .none: return 0
        case let .grams(grams): return min(max(0, grams), Self.maxGrams)
        }
    }

    /// The first food replaced without grams: no dose until they are typed, or it would be counted too low.
    public func foodWithoutGrams(in entry: MealPlanEntry) -> String? {
        entry.items.lazy.compactMap { item in
            let food = self.food(item)
            return food.needsGrams ? food.replacedBy : nil
        }.first
    }

    public func carbs(of entry: MealPlanEntry) -> Int? {
        if foodWithoutGrams(in: entry) != nil { return nil }
        let known = entry.items.compactMap { carbs(of: $0) } + added.compactMap(\.carbs_g)
        guard !known.isEmpty else { return nil }
        return Int(known.reduce(0, +).rounded())
    }

    /// The foods as eaten, for the bolus card: portions applied (protein and fat in the same share), a replaced food with
    /// its own grams and no macros, foods left out dropped. Nil while a replaced food has no grams.
    public func eatenItems(_ entry: MealPlanEntry) -> [MealPlanItem]? {
        if foodWithoutGrams(in: entry) != nil { return nil }
        let menu: [MealPlanItem] = entry.items.compactMap { item in
            let food = food(item)
            guard let carbs = carbs(of: item), food.portion != .none else { return nil }
            if let other = food.replacedBy { return MealPlanItem(name: other, carbs_g: carbs) }
            let share: Double? = switch food.portion {
            case .whole: 1
            case .half: 0.5
            case .none: 0
            case .grams: item.carbs_g.flatMap { $0 > 0 ? carbs / $0 : nil }
            }
            return MealPlanItem(name: item.name, carbs_g: carbs, protein_g: share.flatMap { s in item.protein_g.map { $0 * s } }, fat_g: share.flatMap { s in item.fat_g.map { $0 * s } })
        }
        return menu + added
    }

    /// The foods in words, for the chat: "Kotlet 12 g, Ziemniaki (połowa) 13 g, Kompot (nie je)".
    public func described(_ entry: MealPlanEntry) -> String {
        (entry.items.map { item in
            let food = food(item)
            let note: String? = switch food.portion {
            case .half: "połowa"
            case .none: "nie je"
            default: nil
            }
            var text = food.replacedBy.map { "\($0) zamiast: \(item.name)" } ?? item.name
            if let note { text += " (\(note))" }
            if food.portion != .none, let grams = carbs(of: item) { text += " \(MealJournalFormat.number(grams)) g" }
            return text
        } + added.map { "\($0.name) \(MealJournalFormat.number($0.carbs_g ?? 0)) g" }).joined(separator: ", ")
    }

    /// "1,5" or "1.5" from the grams field; nil when it is not a number in range.
    public static func grams(from text: String) -> Double? {
        guard let value = Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")), value >= 0, value <= maxGrams else { return nil }
        return value
    }
}

/// What the planned meal's page can say now: the dose only near the meal, never long after it.
public enum MealPlanMoment: Equatable {
    /// More than 30 minutes before the meal: the dose would be a guess.
    case tooEarly(doseFrom: Date)
    case soon
    /// After the meal's time, within 30 minutes: the dose counted for now.
    case late
    case tooLate
    case skipped

    public static let doseWindow: TimeInterval = 30 * 60

    public static func of(_ entry: MealPlanEntry, now: Date) -> MealPlanMoment {
        if entry.isSkipped { return .skipped }
        guard let planned = entry.plannedDate else { return .tooLate }
        if now < planned.addingTimeInterval(-doseWindow) { return .tooEarly(doseFrom: planned.addingTimeInterval(-TimeInterval(entry.lead_minutes * 60))) }
        if now < planned { return .soon }
        return now < planned.addingTimeInterval(doseWindow) ? .late : .tooLate
    }
}

/// The card pinned at the top of the Meals tab (owner 2026-11-05): today's next meal, from an hour before it until it starts.
public extension MealPlanEntry {
    /// A dose was given near it and not said to be for something else: it is eaten (under "Dziś"), not planned.
    var hasDoseForIt: Bool {
        if dose_answer == "THIS_MEAL" { return true }
        return given != nil && dose_answer != "OTHER"
    }
}

public enum MealPlanPin {
    public static let window: TimeInterval = 60 * 60

    public static func entry(in entries: [MealPlanEntry], now: Date) -> MealPlanEntry? {
        entries
            .filter { $0.isMeal && !$0.isSkipped && $0.status == "PLANNED" && !$0.hasDoseForIt }
            .compactMap { entry in entry.plannedDate.map { (entry, $0) } }
            .filter { $0.1 > now && $0.1.timeIntervalSince(now) < window }
            .min { $0.1 < $1.1 }?.0
    }

    /// "za 20 min"; a meal less than a minute away: "za chwilę".
    public static func timeLeft(to entry: MealPlanEntry, now: Date) -> String {
        guard let planned = entry.plannedDate else { return "" }
        let minutes = Int(planned.timeIntervalSince(now) / 60)
        return minutes < 1 ? "za chwilę" : "za \(minutes) min"
    }
}

/// The plan as the Meals tab shows it: one read for all days, kept fresh by live changes. Empty and silent on a server
/// without meal plans.
@MainActor
public final class MealPlanModel: ObservableObject {
    @Published public private(set) var entries: [MealPlanEntry] = []
    /// The server has plans: future days can be tapped.
    @Published public private(set) var isAvailable = false
    /// A read of the plan finished (answered or failed): before it, a meal missing from `entries` is not known yet,
    /// so its page waits instead of saying it is gone.
    @Published public private(set) var hasRead = false
    /// The last read failed (no connection): a meal missing from `entries` may still be in the plan.
    @Published public private(set) var lastReadFailed = false
    @Published public var errorMessage: String?
    /// The last entry taken off the list, for "Cofnij".
    @Published public private(set) var removed: MealPlanEntry?
    /// Portions by entry, shared by both phones: a change here goes to the server, the server's come back on a read.
    @Published public var plates: [String: MealPlanPlate] = [:] {
        didSet {
            savePlates()
            guard !applyingServerPlates else { return }
            for (id, plate) in plates where oldValue[id] != plate { schedulePlateUpload(id) }
        }
    }
    /// Plates being set from a read: not sent back.
    private var applyingServerPlates = false
    /// Changes not yet on the server, by entry: a read does not overwrite them.
    private var plateUploads: [String: Task<Void, Never>] = [:]
    private let defaults: UserDefaults
    /// "Podaj insulinę" was pressed on this meal's page: a bolus after that is this meal's without asking.
    private var givingSince: [String: Date] = [:]

    private let patientID: String
    private let api: MealPlanAPI
    private let now: () -> Date
    private var calendar: Calendar { .polish }
    private var liveSubscription: AnyCancellable?

    public init(patientID: String, api: MealPlanAPI, now: @escaping () -> Date = Date.init, defaults: UserDefaults = .standard) {
        self.patientID = patientID
        self.api = api
        self.now = now
        self.defaults = defaults
        if let data = defaults.data(forKey: platesKey), let saved = try? JSONDecoder().decode([String: MealPlanPlate].self, from: data) {
            plates = saved
        }
    }

    private var platesKey: String { "mealPlan.plates.\(patientID)" }

    /// Portions outlive the app, and only as long as their meal is in the plan.
    private func savePlates() {
        if let data = try? JSONEncoder().encode(plates) { defaults.set(data, forKey: platesKey) }
    }

    /// "Zmień godzinę", for all caregivers; false when it could not be saved.
    public func setTime(_ entry: MealPlanEntry, to date: Date) async -> Bool {
        do {
            replace(try await api.setMealPlanEntryTime(patientID: patientID, entryID: entry.id, plannedAt: date).entry)
            return true
        } catch is CancellationError {
            return false
        } catch {
            errorMessage = "Nie udało się zmienić godziny. Godzina musi być w przyszłości. Sprawdź połączenie i spróbuj ponownie."
            return false
        }
    }

    public func load() async {
        let today = calendar.startOfDay(for: now())
        guard let to = calendar.date(byAdding: .day, value: 36, to: today) else { return }
        let formatter = ISO8601DateFormatter()
        do {
            entries = try await api.listMealPlan(patientID: patientID, from: formatter.string(from: today), to: formatter.string(from: to)).entries
            isAvailable = true
            hasRead = true
            lastReadFailed = false
            applyServerPlates()
            await linkDosesSentFromPages()
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            // An older server, or no connection: what was read stays.
            hasRead = true
            lastReadFailed = true
        }
    }

    /// The server's plates win, except for a change of this phone still on its way; a plate only this phone has (set
    /// before plates were shared) goes up once.
    private func applyServerPlates() {
        let known = Set(entries.map(\.id))
        var merged = plates.filter { known.contains($0.key) }
        var toUpload: [String] = []
        for entry in entries where plateUploads[entry.id] == nil {
            if let stored = entry.plate {
                merged[entry.id] = stored.value ?? MealPlanPlate()
                if merged[entry.id] == MealPlanPlate() { merged[entry.id] = nil }
            } else if merged[entry.id]?.isEdited == true {
                toUpload.append(entry.id)
            }
        }
        if merged != plates {
            applyingServerPlates = true
            plates = merged
            applyingServerPlates = false
        }
        toUpload.forEach(schedulePlateUpload)
    }

    /// Several taps in a row go up as one write.
    private func schedulePlateUpload(_ entryID: String) {
        plateUploads[entryID]?.cancel()
        plateUploads[entryID] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled, let self else { return }
            let plate = self.plates[entryID] ?? MealPlanPlate()
            do {
                let saved = try await self.api.setMealPlanPlate(patientID: self.patientID, entryID: entryID, plate: plate).entry
                guard !Task.isCancelled else { return }
                self.plateUploads[entryID] = nil
                self.replace(saved)
            } catch {
                // An older server or no connection: the plate stays on this phone, the next change tries again.
                if !Task.isCancelled { self.plateUploads[entryID] = nil }
            }
        }
    }

    public func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: ["meals"]) }
            .debounce(for: .milliseconds(400), scheduler: RunLoop.main)
            .sink { [weak self] _ in Task { await self?.load() } }
    }

    public func entries(on day: Date) -> [MealPlanEntry] {
        entries.filter { entry in entry.plannedDate.map { calendar.isDate($0, inSameDayAs: day) } ?? false }
    }

    public func entry(id: String) -> MealPlanEntry? { entries.first { $0.id == id } }

    public func hasEntries(on day: Date) -> Bool { !entries(on: day).isEmpty }

    /// Off the list at once; "Cofnij" brings it back.
    public func remove(_ entry: MealPlanEntry) async {
        entries.removeAll { $0.id == entry.id }
        removed = entry
        await set(entry.id, status: "REMOVED")
    }

    public func undoRemove() async {
        guard let entry = removed else { return }
        removed = nil
        await set(entry.id, status: "PLANNED")
    }

    public func clearUndo() { removed = nil }

    public func skip(_ entry: MealPlanEntry) async { await set(entry.id, status: "SKIPPED") }

    public func unskip(_ entry: MealPlanEntry) async { await set(entry.id, status: "PLANNED") }

    public func markGiving(_ entry: MealPlanEntry) {
        givingSince[entry.id] = now()
    }

    /// A bolus sent from the meal's page needs no question.
    private func linkDosesSentFromPages() async {
        for entry in entries where entry.dose_answer == nil {
            guard let since = givingSince[entry.id], let at = entry.given?.date, at >= since else { continue }
            givingSince[entry.id] = nil
            await answerDose(entry, answer: "THIS_MEAL")
        }
    }

    /// "Tak" or "Nie" to "Czy to było do tego posiłku?"; shared by all caregivers.
    public func answerDose(_ entry: MealPlanEntry, answer: String?) async {
        do {
            let response = try await api.setMealPlanDoseAnswer(patientID: patientID, entryID: entry.id, answer: answer)
            replace(response.entry)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = "Nie udało się zapisać odpowiedzi. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    public func answerEaten(_ entry: MealPlanEntry, answer: String) async {
        do {
            let response = try await api.setMealPlanEatenAnswer(patientID: patientID, entryID: entry.id, answer: answer)
            replace(response.entry)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = "Nie udało się zapisać odpowiedzi. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    private func replace(_ entry: MealPlanEntry) {
        if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = entry }
    }

    /// The entry as the planned meal's chat last read it: a change accepted there brings new dishes and an empty plate.
    public func applyChatEntry(_ entry: MealPlanEntry) {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
        guard entries[index] != entry else { return }
        entries[index] = entry
        if plateUploads[entry.id] == nil, let stored = entry.plate {
            let plate = stored.value ?? MealPlanPlate()
            applyingServerPlates = true
            plates[entry.id] = plate == MealPlanPlate() ? nil : plate
            applyingServerPlates = false
        }
    }

    private func set(_ id: String, status: String) async {
        do {
            _ = try await api.setMealPlanEntryStatus(patientID: patientID, entryID: id, status: status)
        } catch {
            errorMessage = "Nie udało się zapisać zmiany w planie. Sprawdź połączenie i spróbuj ponownie."
        }
        await load()
    }
}
