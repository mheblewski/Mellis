import Foundation

/// Numbers, times and meal names as the meal screens, the chat cards and the reminders write them (Polish decimal
/// comma, 24 h clock).
enum LoopFormat {
    /// "4,5" / "2": units and grams with a Polish decimal comma.
    static func number(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
        return text.replacingOccurrences(of: ".", with: ",")
    }

    /// "2,25 j": insulin as everywhere in the app (up to two decimals, as the pump steps).
    static func units(_ value: Double) -> String { "\(RemoteCommandFormat.units(value)) j" }

    /// "13:05" of a server time; "--:--" when it cannot be read.
    static func time(_ iso: String) -> String {
        ServerDate.parse(iso).map { MealJournalFormat.clock($0) } ?? "--:--"
    }

    static func clock(_ date: Date) -> String { RemoteCommandFormat.time(date) }

    /// "W 23 g · B 9 g · T 7,3 g" ("?" for a value not known).
    static func macros(_ macros: MealMacros) -> String {
        let value = { (grams: Double?) in grams.map { "\(number($0)) g" } ?? "?" }
        return "W \(value(macros.carbs.grams)) · B \(value(macros.protein.grams)) · T \(value(macros.fat.grams))"
    }
}

enum MealNames {
    /// "Rogal maślany (30 g), Kabanos drobiowy (25 g)" -> "Rogal maślany, kabanos drobiowy"; nil when nothing is left.
    static func short(_ description: String) -> String? {
        let withoutAmounts = description.replacingOccurrences(of: #"\s*\([^)]*\)"#, with: "", options: .regularExpression)
        let items = withoutAmounts
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !items.isEmpty else { return nil }
        return items.enumerated().map { index, item in
            // Items after the first start lower case, unless the word is an acronym or a brand in capitals.
            guard index > 0, let first = item.first, let second = item.dropFirst().first, second.isLowercase else { return item }
            return first.lowercased() + item.dropFirst()
        }
        .joined(separator: ", ")
    }
}
