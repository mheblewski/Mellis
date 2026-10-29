import Foundation

/// The glucose trend, one rule for every screen: Nightscout's own direction, the one the dashboard shows; from the
/// 5-minute change with Nightscout's cut-offs (1 / 2 / 3.5 mg/dL per minute, so 5 / 10 / 17.5 per 5 minutes) only when
/// the server did not send one.
public enum GlucoseTrend {
    public enum Movement: Equatable {
        case rising, falling, steady
    }

    /// The direction to show: Nightscout's when it is a known one, else from `delta` (mg/dL per 5 minutes); nil when
    /// neither is there.
    public static func direction(nightscout: String?, delta: Double?) -> String? {
        if isKnown(nightscout) { return nightscout }
        guard let delta else { return nil }
        if delta > 17.5 { return "DoubleUp" }
        if delta > 10 { return "SingleUp" }
        if delta > 5 { return "FortyFiveUp" }
        if delta < -17.5 { return "DoubleDown" }
        if delta < -10 { return "SingleDown" }
        if delta < -5 { return "FortyFiveDown" }
        return "Flat"
    }

    /// Rising or falling as the arrow shows it (a 45° arrow counts); no direction is steady.
    public static func movement(_ direction: String?) -> Movement {
        switch direction {
        case "DoubleUp", "SingleUp", "FortyFiveUp": return .rising
        case "DoubleDown", "SingleDown", "FortyFiveDown": return .falling
        default: return .steady
        }
    }

    public static func isKnown(_ direction: String?) -> Bool {
        label(direction) != nil
    }

    /// "Lekko spada": the direction in words (accessibility, lists).
    public static func label(_ direction: String?) -> String? {
        switch direction {
        case "DoubleUp": return "Szybko rośnie"
        case "SingleUp": return "Rośnie"
        case "FortyFiveUp": return "Lekko rośnie"
        case "Flat": return "Stabilnie"
        case "FortyFiveDown": return "Lekko spada"
        case "SingleDown": return "Spada"
        case "DoubleDown": return "Szybko spada"
        default: return nil
        }
    }

    /// The direction as one text character, for lines of text.
    public static func arrowCharacter(_ direction: String?) -> String? {
        switch direction {
        case "DoubleUp": return "⇈"
        case "SingleUp": return "↑"
        case "FortyFiveUp": return "↗"
        case "Flat": return "→"
        case "FortyFiveDown": return "↘"
        case "SingleDown": return "↓"
        case "DoubleDown": return "⇊"
        default: return nil
        }
    }
}
