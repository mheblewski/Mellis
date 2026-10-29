import Foundation

/// Opens a meal: /patients/{patientId}/meals/{mealId} (push `meal_description` or universal link), its WBT insulin
/// screen: /patients/{patientId}/meals/{mealId}/wbt (push `wbt_reminder`), or the second part of its split bolus:
/// /patients/{patientId}/meals/{mealId}/planned-bolus (push `planned_bolus`). The retired `loop_action` push and its
/// /patients/{patientId}/loop-actions/{actionId} link lead nowhere.
public struct MealRoute: Equatable, Identifiable {
    public let patientID: String
    public let mealID: String
    public let opensWbt: Bool
    /// Opens the card of the meal's planned second bolus part.
    public let opensPlannedBolus: Bool
    /// The part the push was about (a meal may have several due at once); nil: the meal's current part.
    public let plannedBolusID: String?

    public var id: String {
        "\(patientID)/\(mealID)\(opensWbt ? "/wbt" : "")\(opensPlannedBolus ? "/planned-bolus" : "")\(plannedBolusID.map { "/\($0)" } ?? "")"
    }

    public init(patientID: String, mealID: String, opensWbt: Bool = false, opensPlannedBolus: Bool = false, plannedBolusID: String? = nil) {
        self.patientID = patientID
        self.mealID = mealID
        self.opensWbt = opensWbt
        self.opensPlannedBolus = opensPlannedBolus && !opensWbt
        self.plannedBolusID = self.opensPlannedBolus ? plannedBolusID : nil
    }
}

public enum MealLinkParser {
    public static func parsePath(_ path: String) -> MealRoute? {
        let sanitizedPath = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? path
        let parts = sanitizedPath
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard parts.count == 4 || (parts.count == 5 && (parts[4] == "wbt" || parts[4] == "planned-bolus")), parts[0] == "patients", parts[2] == "meals" else {
            return nil
        }

        let patientID = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        let mealID = parts[3].trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: patientID) != nil, UUID(uuidString: mealID) != nil else {
            return nil
        }

        return MealRoute(patientID: patientID, mealID: mealID, opensWbt: parts.count == 5 && parts[4] == "wbt", opensPlannedBolus: parts.count == 5 && parts[4] == "planned-bolus")
    }

    public static func parse(_ url: URL) -> MealRoute? {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == AppLink.host else {
            return nil
        }

        return parsePath(url.path)
    }

    /// Parses an APNs payload of type `meal_description`, `wbt_reminder`, `planned_bolus`, `meal_chat_answer`, `dose_given` (the meal
    /// chat's answer is ready, answer-ready-push.v1) or `care_reminder` with a meal; any other type (the retired
    /// `loop_action` included) returns nil.
    public static func parsePushPayload(userInfo: [AnyHashable: Any]) -> MealRoute? {
        guard let gluco = userInfo["gluco"] as? [String: Any], let type = gluco["type"] as? String else {
            return nil
        }
        // A care reminder opens its meal only when it has one (the Bolus tab's second dose); a chat reminder opens its
        // conversation instead.
        guard type == "meal_description" || type == "wbt_reminder" || type == "planned_bolus" || type == "meal_chat_answer" || type == "dose_given"
            || (type == "care_reminder" && gluco["mealId"] is String) else {
            return nil
        }
        let opensWbt = type == "wbt_reminder"
        let opensPlannedBolus = type == "planned_bolus"
        // The part this reminder is for: with two parts due, the tap opens this one (older servers: absent).
        let plannedBolusID = (gluco["plannedBolusId"] as? String).flatMap { UUID(uuidString: $0) != nil ? $0 : nil }

        if let patientID = gluco["patientId"] as? String,
           let mealID = gluco["mealId"] as? String,
           UUID(uuidString: patientID) != nil,
           UUID(uuidString: mealID) != nil {
            return MealRoute(patientID: patientID, mealID: mealID, opensWbt: opensWbt, opensPlannedBolus: opensPlannedBolus, plannedBolusID: plannedBolusID)
        }

        if let universalLink = gluco["universalLink"] as? String,
           let url = URL(string: universalLink),
           let route = parse(url) {
            return MealRoute(patientID: route.patientID, mealID: route.mealID, opensWbt: opensWbt, opensPlannedBolus: opensPlannedBolus, plannedBolusID: plannedBolusID)
        }

        if let routePath = gluco["routePath"] as? String, let route = parsePath(routePath) {
            return MealRoute(patientID: route.patientID, mealID: route.mealID, opensWbt: opensWbt, opensPlannedBolus: opensPlannedBolus, plannedBolusID: plannedBolusID)
        }

        return nil
    }
}
