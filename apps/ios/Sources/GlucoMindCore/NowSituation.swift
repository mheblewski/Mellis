import Foundation

public enum NowSituationDisplay: Equatable {
    case situation(NowSituation)
    /// A loader in the new layout until the read arrives.
    case waiting
    case plainHero

    public var situation: NowSituation? {
        if case .situation(let situation) = self { return situation }
        return nil
    }
}

/// What the Teraz screen says now (now-situation.v1, GET dashboard `situation`). The server decides the state and writes
/// the finished Polish strings; the app only colours and lays them out. Fields decode one by one and strings stay
/// strings, so a value this build does not know never costs the dashboard: its words are drawn without the unknown part.
public struct NowSituation: Codable, Equatable {
    public struct Glucose: Codable, Equatable {
        public let value: Int
        public let at: String
        public let tone: String
        public init(value: Int, at: String, tone: String) {
            self.value = value
            self.at = at
            self.tone = tone
        }
        public var observedAt: Date? { DashboardDate.parse(at) }
    }

    public struct Second: Codable, Equatable {
        /// DOSE, SOFT_DOSE, FORECAST_DOSE, CHECK or NO_READING.
        public let kind: String
        public let label: String?
        public let value: String
        public let unit: String?
        public let note: String?
    }

    public struct Action: Codable, Equatable {
        /// GIVEN, LOG_CARBS or UNDO.
        public let kind: String
        public let grams: Int?
        /// FILLED or OUTLINE.
        public let style: String?
        public let label: String
        public let other_amount_label: String?
        /// UNDO: which entry "Cofnij" takes back, and until when.
        public let event_id: String?
        public let until: String?
    }

    public struct Check: Codable, Equatable {
        public let carbs_at: String
        public let carbs_g: Int
        public let due_at: String
    }

    /// The bar's one button (now-situation.v5): it only opens a screen, never sends anything.
    public struct Link: Codable, Equatable {
        /// MEAL_PLAN_ENTRY, CONVERSATION or MEAL (meal-eaten.v1: "Czy zjedzono cały posiłek?").
        public let kind: String
        /// MEAL_PLAN_ENTRY: the planned meal's entry.
        public let entry_id: String?
        /// MEAL: the meal's page.
        public var meal_id: String? = nil
        /// "Obiad", "Rozmowa o tym": the app adds " ›".
        public let label: String

        public init(kind: String, entry_id: String?, label: String, meal_id: String? = nil) {
            self.kind = kind
            self.entry_id = entry_id
            self.label = label
            self.meal_id = meal_id
        }
    }

    public let state: String
    public let evaluated_at: String?
    public let glucose: Glucose?
    public let second: Second?
    public let sentence: String
    public let detail: String?
    public let action: Action?
    public let check: Check?
    /// Quiet states only: one of these stands under the sentence ("Linia dnia"). Absent means none.
    public let day_lines: [String]?
    /// The day line that is a light fact: drawn grey, as an extra (owner, 2026-11-08).
    public let light_fact: String?
    /// v5: the bar's button tied to the sentence; nil: no button.
    public let link: Link?
    /// The server decides the bar's button (v5 sends `link`, null included). False: an older server, "Porozmawiaj ›" stays.
    public let linkSent: Bool

    /// A patient's page needs a look: a low or a forecast (the red dot in the carousel).
    public var needsAttention: Bool {
        state.hasPrefix("5") || state.hasPrefix("6") || state.hasPrefix("7") || state == "8g"
    }

    /// A situation older than this is not shown: its dose and words may no longer hold.
    public static let maxAge: TimeInterval = 5 * 60

    static let knownSeconds: Set<String> = ["DOSE", "SOFT_DOSE", "FORECAST_DOSE", "GIVEN", "CHECK", "NO_READING"]
    static let knownActions: Set<String> = ["GIVEN", "LOG_CARBS", "UNDO"]
    static let knownLinks: Set<String> = ["MEAL_PLAN_ENTRY", "CONVERSATION", "MEAL"]

