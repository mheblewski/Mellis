import Combine
import Foundation

/// "Wzorce" from the server (therapy-patterns.v1, family): the patterns of the last 14 days. Every sentence is the server's.
public struct TherapyPatternsView: Decodable, Equatable {
    public struct Window: Decodable, Equatable { public let from: String; public let to: String }
    public let computed_at: String
    public let window: Window
    /// "Przed i po zmianie": the newest Trio change of the last 28 days, numbers only (nil when none).
    public let change_check: ChangeCheck?
    public let patterns: [TherapyPattern]
    public let gone: [TherapyPattern]
    public let dismissed: [TherapyPattern]
}

public struct TherapyPattern: Decodable, Equatable, Identifiable, Hashable {
    public struct Episode: Decodable, Equatable, Hashable {
        public let date: String; public let time: String; public let note: String
        /// The day's glucose for the "Kiedy" mini chart (patterns of one time of day; older servers: nil).
        public let chart: EpisodeChart?
    }
    /// One day of a pattern on its mini chart: readings as [minutes from the chart's start, mg/dL].
    public struct EpisodeChart: Decodable, Equatable, Hashable {
        public let trace: [[Int]]
        public let meal_minute: Int?
        public let meal_time: String?
        public let nadir: Int?
        public let nadir_time: String?
        public let low_minutes: Int?
        /// [minute from the chart's start, U] and [minute, g]: drawn as on Teraz (older servers: nil).
        public let boluses: [[Double]]?
        public let carbs: [[Double]]?
    }
    /// The span of the mini charts, the pattern's hours (shaded) and the sentence about the other days.
    public struct PatternChart: Decodable, Equatable, Hashable {
        public let from_minute: Int
        public let to_minute: Int
        public let band_from_minute: Int
        public let band_to_minute: Int
        public let comparison: String
    }
    public let chart: PatternChart?
    public let key: String
    /// NIGHT_LOWS, TIME_BELOW_GOAL, DAY_LOWS_WITHOUT_FOOD, MEAL_RISES_SAME_TIME (settings and rebound: report only).
    public let id: String
    public let title: String
    /// The list's line: the sentence, or "3 ustawienia do omówienia" for the settings card.
    public let summary: String
    public let sentence: String
    /// The settings card's rows (facts); empty for the others.
    public let lines: [String]
    /// More facts for the pattern's own card, under its sentence (older servers: nil).
    public let details: [String]?
    /// The first episode's date ("Pierwszy raz: 4.11").
    public let first_episode: String?
    /// At most one question the data cannot answer; the chat checks the rest.
    public let question: String?
    /// The topic for the clinic ("Na wizytę: …").
    public let visit: String
    /// Lows are never hidden.
    public let can_dismiss: Bool
    /// All episodes; `episodes` holds the newest five.
    public let episode_count: Int
    public let episodes: [Episode]
    public let first_seen: String?
    public let last_seen: String?
    /// "Nowy" until this caregiver opens the card (servers before 2026-11-14: 7 days after it was first shown).
    public let is_new: Bool
    public let dismissed_until: String?

    /// "Ukryte przez: Ewa, 12.11" for a hidden pattern (older servers: nil).
    public let dismissed_label: String?

    public var isLows: Bool { ["NIGHT_LOWS", "TIME_BELOW_GOAL", "LOWS_AFTER_MEAL_BOLUS", "DAY_LOWS_WITHOUT_FOOD"].contains(id) }
    public var isSettings: Bool { id == "SETTING_CHECK" }
    /// Facts against the goal over 14 days (not patterns): no "Nowy" chip, no "Pierwszy raz".
    public var isFact: Bool { ["TIME_BELOW_GOAL", "NIGHT_LOWS"].contains(id) }
}

