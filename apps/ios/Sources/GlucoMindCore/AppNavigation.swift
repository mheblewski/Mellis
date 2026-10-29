import Foundation
import SwiftUI

/// Where a notification (push, the bell's list, a universal link or the app's own remote command notifications) leads.
public enum AppRoute: Equatable {
    /// A conversation: a question card, a hypo screen or a rescue carbs alert.
    case conversation(ConversationRoute)
    /// A meal, its WBT screen or the second part of its split bolus.
    case meal(MealRoute)
    /// The Bolus tab: the app's notifications about a remote command (sent, no answer, result).
    case remoteCommands(patientID: String)
    /// Only the patient (a reminder with neither a conversation nor a meal, routePath /patients/{id}): the app switches
    /// to them and opens their start screen (audit 2026-10-26: such a tap did nothing, not even switch the patient).
    case patient(patientID: String)
    /// The patient's equipment list on the dashboard (the home-screen widget's equipment field).
    case equipment(patientID: String)

    public var patientID: String {
        switch self {
        case let .conversation(route): route.patientID
        case let .meal(route): route.patientID
        case let .remoteCommands(patientID): patientID
        case let .patient(patientID): patientID
        case let .equipment(patientID): patientID
        }
    }

    /// Key of the app's own remote command notifications (they carry the patient, not a `gluco` payload).
    public static let localNotificationKey = "gluco_local"
    public static let localRemoteCommand = "remote_command"
    /// The server's push about a low reservoir (reservoir-alerts.v1).
    public static let reservoirPushType = "reservoir_low"

    /// The payload of the app's remote command notifications: a tap opens the patient's Bolus tab.
    public static func remoteCommandPayload(patientID: String) -> [AnyHashable: Any] {
        [localNotificationKey: localRemoteCommand, "patientId": patientID]
    }

    public static func parse(pushPayload userInfo: [AnyHashable: Any]) -> AppRoute? {
        if userInfo[localNotificationKey] as? String == localRemoteCommand {
            guard let patientID = userInfo["patientId"] as? String, UUID(uuidString: patientID) != nil else { return nil }
            return .remoteCommands(patientID: patientID)
        }
        // Little insulin in the reservoir (reservoir-alerts.v1): its link is the equipment list (routePath, the patient,
        // is what older builds open).
        if let gluco = userInfo["gluco"] as? [String: Any], gluco["type"] as? String == reservoirPushType,
           let link = (gluco["universalLink"] as? String).flatMap(URL.init(string:)).flatMap(HomeWidgetLink.parse) {
            return link.route
        }
        if let route = MealLinkParser.parsePushPayload(userInfo: userInfo) {
            return .meal(route)
        }
        if let route = PushPayloadParser.parseConversationRoute(userInfo: userInfo) {
            return .conversation(route)
        }
        if let patientID = PatientLinkParser.parsePushPayload(userInfo: userInfo) {
            return .patient(patientID: patientID)
        }
        return nil
    }

    public static func parse(universalLink url: URL) -> AppRoute? {
        if let link = HomeWidgetLink.parse(url) {
            return link.route
        }
        if let route = MealLinkParser.parse(url) {
            return .meal(route)
        }
        if let route = UniversalLinkParser.parse(url) {
            return .conversation(route)
        }
        if let patientID = PatientLinkParser.parse(url) {
            return .patient(patientID: patientID)
        }
        return nil
    }
}

/// Holds the route of the last tapped notification until it can be shown: the caregiver is signed in and the patient
/// is one they may see (checked on the patient list already loaded; the server is asked only for a patient missing
/// from it). A failed sign-in or patient list keeps the route for the next attempt instead of dropping it.
@MainActor
public final class PendingRouteCoordinator {
    public enum Outcome: Equatable {
        case delivered
        case nothingPending
        case waitingForSignIn
        case waitingForPatients
        /// A newer route arrived while this one was checked.
        case superseded
        case rejected
    }

    public private(set) var pending: AppRoute?
    private let isSignedIn: () async -> Bool
    private let knownPatientIDs: () -> [String]?
    private let refreshPatientIDs: () async throws -> [String]
    private let deliver: (AppRoute) -> Void

