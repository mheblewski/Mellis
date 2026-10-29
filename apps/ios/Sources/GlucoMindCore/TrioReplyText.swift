import Foundation

/// Trio's answer said short: the gist in a few words for the card ("Za duży bolus dla Trio (max 3 j)"), the whole text
/// kept under "Szczegóły z Trio". The server already turns known refusals into Polish (translateTrioReason); others come
/// as Trio wrote them, sometimes hundreds of characters of English.
public struct TrioReplyText: Equatable {
    public let short: String
    /// The full answer (without the server's "Błąd:" prefix), when the short text says less than it; nil when they are
    /// the same.
    public let details: String?

    /// Longest short text before it is cut at a word with "…" (about three lines on the card).
    static let maxShort = 120

    public init(statusMessage: String?) {
        let full = (statusMessage ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // The card's title already says what failed ("Bolus nie został podany"): the details are Trio's own words.
        let reason = Self.reason(in: full)
        let short = Self.shorten(reason)
        self.short = short
        self.details = reason.isEmpty || reason == short ? nil : reason
    }

    /// The server's "Błąd: …" and "Węglowodany zapisane w Trio (w Loopie), bolus odrzucony: …" carry the reason after the colon.
    static func reason(in message: String) -> String {
        for prefix in ["Błąd:", "Węglowodany zapisane w Trio, bolus odrzucony:", "Węglowodany zapisane w Loopie, bolus odrzucony:", "Command rejected:"] where message.hasPrefix(prefix) {
            return String(message.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        }
        return message
    }

    static func shorten(_ reason: String) -> String {
        let text = reason
            .replacingOccurrences(of: #"\s*Details:.*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            // Trio's own wrapper repeats the card's title; its cause follows the colon.
            .replacingOccurrences(of: #"^(Błąd!\s*)?Bolus nie powiódł się z powodu błędu:\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"^(Error!\s*)?Bolus failed( with error| due to error)?:\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        let rules: [(String, (Match) -> String)] = [
            // The server's Polish.
            (#"bolus ([\d,.]+) j przekracza maksymalny bolus w Trio \(([\d,.]+) j\)"#, { "Za duży bolus dla Trio (max \(Self.decimal($0[2])) j)" }),
            (#"przekroczyłby maksymalne IOB w Trio \(([\d,.]+) j, teraz ([\d,.]+) j\)"#, { "Przekroczone max IOB w Trio (\(Self.decimal($0[1])) j, teraz \(Self.decimal($0[2])) j)" }),
            (#"od wysłania polecenia podano już bolus"#, { _ in "W międzyczasie podano już bolus" }),
            (#"([\d,.]+) g przekracza maksymalne węglowodany w Trio \(([\d,.]+) g\)"#, { "Za dużo węgli dla Trio (max \(Self.decimal($0[2])) g)" }),
            (#"od wysłania polecenia w Trio wpisano nowe węglowodany"#, { _ in "W Trio wpisano nowsze węgle" }),
            (#"polecenie dotarło za późno"#, { _ in "Polecenie dotarło za późno" }),
            (#"Remote Control jest wyłączone w Trio"#, { _ in "Zdalne sterowanie wyłączone w Trio" }),
            (#"Shared Secret nie zgadza się z Trio"#, { _ in "Zły Shared Secret w ustawieniach" }),
            // Trio's English, untranslated by the server.
            (#"exceeds the maximum allowed \(([\d.]+) units\)"#, { "Za duży bolus dla Trio (max \(Self.decimal($0[1])) j)" }),
            (#"max IOB \(([\d.]+) units\)"#, { "Przekroczone max IOB w Trio (\(Self.decimal($0[1])) j)" }),
            (#"suspend"#, { _ in "Pompa jest wstrzymana" }),
            (#"occlusion"#, { _ in "Okluzja w pompie" }),
            (#"reservoir|insufficient insulin"#, { _ in "Za mało insuliny w zbiorniku" }),
            (#"battery"#, { _ in "Słaba bateria pompy" }),
            (#"bluetooth|communicat|connection|not respond|timed? ?out|unreachable"#, { _ in "Brak łączności z pompą" }),
            (#"APS Manager|busy|loop (is )?(running|in progress)"#, { _ in "Trio liczy pętlę — spróbuj za chwilę" }),
        ]
        for (pattern, render) in rules {
            if let match = Match(pattern, in: text) { return render(match) }
        }
        return Self.firstSentence(text)
    }

    /// The first sentence, at most `maxShort` characters (cut at a word, with "…").
    static func firstSentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Trio nie podało powodu" }
        var sentence = trimmed.components(separatedBy: ". ").first ?? trimmed
        if sentence.hasSuffix(".") { sentence.removeLast() }
        guard sentence.count > maxShort else { return Self.capitalized(sentence) }
        let cut = sentence.prefix(maxShort - 1)
        let atWord = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return Self.capitalized(String(atWord)) + "…"
    }

    static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// "3.0" → "3", "2.5" → "2,5".
    /// "4.2" from Trio or the server as the app writes amounts ("4,2").
    static func decimal(_ text: String) -> String {
        guard let value = Double(text.replacingOccurrences(of: ",", with: ".")) else { return text }
        return RemoteCommandFormat.units(value)
    }

    /// A regular expression match's groups, case-insensitive.
    struct Match {
        let groups: [String]
        init?(_ pattern: String, in text: String) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                  let result = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
            groups = (0..<result.numberOfRanges).map { index in
                Range(result.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
        subscript(index: Int) -> String { index < groups.count ? groups[index] : "" }
    }
}