public struct ChangeCheck: Decodable, Equatable {
    public struct Change: Decodable, Equatable, Hashable { public let label: String; public let before: String; public let after: String }
    public struct Row: Decodable, Equatable, Hashable { public let label: String; public let before: String; public let after: String }
    public let key: String
    public let title: String
    public let changes: [Change]
    public let hours: String?
    public let day: Int?
    public let of: Int?
    public let before_days: Int?
    public let after_days: Int?
    public let rows: [Row]
    public let question: String?
    /// One comparison per direction of the change (never merged); older servers send only `rows`.
    public struct Section: Decodable, Equatable, Hashable {
        public let title: String; public let before_days: Int; public let after_days: Int; public let rows: [Row]
        /// "liczone w godzinach 18:00–3:00", and dated column headers ("Przed 23.10–5.11").
        public let subtitle: String?
        public let before_label: String?
        public let after_label: String?
        public init(title: String, before_days: Int, after_days: Int, rows: [Row], subtitle: String? = nil, before_label: String? = nil, after_label: String? = nil) {
            self.title = title; self.before_days = before_days; self.after_days = after_days; self.rows = rows
            self.subtitle = subtitle; self.before_label = before_label; self.after_label = after_label
        }
    }
    public let sections: [Section]?
    /// What else differed: boluses per meal, carbs a day.
    public let context: [Row]?
    public let before_note: String?
    /// "Bez oceny: …" from the server.
    public let note: String?
    /// "Po zmianie w tych godzinach glukoza była dłużej poniżej 70 niż przed. Pokaż to poradni." (its own line).
    public let safety: String?
    /// Until day 14 the card is one line without numbers (plan to 9/10, D1): "dzień 5 z 14 · porównanie od 20.11".
    public let ready: Bool?
    public let line: String?

    /// Still collecting the days after the change.
    public var isRunning: Bool { (day ?? 0) < (of ?? 14) }
}

/**
 * The one row on Teraz (role review 2026-11-12): new patterns and lows win over the change card, which only adds its day
 * to the caption; a running change alone shows its day, from day 14 "porównanie gotowe". No progress bar.
 */
public enum TherapyPatternsDashboardRow {
    public static func row(_ patterns: TherapyPatternsView) -> InsightDashboardRow? {
        let freshPatterns = patterns.patterns.filter(\.is_new)
        let fresh = freshPatterns.count
        let lows = patterns.patterns.contains(where: \.isLows)
        let change = patterns.change_check
        let changeText: String? = change.flatMap { c in
            guard let day = c.day, let of = c.of else { return nil }
            return c.isRunning ? "zmiana: dzień \(day) z \(of)" : "zmiana: porównanie gotowe"
        }
        let changeSpoken: String? = change.flatMap { c in
            guard let day = c.day, let of = c.of else { return nil }
            return c.isRunning ? "\(c.title), dzień \(day) z \(of)." : "\(c.title), porównanie gotowe."
        }
        if fresh > 0 || lows || (change == nil && !patterns.patterns.isEmpty) {
            // A new lows card is named: "Czas poniżej 70 ponad cel" (a fact, so no "Nowe:"), "Nowe: spadki między 6 a 9…".
            let freshLows = freshPatterns.first(where: \.isLows)
            let count = freshLows.map { $0.isFact ? $0.title : "Nowe: \($0.title.prefix(1).lowercased() + $0.title.dropFirst())" }
                ?? (fresh == 1 ? "1 nowy" : fresh > 1 ? "\(fresh) nowe" : "\(patterns.patterns.count) do omówienia")
            // One line on Teraz: a named new lows pattern leaves the change to the Wzorce screen (it did not fit).
            let caption = freshLows == nil ? (changeText.map { "\(count) · \($0) ›" } ?? "\(count) ›") : "\(count) ›"
            let spoken = "Wzorce: \(fresh == 1 ? "1 nowy" : fresh > 1 ? "\(fresh) nowe" : "\(patterns.patterns.count) do omówienia")\(lows ? ", dotyczy spadków" : "")." + (changeSpoken.map { " \($0)" } ?? "")
            // Red only for nights under 54 (round 4); other lows keep the arrow shape in the neutral colour.
            let nightUnder54 = patterns.patterns.contains { $0.id == "NIGHT_LOWS" }
            return InsightDashboardRow(title: "Wzorce", caption: caption, tone: .brand, itemID: nil, isLows: nightUnder54, icon: lows ? "arrow.down.circle" : nil, spoken: spoken, opensPatterns: true)
        }
        if let change, let day = change.day, let of = change.of {
            return InsightDashboardRow(title: change.title, caption: change.isRunning ? "dzień \(day) z \(of) ›" : "porównanie gotowe ›", tone: .brand, itemID: nil, isLows: false, spoken: changeSpoken, opensPatterns: true)
        }
        return nil
    }
}

/// What Teraz's Wzorce row says (tone of its title).
public enum InsightTileTone: String, Codable, Equatable, Sendable {
    case red, orange, brand, neutral
}