    /// `knownPatientIDs`: the patient list on screen, nil while it is being loaded (`resume()` runs once it is).
    public init(
        isSignedIn: @escaping () async -> Bool,
        knownPatientIDs: @escaping () -> [String]?,
        refreshPatientIDs: @escaping () async throws -> [String],
        deliver: @escaping (AppRoute) -> Void
    ) {
        self.isSignedIn = isSignedIn
        self.knownPatientIDs = knownPatientIDs
        self.refreshPatientIDs = refreshPatientIDs
        self.deliver = deliver
    }

    /// A newer notification replaces one still waiting.
    @discardableResult
    public func receive(_ route: AppRoute) async -> Outcome {
        pending = route
        return await resume()
    }

    /// Tries the waiting route again: after a sign-in, once the patient list is loaded, on every return to the app.
    @discardableResult
    public func resume() async -> Outcome {
        guard let route = pending else { return .nothingPending }
        guard await isSignedIn() else {
            NSLog("[PUSH-TAP] route waits for sign-in patientId=%@", route.patientID)
            return pending == route ? .waitingForSignIn : .superseded
        }
        guard pending == route else { return .superseded }

        guard let known = knownPatientIDs() else {
            NSLog("[PUSH-TAP] route waits for the patient list patientId=%@", route.patientID)
            return .waitingForPatients
        }
        var patientIDs = known
        if !Self.contains(patientIDs, route.patientID) {
            do {
                patientIDs = try await refreshPatientIDs()
            } catch {
                NSLog("[PUSH-TAP] route kept, patient list failed patientId=%@ error=%@", route.patientID, String(describing: error))
                return pending == route ? .waitingForPatients : .superseded
            }
            guard pending == route else { return .superseded }
        }

        pending = nil
        guard Self.contains(patientIDs, route.patientID) else {
            NSLog("[PUSH-TAP] route rejected, no access patientId=%@", route.patientID)
            return .rejected
        }
        NSLog("[PUSH-TAP] route delivered patientId=%@", route.patientID)
        deliver(route)
        return .delivered
    }

    public func clear() {
        pending = nil
    }

    static func contains(_ patientIDs: [String], _ patientID: String) -> Bool {
        patientIDs.contains { $0.caseInsensitiveCompare(patientID) == .orderedSame }
    }
}

// MARK: - Closing what covers the screen

/// Which sheets are open, so a notification knows whether it has to wait for them to close before its screen opens
/// one of its own (two sheets presented at once: the second is dropped).
@MainActor
public final class NotificationModalTracker {
    private var open: Set<UUID> = []

    public init() {}

    public var hasOpenModal: Bool { !open.isEmpty }

    /// Every sheet is being closed for a notification: one whose view went away while it was open is forgotten too
    /// (a sheet opened later registers again).
    public func forgetAll() {
        open.removeAll()
    }

    func set(_ id: UUID, presented: Bool) {
        if presented {
            open.insert(id)
        } else {
            open.remove(id)
        }
    }
}

private struct NotificationDismissalKey: EnvironmentKey {
    static let defaultValue = 0
}

private struct NotificationModalTrackerKey: EnvironmentKey {
    static let defaultValue: NotificationModalTracker? = nil
}

public extension EnvironmentValues {
    /// Grows each time a notification opens a screen: every sheet, cover or picker on screen closes.
    var notificationDismissal: Int {
        get { self[NotificationDismissalKey.self] }
        set { self[NotificationDismissalKey.self] = newValue }
    }

    var notificationModalTracker: NotificationModalTracker? {
        get { self[NotificationModalTrackerKey.self] }
        set { self[NotificationModalTrackerKey.self] = newValue }
    }
}

public extension View {
    /// The sheet this view presents closes when a notification opens another screen; `close` ends the presentation.
    func closesForNotification(isPresented: Bool, close: @escaping () -> Void) -> some View {
        modifier(CloseForNotification(isPresented: isPresented, close: close))
    }
}

private struct CloseForNotification: ViewModifier {
    let isPresented: Bool
    let close: () -> Void
    @Environment(\.notificationDismissal) private var dismissal
    @Environment(\.notificationModalTracker) private var tracker
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented, initial: true) { _, presented in
                tracker?.set(id, presented: presented)
            }
            .onChange(of: dismissal) { _, _ in
                if isPresented {
                    close()
                }
            }
    }
}
