import Foundation

@MainActor
public final class RemoteNotificationInbox {
    public static let shared = RemoteNotificationInbox()

    /// Copies of one tap closer together than this are one tap (a cold launch hands the payload over twice); the same
    /// notification opened again later (the bell, a second tap) opens again.
    public static let duplicateWindow: TimeInterval = 10
    /// How long the cold launch copy (launch options) waits for the delegate's copy, which also says which notification
    /// button was used.
    public static let launchCopyGrace: TimeInterval = 1.5

    private var pendingPayloads: [[AnyHashable: Any]] = []
    private var recentPayloadEventIDs: [String: Date] = [:]
    private var launchCopy: (payload: [AnyHashable: Any], tapID: String?)?
    private var pendingDeviceTokens: [Data] = []
    private var payloadListener: (([AnyHashable: Any]) -> Void)?
    private var deviceTokenListener: ((Data) -> Void)?
    var now: () -> Date = Date.init
    var launchCopyDelay: TimeInterval = RemoteNotificationInbox.launchCopyGrace

    private init() {}

    /// A tapped notification (the notification center delegate), or a payload delivered while the app is open.
    public func receivePushPayload(_ userInfo: [AnyHashable: Any]) {
        guard !userInfo.isEmpty else {
            return
        }

        // The cold launch copy of the same tap: the delegate's copy wins.
        let tapID = payloadEventID(from: userInfo)
        if let launchCopy, launchCopy.tapID == tapID {
            self.launchCopy = nil
        }

        let conversationID = conversationID(from: userInfo)

        if let eventID = tapID {
            let current = now()
            forgetOldTaps(now: current)
            guard recentPayloadEventIDs[eventID] == nil else {
                NSLog("[PUSH-TAP] 05 inbox deduped conversationId=%@", conversationID)
                return
            }

            recentPayloadEventIDs[eventID] = current
        }

        NSLog("[PUSH-TAP] 05 inbox accepted conversationId=%@", conversationID)

        if let payloadListener {
            payloadListener(userInfo)
            return
        }

        pendingPayloads.append(userInfo)
    }

