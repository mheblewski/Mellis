import Foundation

/// One option of an answer (answer-options.v1): "A. Najpierw 3 g, bolus później", its cards tagged with its key.
public struct AnswerOption: Codable, Equatable, Identifiable {
    public let key: String
    public let title: String
    public let detail: String?
    /// What the cards do not show, in small print ("⚠️ Trzeba dopilnować dawki później"; absent: nothing).
    public var note: String? = nil
    public let recommended: Bool

    public var id: String { key }

    public init(key: String, title: String, detail: String? = nil, note: String? = nil, recommended: Bool = false) {
        self.key = key
        self.title = title
        self.detail = detail
        self.note = note
        self.recommended = recommended
    }
}

/// What the option picker under an answer shows: the options, which one is chosen, its cards and whether the choice
/// is fixed because something of one option was already sent or logged.
public struct AnswerOptionsPresentation: Equatable {
    /// The "Własny plan" row: no cards, the chat field is highlighted.
    public static let ownPlanKey = "OWN"

    public let options: [AnswerOption]
    public let selectedKey: String
    /// The option something was sent or logged from: the picker stays on it.
    public let lockedKey: String?

    /// nil when the answer offers no options (its cards then show as before). `treatedProposalID`: the rescue card an
    /// alert's treatment was logged from (in an alert's conversation), which fixes its option too.
    public init?(message: ConversationMessage, chosenKey: String?, treatedProposalID: String? = nil) {
        guard let options = message.answer_options, options.count >= 2 else { return nil }
        // The recommended option on top, whatever its letter.
        self.options = options.filter(\.recommended) + options.filter { !$0.recommended }
        let known = Set(options.map(\.key))
        let used = (message.bolus_proposals ?? []).first { $0.option_key.map(known.contains) == true && $0.state == "SENT" }?.option_key
            ?? (message.rescue_carb_proposals ?? []).first { $0.option_key.map(known.contains) == true && ($0.isAccepted || $0.logged != nil || $0.id == treatedProposalID) }?.option_key
        lockedKey = used
        let recommended = options.first(where: \.recommended)?.key ?? options[0].key
        let valid = chosenKey.flatMap { key in key == Self.ownPlanKey || options.contains { $0.key == key } ? key : nil }
        selectedKey = lockedKey ?? valid ?? recommended
    }

    public var isOwnPlan: Bool { selectedKey == Self.ownPlanKey }

    /// Cards without an option show whatever is chosen; the others only under their option.
    public func shows(optionKey: String?) -> Bool {
        optionKey == nil || optionKey == selectedKey
    }

    /// A card's option is one of these (a card tagged with a key the answer lost shows below the list, like no option).
    public func owns(optionKey: String?) -> Bool {
        optionKey.map { key in options.contains { $0.key == key } } ?? false
    }

    /// The lowest forecast of the option's cards that can still be given (an expired or sent card's forecast is old);
    /// nil without one.
    public func forecastMinimum(of key: String, in message: ConversationMessage) -> Int? {
        (message.bolus_proposals ?? []).filter { $0.option_key == key && $0.state == "PROPOSED" }.compactMap(\.risk?.min_mgdl).min()
    }

    /// "7 g dosłodzenia · 0 j teraz · ok. 2,9 j później · ok. 0,7 j WBT": the option's doses in one line.
    public func summary(of key: String, in message: ConversationMessage) -> String {
        let cards = (message.bolus_proposals ?? []).filter { $0.option_key == key }
        let rescue = (message.rescue_carb_proposals ?? []).filter { $0.option_key == key }.map(\.carbs_g).reduce(0, +)
        let now = cards.map(\.shownInsulinU).reduce(0, +)
        let later = cards.flatMap { card in card.split.map { [$0] + ($0.more_parts ?? []) } ?? [] }
            .map { $0.fixed_insulin_u ?? $0.later_insulin_u }
            .reduce(0, +)
        let wbt = cards.compactMap { $0.wbt_plan?.auto == true ? $0.wbt_plan?.standard_dose_u : nil }.reduce(0, +)
        var parts: [String] = []
        if rescue > 0 { parts.append("\(RescueCarbsFormat.grams(rescue)) g dosłodzenia") }
        let carbs = cards.map(\.shownCarbsG).reduce(0, +)
        if !cards.isEmpty { parts.append(now > 0 ? "\(RemoteCommandFormat.units(now)) j teraz" : "\(carbs) g bez insuliny teraz") }
        if later > 0 { parts.append("ok. \(RemoteCommandFormat.units(later)) j później") }
        if wbt > 0 { parts.append("WBT ok. \(RemoteCommandFormat.units(wbt)) j") }
        return parts.joined(separator: " · ")
    }
}
