import Foundation

/// The Bolus tab's checks of the amounts on screen as ONE compact row (1.0.5, owner 2026-10-30): disagreeing with the
/// app is a normal situation, so the forecast going low, this phone's limits, the server's blocks and warnings no longer
/// stack up over the chart. The row has the colour of the most serious one, its short headline and "· +N"; a tap shows
/// every item with its full text. Only the presentation changes: what the slider acknowledges stays the same.
public struct BolusCheckItem: Equatable, Identifiable, Sendable {
    public enum Level: Int, Comparable, Sendable {
        /// The slider stays off (a block, over this phone's limits).
        case block = 0
        /// Red: the forecast below 70, a DANGER warning.
        case danger = 1
        /// Orange: an ordinary warning.
        case warning = 2
        /// Said elsewhere on screen already (glucose and its trend are in the chart's header): only in the full list,
        /// never the headline of a row with other items and not counted in "+N".
        case repeated = 3

        public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    public let id: String
    public let level: Level
    /// A few words, for the collapsed row ("Prognoza < 70 ok. 14:34").
    public let headline: String
    /// The full text with its numbers (the expanded list, VoiceOver); nil when the headline is the whole text.
    public let detail: String?
    /// A DANGER warning the caregiver confirms before the slider sends (shown again in that confirmation).
    public let needsConfirmation: Bool

    public init(id: String, level: Level, headline: String, detail: String?, needsConfirmation: Bool = false) {
        self.id = id
        self.level = level
        self.headline = headline
        self.detail = detail
        self.needsConfirmation = needsConfirmation
    }

    /// Red (blocks and dangers) or orange.
    public var isRed: Bool { level <= .danger }
    /// The whole text: what VoiceOver reads and the expanded row's second line.
    public var fullText: String { detail ?? headline }
}

public struct BolusCheckSummary: Equatable, Sendable {
    /// Most serious first.
    public let items: [BolusCheckItem]

    public init(items: [BolusCheckItem]) {
        // Stable: within a level the order they were given in (forecast, then the server's order).
        self.items = items.enumerated().sorted { lhs, rhs in
            lhs.element.level != rhs.element.level ? lhs.element.level < rhs.element.level : lhs.offset < rhs.offset
        }.map(\.element)
    }

    public var isEmpty: Bool { items.isEmpty }
    /// The collapsed row's item: the most serious one.
    public var headline: BolusCheckItem? { items.first }
    /// "+N": the other items worth counting (repeated ones are in the list but not counted).
    public var moreCount: Int {
        guard let headline else { return 0 }
        return items.filter { $0.id != headline.id && $0.level != .repeated }.count
    }

    /// The collapsed row's text: only the most serious item's headline ("Prognoza < 70 ok. 14:34"), one line; the
    /// count of the others is its own badge (`badgeText`).
    public var collapsedText: String? { headline?.headline }

    /// The badge before the chevron: "+4", nil when nothing else is counted.
    public var badgeText: String? { moreCount > 0 ? "+\(moreCount)" : nil }

    /// Everything, in full, for VoiceOver (the row reads the whole list, not only the headline).
    public var accessibilityText: String {
        items.map(\.fullText).joined(separator: " ")
    }

    /// The collapsed row for VoiceOver: "Prognoza poniżej 70 około 17:49, i 4 inne ostrzeżenia" (the symbols and
    /// abbreviations read as words).
    public var collapsedAccessibilityText: String? {
        guard let headline else { return nil }
        let spoken = Self.spoken(headline.headline)
        guard moreCount > 0 else { return spoken }
        return "\(spoken), i \(moreCount) \(Self.otherWarnings(moreCount))"
    }

    /// "inne ostrzeżenie" / "inne ostrzeżenia" / "innych ostrzeżeń", by the Polish plural.
    static func otherWarnings(_ count: Int) -> String {
        if count == 1 { return "inne ostrzeżenie" }
        let tens = count % 100
        if (2...4).contains(count % 10) && !(12...14).contains(tens) { return "inne ostrzeżenia" }
        return "innych ostrzeżeń"
    }

    static func spoken(_ text: String) -> String {
        text
            .replacingOccurrences(of: " < ", with: " poniżej ")
            .replacingOccurrences(of: " > ", with: " powyżej ")
            .replacingOccurrences(of: "ok. ", with: "około ")
    }

    /// DANGER warnings the slider asks to confirm (INSULIN_WHILE_LOW has its own confirmation).
    public var confirmations: [BolusCheckItem] { items.filter(\.needsConfirmation) }

    /// Builds the summary of the Bolus tab's checks.
    /// - forecastLowAt: the chart's forecast goes below 70 then (bolus-forecast.v1); `forecastLoopGenitive` names the
    ///   loop when the line is only the loop's own ("Trio"), nil for a line with the dose.
    /// - totalLowWithoutLine: the loop's end value plus the dose's full effect, when below 70 (bolus-forecast.v7).
    public static func make(
        forecastLowAt: Date?,
        forecastLoopGenitive: String? = nil,
        forecastLowFromDose: Bool = false,
        totalLowWithoutLine: Int? = nil,
        limitProblem: String? = nil,
        blocks: [RemoteCommandNotice] = [],
        warnings: [RemoteCommandNotice] = [],
        time: (Date) -> String = { RemoteCommandFormat.time($0) }
    ) -> BolusCheckSummary {
        var items: [BolusCheckItem] = []
        for block in blocks {
            items.append(BolusCheckItem(id: "block:\(block.code):\(block.message)", level: .block, headline: block.message, detail: nil))
        }
        if let limitProblem {
            items.append(BolusCheckItem(id: "limit", level: .block, headline: limitProblem, detail: nil))
        }
        if let low = forecastLowAt {
            let clock = time(low)
            let advice = forecastLowFromDose ? " Rozważ mniejszą dawkę." : ""
            let line = forecastLoopGenitive.map { "Prognoza \($0) (bez tej dawki)" } ?? "Prognoza"
            items.append(BolusCheckItem(id: "forecast-low", level: .danger, headline: "Prognoza < 70 ok. \(clock)", detail: "\(line) schodzi poniżej 70 ok. \(clock).\(advice)"))
        }
        if let total = totalLowWithoutLine {
            items.append(BolusCheckItem(id: "forecast-total", level: .danger, headline: "Po tej dawce ok. \(total) mg/dL",
                                        detail: "Po pełnym działaniu tej dawki prognoza to ok. \(total) mg/dL (zakłada, że pętla nic więcej nie zmieni). Rozważ mniejszą dawkę."))
        }
        for warning in warnings {
            items.append(item(for: warning))
        }
        return BolusCheckSummary(items: items)
    }