    /// The payload of the notification that launched the app (launch options). The delegate hands the same tap over
    /// right after, with the notification button used; this copy opens only when that one does not come.
    public func receiveLaunchPayload(_ userInfo: [AnyHashable: Any]) {
        guard !userInfo.isEmpty else {
            return
        }

        let tapID = payloadEventID(from: userInfo)
        forgetOldTaps(now: now())
        // The delegate's copy came first: this tap is open already.
        if let tapID, recentPayloadEventIDs[tapID] != nil {
            return
        }

        launchCopy = (userInfo, tapID)
        let delay = launchCopyDelay
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            self?.flushLaunchCopy()
        }
    }

    func flushLaunchCopy() {
        guard let launchCopy else {
            return
        }

        self.launchCopy = nil
        NSLog("[PUSH-TAP] 05 inbox uses the launch copy conversationId=%@", conversationID(from: launchCopy.payload))
        receivePushPayload(launchCopy.payload)
    }

    public func receiveDeviceToken(_ token: Data) {
        guard !token.isEmpty else {
            return
        }

        if let deviceTokenListener {
            deviceTokenListener(token)
            return
        }

        pendingDeviceTokens.append(token)
    }

    public func bind(
        onPushPayload: @escaping ([AnyHashable: Any]) -> Void,
        onDeviceToken: @escaping (Data) -> Void
    ) {
        payloadListener = onPushPayload
        deviceTokenListener = onDeviceToken

        let queuedPayloads = pendingPayloads
        let queuedTokens = pendingDeviceTokens
        pendingPayloads.removeAll(keepingCapacity: false)
        pendingDeviceTokens.removeAll(keepingCapacity: false)

        for payload in queuedPayloads {
            NSLog("[PUSH-TAP] 07 inbox replay conversationId=%@", conversationID(from: payload))
            onPushPayload(payload)
        }

        for token in queuedTokens {
            onDeviceToken(token)
        }
    }

    #if DEBUG
    public func resetForTesting() {
        pendingPayloads.removeAll(keepingCapacity: false)
        recentPayloadEventIDs.removeAll(keepingCapacity: false)
        launchCopy = nil
        pendingDeviceTokens.removeAll(keepingCapacity: false)
        payloadListener = nil
        deviceTokenListener = nil
        now = Date.init
        launchCopyDelay = Self.launchCopyGrace
    }
    #endif

    private func forgetOldTaps(now current: Date) {
        recentPayloadEventIDs = recentPayloadEventIDs.filter { current.timeIntervalSince($0.value) < Self.duplicateWindow }
    }

    private func payloadEventID(from userInfo: [AnyHashable: Any]) -> String? {
        guard let gluco = userInfo["gluco"] as? [String: Any] else {
            return nil
        }

        guard let type = normalizedString(gluco["type"]), !type.isEmpty else {
            return nil
        }

        let patientID = normalizedString(gluco["patientId"])
        let conversationID = normalizedString(gluco["conversationId"])
        let questionID = normalizedString(gluco["questionId"])
        // Meal pushes (meal_description, wbt_reminder) carry no conversation: without the meal, every later reminder
        // for another meal would be deduped as the first one.
        let mealID = normalizedString(gluco["mealId"])
        // Two split boluses of one meal are two reminders.
        let plannedBolusID = normalizedString(gluco["plannedBolusId"]).map { "|plan=\($0)" } ?? ""
        // Loop action pushes: one per action.
        let actionID = normalizedString(gluco["actionId"])
        // A rescue carbs alert and its one reminder share the conversation and the alert: the reminder's title
        // ("… (przypomnienie)") tells them apart, while the cold launch copies of one push stay equal.
        let alert = type == "rescue_carbs" ? "|alert=\(normalizedString(gluco["alertId"]) ?? "")|title=\(alertTitle(from: userInfo) ?? "")" : ""
        // Two reminders (or two answers) of one conversation are two taps (audit 2026-10-26): the reminder's, the
        // message's or the command's id when the push has one; an answer push without an id is told apart by its text,
        // which the cold launch copies of one push share.
        let ids = [("reminder", "reminderId"), ("message", "messageId"), ("command", "commandId")]
            .compactMap { label, key in normalizedString(gluco[key]).map { "|\(label)=\($0)" } }
            .joined()
        let answerText = PushPayloadParser.answerReadyPushTypes.contains(type) && ids.isEmpty
            ? "|text=\(alertTitle(from: userInfo) ?? "")/\(alertBody(from: userInfo) ?? "")"
            : ""

        if patientID != nil || conversationID != nil || questionID != nil || mealID != nil || actionID != nil {
            return "type=\(type)|patient=\(patientID ?? "")|conversation=\(conversationID ?? "")|question=\(questionID ?? "")|meal=\(mealID ?? "")|action=\(actionID ?? "")\(plannedBolusID)\(alert)\(ids)\(answerText)"
        }

        if let routePath = normalizedString(gluco["routePath"]), !routePath.isEmpty {
            return "type=\(type)|routePath=\(routePath)"
        }

        if let universalLink = normalizedString(gluco["universalLink"]), !universalLink.isEmpty {
            return "type=\(type)|universalLink=\(universalLink)"
        }

        return "type=\(type)"
    }

    private func alertTitle(from userInfo: [AnyHashable: Any]) -> String? {
        guard let aps = userInfo["aps"] as? [String: Any] else { return nil }
        if let alert = aps["alert"] as? [String: Any] {
            return normalizedString(alert["title"])
        }
        return normalizedString(aps["alert"])
    }

    private func alertBody(from userInfo: [AnyHashable: Any]) -> String? {
        guard let aps = userInfo["aps"] as? [String: Any], let alert = aps["alert"] as? [String: Any] else { return nil }
        return normalizedString(alert["body"])
    }

    private func normalizedString(_ value: Any?) -> String? {
        guard let value = value as? String else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func conversationID(from userInfo: [AnyHashable: Any]) -> String {
        guard let gluco = userInfo["gluco"] as? [String: Any] else {
            return "n/a"
        }

        return normalizedString(gluco["conversationId"]) ?? "n/a"
    }
}