    public init(state: String, evaluated_at: String?, glucose: Glucose?, second: Second?, sentence: String, detail: String?, action: Action?, check: Check?, day_lines: [String]? = nil, light_fact: String? = nil, link: Link? = nil, linkSent: Bool = false) {
        self.state = state
        self.evaluated_at = evaluated_at
        self.glucose = glucose
        self.second = second
        self.sentence = sentence
        self.detail = detail
        self.action = action
        self.check = check
        self.day_lines = day_lines
        self.light_fact = light_fact
        self.link = link
        self.linkSent = linkSent
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? container.decode(String.self, forKey: .state)) ?? ""
        evaluated_at = try? container.decode(String.self, forKey: .evaluated_at)
        glucose = try? container.decode(Glucose.self, forKey: .glucose)
        second = try? container.decode(Second.self, forKey: .second)
        sentence = (try? container.decode(String.self, forKey: .sentence)) ?? ""
        detail = try? container.decode(String.self, forKey: .detail)
        action = try? container.decode(Action.self, forKey: .action)
        check = try? container.decode(Check.self, forKey: .check)
        day_lines = try? container.decode([String].self, forKey: .day_lines)
        light_fact = try? container.decode(String.self, forKey: .light_fact)
        link = try? container.decode(Link.self, forKey: .link)
        // A copy this app wrote keeps its flag; the server's answer says it by sending the key at all.
        linkSent = (try? container.decode(Bool.self, forKey: .linkSent)) ?? container.contains(.link)
    }

    /// Whether it still holds: with words, and fresh.
    public func isUsable(now: Date) -> Bool {
        guard !sentence.isEmpty, let evaluated = evaluated_at.flatMap(DashboardDate.parse) else { return false }
        return now.timeIntervalSince(evaluated) <= Self.maxAge
    }

    /// What Teraz draws from the read on hand. The old hero only when the read has no situation at all (the server's way
    /// back, NOW_SITUATION_ENABLED off): every other case stays in this layout.
    public static func display(
        situation: NowSituation?,
        glucose: DashboardGlucose?,
        freshness: DashboardFreshness,
        readFailed: Bool,
        lastSuccessAt: Date?,
        now: Date,
        loopSystem: LoopSystemKind = .unknown,
        earlyGlucose: DashboardGlucose? = nil
    ) -> NowSituationDisplay {
        guard let situation else { return .plainHero }
        if freshness == .refreshing {
            // No old words, number or colour while the new read is on its way; a younger read shows dimmed.
            let old = !situation.isUsable(now: now) || freshness.hidesGlucose(observedAt: situation.glucose?.observedAt, now: now)
            // glucose-first.v1: the new number already came on its own; the rest of the screen still waits for its read.
            if old, let early = earlyGlucose.flatMap({ Self.early($0, now: now) }) { return .situation(early) }
            return old ? .waiting : .situation(situation.agedOut(now: now, loopSystem: loopSystem).withoutUnknownParts)
        }
        // Read a moment ago by this phone's own clock, which also holds when that clock disagrees with the server's.
        let justRead = freshness == .fresh && lastSuccessAt.map { abs(now.timeIntervalSince($0)) <= maxAge } == true
        if !situation.sentence.isEmpty, justRead || situation.isUsable(now: now) { return .situation(situation.agedOut(now: now, loopSystem: loopSystem).withoutUnknownParts) }
        if freshness == .failed || readFailed || justRead { return .situation(unreadable(glucose: glucose, now: now)) }
        return .waiting
    }

    /// glucose-first.v1 (2026-11-13): the state of a screen that has only the newest number, read on its own ahead of the
    /// whole dashboard. No sentence, dose or button: those come with the dashboard's read.
    public static let earlyState = "early"

    public var isEarly: Bool { state == Self.earlyState }

    /// Only the number, its age and its colour by value (the server's 70 and 180); nil when the reading is itself older than
    /// a CGM's 5 minutes, which then waits for the whole read as before.
    static func early(_ glucose: DashboardGlucose, now: Date) -> NowSituation? {
        guard let at = glucose.observedAt, now.timeIntervalSince(at) < DashboardFreshness.hidesGlucoseAfter else { return nil }
        let tone = glucose.value < 70 ? "RED" : glucose.value > 180 ? "AMBER" : "NEUTRAL"
        return NowSituation(state: earlyState, evaluated_at: nil, glucose: Glucose(value: glucose.value, at: glucose.observed_at, tone: tone),
                            second: nil, sentence: "", detail: nil, action: nil, check: nil, link: nil, linkSent: true)
    }

    /// The server's limit for a reading too old to speak for now, on this phone's clock, for when its answer is not fresh.
    /// One limit at any glucose (owner, 2026-11-07).
    static let oldReadingMinutes = 15.0

    /// A reading gone old while no new answer came: no sentence or dose from before it, only what the server would say. The
    /// undo window stays, for carbs just given.
    func agedOut(now: Date, loopSystem: LoopSystemKind = .unknown) -> NowSituation {
        guard state != "8u", let glucose, glucose.tone != "STALE", let at = glucose.observedAt else { return self }
        let minutes = now.timeIntervalSince(at) / 60
        let low = glucose.value < 70
        guard minutes >= Self.oldReadingMinutes else { return self }
        return NowSituation(
            state: low ? "9b" : "9",
            evaluated_at: evaluated_at,
            glucose: Glucose(value: glucose.value, at: glucose.at, tone: "STALE"),
            second: Second(kind: "NO_READING", label: nil, value: "\(Int(minutes)) min", unit: "bez odczytu", note: nil),
            // As the server's state 9 since the texts review (2026-11-09): the "bez odczytu" row says Mellis does not know.
            sentence: low ? "Zmierz glukozę glukometrem." : "Warto sprawdzić sensor i telefon z \(loopSystem.instrumental).",
            detail: nil,
            // No "Zapisz węgle": the screen asks for a meter, not for carbs (owner, 2026-11-13).
            action: nil,
            check: nil,
            linkSent: linkSent
        )
    }

    /// No words to stand behind: the last reading in grey with its age, no dose and no button.
    static func unreadable(glucose: DashboardGlucose?, now: Date) -> NowSituation {
        NowSituation(
            state: "9",
            evaluated_at: ISO8601DateFormatter().string(from: now),
            glucose: glucose.map { Glucose(value: $0.value, at: $0.observed_at, tone: "STALE") },
            second: glucose.map { _ in Second(kind: "NO_READING", label: nil, value: "", unit: "bez odczytu", note: nil) },
            sentence: "Nie udało się pobrać danych.",
            detail: glucose.map { $0.value < 70 ? "Zmierz glukozę glukometrem." : "Warto zmierzyć glukozę glukometrem." },
            action: nil,
            check: nil
        )
    }

    /// A newer server may send a kind this build cannot draw: the words stay, that part goes.
    var withoutUnknownParts: NowSituation {
        NowSituation(
            state: state,
            evaluated_at: evaluated_at,
            glucose: glucose,
            second: second.flatMap { Self.knownSeconds.contains($0.kind) ? $0 : nil },
            sentence: sentence,
            detail: detail,
            action: action.flatMap { Self.knownActions.contains($0.kind) ? $0 : nil },
            check: check,
            day_lines: day_lines,
            light_fact: light_fact,
            link: link.flatMap { Self.knownLinks.contains($0.kind) ? $0 : nil },
            linkSent: linkSent
        )
    }

    /// The whole screen on red: below 54 mg/dL.
    public var isUrgentRed: Bool { glucose?.tone == "ON_RED" }

    /// A dose on screen (the part hidden while a refresh runs, as it may no longer hold).
    public var showsDose: Bool {
        guard let kind = second?.kind else { return false }
        return kind == "DOSE" || kind == "SOFT_DOSE" || kind == "FORECAST_DOSE"
    }

    /// Keeps a one-letter word with what follows, and a number with its word, at the end of a line (no "a" or "od 25" left hanging).
    public static func noBreaks(_ text: String) -> String {
        let space = "\u{00A0}"
        var result = text
        result = result.replacingOccurrences(of: #"(?<![\p{L}\p{N}])([aiouwzAIOUWZ]) "#, with: "$1" + space, options: .regularExpression)
        result = result.replacingOccurrences(of: #"\b(Na|na) razie"#, with: "$1" + space + "razie", options: .regularExpression)
        result = result.replacingOccurrences(of: #"\b(od|Od|po|Po|pod|za|do) (\d)"#, with: "$1" + space + "$2", options: .regularExpression)
        result = result.replacingOccurrences(of: #"(\d) (minut|minuty|minutę|godzin|godziny|sekund|sekundy|sekundę|g|j|dni)\b"#, with: "$1" + space + "$2", options: .regularExpression)
        return result
    }

    /// The whole seconds left to take the carbs back, counted here; nil without the undo window or once it is over.
    public func undoSecondsLeft(now: Date) -> Int? {
        guard action?.kind == "UNDO", let until = action?.until.flatMap(DashboardDate.parse) else { return nil }
        let left = until.timeIntervalSince(now)
        return left > 0 ? Int(left.rounded(.up)) : nil
    }

    /// "Węgle zostaną zapisane za 4 sekundy.", or on the other phone "Opiekun Ewa podał węgle. Mellis zapisze je za 4 sekundy."
    /// (two doers there, so the name stays: voice review 2026-11-13).
    public static func undoSentence(seconds: Int, serverSentence: String = "") -> String {
        let word: String
        switch seconds {
        case 1: word = "sekundę"
        case 2, 3, 4: word = "sekundy"
        default: word = "sekund"
        }
        // "Ewa podała węgle." as well as "Opiekun Jan podał węgle.": the name must stay on the other phone.
        if let range = serverSentence.range(of: " podał węgle.") ?? serverSentence.range(of: " podała węgle.") {
            return "\(serverSentence[..<range.upperBound]) Mellis zapisze je za \(seconds) \(word)."
        }
        return "Węgle zostaną zapisane za \(seconds) \(word)."
    }

    /// The check's minutes left, counted here so it does not wait for a refresh; nil without a running check.
    public func checkMinutesLeft(now: Date) -> Int? {
        guard second?.kind == "CHECK", let due = check.flatMap({ DashboardDate.parse($0.due_at) }) else { return nil }
        return max(1, Int((due.timeIntervalSince(now) / 60).rounded(.up)))
    }

    /// A reading this old after the check was due: then the screen says it waits (texts review, 2026-11-09). A younger
    /// one is the usual 5-minute rhythm, not a failure.
    public static let checkWaitReadingMinutes = 10.0

    /// The check is due, so the time is not "1 min" any more (owner, 2026-11-08, "od kilku minut jest ta jedna minuta").
    public func checkIsDue(now: Date) -> Bool {
        guard second?.kind == "CHECK", let due = check.flatMap({ DashboardDate.parse($0.due_at) }) else { return false }
        return now >= due
    }

    /// The check is due and its reading is late: "Odczyt spóźnia się o 4 min".
    public func checkWaitsForReading(now: Date) -> Bool {
        guard checkIsDue(now: now) else { return false }
        guard let observed = glucose?.observedAt else { return true }
        return now.timeIntervalSince(observed) / 60 >= Self.checkWaitReadingMinutes
    }

    /// Whole minutes since the check was due.
    public func checkMinutesPastDue(now: Date) -> Int? {
        guard checkIsDue(now: now), let due = check.flatMap({ DashboardDate.parse($0.due_at) }) else { return nil }
        return max(0, Int(now.timeIntervalSince(due) / 60))
    }
}

/// POST and DELETE rescue-carbs: LOGGED, ALREADY_LOGGED, UNDONE or TOO_LATE.
/// Which "Linia dnia" stands now on this phone: the next one at most every 10 minutes, or at once when the situation has
/// changed. Asked when the screen opens and when the situation changes, never while it is being read. The two phones may
/// show different lines; the numbers come from the server and are the same.
public struct DayLineRotation {
    /// One line for the whole calm stretch, at most an hour (teraz-sentence-review, owner 2026-11-08).
    public static let minimumSeconds: TimeInterval = 60 * 60
    let defaults: UserDefaults
    let key: String

    public init(scope: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        key = "teraz.dayLine.\(scope)"
    }

    public func line(lines: [String], state: String, now: Date) -> String? {
        guard !lines.isEmpty else { return nil }
        let saved = defaults.dictionary(forKey: key)
        let last = saved?["line"] as? String
        let changedAt = saved?["at"] as? TimeInterval ?? 0
        let sameState = saved?["state"] as? String == state
        if let last, lines.contains(last), sameState, now.timeIntervalSince1970 - changedAt < Self.minimumSeconds { return last }
        let next = last.flatMap { lines.firstIndex(of: $0) }.map { (($0 + 1) % lines.count) } ?? (saved?["index"] as? Int ?? 0) % lines.count
        defaults.set(["line": lines[next], "at": now.timeIntervalSince1970, "state": state, "index": next + 1], forKey: key)
        return lines[next]
    }
}

public struct SituationCarbsResponse: Codable, Equatable {
    public let status: String
    /// The entry "Cofnij" takes back (LOGGED, and ALREADY_LOGGED for the earlier one).
    public var event_id: String? = nil
}

extension NowSituation {
    /// Right after "Podano": the undo window as the server will say it, drawn at once instead of after the dashboard read
    /// (which can take seconds and eat into the 5 s). The read that follows replaces it.
    public func justGiven(grams: Int, eventID: String, now: Date, undoSeconds: TimeInterval = 5) -> NowSituation {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return NowSituation(
            state: "8u",
            evaluated_at: iso.string(from: now),
            glucose: glucose,
            second: Second(kind: "GIVEN", label: "Podano", value: "\(grams) g", unit: "szybkich węgli", note: nil),
            sentence: "Węgle zostaną zapisane za \(Int(undoSeconds)) sekund.",
            detail: nil,
            action: Action(kind: "UNDO", grams: nil, style: nil, label: "Cofnij", other_amount_label: nil, event_id: eventID, until: iso.string(from: now.addingTimeInterval(undoSeconds))),
            check: nil,
            linkSent: linkSent
        )
    }
}

/// What a rescue push said, kept when it is opened: Teraz shows the state of now, so this only says the alert has passed,
/// or stands in when there is no network.
public struct SituationPushContext: Equatable {
    public let patientID: String
    public let alertAt: Date
    public let glucose: Int?
    public let grams: Int?
    public let openedAt: Date

    /// How long "Alert z 12:36 jest już nieaktualny" stands, and how long the push's own numbers may replace a failed read.
    public static let staleLineSeconds: TimeInterval = 60
    public static let offlineSeconds: TimeInterval = 15 * 60

    public init(patientID: String, alertAt: Date, glucose: Int?, grams: Int?, openedAt: Date) {
        self.patientID = patientID
        self.alertAt = alertAt
        self.glucose = glucose
        self.grams = grams
        self.openedAt = openedAt
    }

    public static func parse(userInfo: [AnyHashable: Any], openedAt: Date) -> SituationPushContext? {
        guard let gluco = userInfo["gluco"] as? [String: Any], gluco["type"] as? String == "rescue_carbs",
              let patientID = gluco["patientId"] as? String, UUID(uuidString: patientID) != nil,
              let alertAt = (gluco["situationAlertAt"] as? String).flatMap(DashboardDate.parse) else { return nil }
        return SituationPushContext(
            patientID: patientID,
            alertAt: alertAt,
            glucose: (gluco["situationGlucose"] as? String).flatMap(Int.init),
            grams: (gluco["situationGrams"] as? String).flatMap(Int.init),
            openedAt: openedAt
        )
    }

    private func clock(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// For a minute after opening, when what the push was about has passed: "Alert z 12:36 jest już nieaktualny." The number
    /// and the arrow say the rest (texts review, 2026-11-09).
    public func staleLine(situation: NowSituation, delta: Int?, now: Date, timeZone: TimeZone = .current) -> String? {
        guard now.timeIntervalSince(openedAt) <= Self.staleLineSeconds, now >= openedAt, situation.glucose != nil else { return nil }
        let stillAbout = situation.state.hasPrefix("5") || situation.state.hasPrefix("6") || situation.state.hasPrefix("7") || situation.state.hasPrefix("8") || situation.state.hasPrefix("9")
        if stillAbout { return nil }
        return "Alert z \(clock(alertAt, timeZone: timeZone)) jest już nieaktualny."
    }

    /// Opened with no network: only the push's own words and numbers, grey, with no button and no new dose.
    public func offlineSituation(now: Date, timeZone: TimeZone = .current) -> NowSituation? {
        guard now.timeIntervalSince(openedAt) <= Self.offlineSeconds else { return nil }
        let at = ISO8601DateFormatter().string(from: alertAt)
        var parts = ["Alert z \(clock(alertAt, timeZone: timeZone))"]
        var numbers: [String] = []
        if let glucose { numbers.append("glukoza \(glucose)") }
        if let grams { numbers.append("propozycja \(grams) g") }
        if !numbers.isEmpty { parts = ["\(parts[0]): \(numbers.joined(separator: ", "))."] } else { parts = ["\(parts[0])."] }
        return NowSituation(
            state: "9",
            evaluated_at: ISO8601DateFormatter().string(from: now),
            glucose: glucose.map { NowSituation.Glucose(value: $0, at: at, tone: "STALE") },
            second: nil,
            sentence: "Nie udało się pobrać danych.",
            detail: parts[0],
            action: nil,
            check: nil
        )
    }
}

/// The rescue push opened last; the Teraz screen reads it.
@MainActor
public final class SituationPushContextStore: ObservableObject {
    public static let shared = SituationPushContextStore()
    @Published public private(set) var context: SituationPushContext?

    public init() {}

    public func opened(userInfo: [AnyHashable: Any], now: Date = Date()) {
        if let context = SituationPushContext.parse(userInfo: userInfo, openedAt: now) { self.context = context }
    }
}

public struct SituationConversationResponse: Codable {
    public struct Conversation: Codable {
        public let id: String
    }
    public let conversation: Conversation
}
