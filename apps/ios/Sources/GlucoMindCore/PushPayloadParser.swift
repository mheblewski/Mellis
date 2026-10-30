import Foundation

public enum PushPayloadParser {
    /// Push types that open a conversation: a question card (hypo report), a rescue carbs alert (`rescue_carbs`,
    /// rescue-carbs.v1), which opens the alert's conversation with its dose block on top, or a reminder the chat set
    /// (`care_reminder`, care-reminders.v1), which opens the conversation it was set in, or the answer to the
    /// caregiver's question being ready (`conversation_answer`, answer-ready-push.v1).
    public static let conversationPushTypes: Set<String> = ["conversation_question", "rescue_carbs", "care_reminder", "conversation_answer"]

    /// "Odpowiedź gotowa" (answer-ready-push.v1) in a conversation or in a meal chat: meant for a phone put away, so the
    /// open app shows no banner (the answer is on the screen or one tab away).
    public static let answerReadyPushTypes: Set<String> = ["conversation_answer", "meal_chat_answer"]

    /// An owner handed over their Trio / Loop settings to this person (1.0.5): the app reads its waiting packages.
    public static let remoteSettingsHandoffType = "remote_settings_handoff"

    /// The patient and package of a hand-off push; nil for any other push.
    public static func remoteSettingsHandoff(userInfo: [AnyHashable: Any]) -> (patientID: String, handoffID: String?)? {
        guard let gluco = userInfo["gluco"] as? [String: Any], gluco["type"] as? String == remoteSettingsHandoffType,
              let patientID = gluco["patientId"] as? String, UUID(uuidString: patientID) != nil else { return nil }
        let handoffID = (gluco["handoffId"] as? String).flatMap { UUID(uuidString: $0) != nil ? $0.lowercased() : nil }
        return (patientID, handoffID)
    }

    public static func isAnswerReady(userInfo: [AnyHashable: Any]) -> Bool {
        guard let gluco = userInfo["gluco"] as? [String: Any], let type = gluco["type"] as? String else { return false }
        return answerReadyPushTypes.contains(type)
    }

    public static func parseConversationRoute(userInfo: [AnyHashable: Any]) -> ConversationRoute? {
        guard let gluco = userInfo["gluco"] as? [String: Any] else {
            NSLog("[PUSH-TAP] 10 route rejected conversationId=n/a reason=missing_gluco")
            return nil
        }

        guard let type = gluco["type"] as? String, conversationPushTypes.contains(type) else {
            NSLog("[PUSH-TAP] 10 route rejected conversationId=%@ reason=unexpected_type", normalize(gluco["conversationId"] as? String))
            return nil
        }

        if let patientID = gluco["patientId"] as? String,
           let conversationID = gluco["conversationId"] as? String,
           UUID(uuidString: patientID) != nil,
           UUID(uuidString: conversationID) != nil {
            let questionID = gluco["questionId"] as? String
            NSLog("[PUSH-TAP] 10 route parsed conversationId=%@ patientId=%@", conversationID, patientID)
            return ConversationRoute(patientID: patientID, conversationID: conversationID, questionID: questionID)
        }

        if let universalLink = gluco["universalLink"] as? String,
           let url = URL(string: universalLink),
           let route = UniversalLinkParser.parse(url) {
            NSLog("[PUSH-TAP] 10 route parsed conversationId=%@ patientId=%@", route.conversationID, route.patientID)
            return route
        }

        if let routePath = gluco["routePath"] as? String,
           let route = UniversalLinkParser.parsePath(routePath) {
            let questionID = URLComponents(string: routePath)?.queryItems?
                .first(where: { $0.name.lowercased() == "questionid" || $0.name.lowercased() == "question_id" })?
                .value
            NSLog("[PUSH-TAP] 10 route parsed conversationId=%@ patientId=%@", route.conversationID, route.patientID)
            return ConversationRoute(patientID: route.patientID, conversationID: route.conversationID, questionID: questionID)
        }

        NSLog("[PUSH-TAP] 10 route rejected conversationId=%@ reason=no_valid_route", normalize(gluco["conversationId"] as? String))
        return nil
    }

    private static func normalize(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "n/a" : trimmed
    }
}
