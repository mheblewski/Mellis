import Foundation

/// Texts of Settings (the patient list, the patient's page): pure, so the wording is tested.
public enum SettingsText {
    /// "ostatni odczyt 3 min temu", "ostatni odczyt przed chwilą", "ostatni odczyt 2 godz. temu", "ostatni odczyt
    /// 3 dni temu"; nil without a reading.
    public static func lastReading(_ date: Date?, now: Date) -> String? {
        guard let date else { return nil }
        return "ostatni odczyt " + relative(date, now: now)
    }

    /// "przed chwilą", "3 min temu", "2 godz. temu", "1 dzień temu", "5 dni temu".
    public static func relative(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        let minutes = Int(seconds / 60)
        if minutes < 1 { return "przed chwilą" }
        if minutes < 60 { return "\(minutes) min temu" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) godz. temu" }
        let days = hours / 24
        return days == 1 ? "1 dzień temu" : "\(days) dni temu"
    }

    /// "Przed chwilą", "3 min temu" (a value on its own).
    public static func relativeCapitalized(_ date: Date, now: Date) -> String {
        let text = relative(date, now: now)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// The patient's row: "2019 · Trio · ostatni odczyt 3 min temu" (what is known of it).
    public static func patientSubtitle(birthYear: Int?, loop: LoopSystemInfo?, lastReadingAt: Date?, now: Date) -> String {
        var parts: [String] = []
        if let birthYear { parts.append(String(birthYear)) }
        if let name = loop?.system.names.nominative, loop?.system != .unknown { parts.append(name) }
        if let reading = lastReading(lastReadingAt, now: now) { parts.append(reading) }
        return parts.joined(separator: " · ")
    }

    /// A reading older than this is shown as a connection problem on the patient's page.
    public static let staleReadingInterval: TimeInterval = 15 * 60

    public static func isStale(_ date: Date?, now: Date) -> Bool {
        guard let date else { return true }
        return now.timeIntervalSince(date) > staleReadingInterval
    }

    /// The footer of everything stored per phone.
    public static let onThisPhone = "Na tym telefonie."
}
