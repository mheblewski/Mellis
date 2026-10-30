import Foundation

// "Przewodnik konfiguracji": a short guided setup shown once, right after a new pairing (or sign-in) of this phone,
// after the first patient's tabs. Each step is optional and reuses a settings page: remote bolus (Ustawienia →
// <pacjent> → Zdalny bolus), this phone's notifications (Ustawienia → <pacjent> → Powiadomienia) and "Instrukcje dla
// Mellis". Nothing is stored on the server: the "pending" and "seen" marks live on this phone, per server and person.
// Only a pairing / sign-in sets "pending", so an app update over an existing session never shows the guide.

/// One page of the guide, in this order.
public enum SetupGuideStep: String, CaseIterable, Sendable {
    case remoteControl
    case notifications
    case instructions
    case done
}

/// What this person may use, read when the guide opens: only the steps they can use are shown.
public struct SetupGuideAccess: Equatable, Sendable {
    /// The person may set up remote bolus for the patient on screen (an owner, or someone an owner granted it to), and
    /// this phone is not set up yet.
    public var remoteControl: Bool
    /// The patient's loop, named in the remote step's title ("w Trio", "w Loopie"); unknown names both.
    public var loopSystem: LoopSystemKind
    /// The person gets glucose pushes for the patient ("Glukoza i alarmy"): low glucose warnings, the reservoir.
    public var glucoseAlerts: Bool
    /// The person uses the AI ("Rozmowy z AI i posiłki"): the answer-ready push and "Instrukcje dla Mellis".
    public var assistant: Bool
    /// The server has "Instrukcje dla Mellis" (GET /v1/me/ai-preferences answered).
    public var hasAiPreferences: Bool

    public init(remoteControl: Bool, loopSystem: LoopSystemKind = .unknown, glucoseAlerts: Bool = true, assistant: Bool = true, hasAiPreferences: Bool = true) {
        self.remoteControl = remoteControl
        self.loopSystem = loopSystem
        self.glucoseAlerts = glucoseAlerts
        self.assistant = assistant
        self.hasAiPreferences = hasAiPreferences
    }

    /// The steps for this person, "Gotowe" last. Notifications are for everyone (at least the iOS permission).
    public var steps: [SetupGuideStep] {
        var steps: [SetupGuideStep] = []
        if remoteControl { steps.append(.remoteControl) }
        steps.append(.notifications)
        if assistant && hasAiPreferences { steps.append(.instructions) }
        steps.append(.done)
        return steps
    }

    /// Whether the remote step is for this person.
    /// - deviceMode: a paired phone (owners and grants); otherwise the server's answer alone counts.
    /// - isOwner: from the patient's people (nil while unknown, false for a member who may not read them).
    /// - grant: the person's remote bolus grant (nil while unknown).
    /// - setUpOnThisPhone: the loop's remote control is already complete on this phone (nothing left to do).
    public static func allowsRemoteControl(deviceMode: Bool, isOwner: Bool?, grant: RemoteBolusGrantState?, remoteCommands: RemoteCommandsAccess, setUpOnThisPhone: Bool) -> Bool {
        if setUpOnThisPhone && remoteCommands.enabled && grant != .awaitingConfirmation { return false }
        guard deviceMode else { return remoteCommands.enabled }
        // Off for everyone on this server or patient, or a loop that takes no commands: nothing to set up.
        switch remoteCommands.reason {
        case "ENABLED", "CAREGIVER_NOT_PERMITTED": break
        default: return false
        }
        // An owner may give it to themself (Osoby i udostępnianie); anyone else only after an owner granted it.
        if isOwner == true { return true }
        switch grant {
        case .some(.on), .some(.awaitingConfirmation): return true
        case .some(.off), .none: return false
        }
    }
}

/// Where the marks are kept, per server and person on this phone: "pending" (set when this phone was just paired or
/// signed in, cleared once the guide was offered) and "seen" (the guide was shown).
public protocol SetupGuideSeenStoring {
    func hasSeen(_ key: String) -> Bool
    func markSeen(_ key: String)
    func isPending(_ key: String) -> Bool
    func setPending(_ key: String, _ pending: Bool)
}

public struct UserDefaultsSetupGuideSeenStore: SetupGuideSeenStoring {
    static let prefix = "mellis.setupGuide.seen."
    static let pendingPrefix = "mellis.setupGuide.pending."
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func hasSeen(_ key: String) -> Bool { defaults.bool(forKey: Self.prefix + key) }
    public func markSeen(_ key: String) { defaults.set(true, forKey: Self.prefix + key) }
    public func isPending(_ key: String) -> Bool { defaults.bool(forKey: Self.pendingPrefix + key) }
    public func setPending(_ key: String, _ pending: Bool) {
        if pending { defaults.set(true, forKey: Self.pendingPrefix + key) } else { defaults.removeObject(forKey: Self.pendingPrefix + key) }
    }
}

public enum SetupGuideKey {
    /// "mellis.example:443|<user id>": another server or another person on the same phone sees the guide again.
    public static func make(server: URL, userID: String) -> String {
        let host = (server.host ?? server.absoluteString).lowercased()
        let port = server.port.map { ":\($0)" } ?? ""
        return "\(host)\(port)|\(userID.lowercased())"
    }
}

