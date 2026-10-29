import Combine
import Foundation

/// GET /v1/patients/{patientId}/notifications: pushes sent for the patient, newest first.
public struct NotificationHistoryResponse: Codable, Equatable {
    public let patient_id: String
    public let items: [NotificationHistoryItem]

    public init(patient_id: String, items: [NotificationHistoryItem]) {
        self.patient_id = patient_id
        self.items = items
    }
}

public struct NotificationHistoryItem: Codable, Equatable, Identifiable {
    public let id: String
    public let type: String
    public let title: String
    public let body: String
    public let sent_at: String
    public let payload: NotificationHistoryPayload

    public init(id: String, type: String, title: String, body: String, sent_at: String, payload: NotificationHistoryPayload) {
        self.id = id
        self.type = type
        self.title = title
        self.body = body
        self.sent_at = sent_at
        self.payload = payload
    }

    public var sentAt: Date? {
        NotificationHistoryDate.parse(sent_at)
    }
}

/// The push's "gluco" dictionary as the server sent it.
public struct NotificationHistoryPayload: Codable, Equatable {
    public let type: String
    public let patientId: String?
    public let conversationId: String?
    public let questionId: String?
    public let mealId: String?
    /// Rescue carbs alerts only (`rescue_carbs`).
    public var alertId: String? = nil
    public let routePath: String?
    public let universalLink: String?

    public init(
        type: String,
        patientId: String? = nil,
        conversationId: String? = nil,
        questionId: String? = nil,
        mealId: String? = nil,
        alertId: String? = nil,
        routePath: String? = nil,
        universalLink: String? = nil
    ) {
        self.type = type
        self.patientId = patientId
        self.conversationId = conversationId
        self.questionId = questionId
        self.mealId = mealId
        self.alertId = alertId
        self.routePath = routePath
        self.universalLink = universalLink
    }

    /// The same userInfo as the tapped push, so opening from the bell goes through the push routing.
    public var pushUserInfo: [AnyHashable: Any] {
        var gluco: [String: Any] = ["type": type]
        let fields: [(String, String?)] = [
            ("patientId", patientId),
            ("conversationId", conversationId),
            ("questionId", questionId),
            ("mealId", mealId),
            ("alertId", alertId),
            ("routePath", routePath),
            ("universalLink", universalLink),
        ]
        for (key, value) in fields {
            if let value {
                gluco[key] = value
            }
        }
        return ["gluco": gluco]
    }
}

/// What the caregiver has read on this phone, per patient: everything sent up to "Oznacz wszystkie jako przeczytane"
/// (or the last opening of the bell before rows were read one by one), plus the rows opened since.
public struct NotificationSeenStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func lastSeen(patientID: String) -> Date? {
        defaults.object(forKey: key(patientID)) as? Date
    }

    public func setLastSeen(_ date: Date, patientID: String) {
        defaults.set(date, forKey: key(patientID))
    }

    public func readIDs(patientID: String) -> [String] {
        defaults.stringArray(forKey: readKey(patientID)) ?? []
    }

    public func setReadIDs(_ ids: [String], patientID: String) {
        defaults.set(ids, forKey: readKey(patientID))
    }

    private func key(_ patientID: String) -> String {
        "gluco.notifications.lastSeen.\(patientID)"
    }

    private func readKey(_ patientID: String) -> String {
        "gluco.notifications.readIDs.\(patientID)"
    }
}

@MainActor
public final class NotificationHistoryViewModel: ObservableObject {
    @Published public private(set) var items: [NotificationHistoryItem] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorMessage: String?
    /// An unread row in the list: the bell's dot. The server leaves out what was already done (a described meal, WBT
    /// given), so only the requests still waiting and the news stay.
    @Published public private(set) var hasUnseen = false
    @Published private var readCutoff: Date = .distantPast
    @Published private var readIDs: Set<String> = []

    public let patientID: String
    private let apiClient: APIClient
    private let seenStore: NotificationSeenStore
    /// One list for every tab's bell: a read in flight serves every caller that asks meanwhile.
    private var inFlight: Task<Void, Never>?
    private var lastReadAt: Date?
    private var liveUpdates: LiveUpdates?
    private var liveSubscription: AnyCancellable?

    public init(apiClient: APIClient, patientID: String, seenStore: NotificationSeenStore = NotificationSeenStore()) {
        self.apiClient = apiClient
        self.patientID = patientID
        self.seenStore = seenStore
        readCutoff = seenStore.lastSeen(patientID: patientID) ?? .distantPast
        readIDs = Set(seenStore.readIDs(patientID: patientID))
    }

    public func refresh() async {
        if let inFlight {
            await inFlight.value
            return
        }
        isLoading = true
        let read = Task { [weak self] in
            guard let self else { return }
            defer {
                self.isLoading = false
                self.inFlight = nil
            }
            do {
                self.items = try await self.apiClient.listNotifications(patientID: self.patientID).items
                self.errorMessage = nil
                self.lastReadAt = Date()
            } catch {
                // The last list stays: a network error does not empty the bell.
                self.errorMessage = "Nie udało się wczytać powiadomień"
            }
            self.updateUnseen()
        }
        inFlight = read
        await read.value
    }

    /// A tab appearing or the app coming back: read only when the list is older than `maxAge` (each tab's bell asks).
    public func refreshIfStale(maxAge: TimeInterval = 30, now: Date = Date()) async {
        if let lastReadAt, now.timeIntervalSince(lastReadAt) < maxAge, inFlight == nil {
            return
        }
        await refresh()
    }

    /// A new notification for either caregiver appears in the list (and the bell's dot) right away; one whose request
    /// either caregiver just did (a meal described, a dose given, an entry answered) leaves it. Subscribed once,
    /// however many tabs show the bell.
    public func bindLiveUpdates(_ live: LiveUpdates?) {
        guard live !== liveUpdates else { return }
        liveUpdates = live
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: Self.liveKinds) }
            // A meal or a conversation changes in bursts (a sync, an answer being written): one read after them.
            .debounce(for: .seconds(1), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { await self?.refresh() }
            }
    }

    /// The changes that add a notification or settle what one asked for.
    static let liveKinds: Set<String> = ["notifications", "meal", "meals", "loop_action", "conversation", "hypo", "remote_command"]

    public func isNew(_ item: NotificationHistoryItem) -> Bool {
        guard let sentAt = item.sentAt else {
            return false
        }
        return sentAt > readCutoff && !readIDs.contains(item.id)
    }

    /// The row was opened.
    public func markRead(_ item: NotificationHistoryItem) {
        guard isNew(item) else { return }
        readIDs.insert(item.id)
        // Only rows still listed are kept, so the stored set stays small.
        seenStore.setReadIDs(items.map(\.id).filter(readIDs.contains), patientID: patientID)
        updateUnseen()
    }

    /// "Oznacz wszystkie jako przeczytane": everything sent until now; a later push lights the dot again.
    public func markAllRead(now: Date = Date()) {
        let newest = items.compactMap(\.sentAt).max()
        readCutoff = max(newest ?? now, now)
        readIDs = []
        seenStore.setLastSeen(readCutoff, patientID: patientID)
        seenStore.setReadIDs([], patientID: patientID)
        updateUnseen()
    }

    private func updateUnseen() {
        hasUnseen = items.contains(where: isNew)
    }
}

enum NotificationHistoryDate {
    static func parse(_ value: String) -> Date? {
        ServerDate.parse(value)
    }
}
