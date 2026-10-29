import Foundation

/// One card on an empty new conversation. Tapping it sends `question`, or for the meal card opens the camera or the
/// library first.
public struct ConversationStarter: Equatable, Identifiable {
    public enum Action: Equatable {
        case send(String)
        case mealPhoto
    }

    public let id: String
    public let title: String
    public let subtitle: String
    /// The start of the subtitle shown in the glucose colour (the value and its arrow).
    public let highlight: String?
    public let highlightLevel: DashboardLevel?
    public let systemImage: String
    public let action: Action
    /// The first card, chosen from the situation; it has the turning border in the logo's colours.
    public let isHot: Bool
}

/// The three cards of an empty new conversation: the first depends on the glucose and the
/// time of day, the other two are always the same.
public enum ConversationStarters {
    /// The text put in the composer when a photo is added after the meal card opened the camera or the library. With
    /// remote control set up on this phone it asks for the bolus too, so the answer prepares the bolus card (a meal
    /// photo from this card is mostly a meal about to be eaten); the caregiver can delete "i bolus" before sending.
    public static func mealPhotoDraft(bolusCards: Bool) -> String {
        bolusCards ? "Policz WW, WBT i bolus tego posiłku." : "Policz WW i WBT tego posiłku."
    }

    public static func make(glucose: DashboardGlucose?, now: Date, bolusCards: Bool = false, calendar: Calendar = .current) -> [ConversationStarter] {
        [hot(glucose: glucose, now: now, calendar: calendar), lastDay, mealPhoto(bolusCards: bolusCards)]
    }

    /// "Dzień dobry" from 5:00 to 17:59, "Dobry wieczór" otherwise; with the caregiver's first name when known.
    public static func greeting(name: String?, now: Date, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: now)
        let salutation = (5..<18).contains(hour) ? "Dzień dobry" : "Dobry wieczór"
        guard let firstName = name?.split(whereSeparator: \.isWhitespace).first else {
            return salutation
        }
        return "\(salutation), \(firstName)"
    }

    static func hot(glucose: DashboardGlucose?, now: Date, calendar: Calendar) -> ConversationStarter {
        if let glucose, let starter = glucoseStarter(glucose, now: now) {
            return starter
        }
        let hour = calendar.component(.hour, from: now)
        if hour >= 21 || hour < 5 {
            return ConversationStarter(
                id: "calm-night",
                title: "Czy noc będzie spokojna?",
                subtitle: "IOB, COB i prognoza z pętli",
                highlight: nil,
                highlightLevel: nil,
                systemImage: "moon",
                action: .send("Czy noc będzie spokojna? Oceń IOB, COB i prognozę z pętli."),
                isHot: true
            )
        }
        return ConversationStarter(
            id: "last-night",
            title: "Jak minęła noc?",
            subtitle: "Glikemia od 22:00 do rana",
            highlight: nil,
            highlightLevel: nil,
            systemImage: "moon",
            action: .send("Jak minęła noc? Glikemia od 22:00 do rana."),
            isHot: true
        )
    }

    /// Out of range (the dashboard's thresholds) on a reading at most 15 minutes old: why it is high or low.
    static func glucoseStarter(_ glucose: DashboardGlucose, now: Date) -> ConversationStarter? {
        guard let observedAt = glucose.observedAt else { return nil }
        let minutes = Int(now.timeIntervalSince(observedAt) / 60)
        guard minutes >= 0, DashboardThresholds.readingAge(minutes: minutes) != .alarm else { return nil }
        let level = DashboardThresholds.glucose(glucose.value)
        guard level != .normal else { return nil }

        let trend = trend(glucose)
        let title: String
        let question: String
        if glucose.value < 70 {
            title = trend == .falling ? "Dlaczego cukier spada?" : "Dlaczego cukier jest niski?"
            question = trend == .falling ? "Dlaczego cukier teraz spada?" : "Dlaczego cukier jest teraz niski?"
        } else {
            title = trend == .rising ? "Dlaczego cukier rośnie?" : "Dlaczego cukier jest wysoki?"
            question = trend == .rising ? "Dlaczego cukier teraz rośnie?" : "Dlaczego cukier jest teraz wysoki?"
        }
        let value = [String(glucose.value), GlucoseTrend.arrowCharacter(direction(glucose))].compactMap { $0 }.joined(separator: " ")
        return ConversationStarter(
            id: "glucose",
            title: title,
            subtitle: "\(value) · dane z ostatnich 3 h",
            highlight: value,
            highlightLevel: level,
            systemImage: "sparkles",
            action: .send(question),
            isHot: true
        )
    }

    static let lastDay = ConversationStarter(
        id: "last-day",
        title: "Podsumuj ostatnią dobę",
        subtitle: "Zakres, hipo i hiper, trendy",
        highlight: nil,
        highlightLevel: nil,
        systemImage: "chart.xyaxis.line",
        action: .send("Podsumuj ostatnią dobę: czas w zakresie, hipo i hiper, trendy."),
        isHot: false
    )

    static func mealPhoto(bolusCards: Bool) -> ConversationStarter {
        ConversationStarter(
            id: "meal-photo",
            title: "Policz posiłek",
            subtitle: bolusCards ? "Ze zdjęcia: WW, WBT i bolus" : "Ze zdjęcia: WW i WBT",
            highlight: nil,
            highlightLevel: nil,
            systemImage: "camera",
            action: .mealPhoto,
            isHot: false
        )
    }

    /// The trend of the reading, by the rule of the Bolus tab (`GlucoseTrend`).
    static func trend(_ glucose: DashboardGlucose) -> GlucoseTrend.Movement {
        GlucoseTrend.movement(direction(glucose))
    }

    /// Nightscout's direction, or one worked out from the 5-minute change when the server sent none.
    static func direction(_ glucose: DashboardGlucose) -> String? {
        GlucoseTrend.direction(nightscout: glucose.direction, delta: glucose.delta.map(Double.init))
    }
}