    /// One server warning: its short headline by code, the server's text as the detail.
    static func item(for warning: RemoteCommandNotice) -> BolusCheckItem {
        let id = "warning:\(warning.acknowledgementKey)"
        let message = warning.message
        let level: BolusCheckItem.Level
        if repeatedCodes.contains(warning.code) {
            level = .repeated
        } else {
            level = warning.isDanger ? .danger : .warning
        }
        let short = shortHeadline(code: warning.code, message: message)
        // INSULIN_WHILE_LOW is confirmed separately (lowGlucoseInsulinConfirmation); every other DANGER here.
        let confirm = warning.isDanger && !warning.needsSeparateConfirmation
        return BolusCheckItem(id: id, level: level, headline: short ?? message, detail: short == nil || short == message ? nil : message, needsConfirmation: confirm)
    }

    /// Already on screen: glucose and its trend in the chart's header.
    static let repeatedCodes: Set<String> = ["GLUCOSE_FALLING_OR_LOW"]

    /// A few words for a known warning; nil: the server's text is used as it is (a code this build does not know).
    static func shortHeadline(code: String, message: String) -> String? {
        switch code {
        case "DOSE_ABOVE_CALCULATOR":
            if let extra = firstCapture(#"to o ([0-9]+(?:,[0-9]+)?) j więcej"#, in: message) { return "Dawka wyższa niż z danych (+\(extra) j)" }
            return "Dawka wyższa niż z danych"
        case "DOSE_ABOVE_FORMULA":
            return "Dawka wyższa niż z danych"
        case "RECENT_BOLUS":
            if let units = firstCapture(#"Bolus ([0-9]+(?:,[0-9]+)?) j"#, in: message), let minutes = firstCapture(#"podano ([0-9]+) min temu"#, in: message) {
                return "Bolus \(units) j \(minutes) min temu"
            }
            return "Niedawny bolus"
        case "RECENT_REMOTE_BOLUS":
            if let units = firstCapture(#"bolus ([0-9]+(?:,[0-9]+)?) j"#, in: message), let minutes = firstCapture(#"wysłano ([0-9]+) min temu"#, in: message) {
                return "Zdalny bolus \(units) j \(minutes) min temu"
            }
            return "Niedawny zdalny bolus"
        case "UNCONFIRMED_REMOTE_BOLUS":
            if let units = firstCapture(#"bolus ([0-9]+(?:,[0-9]+)?) j"#, in: message) { return "Zdalny bolus \(units) j bez potwierdzenia" }
            return "Zdalny bolus bez potwierdzenia"
        case "ALREADY_SENT_FOR_MEAL":
            return "Ten posiłek mógł już być wysłany"
        case "RECENT_INSULIN":
            if let units = firstCapture(#"podano ([0-9]+(?:,[0-9]+)?) j"#, in: message), let minutes = firstCapture(#"W ostatnich ([0-9]+) min"#, in: message) {
                return "\(units) j insuliny w \(minutes) min"
            }
            return "Niedawno podana insulina"
        case "INSULIN_WHILE_LOW":
            return "Najpierw węglowodany"
        case "LOW_GLUCOSE":
            return "Niska glukoza"
        case "CALCULATOR_UNAVAILABLE":
            return "Kalkulator niedostępny"
        case "SAME_MEAL_CHECK_UNAVAILABLE":
            return "Nie sprawdzono powtórki posiłku"
        case "NO_GLUCOSE":
            return "Brak odczytu glukozy"
        case "GLUCOSE_STALE", "GLUCOSE_OLD":
            if let minutes = firstCapture(#"ma ([0-9]+) min"#, in: message) { return "Odczyt sprzed \(minutes) min" }
            return "Stary odczyt glukozy"
        case "LOOP_STALE":
            return "Pętla nie wysyła obliczeń"
        case "NO_THERAPY_PROFILE":
            return "Brak ICR w profilu"
        case "INSULIN_HISTORY_UNAVAILABLE":
            return "Brak historii bolusów"
        case "DOSE_DIFFERS_FROM_ICR":
            return "Dawka inna niż z ICR"
        case "GLUCOSE_FALLING_OR_LOW":
            guard let value = firstCapture(#"Glukoza ([0-9]+) mg/dL"#, in: message) else { return nil }
            if let delta = firstCapture(#"zmiana ([+-]?[0-9]+) na 5 min"#, in: message) { return "Glukoza \(value) mg/dL (\(delta)/5 min)" }
            return "Glukoza \(value) mg/dL"
        default:
            return nil
        }
    }

    private static func firstCapture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}
