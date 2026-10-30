import Foundation

/// "Jeszcze jeden krok" (1.0.5, owner 2026-10-30): this phone has the patient's Trio / Loop settings ready (handed over
/// with "Zapisz", or typed in), but the person's remote bolus is not usable from it yet, and nothing said so. The sheet
/// says what is missing and starts the existing flow: an owner turns it on for themself, a waiting grant is confirmed
/// with Face ID, this phone gets its bolus key; someone else's grant only the owner can turn on.
/// Shown once per patient and settings save (`settingsStamp`), not on every launch.
public enum RemoteBolusNextStep: String, Equatable, Sendable {
    /// An owner without a grant: enableRemoteBolusForSelf() (the grant, then Face ID).
    case enableForSelf
    /// Granted, waiting for this person's Face ID: confirmRemoteBolus().
    case confirm
    /// On for the person, but this phone has no bolus key yet: confirmRemoteBolus() too.
    case setUpThisPhone
    /// Not an owner and no grant: the owner turns it on (Osoby i udostępnianie).
    case askOwner

    /// Nil: nothing to do (remote bolus works here, or this phone could not use it anyway: no Face ID / Touch ID).
    public static func decide(isOwner: Bool, state: RemoteBolusGrantState, phoneReady: Bool, biometrics: Bool) -> RemoteBolusNextStep? {
        switch state {
        case .off:
            if !isOwner { return .askOwner }
            return biometrics ? .enableForSelf : nil
        case .awaitingConfirmation:
            return biometrics ? .confirm : nil
        case .on:
            return phoneReady || !biometrics ? nil : .setUpThisPhone
        }
    }

    public static let title = "Jeszcze jeden krok"

    /// The sheet's text: "Ustawienia Trio dla: Zosia są zapisane na tym telefonie. …".
    public func message(loopName: String, patientName: String) -> String {
        let saved = "Ustawienia \(loopName) dla: \(patientName) są zapisane na tym telefonie."
        switch self {
        case .askOwner:
            return "\(saved) Właściciel musi jeszcze włączyć Ci zdalny bolus (Osoby i udostępnianie)."
        case .enableForSelf, .confirm, .setUpThisPhone:
            return "\(saved) Żeby wysyłać bolusy, potwierdź zdalny bolus Face ID."
        }
    }

    /// "Włącz teraz" and "Później"; only "OK" when the owner has to act.
    public var canActHere: Bool { self != .askOwner }

    /// The settings save the sheet is about: the patient, the loop and when its Trio / Loop was confirmed (pinned). A new
    /// save (a new hand-off, the Trio confirmed again) is a new stamp; limits changed later are not. Nil: no complete
    /// settings for the patient on this phone.
    public static func settingsStamp(patientID: String, trio: TrioRemoteSettings?, loop: LoopRemoteSettings?, glucoMindTeamID: String, prefersLoop: Bool) -> (loopName: String, stamp: String)? {
        let id = patientID.lowercased()
        let trioStamp: (String, String)? = trio.flatMap { settings in
            guard settings.isComplete(glucoMindTeamID: glucoMindTeamID), let pinned = settings.pinnedTrio else { return nil }
            return ("Trio", "trio:\(id):\(pinned.tokenHash):\(Int(pinned.pinnedAt.timeIntervalSince1970))")
        }
        let loopStamp: (String, String)? = loop.flatMap { settings in
            guard settings.isComplete(glucoMindTeamID: glucoMindTeamID), let pinned = settings.pinnedLoop else { return nil }
            return ("Loop", "loop:\(id):\(pinned.tokenHash):\(Int(pinned.pinnedAt.timeIntervalSince1970))")
        }
        let picked = prefersLoop ? (loopStamp ?? trioStamp) : (trioStamp ?? loopStamp)
        return picked.map { (loopName: $0.0, stamp: $0.1) }
    }
}

/// Which "Jeszcze jeden krok" sheets this phone has shown (one per settings stamp).
public protocol RemoteBolusNextStepPromptStore {
    func wasShown(_ stamp: String) -> Bool
    func markShown(_ stamp: String)
}

public final class UserDefaultsRemoteBolusNextStepPromptStore: RemoteBolusNextStepPromptStore {
    private let defaults: UserDefaults
    private static let key = "mellis.remoteBolusNextStep.shown"
    /// Old stamps are dropped beyond this many (a phone with a few patients and settings saves).
    private static let limit = 40

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func wasShown(_ stamp: String) -> Bool {
        (defaults.stringArray(forKey: Self.key) ?? []).contains(stamp)
    }

    public func markShown(_ stamp: String) {
        var shown = defaults.stringArray(forKey: Self.key) ?? []
        guard !shown.contains(stamp) else { return }
        shown.append(stamp)
        defaults.set(Array(shown.suffix(Self.limit)), forKey: Self.key)
    }
}

/// The sheet's request: whose settings, which loop, what to do.
public struct RemoteBolusNextStepRequest: Identifiable, Equatable, Sendable {
    public let patientID: String
    public let patientName: String
    public let loopName: String
    public let step: RemoteBolusNextStep
    public let stamp: String

    public var id: String { stamp }

    public init(patientID: String, patientName: String, loopName: String, step: RemoteBolusNextStep, stamp: String) {
        self.patientID = patientID
        self.patientName = patientName
        self.loopName = loopName
        self.step = step
        self.stamp = stamp
    }

    public var message: String { step.message(loopName: loopName, patientName: patientName) }
}
