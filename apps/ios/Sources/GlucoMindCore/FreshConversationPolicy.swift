import Foundation

/// fresh-chat.v1: when the Rozmowy tab comes on screen (launch, a tab switch, a return to the foreground) and the
/// conversation it would show has had no activity for an hour, it shows an empty new conversation instead (its greeting
/// and starter cards). Nothing is created on the server until something is sent; the old one stays in the ☰ list.
public enum FreshConversationPolicy {
    /// The one threshold: a conversation quiet for longer is replaced by a new, empty one.
    public static let defaultInactivityThreshold: TimeInterval = 60 * 60
    /// Debug builds only: GLUCOMIND_FRESH_CHAT_AFTER_SECONDS=<seconds> (simulator checks without waiting an hour).
    public static let debugOverrideKey = "GLUCOMIND_FRESH_CHAT_AFTER_SECONDS"

    public static var inactivityThreshold: TimeInterval {
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment[debugOverrideKey], let seconds = TimeInterval(raw), seconds > 0 {
            return seconds
        }
        #endif
        return defaultInactivityThreshold
    }

    /// What the tab knows about the conversation on screen when it comes back.
    public struct Snapshot: Equatable {
        public var conversationID: String
        /// The newest message (either side), the alert or hypo it is about, or its creation; nil when nothing says
        /// (an empty, ordinary conversation, which already shows the new-conversation screen).
        public var lastActivity: Date?
        /// A send, an analysis or an answer being written: never replaced.
        public var isBusy: Bool
        /// Unsent text or photos in the composer: kept with its conversation.
        public var hasDraft: Bool
        /// A question of Mellis waits for the caregiver's answer.
        public var awaitsAnswer: Bool

        public init(conversationID: String, lastActivity: Date?, isBusy: Bool = false, hasDraft: Bool = false, awaitsAnswer: Bool = false) {
            self.conversationID = conversationID
            self.lastActivity = lastActivity
            self.isBusy = isBusy
            self.hasDraft = hasDraft
            self.awaitsAnswer = awaitsAnswer
        }
    }

    public enum Decision: Equatable {
        case keep(KeepReason)
        case startFresh
    }

    public enum KeepReason: Equatable {
        /// Opened on purpose a moment ago: a notification, a link, the dashboard or the ☰ list.
        case openedOnPurpose
        case busy
        case draft
        case awaitsAnswer
        case recentActivity
        /// Nothing to compare (an empty conversation already looks like a new one).
        case noActivityKnown
    }

    /// `openedOnPurposeAt`: when this conversation was opened by a notification, a link, the dashboard or the history
    /// list on this phone; such an opening counts as activity for the same threshold.
    public static func decide(_ snapshot: Snapshot, openedOnPurposeAt: Date?, now: Date, threshold: TimeInterval = inactivityThreshold) -> Decision {
        if let openedOnPurposeAt, now.timeIntervalSince(openedOnPurposeAt) < threshold {
            return .keep(.openedOnPurpose)
        }
        if snapshot.isBusy { return .keep(.busy) }
        if snapshot.hasDraft { return .keep(.draft) }
        if snapshot.awaitsAnswer { return .keep(.awaitsAnswer) }
        guard let lastActivity = snapshot.lastActivity else { return .keep(.noActivityKnown) }
        return now.timeIntervalSince(lastActivity) > threshold ? .startFresh : .keep(.recentActivity)
    }
}

public extension ConversationResponse {
    /// The latest thing that happened in this conversation: its newest message (either side), its alert (sent, reminded,
    /// treated, declined) or hypo (start, end), or `createdAt` (from the history list). nil when none is known.
    func lastActivity(createdAt: Date? = nil) -> Date? {
        var dates: [Date] = messages.compactMap { ServerDate.parse($0.created_at) }
        if let rescue = rescue_carbs {
            dates += [rescue.detected_at, rescue.notified_at, rescue.reminder_sent_at, rescue.treatment?.logged_at, rescue.declined?.declined_at]
                .compactMap { $0.flatMap(ServerDate.parse) }
        }
        if let hypo {
            dates += [hypo.started_at, hypo.ended_at].compactMap { $0.flatMap(ServerDate.parse) }
        }
        if let createdAt { dates.append(createdAt) }
        return dates.max()
    }
}

