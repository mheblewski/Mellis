import Foundation

/// The phone's state when the report was made: settings of the system and of this app, nothing about the patient.
public struct DiagnosticPhoneFacts: Equatable {
    public var appVersion: String
    public var deviceModel: String
    public var systemVersion: String
    public var timeZone: String
    public var utcOffsetMinutes: Int
    public var lowPowerMode: Bool
    public var backgroundRefresh: String
    public var notificationAuthorization: String
    public var notificationAlerts: String
    public var notificationSounds: String
    public var registeredForPushes: Bool
    public var deviceSignIn: Bool
    public var patients: Int
    public var remoteSetupComplete: Bool

    public init(appVersion: String, deviceModel: String, systemVersion: String, timeZone: String, utcOffsetMinutes: Int, lowPowerMode: Bool, backgroundRefresh: String, notificationAuthorization: String, notificationAlerts: String, notificationSounds: String, registeredForPushes: Bool, deviceSignIn: Bool, patients: Int, remoteSetupComplete: Bool) {
        self.appVersion = appVersion
        self.deviceModel = deviceModel
        self.systemVersion = systemVersion
        self.timeZone = timeZone
        self.utcOffsetMinutes = utcOffsetMinutes
        self.lowPowerMode = lowPowerMode
        self.backgroundRefresh = backgroundRefresh
        self.notificationAuthorization = notificationAuthorization
        self.notificationAlerts = notificationAlerts
        self.notificationSounds = notificationSounds
        self.registeredForPushes = registeredForPushes
        self.deviceSignIn = deviceSignIn
        self.patients = patients
        self.remoteSetupComplete = remoteSetupComplete
    }
}

// Here and not next to the sanitizer: the watch targets compile DiagnosticLog.swift without the Keychain stores.
public extension DiagnosticSanitizer {
    /// An error as one number or name: a Keychain status (-25308: the phone is locked), else the error's own code. Never
    /// its text, which can hold an address or a name.
    static func errorCode(_ error: Error) -> String {
        if case let .keychain(status) = error as? TrioRemoteSettingsStoreError { return "\(status)" }
        let nsError = error as NSError
        return nsError.domain.hasPrefix("GlucoMind") ? slug(String(describing: type(of: error))) : "\(nsError.code)"
    }
}

public struct DiagnosticServerReport: Decodable, Equatable {
    public let text: String
}

/// The server's half of the report, or why there is none. A report is most needed when the server does not answer, so
/// a failure here never stops the phone's half.
public enum DiagnosticServerPart: Equatable {
    case report(String)
    /// The server report covers everyone on the server: only an owner gets it.
    case notOwner
    /// A code, never the error's text.
    case unavailable(String)

    public init(error: Error) {
        switch error as? APIClientError {
        case .forbidden:
            self = .notOwner
        case .transport:
            self = .unavailable("BRAK_POLACZENIA")
        case .unauthenticated:
            self = .unavailable("BRAK_ZALOGOWANIA")
        case .notFound:
            self = .unavailable("STARSZA_WERSJA_SERWERA")
        case .server:
            self = .unavailable("HTTP_500")
        case let .unexpectedStatus(status, _):
            self = .unavailable("HTTP_\(status)")
        default:
            self = .unavailable(error is URLError ? "BRAK_ODPOWIEDZI" : "BLAD_ODCZYTU")
        }
    }

    /// The note on the screen, when the file has the phone's half only.
    public var screenNote: String? {
        switch self {
        case .report:
            return nil
        case .notOwner:
            return "Część o serwerze może pobrać tylko właściciel, więc ten raport opisuje sam telefon. Jeśli problem dotyczy serwera, poproś właściciela o raport z jego telefonu."
        case .unavailable:
            return "Serwer nie przekazał swojej części, więc ten raport opisuje sam telefon."
        }
    }
}

public enum DiagnosticReportText {
    public static let header = "Bez imion, glukozy, dawek, posiłków, rozmów, zdjęć, kluczy i adresów. Są w nim godziny i nazwy zdarzeń, na przykład że wysłano przypomnienie. Przejrzyj go przed wysłaniem."

    public static func build(now: Date, facts: DiagnosticPhoneFacts, entries: [DiagnosticEntry], server: DiagnosticServerPart) -> String {
        let yesNo: (Bool) -> String = { $0 ? "tak" : "nie" }
        var lines: [String] = [
            "Mellis: raport do zgłoszenia (\(iso(now)))",
            header,
            "",
            "TELEFON",
            "  Aplikacja: \(facts.appVersion) · logowanie urządzeniem: \(yesNo(facts.deviceSignIn))",
            "  Model: \(facts.deviceModel) · iOS \(facts.systemVersion) · tryb oszczędzania energii: \(yesNo(facts.lowPowerMode)) · odświeżanie w tle: \(facts.backgroundRefresh)",
            "  Strefa czasowa: \(facts.timeZone) (UTC\(facts.utcOffsetMinutes >= 0 ? "+" : "")\(facts.utcOffsetMinutes) min)",
            "  Powiadomienia: zgoda \(facts.notificationAuthorization), banery \(facts.notificationAlerts), dźwięki \(facts.notificationSounds), rejestracja w Apple: \(yesNo(facts.registeredForPushes))",
            "  Podopiecznych: \(facts.patients) · zdalny bolus ustawiony dla bieżącego podopiecznego: \(yesNo(facts.remoteSetupComplete))",
            "",
            "ZDARZENIA TELEFONU (7 dni, najnowsze na górze)",
        ]
        if entries.isEmpty { lines.append("  brak") }
        for entry in entries.reversed() {
            let fields = entry.fields.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            lines.append("  \(iso(entry.at)) \(entry.category.rawValue) \(entry.event)\(fields.isEmpty ? "" : " \(fields)")")
        }
        lines.append("")
        switch server {
        case let .report(text):
            lines.append(text)
        case .notOwner:
            lines.append("RAPORT SERWERA: niedostępny, ten telefon nie należy do właściciela")
        case let .unavailable(code):
            lines.append("RAPORT SERWERA: niedostępny (\(code))")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    public static func fileName(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmm"
        return "mellis-raport-\(formatter.string(from: now)).txt"
    }

    private static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
