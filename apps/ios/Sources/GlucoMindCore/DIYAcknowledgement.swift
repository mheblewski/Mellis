import Foundation

/// The medical-safety acknowledgement (docs-site instalacja): Mellis is a DIY project, not a medical device. Accepted
/// once on each phone before pairing completes, and once before the first remote bolus from it; remembered per phone
/// (UserDefaults), never sent anywhere except as the signed timestamp of a remote bolus grant confirmation.
public enum DIYAcknowledgement {
    public static let notice = "Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje o leczeniu podejmujesz Ty."
    /// The confirm button / toggle.
    public static let acceptTitle = "Rozumiem i akceptuję"
    /// Under a confirmation that counts as accepting it (the remote bolus grant, confirmed with Face ID).
    public static let confirmingAccepts = "Potwierdzając, akceptujesz: \(notice)"
    /// A dose or a pairing tried before the acceptance (the UI keeps them off, so this is only the last guard).
    public static let requiredMessage = "Najpierw potwierdź, że rozumiesz: Mellis to projekt DIY, nie wyrób medyczny."

    public enum Scope: String, CaseIterable, Sendable {
        /// Before this phone pairs with a server (a QR code, a link, a recovery code).
        case pairing
        /// Before the first remote bolus (or rescue carbs) is sent from this phone.
        case remoteBolus = "remote-bolus"
    }
}

public enum DIYAcknowledgementError: Error, Equatable {
    case notAccepted

    public var message: String { DIYAcknowledgement.requiredMessage }
}

/// Where this phone remembers the acceptance.
public protocol DIYAcknowledgementStoring: AnyObject {
    func acceptedAt(_ scope: DIYAcknowledgement.Scope) -> Date?
    func accept(_ scope: DIYAcknowledgement.Scope, at date: Date)
}

public extension DIYAcknowledgementStoring {
    func isAccepted(_ scope: DIYAcknowledgement.Scope) -> Bool { acceptedAt(scope) != nil }

    func accept(_ scope: DIYAcknowledgement.Scope) { accept(scope, at: Date()) }

    /// Accepted earlier keeps its first date.
    func acceptIfNeeded(_ scope: DIYAcknowledgement.Scope, at date: Date = Date()) {
        if !isAccepted(scope) { accept(scope, at: date) }
    }
}

/// The app's store: one key per scope in UserDefaults (this phone only; removed with the app).
public final class UserDefaultsDIYAcknowledgementStore: DIYAcknowledgementStoring {
    public static func key(_ scope: DIYAcknowledgement.Scope) -> String { "mellis.diy-acknowledgement.\(scope.rawValue).v1" }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func acceptedAt(_ scope: DIYAcknowledgement.Scope) -> Date? {
        let seconds = defaults.double(forKey: Self.key(scope))
        return seconds > 0 ? Date(timeIntervalSince1970: seconds) : nil
    }

    public func accept(_ scope: DIYAcknowledgement.Scope, at date: Date) {
        defaults.set(date.timeIntervalSince1970, forKey: Self.key(scope))
    }
}

/// Tests and previews.
public final class InMemoryDIYAcknowledgementStore: DIYAcknowledgementStoring {
    private var accepted: [DIYAcknowledgement.Scope: Date] = [:]

    public init(accepted scopes: [DIYAcknowledgement.Scope] = [], at date: Date = Date()) {
        for scope in scopes { accepted[scope] = date }
    }

    public func acceptedAt(_ scope: DIYAcknowledgement.Scope) -> Date? { accepted[scope] }

    public func accept(_ scope: DIYAcknowledgement.Scope, at date: Date) { accepted[scope] = date }
}