/// stale-alerts.v1: a hypo, predicted-low or rescue carbs alert (and a rescue carb card) older than 30 minutes is
/// history: its header says "Nieaktualne · 2 godz. temu", its glucose is "wtedy" (not "teraz"), and nothing is sent to
/// the loop from it. Logging what was actually given ("Podano dosłodzenie", "Podano X g" as a log) and "Nie podaję" stay.
public enum AlertStaleness {
    /// The server refuses rescue carbs to the loop from such alerts after the same time (RESCUE_ALERT_STALE).
    public static let staleAfter: TimeInterval = 30 * 60

    public struct Stale: Equatable {
        public let age: TimeInterval

        /// "Nieaktualne · 2 godz. temu"
        public var badge: String { "Nieaktualne · \(AlertStaleness.ago(age))" }
        /// "Alarm sprzed 2 godz. Do Trio nic nie wyślę; możesz zapisać, co podano."
        public func alertReason(loop: LoopSystemNames) -> String {
            "Alarm sprzed \(AlertStaleness.sentence(AlertStaleness.since(age))) \(AlertStaleness.logOnly(loop))"
        }
        /// A rescue carb card of a chat: "Propozycja sprzed 2 godz. Do Trio nic nie wyślę; możesz zapisać, co podano."
        public func cardReason(loop: LoopSystemNames) -> String {
            "Propozycja sprzed \(AlertStaleness.sentence(AlertStaleness.since(age))) \(AlertStaleness.logOnly(loop))"
        }
    }

    /// "Do Trio nic nie wyślę; możesz zapisać, co podano."
    static func logOnly(_ loop: LoopSystemNames) -> String {
        "Do \(loop.genitive) nic nie wyślę; możesz zapisać, co podano."
    }

    /// nil while the alert is current (or its time is unknown).
    public static func stale(issuedAt: Date?, now: Date) -> Stale? {
        guard let issuedAt else { return nil }
        let age = now.timeIntervalSince(issuedAt)
        return age > staleAfter ? Stale(age: age) : nil
    }

    /// The rescue alert's last push (the reminder, else the alert itself, else its detection).
    public static func stale(_ rescue: ConversationRescueCarbs, now: Date) -> Stale? {
        let issued = [rescue.reminder_sent_at, rescue.notified_at, rescue.detected_at].lazy.compactMap { $0.flatMap(ServerDate.parse) }.first
        return stale(issuedAt: issued, now: now)
    }

    /// A hypo still going on is current; an ended one counts from its start (the alert).
    public static func stale(_ hypo: ConversationHypo, now: Date) -> Stale? {
        if hypo.ended_at == nil || hypo.state.uppercased() == "OPEN" { return nil }
        return stale(issuedAt: ServerDate.parse(hypo.started_at), now: now)
    }

    /// A rescue carb card counts from when the answer proposed it.
    public static func stale(_ proposal: ConversationRescueCarbProposal, now: Date) -> Stale? {
        stale(issuedAt: proposal.created_at.flatMap(ServerDate.parse), now: now)
    }

    /// Ends a sentence once: "2 godz." stays, "45 min" gets its full stop.
    static func sentence(_ text: String) -> String {
        text.hasSuffix(".") ? text : text + "."
    }

    /// "45 min temu", "2 godz. temu", "1 dzień temu", "3 dni temu"
    public static func ago(_ age: TimeInterval) -> String {
        let minutes = max(1, Int(age / 60))
        if minutes < 60 { return "\(minutes) min temu" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) godz. temu" }
        let days = hours / 24
        return days == 1 ? "1 dzień temu" : "\(days) dni temu"
    }

    /// "sprzed 45 min", "sprzed 2 godz.", "sprzed 1 dnia", "sprzed 3 dni" (without "sprzed").
    public static func since(_ age: TimeInterval) -> String {
        let minutes = max(1, Int(age / 60))
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) godz." }
        let days = hours / 24
        return days == 1 ? "1 dnia" : "\(days) dni"
    }
}