/// The guide's pages and where the person is. A step put off ("Później", "Pomiń") shows where to find it later and
/// counts as seen; the guide as a whole is marked seen as soon as it is shown, so closing it never brings it back.
@MainActor
public final class SetupGuideViewModel: ObservableObject {
    public let steps: [SetupGuideStep]
    public let access: SetupGuideAccess
    /// The patient whose settings the steps open.
    public let patientName: String
    @Published public private(set) var index: Int
    /// Steps put off with "Później" / "Pomiń": the page shows where to change it later.
    @Published public private(set) var postponed: Set<SetupGuideStep> = []
    /// Steps whose settings page was opened from the guide ("Skonfiguruj teraz", the instructions).
    @Published public private(set) var opened: Set<SetupGuideStep> = []
    @Published public private(set) var isClosed = false

    private let store: SetupGuideSeenStoring
    private let key: String?

    /// - key: nil for a guide reopened from Settings or shown by fixtures (it changes no mark).
    public init(access: SetupGuideAccess, patientName: String, store: SetupGuideSeenStoring, key: String?, startAt: SetupGuideStep? = nil) {
        self.access = access
        self.patientName = patientName
        self.steps = access.steps
        self.store = store
        self.key = key
        self.index = startAt.flatMap { access.steps.firstIndex(of: $0) } ?? 0
    }

    /// This phone was just paired with the server (device mode) or signed in to it: the guide is offered once, at the
    /// next dashboard. Never called for a session that already existed (an app update, a launch, a token refresh).
    public static func noteNewPairing(store: SetupGuideSeenStoring, key: String) {
        store.setPending(key, true)
    }

    /// Whether the guide is to be offered now on this phone for this server and person: only after a new pairing /
    /// sign-in, and only if it was not shown to them here before.
    public static func shouldOffer(store: SetupGuideSeenStoring, key: String) -> Bool {
        store.isPending(key) && !store.hasSeen(key)
    }

    /// The offer was decided (shown, or not for this person): the pending mark goes.
    public static func clearPending(store: SetupGuideSeenStoring, key: String) {
        store.setPending(key, false)
    }

    public var current: SetupGuideStep { steps[index] }

    /// "1/3" on the steps, nil on "Gotowe".
    public var progress: (number: Int, total: Int)? {
        let total = steps.filter { $0 != .done }.count
        guard current != .done, total > 0 else { return nil }
        return (index + 1, total)
    }

    public var progressText: String? { progress.map { "\($0.number)/\($0.total)" } }
    public var canGoBack: Bool { index > 0 && !isClosed }

    public func isPostponed(_ step: SetupGuideStep) -> Bool { postponed.contains(step) }
    public func wasOpened(_ step: SetupGuideStep) -> Bool { opened.contains(step) }

    /// The guide is on screen: it is not offered again.
    public func markShown() {
        guard let key else { return }
        store.markSeen(key)
        store.setPending(key, false)
    }

    public func next() {
        guard index < steps.count - 1 else { return close() }
        index += 1
    }

    public func back() {
        guard canGoBack else { return }
        index -= 1
    }

    /// "Później" / "Pomiń": the page stays and says where to do it later; "Dalej" goes on.
    public func postpone() {
        guard current != .done else { return }
        postponed.insert(current)
        markShown()
    }

    /// The step's settings page was opened.
    public func didOpen(_ step: SetupGuideStep) {
        opened.insert(step)
        postponed.remove(step)
    }

    /// X, a swipe down or "Gotowe": seen, nothing more is asked.
    public func close() {
        markShown()
        isClosed = true
    }
}

/// The guide's texts (the screens and tests share them).
public enum SetupGuideText {
    public static let settingsEntry = "Przewodnik konfiguracji"

    public static func remoteTitle(_ loop: LoopSystemKind) -> String {
        switch loop {
        case .trio, .loop: return "Zdalne podawanie insuliny w \(loop.names.locative)"
        default: return "Zdalne podawanie insuliny w Trio / Loop"
        }
    }

    public static func remoteDetail(_ loop: LoopSystemKind, patientName: String) -> String {
        let system: String
        switch loop {
        case .trio, .loop: system = loop.names.genitive
        default: system = "Trio albo Loopa"
        }
        return "Z tego telefonu wyślesz bolus i węglowodany prosto do \(system) (pacjent: \(patientName)). Każde polecenie potwierdzasz Face ID, a ostatnie słowo ma zawsze pętla."
    }

    public static let notificationsTitle = "Powiadomienia"
    public static let notificationsDetail = "Wybierz, o czym Mellis ma Cię powiadamiać na tym telefonie. Każdy telefon i każdy opiekun ma własne ustawienia."
    public static let instructionsTitle = "Instrukcje dla Mellis"
    public static let instructionsDetail = "Napisz, kim jesteś i jak mają wyglądać odpowiedzi. To opcjonalne i działa u każdego pacjenta."
    public static let instructionsExample = "Np. „Jestem tatą, od roku na pętli. Pisz krótko i konkretnie.”"
    public static let doneTitle = "Gotowe"
    public static let doneDetail = "Wszystko z tego przewodnika zmienisz później w Ustawieniach, pod ikoną zębatki."

    /// Where to find a step later (after "Później" / "Pomiń").
    public static func laterNote(_ step: SetupGuideStep, patientName: String) -> String? {
        switch step {
        case .remoteControl: return "Możesz to zrobić później w Ustawieniach → \(patientName) → Zdalny bolus."
        case .notifications: return "Możesz to zmienić później w Ustawieniach → \(patientName) → Powiadomienia: \(patientName)."
        case .instructions: return "Możesz je wpisać później w Ustawieniach → Instrukcje dla Mellis."
        case .done: return nil
        }
    }
}