/// What the dashboard's row says. Remembered per patient, so the row is in its place as soon as the screen opens instead
/// of pushing the chart up when the server answers.
public struct InsightDashboardRow: Codable, Equatable, Sendable {
    public let title: String
    public let caption: String
    public let tone: InsightTileTone
    public let itemID: String?
    /// Lows: the accessibility hint adds that this is not an alarm for now.
    public let isLows: Bool
    /// A running check: how far it is, 0–1 (the row's progress bar).
    public var progress: Double? = nil
    /// An SF Symbol before the title (lows: an arrow down, in the lows colour).
    public var icon: String? = nil
    /// The whole row for VoiceOver, when the caption's short words are not enough.
    public var spoken: String? = nil
    /// Opens Wzorce (not "Ustawienia pod lupą"): the hint follows the row's kind, not its title.
    public var opensPatterns: Bool? = nil
}

public enum InsightDashboardRowMemory {
    private static func key(_ patientID: String) -> String { "dashboard.insightsRow.\(patientID.lowercased())" }

    public static func load(patientID: String, defaults: UserDefaults = .standard) -> InsightDashboardRow? {
        defaults.data(forKey: key(patientID)).flatMap { try? JSONDecoder().decode(InsightDashboardRow.self, from: $0) }
    }

    public static func save(_ row: InsightDashboardRow?, patientID: String, defaults: UserDefaults = .standard) {
        if let row, let data = try? JSONEncoder().encode(row) {
            defaults.set(data, forKey: key(patientID))
        } else {
            defaults.removeObject(forKey: key(patientID))
        }
    }
}

/// The Teraz row of Wzorce: loaded with the screen, remembered per patient so the row is in its place when Teraz opens.
@MainActor
public final class TherapyPatternsRowModel: ObservableObject {
    @Published public private(set) var patterns: TherapyPatternsView? {
        didSet {
            guard let patterns else { return }
            InsightDashboardRowMemory.save(TherapyPatternsDashboardRow.row(patterns), patientID: patientID, defaults: defaults)
        }
    }
    public let patientID: String
    private let apiClient: APIClient
    private let defaults: UserDefaults
    private var rememberedRow: InsightDashboardRow?

    public init(apiClient: APIClient, patientID: String, defaults: UserDefaults = .standard) {
        self.apiClient = apiClient
        self.patientID = patientID
        self.defaults = defaults
        rememberedRow = InsightDashboardRowMemory.load(patientID: patientID, defaults: defaults)
    }

    /// The row: until the first answer, what it said last time; nil when nothing repeats.
    public var dashboardRow: InsightDashboardRow? {
        patterns.map(TherapyPatternsDashboardRow.row) ?? rememberedRow
    }

    /// A failed read keeps the last row.
    public func load() async {
        if let fresh = try? await apiClient.therapyPatterns(patientID: patientID) { patterns = fresh }
    }

    /// Wzorce are off for this caregiver: nothing of them stays on Teraz.
    public func forget() {
        rememberedRow = nil
        patterns = nil
        InsightDashboardRowMemory.save(nil, patientID: patientID, defaults: defaults)
    }
}

public struct TherapyPatternThreadResponse: Decodable, Equatable { public let conversation_id: String }

extension APIClient {
    public func therapyPatterns(patientID: String) async throws -> TherapyPatternsView {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/patterns", method: "GET")
        // The first open before any night counts the patterns (a few seconds on a small server).
        request.timeoutInterval = 45
        return try await decode(request, as: TherapyPatternsView.self)
    }

    /// "Nie dotyczy nas" (30 days), or back on the list.
    public func dismissTherapyPattern(patientID: String, key: String, dismissed: Bool) async throws {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/patterns/\(key)/dismiss", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["dismissed": dismissed])
        struct Response: Decodable { let key: String }
        _ = try await decode(request, as: Response.self)
    }

    /// The card was opened: no longer "Nowy" for this caregiver (the other owner keeps their own).
    public func markTherapyPatternOpened(patientID: String, key: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/patterns/\(key)/opened", method: "POST")
        struct Response: Decodable { let key: String }
        _ = try await decode(request, as: Response.self)
    }

    /// "Omów z Mellis": the pattern's conversation (created on first open, the same for every owner).
    public func openTherapyPatternThread(patientID: String, key: String) async throws -> TherapyPatternThreadResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/patterns/\(key)/conversation", method: "POST")
        return try await decode(request, as: TherapyPatternThreadResponse.self)
    }
}

/// "Raport dla poradni" (clinic-report.v1): four A4 pages of HTML from the server; the app prints them to PDF.
public struct ClinicReportResponse: Decodable, Equatable { public let html: String }

extension APIClient {
    public func clinicReport(patientID: String) async throws -> String {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/patterns/report", method: "GET")
        // 28 days of data on a small server: a few seconds the first time a day.
        request.timeoutInterval = 60
        return try await decode(request, as: ClinicReportResponse.self).html
    }
}
