import Foundation

/// Host of the app's own https links: the server's push payloads (`universalLink`), the widgets and the Live Activity.
/// The app routes them itself, so no domain is needed; the reserved .invalid name never resolves. For real universal
/// links set your own domain here and in the server (APP_LINK_ORIGIN), add `applinks:<domain>` to the entitlements and
/// serve an apple-app-site-association file there (apple-app-site-association.example.json).
public enum AppLink {
    public static let host = "app.mellis.invalid"
    public static let origin = "https://\(host)"
}

public struct ConversationRoute: Equatable {
    public let patientID: String
    public let conversationID: String
    public let questionID: String?

    public init(patientID: String, conversationID: String, questionID: String? = nil) {
        self.patientID = patientID
        self.conversationID = conversationID
        self.questionID = questionID
    }
}

public enum UniversalLinkParser {
    public static func parsePath(_ path: String) -> ConversationRoute? {
        let sanitizedPath = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? path
        let trimmedPath = sanitizedPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmedPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 4 else {
            return nil
        }

        guard parts[0] == "patients", parts[2] == "conversations" else {
            return nil
        }

        let patientID = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        let conversationID = parts[3].trimmingCharacters(in: .whitespacesAndNewlines)

        guard UUID(uuidString: patientID) != nil,
              UUID(uuidString: conversationID) != nil else {
            return nil
        }

        return ConversationRoute(patientID: patientID, conversationID: conversationID)
    }

    public static func parse(_ url: URL) -> ConversationRoute? {
        guard url.scheme?.lowercased() == "https" else {
            return nil
        }

        guard let host = url.host?.lowercased(), host == AppLink.host else {
            return nil
        }

        let route = parsePath(url.path)
        if let route {
            let questionID = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                .first(where: { $0.name.lowercased() == "questionid" || $0.name.lowercased() == "question_id" })?
                .value
            return ConversationRoute(patientID: route.patientID, conversationID: route.conversationID, questionID: questionID)
        }
        return nil
    }
}

/// A patient alone: /patients/{patientId}, the route of a push that has neither a conversation nor a meal (a care
/// reminder without either). Opens the patient's start screen.
public enum PatientLinkParser {
    /// Push types whose tap may lead to the patient alone when nothing more precise parses.
    public static let patientPushTypes: Set<String> = ["care_reminder"]

    public static func parsePath(_ path: String) -> String? {
        let sanitizedPath = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? path
        let parts = sanitizedPath.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 2, parts[0] == "patients" else { return nil }
        let patientID = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return UUID(uuidString: patientID) != nil ? patientID : nil
    }

    public static func parse(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", url.host?.lowercased() == AppLink.host else { return nil }
        return parsePath(url.path)
    }

    /// A known push (a care reminder, or any whose routePath or link is /patients/{id}) with a valid patient; nil for the
    /// app's own notifications and anything without a gluco payload.
    public static func parsePushPayload(userInfo: [AnyHashable: Any]) -> String? {
        guard let gluco = userInfo["gluco"] as? [String: Any], let type = gluco["type"] as? String else { return nil }
        let fromPath = (gluco["routePath"] as? String).flatMap(parsePath)
            ?? (gluco["universalLink"] as? String).flatMap(URL.init(string:)).flatMap(parse)
        if let fromPath { return fromPath }
        guard patientPushTypes.contains(type), let patientID = gluco["patientId"] as? String, UUID(uuidString: patientID) != nil else { return nil }
        return patientID
    }
}

/// Where the home-screen widget leads: the patient's Bolus tab (/patients/{id}/bolus, the Bolus button and the small
/// widget) or their equipment list (/patients/{id}/equipment). Universal links, so the app opens them like any other.
public enum HomeWidgetLink: Equatable {
    case bolus(patientID: String)
    case equipment(patientID: String)

    public var url: URL {
        switch self {
        case let .bolus(patientID): URL(string: "\(AppLink.origin)/patients/\(patientID.lowercased())/bolus")!
        case let .equipment(patientID): URL(string: "\(AppLink.origin)/patients/\(patientID.lowercased())/equipment")!
        }
    }

    public var route: AppRoute {
        switch self {
        // The Bolus tab is where the app's remote command notifications lead too (the dashboard without remote setup).
        case let .bolus(patientID): .remoteCommands(patientID: patientID)
        case let .equipment(patientID): .equipment(patientID: patientID)
        }
    }

    public static func parse(_ url: URL) -> HomeWidgetLink? {
        guard url.scheme?.lowercased() == "https", url.host?.lowercased() == AppLink.host else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count == 3, parts[0] == "patients", UUID(uuidString: parts[1]) != nil else { return nil }
        switch parts[2] {
        case "bolus": return .bolus(patientID: parts[1])
        case "equipment": return .equipment(patientID: parts[1])
        default: return nil
        }
    }
}
