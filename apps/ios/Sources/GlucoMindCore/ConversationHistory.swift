import Foundation

public enum ConversationOrigin: Equatable {
    case user
    case system
    case unknown
}

public enum ConversationTriggerType: Equatable {
    case none
    case hypo
    case other(String)

    public static func fromBackendTriggerType(_ value: String) -> ConversationTriggerType {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if normalized.isEmpty {
            return .none
        }

        if normalized.contains("HYPO") {
            return .hypo
        }

        return .other(normalized)
    }
}

public struct ConversationHistoryItem: Identifiable, Equatable {
    public let id: String
    public let conversationID: String
    public let title: String
    public let status: String
    public let awaitingUserAnswer: Bool
    public let origin: ConversationOrigin
    public let triggerType: ConversationTriggerType
    public let createdAt: Date
    public let updatedAt: Date
    /// Pinned to the top of the history (its own section, most recently pinned first).
    public let pinnedAt: Date?

    public var isPinned: Bool { pinnedAt != nil }

    public init(
        conversationID: String,
        title: String,
        status: String,
        awaitingUserAnswer: Bool,
        origin: ConversationOrigin,
        triggerType: ConversationTriggerType,
        createdAt: Date,
        updatedAt: Date,
        pinnedAt: Date? = nil
    ) {
        self.id = conversationID
        self.conversationID = conversationID
        self.title = title
        self.status = status
        self.awaitingUserAnswer = awaitingUserAnswer
        self.origin = origin
        self.triggerType = triggerType
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pinnedAt = pinnedAt
    }
}

public enum ConversationHistorySectionKey: Equatable {
    case pinned
    case today
    case yesterday
    case older(Date)

    public var id: String {
        switch self {
        case .pinned:
            return "pinned"
        case .today:
            return "today"
        case .yesterday:
            return "yesterday"
        case .older(let date):
            return "older-\(Int(date.timeIntervalSince1970))"
        }
    }

    public func title(using formatter: DateFormatter) -> String {
        switch self {
        case .pinned:
            return "Przypięte"
        case .today:
            return "Dziś"
        case .yesterday:
            return "Wczoraj"
        case .older(let date):
            return formatter.string(from: date)
        }
    }
}

public struct ConversationHistorySection: Identifiable, Equatable {
    public let key: ConversationHistorySectionKey
    public let title: String
    public let entries: [ConversationHistoryItem]

    public var id: String { key.id }
}

public enum ConversationHistoryTitleBuilder {
    public static func title(triggerType: ConversationTriggerType) -> String {
        switch triggerType {
        case .hypo:
            return "Niska glikemia"
        case .none:
            return "Rozmowa"
        case .other:
            // `.other` always carries a non-empty trigger type (an empty one is `.none`).
            return "Zdarzenie systemowe"
        }
    }
}

public enum ConversationListHistoryAdapter {
    public static func makeItems(from conversations: [ConversationListItem]) -> [ConversationHistoryItem] {
        conversations.compactMap { conversation in
            // With and without fractional seconds: a timestamp without them must not drop the conversation.
            guard let createdAt = ServerDate.parse(conversation.created_at),
                  let updatedAt = ServerDate.parse(conversation.updated_at) else {
                return nil
            }

            let triggerType = ConversationTriggerType.fromBackendTriggerType(conversation.trigger_type ?? "")
            return ConversationHistoryItem(
                conversationID: conversation.id,
                title: Self.title(name: conversation.title, preview: conversation.title_preview, triggerType: triggerType),
                status: conversation.workflow_status,
                awaitingUserAnswer: conversation.awaiting_user_answer,
                origin: parseOrigin(conversation.origin),
                triggerType: triggerType,
                createdAt: createdAt,
                updatedAt: updatedAt,
                pinnedAt: conversation.pinned_at.flatMap(Self.parseDate)
            )
        }
    }

    /// The conversation's name (from the AI or a caregiver) wins; then the user's first question; trigger-based names
    /// stay for unnamed system conversations.
    static func title(name: String? = nil, preview: String?, triggerType: ConversationTriggerType) -> String {
        let name = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty {
            return name
        }
        let trimmed = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty, triggerType == .none {
            return trimmed
        }
        return ConversationHistoryTitleBuilder.title(triggerType: triggerType)
    }

    private static func parseDate(_ value: String) -> Date? {
        ServerDate.parse(value)
    }

    private static func parseOrigin(_ raw: String) -> ConversationOrigin {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
        case "USER":
            return .user
        case "SYSTEM":
            return .system
        default:
            return .unknown
        }
    }
}

public enum ConversationHistoryGrouper {
    public static func sections(
        from items: [ConversationHistoryItem],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [ConversationHistorySection] {
        let sorted = items.sorted { left, right in
            if left.updatedAt == right.updatedAt {
                return left.createdAt > right.createdAt
            }

            return left.updatedAt > right.updatedAt
        }

        var buckets: [String: (key: ConversationHistorySectionKey, entries: [ConversationHistoryItem])] = [:]

        for item in sorted {
            let sectionKey = item.isPinned ? .pinned : sectionKeyForDate(item.createdAt, now: now, calendar: calendar)
            let bucketID = sectionKey.id

            if buckets[bucketID] == nil {
                buckets[bucketID] = (sectionKey, [item])
            } else {
                buckets[bucketID]?.entries.append(item)
            }
        }

        let sectionTitleFormatter = DateFormatter()
        sectionTitleFormatter.calendar = calendar
        sectionTitleFormatter.locale = Locale(identifier: "pl_PL")
        sectionTitleFormatter.setLocalizedDateFormatFromTemplate("d MMMM")

        return buckets.values
            .map { bucket in
                let sortedEntries = bucket.entries.sorted { left, right in
                    if bucket.key == .pinned, let leftPinned = left.pinnedAt, let rightPinned = right.pinnedAt, leftPinned != rightPinned {
                        return leftPinned > rightPinned
                    }
                    return left.updatedAt > right.updatedAt
                }

                return ConversationHistorySection(
                    key: bucket.key,
                    title: bucket.key.title(using: sectionTitleFormatter),
                    entries: sortedEntries
                )
            }
            .sorted { left, right in
                sectionSortRank(left.key) < sectionSortRank(right.key)
            }
    }

    static func sectionSortRank(_ key: ConversationHistorySectionKey) -> Int {
        switch key {
        case .pinned:
            return -1
        case .today:
            return 0
        case .yesterday:
            return 1
        case .older(let date):
            return 2_000_000_000 - Int(date.timeIntervalSince1970)
        }
    }

    static func sectionKeyForDate(_ date: Date, now: Date, calendar: Calendar) -> ConversationHistorySectionKey {
        if calendar.isDate(date, inSameDayAs: now) {
            return .today
        }

        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return .yesterday
        }

        let startOfDay = calendar.startOfDay(for: date)
        return .older(startOfDay)
    }
}

/// A caregiver's new conversation name as sent to the server: one line, whitespace collapsed, at most 80 characters
/// (the server's limit); nil when nothing is left.
public enum ConversationTitleDraft {
    public static let maxLength = 80

    public static func normalized(_ draft: String) -> String? {
        let collapsed = draft
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        guard !collapsed.isEmpty else {
            return nil
        }
        return String(collapsed.prefix(maxLength)).trimmingCharacters(in: .whitespaces)
    }
}
