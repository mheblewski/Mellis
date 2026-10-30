import Foundation

/// Settings → pacjent → Zdalny bolus: what the "Ty i ten telefon" section offers and the footers of the page, decided
/// from who the person is (owner or not), their grant, this phone's bolus key and Face ID.
public enum RemoteBolusPersonAction: Equatable, Sendable {
    /// An owner without a grant: "Włącz zdalny bolus dla siebie" grants it and confirms it with Face ID in one go.
    case enableForSelf
    /// Granted, not confirmed yet: the Face ID confirmation.
    case confirm
    /// On for the person, but this phone has no bolus key yet.
    case setUpThisPhone
    case none
}

public enum RemoteBolusSettingsText {
    public static let enableForSelfButton = "Włącz zdalny bolus dla siebie"

    public static func confirmButton(patientName: String) -> String {
        "Chcę podawać bolus zdalnie dla: \(patientName)"
    }

    public static let setUpThisPhoneButton = "Ustaw na tym telefonie"

    /// Someone else turns remote bolus on for a member.
    public static let memberOff = "Zdalny bolus włącza Ci właściciel (Osoby i udostępnianie). Potem potwierdzisz go tu Face ID."

    /// An owner gives it to themself here.
    public static let ownerOff = "Jako właściciel włączasz go sobie tutaj. Po potwierdzeniu Face ID ten telefon utworzy swój klucz do bolusa."

    public static func personAction(isOwner: Bool, state: RemoteBolusGrantState?, phoneReady: Bool, biometrics: Bool) -> RemoteBolusPersonAction {
        // Without Face ID / Touch ID no bolus key can exist: nothing to start here.
        guard biometrics else { return .none }
        switch state {
        case .some(.off): return isOwner ? .enableForSelf : .none
        case .some(.awaitingConfirmation): return .confirm
        case .some(.on): return phoneReady ? .none : .setUpThisPhone
        case .none: return .none
        }
    }

    /// The footer of "Ty i ten telefon".
    public static func personFooter(isOwner: Bool, state: RemoteBolusGrantState?, phoneReady: Bool, biometrics: Bool) -> String {
        switch state {
        case .some(.off):
            guard isOwner else { return memberOff }
            return biometrics ? "\(ownerOff)\n\n\(DIYAcknowledgement.confirmingAccepts)" : DeviceBiometrics.unavailableMessage
        case .some(.awaitingConfirmation):
            guard biometrics else { return DeviceBiometrics.unavailableMessage }
            let lead = isOwner
                ? "Zdalny bolus jest dla Ciebie włączony, ale czeka na potwierdzenie."
                : "Właściciel włączył Ci zdalny bolus."
            return "\(lead) Potwierdź go Face ID: ten telefon utworzy wtedy swój klucz do bolusa i dopiero potem polecenia zadziałają.\n\n\(DIYAcknowledgement.confirmingAccepts)"
        case .some(.on) where !phoneReady:
            return biometrics
                ? "Zdalny bolus jest dla Ciebie włączony, ale ten telefon nie ma jeszcze klucza do bolusa (inny telefon albo zmiana Face ID). Ustaw go Face ID.\n\n\(DIYAcknowledgement.confirmingAccepts)"
                : DeviceBiometrics.unavailableMessage
        case .some(.on):
            return "\(SettingsText.onThisPhone) Każde polecenie potwierdzasz Face ID; klucz do bolusa nie opuszcza telefonu."
        case .none:
            return SettingsText.onThisPhone
        }
    }

    /// The footer of "Pętla i ten telefon". `isOwner` and `grant` are nil while unknown (or outside device mode).
    public static func loopFooter(remoteCommands: RemoteCommandsAccess, isOwner: Bool?, grant: RemoteBolusGrantState?) -> String {
        if remoteCommands.enabled {
            return remoteCommands.sendsToLoop
                ? "\(SettingsText.onThisPhone) Polecenia do Loopa wysyła ten telefon. Ostatnie słowo ma zawsze Loop: wyłączenie zdalnych poleceń w Loopie zatrzymuje każde polecenie."
                : "\(SettingsText.onThisPhone) Polecenia do Trio wysyła ten telefon. Ostatnie słowo ma zawsze Trio: wyłączenie Remote Control w Trio zatrzymuje każde polecenie."
        }
        guard remoteCommands.reason == "CAREGIVER_NOT_PERMITTED" else { return remoteCommands.explanation }
        switch (grant, isOwner) {
        case (.some(.awaitingConfirmation), _):
            return "Najpierw potwierdź zdalny bolus Face ID (wyżej)."
        case (.some(.off), .some(true)):
            return "Najpierw włącz zdalny bolus dla siebie (wyżej)."
        case (.some(.off), .some(false)):
            return "Właściciel nie włączył Ci zdalnych poleceń dla tego pacjenta."
        default:
            return remoteCommands.explanation
        }
    }
}
